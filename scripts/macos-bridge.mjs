// The client of the desktop app's test-only bridge (apps/desktop/src-tauri/src/bridge.rs, cargo
// feature e2e-bridge) and the page helpers the macOS acceptance run drives the app with
// (scripts/macos-acceptance.mjs). WKWebView has no debugging port for Playwright, so the run
// sends JSON lines to 127.0.0.1 instead: a function to run in the window, the window's title, quit.
//
// Typing goes the way the editor takes typed text from WebKit's own input: each character is
// inserted by the browser (`document.execCommand('insertText')`), which fires beforeinput and input
// and changes the DOM that ProseMirror reads back, as a key press does. Text boxes get the same
// insertion, so React sees their input events.
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

/** What only a test build's program holds: the bridge's setting, its file and its command. */
export const BRIDGE_MARKERS = ['CGW_E2E_BRIDGE_PORT', 'cgw-e2e-settings.json', 'e2e_bridge_reply'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new token for the bridge (it takes 32 characters or more). */
export const newToken = () => randomBytes(24).toString('hex');

/** Specs go as JSON: a RegExp in one becomes { source, flags }. */
function plain(value) {
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

/**
 * What the page helpers run on, sent with each call (the page's CSP has no 'unsafe-eval', so the
 * page cannot keep code sent to it as text). A spec is a CSS selector, or an object:
 * { css | role | label | testId, name?, text?, visible? }, where name and text are a string to
 * match exactly or { source, flags }.
 */
function pageLib() {
  const words = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const matches = (value, want) =>
    want === undefined || want === null
      ? true
      : typeof want === 'string'
        ? value === want
        : new RegExp(want.source, want.flags).test(value);
  // What a person reads: a text box's value, else the text. (A button has a value too, "".)
  const shown = (el) =>
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
      ? el.value
      : el.textContent;
  const visible = (el) =>
    !!el &&
    el.isConnected &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' &&
    !el.closest('[aria-hidden="true"], [inert]');
  const name = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy)
      return words(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
    return words(
      el.getAttribute('aria-label') ||
        (el.labels?.[0]?.textContent ?? '') ||
        el.textContent ||
        el.getAttribute('title') ||
        el.getAttribute('value') ||
        '',
    );
  };
  const roles = {
    button: 'button, [role="button"], input[type="submit"], input[type="button"]',
    treeitem: '[role="treeitem"]',
    heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
    menuitem: '[role="menuitem"]',
    radio: 'input[type="radio"], [role="radio"]',
    textbox: 'input:not([type]), input[type="text"], input[type="email"], textarea',
  };
  const byLabel = (label) =>
    [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')].filter(
      (el) => matches(name(el), label),
    );
  function all(spec) {
    if (typeof spec === 'string') spec = { css: spec };
    let found = spec.css
      ? [...document.querySelectorAll(spec.css)]
      : spec.role
        ? [...document.querySelectorAll(roles[spec.role] ?? `[role="${spec.role}"]`)]
        : spec.testId
          ? [...document.querySelectorAll(`[data-testid="${spec.testId}"]`)]
          : spec.label
            ? byLabel(spec.label)
            : [];
    if (spec.name !== undefined) found = found.filter((el) => matches(name(el), spec.name));
    if (spec.text !== undefined) found = found.filter((el) => matches(words(shown(el)), spec.text));
    if (spec.visible !== false) found = found.filter(visible);
    return found;
  }
  function one(spec) {
    const [el] = all(spec);
    if (!el) throw new Error('Nothing on the page matches ' + JSON.stringify(spec));
    return el;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    all,
    one,
    name,
    words,
    shown,
    describe: (el) =>
      el
        ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`
        : 'nothing',
    /** Clicks an element (a button, a tree item), after scrolling it into view. */
    click(spec) {
      const el = one(spec);
      el.scrollIntoView({ block: 'center' });
      el.click();
      return name(el);
    },
    /** Replaces a text box's value with the text, inserted as typing does. */
    async fill(spec, text) {
      const el = one(spec);
      el.focus();
      el.select?.();
      document.execCommand('selectAll');
      if (text) document.execCommand('insertText', false, text);
      else document.execCommand('delete');
      await settle();
      if (el.value !== text) {
        // A last resort for a box that ignored the insertion: the value as React reads it.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        setter?.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return el.value;
    },
    /** Types into whatever has focus, a character at a time. */
    async type(text, delayMs = 10) {
      const target = document.activeElement;
      if (!target || target === document.body) throw new Error('Nothing has focus to type into');
      for (const character of text) {
        if (character === '\n') {
          // The editor handles Enter on keydown; anything that does not gets a paragraph.
          const init = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          };
          const down = new KeyboardEvent('keydown', init);
          target.dispatchEvent(down);
          if (!down.defaultPrevented) document.execCommand('insertParagraph');
          target.dispatchEvent(new KeyboardEvent('keyup', init));
        } else if (!document.execCommand('insertText', false, character)) {
          throw new Error('The browser did not insert the text');
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return this.describe(document.activeElement);
    },
    /** Sends a key to whatever has focus (React and ProseMirror read keydown). */
    press(key) {
      const target = document.activeElement ?? document.body;
      const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
      const down = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
      target.dispatchEvent(down);
      target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true }));
      return down.defaultPrevented;
    },
    /** Puts the caret at the end of an editable element's last text. */
    caretAtEnd(spec) {
      const el = one(spec);
      el.focus();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last = null;
      while (walker.nextNode()) if (walker.currentNode.textContent) last = walker.currentNode;
      const range = document.createRange();
      if (last) range.setStart(last, last.length);
      else range.selectNodeContents(el);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return this.describe(document.activeElement);
    },
  };
}
const LIB = pageLib.toString();

/** One connection to the app's bridge. */
export class Bridge {
  #socket;
  #token;
  #next = 0;
  #pending = new Map();
  #closed = null;

  constructor(socket, token) {
    this.#socket = socket;
    this.#token = token;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let answer;
        try {
          answer = JSON.parse(line);
        } catch {
          continue;
        }
        const waiting = this.#pending.get(answer.id);
        if (!waiting) continue;
        this.#pending.delete(answer.id);
        if (answer.ok) waiting.resolve(answer.value);
        else waiting.reject(new Error(answer.error));
      }
    });
    const fail = (error) => {
      this.#closed = error ?? new Error('The bridge closed the connection');
      for (const waiting of this.#pending.values()) waiting.reject(this.#closed);
      this.#pending.clear();
    };
    socket.on('error', fail);
    socket.on('close', () => fail());
  }

  /** Connects once the app listens; gives up after timeoutMs. */
  static async connect(port, token, { timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket));
          socket.once('error', reject);
        });
        return new Bridge(socket, token);
      } catch (error) {
        if (Date.now() > deadline)
          throw new Error(`The app's bridge did not listen on 127.0.0.1:${port}`, {
            cause: error,
          });
        await sleep(250);
      }
    }
  }

  get closed() {
    return this.#closed !== null;
  }

  request(command, waitMs = 35_000) {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`No answer to ${command.cmd} in ${waitMs} ms`));
      }, waitMs);
      this.#pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.#socket.write(JSON.stringify({ id, token: this.#token, ...command }) + '\n');
    });
  }

  /** Runs fn(...args) in the window and returns its result (JSON). */
  evaluate(fn, ...args) {
    return this.evaluateFor(30_000, fn, ...args);
  }

  evaluateFor(timeoutMs, fn, ...args) {
    const script = typeof fn === 'function' ? fn.toString() : fn;
    return this.request({ cmd: 'eval', script, args: plain(args), timeoutMs }, timeoutMs + 5000);
  }

  /** Runs fn(lib, ...args) in the window, with the page helpers above as lib. */
  page(fn, ...args) {
    return this.pageFor(30_000, fn, ...args);
  }

  pageFor(timeoutMs, fn, ...args) {
    const script = `async (...args) => (${fn.toString()}\n)((${LIB}\n)(), ...args)`;
    return this.evaluateFor(timeoutMs, script, ...args);
  }

  title() {
    return this.request({ cmd: 'title' });
  }

  /** Asks the app to close its window as the close button does. */
  quit() {
    return this.request({ cmd: 'quit' });
  }

  /** Has the app do what an item of its menu does (only `quit`, ⌘Q's item). */
  menu(item) {
    return this.request({ cmd: 'menu', item });
  }

  close() {
    this.#socket.destroy();
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers in the manner of Playwright's, polling the page.

  /** Waits until fn(lib, ...args), run in the page, gives something truthy. */
  async until(what, fn, args = [], { timeoutMs = 30_000, everyMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        // A page that is still loading never answers: each try waits a little only.
        const value = await this.pageFor(5000, fn, ...args);
        if (value) return value;
        last = value;
      } catch (error) {
        if (this.closed) throw error;
        last = error.message;
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out after ${timeoutMs} ms: ${what} (last: ${JSON.stringify(last)})`);
      await sleep(everyMs);
    }
  }

  /** Waits for an element to be on the page and visible; returns its text. */
  waitFor(spec, options) {
    return this.until(
      `${JSON.stringify(plain(spec))} to show`,
      (lib, spec) => {
        const [el] = lib.all(spec);
        return el ? lib.words(lib.shown(el)) || true : false;
      },
      [spec],
      options,
    );
  }

  /** Waits for an element's text (or a text box's value) to match. */
  waitForText(spec, want, options) {
    return this.until(
      `${JSON.stringify(plain(spec))} to read ${want}`,
      (lib, spec, want) =>
        lib.all({ ...(typeof spec === 'string' ? { css: spec } : spec), text: want }).length > 0,
      [spec, want],
      options,
    );
  }

  text(spec) {
    return this.page((lib, spec) => {
      const el = lib.one(spec);
      return lib.words(lib.shown(el));
    }, spec);
  }

  click(spec) {
    return this.page((lib, spec) => lib.click(spec), spec);
  }

  fill(spec, text) {
    return this.page((lib, spec, text) => lib.fill(spec, text), spec, text);
  }

  type(text, delayMs = 10) {
    return this.evaluateFor(
      Math.max(30_000, text.length * (delayMs + 50)),
      `async (...args) => ((lib, text, delay) => lib.type(text, delay)\n)((${LIB}\n)(), ...args)`,
      text,
      delayMs,
    );
  }

  press(key) {
    return this.page((lib, key) => lib.press(key), key);
  }

  caretAtEnd(spec) {
    return this.page((lib, spec) => lib.caretAtEnd(spec), spec);
  }

  /** The window's hash route. */
  hash() {
    return this.evaluate(() => location.hash);
  }

  /** A command of the app, as the page's platform layer calls it. */
  invoke(command, args = {}, timeoutMs = 30_000) {
    return this.evaluateFor(
      timeoutMs,
      (command, args) => window.__TAURI_INTERNALS__.invoke(command, args),
      command,
      args,
    );
  }
}
