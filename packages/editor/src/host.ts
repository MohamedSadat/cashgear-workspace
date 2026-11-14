// What the editor is given by the page around it. The editor never saves, loads or calls the
// network (ARCHITECTURE.md): files, titles, toggle state and navigation all come through here.

/** The editor's interface text, translated by the shell (its catalogue's `editor` section). */
export interface EditorStrings {
  placeholder: string;
  placeholderHeading: string;
  placeholderList: string;
  placeholderTodo: string;
  placeholderToggle: string;
  placeholderQuote: string;
  placeholderCallout: string;
  placeholderCode: string;
  emptyToggle: string;
  toggleOpen: string;
  toggleClose: string;
  checkItem: string;
  readOnlyBlock: string;
  untitled: string;
  missingPage: string;
  dragHandle: string;
  commandMenu: string;
  noCommands: string;
  /** The table of contents' accessible name, and what it says on a page with no headings. */
  tocLabel: string;
  tocEmpty: string;
  /** A database view's accessible name, and what it says when it cannot be drawn. */
  databaseView: string;
  databaseUnavailable: string;
  databaseNotChosen: string;
  databaseChoose: string;
  /**
   * A workbook block's accessible name; what it says with no workbook, with the buttons that
   * choose or make one, and when it cannot be drawn here.
   */
  sheetEmbed: string;
  sheetNotChosen: string;
  sheetChoose: string;
  sheetCreate: string;
  sheetUnavailable: string;
  /** An ERP view block's accessible name; what it says with no link, and when it cannot be drawn. */
  erpView: string;
  erpNotChosen: string;
  erpUnavailable: string;
  /** The "@" menu's groups and its date items; what a date with no valid value says. */
  mentionPages: string;
  mentionDates: string;
  dateToday: string;
  dateTomorrow: string;
  datePick: string;
  datePicker: string;
  dateInvalid: string;
  /**
   * Phase 6: what a mention of a person this page cannot name says after its `@`; the "@"
   * menu's group of people; "Comment" in the bubble toolbar and the block menu; a comment
   * marker's name. Read through `editorString`: a catalogue without them yet gets the English of
   * `EDITOR_STRING_DEFAULTS`.
   */
  someone: string;
  mentionPeople: string;
  comment: string;
  commentOpen: string;
  [key: string]: string;
}

/** English for the strings added in Phase 6, used while the host's catalogue lacks them. */
export const EDITOR_STRING_DEFAULTS = {
  someone: 'someone',
  mentionPeople: 'People',
  comment: 'Comment',
  commentOpen: 'Open the comment',
} as const;

/** One of the Phase 6 strings: the host's, else the English default. */
export function editorString(host: EditorHost, key: keyof typeof EDITOR_STRING_DEFAULTS): string {
  // A catalogue cast to these strings may still lack the Phase 6 keys.
  return (host.strings?.[key] as string | undefined) || EDITOR_STRING_DEFAULTS[key];
}

