// The account's passkeys (Phase 11, M11.2), for Settings → Account: the list, rename and remove
// over the API's JSON routes, and the API's own page where a passkey is added (every ceremony
// runs on the API's pages, never in the app). A module of its own that Settings loads, so the
// app's start holds none of it. A refusal is a SyncHttpError with the server's code.
import type { ApiClient } from '@cgw/api';
import { SyncHttpError } from '@cgw/workspace';
import type { Language } from '../i18n';
import type { Cloud } from './cloud';

/** A passkey as the server lists it; `id` is its credential id (base64url). */
export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The most an account may have (the server's rule; it refuses a 21st). */
export const PASSKEY_LIMIT = 20;

/** What Settings → Account → Passkeys needs (a fake in tests). */
export interface PasskeysHost {
  list(): Promise<Passkey[]>;
  rename(id: string, name: string): Promise<Passkey>;
  remove(id: string): Promise<void>;
  /**
   * Opens the API's page that adds one: `left` when this tab went there (it comes back to
   * Settings, which reads the list again), `browser` when the system browser did (the desktop).
   */
  add(language: Language): Promise<'left' | 'browser'>;
}

type Answer<T> = { data?: T; error?: unknown; response: Response };

async function data<T>(request: Promise<Answer<T>>): Promise<T> {
  const result = await request;
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string; title?: string } | undefined;
  throw new SyncHttpError(
    result.response.status,
    body?.code ?? 'server.error',
    body?.title ?? result.response.statusText,
  );
}

const passkeyOf = (dto: Passkey): Passkey => ({
  id: dto.id,
  name: dto.name,
  createdAt: dto.createdAt,
  lastUsedAt: dto.lastUsedAt ?? null,
});

/**
 * The API's page that adds a passkey (`/account/passkeys/new`), in the interface language, coming
 * back to `back` (an address of this app, which the server checks against its allowed origins)
 * when one is given; without it the page ends by saying the passkey is added.
 */
export const passkeyPageUrl = (apiBase: string, language: Language, back?: string) =>
  `${apiBase}/account/passkeys/new?lang=${language}${back ? `&return=${encodeURIComponent(back)}` : ''}`;

/**
 * The routes over the app's API client. In a browser "Add a passkey" goes to the API's page in
 * this tab, back to this app's Settings; on the desktop it opens in the system browser (where the
 * desktop's sign-in runs too), with no address to come back to.
 */
export function passkeysHost(
  cloud: Pick<Cloud, 'api' | 'platform'>,
  assign: (url: string) => void = (url) => location.assign(url),
): PasskeysHost {
  const api: ApiClient = cloud.api;
  const path = (id: string) => ({ params: { path: { id } } });
  return {
    list: async () => (await data(api.GET('/api/v1/account/passkeys'))).passkeys.map(passkeyOf),
    rename: async (id, name) =>
      passkeyOf(
        await data(api.PATCH('/api/v1/account/passkeys/{id}', { ...path(id), body: { name } })),
      ),
    remove: async (id) => {
      await data(api.DELETE('/api/v1/account/passkeys/{id}', path(id)));
    },
    add: async (language) => {
      if (cloud.platform.kind === 'web') {
        assign(
          passkeyPageUrl(api.baseUrl, language, `${location.origin}${location.pathname}#/settings`),
        );
        return 'left';
      }
      await cloud.platform.openExternal(passkeyPageUrl(api.baseUrl, language));
      return 'browser';
    },
  };
}
