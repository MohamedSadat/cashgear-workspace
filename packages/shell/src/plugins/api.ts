// Workspace's plugin routes (Phase 10, M10.5; the streams' brief, "Plugins: the server"): a
// workspace's plugins, a bundle added or updated (the zip as the body), one turned on or off or
// removed, and a frame ticket for a member. Owners and admins change; any member reads and asks
// for frames; the server decides. A refusal is a PluginRequestError with the server's code (and
// a refused bundle's `errors`); no answer at all is `offline`. Answers are read field by field
// with fallbacks (`pluginOf`), so a newer server's extra fields never break an older client.
import type { ApiClient } from '@cgw/api';
import type { Id } from '@cgw/workspace';
import type { BundleError, BundleErrorCode } from '@cgw/plugins/frame';

/** A workspace's plugin, as the server sends it (`WorkspacePlugin`). */
export interface WorkspacePlugin {
  id: Id;
  type: string;
  version: number;
  name: { en: string; ar: string };
  description: { en: string; ar: string } | null;
  reads: { rows: boolean };
  height: number;
  keywords: string[];
  enabled: boolean;
  sizeBytes: number;
  addedBy: { id: Id; name: string } | null;
  addedAt: string;
  updatedAt: string;
  /**
   * Phase 13: the hosts its manifest names and those approved (the ones it reaches); a host named and
   * not approved waits. Null when it names none (and from a server before 0.13.0).
   */
  network: { hosts: string[]; approved: string[] } | null;
}

/** A refusal: the status, the server's code, and a refused bundle's problems. */
export class PluginRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly errors: BundleError[] = [],
  ) {
    super(`${status} ${code}`);
    this.name = 'PluginRequestError';
  }
}

export interface PluginApi {
  list(workspaceId: Id): Promise<WorkspacePlugin[]>;
  /**
   * A new type (`created`), or a new bundle for a type already there; `approve`, the hosts of its
   * manifest the person was shown and allowed (Phase 13).
   */
  add(
    workspaceId: Id,
    zip: Uint8Array,
    approve?: readonly string[],
  ): Promise<{ plugin: WorkspacePlugin; created: boolean }>;
  setEnabled(workspaceId: Id, pluginId: Id, enabled: boolean): Promise<WorkspacePlugin>;
  /** Phase 13: the hosts of its manifest it may reach, all of them at once. */
  setApprovedHosts(
    workspaceId: Id,
    pluginId: Id,
    hosts: readonly string[],
  ): Promise<WorkspacePlugin>;
  remove(workspaceId: Id, pluginId: Id): Promise<void>;
  /** A frame's address (a ticket of 10 minutes on the plugins origin). */
  frame(workspaceId: Id, pluginId: Id): Promise<{ url: string; expiresAt: string }>;
}

type Answer = { data?: unknown; error?: unknown; response: Response };

const BUNDLE_CODES: readonly BundleErrorCode[] = [
  'manifest.missing',
  'manifest.invalid',
  'type.reserved',
  'host.reserved',
  'entry.missing',
  'file.type',
  'file.name',
  'bundle.tooLarge',
  'bundle.zip',
];

function bundleErrors(raw: unknown): BundleError[] {
  if (!Array.isArray(raw)) return [];
  const out: BundleError[] = [];
  for (const item of raw) {
    const { code, path } = (item ?? {}) as { code?: unknown; path?: unknown };
    if (typeof code !== 'string' || !(BUNDLE_CODES as readonly string[]).includes(code)) continue;
    out.push(
      typeof path === 'string'
        ? { code: code as BundleErrorCode, path: path.slice(0, 200) }
        : { code: code as BundleErrorCode },
    );
  }
  return out.slice(0, 50);
}

/** The answer's data, or a PluginRequestError; no answer at all is `offline`. */
async function data<T>(request: Promise<Answer>): Promise<{ value: T; status: number }> {
  let result: Answer;
  try {
    result = await request;
  } catch {
    throw new PluginRequestError(0, 'offline');
  }
  const { response } = result;
  if (response.ok) return { value: result.data as T, status: response.status };
  const body = (result.error ?? {}) as { code?: unknown; errors?: unknown };
  const code =
    typeof body.code === 'string'
      ? body.code
      : response.status === 413
        ? 'bundle.tooLarge'
        : response.status === 429
          ? 'limit.rate'
          : 'server.error';
  throw new PluginRequestError(response.status, code, bundleErrors(body.errors));
}

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const localized = (value: unknown): { en: string; ar: string } | null => {
  if (!value || typeof value !== 'object') return null;
  const { en, ar } = value as { en?: unknown; ar?: unknown };
  return { en: text(en), ar: text(ar, text(en)) };
};

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** A plugin's network as answered; null when it names no host. */
function networkOf(value: unknown): WorkspacePlugin['network'] {
  if (!value || typeof value !== 'object') return null;
  const { hosts, approved } = value as { hosts?: unknown; approved?: unknown };
  const named = texts(hosts);
  if (!named.length) return null;
  return { hosts: named, approved: texts(approved).filter((h) => named.includes(h)) };
}

