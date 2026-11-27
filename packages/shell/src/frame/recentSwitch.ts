// Settings → General's "Show recent pages in the sidebar" (after 0.19.0): kept on this device under
// `cgw-recent` (present: hidden), and shown or hidden at once by <html>'s attribute, which the
// sidebar's CSS reads (`sidebarPrefs.ts` sets it at start).

/** Whether this device hides Recent; shown when storage cannot be read. */
export function recentHidden(): boolean {
  try {
    return !!localStorage.getItem('cgw-recent');
  } catch {
    return false;
  }
}

/** Shows or hides Recent now and on this device's next starts. */
export function setRecentShown(shown: boolean) {
  const root = document.documentElement.dataset;
  if (shown) delete root.cgwRecent;
  else root.cgwRecent = 'hidden';
  try {
    if (shown) localStorage.removeItem('cgw-recent');
    else localStorage.setItem('cgw-recent', 'hidden');
  } catch {
    // Kept until the page closes.
  }
}
