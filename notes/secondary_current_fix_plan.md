# Fix plan: one-directional secondary currents (Johnstone Strait group)

Status: ALL PHASES DONE (2026-07-05).

Phase 4 outcome:
- HARO STRAIT (a): new turn_to_ebb_conditional field ({below_knots,
  add}) emitted from TABLE4_FOOTNOTES; secondaryCurrentExtremes walks
  back to the turn ref's preceding max-flood (weak counts as 0) and
  adds +1:10 when below 2.0 kn. E2E: exactly 147 of Haro's 2026
  slack-to-ebb events shift, each by exactly +1:10.
- NITINAT BAR (b): restored (48 40N 124 51W raw PDF coords — needs a
  coord_overrides.json entry like the other restored stations). New
  lower_lw_turn_to_flood_diff field ("+04:17"); turn_to_flood_diff
  holds the higher-LW "+02:00". New classifyLowerLows(extremes, isHi,
  utcOffset) marks each station-local day's lowest LW (single-LW days
  count as lower); classifyTideAsCurrent tags slack-to-flood events
  with lowerLW; builder picks the per-event diff. E2E: Tofino 2026 has
  365 lower + 340 higher LWs; Nitinat balanced 705 flood / 704 ebb.
- Published data now 47 secondaries. Whitelist extended with both new
  fields. 25 tests green (conditional x3, lower-LW x2, invariants
  extended to pin Haro/Nitinat footnote fields per year). Build green.
- TABLE4_FOOTNOTES actions now: turn_reference, conditional_turn_to_ebb,
  lw_turn_to_flood, static_ok, drop. Unknown markers still raise.

Phase 3 outcome:
- SURPRISE FINDING: parse_table4 read only the FIRST page of Table 4;
  vol 6's table spans two pages, so 8 stations were silently missing
  for years: Nahwitti Bar, Stuart Narrows (on ALERT BAY tides),
  Nenahlmai Lagoon, Eclipse Narrows, Schooner Channel, Slingsby
  Channel (on NAKWAKTO RAPIDS), Nitinat Bar, Hayden Passage (on
  TOFINO tides). Parser now walks continuation pages (every table page
  repeats the "REFERENCE AND SECONDARY" header) with on/sur state
  carried across the break. 7 restored; Nitinat Bar deliberately
  dropped (footnote (b) rule unrepresentable — Phase 4).
- read_tct.py: TABLE4_FOOTNOTES curated map keyed by (index_no,
  marker); parse RAISES on any un-curated marker — the 2027 guard.
  Row-level marker capture (regex \(([a-z])\) over row text), new
  SecondaryCurrent fields footnote_markers + turn_reference_primary.
- build_manifest.py: turn_reference_primary added to the
  current_secondary publish whitelist (published files are
  whitelist-stripped; root JSONs keep everything).
- Regenerated + republished 2026 data (46 secondaries, was 39).
  Coord overrides re-applied cleanly (all hand-tweaks live in
  coord_overrides.json keyed by index_no — verified before regen).
- App: CurrentSecondaryStation.turn_reference_primary type field;
  secondaryCurrentExtremes(sec, refClassified, turnRefClassified?) —
  slacks from turn ref, maxes from rate ref; loader resolves the turn
  ref through CURRENT_REF_ALIASES with warn-and-fallback.
- Tests (20 green): split-ref unit test; data invariants extended —
  continuation-page stations present, ALERT BAY / PULTENEY POINT have
  turn_reference_primary === "SEYMOUR NARROWS", both-directions
  invariant now split-ref aware.
- E2E: Alert Bay 2821 events/yr (1410 slacks from Seymour's 4/day
  turns — JSC could only supply 220), 701 flood / 710 ebb, zero
  same-sign adjacent maxes. Restored tide-ref stations all balanced.
- Known cosmetics: "GOLETAS CHANNEL NAHWITTI BAR" / "DRURY INLET
  STUART NARROWS" names carry their zone-heading prefix (existing
  MALIBU RAPIDS convention); NENAHLMAI's wrapped name line "ENTRANCE"
  mis-attaches as ECLIPSE NARROWS' geographic_zone (unused by app).

Phase 2 outcome:
- secondaryCurrentExtremes (web/src/interp/secondaryCurrents.ts): a weak
  ref max at a knots-rule (percentage-omitted) secondary now emits the
  published ±magnitude, un-flagged (weakness belongs to the reference);
  percentage-rule secondaries keep 0 + weak:true; a weak ref max whose
  matching magnitude column is null also stays 0 + weak:true (preserves
  the v===0 contract).
- Secondary-coverage invariant enabled in dataInvariants.test.ts: every
  magnitude-bearing, current-referenced secondary must have peaks in
  both directions over the year, per published year dir. Loader's
  CURRENT_REF_ALIASES exported so tests resolve refs identically.
