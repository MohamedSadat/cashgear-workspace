import '@cashgear/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { WorkspaceApp } from '@cgw/shell';
import { desktopPlatform } from './platform/desktop';
import { webPlatform } from './platform/web';

const platform = isTauri() ? desktopPlatform : webPlatform;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceApp platform={platform} />
  </StrictMode>,
);
