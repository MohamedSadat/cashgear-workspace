// SheetEmbed: Cash Gear Sheet's `/embed` in a sandboxed frame, spoken to by sheet-embed.1
// (docs/INTEGRATIONS.md, "Contract `sheet-embed.1`"). It draws the frame, runs the handshake,
// passes on what the embed says, and drops anything that fails validation or comes from
// elsewhere. It is given a source (a signed URL the shell fetched after the workbook's own check)
// and never calls the network, saves or logs: nothing of any message reaches a console.
import {
  SHEET_EMBED_CONTRACT,
  parseEmbedMessage,
  parseParentMessage,
  type SheetDirection,
  type SheetErrorCode,
  type SheetInitMessage,
  type SheetLoadedMessage,
  type SheetLocale,
  type SheetParentMessage,
  type SheetScale,
  type SheetSize,
  type SheetSource,
  type SheetTheme,
  type SheetView,
} from './contract';

export interface SheetEmbedOptions {
  /** The build's one Sheet origin (`https://sheet.cashgearerp.com`); the frame is its `/embed`. */
  sheetOrigin: string;
  source: SheetSource;
  view: SheetView;
  theme: SheetTheme;
  direction: SheetDirection;
  locale: SheetLocale;
  /** The frame's title, for screen readers. */
  title: string;
  /** How long to wait for `loaded`, or for a preview; 20 seconds when left out. */
  timeoutMs?: number;
}

/** What the embed drew (`loaded`, without its type). */
export type SheetLoaded = Omit<SheetLoadedMessage, 'type'>;

/** An `error` from the embed, or one of its codes for no answer in time. */
export interface SheetEmbedFailure {
  code: SheetErrorCode;
  /** For the log only: the embed's words, or a note of what happened here. */
  message: string;
}

export interface SheetEmbedEvents {
  loaded?(loaded: SheetLoaded): void;
  /** The view's natural size changed without a new `loaded`. */
  resize?(size: SheetSize): void;
  /** The embed answered `error`, spoke no contract in common, or did not answer in time. */
  error?(failure: SheetEmbedFailure): void;
  /** The person chose "Open in Cash Gear Sheet" inside the frame. */
  openRequested?(): void;
}

/**
 * `connecting` until the embed's `ready`; `loading` while a view or source is being drawn;
 * `loaded` once drawn; `error` after an `error` or a timeout; `destroyed` after `destroy`.
 */
export type SheetEmbedState = 'connecting' | 'loading' | 'loaded' | 'error' | 'destroyed';

export interface SheetPreviewRequest {
  /** CSS pixels, 16 to 4,096. */
  maxWidth: number;
  maxHeight: number;
  scale: SheetScale;
}

/** A picture of the view as drawn: `width` x `height` CSS pixels of PNG. */
export interface SheetPreview {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  etag: string;
  view: SheetView;
}

