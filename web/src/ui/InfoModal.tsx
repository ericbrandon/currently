// "About this site" modal triggered by the (i) button in the Controls
// panel. Holds the contact line and the visible attributions we owe
// upstream data providers (basemap + CHS / OGL-Canada + NOAA CO-OPS —
// see notes/TOS.md §3). Dismissible via close button, backdrop click,
// or Escape.

import { useEffect } from "preact/hooks";
import { infoModalOpen } from "../state/store";

function close() {
  infoModalOpen.value = false;
}

export function InfoModal() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      class="info-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="info-title"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div class="info-modal">
        <div class="info-header">
          <h2 id="info-title" class="info-title">Information</h2>
          <button
            class="info-close"
            type="button"
            aria-label="Close"
            onClick={close}
          >
            ×
          </button>
        </div>
        <div class="info-body">
          <h3>Tips</h3>
          <ul class="info-legend">
            <li>Show tides and currents with the top right corner buttons</li>
            <li>Click on a station to see its chart</li>
            <li>Drag the timeline left or right</li>
            <li>To see a station's information as a table, press "Table" at the top left of the chart box</li>
          </ul>

          <h3>Legend</h3>
          <ul class="info-legend">
            <li>Times are BC local time (UTC&minus;7 all year)</li>
            <li>Current speed is in knots</li>
            <li>Tide heights are in meters or feet (user selectable)</li>
          </ul>

          <p class="info-copyright">© 2026</p>
          <p>
            Contact:{" "}
            <a href="mailto:admin.currentlybc@gmail.com">admin.currentlybc@gmail.com</a>
          </p>

          <h3>Basemap</h3>
          <p>
            Basemap tiles &amp; style ©{" "}
            <a
              href="https://openfreemap.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenFreeMap
            </a>
            , powered by{" "}
            <a
              href="https://openmaptiles.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenMapTiles
            </a>
            . Map data ©{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenStreetMap
            </a>{" "}
            contributors.
          </p>

          <h3>Tide &amp; current data</h3>
          <p>
            Canadian waters: contains information licensed under the{" "}
            <a
              href="https://open.canada.ca/en/open-government-licence-canada"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Government Licence – Canada
            </a>
            . Tide and current data © Canadian Hydrographic Service,
            Fisheries and Oceans Canada.
          </p>
          <p>
            Puget Sound: tide and current data courtesy of the{" "}
            <a
              href="https://tidesandcurrents.noaa.gov/"
              target="_blank"
              rel="noopener noreferrer"
            >
              NOAA Center for Operational Oceanographic Products and
              Services (CO-OPS)
            </a>
            , National Ocean Service. U.S. Government data, not subject
            to copyright.
          </p>
        </div>
      </div>
    </div>
  );
}
