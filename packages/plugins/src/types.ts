// What a plugin block is (INTEGRATIONS.md, Plugin blocks): a definition, compiled into the app,
// that reads its props from the block, draws them into the block's frame, and writes them back
// only through its context. A definition never calls the network, never touches a store and never
// edits the document but by `setProps`; the data it shows comes through `PluginData`.
import type { DatabaseHost } from '@cgw/database';
import type { ComponentType } from 'react';

export interface Localized {
  readonly en: string;
  readonly ar: string;
}

export type Language = 'en' | 'ar';

/**
 * How a definition reads its props from the JSON object a block holds: every known prop checked
 * (a value it cannot use reads as that prop's default), never throwing. Unknown keys are not its
 * business: the frame keeps them and writes them back (`props.ts`).
 */
export interface PropSchema<Props> {
  read(raw: Readonly<Record<string, unknown>>): Props;
}

/** What `toPlainText` may look up. */
export interface PlainTextContext {
  readonly language: Language;
  /** A page's title (a database's), when the writer knows it. */
  pageTitle?(pageId: string): string | undefined;
}

/** Where a plugin's data comes from: the workspace's databases, through the shell's host. */
export interface PluginData {
  /** Null where there is nothing to read (a page shared by link, a local test without one). */
  readonly databases: DatabaseHost | null;
  /** Asks which database and view to show (the linked-view picker); null when cancelled. */
  pickDatabase?(): Promise<{ databaseId: string; viewId: string | null } | null>;
}

/** What a definition's view is drawn with. */
export interface PluginViewProps<Props> {
  readonly props: Props;
  /**
   * The person may change the block here: the page is editable, and this build's definition is
   * not older than the version that last wrote the block's props.
   */
  readonly editable: boolean;
  /** The block was written by a later version of this definition: drawn read-only, never written. */
  readonly newer: boolean;
  /**
   * Writes the props (merged over what the block held, so props this build does not know are
   * kept) as an ordinary, undoable edit of the page. Nothing when not editable.
   */
  setProps(next: Props): void;
  readonly data: PluginData;
  readonly blockId: string | null;
  readonly language: Language;
}

export interface BlockDefinition<Props extends object = object> {
  /** `cashgear.chart`, `cashgear.kanban`; a third party's would be `vendor.name`. */
  readonly type: string;
  /** The version of the props this definition writes; a block written by a later one is read-only. */
  readonly version: number;
  readonly props: PropSchema<Props>;
  readonly slash: {
    readonly label: Localized;
    /** A glyph for the menu (as the block actions' glyphs, until Track U8's icons). */
    readonly icon: string;
    /** Words it is found by, in both languages. */
    readonly keywords: readonly string[];
  };
  /** One line for copy and export (search writes nothing for a plugin block). */
  toPlainText(props: Props, context: PlainTextContext): string;
  /** Draws the block (loaded with the first block on screen). */
  readonly render: ComponentType<PluginViewProps<Props>>;
}

/** What a block's frame is given by the editor (`@cgw/editor`'s `PluginMountOptions`). */
export interface PluginFrameOptions {
  readonly type: string | null;
  readonly version: number | null;
  readonly props: string | null;
  readonly blockId: string | null;
  readonly editable: boolean;
  setProps(props: string, version: number): void;
}

/** What the frame gives back (`@cgw/editor`'s `MountedFrame`). */
export interface PluginFrame {
  update(options: PluginFrameOptions): void;
  destroy(): void;
}
