#!/usr/bin/env python3
"""Fetch a year of CHS predictions from the IWLS API and emit them in the
same JSON shape as read_tct.py produces from the printed tables.

Why: the 2027 Tide and Current Tables are the final printed edition. From
2028 the Canadian data has to come from the IWLS API
(https://api-iwls.dfo-mpo.gc.ca/swagger-ui/index.html). Running this for
2027 alongside the PDF parser lets compare_iwls_tct.py prove the two
sources agree, which validates both the 2027 parse and this fetcher.

What it fetches, per station in the roster:
  tide primaries     wlp-hilo        high/low predictions (m, 3 dp)
  current primaries  wcp1-events     SLACK / EXTREMA_FLOOD / EXTREMA_EBB /
                                     WEAK_AND_VARIABLE events (kn, 3 dp)
  both               /metadata       coords, tidal heights (HHWLT, MHHW,
                                     MLLW, LLWLT, MWL, HRWL, LRWL) and, for
                                     currents, floodDirection/ebbDirection
  --secondaries      wlp-hilo for every Table 3 secondary port IWLS has
                     (256 of 263 in 2027). Written to a separate file that
                     build_manifest.py publishes as tidal_secondary_direct;
                     the loader uses these instead of the Table 3
                     derivation wherever a port has them.

Metadata the books carry and IWLS does not is taken from the roster file
when present (--metadata-from roster, the default): the Table 4 reference
rows' "maximum at large tides" knots and the Table 2 tidal heights that
the Table 3 derivation was computed against. IWLS's own values are kept
alongside as iwls_* fields (stripped at publish). --metadata-from iwls
uses the API's values throughout.

Roster: by default the index_nos in {roster-year}_tct_tidal_primary and
{roster-year}_tct_current_primary at the repo root (roster-year defaults
to --year). For a year with no printed tables, pass --roster-year 2027 and
--add-currents / --add-tides with extra five-digit CHS codes.

Times: IWLS returns UTC. Output days are grouped in the station-local
offset given by --utc-offset (default -7, what the 2027 book prints) so
the JSON is interchangeable with the parser's. The window is the local
calendar year: [Jan 1 00:00, Jan 1 00:00 next year) at that offset.

Raw responses are cached under canada_data/iwls_raw/<year>/ (gitignored);
--refresh re-downloads.

Outputs at --out-dir (default repo root):
  {year}_iwls_tidal_primary_stations.json
  {year}_iwls_current_primary_stations.json
  {year}_iwls_tidal_secondary_predictions.json   (with --secondaries)
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BASE = "https://api-iwls.dfo-mpo.gc.ca/api/v1"
THROTTLE_S = 0.25
RETRY_CODES = {429, 500, 502, 503, 504}

# IWLS height-type ids (GET /height-types) → read_tct.py field names.
HEIGHT_FIELDS = {
    "5cec2eba3d0f4a04cc64d5ce": "higher_high_water_large_tide",   # HHWLT
    "5cec2eba3d0f4a04cc64d5d4": "higher_high_water_mean_tide",    # MHHW
    "5cec2eba3d0f4a04cc64d5d5": "lower_low_water_mean_tide",      # MLLW
    "5cec2eba3d0f4a04cc64d5d3": "lower_low_water_large_tide",     # LLWLT
    "5cec2eba3d0f4a04cc64d5d2": "mean_water_level",               # MWL
    "5cec2eba3d0f4a04cc64d5d1": "highest_recorded_high_water",    # HRWL
    "5cec2eba3d0f4a04cc64d5d6": "lowest_recorded_low_water",      # LRWL
}

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- HTTP ----

def get_json(url: str, cache: Path | None, refresh: bool) -> object:
    if cache is not None and cache.exists() and not refresh:
        return json.loads(cache.read_text())
    delay = 1.0
    for attempt in range(1, 6):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json",
                                                       "User-Agent": "currentlybc fetch_iwls"})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            data = json.loads(body)
            if cache is not None:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(body)
            time.sleep(THROTTLE_S)
            return data
        except urllib.error.HTTPError as e:
            if e.code in RETRY_CODES and attempt < 5:
                log(f"    HTTP {e.code}; retry in {delay:.0f}s")
                time.sleep(delay)
                delay *= 2
                continue
            raise
        except urllib.error.URLError:
            if attempt < 5:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    raise RuntimeError("unreachable")


# -------------------------------------------------------------- window ----

def local_year_window_utc(year: int, utc_offset: int) -> tuple[dt.datetime, dt.datetime]:
    """[start, end) in UTC for the station-local calendar year."""
    tz = dt.timezone(dt.timedelta(hours=utc_offset))
    start = dt.datetime(year, 1, 1, tzinfo=tz).astimezone(dt.timezone.utc)
    end = dt.datetime(year + 1, 1, 1, tzinfo=tz).astimezone(dt.timezone.utc)
    return start, end


def iso_z(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_z(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def group_days(year: int, utc_offset: int, items: list[tuple[dt.datetime, dict]],
               key: str) -> list[dict]:
    """Bucket (utc_time, payload) pairs into read_tct-style days[] for the
    whole local year, including days with no events."""
    tz = dt.timezone(dt.timedelta(hours=utc_offset))
    by_day: dict[tuple[int, int], list[dict]] = {}
    for t, payload in items:
        loc = t.astimezone(tz)
        if loc.year != year:
            continue
        by_day.setdefault((loc.month, loc.day), []).append(
            {"time": loc.strftime("%H:%M"), **payload})
    days = []
    for month in range(1, 13):
        for day in range(1, calendar.monthrange(year, month)[1] + 1):
            days.append({
                "month": month,
                "day": day,
                "weekday": WEEKDAYS[dt.date(year, month, day).weekday()],
                key: by_day.get((month, day), []),
            })
    return days


# ------------------------------------------------------------- roster -----

def book_roster(roster_year: int, source: Path) -> tuple[dict[int, dict], dict[int, dict], dict[int, dict]]:
    """(tide primaries, current primaries, tide secondaries) as
    {index_no: book station record minus days} from the parser outputs."""
    def load(kind: str) -> dict[int, dict]:
        p = source / f"{roster_year}_tct_{kind}_stations.json"
        if not p.exists():
            raise SystemExit(f"roster file not found: {p} (run process_canadian.sh "
                             f"--year {roster_year}, or pass --roster-year)")
        out: dict[int, dict] = {}
        for s in json.loads(p.read_text())["stations"]:
            out.setdefault(s["index_no"], {k: v for k, v in s.items() if k != "days"})
        return out
    return load("tidal_primary"), load("current_primary"), load("tidal_secondary")


# Book fields carried over from the roster record when --metadata-from roster.
TIDE_CARRY = ["higher_high_water_large_tide", "higher_high_water_mean_tide",
              "lower_low_water_mean_tide", "lower_low_water_large_tide", "mean_water_level",
              "highest_recorded_high_water", "lowest_recorded_low_water"]
CURRENT_CARRY = ["max_flood_knots", "max_ebb_knots", "flood_direction_true", "ebb_direction_true"]


def carry_over(s: dict, book: dict | None, fields: list[str]) -> None:
    """Replace IWLS-derived `fields` on `s` with the book's values where the
    book has them, keeping the IWLS value under an iwls_ prefix."""
    if not book:
        return
    for f in fields:
        if book.get(f) is None:
            continue
        if f in s:
            s[f"iwls_{f}"] = s[f]
        s[f] = book[f]


# ------------------------------------------------------------ builders ----

def metadata_fields(meta: dict) -> dict:
    out: dict = {}
    for h in meta.get("heights", []):
        field = HEIGHT_FIELDS.get(h.get("heightTypeId"))
        if field and h.get("value") is not None:
            out[field] = h["value"]
    if meta.get("floodDirection") is not None:
        out["flood_direction_true"] = int(meta["floodDirection"])
    if meta.get("ebbDirection") is not None:
        out["ebb_direction_true"] = int(meta["ebbDirection"])
    return out


def build_tide_station(code: int, name: str, station: dict, meta: dict, hilo: list[dict],
                       year: int, utc_offset: int, tz_label: str) -> dict:
    items = [(parse_z(r["eventDate"]), {"metres": r["value"]}) for r in hilo]
    items.sort(key=lambda x: x[0])
    s = {
        "name": name,
        "iwls_name": station["officialName"].strip(),
        "iwls_id": station["id"],
        "index_no": code,
        "timezone": tz_label,
        "utc_offset": utc_offset,
        "year": year,
        "latitude": station["latitude"],
        "longitude": station["longitude"],
        "source": "iwls",
    }
    s.update({k: v for k, v in metadata_fields(meta).items() if not k.endswith("_direction_true")})
    s["days"] = group_days(year, utc_offset, items, "readings")
    return s


def build_current_station(code: int, name: str, station: dict, meta: dict, events: list[dict],
                          year: int, utc_offset: int, tz_label: str) -> dict:
    items: list[tuple[dt.datetime, dict]] = []
    max_flood = 0.0
    max_ebb = 0.0
    unknown: set[str] = set()
    for e in events:
        q = e.get("qualifier")
        v = float(e.get("value") or 0.0)
        if q == "SLACK":
            payload = {"kind": "slack", "knots": 0.0, "weak_variable": False}
        elif q == "EXTREMA_FLOOD":
            payload = {"kind": "max", "knots": round(v, 3), "weak_variable": False}
            max_flood = max(max_flood, v)
        elif q == "EXTREMA_EBB":
            payload = {"kind": "max", "knots": round(-abs(v), 3), "weak_variable": False}
            max_ebb = max(max_ebb, abs(v))
        elif q == "WEAK_AND_VARIABLE":
            payload = {"kind": "max", "knots": 0.0, "weak_variable": True}
        else:
            unknown.add(str(q))
            continue
        items.append((parse_z(e["eventDate"]), payload))
    if unknown:
        log(f"    WARNING {name}: unknown event qualifiers {sorted(unknown)} skipped")
    items.sort(key=lambda x: x[0])
    s = {
        "name": name,
        "iwls_name": station["officialName"].strip(),
        "iwls_id": station["id"],
        "index_no": code,
        "timezone": tz_label,
        "utc_offset": utc_offset,
        "year": year,
        "latitude": station["latitude"],
        "longitude": station["longitude"],
        "source": "iwls",
        # Book semantics are "peak at large tides"; here, like the NOAA
        # path, it is the largest predicted event of the year.
        "max_flood_knots": round(max_flood, 1),
        "max_ebb_knots": round(-max_ebb, 1),
    }
    s.update(metadata_fields(meta))
    s["days"] = group_days(year, utc_offset, items, "events")
    return s


# ---------------------------------------------------------------- main ----

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--roster-year", type=int, default=None,
                    help="Year of the parser outputs that define the roster (default: --year)")
    ap.add_argument("--source", type=Path, default=REPO_ROOT, help="Where the {year}_tct_*.json live")
    ap.add_argument("--out-dir", type=Path, default=REPO_ROOT)
    ap.add_argument("--utc-offset", type=int, default=-7,
                    help="Station-local offset used to group days (default -7, as the 2027 book prints)")
    ap.add_argument("--metadata-from", choices=["roster", "iwls"], default="roster",
                    help="Source for large-tide max knots / Table 2 heights (default roster = the book)")
    ap.add_argument("--secondaries", action="store_true",
                    help="Also fetch wlp-hilo for every Table 3 secondary port IWLS has")
    ap.add_argument("--add-tides", default="", help="Extra tide station codes, comma-separated (e.g. 07607)")
    ap.add_argument("--add-currents", default="", help="Extra current station codes, comma-separated (e.g. 08138,07724)")
    ap.add_argument("--refresh", action="store_true", help="Ignore the raw cache")
    args = ap.parse_args()

    year = args.year
    roster_year = args.roster_year or year
    tz_label = {-8: "PST-HNP", -7: "PDT-HAP"}.get(args.utc_offset, f"UTC{args.utc_offset:+d}")
    raw = SCRIPT_DIR / "iwls_raw" / str(year)
    start, end = local_year_window_utc(year, args.utc_offset)
    log(f"=== fetch_iwls.py: year={year} roster={roster_year} window {iso_z(start)} .. {iso_z(end)} "
        f"(local offset {args.utc_offset:+d})")

    tides, currents, secondaries = book_roster(roster_year, args.source)
    for c in filter(None, args.add_tides.split(",")):
        tides.setdefault(int(c), None)  # no book record: name and metadata from IWLS
    for c in filter(None, args.add_currents.split(",")):
        currents.setdefault(int(c), None)

    log("--> station catalog (PAC)")
    pac = get_json(f"{BASE}/stations?chs-region-code=PAC", raw / "pac_stations.json", args.refresh)
    by_code = {s["code"]: s for s in pac}

    def station_for(code: int) -> dict | None:
        return by_code.get(f"{code:05d}")

    def has_series(st: dict, ts_code: str) -> bool:
        return any(t["code"] == ts_code for t in st.get("timeSeries", []))

    def fetch_series(st: dict, ts_code: str, tag: str) -> list[dict]:
        q = urllib.parse.urlencode({"time-series-code": ts_code, "from": iso_z(start), "to": iso_z(end)})
        cache = raw / f"{tag}_{st['code']}_{ts_code}_utc{args.utc_offset:+d}.json"
        data = get_json(f"{BASE}/stations/{st['id']}/data?{q}", cache, args.refresh)
        # [start, end): IWLS treats `to` as inclusive.
        return [r for r in data if start <= parse_z(r["eventDate"]) < end]

    def fetch_meta(st: dict) -> dict:
        return get_json(f"{BASE}/stations/{st['id']}/metadata", raw / f"meta_{st['code']}.json", args.refresh)

    # ---- tide primaries
    tide_out: list[dict] = []
    log(f"--> {len(tides)} tide primaries (wlp-hilo + metadata)")
    for code, book in sorted(tides.items()):
        st = station_for(code)
        name = book["name"] if book else st["officialName"].strip().upper() if st else f"{code:05d}"
        if st is None or not has_series(st, "wlp-hilo"):
            log(f"    SKIP {code:05d} {name}: not in IWLS or no wlp-hilo")
            continue
        hilo = fetch_series(st, "wlp-hilo", "tide")
        meta = fetch_meta(st)
        rec = build_tide_station(code, name, st, meta, hilo, year, args.utc_offset, tz_label)
        if args.metadata_from == "roster":
            carry_over(rec, book, TIDE_CARRY)
        tide_out.append(rec)
        log(f"    {code:05d} {name:<24} {len(hilo):>5} hi/lo")

    # ---- current primaries
    cur_out: list[dict] = []
    log(f"--> {len(currents)} current primaries (wcp1-events + metadata)")
    for code, book in sorted(currents.items()):
        st = station_for(code)
        name = book["name"] if book else st["officialName"].strip().upper() if st else f"{code:05d}"
        if st is None or not has_series(st, "wcp1-events"):
            log(f"    SKIP {code:05d} {name}: not in IWLS or no wcp1-events")
            continue
        ev = fetch_series(st, "wcp1-events", "current")
        meta = fetch_meta(st)
        rec = build_current_station(code, name, st, meta, ev, year, args.utc_offset, tz_label)
        if args.metadata_from == "roster":
            carry_over(rec, book, CURRENT_CARRY)
        cur_out.append(rec)
        log(f"    {code:05d} {name:<24} {len(ev):>5} events")

    # ---- Table 3 secondaries (optional)
    sec_out: list[dict] = []
    if args.secondaries:
        avail = [(c, r["name"]) for c, r in sorted(secondaries.items())
                 if station_for(c) is not None and has_series(station_for(c), "wlp-hilo")]
        log(f"--> {len(avail)} of {len(secondaries)} Table 3 secondary ports have wlp-hilo in IWLS")
        for i, (code, name) in enumerate(avail, 1):
            st = station_for(code)
            hilo = fetch_series(st, "wlp-hilo", "tide")
            sec_out.append(build_tide_station(code, name, st, {}, hilo, year, args.utc_offset, tz_label))
            if i % 25 == 0 or i == len(avail):
                log(f"    {i}/{len(avail)} fetched")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    def write(name: str, stations: list[dict], compact: bool = False) -> None:
        p = args.out_dir / name
        doc = {"year": year, "source": "iwls", "generated_at": iso_z(dt.datetime.now(dt.timezone.utc)),
               "stations": stations}
        # The Table 3 port file is ~45 MB indented; it is machine-read only
        # (build_manifest.py), so write it compactly.
        body = json.dumps(doc, separators=(",", ":")) if compact else json.dumps(doc, indent=2)
        p.write_text(body + "\n")
        log(f"    wrote {p} ({len(stations)} stations)")

    write(f"{year}_iwls_tidal_primary_stations.json", tide_out)
    write(f"{year}_iwls_current_primary_stations.json", cur_out)
    if args.secondaries:
        write(f"{year}_iwls_tidal_secondary_predictions.json", sec_out, compact=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
