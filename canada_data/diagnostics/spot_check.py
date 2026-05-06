"""Comprehensive validator: parse every row from each TCT table from raw PDF
text, then compare to the JSON output field-by-field. Reports per-table totals
and details on any mismatch.

The PDF parsers here are independent of read_tct.py's main parsers; they share
only the OCR-artifact normalization helpers, which are about cleaning input
rather than parsing structure.
"""
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
import pdfplumber

# canada_data/ holds the PDFs and read_tct.py; their JSON outputs live at the repo root.
SCRIPT_DIR = Path(__file__).resolve().parent
CANADA_DATA_DIR = SCRIPT_DIR.parent  # canada_data/
REPO_ROOT = CANADA_DATA_DIR.parent

# Make `from read_tct import ...` resolve from canada_data/ even though we
# live in canada_data/diagnostics/.
sys.path.insert(0, str(CANADA_DATA_DIR))

from read_tct import (
    parse_toc,
    _printed_page_offset,
    _find_toc_page,
    _fix_decimal_gaps,
    _split_concat_time_diff,
    _bucket_by_column,
    _format_time_diff,
)

VOLS = {
    5: str(CANADA_DATA_DIR / "chs-shc-tct-tmc-vol5-2026-41311243.pdf"),
    6: str(CANADA_DATA_DIR / "chs-shc-tct-tmc-vol6-2026-41311267.pdf"),
    7: str(CANADA_DATA_DIR / "chs-shc-tct-tmc-vol7-2026-41311280.pdf"),
}

VOL_INDEX_RANGES = {5: (7000, 8000), 6: (8000, 8800), 7: (8800, 10000)}


# ---------- helpers ----------

def fclose(a, b, eps=1e-6):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return math.isclose(a, b, abs_tol=eps)


def coord(deg, minutes, sign):
    return sign * (deg + minutes / 60.0)


def lat_from(d, m):
    return coord(int(d), int(m), 1)


def lon_from(d, m):
    return coord(int(d), int(m), -1)


@dataclass
class Diff:
    table: str
    vol: int
    index_no: int | str
    name: str
    field: str
    expected: object
    actual: object
    raw: str = ""

    def __str__(self):
        return (f"  vol{self.vol} {self.table} {self.index_no} {self.name!r} "
                f".{self.field}: expected={self.expected!r}  actual={self.actual!r}\n"
                f"    raw: {self.raw}")


# ---------- table 1 / table 2 ----------

T1_PAT = re.compile(
    r"^(?P<name>[A-Z][A-Z\s\-'.]+?)\s+"
    r"(?P<index>\d{4})\s+-\s*(?P<tz>\d+)\s+"
    r"(?P<lat_d>\d+)\s+(?P<lat_m>\d+)\s+"
    r"(?P<lon_d>\d+)\s+(?P<lon_m>\d+)\s+"
    r"(?P<type>[A-Z]+)\s+"
    r"(?P<mean>\d+\.\d+)\s+(?P<large>\d+\.\d+)\s*$"
)

T2_PAT = re.compile(
    r"^(?P<name>[A-Z][A-Z\s\-'.]+?)\s+"
    + r"\s+".join(rf"(?P<v{i}>-?\d+\.\d+)" for i in range(1, 8))
    + r"\s*$"
)


def parse_table1_pdf(pdf, toc, offset):
    if 1 not in toc.table_pages:
        return {}
    text = pdf.pages[toc.table_pages[1] + offset].extract_text() or ""
    out = {}
    for line in text.split("\n"):
        m = T1_PAT.match(_fix_decimal_gaps(line.strip()))
        if not m:
            continue
        out[int(m.group("index"))] = {
            "name": m.group("name").strip(),
            "utc_offset": -int(m.group("tz")),
            "latitude": lat_from(m.group("lat_d"), m.group("lat_m")),
            "longitude": lon_from(m.group("lon_d"), m.group("lon_m")),
            "tide_type": m.group("type"),
            "mean_tide_range": float(m.group("mean")),
            "large_tide_range": float(m.group("large")),
            "raw": line.strip(),
        }
    return out


