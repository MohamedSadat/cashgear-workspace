// Publishing a page tree as a public, read-only site (Phase 9, M9.1; the streams' contract and
// DECISIONS.md, "2026-11-17: Phase 9"): the API's routes for a page's site and the workspace's
// switch, the slug's rules as the server checks them (so the dialog can say what is wrong before
// it asks), and the slug proposed from a title. The server decides who may publish and what a site
// holds; nothing here is the check. Phase 14: a workspace's host names for its sites (owners and
// admins add, prove and remove them; whoever may publish gives a site one).
import type { ApiClient, Schemas } from '@cgw/api';
import { SyncHttpError, type Id } from '@cgw/workspace';

export type SiteLanguage = 'en' | 'ar';

/** A live site, as the API sends it (`SiteDto`). */
export interface Site {
  id: Id;
  pageId: Id;
  slug: string;
  /** The site's address on its own origin (`https://pages.cashgearerp.com/<slug>`). */
  url: string;
  indexing: boolean;
  language: SiteLanguage;
  /** Rises with every change: the `If-Match` of a change. */
  version: number;
  publishedAt: string;
  publishedBy: { id: Id; name: string } | null;
  updatedAt: string;
  /** Phase 14: its host name, if it has one; `url` is there once the certificate is live. */
  domain: { host: string; certificate: CertificateState; url: string } | null;
}

/** Phase 14: a host name's certificate: none yet, being made, live, or failed (`error` says why). */
export type CertificateState = 'none' | 'ordering' | 'live' | 'failed';

/** Phase 14: a host name of the workspace, as owners and admins see it. */
export interface SiteDomain {
  id: Id;
  host: string;
  /** The DNS `TXT` record that proves it. */
  record: { name: string; value: string };
  /** The name its `CNAME` points at (the sites' own). */
  target: string;
  verifiedAt: string | null;
  /** The page whose site it serves, if any. */
  pageId: Id | null;
  pageTitle: string | null;
  certificate: CertificateState;
  certificateExpiresAt: string | null;
  /** Why the last certificate order failed (`notPointed`, `challenge`, `rateLimited`...). */
  certificateError: string | null;
  version: number;
}

/** Phase 14: `GET /workspaces/{id}/publishing/domains`. */
export interface SiteDomains {
  /** Every host name, to owners and admins; empty for anyone else. */
  domains: SiteDomain[];
  /** The proven names a site may be given, to everyone; `pageId` the page whose site has it. */
  choices: { host: string; pageId: Id | null }[];
  target: string;
  /** Whether this server makes certificates (its ACME settings are set). */
  certificates: boolean;
}

/** Why a page cannot be published now (the server's answer). */
export type NotPublishable = 'private' | 'off' | 'local' | 'trashed';

/** A page the site holds (or would), parents first. */
export interface SitePage {
  id: Id;
  title: string;
  icon: string | null;
  parentPageId: Id | null;
}

/** `GET /pages/{id}/site`: the page's site, whether it may be published, and what it holds. */
export interface SiteState {
  site: Site | null;
  publishable: boolean;
  reason: NotPublishable | null;
  pages: SitePage[];
  /** Pages of the subtree left out (restricted, hidden): only how many, never their titles. */
  leftOut: number;
}

/** The workspace's switch and, for owners and admins, its live sites. */
export interface Publishing {
  enabled: boolean;
  sites: (Site & { pageTitle: string; pageIcon: string | null; domainHost: string | null })[];
}

export interface SiteSettings {
  slug: string;
  indexing: boolean;
  language: SiteLanguage;
}

// ---- The slug ----------------------------------------------------------------------------------

export const SLUG_MIN = 3;
export const SLUG_MAX = 63;

/** Words a slug may not be (the site's own routes, and names kept back); `_…` too. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'files',
  'assets',
  'static',
  'health',
  'robots-txt',
  'favicon-ico',
  'admin',
  'www',
  'cashgear',
]);

export type SlugProblem = 'length' | 'characters' | 'edges' | 'dashes' | 'reserved';

/** What is wrong with a slug by the server's rules, or null when it may be asked for. */
export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return 'length';
  if (slug.startsWith('_') || RESERVED_SLUGS.has(slug)) return 'reserved';
  if (!/^[a-z0-9-]+$/.test(slug)) return 'characters';
  if (slug.startsWith('-') || slug.endsWith('-')) return 'edges';
  if (slug.includes('--')) return 'dashes';
  return null;
}