/** A preview that failed: the embed's `error` for it, no answer in time, or a destroyed embed. */
export class SheetEmbedError extends Error {
  readonly code: SheetErrorCode;
  constructor(code: SheetErrorCode, message: string) {
    super(message);
    this.name = 'SheetEmbedError';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

interface PendingPreview {
  resolve(preview: SheetPreview): void;
  reject(error: SheetEmbedError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** `https://host[:port]` or `http://…`, nothing after it; else a TypeError. */
function originOf(sheetOrigin: string): string {
  let url: URL;
  try {
    url = new URL(sheetOrigin);
  } catch {
    throw new TypeError('SheetEmbed: sheetOrigin is not an origin');
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !bare) {
    throw new TypeError('SheetEmbed: sheetOrigin is not an origin');
  }
  return url.origin;
}

/** The message, checked as the embed will check it; a TypeError for one that would be dropped. */
function checked<T extends SheetParentMessage>(message: T): T {
  if (!parseParentMessage(message)) {
    throw new TypeError(`SheetEmbed: not a valid sheet-embed.1 ${message.type}`);
  }
  return message;
}

/** A bytes source with a copy of its bytes, so transferring it leaves the caller's whole. */
const sendable = (source: SheetSource): SheetSource =>
  source.kind === 'bytes' ? { ...source, bytes: source.bytes.slice(0) } : source;

const transferOf = (source: SheetSource): Transferable[] =>
  source.kind === 'bytes' ? [source.bytes] : [];

export class SheetEmbed {
  /** The frame, for the host to size and style. */
  readonly frame: HTMLIFrameElement;
  readonly #origin: string;
  readonly #window: Window;
  readonly #events: SheetEmbedEvents;
  readonly #timeoutMs: number;
  #source: SheetSource;
  #view: SheetView;
  #theme: SheetTheme;
  #direction: SheetDirection;
  #locale: SheetLocale;
  #state: SheetEmbedState = 'connecting';
  #port: MessagePort | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #previews = new Map<string, PendingPreview>();
  #nextPreview = 1;
  /** `load` events of the frame so far: each new document fires one. */
  #loads = 0;
  /** Whether this document's `ready` was taken. */
  #readyTaken = false;
  /** A `ready` that came while one was taken: a new document's, if a `load` follows it. */
  #heldReady: string[] | null = null;

  constructor(container: HTMLElement, options: SheetEmbedOptions, events: SheetEmbedEvents = {}) {
    this.#origin = originOf(options.sheetOrigin);
    const win = container.ownerDocument.defaultView;
    if (!win) throw new TypeError('SheetEmbed: the container is not in a window');
    this.#window = win;
    this.#events = events;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#source = options.source;
    this.#view = options.view;
    this.#theme = options.theme;
    this.#direction = options.direction;
    this.#locale = options.locale;
    checked(this.#init());

    const frame = container.ownerDocument.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.title = options.title;
    frame.addEventListener('load', this.#onLoad);
    this.frame = frame;
    win.addEventListener('message', this.#onWindowMessage);
    frame.src = `${this.#origin}/embed`;
    container.append(frame);
    this.#startTimer();
  }

  get state(): SheetEmbedState {
    return this.#state;
  }

  /** Shows another view of the same workbook; answered by `loaded` or `error`. */
  setView(view: SheetView): void {
    if (this.#state === 'destroyed') return;
    checked({ type: 'setView', view });
    this.#view = view;
    this.#post({ type: 'setView', view }, true);
  }

  /** Draws again in another theme, direction or language; no answer. */
  setTheme(look: { theme: SheetTheme; direction: SheetDirection; locale: SheetLocale }): void {
    if (this.#state === 'destroyed') return;
    const message = checked({ type: 'setTheme', ...look });
    this.#theme = look.theme;
    this.#direction = look.direction;
    this.#locale = look.locale;
    this.#post(message, false);
  }

  /** Reads the source again (a fresh signed URL, say); the same ETag draws nothing new. */
  refresh(source: SheetSource): void {
    if (this.#state === 'destroyed') return;
    checked({ type: 'refresh', source });
    this.#source = source;
    this.#post({ type: 'refresh', source: sendable(source) }, true);
  }

  /** A PNG of the view as drawn, paired with its answer by id; rejects with `SheetEmbedError`. */
  requestPreview(request: SheetPreviewRequest): Promise<SheetPreview> {
    const id = `preview-${this.#nextPreview++}`;
    const message = checked({
      type: 'requestPreview',
      id,
      maxWidth: request.maxWidth,
      maxHeight: request.maxHeight,
      scale: request.scale,
    });
    const port = this.#port;
    if (this.#state === 'destroyed' || !port) {
      return Promise.reject(
        new SheetEmbedError('source.unavailable', 'The embed is not connected'),
      );
    }
    return new Promise<SheetPreview>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#previews.delete(id);
        reject(new SheetEmbedError('source.unavailable', 'No preview in time'));
      }, this.#timeoutMs);
      this.#previews.set(id, { resolve, reject, timer });
      port.postMessage(message);
    });
  }

  /** Closes the port and removes the frame; nothing is said or called after it. */
  destroy(): void {
    if (this.#state === 'destroyed') return;
    this.#state = 'destroyed';
    this.#clearTimer();
    this.#window.removeEventListener('message', this.#onWindowMessage);
    this.frame.removeEventListener('load', this.#onLoad);
    this.#closePort('The embed was destroyed');
    this.frame.remove();
  }

  #init(): SheetInitMessage {
    return {
      type: 'init',
      contract: SHEET_EMBED_CONTRACT,
      source: this.#source,
      view: this.#view,
      theme: this.#theme,
      direction: this.#direction,
      locale: this.#locale,
    };
  }

  /** Sends on the port, if the handshake is done (else `init` will carry the change). */
  #post(message: SheetParentMessage, answered: boolean): void {
    if (!this.#port) return;
    const transfer = 'source' in message ? transferOf(message.source) : [];
    this.#port.postMessage(message, transfer);
    if (answered) {
      this.#state = 'loading';
      this.#startTimer();
    }
  }

  readonly #onWindowMessage = (event: MessageEvent): void => {
    if (this.#state === 'destroyed') return;
    const frameWindow = this.frame.contentWindow;
    if (!frameWindow || event.source !== frameWindow || event.origin !== this.#origin) return;
    const message = parseEmbedMessage(event.data);
    if (message?.type !== 'ready') return;
    if (this.#readyTaken) {
      this.#heldReady = message.contracts;
      return;
    }
    this.#takeReady(message.contracts);
  };

  readonly #onLoad = (): void => {
    if (this.#state === 'destroyed') return;
    this.#loads++;
    const held = this.#heldReady;
    this.#heldReady = null;
    // The first document's own `load`; a `ready` held before it was a second one from it.
    if (this.#loads === 1) return;
    // A new document: the old one's port is gone. Its `ready` may have come before this event.
    this.#closePort('The embed reloaded');
    this.#readyTaken = false;
    this.#state = 'connecting';
    this.#startTimer();
    if (held) this.#takeReady(held);
  };

  #takeReady(contracts: string[]): void {
    this.#readyTaken = true;
    if (!contracts.includes(SHEET_EMBED_CONTRACT)) {
      this.#fail('contract.unsupported', 'No contract in common');
      return;
    }
    const target = this.frame.contentWindow;
    if (!target) return;
    const channel = new MessageChannel();
    this.#port = channel.port1;
    channel.port1.onmessage = this.#onPortMessage;
    const init: SheetInitMessage = { ...this.#init(), source: sendable(this.#source) };
    target.postMessage(init, this.#origin, [channel.port2, ...transferOf(init.source)]);
    this.#state = 'loading';
    this.#startTimer();
  }

  readonly #onPortMessage = (event: MessageEvent): void => {
    if (this.#state === 'destroyed') return;
    const message = parseEmbedMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'loaded': {
        this.#clearTimer();
        this.#state = 'loaded';
        this.#events.loaded?.({
          etag: message.etag,
          view: message.view,
          sheets: message.sheets,
          charts: message.charts,
          size: message.size,
          capped: message.capped,
        });
        return;
      }
      case 'resize':
        this.#events.resize?.(message.size);
        return;
      case 'preview': {
        const pending = this.#previews.get(message.id);
        if (!pending) return;
        this.#previews.delete(message.id);
        clearTimeout(pending.timer);
        const { bytes, width, height, etag, view } = message;
        pending.resolve({ bytes, width, height, etag, view });
        return;
      }
      case 'openRequested':
        this.#events.openRequested?.();
        return;
      case 'error': {
        if (message.id === undefined) {
          this.#fail(message.code, message.message);
          return;
        }
        const pending = this.#previews.get(message.id);
        if (!pending) return;
        this.#previews.delete(message.id);
        clearTimeout(pending.timer);
        pending.reject(new SheetEmbedError(message.code, message.message));
        return;
      }
      default:
        // `ready` comes only on the window.
        return;
    }
  };

  #fail(code: SheetErrorCode, message: string): void {
    this.#clearTimer();
    this.#state = 'error';
    this.#events.error?.({ code, message });
  }

  #startTimer(): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#state === 'connecting' || this.#state === 'loading') {
        this.#fail('source.unavailable', 'No answer in time');
      }
    }, this.#timeoutMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #closePort(reason: string): void {
    if (this.#port) {
      this.#port.onmessage = null;
      this.#port.close();
      this.#port = null;
    }
    for (const pending of this.#previews.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SheetEmbedError('source.unavailable', reason));
    }
    this.#previews.clear();
  }
}
