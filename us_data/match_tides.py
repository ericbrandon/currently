"""Search NOAA WA tide prediction stations for each tide placename."""
import json
from collections import defaultdict

with open("us_data/2026_noaa_tidepredictions_wa.json") as f:
    rows = json.load(f)["stations"]

by_id = {s["id"]: s for s in rows}

QUERIES = [
    ("Seattle / Elliott Bay", [["seattle", "elliott"]]),
    ("Shilshole Bay / Ballard", [["shilshole", "ballard"]]),
    ("Ballard Locks / Lake Wash Ship Canal", [["lock", "ship canal"]]),
    ("Edmonds", [["edmonds"]]),
    ("Everett / Port Gardner", [["everett", "port gardner"]]),
    ("Mukilteo / Possession", [["mukilteo", "possession"]]),
    ("Kingston / Apple Tree Cove", [["kingston", "apple tree"]]),
    ("Port Madison", [["port madison"]]),
    ("Eagle Harbor / Bainbridge", [["eagle harbor", "bainbridge"]]),
    ("Poulsbo / Liberty Bay", [["poulsbo", "liberty bay"]]),
    ("Bremerton / Sinclair Inlet", [["bremerton", "sinclair"]]),
    ("Port Orchard", [["port orchard"]]),
    ("Blake Island", [["blake island"]]),
    ("Gig Harbor", [["gig harbor"]]),
    ("Tacoma / Commencement Bay", [["tacoma", "commencement"]]),
    ("Tacoma Narrows / Narrows Marina", [["narrows"]]),
    ("Quartermaster Harbor / Vashon-Maury", [["quartermaster", "vashon", "maury"]]),
    ("Des Moines / Redondo", [["des moines", "redondo"]]),
    ("Olympia / Budd Inlet", [["olympia", "budd"]]),
    ("Shelton / Oakland Bay / Hammersley", [["shelton", "oakland bay", "hammersley"]]),
    ("Jarrell Cove", [["jarrell"]]),
    ("Penrose Point / Lakebay", [["penrose", "lakebay"]]),
    ("McMicken Island / Harstine", [["mcmicken", "harstine", "hartstene"]]),
    ("Hope Island / Squaxin Island", [["hope island", "squaxin"]]),
    ("Hood Canal — Seabeck / Dabob", [["seabeck", "dabob"]]),
    ("Hood Canal — Union / Great Bend", [["union", "great bend", "lynch cove"]]),
    ("Port Townsend", [["port townsend"]]),
    ("Port Ludlow", [["port ludlow"]]),
    ("Port Hadlock / PT Bay south", [["hadlock"]]),
    ("Mystery Bay / Marrowstone", [["mystery bay", "marrowstone"]]),
    ("Fort Flagler / Kilisut Harbor", [["flagler", "kilisut"]]),
    ("Oak Bay / Mats Mats Bay", [["oak bay", "mats mats", "mats-mats"]]),
    ("Oak Harbor / Saratoga Passage", [["oak harbor", "saratoga"]]),
    ("La Conner / Swinomish", [["la conner", "swinomish"]]),
    ("Anacortes / Cap Sante / Guemes", [["anacortes", "cap sante", "guemes"]]),
]

for label, groups in QUERIES:
    print(f"\n=== {label} ===")
    matched = []
    for sid, s in by_id.items():
        name = s["name"].lower()
        if all(any(k in name for k in g) for g in groups):
            matched.append(s)
    if not matched:
        print("  (no matches)")
    for s in sorted(matched, key=lambda r: r["id"]):
        print(f"  {s['id']:9s}  {s['name']:50s}  ({s['lat']:.4f},{s['lng']:.4f}) type={s.get('type')} ref={s.get('reference_id') or '-'}")
