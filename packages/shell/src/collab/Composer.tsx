// The comment composer: a small editable area that writes the contract's `CommentBody` (text,
// line breaks, and mentions of people and pages). "@" offers the workspace's people, then pages;
// arrow keys choose, Enter or Tab takes one, Escape closes the list. Ctrl+Enter (⌘Enter) sends.
// Pasted content goes in as plain text. Nothing here renders per keystroke: React state changes
// only when sending becomes possible or not, or the "@" list opens, closes or changes.
import type { Id } from '@cgw/workspace';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  BODY_TEXT_LIMIT,
  bodyFromElement,
  bodyProblem,
  bodyTextLength,
  fillElement,
  mentionElement,
  mentionQueryAt,
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

interface Option {
  kind: 'user' | 'page';
  id: Id;
  label: string;
  detail: string;
}

interface Menu {
  node: Text;
  start: number;
  options: Option[];
  index: number;
}

/** Plain text at the caret, keeping the browser's undo history where it can. */
function insertPlainText(text: string) {
  if (document.execCommand?.('insertText', false, text)) return;
  const selection = getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Puts a mention where "@query" is being typed: the text from the "@" to the caret becomes the
 * mention's atom, followed by a space, and the caret goes after it.
 */
export function insertMention(
  root: HTMLElement,
  at: { node: Text; start: number },
  mention: { kind: 'user' | 'page'; id: Id },
  label: string,
) {
  const doc = root.ownerDocument;
  const selection = doc.getSelection();
  const end =
    selection?.focusNode === at.node ? Math.max(at.start, selection.focusOffset) : at.node.length;
  const range = doc.createRange();
  range.setStart(at.node, Math.min(at.start, at.node.length));
  range.setEnd(at.node, Math.min(end, at.node.length));
  range.deleteContents();
  const atom = mentionElement(doc, mention, label);
  range.insertNode(atom);
  const space = doc.createTextNode(' ');
  atom.after(space);
  const caret = doc.createRange();
  caret.setStart(space, 1);
  caret.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(caret);
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
  const area = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}-mentions`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [state, setState] = useState<{ ready: boolean; left: number | null; empty: boolean }>({
    ready: false,
    left: null,
    empty: true,
  });

  /** What the area holds now: whether it can be sent, and the characters left near the limit. */
  const measure = () => {
    const el = area.current;
    if (!el) return;
    const body = bodyFromElement(el);
    const left = BODY_TEXT_LIMIT - bodyTextLength(body);
    const next = {
      ready: bodyProblem(body) === null,
      left: left <= COUNT_FROM ? left : null,
      empty: !el.textContent && !el.querySelector('[data-user-id],[data-page-id]'),
    };
    setState((was) =>
      was.ready === next.ready && was.left === next.left && was.empty === next.empty ? was : next,
    );
  };

  useLayoutEffect(() => {
    const el = area.current;
    if (!el || !initial) return;
    fillElement(el, initial, { person: personName, page: pageTitle });
    measure();
    // The body it opens with only; later changes are the person's own.
  }, []);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  useImperativeHandle(handle, () => ({
    focus: () => area.current?.focus(),
    clear: () => {
      area.current?.replaceChildren();
      setMenu(null);
      measure();
    },
  }));

  const findMenu = () => {
    const el = area.current;
    const selection = getSelection();
    const node = selection?.focusNode;
    if (!el || !selection?.isCollapsed || !node || node.nodeType !== 3 || !el.contains(node))
      return setMenu(null);
    const found = mentionQueryAt((node as Text).data, selection.focusOffset);
    if (!found) return setMenu(null);
    const options: Option[] = [
      ...(people?.search(found.query) ?? []).map((p) => ({
        kind: 'user' as const,
        id: p.id,
        label: p.name,
        detail: people?.person(p.id)?.email ?? '',
      })),
      ...pages(found.query)
        .slice(0, PAGE_LIMIT)
        .map((p) => ({
          kind: 'page' as const,
          id: p.id,
          label: p.title || t('page.untitled'),
          detail: p.icon ?? '',
        })),
    ];
    setMenu((was) => {
      const same =
        was &&
        was.node === node &&
        was.start === found.start &&
        was.options.map((o) => o.id).join() === options.map((o) => o.id).join();
      if (same) return was;
      return options.length ? { node: node as Text, start: found.start, options, index: 0 } : null;
    });
  };

  const pick = (option: Option) => {
    const el = area.current;
    if (!el || !menu) return;
    insertMention(el, menu, { kind: option.kind, id: option.id }, option.label);
    setMenu(null);
    measure();
  };

  const submit = () => {
    const el = area.current;
    if (!el || disabled) return;
    const body = bodyFromElement(el);
    if (bodyProblem(body)) return;
    onSubmit(body);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenu({
          ...menu,
          index: (menu.index + step + menu.options.length) % menu.options.length,
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(menu.options[menu.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    insertPlainText(event.clipboardData.getData('text/plain'));
    measure();
  };

  const active = menu ? `${listId}-${menu.index}` : undefined;
  const users = menu?.options.filter((o) => o.kind === 'user') ?? [];
  const linked = menu?.options.filter((o) => o.kind === 'page') ?? [];
  const optionOf = (option: Option) => {
    const index = menu!.options.indexOf(option);
    return (
      <div
        key={`${option.kind}:${option.id}`}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={index === menu!.index}
        className={`cgw-mention-option${index === menu!.index ? ' is-active' : ''}`}
        // The area keeps the focus (and the caret) while an option is chosen with the pointer.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(option)}
      >
        <span dir="auto">
          {option.kind === 'page' && option.detail ? `${option.detail} ` : ''}
          {option.label}
        </span>
        {option.kind === 'user' && option.detail && (
          <span className="cgw-muted" dir="ltr">
            {option.detail}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="cgw-composer" data-disabled={disabled || undefined}>
      <div
        ref={area}
        className="cgw-composer-area"
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-placeholder={placeholder}
        aria-describedby={state.left !== null ? `${hintId} ${countId}` : hintId}
        aria-autocomplete="list"
        aria-controls={menu ? listId : undefined}
        aria-activedescendant={active}
        aria-disabled={disabled || undefined}
        data-placeholder={placeholder}
        data-empty={state.empty || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        dir="auto"
        tabIndex={0}
        onInput={() => {
          measure();
          findMenu();
        }}
        onKeyUp={(event) => {
          // The caret moved without typing (arrows, Home, End): the "@" list follows it.
          if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')
            if (!menu || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) findMenu();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => setMenu(null)}
        data-testid="comment-composer"
      />
      {menu && (
        <div
          id={listId}
          className="cgw-mention-menu"
          role="listbox"
          aria-label={t('comments.mentionMenu')}
        >
          {users.length > 0 && (
            <div role="group" aria-labelledby={`${listId}-people`}>
              <div id={`${listId}-people`} role="presentation" className="cgw-mention-heading">
                {t('comments.mentionPeople')}
              </div>
              {users.map(optionOf)}
            </div>
          )}
          {linked.length > 0 && (
            <div role="group" aria-labelledby={`${listId}-pages`}>
              <div id={`${listId}-pages`} role="presentation" className="cgw-mention-heading">
                {t('comments.mentionPages')}
              </div>
              {linked.map(optionOf)}
            </div>
          )}
        </div>
      )}
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
