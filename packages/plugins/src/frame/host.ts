// PluginFrameHost: a third-party plugin's bundle in a sandboxed frame, spoken to by
// `plugin-frame.1` (Phase 10, M10.4). It draws the frame from an address the shell asked the
// server for (a frame ticket on the plugins origin), runs the handshake, passes on what the
// plugin asks, and drops anything that fails validation or comes from elsewhere. The frame gets
// `sandbox="allow-scripts"` and nothing else: an opaque origin, no pop-ups, no top navigation, no
// forms; the bundle's own CSP gives it no network. A second `load` (it navigated itself) ends it.
// Never calls the network, saves or logs: nothing of any message reaches a console.
import {
  PLUGIN_FRAME_CONTRACT,
  checkProps,
  frameHeight,
  parseHostMessage,
  parsePluginMessage,
  type HostMessage,
  type InitMessage,
  type PluginBlockState,
  type PluginDirection,
  type PluginLanguage,
  type PluginProps,
  type PluginRef,
  type PluginTheme,
  type RefusedCode,
  type Rows,
} from './contract';
import { canonicalJson } from './props';

export interface PluginLook {
  theme: PluginTheme;
  direction: PluginDirection;
  language: PluginLanguage;
}

export interface PluginFrameHostOptions {
  /** The build's one plugins origin (`https://plugins.cashgearerp.com`). */
  pluginsOrigin: string;
  /** The frame's address, from the frames route: on the plugins origin, or a TypeError. */
  url: string;
  /** The frame's title, for screen readers: it names the plugin. */
  title: string;
  plugin: PluginRef;
  block: PluginBlockState;
  props: PluginProps;
  look: PluginLook;
  rows: Rows | null;
  /** The frame's first height, CSS px (the manifest's). */
  height: number;
  /** How long to wait for `ready`; 20 seconds when left out. */
  timeoutMs?: number;
}

/**
 * Why a frame stopped: it navigated itself (a second `load`), said nothing in time, or speaks no
 * contract this build does.
 */
export type PluginFrameStop = 'navigated' | 'timeout' | 'contract';

export interface PluginFrameEvents {
  /** The plugin's props, checked: write them as one undoable edit, or say why not. */
  setProps?(props: PluginProps): 'saved' | RefusedCode;
  /** The frame was made this tall (48 to 1,200 CSS px). */
  resize?(height: number): void;
  /** The plugin said it cannot draw; only its code (its message is for no one here). */
  error?(code: string): void;
  /** The frame is gone, and why. */
  stopped?(why: PluginFrameStop): void;
  /** The handshake is done: the plugin has its port and `init`. */
  connected?(): void;
}

export type PluginFrameState = 'connecting' | 'connected' | 'stopped' | 'destroyed';

const DEFAULT_TIMEOUT_MS = 20_000;
/** A plugin's writes of its props: one each this many milliseconds at most. */
export const WRITE_INTERVAL_MS = 250;
const LOCAL = new Set(['127.0.0.1', 'localhost']);

/** `https://host[:port]`, or `http://` on 127.0.0.1 or localhost, nothing after it; else a TypeError. */
export function pluginsOriginOf(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError('PluginFrameHost: pluginsOrigin is not an origin');
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL.has(url.hostname));
  if (!secure || !bare) throw new TypeError('PluginFrameHost: pluginsOrigin is not an origin');
  return url.origin;
}

/** Whether a frame address is on the plugins origin (and carries no user name or password). */
export function isFrameUrl(url: string, pluginsOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.origin === pluginsOriginOf(pluginsOrigin) &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname.startsWith('/f/')
  );
}

/** The message, checked as the plugin will check it; a TypeError for one that would be dropped. */
function checked<T extends HostMessage>(message: T): T {
  if (!parseHostMessage(message)) {
    throw new TypeError(`PluginFrameHost: not a valid plugin-frame.1 ${message.type}`);
  }
  return message;
}

