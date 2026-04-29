// "About this site" modal triggered by the (i) button in the Controls
// panel. Holds the contact line and the visible attributions we owe
// upstream data providers (basemap + CHS / OGL-Canada — see notes/TOS.md
// §3). Dismissible via close button, backdrop click, or Escape.

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
          <h3>Legend</h3>
          <ul class="info-legend">
            <li>Times are BC local time (UTC&minus;7 all year)</li>
            <li>Current speed is in knots</li>
            <li>Tide heights are in meters or feet (user selectable)</li>
          </ul>

          <p class="info-copyright">© 2026</p>
          <p>
            Contact:{" "}
            <a href="mailto:info@currentlybc.com">info@currentlybc.com</a>
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
            Contains information licensed under the{" "}
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
        </div>
      </div>
    </div>
  );
}
