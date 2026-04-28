#!/usr/bin/env bash
# Process Canadian Tide & Current Tables PDFs into structured data.
# Usage: ./process_tct.sh [--year YYYY] [-v|--verbose]
#
# --year defaults to 2026. Pass --year 2027 (etc.) when processing a
# newer PDF set. See notes/tables_processing.md.

set -euo pipefail

YEAR=2026
extra_args=()

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
        -v|--verbose)
            extra_args+=("$1")
            shift
            ;;
        -h|--help)
            sed -n '2,5p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            echo "usage: ./process_tct.sh [--year YYYY] [-v|--verbose]" >&2
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

echo "=== process_tct.sh: year=$YEAR ==="

# Step 1: parse PDFs into structured station data
"$PYTHON" read_tct.py --year "$YEAR" "${extra_args[@]+"${extra_args[@]}"}"

# Step 2: refine station lat/lons from the CHS open-data inventory CSV
# and any manual coord_overrides.json — see notes/tables_processing.md.
"$PYTHON" apply_coord_overrides.py --year "$YEAR"

# Step 3: copy parser outputs into web/public/data/{year}/ with
# content-hashed names, then regenerate the client-side manifest.
"$PYTHON" build_manifest.py --year "$YEAR"
