// "Publish to the web" in the share dialog (Phase 9, M9.1): for someone with full access to a page
// in a shared section of a synced workspace, while the workspace allows publishing. Before
// publishing it lists what the site will hold (the page and its subtree as a share link opens it:
// never restricted or hidden pages, and only how many those are), then a slug (proposed from the
// title), the site's own language and whether search engines may index it. A live site shows its
// address, who published it and when, the same settings to change, and Unpublish, which takes it
// down at once. The server decides who may publish and what a site holds, on every request.
// Phase 14: a publish, change or unpublish from another tab or device (the feed's `site` change, or
// the workspace's `publishing` one) is read again at once, unless the person has started changing
// the fields here (their save then meets the version conflict and is read again).
import { CgCheckBox } from '@cashgear/ui';
import type { Id, PageRecord } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  defaultSlug,
  publishFailure,
  slugProblem,
  type PublishingApi,
  type Site,
  type SiteLanguage,
  type SitePage,
  type SiteState,
  type SlugProblem,
} from './publishing';
import { siteDomainsWords } from './domainsWords';
import { useCertificateText } from './SiteDomainsSettings';
import { useSection } from '../i18n/sections';
import './publish.css';

const SLUG_TEXT: Record<SlugProblem, string> = {
  length: 'publish.slugLength',
  characters: 'publish.slugCharacters',
  edges: 'publish.slugEdges',
  dashes: 'publish.slugDashes',
  reserved: 'publish.slugReserved',
};

const REASON_TEXT = {
  private: 'publish.reasonPrivate',
  off: 'publish.reasonOff',
  local: 'publish.reasonLocal',
  trashed: 'publish.reasonTrashed',
} as const;

type Loading = { kind: 'loading' } | { kind: 'ready'; state: SiteState } | { kind: 'hidden' };

/** Each page with how deep it is under the site's root, in the order the server listed them. */
function depths(pages: readonly SitePage[]): { page: SitePage; depth: number }[] {
  const depthOf = new Map<Id, number>();
  return pages.map((page) => {
    const parent = page.parentPageId ? depthOf.get(page.parentPageId) : undefined;
    const depth = parent === undefined ? 0 : parent + 1;
    depthOf.set(page.id, depth);
    return { page, depth };
  });
}

/**
 * Phase 14: a live site's address: its own (the slug's), or one of the workspace's proven host
 * names not given to another site. Read again when the feed says publishing changed.
 */
