# Using Part A of the Canadian Atlas of Tidal Currents (Vol. 3)

Part A of *Canadian Atlas of Tidal Currents, Volume 3 — Juan de Fuca Strait to Strait of Georgia* (CHS, 2016) lets a mariner pick the chart that depicts the tidal-stream pattern at a **specific date and time**. It is the day-of, navigation-planning workflow (as opposed to Part B, which is for studying a generic 25-hour cycle).

## Inputs you need

You need the **predicted tide heights at Point Atkinson, BC** for the day in question. These come from the *Canadian Tide and Current Tables, Volume 5*. Point Atkinson is the single reference station that drives all of Part A — every chart in Part A is keyed off it.

## The selection procedure

For each hour of the passage you care about, do the following.

### 1. Extract three values from the Point Atkinson predictions

For the time you want to look up, identify the **bracketing high and low water** (the HW/LW immediately before and immediately after that time), then compute:

- **(a) Range of tide** — the absolute difference in metres between that HW and LW.
- **(b) Tendency** — *rising* if you are between a LW and the following HW; *falling* if between a HW and the following LW.
- **(c) Hours after the preceding high or low water** — rounded to the nearest whole hour. This is how far into the rising or falling segment you are.

### 2. Read the chart number off the Part A graph (page 4 of the atlas)

Page 4 shows six labelled tide curves arranged in two columns:

- **Left column — rising tides**, with representative ranges of **3.0 m, 1.8 m, and 0.6 m**.
- **Right column — falling tides**, with representative ranges of **3.0 m, 1.8 m, and 1.2 m**.

Each curve has chart numbers printed at hourly increments along its length (the start of each curve is centred on the preceding HW or LW).

To pick a chart:

1. Use **(b) tendency** to choose the column (rising = left, falling = right).
2. Use **(a) range** to choose the curve in that column whose labelled range is closest to yours.
3. Use **(c) hours after HW/LW** to find the labelled point on that curve.
4. **The number printed at that point is the chart number** to consult for the tidal-stream pattern.

### 3. Repeat for each hour of interest

Tidal streams change hour by hour, so for a multi-hour passage you repeat steps 1–2 at each hour and read off a sequence of chart numbers.

## Worked example (atlas p. 5)

Plan a passage from **1300 to 1900** on a day with these Point Atkinson predictions:

| Time  | Height |
|-------|--------|
| 0055  | 4.6 m  |
| 0820  | 1.1 m  |
| 1550  | 4.1 m  |
| 2020  | 3.3 m  |

**First segment (1300–1500), bracketed by LW 0820 → HW 1550 (rising):**

- Range = 4.1 − 1.1 = **3.0 m**
- Tendency = **rising**
- 1300 is **~5 hours after** the 0820 LW

From the page-4 graph, the rising 3.0 m curve at hour 5 → **chart 7** for 1400; at hour 6 → **chart 7 or 8** for 1500.

**Second segment (1600–1900), bracketed by HW 1550 → LW 2020 (falling):**

- Range = 4.1 − 3.3 = **0.8 m** (closest curve: falling 1.2 m)
- Tendency = **falling**
- 1600 is hour 0, 1700 is hour 1, etc. after the 1550 HW

From the page-4 graph, the falling 1.2 m curve gives:

- 1600 → chart 37
- 1700 → chart 38
- 1800 → chart 39
- 1900 → **chart 40 or 41** (see edge-case note below)

## Important caveats

### Edge-of-curve ambiguity (atlas p. 5 note)

The duration between successive HW and LW varies considerably with the range of tide, so the labelled hour on a curve is only approximate near its end. If your computed "hours after HW" lands close to the next LW (or vice-versa), prefer the chart number from the *next* segment. Example from the atlas: if "3 hours after high water" is essentially "1 hour before low water", chart 41 is more appropriate than chart 40.

### Part A vs Part B charts are *similar but not identical* (atlas p. 3)

Part A's hourly increments are **centred on a HW or LW**, while Part B's increments are not centred on any HW/LW. So a Part A chart and a Part B chart that *appear* to depict the same tidal stage will differ slightly. Compare charts 24 (Part A) and 51 (Part B) to see this. Always pick from Part A for date-specific navigation.

### Reference-station predictions are more accurate in narrow passes (atlas p. 3)

The **Current Reference Station predictions in Tide and Current Tables Volume 5** give more accurate slack-water times and maximum-current velocities than the atlas, especially for narrow channels like the Gulf Islands passes. Use Vol. 5 there in preference to the atlas.

### Wind and river discharge are not modelled

Parts A and B assume currents are driven only by ocean tides. Add a wind-driven surface component of roughly **3% of the wind speed** in the wind's direction. Near the Fraser River mouth, surface flow is dominated by river discharge — use **Part C** for that, not Part A.

## Layout reminder

In Parts A and B, **page numbers are in regular type and chart numbers in larger type**. The two sides of the strait are split by page parity:

- **Even (left) pages** → Northern Strait of Georgia
- **Odd (right) pages** → Southern Strait of Georgia and Juan de Fuca Strait

So once you have a chart number from page 4, the actual chart is on whichever even/odd page covers the geography you care about.