/** A plugin from the server's answer, every field read with a fallback. */
export function pluginOf(dto: unknown): WorkspacePlugin {
  const d = (dto ?? {}) as Record<string, unknown>;
  const addedBy = d.addedBy as { id?: unknown; name?: unknown } | null | undefined;
  const reads = d.reads as { rows?: unknown } | null | undefined;
  return {
    id: text(d.id),
    type: text(d.type),
    version: Number(d.version ?? 1),
    name: localized(d.name) ?? { en: text(d.type), ar: text(d.type) },
    description: localized(d.description),
    reads: { rows: reads?.rows === true },
    height: Number(d.height ?? 240),
    keywords: Array.isArray(d.keywords)
      ? d.keywords.filter((k): k is string => typeof k === 'string')
      : [],
    enabled: d.enabled !== false,
    sizeBytes: Number(d.sizeBytes ?? 0),
    addedBy:
      addedBy && typeof addedBy.id === 'string'
        ? { id: addedBy.id, name: text(addedBy.name) }
        : null,
    addedAt: text(d.addedAt),
    updatedAt: text(d.updatedAt, text(d.addedAt)),
    network: networkOf(d.network),
  };
}

/** The plugin routes over the app's API client (the generated path types; answers read as above). */
export function pluginApi(api: ApiClient): PluginApi {
  const one = (workspaceId: Id, pluginId: Id) => ({ params: { path: { workspaceId, pluginId } } });
  return {
    list: async (workspaceId) => {
      const { value } = await data<{ plugins?: unknown[] }>(
        api.GET('/api/v1/workspaces/{workspaceId}/plugins', {
          params: { path: { workspaceId } },
        }) as Promise<Answer>,
      );
      return (value?.plugins ?? []).map(pluginOf);
    },
    add: async (workspaceId, zip, approve) => {
      const { value, status } = await data<unknown>(
        api.POST('/api/v1/workspaces/{workspaceId}/plugins', {
          params: {
            path: { workspaceId },
            query: approve?.length ? { approve: approve.join(',') } : {},
          },
          body: zip as never,
          bodySerializer: (body: unknown) => body as BodyInit,
          headers: { 'Content-Type': 'application/zip' },
        }) as Promise<Answer>,
      );
      return { plugin: pluginOf(value), created: status === 201 };
    },
    setEnabled: async (workspaceId, pluginId, enabled) =>
      pluginOf(
        (
          await data<unknown>(
            api.PATCH('/api/v1/workspaces/{workspaceId}/plugins/{pluginId}', {
              ...one(workspaceId, pluginId),
              body: { enabled },
            }) as Promise<Answer>,
          )
        ).value,
      ),
    setApprovedHosts: async (workspaceId, pluginId, hosts) =>
      pluginOf(
        (
          await data<unknown>(
            api.PATCH('/api/v1/workspaces/{workspaceId}/plugins/{pluginId}', {
              ...one(workspaceId, pluginId),
              body: { approvedHosts: [...hosts] },
            }) as Promise<Answer>,
          )
        ).value,
      ),
    remove: async (workspaceId, pluginId) => {
      await data<unknown>(
        api.DELETE(
          '/api/v1/workspaces/{workspaceId}/plugins/{pluginId}',
          one(workspaceId, pluginId),
        ) as Promise<Answer>,
      );
    },
    frame: async (workspaceId, pluginId) => {
      const { value } = await data<{ url?: unknown; expiresAt?: unknown }>(
        api.POST(
          '/api/v1/workspaces/{workspaceId}/plugins/{pluginId}/frames',
          one(workspaceId, pluginId),
        ) as Promise<Answer>,
      );
      if (typeof value?.url !== 'string') throw new PluginRequestError(200, 'server.error');
      return { url: value.url, expiresAt: text(value.expiresAt) };
    },
  };
}

/** A refusal's code; `offline` when there was no answer. */
export const pluginFailure = (error: unknown): string =>
  error instanceof PluginRequestError ? error.code : 'server.error';
