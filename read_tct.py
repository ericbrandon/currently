import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field

import pdfplumber

COLUMN_SPLIT_X = 315.0
INDENT_THRESHOLD_X = 80.0
ROW_TOLERANCE = 2.0


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


@dataclass
class Station:
    name: str
    page: int


@dataclass
class TOC:
    tide_stations: list[Station] = field(default_factory=list)
    current_stations: list[Station] = field(default_factory=list)
    table_pages: dict[int, int] = field(default_factory=dict)


@dataclass
class CurrentEvent:
    time: str          # "HH:MM"
    kind: str          # "slack" | "max"
    knots: float = 0.0  # signed: + flood, - ebb; 0.0 for slack and weak/variable max
    weak_variable: bool = False  # True if PDF showed '*' for the knots column


@dataclass
class CurrentDay:
    month: int   # 1-12
    day: int     # 1-31
    weekday: str
    events: list[CurrentEvent] = field(default_factory=list)


@dataclass
class CurrentStation:
    name: str
    timezone: str            # e.g. "PST-HNP"
    utc_offset: int          # e.g. -8
    year: int
    flood_direction_true: int | None = None  # degrees, from page footer
    ebb_direction_true: int | None = None    # degrees, from page footer
    # From Table 4 (REFERENCE STATIONS top half)
    index_no: int | None = None
    latitude: float | None = None         # decimal degrees, N positive
    longitude: float | None = None        # decimal degrees, W negative
    max_flood_knots: float | None = None  # at large tides
    max_ebb_knots: float | None = None    # at large tides
    days: list[CurrentDay] = field(default_factory=list)


@dataclass
class SecondaryCurrent:
    index_no: int
    name: str
    flood_direction_true: int | None = None
    latitude: float | None = None
    longitude: float | None = None
    reference_primary: str | None = None  # from "on/sur X, pages Y-Z"
    geographic_zone: str | None = None    # e.g. "PRINCESS LOUISA INLET"
    name_annotation: str | None = None    # e.g. "(HAMLEY PT.)"
    # Time differences applied to the reference station; "±HH:MM" or None
    turn_to_flood_diff: str | None = None
    flood_max_diff: str | None = None
    turn_to_ebb_diff: str | None = None
    ebb_max_diff: str | None = None
    # Percentage of reference rate (when given)
    pct_ref_flood: int | None = None
    pct_ref_ebb: int | None = None
    # Absolute max rates in knots (when given instead of percentages)
    max_flood_knots: float | None = None
    max_ebb_knots: float | None = None
    # Annotation when columns are interpreted differently (e.g. "LW HW")
    format_note: str | None = None
    # True when the "time diff" columns are offsets from a tide station's
    # low/high water times (LW/HW) rather than from a current station's
    # slack/maximum times. Reference_primary will be a tide station in this case.
    offsets_from_tides: bool = False
    has_footnote: bool = False


@dataclass
class SecondaryPort:
    index_no: int
    name: str
    utc_offset: int
    latitude: float
    longitude: float
    # Geographic context (state captured from headings preceding this row)
    area_number: int | None = None
    area_name: str | None = None
    geographic_zone: str | None = None  # immediate sub-region (e.g. "VANCOUVER ISLAND")
    reference_port: str | None = None   # from "on/sur X, pages Y-Z"
    # Tide differences (signed "±HH:MM" strings; None if absent)
    higher_high_water_time_diff: str | None = None
    higher_high_water_mean_tide_diff: float | None = None
    higher_high_water_large_tide_diff: float | None = None
    lower_low_water_time_diff: str | None = None
    lower_low_water_mean_tide_diff: float | None = None
    lower_low_water_large_tide_diff: float | None = None
    # Range and mean water level (metres)
    mean_tide_range: float | None = None
    large_tide_range: float | None = None
    mean_water_level: float | None = None
    has_footnote: bool = False


@dataclass
class TideReading:
    time: str  # "HH:MM"
    metres: float


@dataclass
class TideDay:
    month: int   # 1-12
    day: int     # 1-31
    weekday: str  # "MON".."SUN"
    readings: list[TideReading] = field(default_factory=list)


@dataclass
class TideStation:
    name: str
    timezone: str       # e.g. "PST-HNP"
    utc_offset: int     # e.g. -8
    year: int
    days: list[TideDay] = field(default_factory=list)
    # From Table 1 (REFERENCE PORTS - INFORMATION AND RANGE)
    reference_name: str | None = None     # canonical name in Table 1 (e.g. "VICTORIA")
    index_no: int | None = None
    latitude: float | None = None         # decimal degrees, N positive
    longitude: float | None = None        # decimal degrees, W negative
    tide_type: str | None = None          # e.g. "MSD", "MD"
    mean_tide_range: float | None = None  # metres
    large_tide_range: float | None = None # metres
    # From Table 2 (TIDAL HEIGHTS, EXTREMES, AND MEAN WATER LEVEL); all in metres
    higher_high_water_mean_tide: float | None = None
    higher_high_water_large_tide: float | None = None
    lower_low_water_mean_tide: float | None = None
    lower_low_water_large_tide: float | None = None
    highest_recorded_high_water: float | None = None
    lowest_recorded_low_water: float | None = None
    mean_water_level: float | None = None


TABLE_REF_PATTERN = re.compile(r"\(Tables?\s+([\d\s,and]+?)\)", re.IGNORECASE)


def _parse_table_numbers(text: str) -> list[int]:
    match = TABLE_REF_PATTERN.search(text)
    if not match:
        return []
    inside = match.group(1)
    return [int(n) for n in re.findall(r"\d+", inside)]


def find_tct_pdfs(year: int, directory: str = ".") -> list[tuple[int, str]]:
    year_str = str(year)
    vol_pattern = re.compile(r"vol(\d)(?!\d)")

    volumes: list[tuple[int, str]] = []
    for filename in os.listdir(directory):
        if not filename.lower().endswith(".pdf"):
            continue
        if "tct" not in filename.lower():
            continue
        if year_str not in filename:
            continue

        match = vol_pattern.search(filename.lower())
        if not match:
            continue

        volumes.append((int(match.group(1)), filename))

    volumes.sort(key=lambda v: v[0])
    return volumes


def _group_rows(words: list[dict]) -> list[list[dict]]:
    """Group words into rows by their `top` y-coordinate."""
    rows: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if rows and abs(w["top"] - rows[-1][0]["top"]) <= ROW_TOLERANCE:
            rows[-1].append(w)
        else:
            rows.append([w])
    for row in rows:
        row.sort(key=lambda w: w["x0"])
    return rows


def _find_toc_page(pdf: pdfplumber.PDF) -> int:
    for i, page in enumerate(pdf.pages[:15]):
        text = page.extract_text() or ""
        if "Table of Contents" in text and "Tide Tables" in text:
            return i
    raise ValueError("Table of Contents page not found")


def _printed_page_offset(pdf: pdfplumber.PDF, toc_pdf_index: int) -> int:
    """Return offset such that pdf_index = printed_page + offset."""
    page = pdf.pages[toc_pdf_index]
    words = page.extract_words()
    bottom_word = max(words, key=lambda w: w["top"])
    if not bottom_word["text"].isdigit():
        raise ValueError(f"Could not find printed page number on TOC page; bottom word was {bottom_word['text']!r}")
    return toc_pdf_index - int(bottom_word["text"])


ENGLISH_WEEKDAYS = {"MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"}
FRENCH_WEEKDAYS = {"LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"}
WEEKDAY_TOKENS = ENGLISH_WEEKDAYS | FRENCH_WEEKDAYS

# Current tables use 2-letter weekday abbreviations.
ENGLISH_CURRENT_WEEKDAYS = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


