"""Download a calendar year of NOAA predictions for every station in our picks.

Tides: product=predictions, interval=hilo, units=metric (matches CHS m).
Currents: product=currents_predictions, interval=MAX_SLACK, units=english (knots).

All requests are made with time_zone=lst -- Local Standard Time, no DST. For
WA stations this is UTC-8 year-round. We label outputs as utc_offset=-8 to
match the 2026 CHS chartbook's offset; the app converts to user-local at
display time.

Caches raw NOAA JSON to:
  us_data/raw/<YEAR>/tide_<station_id>.json
  us_data/raw/<YEAR>/current_<station_id>_bin<N>.json

Skips files already present unless --refresh. Note: the cache key does NOT
include the time_zone parameter, so changing time_zone requires --refresh
(or wiping the cache).
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
RETRY_CODES = {429, 500, 502, 503, 504}
THROTTLE_SECONDS = 0.2  # gentle pacing between calls


class C:
    OK = "\033[32m"
    WARN = "\033[33m"
    ERR = "\033[31m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RESET = "\033[0m"


def get_with_retries(url: str, max_attempts: int = 4) -> bytes:
    delay = 1.0
    for attempt in range(1, max_attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code in RETRY_CODES and attempt < max_attempts:
                print(f"  {C.WARN}retry{C.RESET} HTTP {e.code} (attempt {attempt}/{max_attempts}); sleeping {delay:.1f}s", file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            raise
        except urllib.error.URLError as e:
            if attempt < max_attempts:
                print(f"  {C.WARN}retry{C.RESET} URLError: {e}; sleeping {delay:.1f}s", file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            raise


def fetch_one(out_path: Path, params: dict, refresh: bool) -> str:
    """Returns 'fetched', 'cached', or raises."""
    if out_path.exists() and not refresh:
        return "cached"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{DATAGETTER}?{qs}"
    blob = get_with_retries(url)
    # Validate it's JSON and not an error payload before writing.
    parsed = json.loads(blob)
    if "error" in parsed:
        raise RuntimeError(f"NOAA error for {out_path.name}: {parsed['error']}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(blob)
    time.sleep(THROTTLE_SECONDS)
    return "fetched"


def fetch_tides(year: int, picks: list[dict], raw_dir: Path, refresh: bool) -> tuple[int, int, int]:
    """Returns (fetched, cached, errors)."""
    print(f"\n{C.BOLD}Fetching tide predictions{C.RESET}  year={year}")
    seen = set()
    fetched = cached = errors = 0
    for entry in picks:
        sid = entry["id"]
        if sid in seen:
            continue
        seen.add(sid)
        out = raw_dir / f"tide_{sid}.json"
        params = {
            "product": "predictions",
            "datum": "MLLW",
            "station": sid,
            "begin_date": f"{year}0101",
            "end_date": f"{year}1231",
            "interval": "hilo",
            "format": "json",
            "time_zone": "lst",
            "units": "metric",
            "application": "currentlybc",
        }
        try:
            status = fetch_one(out, params, refresh)
            if status == "cached":
                print(f"  {C.DIM}cached{C.RESET}  {sid}  ({entry['name']})")
                cached += 1
            else:
                print(f"  {C.OK}got{C.RESET}     {sid}  ({entry['name']})")
                fetched += 1
        except Exception as e:
            print(f"  {C.ERR}fail{C.RESET}    {sid}  ({entry['name']}): {e}")
            errors += 1
    return fetched, cached, errors


def fetch_currents(year: int, picks: list[dict], raw_dir: Path, refresh: bool) -> tuple[int, int, int]:
    print(f"\n{C.BOLD}Fetching current predictions{C.RESET}  year={year}")
    seen = set()
    fetched = cached = errors = 0
    for entry in picks:
        sid = entry.get("primary")
        if not sid:
            continue
        bin_no = entry.get("shallowest_bin")
        key = (sid, bin_no)
        if key in seen:
            continue
        seen.add(key)
        out = raw_dir / f"current_{sid}_bin{bin_no}.json"
        params = {
            "product": "currents_predictions",
            "station": sid,
            "bin": bin_no,
            "begin_date": f"{year}0101",
            "end_date": f"{year}1231",
            "interval": "MAX_SLACK",
            "format": "json",
            "time_zone": "lst",
            "units": "english",
            "application": "currentlybc",
        }
        try:
            status = fetch_one(out, params, refresh)
            label = f"{sid} bin {bin_no}  ({entry['primary_name']})"
            if status == "cached":
                print(f"  {C.DIM}cached{C.RESET}  {label}")
                cached += 1
            else:
                print(f"  {C.OK}got{C.RESET}     {label}")
                fetched += 1
        except Exception as e:
            print(f"  {C.ERR}fail{C.RESET}    {sid} bin {bin_no}  ({entry['primary_name']}): {e}")
            errors += 1
    return fetched, cached, errors


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--data-dir", default="us_data")
    ap.add_argument("--refresh", action="store_true", help="Re-fetch even if cached")
    args = ap.parse_args()

    d = Path(args.data_dir)
    raw_dir = d / "raw" / str(args.year)

    tide_picks = json.loads((d / "stations_tides.json").read_text())["stations"]
    current_picks = json.loads((d / "stations_currents.json").read_text())["stations"]

    tf, tc, te = fetch_tides(args.year, tide_picks, raw_dir, args.refresh)
    cf, cc, ce = fetch_currents(args.year, current_picks, raw_dir, args.refresh)

    print()
    print(f"{C.BOLD}Summary{C.RESET}")
    print(f"  tides:    fetched={tf}  cached={tc}  errors={te}")
    print(f"  currents: fetched={cf}  cached={cc}  errors={ce}")
    print(f"  raw cache: {raw_dir}")
    if te or ce:
        sys.exit(1)


if __name__ == "__main__":
    main()