- Builder unit tests added (knots-rule weak, pct-rule weak, null-column
  weak) in secondaryCurrents.test.ts. 18 tests green; build passes.
- E2E: Alert Bay 2026 now 701 flood / 710 ebb peaks (was 110 / 710
  plus 591 dead weak zeros).
- Scott Channel follow-up (asked 2026-07-05): NO secondaries reference
  Scott Channel, so its 14 weak (faded-ebb) maxes only affect its own
  primary display, where 0/weak is faithful to the book. Active Pass's
  secondaries: Georgeson Passage + Boat Passage are pct-rule (weak→0
  correct); Sansum Narrows has null max diffs → midpoint synthesis, so
  it was only ever exposed to the slack-misclassification, fixed in
  Phase 1. No footnotes on any of them (census covered vols 5-7).

Phase 1 outcome:
- classifyCurrentEvents rewritten (web/src/interp/secondaryCurrents.ts):
  weak maxes resolve by alternation parity from nearest signed max on
  each side; slacks classify by the next max's resolved direction.
  Empirics that shaped it: strict alternation does NOT hold globally
  (291 consecutive same-sign signed-max pairs in 2026, real vanished
  peaks); both-side parity agrees for 874/876 weak maxes, 0 conflicts,
  0 consecutive-weak pairs; old heuristic was inverted for essentially
  EVERY weak max (JSC 591 floods→ebb, Scott Channel 14 ebbs→flood).
- vitest added to web/ (`npm test`). Unit tests:
  web/src/interp/secondaryCurrents.test.ts. Data invariants (glob all
  year dirs, 2027-ready): web/src/interp/dataInvariants.test.ts —
  flood/ebb balance ≥25% per primary, JSC weak⇒max-flood pin, v===0
  contract. The secondary-coverage invariant is written but `.skip`ped
  until Phase 2 (search "Enabled in Phase 2").
- E2E check: JSC now classifies 701 flood / 710 ebb (was 110/1301);
  Alert Bay year still has only 110 positive peaks until Phase 2 turns
  its 591 weak zeros into +4.0 kn floods.
- notes/calculating_secondary_currents.md classification section
  updated to the new rule.

## Symptom & root cause (investigated 2026-07-05)

Masterman Islands, Browning Islands, Pulteney Point, Alert Bay (plus Camp
Point and Current Passage — same mechanism, unnoticed) only ever render
ebb-direction arrows.

All six reference JOHNSTONE STRAIT-CENTRAL. That primary genuinely prints
`*` ("current weak & variable") for 591 of its 1411 max events in 2026 —
nearly every flood max. Verified against the vol 6 PDF (pdf page index 74,
printed p. 72): the parser is faithful; there is **no sign flip** anywhere.
Real JSC floods, when printed, are only +0.3…+0.5 kn.

Three distinct defects follow:

1. **Classification bug** (`classifyCurrentEvents`,
   web/src/interp/secondaryCurrents.ts): weak maxes are classified by the
   sign of the *nearest non-zero* event. At JSC the nearest signed max is
   always an ebb, so all 591 weak (faded-flood) maxes classify as weak-EBB.
   Positionally they are floods. Additional wrinkle: on weak days JSC often
   prints NO turn (slack) entries around the weak max (e.g. Jan 1: weak
   0005, ebb 0545, weak 1124, ebb 1801, slack 2239), so slack-bracket
   positional classification is impossible — must use **max alternation**
   (maxes alternate flood/ebb; a weak max between two ebbs is a faded
   flood). Slack classification should then key off the *resolved* direction
   of the next max, not nearest-signed-value.

2. **Weak propagation bug** (`secondaryCurrentExtremes`): a weak ref max
   emits v=0 at the secondary even when the secondary has a published
   absolute magnitude (Alert Bay: 4.0 kn flood). Per the book (vol 6
   "Procedure for Calculation of Currents at Secondary Current Stations",
   printed p. 103, step 3): when percentages are omitted, the max rate at
   large tides is given directly — the reference contributes TIMING ONLY.
   And "Explanation of the Tables" (printed p. 105): "Where a maximum rate
   is given, a consistent method of calculating speeds from the Reference
   Station has not been established." So zeroing the secondary from JSC's
   `*` is contrary to the book. The app already emits the flat tabulated
   magnitude on non-weak days (documented deliberate limitation — Okisollo
   peaks 11.0 kn every day); weak days must do the same.
   Percentage-based secondaries (Bear Point, Sunderland Channel, Forward
   Bay) are DIFFERENT: weak ref → 0 is correct for them (book multiplies
   by the unusable ref rate). Keep their behavior.

