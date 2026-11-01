#!/usr/bin/env bash
# Refine Canadian station coords and publish the year's data into
# web/public/data/. Consumes the JSON outputs from both pipelines:
#
#   - Canadian primaries:   {year}_iwls_*_primary_stations.json  (canada_data/fetch_iwls.py)
#                           or {year}_tct_*_primary_stations.json with --primaries tct
#   - Canadian secondaries: {year}_tct_*_secondary_stations.json (canada_data/process_canadian.sh;
#                           Table 3/4 offsets, carried forward from the 2027 books after that)
#   - NOAA:                 {year}_noaa_*_stations.json           (us_data/process_us.sh)
#
# All must already exist at the repo root — this script does not
# regenerate them. See notes/iwls_api.md, notes/canada_data_processing.md
# and notes/US_data_processing.md.
#
# Usage: ./process_combined.sh [--year YYYY] [--primaries iwls|tct]

set -euo pipefail

YEAR=2026
PRIMARIES=iwls

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
        --primaries)
            PRIMARIES="$2"
            shift 2
            ;;
        --primaries=*)
            PRIMARIES="${1#*=}"
            shift
            ;;
        -h|--help)
            sed -n '2,20p' "$0"
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

if [[ "$PRIMARIES" != "iwls" && "$PRIMARIES" != "tct" ]]; then
    echo "invalid --primaries value: $PRIMARIES (expected iwls or tct)" >&2
    exit 1
fi

echo "=== process_combined.sh: year=$YEAR primaries=$PRIMARIES ==="

# Refine station lat/lons from the per-feed inventory CSVs and the
# combined coord_overrides.json at the repo root — see
# notes/tables_processing.md. (Today only CHS overrides are applied;
# NOAA stations come from mdapi at high precision and don't need this.)
"$PYTHON" apply_coord_overrides.py --year "$YEAR" --primaries "$PRIMARIES"

# Copy parser outputs into web/public/data/{year}/ with content-hashed
# names, then regenerate the client-side manifest.
"$PYTHON" build_manifest.py --year "$YEAR" --primaries "$PRIMARIES"
