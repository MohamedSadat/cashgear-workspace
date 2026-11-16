// The comment composer: the library's editable area with suggestions (Track U17) writing the
// contract's `CommentBody` (text, line breaks, and mentions of people and pages). "@" offers the
// workspace's people, then pages; arrow keys choose, Enter or Tab takes one, Escape closes the
// list. Ctrl+Enter (⌘Enter) sends. Pasted content goes in as plain text. Nothing here renders per
// keystroke: React state changes only when sending becomes possible or not, or the count of
// characters left changes near the limit; the area draws its "@" list itself.
import {
  CgMentionArea,
  type CgMentionAreaHandle,
  type CgMentionAreaSuggestion,
} from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { useCallback, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BODY_TEXT_LIMIT,
  bodyFromElement,
  bodyProblem,
  bodyTextLength,
  valueFromBody,
  type CommentBody,
} from './body';
import { formatShortcut } from '../shortcuts';
import type { PeopleDirectory } from './people';

/** Pages offered after the people. */
const PAGE_LIMIT = 5;
/** The count of characters left shows from this many characters left. */
const COUNT_FROM = 400;

export interface ComposerHandle {
  focus(): void;
  clear(): void;
}

export interface ComposerProps {
  /** The editable area's accessible name. */
  label: string;
  placeholder: string;
  submitLabel: string;
  initial?: CommentBody;
  disabled?: boolean;
  autoFocus?: boolean;
  people: PeopleDirectory | null;
  pages: (query: string) => { id: Id; title: string; icon: string | null }[];
  personName: (userId: Id) => string;
  pageTitle: (pageId: Id) => string;
  /** Sends the body; the composer empties itself unless `keep` is set (an edit closes instead). */
  onSubmit: (body: CommentBody) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  handle?: Ref<ComposerHandle>;
}

interface Measure {
  ready: boolean;
  /** Characters left, near the limit only. */
  left: number | null;
}

/** Whether a body can be sent, and the characters left near the limit. */
function measureOf(body: CommentBody): Measure {
  const left = BODY_TEXT_LIMIT - bodyTextLength(body);
  return { ready: bodyProblem(body) === null, left: left <= COUNT_FROM ? left : null };
}

export function Composer({
  label,
  placeholder,
  submitLabel,
  initial,
  disabled = false,
  autoFocus = false,
  people,
  pages,
  personName,
  pageTitle,
  onSubmit,
  onCancel,
  cancelLabel,
  handle,
}: ComposerProps) {
  const { t } = useTranslation();
  const area = useRef<CgMentionAreaHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  // The body it opens with only; later changes are the person's own.
  const [opening] = useState(() =>
    initial ? valueFromBody(initial, { person: personName, page: pageTitle }) : undefined,
  );
  const [state, setState] = useState<Measure>(() =>
    initial ? measureOf(initial) : { ready: false, left: null },
  );

  /** The body the area holds now, read from its content (`bodyFromElement` says why). */
  const read = (): CommentBody => {
    const el = box.current?.querySelector('[role="textbox"]');
    return el ? bodyFromElement(el) : [];
  };

  const measure = () => {
    const next = measureOf(read());
    setState((was) => (was.ready === next.ready && was.left === next.left ? was : next));
  };

  useImperativeHandle(handle, () => ({
    focus: () => area.current?.focus(),
    clear: () => {
      area.current?.clear();
      measure();
    },
  }));

  const suggest = useCallback(
    (query: string): CgMentionAreaSuggestion[] => [
      ...(people?.search(query) ?? []).map((person) => ({
        key: `user:${person.id}`,
        label: person.name,
        group: t('comments.mentionPeople'),
        detail: people?.person(person.id)?.email ?? '',
        mention: { kind: 'user', id: person.id },
      })),
      ...pages(query)
        .slice(0, PAGE_LIMIT)
        .map((page) => {
          const title = page.title || t('page.untitled');
          return {
            key: `page:${page.id}`,
            label: title,
            group: t('comments.mentionPages'),
            // An element: a page's icon is drawn as written.
            ...(page.icon ? { icon: <span>{page.icon}</span> } : {}),
            mention: { kind: 'page', id: page.id },
            // A page's mention is its title, without the "@".
            text: title,
          };
        }),
    ],
    [people, pages, t],
  );

  const submit = () => {
    if (disabled) return;
    const body = read();
    if (bodyProblem(body)) return;
    onSubmit(body);
  };

  return (
    <div ref={box} className="cgw-composer" data-disabled={disabled || undefined}>
      <CgMentionArea
        ref={area}
        // The area and its "@" list (`workspace.css` gives the list's active option its contrast).
        className="cgw-composer-area"
        label={label}
        placeholder={placeholder}
        listLabel={t('comments.mentionMenu')}
        aria-describedby={state.left !== null ? `${hintId} ${countId}` : hintId}
        data-testid="comment-composer"
        defaultValue={opening}
        disabled={disabled}
        autoFocus={autoFocus}
        suggest={suggest}
        onValueChange={measure}
        onSubmit={submit}
        {...(onCancel ? { onCancel } : {})}
      />
      <p id={hintId} className="cgw-composer-hint cgw-muted">
        {t('comments.composerHint', { keys: formatShortcut('Mod+Enter') })}
      </p>
      {state.left !== null && (
        <p
          id={countId}
          className={`cgw-composer-count${state.left < 0 ? ' is-over' : ''}`}
          aria-live="polite"
        >
          {state.left < 0
            ? t('comments.tooLong', { count: -state.left })
            : t('comments.charactersLeft', { count: state.left })}
        </p>
      )}
      <div className="cgw-composer-buttons">
        {onCancel && (
          <button type="button" className="cgw-button" onClick={onCancel}>
            {cancelLabel ?? t('frame.cancel')}
          </button>
        )}
        <button
          type="button"
          className="cgw-button is-primary"
          disabled={disabled || !state.ready}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