export class PluginFrameHost {
  /** The frame, for the host to place and style. */
  readonly frame: HTMLIFrameElement;
  readonly #window: Window;
  readonly #events: PluginFrameEvents;
  readonly #plugin: PluginRef;
  #block: PluginBlockState;
  #props: PluginProps;
  /** The props the plugin knows now (canonical JSON): what it was sent or wrote itself. */
  #known: string;
  #look: PluginLook;
  #rows: Rows | null;
  #state: PluginFrameState = 'connecting';
  #port: MessagePort | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** `load` events of the frame so far: each new document fires one. */
  #loads = 0;
  /** Whether this document's `ready` was taken. */
  #readyTaken = false;
  /** A write held until the interval since the last one has passed, and how many it answers. */
  #pending: PluginProps | null = null;
  #pendingAnswers = 0;
  #lastWrite = -Infinity;
  #writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    container: HTMLElement,
    options: PluginFrameHostOptions,
    events: PluginFrameEvents = {},
  ) {
    if (!isFrameUrl(options.url, options.pluginsOrigin)) {
      throw new TypeError('PluginFrameHost: the frame is not on the plugins origin');
    }
    const win = container.ownerDocument.defaultView;
    if (!win) throw new TypeError('PluginFrameHost: the container is not in a window');
    this.#window = win;
    this.#events = events;
    this.#plugin = { type: options.plugin.type, version: options.plugin.version };
    this.#block = { ...options.block };
    this.#props = options.props;
    this.#known = canonicalJson(options.props);
    this.#look = { ...options.look };
    this.#rows = options.rows;
    checked(this.#init());

    const frame = container.ownerDocument.createElement('iframe');
    // Scripts only: an opaque origin, no pop-ups, no top navigation, no forms, no downloads.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.title = options.title;
    frame.style.blockSize = `${frameHeight(options.height)}px`;
    frame.addEventListener('load', this.#onLoad);
    this.frame = frame;
    win.addEventListener('message', this.#onWindowMessage);
    frame.src = options.url;
    container.append(frame);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#state === 'connecting') this.#stop('timeout');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  get state(): PluginFrameState {
    return this.#state;
  }

  /** The block's props changed elsewhere (Undo, a collaborator): sent when the plugin does not know them. */
  setProps(props: PluginProps): void {
    if (this.#done()) return;
    const text = canonicalJson(props);
    this.#props = props;
    if (text === this.#known) return;
    if (!this.#port) return;
    this.#known = text;
    this.#post(checked({ type: 'props', props }));
  }

  /** Another theme, direction or language. */
  setLook(look: PluginLook): void {
    if (this.#done()) return;
    const same =
      look.theme === this.#look.theme &&
      look.direction === this.#look.direction &&
      look.language === this.#look.language;
    this.#look = { ...look };
    if (!same) this.#post(checked({ type: 'theme', ...look }));
  }

  /** Whether the reader may change the block now, and whether a later version wrote it. */
  setBlock(block: PluginBlockState): void {
    if (this.#done()) return;
    const same = block.editable === this.#block.editable && block.newer === this.#block.newer;
    this.#block = { ...block };
    if (!same)
      this.#post(checked({ type: 'editable', editable: block.editable, newer: block.newer }));
  }

  /** The view's rows changed, or the block names none or the database went away (null). */
  setRows(rows: Rows | null): void {
    if (this.#done()) return;
    if (rows === this.#rows || JSON.stringify(rows) === JSON.stringify(this.#rows)) return;
    this.#rows = rows;
    this.#post(checked({ type: 'rows', rows }));
  }

  /** Closes the port and removes the frame; nothing is said or called after it. */
  destroy(): void {
    if (this.#state === 'destroyed') return;
    this.#state = 'destroyed';
    this.#end();
  }

  #done(): boolean {
    return this.#state === 'destroyed' || this.#state === 'stopped';
  }

  #init(): InitMessage {
    return {
      type: 'init',
      contract: PLUGIN_FRAME_CONTRACT,
      plugin: this.#plugin,
      block: this.#block,
      props: this.#props,
      theme: this.#look.theme,
      direction: this.#look.direction,
      language: this.#look.language,
      rows: this.#rows,
    };
  }

  /** Sends on the port, once the handshake is done (else `init` carries the change). */
  #post(message: HostMessage): void {
    this.#port?.postMessage(message);
  }

  readonly #onWindowMessage = (event: MessageEvent): void => {
    if (this.#state !== 'connecting' || this.#readyTaken) return;
    const frameWindow = this.frame.contentWindow;
    // A sandboxed frame's origin is opaque: its messages say "null".
    if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return;
    const message = parsePluginMessage(event.data);
    if (message?.type !== 'ready') return;
    this.#readyTaken = true;
    if (!message.contracts.includes(PLUGIN_FRAME_CONTRACT)) {
      this.#stop('contract');
      return;
    }
    const channel = new MessageChannel();
    this.#port = channel.port1;
    channel.port1.onmessage = this.#onPortMessage;
    const init = checked(this.#init());
    this.#known = canonicalJson(init.props);
    // The frame's origin is opaque, so the target is "*"; the port carries everything after.
    frameWindow.postMessage(init, '*', [channel.port2]);
    this.#state = 'connected';
    this.#clearTimer();
    this.#events.connected?.();
  };

  readonly #onLoad = (): void => {
    if (this.#done()) return;
    this.#loads++;
    // The first document's own `load`; a second is a document the frame navigated to.
    if (this.#loads > 1) this.#stop('navigated');
  };

  readonly #onPortMessage = (event: MessageEvent): void => {
    if (this.#state !== 'connected') return;
    const message = parsePluginMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'resize': {
        const height = frameHeight(message.height);
        this.frame.style.blockSize = `${height}px`;
        this.#events.resize?.(height);
        return;
      }
      case 'setProps': {
        if (!this.#block.editable || this.#block.newer) {
          this.#post({ type: 'refused', code: 'props.readOnly' });
          return;
        }
        const props = checkProps(message.props);
        if (!props.ok) {
          this.#post({ type: 'refused', code: props.code });
          return;
        }
        // At most one write each `WRITE_INTERVAL_MS`: writes in between are held, the latest
        // replacing the others, and each is answered when it is written.
        this.#pending = props.props;
        this.#pendingAnswers++;
        const wait = this.#lastWrite + WRITE_INTERVAL_MS - Date.now();
        if (wait <= 0) this.#write();
        else this.#writeTimer ??= setTimeout(() => this.#write(), wait);
        return;
      }
      case 'error':
        this.#events.error?.(message.code);
        return;
      default:
        // `ready` comes only on the window.
        return;
    }
  };

  /** Writes the held props and answers every `setProps` they stand for. */
  #write(): void {
    this.#writeTimer = null;
    const props = this.#pending;
    const answers = this.#pendingAnswers;
    this.#pending = null;
    this.#pendingAnswers = 0;
    if (!props || this.#state !== 'connected') return;
    this.#lastWrite = Date.now();
    let answer: 'saved' | RefusedCode = 'props.readOnly';
    if (this.#block.editable && !this.#block.newer) {
      const known = this.#known;
      this.#known = canonicalJson(props);
      answer = this.#events.setProps?.(props) ?? 'props.readOnly';
      if (answer !== 'saved') this.#known = known;
    }
    for (let i = 0; i < answers && this.#state === 'connected'; i++)
      this.#post(answer === 'saved' ? { type: 'saved' } : { type: 'refused', code: answer });
  }

  #stop(why: Parameters<NonNullable<PluginFrameEvents['stopped']>>[0]): void {
    if (this.#done()) return;
    this.#state = 'stopped';
    this.#end();
    this.#events.stopped?.(why);
  }

  #end(): void {
    this.#clearTimer();
    if (this.#writeTimer !== null) clearTimeout(this.#writeTimer);
    this.#writeTimer = null;
    this.#pending = null;
    this.#pendingAnswers = 0;
    this.#window.removeEventListener('message', this.#onWindowMessage);
    this.frame.removeEventListener('load', this.#onLoad);
    if (this.#port) {
      this.#port.onmessage = null;
      this.#port.close();
      this.#port = null;
    }
    this.frame.remove();
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
