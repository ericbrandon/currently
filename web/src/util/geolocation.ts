// Owns the navigator.geolocation.watchPosition lifecycle and writes
// fresh fixes into the `userLocation` signal. The Controls button toggles
// `userLocationActive`; an effect in app.tsx calls start() / stop() in
// response.
//
// The error callback can fire *synchronously* in some browsers when the
// permission is already denied or the page isn't in a secure context.
// We do NOT reset `userLocationActive` from the error path: doing so
// would set the signal back to false in the same microtask the click
// handler set it to true, and the button would never visually change.
// The active flag stays in its tapped state; the user can untap to clear.

import {
  userLocation,
  userLocationActive,
} from "../state/store";

let watchId: number | null = null;

export function startGeolocation(): void {
  if (watchId !== null) return;

  if (!("geolocation" in navigator)) {
    console.warn("[geolocation] navigator.geolocation is not available");
    return;
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    // Geolocation only works in secure contexts. http://localhost counts;
    // a LAN IP over plain http does not — common gotcha when testing on
    // a phone against a dev server.
    console.warn(
      "[geolocation] Not a secure context. Geolocation requires HTTPS " +
        "(or http://localhost). Visit via https or use localhost.",
    );
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      userLocation.value = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      };
    },
    (err) => {
      // Permission denied / position unavailable / timeout. Log and stop
      // the watcher. Leave userLocationActive as-is so the button stays
      // in its tapped state; the user can untap explicitly.
      console.warn(
        `[geolocation] error (code ${err.code}): ${err.message || "(no message)"}`,
      );
      stopGeolocation();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    },
  );

  // Belt-and-suspenders for browsers that take a while to surface the
  // permission prompt: also issue a one-shot getCurrentPosition so we
  // get a fix as fast as possible without waiting on the watcher's
  // poll cadence.
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (userLocationActive.value) {
        userLocation.value = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        };
      }
    },
    () => { /* watcher's error handler already logs; don't double-warn */ },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

export function stopGeolocation(): void {
  if (watchId === null) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
