// Minimal requestAnimationFrame coalescer.
//
// Wrap any "do something with the latest value" callback so it runs at
// most once per frame. Repeated `schedule()` calls within the same frame
// are collapsed to one invocation that sees the most recent value.

export function rafCoalesce<T>(fn: (value: T) => void): {
  schedule: (value: T) => void;
  cancel: () => void;
} {
  let pending: T | undefined;
  let queued = false;
  let frameId = 0;

  function flush() {
    queued = false;
    const v = pending as T;
    pending = undefined;
    fn(v);
  }

  return {
    schedule(value: T) {
      pending = value;
      if (!queued) {
        queued = true;
        frameId = requestAnimationFrame(flush);
      }
    },
    cancel() {
      if (queued) {
        cancelAnimationFrame(frameId);
        queued = false;
        pending = undefined;
      }
    },
  };
}
