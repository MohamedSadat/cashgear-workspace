// The browser page for spikes S5 and S6, driven by run-browser.mjs in Chrome and in WebView2.
// Everything is on window.spike so both browsers run the same steps.
import './page.css';
import { Editor, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import * as ids from '../vendor/y-tiptap-ids.js';
import { createSpikeEditor, CONTENT, type SpikeEditor } from './editor';
import { generateBlocks, rtlChecklistDoc, type Language } from './generate';
import { BlockHandle } from './handle';
import { schemaExtensions, type SchemaVariant } from './schema';
import { firstBody, listBlocks } from './commands';

const variant: SchemaVariant = { content: 'mixed', bodies: 'kind' };
const params = new URLSearchParams(location.search);
document.documentElement.dir = params.get('dir') ?? 'rtl';
document.documentElement.lang = document.documentElement.dir === 'rtl' ? 'ar' : 'en';

const probe = new Editor({ extensions: schemaExtensions(variant), injectCSS: false });
const schema = probe.schema;

/** The stored form of a document: one Yjs update, as the local store would hold it. */
function toUpdate(json: JSONContent): Uint8Array {
  const doc = new Y.Doc();
  ids.prosemirrorJSONToYXmlFragment(schema, json, doc.getXmlFragment(CONTENT));
  return Y.encodeStateAsUpdate(doc);
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const afterPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    }),
  );

let current: { doc: Y.Doc; spike: SpikeEditor; peer?: { doc: Y.Doc; spike: SpikeEditor } } | null =
  null;
const stored = new Map<string, Uint8Array>();
const host = document.getElementById('editor')!;
const peerHost = document.getElementById('peer')!;

// Keystroke to paint: from the keydown's timestamp to the frame after the change is drawn.
const keystrokes: number[] = [];
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key.length !== 1) return;
    const start = event.timeStamp;
    void afterPaint().then(() => keystrokes.push(performance.now() - start));
  },
  true,
);

function close() {
  plain?.destroy();
  plain = null;
  current?.spike.editor.destroy();
  current?.peer?.spike.editor.destroy();
  current?.doc.destroy();
  current = null;
  host.replaceChildren();
  peerHost.replaceChildren();
}

/** Which layers to load, to find what a keystroke costs (S6). */
export interface Layers {
  handle?: boolean;
  ids?: boolean;
  binding?: 'tiptap-ids' | 'tiptap';
}

let plain: Editor | null = null;

async function openBytes(bytes: Uint8Array, layers: Layers = {}): Promise<number> {
  close();
  const started = performance.now();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const spike = createSpikeEditor({
    doc,
    binding: layers.binding ?? 'tiptap-ids',
    schema: variant,
    element: host,
    extraExtensions: layers.handle === false ? [] : [BlockHandle],
    withoutIds: layers.ids === false,
  });
  current = { doc, spike };
  await frame();
  await afterPaint();
  return performance.now() - started;
}

