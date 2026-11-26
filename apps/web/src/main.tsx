import '@cashgear/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { WorkspaceApp } from '@cgw/shell';
import { desktopPlatform } from './platform/desktop';
import { webPlatform } from './platform/web';

const desktop = isTauri();
const platform = desktop ? desktopPlatform : webPlatform;
const root = document.getElementById('root')!;

// The frame above an on-screen keyboard where the browser ignores index.html's
// `interactive-widget=resizes-content` (Safari on iOS): keyboardFit.ts, loaded the first time the
// visual viewport is shorter than the layout viewport, so the first screen carries none of it.
const viewport = window.visualViewport;
const shorter = () => {
  if (viewport!.height >= document.documentElement.clientHeight - 1) return;
  viewport!.removeEventListener('resize', shorter);
  import('./keyboardFit').then(
    ({ fitAboveKeyboard }) => fitAboveKeyboard(root),
    (error: unknown) => console.warn('The frame will not fit above the keyboard:', error),
  );
};
viewport?.addEventListener('resize', shorter);

createRoot(root).render(
  <StrictMode>
    <WorkspaceApp platform={platform} />
  </StrictMode>,
);

// The web app starts with no network after one visit online: a service worker made with the
// build keeps the build's files (sw/service-worker.js has its rules). Only in a production web
// build: the desktop app serves its own files, and Vite's dev server changes them as you edit.
// Registered once the page has loaded, so it never competes with the first paint.
if (import.meta.env.PROD && !desktop && 'serviceWorker' in navigator) {
  const register = () =>
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch((error: unknown) => console.warn('The app will not start offline:', error));
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
