For a marine map app with animated tide/current overlays and a scrubbable timeline that works well on mobile, here's the stack I'd recommend:

**Core map + overlays**
- **MapLibre GL JS** — open-source vector map renderer, GPU-accelerated, excellent on mobile. (Mapbox GL JS is the paid sibling; MapLibre is the free fork most people use now.)
- **deck.gl** layered on top of MapLibre — built for animated, time-aware data layers (arrows, heatmaps, icons, paths). Pairs cleanly with MapLibre via `MapboxOverlay`.

**For current/wind-style animated flow**
- If you want windy.com-style particle streams: roll your own with deck.gl, or grab a community shader layer. For the simpler Leaflet route, [`leaflet-velocity`](https://github.com/onaci/leaflet-velocity) gives you that effect for free but is slower at scale.

**Timeline scrubber**
- Plain `<input type="range">` is genuinely fine and mobile-native. If you want nicer styling/touch handles: **noUiSlider** (vanilla) or **rc-slider** (React).

**Tide curves / station detail charts**
- **uPlot** (tiny, fast) or **Chart.js** for simple line charts; **Plotly** if you want zoom/pan + annotations out of the box.

**App shell**
- **React + Vite** is the path of least resistance — keeps the timeline state and map layers in sync without ceremony. Vanilla JS is viable if you want to keep the bundle tiny.

**Main tradeoff**: MapLibre + deck.gl + React is the most capable but has the steepest learning curve and biggest bundle (~400KB+ gzipped). Leaflet + leaflet-velocity + vanilla JS is far simpler and ships in a day, but animation fidelity and panning smoothness on mobile are noticeably worse with dense data.

Want me to sketch a starter project structure for the deck.gl/MapLibre route, or would you rather see what the Leaflet version looks like first?