/**
 * The slug the dialog proposes: the title's ASCII letters and digits, lower case, words joined by
 * `-` (accents dropped), at most 63 characters. A title that leaves too little of that (an Arabic
 * one) gives `page-` and the last 8 hex digits of the page id (its first ones are a timestamp,
 * the same for pages made a moment apart).
 */
export function defaultSlug(title: string, pageId: Id): string {
  const words = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = words.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (slugProblem(slug)) slug = `page-${pageId.replace(/-/g, '').slice(-8).toLowerCase()}`;
  return slug;
}

// ---- The routes ----------------------------------------------------------------------------------

type Answer<T> = Promise<{ data?: T; error?: unknown; response: Response }>;
type SiteDto = Schemas['SiteDto'];
type PublishingDto = Schemas['PublishingDto'];
type SiteDomainDto = Schemas['SiteDomainDto'];

const CERTIFICATES: readonly CertificateState[] = ['none', 'ordering', 'live', 'failed'];
const certificateOf = (value: string | null | undefined): CertificateState =>
  CERTIFICATES.includes(value as CertificateState) ? (value as CertificateState) : 'none';

/** The answer's data, or a SyncHttpError with the server's code. */
async function data<T>(request: Answer<T>): Promise<T> {
  const result = await request;
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string; title?: string } | undefined;
  throw new SyncHttpError(
    result.response.status,
    body?.code ?? 'server.error',
    body?.title ?? result.response.statusText,
  );
}

const REASONS: readonly NotPublishable[] = ['private', 'off', 'local', 'trashed'];

export const siteOf = (dto: SiteDto): Site => ({
  id: dto.id,
  pageId: dto.pageId,
  slug: dto.slug,
  url: dto.url,
  indexing: !!dto.indexing,
  language: dto.language === 'ar' ? 'ar' : 'en',
  version: Number(dto.version),
  publishedAt: dto.publishedAt,
  publishedBy: dto.publishedBy ? { id: dto.publishedBy.id, name: dto.publishedBy.name } : null,
  updatedAt: dto.updatedAt,
  domain: dto.domain
    ? {
        host: dto.domain.host,
        certificate: certificateOf(dto.domain.certificate),
        url: dto.domain.url,
      }
    : null,
});

const domainOf = (dto: SiteDomainDto): SiteDomain => ({
  id: dto.id,
  host: dto.host,
  record: { name: dto.record.name, value: dto.record.value },
  target: dto.target,
  verifiedAt: dto.verifiedAt ?? null,
  pageId: dto.pageId ?? null,
  pageTitle: dto.pageTitle ?? null,
  certificate: certificateOf(dto.certificate),
  certificateExpiresAt: dto.certificateExpiresAt ?? null,
  certificateError: dto.certificateError ?? null,
  version: Number(dto.version),
});

const publishingOf = (dto: PublishingDto): Publishing => ({
  enabled: !!dto.enabled,
  sites: (dto.sites ?? []).map((s) => ({
    ...siteOf({ ...s, domain: null }),
    domainHost: s.domain ?? null,
    pageTitle: s.pageTitle ?? '',
    pageIcon: s.pageIcon ?? null,
  })),
});

