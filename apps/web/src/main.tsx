import '@cashgear/ui/styles.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App';
import { desktopPlatform } from './platform/desktop';
import { webPlatform } from './platform/web';

const platform = isTauri() ? desktopPlatform : webPlatform;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);
