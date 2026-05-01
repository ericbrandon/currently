"""Search NOAA WA-region current prediction stations for each placename."""
import json
from collections import defaultdict

with open("us_data/2026_noaa_currentpredictions_wa.json") as f:
    rows = json.load(f)["stations"]

by_id = defaultdict(list)
for r in rows:
    by_id[r["id"]].append(r)

# Each placename gets a list of keyword groups; ALL groups must match (any keyword in a group OK).
QUERIES = [
    ("Deception Pass", [["deception"]]),
    ("Swinomish Channel / La Conner", [["swinomish", "la conner"]]),
    ("Guemes Channel / Anacortes / Padilla / Rosario", [["guemes", "anacortes", "padilla", "rosario"]]),
    ("Admiralty Inlet", [["admiralty", "point wilson", "bush point", "marrowstone"]]),
    ("Port Townsend Canal", [["port townsend canal", "indian island", "marrowstone"]]),
    ("Possession Sound / Saratoga Passage", [["possession", "saratoga"]]),
    ("Agate Passage", [["agate"]]),
    ("Rich Passage", [["rich passage"]]),
    ("Colvos Passage", [["colvos"]]),
    ("Tacoma Narrows", [["narrows"]]),
    ("Hale Passage (Fox Island)", [["hale passage", "fox island"]]),
    ("Pitt Passage", [["pitt", "wyckoff"]]),
    ("Balch Passage", [["balch"]]),
    ("Drayton Passage", [["drayton"]]),
    ("Dana Passage", [["dana passage"]]),
    ("Pickering Passage", [["pickering"]]),
    ("Peale Passage", [["peale"]]),
    ("Squaxin Passage", [["squaxin"]]),
    ("Hammersley Inlet / Libby Point", [["hammersley", "libby point"]]),
    ("Cattle Pass / San Juan Channel S", [["cattle", "san juan channel"]]),
    ("Spieden Channel", [["spieden"]]),
]

for label, groups in QUERIES:
    print(f"\n=== {label} ===")
    matched_ids = []
    for sid, recs in by_id.items():
        name = recs[0]["name"].lower()
        if all(any(k in name for k in g) for g in groups):
            matched_ids.append(sid)
    if not matched_ids:
        print("  (no matches)")
    for sid in sorted(matched_ids):
        recs = by_id[sid]
        bins = sorted(set(r.get("currbin") for r in recs))
        depths = sorted(set(r.get("depth") for r in recs))
        print(f"  {sid:10s}  {recs[0]['name']}  ({recs[0]['lat']:.4f},{recs[0]['lng']:.4f}) type={recs[0].get('type')} bins={bins} depths={depths}")
