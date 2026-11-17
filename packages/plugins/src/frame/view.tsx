// `@cgw/plugins/frame-view`: a third-party plugin block's frame (`EditorHost.plugins.mount` for a
// type that is not first-party), a React root of its own per block, with the app's strings and
// direction; loaded with the first such block on screen, so nothing of it is in the app's first
// load. Never saves, loads or calls the network: the shell gives it the frame's address.
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { usePluginT } from '../i18n';
import type { PluginFrame, PluginFrameOptions } from '../types';
import { Message } from '../views/common';
import { ThirdPartyBlock } from './ThirdPartyBlock';
import type { ThirdPartyDeps } from './types';
import '../plugins.css';
import './frame.css';

export { ThirdPartyBlock } from './ThirdPartyBlock';
export type {
  InstalledPlugin,
  PluginAvailability,
  ThirdPartyDeps,
  ThirdPartySource,
} from './types';
export { FrameUrlError } from './types';

export function mountThirdParty(
  element: HTMLElement,
  options: PluginFrameOptions,
  deps: ThirdPartyDeps,
): PluginFrame {
  const container = document.createElement('div');
  container.className = 'cgw-plugin-root';
  element.appendChild(container);
  const { i18n } = deps;
  const apply = () => {
    container.dir = i18n.dir(i18n.language);
    container.lang = i18n.language;
  };
  apply();
  i18n.on('languageChanged', apply);
  const root = createRoot(container);
  let gone = false;
  const draw = (next: PluginFrameOptions) =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Boundary>
          <ThirdPartyBlock options={next} deps={deps} />
        </Boundary>
      </I18nextProvider>,
    );
  draw(options);
  return {
    update: (next) => {
      if (!gone) draw(next);
    },
    destroy: () => {
      if (gone) return;
      gone = true;
      i18n.off('languageChanged', apply);
      // Out of the page at once; the root goes after the editor's own update, as React refuses
      // to unmount a root while rendering.
      container.remove();
      setTimeout(() => root.unmount(), 0);
    },
  };
}

function Unavailable() {
  const { t } = usePluginT();
  return <Message text={t('common.unavailable')} />;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Unavailable /> : this.props.children;
  }
}
