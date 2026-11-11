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
  [key: string]: string;
}

export interface AssetInfo {
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

export interface SlashItem {
  id: string;
  label: string;
  glyph: string;
  group?: string;
  shortcut?: string;
}

export interface EditorHost {
  strings?: EditorStrings;
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
  openExternal?: (url: string) => void;
  onLinkRequest?: () => void;
}
