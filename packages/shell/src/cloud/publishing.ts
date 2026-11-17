// Publishing a page tree as a public, read-only site (Phase 9, M9.1; the streams' contract and
// DECISIONS.md, "2026-11-17: Phase 9"): the API's routes for a page's site and the workspace's
// switch, the slug's rules as the server checks them (so the dialog can say what is wrong before
// it asks), and the slug proposed from a title. The server decides who may publish and what a site
// holds; nothing here is the check.
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
  sites: (Site & { pageTitle: string; pageIcon: string | null })[];
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
});

const publishingOf = (dto: PublishingDto): Publishing => ({
  enabled: !!dto.enabled,
  sites: (dto.sites ?? []).map((s) => ({
    ...siteOf(s),
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
