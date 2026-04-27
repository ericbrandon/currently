import argparse
import os
import re
import sys
from dataclasses import dataclass, field

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


def parse_table1(pdf: pdfplumber.PDF, toc: TOC, page_offset: int) -> list[_ReferencePortInfo]:
    if 1 not in toc.table_pages:
        return []
    pdf_idx = toc.table_pages[1] + page_offset
    text = pdf.pages[pdf_idx].extract_text() or ""
    entries: list[_ReferencePortInfo] = []
    for line in text.split("\n"):
        m = TABLE1_ROW_PATTERN.match(line.strip())
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
        m = TABLE2_ROW_PATTERN.match(line.strip())
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

    _log(f"==> done: {len(all_stations)} primary tide station(s) processed")

    if args.verbose:
        for s in all_stations:
            pretty_print_tide_station(s)

    return 0


if __name__ == "__main__":
    sys.exit(main())
