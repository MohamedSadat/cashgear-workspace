import '@cashgear/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { WorkspaceApp } from '@cgw/shell';
import { desktopPlatform } from './platform/desktop';
import { webPlatform } from './platform/web';

const desktop = isTauri();
const platform = desktop ? desktopPlatform : webPlatform;

createRoot(document.getElementById('root')!).render(
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
