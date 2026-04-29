import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'

// iOS/iPadOS Safari ignores user-scalable=no; block its non-standard
// gesture events so pinches on UI chrome don't zoom the whole page.
// MapLibre uses raw touch events for its own pinch-zoom and doesn't
// depend on these, so the map canvas keeps working.
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('gesturechange', (e) => e.preventDefault())

render(<App />, document.getElementById('app')!)
