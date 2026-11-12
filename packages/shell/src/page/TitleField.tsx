import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnyPage, WorkspaceSession } from '../session';

/**
 * The page title (a field on the page record, D6), edited in place; saved as a page.update after
 * a short pause. A database's page and a row's page have the same field (a row's title is its
 * title property).
 */
export function TitleField({
  session,
  page,
  readOnly,
  onEnter,
  placeholder,
}: {
  session: WorkspaceSession;
  page: AnyPage;
  readOnly: boolean;
  onEnter: () => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(page.title);
  const pending = useRef<number | null>(null);
  const editing = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);

  // A page just made, from the sidebar's button, its row menu or a key, starts in its title.
  useEffect(() => {
    if (session.takeFresh(page.id)) field.current?.focus();
  }, [session, page.id]);

  useEffect(() => {
    if (!editing.current) setDraft(page.title);
  }, [page.title]);

  const commit = (value: string): Promise<void> | undefined => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
    if (value !== page.title) return session.updatePage(page.id, { title: value });
  };

  // Leaving the page with a title still waiting to be saved saves it now; so does the session's
  // flush (the page hiding, the window closing, an upload), which waits for it to be stored.
  const latest = useRef({ draft, commit });
  latest.current = { draft, commit };
  useEffect(
    () => () => {
      if (pending.current !== null) void latest.current.commit(latest.current.draft);
    },
    [],
  );
  useEffect(
    () =>
      session.onFlush(() =>
        pending.current !== null ? latest.current.commit(latest.current.draft) : undefined,
      ),
    [session],
  );

  return (
    <textarea
      ref={field}
      className="cgw-title"
      rows={1}
      dir="auto"
      value={draft}
      readOnly={readOnly}
      placeholder={placeholder ?? t('page.untitled')}
      aria-label={t('page.title')}
      onFocus={() => (editing.current = true)}
      onBlur={() => {
        editing.current = false;
        void commit(draft);
      }}
      onChange={(event) => {
        const value = event.target.value.replace(/\n/g, ' ');
        setDraft(value);
        if (pending.current !== null) clearTimeout(pending.current);
        pending.current = window.setTimeout(() => void commit(value), 400);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void commit(draft);
          onEnter();
        }
      }}
    />
  );
}
