"""Re-fetch the NOAA CO-OPS metadata catalogs for WA tide and PNW current stations.

Writes:
  us_data/<YEAR>_noaa_tidepredictions_wa.json     (filtered: state == "WA")
  us_data/<YEAR>_noaa_currentpredictions_wa.json  (filtered: lat/lng box for WA waters)

The year prefix preserves catalog snapshots across annual runs so we can diff
NOAA's catalog year-over-year. Run yearly via process_us.sh.
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json"

# Box covering Columbia River mouth, outer WA coast, Strait of Juan de Fuca,
# Puget Sound, San Juans, Hood Canal, North Sound to the BC border.
WA_BOX = {"lat_min": 45.5, "lat_max": 49.0, "lng_min": -125.0, "lng_max": -121.5}


def fetch(product_type: str) -> list[dict]:
    url = f"{MDAPI}?type={product_type}&units=english"
    print(f"  GET {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)["stations"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True, help="Calendar year for the snapshot file prefix")
    ap.add_argument("--out-dir", default="us_data", help="Directory for output files")
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    print("Fetching tide prediction catalog...", file=sys.stderr)
    tides = fetch("tidepredictions")
    wa_tides = [s for s in tides if s.get("state") == "WA"]
    (out / f"{args.year}_noaa_tidepredictions_wa.json").write_text(
        json.dumps({"count": len(wa_tides), "stations": wa_tides}, indent=2)
    )
    print(f"  WA tide stations: {len(wa_tides)} of {len(tides)} total")

    print("Fetching current prediction catalog...", file=sys.stderr)
    currents = fetch("currentpredictions")
    in_box = [
        s for s in currents
        if WA_BOX["lat_min"] <= s["lat"] <= WA_BOX["lat_max"]
        and WA_BOX["lng_min"] <= s["lng"] <= WA_BOX["lng_max"]
    ]
    (out / f"{args.year}_noaa_currentpredictions_wa.json").write_text(
        json.dumps({"count": len(in_box), "stations": in_box}, indent=2)
    )
    unique = {s["id"] for s in in_box}
    print(f"  PNW-box current stations: {len(in_box)} rows, {len(unique)} unique IDs (of {len(currents)} total)")


if __name__ == "__main__":
    main()