3. **Split-reference footnote** (Table 4 vol 6, footnote (a)): Alert Bay
   and Pulteney Point turn-to-flood/turn-to-ebb diffs apply to **Seymour
   Narrows**, NOT Johnstone Strait-Central. Max time diffs and rates stay
   on JSC. Complete footnote census across vols 5/6/7 (there are only
   three, verified 2026-07-05):
   - vol 6 (a): Alert Bay + Pulteney Point → turns from Seymour Narrows.
     The ONLY cross-station cases.
   - vol 5 (a): HARO STRAIT — conditional: "If the preceding flood current
     at Race Passage was less than 2.0 knots, add 1 hour 10 minutes" (to
     the +02:30 turn-to-ebb diff). Same ref station, conditional time.
   - vol 6 (b): NITINAT BAR — tide-referenced, turn-to-flood = higher LW
     +2:00 / lower LW +4:17. Station is currently ABSENT from
     2026_tct_current_secondary_stations.json (parser likely dropped it on
     the "(b)" cell) — silent drop to investigate.
   - vol 7: no footnotes.

Affected-station census (secondary has max_flood_knots > 0.2 AND ref has
weak events): Camp Point (6.0), Current Passage (5.0), Alert Bay (4.0),
Pulteney Point (3.0), Masterman Islands (1.0), Browning Islands (1.0) — all
on JSC (591 weak) — plus Sansum Narrows (3.0, Active Pass, only 10 weak
events/yr, cosmetic).

## Key facts

- Classification happens at RUNTIME in the app; the year JSON stores raw
  book data faithfully. Phases 1–2 need **no data regeneration**. Only
  Phase 3 (new JSON field) regenerates tables.
- Data pipeline: canada_data/read_tct.py parses the PDFs →
  2026_tct_current_*.json → build step copies hashed files to
  web/public/data/2026/. Python runs via project venv (venv/bin/python).
- web/ has no test runner yet (vite only) — Phase 1 adds vitest.
- Notes contract (notes/calculating_secondary_currents.md): every emitted
  slack and weak event must be strictly v === 0; currentValueAt branches
  on v === 0. Therefore Phase 2 must emit magnitude WITHOUT weak:true
  (weakness describes JSC, not the secondary).

## Phase 1 — classifier fix + test harness (app only, ships alone)

- Rewrite weak-max classification in `classifyCurrentEvents`:
  max-alternation parity from nearest signed max on each side; both sides
  agree → use it; disagree (physically missing max) → nearer anchor wins;
  no signed max at all → fall back to old nearest-signed heuristic.
- Slacks: classify by resolved direction of the NEXT max (invert previous
  at end of array), replacing nearest-signed-value logic.
- Add vitest to web/ ("test": "vitest run").
- Tests:
  - Unit: synthetic sequences incl. the real JSC pattern (weak, ebb, weak,
    ebb, lone slack), consecutive weaks, boundary weaks.
  - Data invariants, globbing web/public/data/*/current_primary*.json (so
    2027 files are covered automatically when added): resolved max
    directions alternate per station; slack/weak events v === 0.
  - Secondary-coverage invariant (every magnitude-bearing secondary has
    positive AND negative peaks over the year) is written in Phase 1 but
    enabled in Phase 2 — it fails until weak propagation is fixed.

## Phase 2 — weak propagation fix (app only, AFTER Phase 1)

- In `secondaryCurrentExtremes`: ref max weak AND secondary is
  percentage-omitted (max_*_knots path) → emit flat tabulated magnitude,
  signed, at the diff-shifted time, weak flag NOT set.
- Percentage secondaries unchanged (weak → v=0 + weak:true).
- MUST land after Phase 1: with the old misclassification, weak floods
  would emit as -max_ebb_knots at ebb-shifted times.
- Enable the secondary-coverage invariant test.

## Phase 3 — split turn/max references (parser + data + app)

- read_tct.py: capture per-row footnote markers in Table 4 (has_footnote
  already exists; record WHICH marker). Curated interpretation map
  (footnote text is prose; do not auto-parse): marker → semantics, e.g.
  {vol 6, (a)} → turn_reference_primary = "SEYMOUR NARROWS".
- Build FAILS LOUDLY if a footnote marker exists with no curated entry —
  this is the 2027-proofing: new year, new footnote → broken build, not
  silently wrong math.
- Emit optional `turn_reference_primary` field on secondary JSON rows;
  regenerate 2026 secondary JSON + hashed web/public/data/2026 copy.
- App: `secondaryCurrentExtremes` takes separate turn-ref and max-ref
  classified arrays (same array for normal stations); slacks from turnRef,
  maxes from maxRef, merge + sort; loader wires turn_reference_primary.
  Add alternation sanity check on merged output.

## Phase 4 — stragglers (optional, cheap)

- HARO STRAIT: runtime conditional — when preceding Race Passage flood
  < 2.0 kn, add +1:10 to that turn-to-ebb diff (Race Passage rates are in
  memory).
- NITINAT BAR: find why the parser dropped it; restore via the curated
  footnote mechanism or consciously exclude and document.
