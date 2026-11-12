// Node views for the atom bodies and the code block, in plain DOM. The document holds ids only
// (D6): file names, sizes and page titles come from the host when drawn, and a block whose target
// is gone draws a placeholder; nothing here ever removes a block on its own.
import type { NodeViewRenderer, Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { safeHref } from '@cgw/doc';
import type { EditorHost } from '../host';

type Pos = (() => number | undefined) | boolean;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setAttrs(editor: Editor, getPos: Pos, node: PMNode, attrs: Record<string, unknown>) {
  if (typeof getPos !== 'function' || !editor.isEditable) return;
  const pos = getPos();
  if (pos === undefined) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
}

export function formatBytes(bytes: number, locale?: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 1 : 0 }).format(value)} ${units[unit]}`;
}

/** Inputs inside a node view take their own keys and clicks; ProseMirror leaves them alone. */
const ownsEvent = (dom: HTMLElement) => (event: Event) => {
  const target = event.target as HTMLElement | null;
  return (
    !!target && dom.contains(target) && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)
  );
};

export function imageView(host: () => EditorHost): NodeViewRenderer {
  return ({ node: initial, getPos, editor }) => {
    let node = initial;
    const dom = el('figure', 'cgw-body cgw-image');
    dom.dataset.body = 'image';
    dom.contentEditable = 'false';
    const frame = el('div', 'cgw-image-frame');
    const img = el('img');
    img.draggable = false;
    img.decoding = 'async';
    const missing = el('div', 'cgw-image-missing');
    const resize = el('span', 'cgw-image-resize');
    const caption = el('input', 'cgw-image-caption');
    caption.dir = 'auto';
    const tools = el('div', 'cgw-image-tools');
    frame.append(img, missing, resize);
    dom.append(tools, frame, caption);
    let loaded = '';

    const draw = () => {
      const strings = host().strings;
      dom.dataset.align = String(node.attrs.align ?? 'center');
      frame.style.width = node.attrs.width ? `${node.attrs.width}px` : '';
      img.alt = String(node.attrs.alt ?? '');
      caption.value = String(node.attrs.caption ?? '');
      caption.placeholder = strings?.imageCaption ?? '';
      caption.setAttribute('aria-label', strings?.imageCaption ?? '');
      caption.readOnly = !editor.isEditable;
      const assetId = node.attrs.assetId as string | null;
      if (assetId && assetId !== loaded) {
        loaded = assetId;
        void host()
          .assets?.url(assetId)
          .then((url) => {
            if (loaded !== assetId) return;
            if (url) {
              img.src = url;
              img.hidden = false;
              missing.hidden = true;
            } else {
              img.hidden = true;
              missing.hidden = false;
              missing.textContent = host().strings?.assetMissing ?? '';
            }
          });
      }
      tools.replaceChildren();
      if (!editor.isEditable) return;
      for (const align of ['start', 'center', 'end'] as const) {
        const button = el(
          'button',
          'cgw-image-tool',
          align === 'start' ? '⇤' : align === 'center' ? '⇔' : '⇥',
        );
        button.type = 'button';
        button.setAttribute('aria-label', strings?.[`align_${align}`] ?? align);
        button.setAttribute('aria-pressed', String((node.attrs.align ?? 'center') === align));
        button.addEventListener('click', () => setAttrs(editor, getPos, node, { align }));
        tools.append(button);
      }
      const alt = el('button', 'cgw-image-tool', 'ALT');
      alt.type = 'button';
      alt.setAttribute('aria-label', strings?.imageAlt ?? '');
      alt.addEventListener('click', () => {
        const input = el('input', 'cgw-image-alt');
        input.value = String(node.attrs.alt ?? '');
        input.setAttribute('aria-label', strings?.imageAlt ?? '');
        input.placeholder = strings?.imageAlt ?? '';
        input.dir = 'auto';
        const done = () => {
          setAttrs(editor, getPos, node, { alt: input.value.trim() || null });
          input.remove();
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            done();
          }
        });
        input.addEventListener('blur', done);
        tools.append(input);
        input.focus();
      });
      tools.append(alt);
    };

    caption.addEventListener('change', () =>
      setAttrs(editor, getPos, node, { caption: caption.value.trim() || null }),
    );
    caption.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        caption.blur();
        editor.commands.focus();
      }
    });
    // Width by dragging the corner; kept between 80 px and the page's width.
    resize.addEventListener('pointerdown', (event) => {
      if (!editor.isEditable) return;
      event.preventDefault();
      const start = event.clientX;
      const startWidth = frame.getBoundingClientRect().width;
      const rtl = getComputedStyle(dom).direction === 'rtl';
      const max = dom.getBoundingClientRect().width;
      const move = (e: PointerEvent) => {
        const delta = (e.clientX - start) * (rtl ? -1 : 1);
        frame.style.width = `${Math.round(Math.max(80, Math.min(max, startWidth + delta)))}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setAttrs(editor, getPos, node, { width: Math.round(frame.getBoundingClientRect().width) });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    draw();
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        draw();
        return true;
      },
      stopEvent: ownsEvent(dom),
      ignoreMutation: () => true,
    };
  };
}

