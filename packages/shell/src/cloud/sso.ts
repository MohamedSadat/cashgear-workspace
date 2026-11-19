// Single sign-on (Phase 11, M11.3) for Settings: a workspace's own OpenID Connect provider and the
// domains it signs in, over the owners' routes (`/workspaces/{id}/sso`), and the account's
// password for Settings → Account (whether it has one, and the reset mail that sets one). A module
// of its own that only Settings imports, so the app's start holds none of it. A refusal is a
// SyncHttpError with the server's code; the server decides every request (owners only).
import type { ApiClient } from '@cgw/api';
import { SyncHttpError, type Id } from '@cgw/workspace';
import type { Language } from '../i18n';
import type { Cloud } from './cloud';

/** The TXT record that proves a domain: its name and the value to put there. */
export interface SsoRecord {
  name: string;
  value: string;
}

export interface SsoDomain {
  /** As the server keeps it: lower case, an international name as punycode. */
  domain: string;
  record: SsoRecord;
  verifiedAt: string | null;
  required: boolean;
}

/** The provider as the server tells it: never its secret, only whether one is set. */
export interface SsoProvider {
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  joinAsMember: boolean;
  sessionHours: number;
  /** When an owner last signed in through it (required sign-on needs one); null until then. */
  testedAt: string | null;
  version: number;
}

export interface SsoSettings {
  domains: SsoDomain[];
  provider: SsoProvider | null;
  /** The address to register at the provider (the API's own callback). */
  redirectUri: string;
}

/**
 * A provider to save. `clientSecret`: a string sets it, null removes it, left out keeps the one
 * the server holds (as the AI keys).
 */
export interface ProviderChange {
  issuer: string;
  clientId: string;
  clientSecret?: string | null;
  joinAsMember: boolean;
  sessionHours: number;
}

/** How long a session made through the provider may last, in hours (the server's rule). */
export const SESSION_HOURS = { min: 1, max: 720, initial: 24 } as const;

/** What Settings → Single sign-on needs, for one workspace (a fake in tests). */
export interface SsoHost {
  read(): Promise<SsoSettings>;
  addDomain(domain: string): Promise<SsoDomain>;
  verifyDomain(domain: string): Promise<SsoDomain>;
  requireDomain(domain: string, required: boolean): Promise<SsoDomain>;
  removeDomain(domain: string): Promise<void>;
  /** `version` is the provider's as read: a stale one is refused (`version.conflict`). */
  setProvider(change: ProviderChange, version?: number): Promise<SsoProvider>;
  removeProvider(): Promise<void>;
}

/** The account's ways in, for Settings → Account. */
export interface AccountSignIn {
  email: string;
  hasPassword: boolean;
  /** A domain of the account requires its workspace's provider (never for that workspace's owners). */
  ssoRequired: boolean;
}

export interface PasswordHost {
  /** Null when signed out. */
  read(): Promise<AccountSignIn | null>;
  /** Asks the server for the reset mail, whose link sets a password (the server answers 202 always). */
  sendLink(email: string, language: Language): Promise<void>;
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

type DomainDto = {
  domain: string;
  record: SsoRecord;
  verifiedAt: string | null;
  required: boolean;
};
type ProviderDto = Omit<SsoProvider, 'sessionHours' | 'version'> & {
  sessionHours: number | string;
  version: number | string;
};

const domainOf = (dto: DomainDto): SsoDomain => ({
  domain: dto.domain,
  record: { name: dto.record.name, value: dto.record.value },
  verifiedAt: dto.verifiedAt ?? null,
  required: dto.required,
});

const providerOf = (dto: ProviderDto): SsoProvider => ({
  issuer: dto.issuer,
  clientId: dto.clientId,
  hasSecret: dto.hasSecret,
  joinAsMember: dto.joinAsMember,
  sessionHours: Number(dto.sessionHours),
  testedAt: dto.testedAt ?? null,
  version: Number(dto.version),
});

/** The provider's body: `clientSecret` sent only to set it (a string) or remove it (null). */
export const providerBody = (change: ProviderChange) => ({
  issuer: change.issuer,
  clientId: change.clientId,
  joinAsMember: change.joinAsMember,
  sessionHours: change.sessionHours,
  ...(change.clientSecret !== undefined ? { clientSecret: change.clientSecret } : {}),
});

/** The owners' routes of one workspace over the app's API client. */
export function ssoHost(cloud: Pick<Cloud, 'api'>, workspaceId: Id): SsoHost {
  const api: ApiClient = cloud.api;
  const ws = { params: { path: { workspaceId } } };
  const at = (domain: string) => ({ params: { path: { workspaceId, domain } } });
  return {
    read: async () => {
      const answer = await data(api.GET('/api/v1/workspaces/{workspaceId}/sso', ws));
      return {
        domains: answer.domains.map(domainOf),
        provider: answer.provider ? providerOf(answer.provider) : null,
        redirectUri: answer.redirectUri,
      };
    },
    addDomain: async (domain) =>
      domainOf(
        await data(
          api.POST('/api/v1/workspaces/{workspaceId}/sso/domains', { ...ws, body: { domain } }),
        ),
      ),
    verifyDomain: async (domain) =>
      domainOf(
        await data(
          api.POST('/api/v1/workspaces/{workspaceId}/sso/domains/{domain}/verify', at(domain)),
        ),
      ),
    requireDomain: async (domain, required) =>
      domainOf(
        await data(
          api.PATCH('/api/v1/workspaces/{workspaceId}/sso/domains/{domain}', {
            ...at(domain),
            body: { required },
          }),
        ),
      ),
    removeDomain: async (domain) => {
      await data(api.DELETE('/api/v1/workspaces/{workspaceId}/sso/domains/{domain}', at(domain)));
    },
    setProvider: async (change, version) =>
      providerOf(
        await data(
          api.PUT('/api/v1/workspaces/{workspaceId}/sso/provider', {
            ...ws,
            body: providerBody(change),
            ...(version !== undefined ? { headers: { 'If-Match': `"${version}"` } } : {}),
          }),
        ),
      ),
    removeProvider: async () => {
      await data(api.DELETE('/api/v1/workspaces/{workspaceId}/sso/provider', ws));
    },
  };
}

/**
 * The account's password over the app's API client: what `/account/session` says of it (asked
 * when Settings opens: the start's check keeps only who is signed in), and the reset mail
 * (`/account/password/forgot`), whose link comes back to this app on the web.
 */
export function passwordHost(cloud: Pick<Cloud, 'api' | 'platform'>): PasswordHost {
  const api: ApiClient = cloud.api;
  return {
    read: async () => {
      const { account } = await data(api.GET('/api/v1/account/session'));
      if (!account) return null;
      return {
        email: account.email,
        hasPassword: account.hasPassword,
        ssoRequired: account.ssoRequired,
      };
    },
    sendLink: async (email, language) => {
      await data(
        api.POST('/api/v1/account/password/forgot', {
          body: {
            email,
            locale: language,
            returnUrl:
              cloud.platform.kind === 'web' ? `${location.origin}${location.pathname}` : null,
          },
        }),
      );
    },
  };
}
