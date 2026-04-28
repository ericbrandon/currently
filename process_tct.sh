#!/usr/bin/env bash
# Process Canadian Tide & Current Tables PDFs into structured data.
# Usage: ./process_tct.sh [-v|--verbose]

set -euo pipefail

YEAR=2026

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
"$PYTHON" read_tct.py --year "$YEAR" "$@"

# Step 2: copy parser outputs into web/public/data/{year}/ with
# content-hashed names, then regenerate the client-side manifest.
"$PYTHON" build_manifest.py --year "$YEAR"