STATION_HEADER_PATTERN = re.compile(
    r"^(?P<name>[A-Z][A-Z\s\-'.]*?)\s+"
    r"(?P<tz>[A-Z]{3}-[A-Z]{3})\s+"
    r"\(UTC(?P<offset>[+-]\d+)\)\s+"
    r"(?P<year>\d{4})\s+TIDE\s+TABLES"
)


def _parse_station_header(page: pdfplumber.page.Page) -> tuple[str, str, int, int] | None:
    """Returns (name, timezone, utc_offset, year) if this is a tide-station page."""
    text = page.extract_text() or ""
    first_line = text.split("\n", 1)[0]
    match = STATION_HEADER_PATTERN.match(first_line)
    if not match:
        return None
    return (
        match.group("name").strip(),
        match.group("tz"),
        int(match.group("offset")),
        int(match.group("year")),
    )


def parse_toc(pdf_path: str) -> TOC:
    toc = TOC()
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[_find_toc_page(pdf)]
        words = [w for w in page.extract_words() if w["x0"] < COLUMN_SPLIT_X]
        rows = _group_rows(words)

    section: str | None = None  # 'tide' | 'current' | None
    for row in rows:
        first_x = row[0]["x0"]
        last_word = row[-1]["text"]
        has_page = last_word.isdigit()
        text = " ".join(w["text"] for w in row)
        indented = first_x >= INDENT_THRESHOLD_X

        if not indented and not has_page:
            if text == "Tide Tables":
                section = "tide"
            elif text == "Current Tables":
                section = "current"
            else:
                section = None
            continue

        if not indented and has_page:
            section = None
            page_num = int(last_word)
            for table_num in _parse_table_numbers(text):
                toc.table_pages[table_num] = page_num
            continue

        if indented and has_page and section is not None:
            page_num = int(last_word)
            name = " ".join(w["text"] for w in row[:-1])
            station = Station(name=name, page=page_num)
            if section == "tide":
                toc.tide_stations.append(station)
            else:
                toc.current_stations.append(station)

    return toc


def build_volume_tocs(year: int, directory: str = ".") -> dict[int, TOC]:
    return {vol: parse_toc(os.path.join(directory, fname))
            for vol, fname in find_tct_pdfs(year, directory)}


def _months_on_page(words: list[dict], header_y: float) -> list[int]:
    """Return the month numbers (1-12) appearing in the per-month header row."""
    candidates = [w for w in words if w["top"] < header_y - 2 and "-" in w["text"]]
    candidates.sort(key=lambda w: w["x0"])
    months: list[int] = []
    for w in candidates:
        eng = w["text"].split("-", 1)[0]
        if eng in MONTH_NAMES:
            months.append(MONTH_NAMES.index(eng) + 1)
    return months


def _column_x_ranges(words: list[dict], page_width: float) -> tuple[list[tuple[float, float]], list[float]]:
    """Returns (column_ranges, column_day_x).
    Six day-columns total: 3 'Day' (English, days 1-15) and 3 'Jour' (French, days 16-end),
    interleaved per month."""
    day_x = sorted(w["x0"] for w in words if w["text"] == "Day")
    jour_x = sorted(w["x0"] for w in words if w["text"] == "Jour")
    starts = sorted(day_x + jour_x)
    ranges: list[tuple[float, float]] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else page_width
        ranges.append((start - 2.0, end - 2.0))
    return ranges, starts


def _parse_day_block(rows: list[list[dict]], day_num: int) -> tuple[str, list[TideReading]]:
    weekday = ""
    readings: list[TideReading] = []
    for row in rows:
        cells = [w for w in row if w["text"] != str(day_num)]
        if len(cells) == 1 and cells[0]["text"] in WEEKDAY_TOKENS:
            if cells[0]["text"] in ENGLISH_WEEKDAYS:
                weekday = cells[0]["text"]
            continue
        cells = [w for w in cells if w["text"] not in WEEKDAY_TOKENS]
        if len(cells) != 3:
            continue
        time_text = cells[0]["text"]
        metres_text = cells[1]["text"]
        if ":" not in time_text:
            continue
        try:
            readings.append(TideReading(time=time_text, metres=float(metres_text)))
        except ValueError:
            continue
    return weekday, readings


