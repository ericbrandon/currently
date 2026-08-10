/**
 * Service worker registration + update flow (ported from sidestream).
 *
 * Prod only, registered after load. When a new build's worker reaches
 * `installed` while an old one still controls the page, `onUpdateReady`
 * fires with an `apply` callback: the app shows the update toast, and
 * accepting posts SKIP_WAITING → controllerchange → one reload. Ignoring
 * the toast is fine — the next full load activates the new worker
 * naturally.
 *
 * Mobile PWAs rarely "reload", so we also check for updates every time
 * the app returns to the foreground (visibilitychange → visible) —
 * throttled, and the still-waiting worker is re-offered each time (so a
 * dismissed toast comes back rather than stranding the update for the
 * rest of the session).
 */

/**
 * Minimum gap between `registration.update()` calls. Unthrottled, every
 * app-switch on a phone fires a network request for the worker script.
 */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function registerServiceWorker(onUpdateReady: (apply: () => void) => void): void {
  if (!('serviceWorker' in navigator)) return;

  // Reload ONLY when the user accepted an update. clients.claim() also
  // fires controllerchange on the very first install — reloading there
  // would blank every first visit for no reason.
  let applyRequested = false;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applyRequested || reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  // "After load" — but the registering effect usually runs after `load`
  // has already fired, and a listener added then never fires. readyState
  // is the race-free form.
  const whenLoaded = (fn: () => void) => {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
  };

  whenLoaded(() => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        const offerIfWaiting = () => {
          const waiting = registration.waiting;
          // Only a controlled page gets the toast: on the very first
          // install there is nothing stale on screen to refresh away from.
          if (waiting && navigator.serviceWorker.controller) {
            onUpdateReady(() => {
              applyRequested = true;
              waiting.postMessage('SKIP_WAITING');
            });
          }
        };

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed') offerIfWaiting();
          });
        });

        // An update may already be parked from a previous visit/tab.
        offerIfWaiting();

        let lastUpdateCheck = Date.now(); // the registration above just checked

        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'visible') return;
          // The registration is held here for the life of the page, so
          // coming back to the app re-offers whatever is still parked.
          offerIfWaiting();
          const now = Date.now();
          if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
          lastUpdateCheck = now;
          void registration.update();
        });
      })
      .catch((error) => {
        // Non-fatal: the app is fully functional without offline support.
        console.warn('[pwa] service worker registration failed', error);
      });
  });
}
