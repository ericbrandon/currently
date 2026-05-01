#!/usr/bin/env bash
# Parse the Canadian Tide & Current Tables PDFs into structured station JSON.
# Usage: ./canada_data/process_canadian.sh [--year YYYY] [-v|--verbose]
#
# --year defaults to 2026. Pass --year 2027 (etc.) when processing a
# newer PDF set. See notes/tables_processing.md.
#
# Reads PDFs from canada_data/. Emits {year}_tct_*_stations.json at the
# repo root. Run ./process_combined.sh afterwards to refine coords and
# publish into web/public/data/.

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
            sed -n '2,10p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            echo "usage: ./canada_data/process_canadian.sh [--year YYYY] [-v|--verbose]" >&2
            exit 1
            ;;
    esac
done

if [[ ! "$YEAR" =~ ^[0-9]{4}$ ]]; then
    echo "invalid --year value: $YEAR (expected 4 digits)" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON="$REPO_ROOT/venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
    echo "venv/ not found; creating it and installing dependencies..." >&2
    python3 -m venv venv
    venv/bin/pip install --quiet --upgrade pip
    venv/bin/pip install --quiet -r requirements.txt
    echo "venv/ ready." >&2
fi

echo "=== process_canadian.sh: year=$YEAR ==="

# Parse PDFs into structured station data.
# read_tct.py defaults --directory to canada_data/ (script-relative) and
# --out-dir to '.' (= repo root, since we cd'd there above).
"$PYTHON" canada_data/read_tct.py --year "$YEAR" "${extra_args[@]+"${extra_args[@]}"}"
