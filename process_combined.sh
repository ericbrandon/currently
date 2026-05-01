#!/usr/bin/env bash
# Refine Canadian station coords and publish the year's data into
# web/public/data/. Consumes the JSON outputs from both pipelines:
#
#   - Canadian: {year}_tct_*_stations.json    (from canada_data/process_canadian.sh)
#   - NOAA:     {year}_noaa_*_stations.json   (from us_data/process_us.sh)
#
# Both must already exist at the repo root — this script does not
# regenerate them. See notes/tables_processing.md and
# notes/us_data_processing.md.
#
# Usage: ./process_combined.sh [--year YYYY]

set -euo pipefail

YEAR=2026

while [[ $# -gt 0 ]]; do
    case "$1" in
        --year|-y)
            YEAR="$2"
            shift 2
            ;;
        --year=*)
            YEAR="${1#*=}"
            shift
            ;;
        -h|--help)
            sed -n '2,17p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            echo "usage: ./process_combined.sh [--year YYYY]" >&2
            exit 1
            ;;
    esac
done

if [[ ! "$YEAR" =~ ^[0-9]{4}$ ]]; then
    echo "invalid --year value: $YEAR (expected 4 digits)" >&2
    exit 1
fi

cd "$(dirname "$0")"

PYTHON="venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
    echo "venv/ not found; creating it and installing dependencies..." >&2
    python3 -m venv venv
    venv/bin/pip install --quiet --upgrade pip
    venv/bin/pip install --quiet -r requirements.txt
    echo "venv/ ready." >&2
fi

echo "=== process_combined.sh: year=$YEAR ==="

# Refine station lat/lons from the per-feed inventory CSVs and the
# combined coord_overrides.json at the repo root — see
# notes/tables_processing.md. (Today only CHS overrides are applied;
# NOAA stations come from mdapi at high precision and don't need this.)
"$PYTHON" apply_coord_overrides.py --year "$YEAR"

# Copy parser outputs into web/public/data/{year}/ with content-hashed
# names, then regenerate the client-side manifest.
"$PYTHON" build_manifest.py --year "$YEAR"