export function fileView(host: () => EditorHost): NodeViewRenderer {
  return ({ node: initial }) => {
    let node = initial;
    const dom = el('div', 'cgw-body cgw-file');
    dom.dataset.body = 'file';
    dom.contentEditable = 'false';
    const button = el('button', 'cgw-file-open');
    button.type = 'button';
    const name = el('span', 'cgw-file-name');
    const size = el('span', 'cgw-file-size');
    button.append(el('span', 'cgw-file-icon', '📎'), name, size);
    dom.append(button);
    const draw = () => {
      const assetId = node.attrs.assetId as string | null;
      const info = assetId ? host().assets?.info(assetId) : undefined;
      const strings = host().strings;
      name.textContent = info?.fileName ?? strings?.assetMissing ?? '';
      size.textContent = info ? formatBytes(info.sizeBytes, document.documentElement.lang) : '';
      dom.dataset.missing = String(!info);
      button.setAttribute(
        'aria-label',
        `${strings?.openFile ?? ''} ${info?.fileName ?? ''}`.trim(),
      );
    };
    button.addEventListener('click', () => {
      const assetId = node.attrs.assetId as string | null;
      if (assetId && host().assets?.info(assetId)) host().assets?.open(assetId);
    });
    draw();
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        draw();
        return true;
      },
      stopEvent: ownsEvent(dom),
      ignoreMutation: () => true,
    };
  };
}

export function bookmarkView(host: () => EditorHost): NodeViewRenderer {
  return ({ node: initial, getPos, editor }) => {
    let node = initial;
    const dom = el('div', 'cgw-body cgw-bookmark');
    dom.dataset.body = 'bookmark';
    dom.contentEditable = 'false';
    const draw = () => {
      dom.replaceChildren();
      const strings = host().strings;
      const url = safeHref(node.attrs.url);
      if (!url) {
        if (!editor.isEditable) return;
        const form = el('form', 'cgw-bookmark-form');
        const input = el('input', 'cgw-bookmark-input');
        input.dir = 'ltr';
        input.placeholder = strings?.bookmarkPlaceholder ?? '';
        input.setAttribute('aria-label', strings?.bookmarkPlaceholder ?? '');
        const error = el('span', 'cgw-bubble-error');
        const submit = el('button', 'cgw-bookmark-submit', strings?.bookmarkAdd ?? '');
        submit.type = 'submit';
        form.append(input, submit, error);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const value = input.value.trim();
          const candidate = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(value) ? `https://${value}` : value;
          const safe = safeHref(candidate);
          if (!safe || !/^https?:/.test(safe)) {
            error.textContent = strings?.bookmarkInvalid ?? '';
            return;
          }
          setAttrs(editor, getPos, node, { url: safe });
        });
        dom.append(form);
        queueMicrotask(() => input.focus());
        return;
      }
      // The URL always shows; a preview from the server, when there is one, fills the card (Q13).
      const link = el('a', 'cgw-bookmark-card');
      link.href = url;
      link.rel = 'noopener noreferrer nofollow';
      link.target = '_blank';
      link.dir = 'ltr';
      let host_ = url;
      try {
        host_ = new URL(url).host;
      } catch {
        // Keep the URL as written.
      }
      link.append(el('span', 'cgw-bookmark-host', host_), el('span', 'cgw-bookmark-url', url));
      link.addEventListener('click', (event) => {
        event.preventDefault();
        host().openExternal?.(url);
      });
      dom.append(link);
      const drawn = url;
      void host()
        .linkPreview?.(url)
        .then((preview) => {
          // Text only through textContent; the image only from an asset URL the host gave.
          if (!preview || safeHref(node.attrs.url) !== drawn || !link.isConnected) return;
          if (preview.siteName)
            link.querySelector('.cgw-bookmark-host')!.textContent = preview.siteName;
          if (preview.title) link.prepend(el('span', 'cgw-bookmark-title', preview.title));
          if (preview.description)
            link.insertBefore(
              el('span', 'cgw-bookmark-description', preview.description),
              link.querySelector('.cgw-bookmark-host'),
            );
          if (preview.imageUrl && /^(blob:|https:|http:\/\/127\.0\.0\.1)/.test(preview.imageUrl)) {
            const image = el('img', 'cgw-bookmark-image');
            image.src = preview.imageUrl;
            image.alt = '';
            image.loading = 'lazy';
            link.prepend(image);
          }
          link.classList.add('has-preview');
        })
        .catch(() => undefined);
    };
    draw();
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        const changed = next.attrs.url !== node.attrs.url;
        node = next;
        if (changed) draw();
        return true;
      },
      stopEvent: ownsEvent(dom),
      ignoreMutation: () => true,
    };
  };
}

