// Whether the sidebar shows its Recent pages, kept on this device as the theme and the language
// are (DECISIONS.md, 2026-11-27): hidden by CSS from an attribute on <html> (workspace.css,
// `[data-cgw-recent='hidden']`). The first screen only sets it at start (350 kB budget); Settings
// changes it (`frame/recentSwitch.ts`). Visits are recorded either way.

/** Sets the attribute that hides Recent from what this device keeps. */
export function applyRecent() {
  try {
    if (localStorage.getItem('cgw-recent')) document.documentElement.dataset.cgwRecent = 'hidden';
  } catch {
    // Shown.
  }
}
