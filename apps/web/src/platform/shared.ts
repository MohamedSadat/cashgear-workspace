/**
 * One answer for every caller while it is being asked: a caller that comes while an ask is in
 * flight gets that ask's answer (or its error) instead of starting another; the next caller after
 * it settles asks again.
 *
 * The desktop's `auth_token` is answered one at a time on the native side, and offline each
 * refresh it tries fails only after about 2 s (a refused connection on Windows): eight callers at
 * a start waited one behind another, and the sync status said "Syncing" for 18 s before "Offline"
 * (Phase 3's cold start offline, CI run 44309391191).
 */
export function shareInFlight<T>(ask: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const made = ask().finally(() => {
      if (pending === made) pending = null;
    });
    pending = made;
    return made;
  };
}
