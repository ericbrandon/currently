"""Convert raw NOAA prediction JSON into the same shape `read_tct.py` produces.

For NOAA we don't carry the CHS primary/secondary file split: NOAA's API computes
full hilo / max-slack predictions for any station (Reference *or* Subordinate),
so every station ends up in the *_primary file with its own `days` array. We
flag NOAA Subordinates with `US_secondary: true` -- this flag is purely a UI
zoom-level hint (show all stations when zoomed in, only US_secondary=false when
zoomed out). It is NOT used for prediction computation.

Outputs (at repo root, parallel to the CHS *_tct_* files):
  <year>_noaa_tidal_primary_stations.json
  <year>_noaa_current_primary_stations.json
"""
import argparse
import json
import re
from datetime import date
from pathlib import Path

# Strip trailing distance qualifiers like ", 0.6 mi. NE of" or ", 0.3 miles
# North of Bridge" from NOAA station names. These are gauge-position notes
# from NOAA's catalog that don't read well in chart titles.
DISTANCE_QUALIFIER = re.compile(r",\s*\d+(?:\.\d+)?\s*(?:mi\.?|miles?)\b.*$", re.IGNORECASE)


def sanitize_station_name(name: str) -> str:
    return DISTANCE_QUALIFIER.sub("", name).rstrip(" ,")

# CHS uses 3-letter weekday for tides, 2-letter for currents (see read_tct.py:229).
TIDE_WKDAY = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
CURRENT_WKDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
TIMEZONE_LABEL = "PST"
UTC_OFFSET = -8


def parse_noaa_time(t: str) -> tuple[int, int, int, str, str]:
    """'2026-01-01 04:21' -> (month, day, weekday_index, 'HH:MM', date_iso)."""
    date_part, time_part = t.split(" ")
    y, m, d = (int(x) for x in date_part.split("-"))
    return m, d, date(y, m, d).weekday(), time_part, date_part


def group_days(events: list[dict], wkday_table: list[str]) -> list[dict]:
    """Group flat events by date; return CHS-shaped days list."""
    by_date: dict[str, dict] = {}
    for ev in events:
        date_key = ev.pop("_date")
        d = by_date.setdefault(date_key, {
            "month": ev.pop("_month"),
            "day": ev.pop("_day"),
            "weekday": wkday_table[ev.pop("_wkday_idx")],
            "_events_or_readings": [],
        })
        # If we've already initialized the day, drop the leading metadata fields
        for k in ("_month", "_day", "_wkday_idx"):
            ev.pop(k, None)
        d["_events_or_readings"].append(ev)
    out = []
    for k in sorted(by_date.keys()):
        d = by_date[k]
        out.append({
            "month": d["month"], "day": d["day"], "weekday": d["weekday"],
            "_events_or_readings": d["_events_or_readings"],
        })
    return out


def convert_tide_station(raw: dict, pick: dict, year: int,
                         lat: float | None, lng: float | None) -> dict:
    """raw is the NOAA datagetter response; pick is the entry from stations_tides.json."""
    flat = []
    for p in raw.get("predictions", []):
        m, d, w, hhmm, date_iso = parse_noaa_time(p["t"])
        flat.append({
            "_date": date_iso, "_month": m, "_day": d, "_wkday_idx": w,
            "time": hhmm, "metres": float(p["v"]),
        })
    grouped = group_days(flat, TIDE_WKDAY)
    days = [{"month": d["month"], "day": d["day"], "weekday": d["weekday"],
             "readings": d["_events_or_readings"]} for d in grouped]
    return {
        "name": pick.get("NOAA_short_name") or sanitize_station_name(pick["name"]),
        "NOAA_station_name": sanitize_station_name(pick["name"]),
        "NOAA_short_name": pick.get("NOAA_short_name"),
        "timezone": TIMEZONE_LABEL,
        "utc_offset": UTC_OFFSET,
        "year": year,
        "noaa_id": pick["id"],
        "latitude": lat,
        "longitude": lng,
        "US_secondary": pick.get("type") == "S",
        "days": days,
    }


