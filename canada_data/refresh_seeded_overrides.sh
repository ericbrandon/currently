#!/usr/bin/env bash
# Annual one-shot: re-parse the year's CHS PDFs and re-run the IWLS
# seeder against the raw PDF coords, so coord_overrides.json reflects
# the current upstream IWLS catalog.
#
# NOT for routine use. After editing coord_overrides.json by hand
# (manual override, suppression, etc.), just run ./process_combined.sh —
# the PDF didn't change, the seeder doesn't need to re-run.
#
# Usage: ./canada_data/refresh_seeded_overrides.sh [--year YYYY]
#
# What this does (in order):
#   1. canada_data/process_canadian.sh --year YEAR
#        — parses the PDFs into raw integer-arcminute coords; emits
#          {year}_tct_*_stations.json at the repo root. The seeder
#          reads these as its PDF baseline, so this step must run
#          first. (apply_coord_overrides.py would otherwise have
#          rewritten the JSONs with post-override coords, which would
#          confuse the seeder's offset calculations.)
#   2. canada_data/seed_iwls_overrides.py --year YEAR
#        — one HTTP call to the IWLS catalog. Add/refresh/remove
#          entries in _block_iwls_seeded so it exactly mirrors current
#          IWLS data for every parser station IWLS covers.
#
# Stops before publishing. Inspect the seeder's output for surprises
# (refreshed entries, removals), then run ./process_combined.sh --year
# YEAR to apply the new overrides to the parser JSONs and republish
# into web/public/data/.

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
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            echo "usage: ./canada_data/refresh_seeded_overrides.sh [--year YYYY]" >&2
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

echo "=== refresh_seeded_overrides.sh: year=$YEAR ==="

echo
echo "[1/2] re-parsing CHS PDFs to restore raw integer-arcminute coords ..."
"$REPO_ROOT/canada_data/process_canadian.sh" --year "$YEAR"

echo
echo "[2/2] syncing IWLS overrides ..."
"$PYTHON" "$REPO_ROOT/canada_data/seed_iwls_overrides.py" --year "$YEAR"

echo
echo "=== done ==="
echo "Now run ./process_combined.sh --year $YEAR to apply the refreshed"
echo "overrides to the parser JSONs and republish into web/public/data/."