const spike = {
  /** Opens a generated document of `count` blocks; returns ms from bytes to the painted page. */
  async open(count: number, language: Language, layers: Layers = {}) {
    const key = `${count}:${language}`;
    if (!stored.has(key)) stored.set(key, toUpdate(generateBlocks(count, language)));
    return openBytes(stored.get(key)!, layers);
  },
  /** The bare editor: schema only, no Yjs, no id plugin, no handle. */
  async openPlain(count: number, language: Language) {
    close();
    plain = new Editor({
      element: host,
      extensions: schemaExtensions(variant),
      content: generateBlocks(count, language),
      injectCSS: false,
    });
    await frame();
  },
  /** Average ms to dispatch and draw one typed character in the middle block, synchronously. */
  timeInserts(count: number) {
    const editor = plain ?? current!.spike.editor;
    const blocks = listBlocks(editor.state.doc);
    const body = firstBody(blocks[Math.floor(blocks.length / 2)])!;
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      const started = performance.now();
      editor.view.dispatch(editor.state.tr.insertText('x', body.pos + 1 + i));
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return { p50: times[Math.floor(count / 2)], p95: times[Math.floor(count * 0.95)] };
  },
  async openChecklist() {
    return openBytes(toUpdate(rtlChecklistDoc()));
  },
  /** A second editor on its own Yjs document, synced both ways, standing in for a peer. */
  connectPeer() {
    if (!current) throw new Error('nothing open');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(current.doc));
    const main = current.doc;
    main.on(
      'update',
      (u: Uint8Array, origin: unknown) => origin !== 'peer' && Y.applyUpdate(doc, u, 'main'),
    );
    doc.on(
      'update',
      (u: Uint8Array, origin: unknown) => origin !== 'main' && Y.applyUpdate(main, u, 'peer'),
    );
    const peer = createSpikeEditor({
      doc,
      binding: 'tiptap-ids',
      schema: variant,
      element: peerHost,
    });
    current.peer = { doc, spike: peer };
  },
  peerInsert(blockIndex: number, offset: number, text: string) {
    const editor = current!.peer!.spike.editor;
    const body = firstBody(listBlocks(editor.state.doc)[blockIndex])!;
    editor.view.dispatch(editor.state.tr.insertText(text, body.pos + 1 + offset));
  },
  /** Puts the caret in block `index`'s text at `offset`, and focuses the editor. */
  caret(index: number, offset: number) {
    const editor = current!.spike.editor;
    const body = firstBody(listBlocks(editor.state.doc)[index])!;
    editor.view.focus();
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 1 + offset)),
    );
  },
  /** The selection as offsets inside the block that holds its head, and the text around it. */
  selection() {
    const editor = current!.spike.editor;
    const { head, from, to } = editor.state.selection;
    const $head = editor.state.doc.resolve(head);
    const blocks = listBlocks(editor.state.doc);
    const index = blocks.findIndex(
      (b) => head > b.pos && head < b.pos + b.node.nodeSize && $head.parent.type.name !== 'block',
    );
    return {
      head,
      from,
      to,
      offset: $head.parentOffset,
      parentText: $head.parent.textContent,
      before: $head.parent.textContent.slice(0, $head.parentOffset).slice(-3),
      after: $head.parent.textContent.slice($head.parentOffset, $head.parentOffset + 3),
      block: index,
      selectedText: editor.state.doc.textBetween(from, to, '\n'),
      domSelection: getSelection()?.toString() ?? '',
    };
  },
  blockText(index: number) {
    return firstBody(listBlocks(current!.spike.editor.state.doc)[index])!.node.textContent;
  },
  yjsText() {
    return current!.doc.getXmlFragment(CONTENT).toJSON();
  },
  contentErrors() {
    return current!.spike.contentErrors.map((e) => e.message);
  },
  blockCount() {
    return listBlocks(current!.spike.editor.state.doc).length;
  },
  domNodes() {
    return host.getElementsByTagName('*').length;
  },
  keystrokes() {
    return keystrokes.splice(0);
  },
  /** Geometry of the n-th element matching a selector, for layout checks. */
  rect(selector: string, n = 0) {
    const element = host.querySelectorAll(selector)[n] as HTMLElement | undefined;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      direction: getComputedStyle(element).direction,
    };
  },
  close,
  /**
   * S7: hostile content arriving from Yjs, as a peer would send it, then hostile pasted HTML.
   * Reports what reached the DOM and whether any script ran. `unknownElement` adds a node type
   * the schema lacks (the binding then stops syncing: the worker must refuse such updates).
   */
  async hostile(unknownElement = false) {
    await openBytes(toUpdate(rtlChecklistDoc()), { handle: false });
    const flag = window as unknown as { __xss?: number[] };
    flag.__xss = [];
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(current!.doc));
    const content = peer.getXmlFragment(CONTENT);
    peer.transact(() => {
      const add = (body: Y.XmlElement) => {
        const block = new Y.XmlElement('block');
        block.setAttribute('id', 'h' + Math.random().toString(36).slice(2, 13));
        block.insert(0, [body]);
        content.push([block]);
      };
      for (const href of [
        'javascript:window.__xss.push(1)',
        '  JaVaScRiPt:window.__xss.push(2)',
        'data:text/html,<script>parent.__xss.push(3)</script>',
        'vbscript:msgbox(1)',
      ]) {
        const body = new Y.XmlElement('textBody');
        body.setAttribute('kind', 'paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'click me ' + href.slice(0, 12), { link: { href } });
        body.insert(0, [text]);
        add(body);
      }
      const image = new Y.XmlElement('image');
      image.setAttribute('assetId', '" onerror="window.__xss.push(4)');
      image.setAttribute('onerror', 'window.__xss.push(5)');
      image.setAttribute('src', 'javascript:window.__xss.push(6)');
      image.setAttribute('style', 'background:url(javascript:window.__xss.push(7))');
      add(image);
      const body = new Y.XmlElement('textBody');
      body.setAttribute('kind', 'paragraph');
      body.setAttribute('onclick', 'window.__xss.push(8)');
      body.insert(0, [new Y.XmlText('<img src=x onerror="window.__xss.push(9)">')]);
      add(body);
      if (unknownElement) {
        const script = new Y.XmlElement('script');
        script.insert(0, [new Y.XmlText('window.__xss.push(10)')]);
        add(script);
      }
    });
    Y.applyUpdate(
      current!.doc,
      Y.encodeStateAsUpdate(peer, Y.encodeStateVector(current!.doc)),
      'remote',
    );
    await afterPaint();
    // Pasted HTML goes through the schema's parser.
    const editor = current!.spike.editor;
    editor.commands.focus('end');
    editor.view.pasteHTML(
      '<p><a href="javascript:window.__xss.push(11)">pasted link</a></p>' +
        '<img src="x" onerror="window.__xss.push(12)">' +
        '<script>window.__xss.push(13)</script>' +
        '<div onclick="window.__xss.push(14)">pasted div</div>' +
        '<iframe src="javascript:window.__xss.push(15)"></iframe>',
    );
    await afterPaint();
    // Click every link, as a reader would.
    for (const link of host.querySelectorAll('a')) (link as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 300));
    const all = [...host.querySelectorAll('*')];
    return {
      scriptsRan: flag.__xss,
      unsafeLinks: all
        .filter((e) => e.tagName === 'A')
        .map((e) => e.getAttribute('href'))
        .filter((h) => h !== null && !/^(https?:|mailto:|tel:|#|\/)/i.test(h.trim())),
      eventAttributes: all
        .flatMap((e) => [...e.attributes].map((a) => a.name))
        .filter((n) => /^on/i.test(n)),
      dangerousElements: all
        .map((e) => e.tagName.toLowerCase())
        .filter((t) => ['script', 'iframe', 'object', 'embed', 'img'].includes(t)),
      styleWithScript: all.filter((e) => /javascript:/i.test(e.getAttribute('style') ?? '')).length,
      contentErrors: current!.spike.contentErrors.map((e) => e.message),
      textShown: host.textContent?.includes('<img src=x') ?? false,
    };
  },
};

Object.assign(window, { spike });
document.body.dataset.ready = 'true';
