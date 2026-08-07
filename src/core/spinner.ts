// Match pi's built-in Loader defaults used for the inline "Working..." indicator.
// See @earendil-works/pi-tui/src/components/loader.ts.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

/**
 * Drives a live spinner row at pi's own Loader cadence. The interval stays
 * alive while isActive() returns true and is unref'd so it never holds the
 * process open on its own.
 */
export function createSpinnerHeartbeat(
  isActive: () => boolean,
  onTick: () => void,
): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        if (isActive()) {
          onTick();
        }
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
