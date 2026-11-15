// `@cgw/plugins/view`: a plugin block's frame (`EditorHost.plugins.mount`): the definition's view
// drawn into the block's element, a React root of its own per block, with the app's strings and
// direction. The block's props are read by the definition (unknown ones kept) and written back
// merged; a block written by a later version of the definition is drawn read-only and never
// written. A definition that throws draws "can't be shown here", and the page goes on.
import type { i18n as I18n } from 'i18next';
import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { usePluginT } from './i18n';
import { readBlock, writeProps } from './props';
import type { PluginRegistry } from './registry';
import type { BlockDefinition, PluginData, PluginFrame, PluginFrameOptions } from './types';
import { Message } from './views/common';
import './plugins.css';

export interface PluginMountDeps {
  registry: PluginRegistry;
  data: PluginData;
  i18n: I18n;
}

export function mountPlugin(
  element: HTMLElement,
  options: PluginFrameOptions,
  deps: PluginMountDeps,
): PluginFrame {
  const container = document.createElement('div');
  container.className = 'cgw-plugin-root';
  element.appendChild(container);
  const root = createRoot(container);
  let gone = false;
  const draw = (next: PluginFrameOptions) =>
    root.render(<PluginBlockFrame options={next} deps={deps} container={container} />);
  draw(options);
  return {
    update: (next) => {
      if (!gone) draw(next);
    },
    destroy: () => {
      if (gone) return;
      gone = true;
      // Not during the editor's own update: React refuses to unmount a root while rendering.
      setTimeout(() => {
        root.unmount();
        container.remove();
      }, 0);
    },
  };
}

function PluginBlockFrame({
  options,
  deps,
  container,
}: {
  options: PluginFrameOptions;
  deps: PluginMountDeps;
  container: HTMLElement;
}) {
  const { i18n } = deps;
  useEffect(() => {
    const apply = () => {
      container.dir = i18n.dir(i18n.language);
      container.lang = i18n.language;
    };
    apply();
    i18n.on('languageChanged', apply);
    return () => i18n.off('languageChanged', apply);
  }, [i18n, container]);
  const definition = options.type ? deps.registry.get(options.type) : undefined;
  return (
    <I18nextProvider i18n={i18n}>
      {definition ? (
        <Drawn definition={definition} options={options} data={deps.data} />
      ) : (
        <Unavailable />
      )}
    </I18nextProvider>
  );
}

function Drawn({
  definition,
  options,
  data,
}: {
  definition: BlockDefinition;
  options: PluginFrameOptions;
  data: PluginData;
}) {
  const { locale } = usePluginT();
  const read = useMemo(
    () => readBlock(definition, options.props, options.version),
    [definition, options.props, options.version],
  );
  const editable = options.editable && !read.newer;
  const setProps = (next: object) => {
    if (!editable) return;
    options.setProps(writeProps(read.raw, next), definition.version);
  };
  const View = definition.render;
  return (
    <Boundary fallback={<Unavailable />}>
      <Suspense fallback={<Loading />}>
        <View
          props={read.props}
          editable={editable}
          newer={read.newer}
          setProps={setProps}
          data={data}
          blockId={options.blockId}
          language={locale.startsWith('ar') ? 'ar' : 'en'}
        />
      </Suspense>
    </Boundary>
  );
}

function Loading() {
  const { t } = usePluginT();
  return <Message text={t('common.loading')} busy />;
}

function Unavailable() {
  const { t } = usePluginT();
  return <Message text={t('common.unavailable')} />;
}

class Boundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('A plugin block could not be drawn:', error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