export interface AssetInfo {
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

export interface LinkPreview {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

export interface SlashItem {
  id: string;
  label: string;
  glyph: string;
  group?: string;
  shortcut?: string;
}

/** A person, as the "@" menu lists them (Phase 6): the workspace's members the reader may see. */
export interface PersonRef {
  id: string;
  name: string;
}

/**
 * Another session's cursor on this page (Phase 6, presence), as the host has it now: already
 * filtered (not this session, not stale), the name and colour from the workspace's members,
 * never from the message.
 */
export interface PresenceCursor {
  /** One per person and Yjs client: what tells two of the same person's cursors apart. */
  key: string;
  userId: string;
  name: string;
  /** A CSS colour: a theme token (`var(--cgw-presence-3)`, or `--cgw-presence-3`) or a value. */
  colour: string;
  /** The selection's ends, as `Y.encodeRelativePosition` in base64 (`relativePosition`). */
  anchor: string;
  head: string;
}

/**
 * Where a comment thread is (Phase 6, contracts section 3): the block, by id, and in it the
 * range's ends as Yjs relative positions (base64), or null for the whole block; the text it was
 * made on ("" for a whole block), the fallback when the positions no longer resolve.
 */
export interface CommentAnchor {
  blockId: string;
  start: string | null;
  end: string | null;
  quote: string;
}

/** A thread to draw: an open one, `active` for the one the comments panel has selected. */
export interface CommentThreadAnchor extends CommentAnchor {
  id: string;
  active: boolean;
}

/** How a thread was found in the page (`anchorsInOrder`), by the rule of contracts section 3. */
export type AnchorFound = 'range' | 'quote' | 'block' | 'missing';

/** Tells a node view when the editor is given another host (`setHost`); returns the unsubscribe. */
export type OnHostChange = (listener: () => void) => () => void;

/** What a database view block gives the host to draw into its frame (schema version 3). */
export interface DatabaseMountOptions {
  databaseId: string;
  /** Null: the database's first view. */
  viewId: string | null;
  /** The block holding the view, for anything the host keeps per block. */
  blockId: string | null;
  /** Whether the page is editable here; the database's own access is the host's to check. */
  editable: boolean;
  /**
   * Points the block at another of the database's views (a view picker in the frame), as an
   * ordinary edit of the page. Does nothing when the page is not editable.
   */
  setViewId(viewId: string | null): void;
}

/** A database and the view a new block shows: what creating or picking one gives. */
export interface DatabaseRef {
  databaseId: string;
  /** Null: the database's first view. */
  viewId: string | null;
}

/**
 * What a frame the host draws into gives back (schema version 4's blocks): `update` takes the
 * block's attributes when they change without anything that needs a new frame (a sheet's view,
 * an ERP view's fields), `destroy` removes what was drawn.
 */
export interface MountedFrame<Options> {
  update(options: Options): void;
  destroy(): void;
}

/** A sheet embed block's view (schema version 4): which part of the workbook it shows. */
export interface SheetBlockAttrs {
  /** Null: the first visible sheet. */
  sheet: string | null;
  /** A1 notation without a sheet; null: the used range, capped at 5,000 cells. */
  range: string | null;
  /** Shows this chart instead of a range when set. */
  chartId: string | null;
  /** The frame's most height in CSS pixels; null: the host's default. */
  height: number | null;
}

/** What a sheet embed block gives the host to draw into its frame. */
export interface SheetMountOptions extends SheetBlockAttrs {
  workbookId: string;
  /** The block holding the embed, for anything the host keeps per block. */
  blockId: string | null;
  /** Whether the page is editable here; the workbook's own access is the host's to check. */
  editable: boolean;
  /** Changes the block's view or height, as an ordinary edit; nothing when not editable. */
  setAttrs(attrs: Partial<SheetBlockAttrs>): void;
}

/** A workbook and the view a new block shows: what creating or picking one gives. */
export interface WorkbookRef extends Partial<SheetBlockAttrs> {
  workbookId: string;
}

/**
 * An ERP view block's settings (schema version 4). Never ERP data: which link and connector,
 * and what the person typed or picked. `filter`, `fields` and `sort` are JSON text
 * (`{search?, equals?}`, `string[]`, `{field, direction}[]`), null when unset.
 */
export interface ErpBlockAttrs {
  /** Workspace's `ErpLinks` id. */
  linkId: string | null;
  connectorId: string | null;
  filter: string | null;
  fields: string | null;
  sort: string | null;
  /** Rows a page; null: 50. */
  pageSize: number | null;
}

/** What an ERP view block gives the host to draw into its frame. */
export interface ErpMountOptions extends ErpBlockAttrs {
  blockId: string | null;
  editable: boolean;
  /** Changes the block's settings, as an ordinary edit; nothing when not editable. */
  setAttrs(attrs: Partial<ErpBlockAttrs>): void;
}

export interface EditorHost {
  strings?: EditorStrings;
  /** The interface language (BCP 47) dates are drawn in; else the document's `lang`. */
  locale?: string;
  /** Toggle open state, kept per device (DATA_MODEL.md), never in the document. */
  toggles?: {
    isOpen(blockId: string): boolean;
    flip(blockId: string): void;
    subscribe(listener: () => void): () => void;
  };
  /** Images and files: bytes are stored by the shell; the document keeps only the asset id. */
  assets?: {
    url(assetId: string): Promise<string | null>;
    info(assetId: string): AssetInfo | undefined;
    store(
      file: File,
    ): Promise<{ assetId: string; width: number | null; height: number | null } | null>;
    pick(accept: string[]): Promise<File[]>;
    open(assetId: string): void;
  };
  /** Pages, by id: titles resolved when drawn (D6). */
  pages?: {
    title(pageId: string): string | undefined;
    icon(pageId: string): string | null | undefined;
    exists(pageId: string): boolean;
    open(pageId: string, blockId?: string | null): void;
    create(): Promise<string | null>;
    search(query: string): { id: string; title: string; icon: string | null }[];
    subscribe(listener: () => void): () => void;
  };
  /**
   * Databases (schema version 3), drawn by the shell (`@cgw/database`) into a database view
   * block's frame. Each part is optional: without `mount` the block draws a placeholder. The
   * editor never deletes a database: removing the block only unmounts what was drawn.
   */
  databases?: {
    /**
     * Draws the view into `element` and returns what removes it again. Called when the block
     * comes near the viewport (and again after it went far away and came back), and again when
     * the block's database, view or editability changes; never per transaction.
     */
    mount?(element: HTMLElement, options: DatabaseMountOptions): () => void;
    /** Makes an inline database under this page with its first view ("Database"), or null. */
    create?(): Promise<DatabaseRef | null>;
    /** Asks which database (and view) to show ("Linked view"), or null when cancelled. */
    pick?(): Promise<DatabaseRef | null>;
  };
  /**
   * Workbooks (schema version 4), drawn by the shell into a sheet embed block's frame: the
   * picture, the live embed (`SheetEmbed`, sheet-embed.1), the view picker. Without `mount` the
   * block draws a placeholder. The editor never deletes a workbook: removing the block only
   * destroys what was drawn. `mount` is called when the block comes near the viewport (and
   * again after it went far away and came back) and when its workbook, block id or editability
   * changes; a change to its view or height goes to `update`.
   */
  workbooks?: {
    mount?(element: HTMLElement, options: SheetMountOptions): MountedFrame<SheetMountOptions>;
    /** Makes a new workbook in this workspace ("New workbook"), or null. */
    create?(): Promise<WorkbookRef | null>;
    /** Asks which workbook (and view) to show ("Existing workbook"), or null when cancelled. */
    pick?(): Promise<WorkbookRef | null>;
  };
  /**
   * ERP views (schema version 4), drawn by the shell (`@cgw/erp`) into an ERP view block's
   * frame, from the reader's own ERP session, in memory only. Without `mount` the block draws a
   * placeholder. Mounted and updated as `workbooks` are, by link, block id and editability.
   */
  erp?: {
    mount?(element: HTMLElement, options: ErpMountOptions): MountedFrame<ErpMountOptions>;
  };
  /** The slash menu reads the shell's command registry through this. */
  slash?: {
    list(query: string): SlashItem[];
    run(id: string): void | Promise<void>;
  };
  /** A block kind's name in the interface language (paragraph, heading1, bulletList, ...). */
  blockName?: (name: string) => string;
  /** How a shortcut is written in this interface (Ctrl+D, or a Mac's ⌘D). */
  shortcut?: (chord: string) => string;
  /** Copies a link to a block of this page. */
  copyBlockLink?: (blockId: string) => void;
  /**
   * A bookmark's preview, fetched by the server behind its SSRF guard (Q13), or null when there
   * is none (offline, local only, the page gave nothing). The image is an asset URL.
   */
  linkPreview?: (url: string) => Promise<LinkPreview | null>;
  openExternal?: (url: string) => void;
  onLinkRequest?: () => void;
  /**
   * People (Phase 6): a person's mention draws their name now (and again when `subscribe` says
   * the names changed, never per transaction); the "@" menu lists them first. Without it, a
   * mention reads `@` and "someone", and the menu lists pages and dates only.
   */
  people?: {
    /** The person's display name, or undefined when unknown. */
    name(userId: string): string | undefined;
    /** The "@" menu: people whose name or address starts with the query (folded), at most 8. */
    search(query: string): PersonRef[];
    subscribe(listener: () => void): () => void;
  };
  /**
   * Presence (Phase 6): the others' cursors, drawn as decorations (recomputed only when the host
   * says they changed or the document does), and this editor's selection told to the host.
   */
  presence?: {
    /** Others' cursors on this page now (already filtered: not this session, not stale). */
    cursors(): PresenceCursor[];
    subscribe(listener: () => void): () => void;
    /** This editor's selection as relative positions (base64), or null when it is not focused. Throttled by the host. */
    setLocal(cursor: { anchor: string; head: string } | null): void;
  };
  /**
   * Comments (Phase 6): the open threads, drawn as decorations over the text or block each is
   * anchored to (found by contracts section 3's rule), and "Comment" on the selection.
   */
  comments?: {
    /** The threads to draw: open ones, and `active` for the one the panel has selected. */
    threads(): CommentThreadAnchor[];
    subscribe(listener: () => void): () => void;
    /** "Comment" on the selection (bubble toolbar, block menu, Ctrl+Alt+M). Undefined: the person may not comment. */
    create?(anchor: CommentAnchor): void;
    /** A highlighted range (or its marker) was clicked or reached by keyboard. */
    open(threadId: string): void;
  };
}