def parse_tide_page(page: pdfplumber.page.Page) -> list[TideDay]:
    words = page.extract_words()
    day_headers = sorted(
        [w for w in words if w["text"] == "Day"], key=lambda w: w["x0"]
    )
    if len(day_headers) != 3:
        return []
    header_y = day_headers[0]["top"]
    header_row = [w for w in words
                  if abs(w["top"] - header_y) < ROW_TOLERANCE
                  and w["text"] in {"Day", "Time", "Metres", "Feet",
                                    "Jour", "Heure", "Mètres", "Pieds"}]
    data_y_start = max(w["bottom"] for w in header_row) + 1.0

    months = _months_on_page(words, header_y)
    if len(months) != 3:
        return []

    column_ranges, column_day_x = _column_x_ranges(words, page.width)
    if len(column_ranges) != 6:
        return []

    days: list[TideDay] = []
    for col_idx, ((x_start, x_end), day_x) in enumerate(zip(column_ranges, column_day_x)):
        month = months[col_idx // 2]
        col_words = [w for w in words
                     if w["top"] >= data_y_start
                     and x_start <= w["x0"] < x_end
                     and w["top"] < page.height - 30]  # exclude footer
        col_words.sort(key=lambda w: (w["top"], w["x0"]))

        markers: list[tuple[float, int]] = []
        for w in col_words:
            if abs(w["x0"] - day_x) < 4.0 and w["text"].isdigit():
                n = int(w["text"])
                if 1 <= n <= 31:
                    markers.append((w["top"], n))
        markers.sort()

        for i, (y_top, day_num) in enumerate(markers):
            y_end = markers[i + 1][0] - 1.0 if i + 1 < len(markers) else float("inf")
            block = [w for w in col_words if y_top - 1.0 <= w["top"] < y_end]
            rows = _group_rows(block)
            weekday, readings = _parse_day_block(rows, day_num)
            days.append(TideDay(month=month, day=day_num, weekday=weekday, readings=readings))

    days.sort(key=lambda d: (d.month, d.day))
    return days


def _next_station_printed_page(toc: TOC, station_index: int) -> int | None:
    """Page where the next tide station starts (or first current station if last)."""
    if station_index + 1 < len(toc.tide_stations):
        return toc.tide_stations[station_index + 1].page
    if toc.current_stations:
        return toc.current_stations[0].page
    return None


def parse_tide_station(
    pdf: pdfplumber.PDF,
    toc: TOC,
    station_index: int,
    page_offset: int,
) -> TideStation:
    entry = toc.tide_stations[station_index]
    start_idx = entry.page + page_offset
    next_printed = _next_station_printed_page(toc, station_index)
    end_idx = (next_printed + page_offset) if next_printed else len(pdf.pages)

    header = _parse_station_header(pdf.pages[start_idx])
    if header is None:
        raise ValueError(
            f"Expected tide-station header on PDF page {start_idx + 1} "
            f"for TOC entry {entry.name!r} (printed page {entry.page})"
        )
    name, tz, offset, year = header
    station = TideStation(name=name, timezone=tz, utc_offset=offset, year=year)

    for pdf_idx in range(start_idx, end_idx):
        page = pdf.pages[pdf_idx]
        if _parse_station_header(page) is None:
            continue
        station.days.extend(parse_tide_page(page))

    station.days.sort(key=lambda d: (d.month, d.day))
    return station


TABLE1_ROW_PATTERN = re.compile(
    r"^(?P<name>[A-Z][A-Z\s\-'.]+?)\s+"
    r"(?P<index>\d{4})\s+"
    r"(?P<tz>-\s*\d+)\s+"
    r"(?P<lat_d>\d+)\s+(?P<lat_m>\d+)\s+"
    r"(?P<lon_d>\d+)\s+(?P<lon_m>\d+)\s+"
    r"(?P<type>[A-Z]+)\s+"
    r"(?P<mean>\d+\.\d+)\s+(?P<large>\d+\.\d+)\s*$"
)


@dataclass
class _ReferencePortInfo:
    name: str
    index_no: int
    utc_offset: int
    latitude: float
    longitude: float
    tide_type: str
    mean_tide_range: float
    large_tide_range: float


def _fix_decimal_gaps(line: str) -> str:
    # PDF text extraction occasionally injects a stray space inside a number,
    # e.g. "4 .8", "4. 8", or "- 0.1". Collapse those so numeric regexes match.
    line = re.sub(r"(\d)\s+\.", r"\1.", line)
    line = re.sub(r"\.\s+(\d)", r".\1", line)
    line = re.sub(r"(^|\s)-\s+(\d)", r"\1-\2", line)
    return line


def parse_table1(pdf: pdfplumber.PDF, toc: TOC, page_offset: int) -> list[_ReferencePortInfo]:
    if 1 not in toc.table_pages:
        return []
    pdf_idx = toc.table_pages[1] + page_offset
    text = pdf.pages[pdf_idx].extract_text() or ""
    entries: list[_ReferencePortInfo] = []
    for line in text.split("\n"):
        m = TABLE1_ROW_PATTERN.match(_fix_decimal_gaps(line.strip()))
        if not m:
            continue
        entries.append(_ReferencePortInfo(
            name=m.group("name").strip(),
            index_no=int(m.group("index")),
            utc_offset=int(m.group("tz").replace(" ", "")),
            latitude=int(m.group("lat_d")) + int(m.group("lat_m")) / 60.0,
            longitude=-(int(m.group("lon_d")) + int(m.group("lon_m")) / 60.0),
            tide_type=m.group("type"),
            mean_tide_range=float(m.group("mean")),
            large_tide_range=float(m.group("large")),
        ))
    return entries


TABLE2_ROW_PATTERN = re.compile(
    r"^(?P<name>[A-Z][A-Z\s\-'.]+?)\s+"
    + r"\s+".join(rf"(?P<v{i}>-?\d+\.\d+)" for i in range(1, 8))
    + r"\s*$"
)


@dataclass
class _ReferenceTidalHeights:
    name: str
    higher_high_water_mean_tide: float
    higher_high_water_large_tide: float
    lower_low_water_mean_tide: float
    lower_low_water_large_tide: float
    highest_recorded_high_water: float
    lowest_recorded_low_water: float
    mean_water_level: float


def parse_table2(pdf: pdfplumber.PDF, toc: TOC, page_offset: int) -> list[_ReferenceTidalHeights]:
    if 2 not in toc.table_pages:
        return []
    pdf_idx = toc.table_pages[2] + page_offset
    text = pdf.pages[pdf_idx].extract_text() or ""
    entries: list[_ReferenceTidalHeights] = []
    for line in text.split("\n"):
        m = TABLE2_ROW_PATTERN.match(_fix_decimal_gaps(line.strip()))
        if not m:
            continue
        entries.append(_ReferenceTidalHeights(
            name=m.group("name").strip(),
            higher_high_water_mean_tide=float(m.group("v1")),
            higher_high_water_large_tide=float(m.group("v2")),
            lower_low_water_mean_tide=float(m.group("v3")),
            lower_low_water_large_tide=float(m.group("v4")),
            highest_recorded_high_water=float(m.group("v5")),
            lowest_recorded_low_water=float(m.group("v6")),
            mean_water_level=float(m.group("v7")),
        ))
    return entries


def _merge_table1_into_station(station: TideStation, info: _ReferencePortInfo) -> None:
    if not station.name.startswith(info.name):
        raise ValueError(
            f"Table 1 entry {info.name!r} does not match station {station.name!r} "
            f"(expected station name to start with the Table 1 name)"
        )
    if station.utc_offset != info.utc_offset:
        raise ValueError(
            f"UTC offset mismatch for {station.name}: "
            f"page header says {station.utc_offset}, Table 1 says {info.utc_offset}"
        )
    station.reference_name = info.name
    station.index_no = info.index_no
    station.latitude = info.latitude
    station.longitude = info.longitude
    station.tide_type = info.tide_type
    station.mean_tide_range = info.mean_tide_range
    station.large_tide_range = info.large_tide_range


_TIME_DIFF = r"[+-]?\s*\d+\s+\d+\*?"
_SF = r"[+-]?\d+\.\d+\*?"   # signed float, optional footnote *
_UF = r"\d+\.\d+\*?"        # unsigned float, optional footnote *

TABLE3_ROW_PATTERN = re.compile(
    rf"^(?P<index>\d{{4}})\s+"
    rf"(?P<name>.+?)\s+"
    rf"-?\s*(?P<tz>\d+)\s+"
    rf"(?P<lat_d>\d+)\s+(?P<lat_m>\d+)\s+"
    rf"(?P<lon_d>\d+)\s+(?P<lon_m>\d+)\s+"
    rf"(?P<hhw_time>{_TIME_DIFF})\s+"
    rf"(?P<hhw_mean>{_SF})\s+(?P<hhw_large>{_SF})\s+"
    rf"(?P<llw_time>{_TIME_DIFF})\s+"
    rf"(?P<llw_mean>{_SF})\s+(?P<llw_large>{_SF})\s+"
    rf"(?P<range_mean>{_UF})\s+(?P<range_large>{_UF})\s+"
    rf"(?P<mwl>{_UF})\s*$"
)

ON_SUR_PATTERN = re.compile(r"^on/sur\s+(?P<port>.+?),\s+pages\s+\d+", re.IGNORECASE)
AREA_PATTERN = re.compile(r"^AREA\s+(?P<n>\d+)\s*$")

# Lines that just repeat as table headers on each page; skip them.
TABLE3_HEADER_NOISE = {
    "RÉGION",
}


def _format_time_diff(raw: str) -> tuple[str, bool]:
    """Returns ('±HH:MM', has_footnote) from a token like '-0 22', '+1 36*', '0 00'."""
    has_footnote = raw.endswith("*")
    raw = raw.rstrip("*").strip()
    parts = raw.split()
    if len(parts) == 2:
        hours_part, minutes_part = parts
    elif len(parts) == 3:
        hours_part = parts[0] + parts[1]
        minutes_part = parts[2]
    else:
        raise ValueError(f"Could not parse time diff {raw!r}")
    sign = "+"
    if hours_part.startswith("-"):
        sign = "-"
        hours_part = hours_part[1:]
    elif hours_part.startswith("+"):
        hours_part = hours_part[1:]
    hours = int(hours_part)
    minutes = int(minutes_part)
    return f"{sign}{hours:02d}:{minutes:02d}", has_footnote


AREA_NAME_MAX_LINES = 2


def _split_concat_time_diff(line: str) -> str:
    # PDF text extraction sometimes drops the space between hours and minutes
    # in a time-diff token, e.g. "+013" instead of "+0 13". Re-insert the space
    # by splitting a 3-digit signed run into 1 hour-digit + 2 minute-digits.
    return re.sub(r"(?<!\d)([+-])(\d)(\d{2})(?=\s|$)", r"\1\2 \3", line)


def _parse_t3_float(s: str) -> tuple[float, bool]:
    has_foot = s.endswith("*")
    return float(s.rstrip("*")), has_foot


def parse_table3(pdf: pdfplumber.PDF, toc: TOC, page_offset: int) -> list[SecondaryPort]:
    if 3 not in toc.table_pages or 4 not in toc.table_pages:
        return []
    start_idx = toc.table_pages[3] + page_offset
    end_idx = toc.table_pages[4] + page_offset

    ports: list[SecondaryPort] = []
    area_names_by_num: dict[int, str] = {}   # canonical name from first encounter
    state_area_num: int | None = None
    pending_area_lines: list[str] = []
    collecting_area = False
    state_ref_port: str | None = None
    zone_lines: list[str] = []
    zone_used_by_port = False
    in_footnote = False

    def current_area_name() -> str | None:
        if state_area_num is None:
            return None
        return area_names_by_num.get(state_area_num) or (" ".join(pending_area_lines) or None)

    for pdf_idx in range(start_idx, end_idx):
        page = pdf.pages[pdf_idx]
        text = page.extract_text() or ""
        in_footnote = False
        for raw_line in text.split("\n"):
            line = raw_line.strip()
            if not line or line in TABLE3_HEADER_NOISE:
                continue
            if line.isdigit():
                continue
            if line.startswith("*"):
                in_footnote = True
                continue
            if in_footnote:
                continue

            normalized = _split_concat_time_diff(line)
            m = TABLE3_ROW_PATTERN.match(normalized)
            if not m:
                # Recovery: a dropped space inside a time-diff token sometimes
                # surfaces as a stray decimal point, e.g. "+0.05" instead of
                # "+0 05". Only apply when the normal match fails.
                recovered = re.sub(r"(?<!\d)([+-])(\d)\.(\d{2})(?=\s|$)", r"\1\2 \3", normalized)
                if recovered != normalized:
                    m = TABLE3_ROW_PATTERN.match(recovered)
            if m:
                # finalize area name on first port encountered after AREA marker
                if collecting_area and pending_area_lines and state_area_num is not None:
                    area_names_by_num.setdefault(state_area_num, " ".join(pending_area_lines))
                    pending_area_lines = []
                    collecting_area = False
                hhw_time, hhw_flag = _format_time_diff(m.group("hhw_time"))
                llw_time, llw_flag = _format_time_diff(m.group("llw_time"))
                hhw_mean, fa = _parse_t3_float(m.group("hhw_mean"))
                hhw_large, fb = _parse_t3_float(m.group("hhw_large"))
                llw_mean, fc = _parse_t3_float(m.group("llw_mean"))
                llw_large, fd = _parse_t3_float(m.group("llw_large"))
                range_mean, _ = _parse_t3_float(m.group("range_mean"))
                range_large, _ = _parse_t3_float(m.group("range_large"))
                mwl, _ = _parse_t3_float(m.group("mwl"))
                ports.append(SecondaryPort(
                    index_no=int(m.group("index")),
                    name=m.group("name").strip(),
                    utc_offset=-int(m.group("tz")),
                    latitude=int(m.group("lat_d")) + int(m.group("lat_m")) / 60.0,
                    longitude=-(int(m.group("lon_d")) + int(m.group("lon_m")) / 60.0),
                    area_number=state_area_num,
                    area_name=current_area_name(),
                    geographic_zone=" ".join(zone_lines) or None,
                    reference_port=state_ref_port,
                    higher_high_water_time_diff=hhw_time,
                    higher_high_water_mean_tide_diff=hhw_mean,
                    higher_high_water_large_tide_diff=hhw_large,
                    lower_low_water_time_diff=llw_time,
                    lower_low_water_mean_tide_diff=llw_mean,
                    lower_low_water_large_tide_diff=llw_large,
                    mean_tide_range=range_mean,
                    large_tide_range=range_large,
                    mean_water_level=mwl,
                    has_footnote=hhw_flag or llw_flag or fa or fb or fc or fd,
                ))
                zone_used_by_port = True
                continue

            # Skip malformed port rows (start with 4-digit index but didn't match).
            if re.match(r"^\d{4}\s", line):
                _log(f"      WARN: could not parse port row: {line!r}")
                continue

            am = AREA_PATTERN.match(line)
            if am:
                state_area_num = int(am.group("n"))
                pending_area_lines = []
                collecting_area = state_area_num not in area_names_by_num
                zone_lines = []
                zone_used_by_port = False
                continue

            om = ON_SUR_PATTERN.match(line)
            if om:
                # finalize area name if we were still collecting
                if collecting_area and pending_area_lines and state_area_num is not None:
                    area_names_by_num.setdefault(state_area_num, " ".join(pending_area_lines))
                pending_area_lines = []
                collecting_area = False
                state_ref_port = om.group("port").strip()
                zone_lines = []
                zone_used_by_port = False
                continue

            if line.startswith("see/voir"):
                continue
            if line.startswith("(") and line.endswith(")"):
                continue
            if any(noise in line for noise in ("SECONDARY PORTS TABLE 3",
                                                "INFORMATION AND TIDAL",
                                                "RENSEIGNEMENTS",
                                                "DIFFERENCES DIFFÉRENCES",
                                                "RANGE MEAN",
                                                "PLEINE MER",
                                                "NIVEAU",
                                                "D'INDEX",
                                                "HORAIRE",
                                                "MOYENNE MARÉE",
                                                "° '",
                                                "LAT. N.",
                                                "TIDE TIDE",
                                                "IN N D O E")):
                continue

            if collecting_area and len(pending_area_lines) < AREA_NAME_MAX_LINES:
                pending_area_lines.append(line)
                if len(pending_area_lines) == AREA_NAME_MAX_LINES and state_area_num is not None:
                    # Lock in canonical area name once we've collected the cap.
                    area_names_by_num.setdefault(state_area_num, " ".join(pending_area_lines))
                    collecting_area = False
                    pending_area_lines = []
            else:
                # Treat as a sub-region (geographic zone). If the previous
                # zone has already labelled at least one port row, this line
                # starts a fresh zone; otherwise it's a continuation line.
                if zone_used_by_port:
                    zone_lines = [line]
                    zone_used_by_port = False
                else:
                    zone_lines.append(line)

    return ports


def _merge_table2_into_station(station: TideStation, info: _ReferenceTidalHeights) -> None:
    expected_name = station.reference_name or station.name
    if not station.name.startswith(info.name):
        raise ValueError(
            f"Table 2 entry {info.name!r} does not match station {station.name!r} "
            f"(expected station name to start with the Table 2 name)"
        )
    if station.reference_name is not None and info.name != expected_name:
        raise ValueError(
            f"Table 2 name {info.name!r} disagrees with Table 1 name {expected_name!r}"
        )
    station.higher_high_water_mean_tide = info.higher_high_water_mean_tide
    station.higher_high_water_large_tide = info.higher_high_water_large_tide
    station.lower_low_water_mean_tide = info.lower_low_water_mean_tide
    station.lower_low_water_large_tide = info.lower_low_water_large_tide
    station.highest_recorded_high_water = info.highest_recorded_high_water
    station.lowest_recorded_low_water = info.lowest_recorded_low_water
    station.mean_water_level = info.mean_water_level


def build_tide_stations(pdf_path: str, toc: TOC) -> list[TideStation]:
    stations: list[TideStation] = []
    with pdfplumber.open(pdf_path) as pdf:
        offset = _printed_page_offset(pdf, _find_toc_page(pdf))
        for i, entry in enumerate(toc.tide_stations):
            _log(f"      [{i + 1}/{len(toc.tide_stations)}] parsing tide station "
                 f"'{entry.name}' (printed page {entry.page})")
            stations.append(parse_tide_station(pdf, toc, i, offset))
        _log(f"      reading Table 1 (printed page {toc.table_pages.get(1, '?')})")
        table1 = parse_table1(pdf, toc, offset)
        _log(f"      reading Table 2 (printed page {toc.table_pages.get(2, '?')})")
        table2 = parse_table2(pdf, toc, offset)
    if table1:
        if len(table1) != len(stations):
            raise ValueError(
                f"Table 1 row count ({len(table1)}) does not match tide station count "
                f"({len(stations)})"
            )
        for station, info in zip(stations, table1):
            _merge_table1_into_station(station, info)
    if table2:
        if len(table2) != len(stations):
            raise ValueError(
                f"Table 2 row count ({len(table2)}) does not match tide station count "
                f"({len(stations)})"
            )
        for station, info in zip(stations, table2):
            _merge_table2_into_station(station, info)
    return stations


def _format_coord(value: float, pos_hemi: str, neg_hemi: str) -> str:
    hemi = pos_hemi if value >= 0 else neg_hemi
    mag = abs(value)
    deg = int(mag)
    minutes = round((mag - deg) * 60)
    if minutes == 60:
        deg += 1
        minutes = 0
    return f"{mag:8.4f}°{hemi}  ({deg}°{minutes:02d}'{hemi})"


def pretty_print_tide_station(station: TideStation) -> None:
    print("=" * 88)
    print(f"{station.name}  ({station.timezone}, UTC{station.utc_offset:+d})  {station.year}")
    if station.index_no is not None:
        lat = _format_coord(station.latitude, "N", "S") if station.latitude is not None else "?"
        lon = _format_coord(station.longitude, "E", "W") if station.longitude is not None else "?"
        print(f"  Index #{station.index_no}   {lat}   {lon}   "
              f"Tide type: {station.tide_type}   "
              f"Mean range: {station.mean_tide_range} m   "
              f"Large range: {station.large_tide_range} m")
    if station.mean_water_level is not None:
        print(f"  Higher high water:  mean tide {station.higher_high_water_mean_tide} m, "
              f"large tide {station.higher_high_water_large_tide} m")
        print(f"  Lower low water:    mean tide {station.lower_low_water_mean_tide} m, "
              f"large tide {station.lower_low_water_large_tide} m")
        print(f"  Recorded extremes:  highest {station.highest_recorded_high_water} m, "
              f"lowest {station.lowest_recorded_low_water} m")
        print(f"  Mean water level:   {station.mean_water_level} m")
    print("=" * 88)
    days_by_month: dict[int, list[TideDay]] = {}
    for d in station.days:
        days_by_month.setdefault(d.month, []).append(d)

    for month in sorted(days_by_month):
        print()
        print(f"--- {MONTH_NAMES[month - 1]} ---")
        print(f"{'Date':>5}  {'Day':<3}  {'Time':<5}  {'Metres':>6}")
        for d in days_by_month[month]:
            if not d.readings:
                print(f"{d.day:>5}  {d.weekday:<3}  (no readings)")
                continue
            for i, r in enumerate(d.readings):
                date_col = f"{d.day}" if i == 0 else ""
                wkday_col = d.weekday if i == 0 else ""
                print(f"{date_col:>5}  {wkday_col:<3}  {r.time:<5}  {r.metres:>6.1f}")


def build_secondary_ports(pdf_path: str, toc: TOC) -> list[SecondaryPort]:
    with pdfplumber.open(pdf_path) as pdf:
        offset = _printed_page_offset(pdf, _find_toc_page(pdf))
        return parse_table3(pdf, toc, offset)


# Sub-column boundaries within a current-table day-column (offsets relative to day_x).
_CURR_SUB_DAY = (-5.0, 18.0)
_CURR_SUB_TURN = (18.0, 36.0)
_CURR_SUB_MAX = (36.0, 60.0)
_CURR_SUB_KNOTS = (60.0, 92.0)
_CURR_DAY_COL_WIDTH = 92.0
_CURRENT_STATION_PAGES = 4

FLOOD_EBB_PATTERN = re.compile(
    r"Flood/flot\s+direction\s+(?P<flood>\d+)\s+True/vraie\s+"
    r"-\s*Ebb/jusant\s+direction\s+(?P<ebb>\d+)\s+True/vraie",
    re.IGNORECASE,
)


def _parse_current_header(page: pdfplumber.page.Page) -> tuple[str, int, int] | None:
    """Returns (name, utc_offset, year) if this looks like a current-table page."""
    text = page.extract_text() or ""
    lines = text.split("\n")
    if len(lines) < 3:
        return None
    year_line, name_line, tz_line = (lines[0].strip(), lines[1].strip(), lines[2].strip())
    if not (year_line.isdigit() and len(year_line) == 4):
        return None
    if not name_line or not name_line[0].isupper():
        return None
    m = re.search(r"\(UTC([+-]\d+)h?\)", tz_line)
    if not m:
        return None
    return name_line, int(m.group(1)), int(year_line)


def _parse_flood_ebb(page: pdfplumber.page.Page) -> tuple[int | None, int | None]:
    text = page.extract_text() or ""
    m = FLOOD_EBB_PATTERN.search(text)
    if not m:
        return None, None
    return int(m.group("flood")), int(m.group("ebb"))


def _classify_current_sub(word: dict, day_x: float) -> str:
    rel = word["x0"] - day_x
    if _CURR_SUB_DAY[0] <= rel < _CURR_SUB_DAY[1]:
        return "day"
    if _CURR_SUB_TURN[0] <= rel < _CURR_SUB_TURN[1]:
        return "turn"
    if _CURR_SUB_MAX[0] <= rel < _CURR_SUB_MAX[1]:
        return "max"
    if _CURR_SUB_KNOTS[0] <= rel < _CURR_SUB_KNOTS[1]:
        return "knots"
    return "?"


def _hhmm_to_colon(text: str) -> str | None:
    if len(text) != 4 or not text.isdigit():
        return None
    return f"{text[:2]}:{text[2:]}"


def parse_current_page(page: pdfplumber.page.Page) -> list[CurrentDay]:
    words = page.extract_words()
    day_headers = sorted([w for w in words if w["text"] == "Day"], key=lambda w: w["x0"])
    jour_headers = sorted([w for w in words if w["text"] == "jour"], key=lambda w: w["x0"])
    if len(day_headers) != 3 or len(jour_headers) != 3:
        return []

    months = _months_on_page(words, day_headers[0]["top"])
    if len(months) != 3:
        # Try lowercase French month suffix (this volume uses "January-janvier" — already handled)
        return []

    day_xs = sorted([w["x0"] for w in (*day_headers, *jour_headers)])
    if len(day_xs) != 6:
        return []

    header_y = day_headers[0]["top"]
    header_row_words = [w for w in words if abs(w["top"] - header_y) < ROW_TOLERANCE]
    data_y_start = max(w["bottom"] for w in header_row_words) + 1.0
    data_y_end = page.height - 30.0  # exclude footer band

    days: list[CurrentDay] = []
    for col_idx, day_x in enumerate(day_xs):
        month = months[col_idx // 2]
        x_lo = day_x + _CURR_SUB_DAY[0]
        x_hi = day_x + _CURR_DAY_COL_WIDTH
        col_words = [w for w in words
                     if data_y_start <= w["top"] < data_y_end
                     and x_lo <= w["x0"] < x_hi]
        col_words.sort(key=lambda w: (w["top"], w["x0"]))

        markers: list[tuple[float, int]] = []
        for w in col_words:
            if _classify_current_sub(w, day_x) == "day" and w["text"].isdigit():
                n = int(w["text"])
                if 1 <= n <= 31:
                    markers.append((w["top"], n))
        markers.sort()

        for i, (y_top, day_num) in enumerate(markers):
            y_end = (markers[i + 1][0] - 3.0) if i + 1 < len(markers) else float("inf")
            block = [w for w in col_words if y_top - 3.0 <= w["top"] < y_end]
            rows = _group_rows(block)

            weekday = ""
            events: list[CurrentEvent] = []
            for row in rows:
                buckets: dict[str, list[dict]] = {"day": [], "turn": [], "max": [], "knots": []}
                for w in row:
                    sub = _classify_current_sub(w, day_x)
                    if sub in buckets:
                        buckets[sub].append(w)

                for w in buckets["day"]:
                    txt = w["text"]
                    if txt == str(day_num):
                        continue
                    if txt in ENGLISH_CURRENT_WEEKDAYS and not weekday:
                        weekday = txt

                # A turn-only row contributes a slack event.
                for w in buckets["turn"]:
                    t = _hhmm_to_colon(w["text"])
                    if t:
                        events.append(CurrentEvent(time=t, kind="slack"))

                # A max time + knots row contributes a max event.
                if buckets["max"]:
                    time_text = next((w["text"] for w in buckets["max"]
                                      if _hhmm_to_colon(w["text"])), None)
                    knots_text = buckets["knots"][0]["text"] if buckets["knots"] else None
                    if time_text and knots_text is not None:
                        t = _hhmm_to_colon(time_text)
                        if t:
                            if knots_text == "*":
                                events.append(CurrentEvent(
                                    time=t, kind="max", knots=0.0, weak_variable=True))
                            else:
                                try:
                                    events.append(CurrentEvent(
                                        time=t, kind="max", knots=float(knots_text)))
                                except ValueError:
                                    pass

            events.sort(key=lambda e: e.time)
            days.append(CurrentDay(month=month, day=day_num, weekday=weekday, events=events))

    days.sort(key=lambda d: (d.month, d.day))
    return days


def parse_current_station(
    pdf: pdfplumber.PDF,
    toc: TOC,
    station_index: int,
    page_offset: int,
) -> CurrentStation:
    entry = toc.current_stations[station_index]
    start_idx = entry.page + page_offset
    end_idx = start_idx + _CURRENT_STATION_PAGES

    header = _parse_current_header(pdf.pages[start_idx])
    if header is None:
        raise ValueError(
            f"Expected current-station header on PDF page {start_idx + 1} "
            f"for TOC entry {entry.name!r} (printed page {entry.page})"
        )
    name, utc_offset, year = header
    flood_dir, ebb_dir = _parse_flood_ebb(pdf.pages[start_idx])

    station = CurrentStation(
        name=name,
        timezone="PST-HNP",
        utc_offset=utc_offset,
        year=year,
        flood_direction_true=flood_dir,
        ebb_direction_true=ebb_dir,
    )

    for pdf_idx in range(start_idx, end_idx):
        page = pdf.pages[pdf_idx]
        if _parse_current_header(page) is None:
            continue
        station.days.extend(parse_current_page(page))

    station.days.sort(key=lambda d: (d.month, d.day))
    return station


TABLE4_COLUMNS: dict[str, tuple[float, float]] = {
    "index":      (40.0,  70.0),
    "name":       (70.0,  180.0),
    "flood_dir":  (180.0, 210.0),
    "lat_d":      (205.0, 220.0),
    "lat_m":      (220.0, 235.0),
    "lon_d":      (235.0, 252.0),
    "lon_m":      (252.0, 270.0),
    "turn_flood": (275.0, 318.0),
    "flood_max":  (318.0, 358.0),
    "turn_ebb":   (358.0, 405.0),
    "ebb_max":    (405.0, 445.0),
    "max_flood":  (445.0, 480.0),
    "max_ebb":    (480.0, 510.0),
    "pct_flood":  (510.0, 545.0),
    "pct_ebb":    (545.0, 600.0),
}


def _bucket_by_column(words: list[dict]) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = {col: [] for col in TABLE4_COLUMNS}
    for w in words:
        x = w["x0"]
        for col, (lo, hi) in TABLE4_COLUMNS.items():
            if lo <= x < hi:
                buckets[col].append(w)
                break
    for col in buckets:
        buckets[col].sort(key=lambda w: w["x0"])
    return buckets


def _parse_t4_time_diff(words: list[dict]) -> tuple[str | None, bool]:
    """Returns ('±HH:MM', has_footnote) from words like ['+1', '30(a)']."""
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


@dataclass
class _ReferenceCurrentInfo:
    index_no: int
    name: str
    latitude: float | None
    longitude: float | None
    flood_direction_true: int | None
    max_flood_knots: float | None
    max_ebb_knots: float | None


def parse_table4(
    pdf: pdfplumber.PDF, toc: TOC, page_offset: int
) -> tuple[list[_ReferenceCurrentInfo], list[SecondaryCurrent]]:
    if 4 not in toc.table_pages:
        return [], []
    pdf_idx = toc.table_pages[4] + page_offset
    page = pdf.pages[pdf_idx]
    words = page.extract_words()

    rows: dict[int, list[dict]] = {}
    for w in words:
        rows.setdefault(round(w["top"]), []).append(w)
    sorted_tops = sorted(rows.keys())

    refs: list[_ReferenceCurrentInfo] = []
    secs: list[SecondaryCurrent] = []
    seen_on_sur = False
    current_ref_primary: str | None = None
    pending_zone: str | None = None
    pending_format_note: str | None = None

    for top in sorted_tops:
        row = sorted(rows[top], key=lambda w: w["x0"])
        text = " ".join(w["text"] for w in row).strip()

        # Data row: starts with a 4-digit index in the leftmost column
        if row and row[0]["text"].isdigit() and len(row[0]["text"]) == 4 and row[0]["x0"] < 70:
            buckets = _bucket_by_column(row)
            if not buckets["index"]:
                continue
            try:
                index_no = int(buckets["index"][0]["text"])
            except ValueError:
                continue
            name = " ".join(w["text"] for w in buckets["name"]).strip()

            flood_dir = None
            if buckets["flood_dir"] and buckets["flood_dir"][0]["text"].isdigit():
                flood_dir = int(buckets["flood_dir"][0]["text"])

            latitude = longitude = None
            if buckets["lat_d"] and buckets["lat_m"]:
                try:
                    latitude = int(buckets["lat_d"][0]["text"]) + int(buckets["lat_m"][0]["text"]) / 60.0
                except ValueError:
                    pass
            if buckets["lon_d"] and buckets["lon_m"]:
                try:
                    longitude = -(int(buckets["lon_d"][0]["text"]) + int(buckets["lon_m"][0]["text"]) / 60.0)
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
                refs.append(_ReferenceCurrentInfo(
                    index_no=index_no, name=name,
                    latitude=latitude, longitude=longitude,
                    flood_direction_true=flood_dir,
                    max_flood_knots=max_flood, max_ebb_knots=max_ebb,
                ))
                continue

            # Some volumes inline the LW/HW markers per data row instead of in
            # a header above the section (e.g. Vol7 Prince Rupert tide-referenced
            # secondaries). The "LW" token can fall in the gap between bucket
            # column ranges and get dropped, while "HW" lands inside turn_ebb
            # and trips its time-diff parser. Detect and strip these inline.
            row_texts = [w["text"] for w in row]
            inline_lw_hw = "LW" in row_texts and "HW" in row_texts
            if inline_lw_hw:
                tf, fa = _parse_t4_time_diff(
                    [w for w in buckets["turn_flood"] if w["text"] != "LW"]
                )
                te, fc = _parse_t4_time_diff(
                    [w for w in buckets["turn_ebb"] if w["text"] != "HW"]
                )
                fm = em = None
                fb = fd = False
            else:
                tf, fa = _parse_t4_time_diff(buckets["turn_flood"])
                fm, fb = _parse_t4_time_diff(buckets["flood_max"])
                te, fc = _parse_t4_time_diff(buckets["turn_ebb"])
                em, fd = _parse_t4_time_diff(buckets["ebb_max"])
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
            if offsets_from_tides and pending_zone:
                # The "zone" header is actually a name prefix wrapped to its own
                # line because the full name didn't fit (e.g. "PRINCESS LOUISA INLET MALIBU RAPIDS").
                name = f"{pending_zone} {name}".strip()
                effective_zone: str | None = None
            else:
                effective_zone = pending_zone

            secs.append(SecondaryCurrent(
                index_no=index_no, name=name,
                flood_direction_true=flood_dir,
                latitude=latitude, longitude=longitude,
                reference_primary=current_ref_primary,
                geographic_zone=effective_zone,
                turn_to_flood_diff=tf, flood_max_diff=fm,
                turn_to_ebb_diff=te, ebb_max_diff=em,
                pct_ref_flood=pct_f, pct_ref_ebb=pct_e,
                max_flood_knots=max_flood, max_ebb_knots=max_ebb,
                format_note=None if offsets_from_tides else pending_format_note,
                offsets_from_tides=offsets_from_tides,
                has_footnote=any([fa, fb, fc, fd]),
            ))
            pending_zone = None
            pending_format_note = None
            continue

        # Non-data row: classify
        m = ON_SUR_PATTERN.match(text)
        if m:
            seen_on_sur = True
            current_ref_primary = m.group("port").strip()
            pending_zone = None
            pending_format_note = None
            continue

        if text == "LW HW":
            pending_format_note = "LW HW"
            continue

        if text.startswith("(") and text.endswith(")") and not text.startswith("(a)"):
            if secs and secs[-1].name_annotation is None:
                secs[-1].name_annotation = text
            continue

        # Skip footnote rows and known table headers (presence-of-keyword test)
        if any(kw in text for kw in (
            "REFERENCE AND SECONDARY", "STATIONS DE RÉFERENCE", "STATIONS DE RÉFÉRENCE",
            "INFORMATION RATES", "INFORMATION VITESSES",
            "CURRENT STATIONS", "INDEX POSITION", "NO. CURRENT STATION",
            "DIFFÉRENCES DE TEMPS", "D'INDEX STATION",
            "REFERENCE STATION", "STATION DE RÉFÉRENCE",
            "SECONDARY STATION", "STATION SECONDAIRE",
            "TURN TO MAXIMUM", "TIME DIFFERENCES",
            "MAXIMUM RATE", "% REF.", "% VITESSE",
            "FLOOD FLOOD EBB EBB", "FLOT JUSANT",
            "RENV. VERS", "° true", "° vraie",
            "noeuds", "DIR. DU", "DIR. OF FLOOD",
            "knots knots",
        )):
            continue

        if text.startswith("(a)") or text.startswith("*"):
            continue
        if text.isdigit():
            continue  # footer

        # Anything else after seeing "on/sur" is a geographic zone heading.
        if seen_on_sur and text:
            pending_zone = text

    return refs, secs


def _normalize_station_name(name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", " ", name.upper()).strip()


def _merge_table4_into_current_station(
    station: CurrentStation, info: _ReferenceCurrentInfo
) -> None:
    station.index_no = info.index_no
    station.latitude = info.latitude
    station.longitude = info.longitude
    station.max_flood_knots = info.max_flood_knots
    station.max_ebb_knots = info.max_ebb_knots
    if info.flood_direction_true is not None and station.flood_direction_true is None:
        station.flood_direction_true = info.flood_direction_true


def build_current_stations(pdf_path: str, toc: TOC) -> tuple[list[CurrentStation], list[SecondaryCurrent]]:
    stations: list[CurrentStation] = []
    with pdfplumber.open(pdf_path) as pdf:
        offset = _printed_page_offset(pdf, _find_toc_page(pdf))
        for i, entry in enumerate(toc.current_stations):
            _log(f"      [{i + 1}/{len(toc.current_stations)}] parsing current station "
                 f"'{entry.name}' (printed page {entry.page})")
            stations.append(parse_current_station(pdf, toc, i, offset))
        _log(f"      reading Table 4 (printed page {toc.table_pages.get(4, '?')})")
        ref_infos, secondary_currents = parse_table4(pdf, toc, offset)
    if ref_infos:
        if len(ref_infos) != len(stations):
            raise ValueError(
                f"Table 4 reference row count ({len(ref_infos)}) does not match "
                f"current station count ({len(stations)})"
            )
        info_by_name = {_normalize_station_name(info.name): info for info in ref_infos}
        if len(info_by_name) != len(ref_infos):
            raise ValueError("Table 4 reference rows have duplicate station names")
        for station in stations:
            key = _normalize_station_name(station.name)
            info = info_by_name.get(key)
            if info is None:
                raise ValueError(
                    f"No Table 4 reference row matches current station {station.name!r}; "
                    f"available: {sorted(info_by_name)}"
                )
            _merge_table4_into_current_station(station, info)
    return stations, secondary_currents


def pretty_print_current_station(station: CurrentStation) -> None:
    print("=" * 88)
    print(f"{station.name}  ({station.timezone}, UTC{station.utc_offset:+d})  {station.year}")
    if station.flood_direction_true is not None:
        print(f"  Flood: {station.flood_direction_true:>3}° true   "
              f"Ebb: {station.ebb_direction_true:>3}° true")
    if station.index_no is not None:
        lat = _format_coord(station.latitude, "N", "S") if station.latitude is not None else "?"
        lon = _format_coord(station.longitude, "E", "W") if station.longitude is not None else "?"
        print(f"  Index #{station.index_no}   {lat}   {lon}")
        print(f"  Max rates (large tides):  flood {station.max_flood_knots} kts  "
              f"ebb {station.max_ebb_knots} kts")
    print("=" * 88)
    by_month: dict[int, list[CurrentDay]] = {}
    for d in station.days:
        by_month.setdefault(d.month, []).append(d)
    for month in sorted(by_month):
        print()
        print(f"--- {MONTH_NAMES[month - 1]} ---")
        print(f"{'Date':>5}  {'Day':<3}  {'Time':<5}  {'Type':<5}  {'Knots':>6}")
        for d in by_month[month]:
            if not d.events:
                print(f"{d.day:>5}  {d.weekday:<3}  (no events)")
                continue
            for i, e in enumerate(d.events):
                date_col = f"{d.day}" if i == 0 else ""
                wkday_col = d.weekday if i == 0 else ""
                if e.kind == "slack":
                    knots_col = "  --"
                elif e.weak_variable:
                    knots_col = "   * "
                else:
                    knots_col = f"{e.knots:+6.1f}"
                print(f"{date_col:>5}  {wkday_col:<3}  {e.time:<5}  {e.kind:<5}  {knots_col}")


def pretty_print_secondary_currents(ports: list[SecondaryCurrent]) -> None:
    print("=" * 100)
    print(f"SECONDARY CURRENT STATIONS  ({len(ports)} total)")
    print("=" * 100)
    last_ref: object | None = object()
    last_zone: object | None = object()
    for p in ports:
        if p.reference_primary != last_ref:
            print()
            print(f"on/sur {p.reference_primary}")
            last_ref = p.reference_primary
            last_zone = object()
        if p.geographic_zone != last_zone:
            if p.geographic_zone:
                print(f"  [{p.geographic_zone}]")
            last_zone = p.geographic_zone
        flag = " *" if p.has_footnote else ""
        annot = f"  {p.name_annotation}" if p.name_annotation else ""
        fmt = f"  ({p.format_note})" if p.format_note else ""
        tide_ref = "  (offsets from TIDES of reference)" if p.offsets_from_tides else ""
        print(f"    #{p.index_no} {p.name}{annot}{fmt}{tide_ref}{flag}")
        lat = _format_coord(p.latitude, "N", "S") if p.latitude is not None else "?"
        lon = _format_coord(p.longitude, "E", "W") if p.longitude is not None else "?"
        flood_dir = f"flood dir {p.flood_direction_true}°" if p.flood_direction_true is not None else "flood dir ?"
        print(f"      {lat}   {lon}   {flood_dir}")
        diffs = []
        if p.turn_to_flood_diff:
            diffs.append(f"turn→flood {p.turn_to_flood_diff}")
        if p.flood_max_diff:
            diffs.append(f"flood-max {p.flood_max_diff}")
        if p.turn_to_ebb_diff:
            diffs.append(f"turn→ebb {p.turn_to_ebb_diff}")
        if p.ebb_max_diff:
            diffs.append(f"ebb-max {p.ebb_max_diff}")
        if diffs:
            print(f"      diffs: {'  '.join(diffs)}")
        if p.pct_ref_flood is not None:
            print(f"      % ref:  flood {p.pct_ref_flood}%   ebb {p.pct_ref_ebb}%")
        if p.max_flood_knots is not None:
            print(f"      abs:    flood {p.max_flood_knots} kts   ebb {p.max_ebb_knots} kts")


def pretty_print_secondary_ports(ports: list[SecondaryPort]) -> None:
    print("=" * 100)
    print(f"SECONDARY PORTS  ({len(ports)} total)")
    print("=" * 100)
    last_area: int | None = object()  # type: ignore[assignment]
    last_ref: object | None = object()
    last_zone: object | None = object()
    for p in ports:
        if p.area_number != last_area:
            print()
            print(f"AREA {p.area_number} — {p.area_name}")
            last_area = p.area_number
            last_ref = object()
            last_zone = object()
        if p.reference_port != last_ref:
            print(f"  on/sur {p.reference_port}")
            last_ref = p.reference_port
            last_zone = object()
        if p.geographic_zone != last_zone:
            label = p.geographic_zone if p.geographic_zone else "(no zone)"
            print(f"    [{label}]")
            last_zone = p.geographic_zone
        lat = _format_coord(p.latitude, "N", "S")
        lon = _format_coord(p.longitude, "E", "W")
        flag = " *" if p.has_footnote else ""
        print(f"      #{p.index_no} {p.name}{flag}")
        print(f"        {lat}   {lon}   UTC{p.utc_offset:+d}")
        print(f"        HHW diff: time {p.higher_high_water_time_diff}  "
              f"mean {p.higher_high_water_mean_tide_diff:+.1f} m  "
              f"large {p.higher_high_water_large_tide_diff:+.1f} m")
        print(f"        LLW diff: time {p.lower_low_water_time_diff}  "
              f"mean {p.lower_low_water_mean_tide_diff:+.1f} m  "
              f"large {p.lower_low_water_large_tide_diff:+.1f} m")
        print(f"        Range:    mean {p.mean_tide_range} m  large {p.large_tide_range} m   "
              f"MWL {p.mean_water_level} m")


def write_primary_stations_json(
    stations: list[TideStation],
    year: int,
    directory: str,
) -> str:
    path = os.path.join(directory, f"{year}_tct_tidal_primary_stations.json")
    payload = {
        "year": year,
        "stations": [asdict(s) for s in stations],
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    return path


def write_secondary_ports_json(
    ports: list[SecondaryPort],
    year: int,
    directory: str,
) -> str:
    path = os.path.join(directory, f"{year}_tct_tidal_secondary_stations.json")
    payload = {
        "year": year,
        "stations": [asdict(p) for p in ports],
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    return path


def write_current_stations_json(
    stations: list[CurrentStation],
    year: int,
    directory: str,
) -> str:
    path = os.path.join(directory, f"{year}_tct_current_primary_stations.json")
    payload = {
        "year": year,
        "stations": [asdict(s) for s in stations],
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    return path


def write_secondary_currents_json(
    ports: list[SecondaryCurrent],
    year: int,
    directory: str,
) -> str:
    path = os.path.join(directory, f"{year}_tct_current_secondary_stations.json")
    payload = {
        "year": year,
        "stations": [asdict(p) for p in ports],
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Parse Canadian Tide & Current Tables PDFs into structured data."
    )
    parser.add_argument("--year", type=int, required=True,
                        help="Year of the TCT volumes to process (e.g. 2026)")
    parser.add_argument("--directory", default=".",
                        help="Directory to scan for TCT PDFs (default: current dir)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Pretty-print all primary tide stations to stdout")
    args = parser.parse_args()

    _log(f"==> Scanning {args.directory!r} for TCT PDFs (year {args.year})")
    pdfs = find_tct_pdfs(args.year, args.directory)
    if not pdfs:
        _log(f"    no TCT PDFs found for year {args.year}")
        return 1
    _log(f"    found {len(pdfs)} volume(s): "
         + ", ".join(f"vol{v}" for v, _ in pdfs))

    all_stations: list[TideStation] = []
    all_secondary: list[SecondaryPort] = []
    all_current: list[CurrentStation] = []
    all_secondary_currents: list[SecondaryCurrent] = []
    for vol, fname in pdfs:
        path = os.path.join(args.directory, fname)
        _log(f"==> vol{vol}: {fname}")
        _log(f"    parsing table of contents")
        toc = parse_toc(path)
        _log(f"    TOC: {len(toc.tide_stations)} tide station(s), "
             f"{len(toc.current_stations)} current station(s), "
             f"{len(toc.table_pages)} numbered table(s)")
        _log(f"    extracting tide-station data")
        stations = build_tide_stations(path, toc)
        _log(f"    vol{vol}: extracted {len(stations)} tide station(s); "
             f"days total = {sum(len(s.days) for s in stations)}")
        all_stations.extend(stations)

        _log(f"    extracting secondary-port data (Table 3, "
             f"printed pages {toc.table_pages.get(3, '?')}-{toc.table_pages.get(4, '?')-1 if 4 in toc.table_pages else '?'})")
        secondary = build_secondary_ports(path, toc)
        _log(f"    vol{vol}: extracted {len(secondary)} secondary port(s)")
        all_secondary.extend(secondary)

        _log(f"    extracting current-station data")
        current, secondary_currents = build_current_stations(path, toc)
        _log(f"    vol{vol}: extracted {len(current)} current station(s); "
             f"days total = {sum(len(s.days) for s in current)}; "
             f"events total = {sum(len(d.events) for s in current for d in s.days)}; "
             f"secondary currents = {len(secondary_currents)}")
        all_current.extend(current)
        all_secondary_currents.extend(secondary_currents)

    _log(f"==> done: {len(all_stations)} primary tide station(s), "
         f"{len(all_secondary)} secondary port(s), "
         f"{len(all_current)} current station(s), "
         f"{len(all_secondary_currents)} secondary current(s) processed")

    output_path = write_primary_stations_json(all_stations, args.year, args.directory)
    _log(f"    wrote {output_path}")
    secondary_path = write_secondary_ports_json(all_secondary, args.year, args.directory)
    _log(f"    wrote {secondary_path}")
    current_path = write_current_stations_json(all_current, args.year, args.directory)
    _log(f"    wrote {current_path}")
    secondary_current_path = write_secondary_currents_json(all_secondary_currents, args.year, args.directory)
    _log(f"    wrote {secondary_current_path}")

    if args.verbose:
        for s in all_stations:
            pretty_print_tide_station(s)
        pretty_print_secondary_ports(all_secondary)
        for s in all_current:
            pretty_print_current_station(s)
        pretty_print_secondary_currents(all_secondary_currents)

    return 0


if __name__ == "__main__":
    sys.exit(main())
