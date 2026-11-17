// A third-party block's props (`pluginBlock.props`, JSON text), split into what the plugin sees and
// what the host keeps for itself: every top-level key starting with `$` is the host's (`$view`, the
// database view the person chose with the linked-view picker), never sent to the frame and never
// written by it. A plugin's write is merged over what the block held, so the host's keys and any
// key the plugin did not send (a later version's, say) are kept.
import { parseProps } from '../props';
import { checkProps, isRowsId, type PluginProps } from './contract';

/** The view a block shows rows of (`$view`): a database and one of its views (null: its first). */
export interface ViewRef {
  databaseId: string;
  viewId: string | null;
}

/** The host's key for the view. */
export const VIEW_KEY = '$view';

export interface BlockProps {
  /** Every key the block held, as it held them. */
  raw: Record<string, unknown>;
  /**
   * What the plugin is shown: the keys without `$`, as `checkProps` takes them; an empty object
   * when they are not JSON data within the limits (`unsendable`).
   */
  shown: PluginProps;
  unsendable: boolean;
  view: ViewRef | null;
}

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The view a `$view` value names, or null. */
export function viewOf(value: unknown): ViewRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { databaseId, viewId } = value as Record<string, unknown>;
  if (!isRowsId(databaseId)) return null;
  if (viewId !== null && viewId !== undefined && !isRowsId(viewId)) return null;
  return { databaseId, viewId: (viewId as string | null | undefined) ?? null };
}

export function readBlockProps(text: string | null | undefined): BlockProps {
  const raw = parseProps(text);
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!key.startsWith('$')) define(own, key, value);
  const checked = checkProps(own);
  return {
    raw,
    shown: checked.ok ? checked.props : {},
    unsendable: !checked.ok,
    view: viewOf(raw[VIEW_KEY]),
  };
}

/** The text a plugin's write stores: what the block held, the plugin's keys over it. */
export function mergeProps(raw: Readonly<Record<string, unknown>>, next: PluginProps): string {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) define(merged, key, value);
  for (const [key, value] of Object.entries(next))
    if (!key.startsWith('$')) define(merged, key, value);
  return JSON.stringify(merged);
}

/** The text the picker stores: what the block held, with `$view` set (or removed for null). */
export function withView(raw: Readonly<Record<string, unknown>>, view: ViewRef | null): string {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (key !== VIEW_KEY) define(merged, key, value);
  if (view) define(merged, VIEW_KEY, { databaseId: view.databaseId, viewId: view.viewId });
  return JSON.stringify(merged);
}

/** JSON with every object's keys sorted: what two props are compared by. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
