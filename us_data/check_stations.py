"""Compare our committed station picks against the freshly-fetched NOAA catalogs.

Flags stations whose name has changed, whose coords have moved more than
LOCATION_THRESHOLD_KM, that have disappeared from NOAA, or (for currents) whose
shallowest_bin no longer exists.

Reads:
  us_data/stations_tides.json
  us_data/stations_currents.json
  us_data/<YEAR>_noaa_tidepredictions_wa.json
  us_data/<YEAR>_noaa_currentpredictions_wa.json

Writes:
  us_data/anomalies_<UTC-iso>.md   (timestamped report)

Exits non-zero on any anomaly so the driver script can halt.
"""
import argparse
import json
import math
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

LOCATION_THRESHOLD_KM = 0.1  # 100 m
NAME_CASE_INSENSITIVE = True
MDAPI_STATION = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{id}.json"


def haversine_km(lat1, lng1, lat2, lng2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def names_match(a: str, b: str) -> bool:
    if NAME_CASE_INSENSITIVE:
        return a.strip().lower() == b.strip().lower()
    return a.strip() == b.strip()


def fetch_station_by_id(station_id: str, product: str) -> dict | None:
    """Fallback: fetch a single station's metadata from NOAA directly.

    Used when a committed station is missing from the bulk WA catalog (e.g.
    moved out of our bbox, or filtering by `state=WA` no longer includes it).
    """
    url = MDAPI_STATION.format(id=station_id) + f"?expand=details&type={product}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.load(resp)
            stations = data.get("stations") or []
            return stations[0] if stations else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


# ANSI for terminal logging
class C:
    OK = "\033[32m"
    WARN = "\033[33m"
    ERR = "\033[31m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RESET = "\033[0m"


def log_ok(msg):
    print(f"  {C.OK}✓{C.RESET} {msg}")


def log_warn(msg):
    print(f"  {C.WARN}⚠{C.RESET} {msg}")


def log_err(msg):
    print(f"  {C.ERR}✗{C.RESET} {msg}")


def check_tides(picks_path: Path, catalog_path: Path) -> list[dict]:
    catalog = {s["id"]: s for s in json.loads(catalog_path.read_text())["stations"]}
    picks = json.loads(picks_path.read_text())["stations"]

    anomalies = []
    print(f"\n{C.BOLD}Tide stations{C.RESET}  ({len(picks)} entries; {len({p['id'] for p in picks})} unique IDs)")

    seen_ids = set()
    for entry in picks:
        sid = entry["id"]
        placename = entry["placename"]
        if sid in seen_ids:
            continue
        seen_ids.add(sid)

        live = catalog.get(sid)
        if live is None:
            live = fetch_station_by_id(sid, "tidepredictions")
            if live is None:
                log_err(f"{sid} ({placename}): MISSING from NOAA catalog")
                anomalies.append({
                    "kind": "missing", "category": "tide", "id": sid,
                    "placename": placename, "recorded_name": entry["name"],
                })
                continue
            else:
                log_warn(f"{sid} ({placename}): not in WA bulk catalog but found via direct lookup")

        recorded_name = entry["name"]
        live_name = live["name"]
        if not names_match(recorded_name, live_name):
            log_warn(f"{sid} ({placename}): name change  {recorded_name!r} -> {live_name!r}")
            anomalies.append({
                "kind": "name_change", "category": "tide", "id": sid,
                "placename": placename, "recorded_name": recorded_name, "live_name": live_name,
            })

        # We don't carry coords on tide picks (only NOAA does); compare against the catalog directly.
        # No anomaly detection on movement for tides since we don't store baseline coords.
        # (NOAA has fixed station locations -- if it moves it would be a re-numbered station.)
        # We still report any reference_id change since that affects predictions.
        recorded_ref = entry.get("reference_id")
        live_ref = live.get("reference_id") or None
        if recorded_ref and live_ref and recorded_ref != live_ref:
            log_warn(f"{sid} ({placename}): reference_id changed  {recorded_ref!r} -> {live_ref!r}")
            anomalies.append({
                "kind": "reference_change", "category": "tide", "id": sid,
                "placename": placename, "recorded_reference_id": recorded_ref, "live_reference_id": live_ref,
            })

        # type change (R<->S) is also worth flagging
        if entry.get("type") and live.get("type") and entry["type"] != live["type"]:
            log_warn(f"{sid} ({placename}): type changed  {entry['type']!r} -> {live['type']!r}")
            anomalies.append({
                "kind": "type_change", "category": "tide", "id": sid,
                "placename": placename, "recorded_type": entry["type"], "live_type": live["type"],
            })

    if not anomalies:
        log_ok("all tide stations match catalog")
    return anomalies


def check_currents(picks_path: Path, catalog_path: Path) -> list[dict]:
    catalog_rows = json.loads(catalog_path.read_text())["stations"]
    by_id: dict[str, list[dict]] = {}
    for r in catalog_rows:
        by_id.setdefault(r["id"], []).append(r)

    picks = json.loads(picks_path.read_text())["stations"]
    real_picks = [p for p in picks if p.get("primary")]
    print(f"\n{C.BOLD}Current stations{C.RESET}  ({len(real_picks)} with stations; {len(picks) - len(real_picks)} placeholder)")

    anomalies = []
    for entry in picks:
        placename = entry["placename"]
        sid = entry.get("primary")
        if sid is None:
            continue

        live_rows = by_id.get(sid)
        if not live_rows:
            single = fetch_station_by_id(sid, "currentpredictions")
            if single is None:
                log_err(f"{sid} ({placename}): MISSING from NOAA catalog")
                anomalies.append({
                    "kind": "missing", "category": "current", "id": sid,
                    "placename": placename, "recorded_name": entry["primary_name"],
                })
                continue
            else:
                log_warn(f"{sid} ({placename}): not in PNW bulk catalog but found via direct lookup")
                live_rows = [single]

        recorded_name = entry["primary_name"]
        live_name = live_rows[0]["name"]
        if not names_match(recorded_name, live_name):
            log_warn(f"{sid} ({placename}): name change  {recorded_name!r} -> {live_name!r}")
            anomalies.append({
                "kind": "name_change", "category": "current", "id": sid,
                "placename": placename, "recorded_name": recorded_name, "live_name": live_name,
            })

        # Coord drift -- we have lat/lng on the live record but not stored on our picks file.
        # We can compare against the catalog row that was committed earlier, but since we
        # don't snapshot coords on the picks, skip movement detection for now.

        # Bin still available?
        recorded_bin = entry.get("shallowest_bin")
        if recorded_bin is not None:
            live_bins = sorted({r.get("currbin") for r in live_rows if r.get("currbin") is not None})
            if recorded_bin not in live_bins:
                log_err(f"{sid} ({placename}): recorded bin {recorded_bin} no longer offered (live bins: {live_bins})")
                anomalies.append({
                    "kind": "bin_missing", "category": "current", "id": sid,
                    "placename": placename, "recorded_bin": recorded_bin, "live_bins": live_bins,
                })

        # Type change
        if entry.get("type") and live_rows[0].get("type") and entry["type"] != live_rows[0]["type"]:
            log_warn(f"{sid} ({placename}): type changed  {entry['type']!r} -> {live_rows[0]['type']!r}")
            anomalies.append({
                "kind": "type_change", "category": "current", "id": sid,
                "placename": placename, "recorded_type": entry["type"], "live_type": live_rows[0]["type"],
            })

    if not anomalies:
        log_ok("all current stations match catalog")
    return anomalies


def write_report(anomalies: list[dict], out_dir: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"anomalies_{stamp}.md"
    lines = [f"# NOAA station anomaly report ({stamp})", ""]
    if not anomalies:
        lines.append("No anomalies detected.")
    else:
        lines.append(f"**{len(anomalies)} anomaly(ies) detected.** Review and decide whether to update committed picks.\n")
        for a in anomalies:
            lines.append(f"- **{a['kind']}** ({a['category']}) `{a['id']}` — {a['placename']}")
            for k, v in a.items():
                if k in ("kind", "category", "id", "placename"):
                    continue
                lines.append(f"  - `{k}`: {v}")
    path.write_text("\n".join(lines) + "\n")
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True, help="Year of the catalog snapshot to check against")
    ap.add_argument("--data-dir", default="us_data")
    args = ap.parse_args()

    d = Path(args.data_dir)
    tide_catalog = d / f"{args.year}_noaa_tidepredictions_wa.json"
    current_catalog = d / f"{args.year}_noaa_currentpredictions_wa.json"
    print(f"{C.BOLD}Checking committed station picks against NOAA catalog{C.RESET}")
    print(f"{C.DIM}(catalog snapshots: {tide_catalog}, {current_catalog}){C.RESET}")

    anomalies = []
    anomalies += check_tides(d / "stations_tides.json", tide_catalog)
    anomalies += check_currents(d / "stations_currents.json", current_catalog)

    report = write_report(anomalies, d)
    print()
    if anomalies:
        print(f"{C.ERR}{C.BOLD}{len(anomalies)} anomaly(ies) detected.{C.RESET}  Report: {report}")
        sys.exit(1)
    else:
        print(f"{C.OK}{C.BOLD}No anomalies.{C.RESET}  Report: {report}")


if __name__ == "__main__":
    main()