def convert_current_station(raw: dict, pick: dict, year: int, lat: float | None, lng: float | None) -> dict:
    cp = raw.get("current_predictions", {}).get("cp", [])
    flood_dir = ebb_dir = None
    max_flood = max_ebb = 0.0
    flat = []
    for ev in cp:
        m, d, w, hhmm, date_iso = parse_noaa_time(ev["Time"])
        velocity = float(ev["Velocity_Major"])
        kind_raw = ev["Type"]
        if kind_raw == "slack":
            kind = "slack"
            knots = 0.0
        else:
            kind = "max"
            knots = velocity
            if velocity > max_flood:
                max_flood = velocity
            if velocity < -max_ebb:
                max_ebb = -velocity
        if flood_dir is None:
            flood_dir = ev.get("meanFloodDir")
            ebb_dir = ev.get("meanEbbDir")
        flat.append({
            "_date": date_iso, "_month": m, "_day": d, "_wkday_idx": w,
            "time": hhmm, "kind": kind, "knots": knots, "weak_variable": False,
        })
    grouped = group_days(flat, CURRENT_WKDAY)
    days = [{"month": d["month"], "day": d["day"], "weekday": d["weekday"],
             "events": d["_events_or_readings"]} for d in grouped]
    return {
        "name": pick.get("NOAA_short_name") or sanitize_station_name(pick["primary_name"]),
        "NOAA_station_name": sanitize_station_name(pick["primary_name"]),
        "NOAA_short_name": pick.get("NOAA_short_name"),
        "timezone": TIMEZONE_LABEL,
        "utc_offset": UTC_OFFSET,
        "year": year,
        "flood_direction_true": flood_dir,
        "ebb_direction_true": ebb_dir,
        "noaa_id": pick["primary"],
        "noaa_bin": pick.get("shallowest_bin"),
        "latitude": lat,
        "longitude": lng,
        "max_flood_knots": max_flood if max_flood else None,
        "max_ebb_knots": max_ebb if max_ebb else None,
        "US_secondary": pick.get("type") == "S",
        "days": days,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--data-dir", default="us_data")
    ap.add_argument("--out-dir", default=".", help="Where to write *_noaa_*_stations.json")
    args = ap.parse_args()

    d = Path(args.data_dir)
    raw_dir = d / "raw" / str(args.year)

    tide_picks = json.loads((d / "stations_tides.json").read_text())["stations"]
    current_picks = json.loads((d / "stations_currents.json").read_text())["stations"]

    # Look up coords from the catalog (we don't carry them on picks).
    tide_catalog = {s["id"]: s for s in json.loads((d / f"{args.year}_noaa_tidepredictions_wa.json").read_text())["stations"]}
    current_catalog: dict[str, list[dict]] = {}
    for s in json.loads((d / f"{args.year}_noaa_currentpredictions_wa.json").read_text())["stations"]:
        current_catalog.setdefault(s["id"], []).append(s)

    # Tides: dedupe by NOAA station ID (multiple placenames can map to one ID).
    seen_tide = set()
    tide_out = []
    for pick in tide_picks:
        sid = pick["id"]
        if sid in seen_tide:
            continue
        seen_tide.add(sid)
        raw_path = raw_dir / f"tide_{sid}.json"
        if not raw_path.exists():
            print(f"  WARN: missing raw tide file for {sid} ({pick['placename']})")
            continue
        raw = json.loads(raw_path.read_text())
        # Override pick-name with catalog name if available (more authoritative).
        canonical_pick = dict(pick)
        cat = tide_catalog.get(sid)
        if cat:
            canonical_pick["name"] = cat["name"]
        lat = cat.get("lat") if cat else None
        lng = cat.get("lng") if cat else None
        tide_out.append(convert_tide_station(raw, canonical_pick, args.year, lat, lng))

    # Currents: dedupe by (id, bin).
    seen_current = set()
    current_out = []
    for pick in current_picks:
        sid = pick.get("primary")
        if not sid:
            continue
        bin_no = pick.get("shallowest_bin")
        key = (sid, bin_no)
        if key in seen_current:
            continue
        seen_current.add(key)
        raw_path = raw_dir / f"current_{sid}_bin{bin_no}.json"
        if not raw_path.exists():
            print(f"  WARN: missing raw current file for {sid} bin{bin_no} ({pick['placename']})")
            continue
        raw = json.loads(raw_path.read_text())
        rows = current_catalog.get(sid, [])
        lat = rows[0]["lat"] if rows else None
        lng = rows[0]["lng"] if rows else None
        # Override pick-name with catalog name if available (more authoritative).
        canonical_pick = dict(pick)
        if rows:
            canonical_pick["primary_name"] = rows[0]["name"]
        current_out.append(convert_current_station(raw, canonical_pick, args.year, lat, lng))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tide_path = out_dir / f"{args.year}_noaa_tidal_primary_stations.json"
    current_path = out_dir / f"{args.year}_noaa_current_primary_stations.json"
    tide_path.write_text(json.dumps({"year": args.year, "stations": tide_out}, indent=2))
    current_path.write_text(json.dumps({"year": args.year, "stations": current_out}, indent=2))

    print(f"\nWrote:")
    print(f"  {tide_path}    ({len(tide_out)} stations)")
    print(f"  {current_path} ({len(current_out)} stations)")
    print(f"\nUS_secondary breakdown:")
    print(f"  tides    primary={sum(1 for s in tide_out if not s['US_secondary'])}  secondary={sum(1 for s in tide_out if s['US_secondary'])}")
    print(f"  currents primary={sum(1 for s in current_out if not s['US_secondary'])}  secondary={sum(1 for s in current_out if s['US_secondary'])}")


if __name__ == "__main__":
    main()