export function childPageView(host: () => EditorHost): NodeViewRenderer {
  return ({ node: initial }) => {
    let node = initial;
    const dom = el('div', 'cgw-body cgw-childPage');
    dom.dataset.body = 'childPage';
    dom.contentEditable = 'false';
    const link = el('a', 'cgw-child-page-link');
    const icon = el('span', 'cgw-child-page-icon');
    const title = el('span', 'cgw-child-page-title');
    link.append(icon, title);
    dom.append(link);
    const draw = () => {
      const pageId = node.attrs.pageId as string | null;
      const pages = host().pages;
      const strings = host().strings;
      const exists = !!pageId && !!pages?.exists(pageId);
      link.href = pageId ? `#/p/${pageId}` : '#';
      icon.textContent = (pageId && pages?.icon(pageId)) || '📄';
      title.textContent = exists
        ? pages!.title(pageId!) || (strings?.untitled ?? '')
        : (strings?.missingPage ?? '');
      dom.dataset.missing = String(!exists);
    };
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const pageId = node.attrs.pageId as string | null;
      if (pageId && host().pages?.exists(pageId)) host().pages?.open(pageId);
    });
    const unsubscribe = host().pages?.subscribe(draw);
    draw();
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        draw();
        return true;
      },
      ignoreMutation: () => true,
      destroy: () => unsubscribe?.(),
    };
  };
}

export const CODE_LANGUAGES = [
  'plaintext',
  'javascript',
  'typescript',
  'json',
  'html',
  'css',
  'csharp',
  'sql',
  'python',
  'rust',
  'bash',
  'powershell',
  'yaml',
  'xml',
  'markdown',
  'java',
  'go',
  'cpp',
];

export function codeBlockView(host: () => EditorHost): NodeViewRenderer {
  return ({ node: initial, getPos, editor }) => {
    let node = initial;
    const dom = el('div', 'cgw-code-wrap');
    const bar = el('div', 'cgw-code-bar');
    bar.contentEditable = 'false';
    const select = el('select', 'cgw-code-language');
    for (const language of CODE_LANGUAGES) {
      const option = el('option', undefined, language);
      option.value = language;
      select.append(option);
    }
    const wrap = el('button', 'cgw-code-tool');
    wrap.type = 'button';
    const copy = el('button', 'cgw-code-tool');
    copy.type = 'button';
    bar.append(select, wrap, copy);
    const pre = el('pre', 'cgw-body cgw-codeBlock');
    pre.dir = 'ltr';
    pre.dataset.body = 'codeBlock';
    const code = el('code');
    pre.append(code);
    dom.append(bar, pre);
    const draw = () => {
      const strings = host().strings;
      select.value = String(node.attrs.language ?? 'plaintext');
      if (!CODE_LANGUAGES.includes(select.value)) {
        const option = el('option', undefined, String(node.attrs.language));
        option.value = String(node.attrs.language);
        select.append(option);
        select.value = option.value;
      }
      select.disabled = !editor.isEditable;
      select.setAttribute('aria-label', strings?.codeLanguage ?? '');
      pre.dataset.wrap = String(Boolean(node.attrs.wrap));
      if (node.attrs.language) pre.dataset.language = String(node.attrs.language);
      wrap.textContent = '↩';
      wrap.setAttribute('aria-label', strings?.codeWrap ?? '');
      wrap.setAttribute('aria-pressed', String(Boolean(node.attrs.wrap)));
      wrap.hidden = !editor.isEditable;
      copy.textContent = '⧉';
      copy.setAttribute('aria-label', strings?.codeCopy ?? '');
    };
    select.addEventListener('change', () =>
      setAttrs(editor, getPos, node, {
        language: select.value === 'plaintext' ? null : select.value,
      }),
    );
    wrap.addEventListener('click', () =>
      setAttrs(editor, getPos, node, { wrap: !node.attrs.wrap }),
    );
    copy.addEventListener('click', () => void navigator.clipboard?.writeText(node.textContent));
    draw();
    return {
      dom,
      contentDOM: code,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        draw();
        return true;
      },
      stopEvent: (event) => bar.contains(event.target as Node),
      ignoreMutation: (mutation) => bar.contains(mutation.target as Node),
    };
  };
}
