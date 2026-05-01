#!/bin/bash
# Annual NOAA US tides & currents pipeline.
#
# 1. Refresh the NOAA station-metadata catalogs.
# 2. Check our committed station picks for anomalies (name change, disappearance,
#    missing bins). HALTS if anomalies are found, unless --force is given.
# 3. Download the year's hilo tide + max_slack current predictions (cached).
# 4. Convert NOAA JSON into the same CHS-shaped JSONs that read_tct.py produces.
#
# Usage:
#   ./us_data/process_us.sh --year 2026
#   ./us_data/process_us.sh --year 2026 --force        # proceed past anomalies
#   ./us_data/process_us.sh --year 2026 --refresh      # re-download even if cached

set -euo pipefail

YEAR=""
FORCE=0
REFRESH=0

while [ $# -gt 0 ]; do
    case "$1" in
        --year) YEAR="$2"; shift 2 ;;
        --force) FORCE=1; shift ;;
        --refresh) REFRESH=1; shift ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

if [ -z "$YEAR" ]; then
    echo "usage: $0 --year YEAR [--force] [--refresh]" >&2
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d venv ]; then
    echo "ERROR: venv not found at $REPO_ROOT/venv. Create it first." >&2
    exit 1
fi
PY="$REPO_ROOT/venv/bin/python"

echo "============================================================"
echo "NOAA US pipeline  year=$YEAR  force=$FORCE  refresh=$REFRESH"
echo "============================================================"

echo
echo "[1/4] Refreshing NOAA station metadata catalogs..."
"$PY" us_data/refresh_station_metadata.py --year "$YEAR"

echo
echo "[2/4] Checking station picks for anomalies..."
set +e
"$PY" us_data/check_stations.py --year "$YEAR"
ANOMALY_RC=$?
set -e
if [ $ANOMALY_RC -ne 0 ]; then
    if [ $FORCE -eq 1 ]; then
        echo "  --force given; proceeding past anomalies."
    else
        echo
        echo "Anomalies detected. Review the report in us_data/anomalies_*.md," >&2
        echo "update us_data/stations_{tides,currents}.json as needed, and re-run." >&2
        echo "Pass --force to proceed past anomalies." >&2
        exit $ANOMALY_RC
    fi
fi

echo
echo "[3/4] Fetching predictions for $YEAR..."
FETCH_ARGS=(--year "$YEAR")
if [ $REFRESH -eq 1 ]; then
    FETCH_ARGS+=(--refresh)
fi
"$PY" us_data/fetch_predictions.py "${FETCH_ARGS[@]}"

echo
echo "[4/4] Converting NOAA JSON to CHS-shaped JSON..."
"$PY" us_data/convert_to_tct.py --year "$YEAR"

echo
echo "============================================================"
echo "Done. Outputs:"
echo "  ${YEAR}_noaa_tidal_primary_stations.json"
echo "  ${YEAR}_noaa_current_primary_stations.json"
echo "============================================================"
