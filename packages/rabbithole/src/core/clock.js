/** The one production clock; tests inject the same two-method shape. */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
});

/** @param {{ now?: () => number, iso?: () => string } | null | undefined} clock */
export function normalizeClock(clock) {
  const now = clock?.now;
  const iso = clock?.iso;
  return Object.freeze({
    now: typeof now === "function" ? () => now() : systemClock.now,
    iso: typeof iso === "function" ? () => iso() : systemClock.iso,
  });
}