function SiteAddress({
  api,
  page,
  site,
  reading,
  onSite,
}: {
  api: PublishingApi;
  page: PageRecord;
  site: Site;
  reading: number;
  onSite: (site: Site) => void;
}) {
  useSection(siteDomainsWords);
  const { t } = useTranslation();
  const certificate = useCertificateText();
  const [choices, setChoices] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState(site.domain?.host ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const current = site.domain?.host ?? '';

  useEffect(() => {
    let live = true;
    api.domains(page.workspaceId).then(
      (answer) => {
        if (!live) return;
        setChoices(
          answer.choices
            .filter((c) => c.pageId === null || c.pageId === page.id)
            .map((c) => c.host),
        );
      },
      () => live && setChoices([]),
    );
    return () => {
      live = false;
    };
  }, [api, page.workspaceId, page.id, reading]);

  useEffect(() => setChosen(current), [current]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.setDomain(page.id, chosen || null);
      onSite(saved);
      setMessage({
        alert: false,
        text: chosen
          ? t('siteDomains.addressSaved', { host: chosen })
          : t('siteDomains.addressOwnSaved'),
      });
    } catch (error) {
      const code = publishFailure(error);
      setMessage({
        alert: true,
        text:
          code === 'domain.inUse'
            ? t('siteDomains.inUse')
            : code === 'domain.notVerified'
              ? t('siteDomains.notVerified')
              : code === 'offline'
                ? t('publish.offline')
                : t('siteDomains.failed'),
      });
    } finally {
      setBusy(false);
    }
  };

  if (choices === null) return null;
  const hosts = current && !choices.includes(current) ? [current, ...choices] : choices;
  return (
    <div className="cgw-publish-fields" data-testid="site-address">
      <label htmlFor="cgw-publish-address">{t('siteDomains.address')}</label>
      {hosts.length ? (
        <>
          <select
            id="cgw-publish-address"
            className="cgw-input"
            value={chosen}
            aria-describedby="cgw-publish-address-help"
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value="">{t('siteDomains.addressOwn')}</option>
            {hosts.map((host) => (
              <option key={host} value={host} dir="ltr">
                {host}
              </option>
            ))}
          </select>
          <p id="cgw-publish-address-help" className="cgw-muted">
            {t('siteDomains.addressHelp')}
          </p>
          <p>
            <button
              type="button"
              className="cgw-button"
              disabled={busy || chosen === current}
              onClick={() => void save()}
            >
              {t('siteDomains.addressSave')}
            </button>
          </p>
        </>
      ) : (
        <p id="cgw-publish-address-help" className="cgw-muted">
          {t('siteDomains.addressNone')}
        </p>
      )}
      {site.domain ? (
        <p className="cgw-muted" data-testid="site-address-state">
          {t('siteDomains.at', {
            host: site.domain.host,
            state: certificate(site.domain.certificate, null, null),
          })}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.alert ? 'alert' : 'status'}
          className={message.alert ? 'cgw-publish-problem' : 'cgw-muted'}
          data-testid="site-address-message"
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/** Phase 14: what the feed says of publishing, for this page's workspace (`null`: anything). */
export type PublishingChanges = (listener: (pageIds: Id[] | null) => void) => () => void;

export function PublishSection({
  api,
  page,
  changes,
}: {
  api: PublishingApi;
  page: PageRecord;
  changes?: PublishingChanges;
}) {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState<Loading>({ kind: 'loading' });
  // The person changed a field since the last read, or a request is out: a feed change waits.
  const touched = useRef(false);
  const [reading, setReading] = useState(0);
  const [slug, setSlug] = useState('');
  const [language, setLanguage] = useState<SiteLanguage>(i18n.language === 'ar' ? 'ar' : 'en');
  const [indexing, setIndexing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });

  useEffect(() => {
    let live = true;
    api.site(page.id).then(
      (state) => {
        if (!live) return;
        touched.current = false;
        setLoading({ kind: 'ready', state });
        const site = state.site;
        setSlug(site ? site.slug : defaultSlug(page.title, page.id));
        if (site) {
          setLanguage(site.language);
          setIndexing(site.indexing);
        }
      },
      (error: unknown) => {
        if (!live) return;
        // Not full access (or a row): the section is not offered; anything else says so.
        const code = publishFailure(error);
        if (code === 'access.denied') setLoading({ kind: 'hidden' });
        else {
          setLoading({ kind: 'hidden' });
          setMessage({
            text: code === 'offline' ? t('publish.offline') : t('publish.loadFailed'),
            alert: true,
          });
        }
      },
    );
    return () => {
      live = false;
    };
    // The title is the proposal's only when the dialog opens.
  }, [api, page.id, reading, t]);

  useEffect(
    () =>
      changes?.((pageIds) => {
        if ((pageIds === null || pageIds.includes(page.id)) && !touched.current)
          setReading((n) => n + 1);
      }),
    [changes, page.id],
  );

  const state = loading.kind === 'ready' ? loading.state : null;
  const site = state?.site ?? null;
  const listed = useMemo(() => depths(state?.pages ?? []), [state]);
  const problem = slugProblem(slug);
  const changed =
    !!site && (site.slug !== slug || site.language !== language || site.indexing !== indexing);

  const refused = (error: unknown) => {
    const code = publishFailure(error);
    return code === 'slug.taken'
      ? t('publish.slugTaken')
      : code === 'request.invalid'
        ? t('publish.invalid')
        : code === 'version.conflict'
          ? t('publish.conflict')
          : code === 'publishing.off'
            ? t('publish.reasonOff')
            : code === 'conflict'
              ? t('publish.reasonTrashed')
              : code === 'access.denied'
                ? t('publish.denied')
                : code === 'offline'
                  ? t('publish.offline')
                  : t('publish.failed');
  };

  const publish = async () => {
    if (problem) return;
    touched.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const made = await api.publish(page.id, { slug, indexing, language }, site?.version);
      setLoading((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', state: { ...current.state, site: made } }
          : current,
      );
      setCopied(false);
      touched.current = false;
      setMessage({ text: t(site ? 'publish.updated' : 'publish.published'), alert: false });
    } catch (error) {
      setMessage({ text: refused(error), alert: true });
      // Someone changed the site (or the page) meanwhile: what is there now is read again.
      if (publishFailure(error) === 'version.conflict') setReading((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    touched.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await api.unpublish(page.id);
      setConfirming(false);
      setMessage({ text: t('publish.unpublished'), alert: false });
      setReading((n) => n + 1);
    } catch (error) {
      setConfirming(false);
      setMessage({ text: refused(error), alert: true });
    } finally {
      setBusy(false);
    }
  };

  if (loading.kind === 'hidden')
    return message ? (
      <p role="alert" className="cgw-muted">
        {message.text}
      </p>
    ) : null;

  return (
    <section
      aria-labelledby="cgw-publish-title"
      className="cgw-publish"
      data-testid="publish-section"
      data-state={site ? 'live' : (state?.reason ?? (state ? 'ready' : 'loading'))}
    >
      <h3 id="cgw-publish-title">{t('publish.title')}</h3>
      {!state ? (
        <p aria-busy="true" className="cgw-muted">
          {t('app.loading')}
        </p>
      ) : !site && !state.publishable ? (
        <p className="cgw-muted" role="note" data-testid="publish-reason">
          {t(state.reason ? REASON_TEXT[state.reason] : 'publish.reasonOther')}
        </p>
      ) : (
        <>
          {site ? (
            <div className="cgw-publish-live" role="group" aria-label={t('publish.liveLabel')}>
              <p>
                {t('publish.liveAt')}{' '}
                <a
                  href={site.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="cgw-publish-url"
                  data-testid="site-url"
                  dir="ltr"
                >
                  {site.url}
                </a>{' '}
                <button
                  type="button"
                  className="cgw-button"
                  onClick={() =>
                    void navigator.clipboard?.writeText(site.url).then(
                      () => setCopied(true),
                      () => undefined,
                    )
                  }
                >
                  {copied ? t('share.copied') : t('share.copy')}
                </button>
              </p>
              <p className="cgw-muted">
                {site.publishedBy
                  ? t('publish.publishedBy', {
                      name: site.publishedBy.name,
                      when: format.format(new Date(site.publishedAt)),
                    })
                  : t('publish.publishedOn', { when: format.format(new Date(site.publishedAt)) })}
              </p>
            </div>
          ) : (
            <p className="cgw-muted">{t('publish.note')}</p>
          )}
          <div className="cgw-publish-pages">
            <p id="cgw-publish-pages-title">
              {t(site ? 'publish.holds' : 'publish.willHold', { number: listed.length })}
            </p>
            <ul aria-labelledby="cgw-publish-pages-title" data-testid="publish-pages">
              {listed.map(({ page: p, depth }) => (
                <li key={p.id} style={{ paddingInlineStart: `${depth * 16}px` }} dir="auto">
                  {p.icon ? `${p.icon} ` : ''}
                  {p.title || t('page.untitled')}
                </li>
              ))}
            </ul>
            {state.leftOut ? (
              <p className="cgw-muted" data-testid="publish-left-out">
                {t('publish.leftOut', { number: state.leftOut })}
              </p>
            ) : null}
            <p className="cgw-muted">{t('publish.neverShown')}</p>
          </div>
          <div className="cgw-publish-fields">
            <label htmlFor="cgw-publish-slug">{t('publish.slug')}</label>
            <input
              id="cgw-publish-slug"
              className="cgw-input"
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              maxLength={63}
              value={slug}
              aria-describedby="cgw-publish-slug-help"
              aria-invalid={problem ? true : undefined}
              onChange={(event) => {
                touched.current = true;
                setSlug(event.target.value.trim().toLowerCase());
              }}
            />
            <p
              id="cgw-publish-slug-help"
              className={problem ? 'cgw-publish-problem' : 'cgw-muted'}
              role={problem ? 'alert' : undefined}
            >
              {problem ? t(SLUG_TEXT[problem] as 'publish.slugLength') : t('publish.slugHelp')}
            </p>
            <label htmlFor="cgw-publish-language">{t('publish.language')}</label>
            <select
              id="cgw-publish-language"
              className="cgw-input"
              value={language}
              aria-describedby="cgw-publish-language-help"
              onChange={(event) => {
                touched.current = true;
                setLanguage(event.target.value === 'ar' ? 'ar' : 'en');
              }}
            >
              <option value="en" lang="en">
                {t('language.en')}
              </option>
              <option value="ar" lang="ar">
                {t('language.ar')}
              </option>
            </select>
            <p id="cgw-publish-language-help" className="cgw-muted">
              {t('publish.languageHelp')}
            </p>
          </div>
          {site ? (
            <SiteAddress
              api={api}
              page={page}
              site={site}
              reading={reading}
              onSite={(saved) =>
                setLoading((current) =>
                  current.kind === 'ready'
                    ? { kind: 'ready', state: { ...current.state, site: saved } }
                    : current,
                )
              }
            />
          ) : null}
          <CgCheckBox
            label={t('publish.indexing')}
            description={t('publish.indexingHelp')}
            checked={indexing}
            onCheckedChange={(checked) => {
              touched.current = true;
              setIndexing(checked === true);
            }}
          />
          <div className="cgw-publish-buttons">
            {site ? (
              <>
                <button
                  type="button"
                  className="cgw-button is-primary"
                  disabled={busy || !!problem || !changed}
                  onClick={() => void publish()}
                >
                  {t('publish.save')}
                </button>
                {confirming ? (
                  <span
                    role="group"
                    aria-label={t('publish.unpublish')}
                    className="cgw-publish-confirm"
                  >
                    <span>{t('publish.unpublishConfirm')}</span>
                    <button
                      type="button"
                      className="cgw-button is-danger"
                      disabled={busy}
                      onClick={() => void unpublish()}
                    >
                      {t('publish.unpublishNow')}
                    </button>
                    <button
                      type="button"
                      className="cgw-button"
                      disabled={busy}
                      onClick={() => setConfirming(false)}
                    >
                      {t('frame.cancel')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="cgw-button"
                    disabled={busy}
                    onClick={() => setConfirming(true)}
                  >
                    {t('publish.unpublish')}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="cgw-button is-primary"
                disabled={busy || !!problem}
                onClick={() => void publish()}
              >
                {t('publish.publish')}
              </button>
            )}
          </div>
        </>
      )}
      {message ? (
        <p
          role={message.alert ? 'alert' : 'status'}
          className={message.alert ? 'cgw-publish-problem' : 'cgw-muted'}
          data-testid="publish-message"
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