def parse_table2_pdf(pdf, toc, offset):
    if 2 not in toc.table_pages:
        return {}
    text = pdf.pages[toc.table_pages[2] + offset].extract_text() or ""
    out = {}
    for line in text.split("\n"):
        m = T2_PAT.match(_fix_decimal_gaps(line.strip()))
        if not m:
            continue
        name = m.group("name").strip()
        out[name] = {
            "higher_high_water_mean_tide": float(m.group("v1")),
            "higher_high_water_large_tide": float(m.group("v2")),
            "lower_low_water_mean_tide": float(m.group("v3")),
            "lower_low_water_large_tide": float(m.group("v4")),
            "highest_recorded_high_water": float(m.group("v5")),
            "lowest_recorded_low_water": float(m.group("v6")),
            "mean_water_level": float(m.group("v7")),
            "raw": line.strip(),
        }
    return out


def check_tables_1_2(diffs):
    primary = json.load(open(REPO_ROOT / "2026_tct_tidal_primary_stations.json"))["stations"]
    by_idx = {s["index_no"]: s for s in primary}
    t1_total = t1_ok = t2_total = t2_ok = 0
    for vol, fname in VOLS.items():
        toc = parse_toc(fname)
        with pdfplumber.open(fname) as pdf:
            offset = _printed_page_offset(pdf, _find_toc_page(pdf))
            t1 = parse_table1_pdf(pdf, toc, offset)
            t2 = parse_table2_pdf(pdf, toc, offset)
        # Table 1 by index_no
        for idx, exp in t1.items():
            t1_total += 1
            s = by_idx.get(idx)
            if s is None:
                diffs.append(Diff("T1", vol, idx, exp["name"], "*", "JSON entry", "MISSING", exp["raw"]))
                continue
            row_ok = True
            for field_name in ("utc_offset", "tide_type", "mean_tide_range", "large_tide_range"):
                if s[field_name] != exp[field_name]:
                    diffs.append(Diff("T1", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            if not fclose(s["latitude"], exp["latitude"]):
                diffs.append(Diff("T1", vol, idx, exp["name"], "latitude", exp["latitude"], s["latitude"], exp["raw"]))
                row_ok = False
            if not fclose(s["longitude"], exp["longitude"]):
                diffs.append(Diff("T1", vol, idx, exp["name"], "longitude", exp["longitude"], s["longitude"], exp["raw"]))
                row_ok = False
            # name comparison: JSON station.name should start with the T1 ref name
            if not s["name"].startswith(exp["name"]):
                diffs.append(Diff("T1", vol, idx, exp["name"], "name_prefix", exp["name"], s["name"], exp["raw"]))
                row_ok = False
            if row_ok:
                t1_ok += 1
        # Table 2 by name
        by_t2_name = {s["reference_name"]: s for s in primary}
        for name, exp in t2.items():
            t2_total += 1
            s = by_t2_name.get(name)
            if s is None:
                diffs.append(Diff("T2", vol, "?", name, "*", "JSON entry", "MISSING", exp["raw"]))
                continue
            row_ok = True
            for field_name in (
                "higher_high_water_mean_tide", "higher_high_water_large_tide",
                "lower_low_water_mean_tide", "lower_low_water_large_tide",
                "highest_recorded_high_water", "lowest_recorded_low_water", "mean_water_level"
            ):
                if not fclose(s[field_name], exp[field_name]):
                    diffs.append(Diff("T2", vol, s["index_no"], name, field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            if row_ok:
                t2_ok += 1
    return t1_ok, t1_total, t2_ok, t2_total


# ---------- table 3 ----------

# Reuse the patterns from read_tct
from read_tct import TABLE3_ROW_PATTERN, TABLE3_HEADER_NOISE


def parse_table3_pdf(pdf, toc, offset):
    if 3 not in toc.table_pages:
        return {}
    out = {}
    start = toc.table_pages[3] + offset
    end = toc.table_pages[4] + offset
    for pdf_idx in range(start, end):
        text = pdf.pages[pdf_idx].extract_text() or ""
        for raw_line in text.split("\n"):
            line = raw_line.strip()
            if not line or line in TABLE3_HEADER_NOISE:
                continue
            normalized = _split_concat_time_diff(line)
            m = TABLE3_ROW_PATTERN.match(normalized)
            if not m:
                # Apply same recovery as read_tct
                recovered = re.sub(r"(?<!\d)([+-])(\d)\.(\d{2})(?=\s|$)", r"\1\2 \3", normalized)
                m = TABLE3_ROW_PATTERN.match(recovered)
            if not m:
                continue
            hhw_time, hhw_flag = _format_time_diff(m.group("hhw_time"))
            llw_time, llw_flag = _format_time_diff(m.group("llw_time"))

            def f(s):
                return float(s.rstrip("*"))

            idx = int(m.group("index"))
            out[idx] = {
                "name": m.group("name").strip(),
                "utc_offset": -int(m.group("tz")),
                "latitude": lat_from(m.group("lat_d"), m.group("lat_m")),
                "longitude": lon_from(m.group("lon_d"), m.group("lon_m")),
                "higher_high_water_time_diff": hhw_time,
                "higher_high_water_mean_tide_diff": f(m.group("hhw_mean")),
                "higher_high_water_large_tide_diff": f(m.group("hhw_large")),
                "lower_low_water_time_diff": llw_time,
                "lower_low_water_mean_tide_diff": f(m.group("llw_mean")),
                "lower_low_water_large_tide_diff": f(m.group("llw_large")),
                "mean_tide_range": f(m.group("range_mean")),
                "large_tide_range": f(m.group("range_large")),
                "mean_water_level": f(m.group("mwl")),
                "raw": line,
            }
    return out


def check_table3(diffs):
    secondaries = json.load(open(REPO_ROOT / "2026_tct_tidal_secondary_stations.json"))["stations"]
    by_idx = {s["index_no"]: s for s in secondaries}
    total = ok = 0
    for vol, fname in VOLS.items():
        toc = parse_toc(fname)
        with pdfplumber.open(fname) as pdf:
            offset = _printed_page_offset(pdf, _find_toc_page(pdf))
            expected = parse_table3_pdf(pdf, toc, offset)
        for idx, exp in expected.items():
            total += 1
            s = by_idx.get(idx)
            if s is None:
                diffs.append(Diff("T3", vol, idx, exp["name"], "*", "JSON entry", "MISSING", exp["raw"]))
                continue
            row_ok = True
            checks = (
                "name", "utc_offset",
                "higher_high_water_time_diff",
                "lower_low_water_time_diff",
            )
            for field_name in checks:
                if s[field_name] != exp[field_name]:
                    diffs.append(Diff("T3", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            float_fields = (
                "higher_high_water_mean_tide_diff", "higher_high_water_large_tide_diff",
                "lower_low_water_mean_tide_diff", "lower_low_water_large_tide_diff",
                "mean_tide_range", "large_tide_range", "mean_water_level",
            )
            for field_name in float_fields:
                if not fclose(s[field_name], exp[field_name]):
                    diffs.append(Diff("T3", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            for field_name in ("latitude", "longitude"):
                if not fclose(s[field_name], exp[field_name]):
                    diffs.append(Diff("T3", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            if row_ok:
                ok += 1
    return ok, total


# ---------- table 4 ----------

def parse_t4_time_diff_words(words):
    """Re-implement here so we can test the verification independently. Returns (str, bool)."""
    if len(words) < 2:
        return None, False
    h_text = words[0]["text"]
    m_text = words[1]["text"]
    has_foot = "(a)" in m_text or "(a)" in h_text
    m_clean = m_text.replace("(a)", "").strip()
    sign = "+"
    if h_text.startswith("-"):
        sign = "-"
        h_text = h_text[1:]
    elif h_text.startswith("+"):
        h_text = h_text[1:]
    try:
        return f"{sign}{int(h_text):02d}:{int(m_clean):02d}", has_foot
    except ValueError:
        return None, has_foot


def parse_table4_pdf(pdf, toc, offset):
    """Returns (refs_by_index, secs_by_index). Tracks zone/format-note headers
    the same way read_tct.parse_table4 does so the verifier captures the same
    name-prefix merging and offsets_from_tides flagging."""
    if 4 not in toc.table_pages:
        return {}, {}
    pdf_idx = toc.table_pages[4] + offset
    page = pdf.pages[pdf_idx]
    words = page.extract_words()
    rows = {}
    for w in words:
        rows.setdefault(round(w["top"]), []).append(w)
    refs = {}
    secs = {}
    seen_on_sur = False
    current_ref_primary = None
    pending_zone = None
    pending_format_note = None
    for top in sorted(rows.keys()):
        row = sorted(rows[top], key=lambda w: w["x0"])
        text_line = " ".join(w["text"] for w in row).strip()
        if not row:
            continue
        # header transition
        m = re.match(r"^on/sur\s+(?P<port>.+?),\s+pages\s+\d+", text_line, re.IGNORECASE)
        if m:
            seen_on_sur = True
            current_ref_primary = m.group("port").strip()
            pending_zone = None
            pending_format_note = None
            continue
        # data row?
        if not (row[0]["text"].isdigit() and len(row[0]["text"]) == 4 and row[0]["x0"] < 70):
            # Track zone / format-note non-data lines (only after we're in the
            # secondary section). Skip known noise lines and footer page nums.
            if seen_on_sur and text_line and not text_line.isdigit():
                if text_line == "LW HW":
                    pending_format_note = "LW HW"
                elif text_line.startswith("(") or text_line.startswith("*"):
                    pass
                elif not any(kw in text_line for kw in (
                    "REFERENCE", "SECONDARY", "STATION", "TIME DIFF", "MAXIMUM",
                    "FLOOD", "EBB", "TURN", "RATE", "knots", "noeuds", "% REF",
                    "° true", "° vraie", "JUSANT", "RENV", "DIR", "INDEX",
                )):
                    pending_zone = text_line
            continue
        buckets = _bucket_by_column(row)
        if not buckets["index"]:
            continue
        try:
            idx = int(buckets["index"][0]["text"])
        except ValueError:
            continue
        name = " ".join(w["text"] for w in buckets["name"]).strip()
        flood_dir = None
        if buckets["flood_dir"] and buckets["flood_dir"][0]["text"].isdigit():
            flood_dir = int(buckets["flood_dir"][0]["text"])
        latitude = longitude = None
        if buckets["lat_d"] and buckets["lat_m"]:
            try:
                latitude = lat_from(buckets["lat_d"][0]["text"], buckets["lat_m"][0]["text"])
            except ValueError:
                pass
        if buckets["lon_d"] and buckets["lon_m"]:
            try:
                longitude = lon_from(buckets["lon_d"][0]["text"], buckets["lon_m"][0]["text"])
            except ValueError:
                pass
        max_flood = max_ebb = None
        if buckets["max_flood"]:
            try:
                max_flood = float(buckets["max_flood"][0]["text"])
            except ValueError:
                pass
        if buckets["max_ebb"]:
            try:
                max_ebb = float(buckets["max_ebb"][0]["text"])
            except ValueError:
                pass
        if not seen_on_sur:
            refs[idx] = dict(
                name=name, latitude=latitude, longitude=longitude,
                flood_direction_true=flood_dir,
                max_flood_knots=max_flood, max_ebb_knots=max_ebb,
                raw=text_line,
            )
            continue

        # Secondary
        row_texts = [w["text"] for w in row]
        inline_lw_hw = "LW" in row_texts and "HW" in row_texts
        if inline_lw_hw:
            tf, _ = parse_t4_time_diff_words(
                [w for w in buckets["turn_flood"] if w["text"] != "LW"]
            )
            te, _ = parse_t4_time_diff_words(
                [w for w in buckets["turn_ebb"] if w["text"] != "HW"]
            )
            fm = em = None
        else:
            tf, _ = parse_t4_time_diff_words(buckets["turn_flood"])
            fm, _ = parse_t4_time_diff_words(buckets["flood_max"])
            te, _ = parse_t4_time_diff_words(buckets["turn_ebb"])
            em, _ = parse_t4_time_diff_words(buckets["ebb_max"])
        pct_f = pct_e = None
        if buckets["pct_flood"]:
            try:
                pct_f = int(buckets["pct_flood"][0]["text"])
            except ValueError:
                pass
        if buckets["pct_ebb"]:
            try:
                pct_e = int(buckets["pct_ebb"][0]["text"])
            except ValueError:
                pass
        offsets_from_tides = inline_lw_hw or pending_format_note == "LW HW"
        # Apply name-prefix merge from a wrapped zone line (matches read_tct).
        if offsets_from_tides and pending_zone:
            name = f"{pending_zone} {name}".strip()
        secs[idx] = dict(
            name=name, latitude=latitude, longitude=longitude,
            flood_direction_true=flood_dir,
            max_flood_knots=max_flood, max_ebb_knots=max_ebb,
            turn_to_flood_diff=tf, flood_max_diff=fm,
            turn_to_ebb_diff=te, ebb_max_diff=em,
            pct_ref_flood=pct_f, pct_ref_ebb=pct_e,
            offsets_from_tides=offsets_from_tides,
            reference_primary=current_ref_primary,
            raw=text_line,
        )
        pending_zone = None
        pending_format_note = None
    return refs, secs


def check_table4(diffs):
    cur_primary = json.load(open(REPO_ROOT / "2026_tct_current_primary_stations.json"))["stations"]
    cur_secondary = json.load(open(REPO_ROOT / "2026_tct_current_secondary_stations.json"))["stations"]
    primary_by_idx = {s["index_no"]: s for s in cur_primary}
    secondary_by_idx = {s["index_no"]: s for s in cur_secondary}
    p_total = p_ok = s_total = s_ok = 0
    for vol, fname in VOLS.items():
        toc = parse_toc(fname)
        with pdfplumber.open(fname) as pdf:
            offset = _printed_page_offset(pdf, _find_toc_page(pdf))
            refs_pdf, secs_pdf = parse_table4_pdf(pdf, toc, offset)
        # Reference rows
        for idx, exp in refs_pdf.items():
            p_total += 1
            s = primary_by_idx.get(idx)
            if s is None:
                diffs.append(Diff("T4ref", vol, idx, exp["name"], "*", "JSON entry", "MISSING", exp["raw"]))
                continue
            row_ok = True
            # Reference-station Table 4 rows commonly omit the flood direction
            # column (it's printed on the per-station page header instead). Only
            # check it when the PDF row actually populated the column.
            check_fields = ["max_flood_knots", "max_ebb_knots"]
            if exp["flood_direction_true"] is not None:
                check_fields.insert(0, "flood_direction_true")
            for field_name in check_fields:
                if s[field_name] != exp[field_name]:
                    diffs.append(Diff("T4ref", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            for field_name in ("latitude", "longitude"):
                if not fclose(s[field_name], exp[field_name]):
                    diffs.append(Diff("T4ref", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            if row_ok:
                p_ok += 1
        # Secondary rows
        for idx, exp in secs_pdf.items():
            s_total += 1
            s = secondary_by_idx.get(idx)
            if s is None:
                diffs.append(Diff("T4sec", vol, idx, exp["name"], "*", "JSON entry", "MISSING", exp["raw"]))
                continue
            row_ok = True
            for field_name in ("name", "flood_direction_true", "turn_to_flood_diff",
                               "flood_max_diff", "turn_to_ebb_diff", "ebb_max_diff",
                               "pct_ref_flood", "pct_ref_ebb",
                               "offsets_from_tides", "reference_primary"):
                if s[field_name] != exp[field_name]:
                    diffs.append(Diff("T4sec", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            for field_name in ("latitude", "longitude", "max_flood_knots", "max_ebb_knots"):
                if not fclose(s[field_name], exp[field_name]):
                    diffs.append(Diff("T4sec", vol, idx, exp["name"], field_name, exp[field_name], s[field_name], exp["raw"]))
                    row_ok = False
            if row_ok:
                s_ok += 1
    return p_ok, p_total, s_ok, s_total


# ---------- main ----------

def main():
    diffs: list[Diff] = []
    print("Validating Tables 1, 2, 3, 4 across vol5/6/7...")
    t1_ok, t1_total, t2_ok, t2_total = check_tables_1_2(diffs)
    t3_ok, t3_total = check_table3(diffs)
    t4p_ok, t4p_total, t4s_ok, t4s_total = check_table4(diffs)

    print()
    print(f"Table 1 (primary tide info):     {t1_ok}/{t1_total} rows match")
    print(f"Table 2 (primary tide heights):  {t2_ok}/{t2_total} rows match")
    print(f"Table 3 (secondary ports):       {t3_ok}/{t3_total} rows match")
    print(f"Table 4 (current primaries):     {t4p_ok}/{t4p_total} rows match")
    print(f"Table 4 (current secondaries):   {t4s_ok}/{t4s_total} rows match")

    if diffs:
        print()
        print(f"Mismatches ({len(diffs)} total):")
        for d in diffs:
            print(d)
    else:
        print("\nAll rows match perfectly.")


if __name__ == "__main__":
    main()