export function publishingApi(api: ApiClient) {
  const page = (pageId: Id) => ({ params: { path: { pageId } } });
  const workspace = (workspaceId: Id) => ({ params: { path: { workspaceId } } });
  return {
    /** The page's site and what it holds (`full` on the page; else `access.denied`). */
    site: async (pageId: Id): Promise<SiteState> => {
      const answer = await data(api.GET('/api/v1/pages/{pageId}/site', page(pageId)));
      return {
        site: answer.site ? siteOf(answer.site) : null,
        publishable: !!answer.publishable,
        reason: REASONS.includes(answer.reason as NotPublishable)
          ? (answer.reason as NotPublishable)
          : null,
        pages: (answer.pages ?? []).map((p) => ({
          id: p.id,
          title: p.title ?? '',
          icon: p.icon ?? null,
          parentPageId: p.parentPageId ?? null,
        })),
        leftOut: Number(answer.leftOut ?? 0),
      };
    },
    /**
     * Publishes the page, or changes its live site; `version` (the site's) refuses a change made
     * over someone else's (`version.conflict`).
     */
    publish: async (pageId: Id, settings: SiteSettings, version?: number): Promise<Site> =>
      siteOf(
        await data(
          api.PUT('/api/v1/pages/{pageId}/site', {
            ...page(pageId),
            body: settings,
            ...(version !== undefined ? { headers: { 'If-Match': `"${version}"` } } : {}),
          }),
        ),
      ),
    /** Takes the site down at once. */
    unpublish: async (pageId: Id): Promise<void> => {
      await data(api.DELETE('/api/v1/pages/{pageId}/site', page(pageId)));
    },
    /** The workspace's switch, and every live site for owners and admins. */
    publishing: async (workspaceId: Id): Promise<Publishing> =>
      publishingOf(
        await data(api.GET('/api/v1/workspaces/{workspaceId}/publishing', workspace(workspaceId))),
      ),
    /** Phase 14: gives the page's live site one of the workspace's proven host names, or (null) none. */
    setDomain: async (pageId: Id, host: string | null): Promise<Site> =>
      siteOf(
        await data(
          api.PUT('/api/v1/pages/{pageId}/site/domain', { ...page(pageId), body: { host } }),
        ),
      ),
    /** Phase 14: the workspace's host names (every one to owners and admins, the proven ones to all). */
    domains: async (workspaceId: Id): Promise<SiteDomains> => {
      const answer = await data(
        api.GET('/api/v1/workspaces/{workspaceId}/publishing/domains', workspace(workspaceId)),
      );
      return {
        domains: (answer.domains ?? []).map(domainOf),
        choices: (answer.choices ?? []).map((c) => ({ host: c.host, pageId: c.pageId ?? null })),
        target: answer.target,
        certificates: !!answer.certificates,
      };
    },
    /** Phase 14, owners and admins: a host name added (not yet proven). */
    addDomain: async (workspaceId: Id, host: string): Promise<SiteDomain> =>
      domainOf(
        await data(
          api.POST('/api/v1/workspaces/{workspaceId}/publishing/domains', {
            ...workspace(workspaceId),
            body: { host },
          }),
        ),
      ),
    /** Phase 14, owners and admins: its `TXT` record read now (`domain.dnsNotFound` until it is there). */
    verifyDomain: async (workspaceId: Id, domainId: Id): Promise<SiteDomain> =>
      domainOf(
        await data(
          api.POST('/api/v1/workspaces/{workspaceId}/publishing/domains/{domainId}/verify', {
            params: { path: { workspaceId, domainId } },
          }),
        ),
      ),
    /** Phase 14, owners and admins: removed at once; the site it served goes back to its slug's address. */
    removeDomain: async (workspaceId: Id, domainId: Id): Promise<void> => {
      await data(
        api.DELETE('/api/v1/workspaces/{workspaceId}/publishing/domains/{domainId}', {
          params: { path: { workspaceId, domainId } },
        }),
      );
    },
    /** Owners and admins: off unpublishes every live site at once; on brings none back. */
    setPublishing: async (workspaceId: Id, enabled: boolean): Promise<Publishing> =>
      publishingOf(
        await data(
          api.PUT('/api/v1/workspaces/{workspaceId}/publishing', {
            ...workspace(workspaceId),
            body: { enabled },
          }),
        ),
      ),
  };
}

export type PublishingApi = ReturnType<typeof publishingApi>;

/** The server's code for a refusal, `offline` when there was no answer. */
export function publishFailure(error: unknown): string {
  if (error instanceof SyncHttpError) return error.code;
  const named = error as { name?: string } | null;
  if (error instanceof TypeError || named?.name === 'NetworkError') return 'offline';
  return 'server.error';
}
