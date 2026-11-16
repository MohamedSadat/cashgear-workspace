// The bubble toolbar on a text selection: marks, link, colour, "turn into" and, when the host lets
// this person comment (Phase 6), "Comment"; when the host offers AI (Phase 7), "Ask AI", which
// only tells the host the selection. `@cashgear/ui`'s CgSelectionToolbar (Track U2): a CgToolbar in
// a CgFlyout that follows the selection's rectangle, the link field, the colours or the "turn into"
// list in its panel. Presses in it keep the focus where it was, so the editor keeps its selection
// while the toolbar is used. On a page this person may comment on but not edit (or in a code block,
// where marks do not apply), it holds "Comment" alone.
import { CgIcon, CgSelectionToolbar, type CgToolbarItem } from '@cashgear/ui';
import { COLOUR_TOKENS, safeHref, type ColourToken } from '@cgw/doc';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { BLOCK_ACTIONS } from '../actions';
import { textOfRange } from '../ai';
import { currentBlock, firstBody } from '../blocks';
import { commentOnSelection } from '../comments';
import type { BlockEditor } from '../editor';
import { editorString, type EditorHost } from '../host';
import { slashState } from '../slash';

type Panel = null | 'link' | 'colour' | 'turnInto';

/** The tools that open the toolbar's panel, each named by its panel. */
const OPENS_PANEL = ['turnInto', 'link', 'colour'] as const;
const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'link'] as const;

interface Snapshot {
  show: boolean;
  /** Every tool, or "Comment" alone (not editable here, or in a code block). */
  commentOnly: boolean;
  key: string;
}

function snapshot(editor: Editor, focused: boolean, canComment: boolean): Snapshot {
  const { state } = editor;
  const { selection } = state;
  const text = selection instanceof TextSelection;
  const inCode = !!selection.$from.parent.type.spec.code;
  let show = false;
  let commentOnly = false;
  if (editor.isEditable) {
    const inLink = editor.isActive('link');
    show = focused && text && (!selection.empty || inLink) && !inCode && !slashState(state).active;
    if (!show && canComment && focused && text && !selection.empty && inCode)
      show = commentOnly = true;
  } else if (canComment && text && !selection.empty) {
    // Read-only here, but this person may comment: a selection is read without focus.
    show = commentOnly = true;
  }
  // Hidden, the snapshot stays the same as the caret moves: no React render per keystroke (each
  // commit while the editor has focus reads its selection offsets, which walks the page's DOM).
  return {
    show,
    commentOnly,
    key: show
      ? `${selection.from}:${selection.to}:${state.doc.content.size}:${commentOnly}`
      : 'hidden',
  };
}

function useSelectionSnapshot(
  editor: Editor,
  canComment: boolean,
  surface: RefObject<HTMLDivElement | null>,
): Snapshot {
  const cache = useRef<Snapshot>({ show: false, commentOnly: false, key: '' });
  const comments = useRef(canComment);
  comments.current = canComment;
  const focused = useRef(editor.isFocused);
  // One subscription for the editor's life: a new one each render would re-read the focus and
  // close the toolbar while its own link field has it.
  const subscribe = useCallback(
    (listener: () => void) => {
      const onFocus = () => {
        focused.current = true;
        listener();
      };
      const onBlur = ({ event }: { event: FocusEvent }) => {
        // Focus moving into the toolbar (the link field) keeps it open.
        const into = event.relatedTarget as Node | null;
        focused.current = !!into && !!surface.current?.contains(into);
        listener();
      };
      editor.on('transaction', listener);
      editor.on('focus', onFocus);
      editor.on('blur', onBlur);
      return () => {
        editor.off('transaction', listener);
        editor.off('focus', onFocus);
        editor.off('blur', onBlur);
      };
    },
    [editor, surface],
  );
  return useSyncExternalStore(subscribe, () => {
    const next = snapshot(editor, focused.current || editor.isFocused, comments.current);
    if (next.key !== cache.current.key) cache.current = next;
    return cache.current;
  });
}

/** A button in the panel under the toolbar (the link's, a colour). */
function PanelButton({
  label,
  active,
  onPress,
  children,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cgw-bubble-button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

const noAi = () => () => {};
const notAvailable = () => false;

/** Whether "Ask AI" is offered (Phase 7, `EditorHost.ai`), followed without a render per key. */
function useAiAvailable(host: EditorHost): boolean {
  const ai = host.ai;
  const subscribe = useCallback(
    (listener: () => void) => (ai ? ai.subscribe(listener) : noAi()),
    [ai],
  );
  return useSyncExternalStore(subscribe, ai ? () => ai.available() : notAvailable);
}

/** The selection's rectangle in the viewport: from its start to its end, over every line. */
function selectionRect(editor: Editor) {
  const { from, to } = editor.state.selection;
  try {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    return { x: left, y: top, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

/** A block kind's name for "turn into", in the host's words. */
function kindName(editor: Editor, host: EditorHost): string {
  const block = currentBlock(editor.state);
  const body = block && firstBody(block);
  if (!body) return '';
  if (body.node.type.name === 'codeBlock') return host.blockName?.('code') ?? 'code';
  const { kind, level } = body.node.attrs;
  const name =
    kind === 'heading'
      ? `heading${level ?? 1}`
      : ((
          { bulletItem: 'bulletList', numberedItem: 'numberedList', checkItem: 'todo' } as Record<
            string,
            string
          >
        )[kind] ?? kind);
  return host.blockName?.(name) ?? name;
}

export function BubbleToolbar({
  editor: blockEditor,
  host,
}: {
  editor: BlockEditor;
  host: EditorHost;
}) {
  const editor = blockEditor.editor;
  const surface = useRef<HTMLDivElement>(null);
  const canComment = !!host.comments?.create;
  const snap = useSelectionSnapshot(editor, canComment, surface);
  const aiAvailable = useAiAvailable(host);
  const [panel, setPanel] = useState<Panel>(null);
  const [href, setHref] = useState('');
  const [invalid, setInvalid] = useState(false);
  const s = host.strings;

  useLayoutEffect(() => {
    if (!snap.show) setPanel(null);
  }, [snap.show]);
  // CgToolbar's items have no `aria-expanded`: the tools that open the panel are marked here.
  useLayoutEffect(() => {
    for (const name of OPENS_PANEL)
      surface.current
        ?.querySelector(`[data-cg-toolbar-name="${name}"]`)
        ?.setAttribute('aria-expanded', String(panel === name));
  });

  const rect = useMemo(() => (snap.show ? selectionRect(editor) : null), [snap, editor]);
  const shown = snap.show && !!s?.formatting;
  const kind = shown && !snap.commentOnly ? kindName(editor, host) : '';
  const marks = shown ? MARKS.map((mark) => (editor.isActive(mark) ? 1 : 0)).join('') : '';
  const items = useMemo((): CgToolbarItem[] => {
    if (!shown || !s) return [];
    const comment: CgToolbarItem | null = canComment
      ? {
          name: 'comment',
          text: editorString(host, 'comment'),
          icon: 'comment',
          iconOnly: true,
          beginGroup: true,
          onClick: () => {
            commentOnSelection(editor.state, host);
            setPanel(null);
          },
        }
      : null;
    if (snap.commentOnly) return comment ? [comment] : [];
    const on = (index: number) => marks[index] === '1';
    const mark = (name: string, text: string, index: number, icon: CgToolbarItem['icon']) => ({
      name,
      text,
      icon,
      iconOnly: true,
      checked: on(index),
      onClick: () => void editor.chain().focus().toggleMark(name).run(),
    });
    const list: CgToolbarItem[] = [
      {
        name: 'turnInto',
        text: s.turnInto,
        icon: (
          <span className="cgw-bubble-opens">
            <span className="cgw-bubble-kind">{kind}</span> ▾
          </span>
        ),
        iconOnly: true,
        onClick: () => setPanel((open) => (open === 'turnInto' ? null : 'turnInto')),
      },
      { ...mark('bold', s.bold, 0, 'text-bold'), beginGroup: true },
      mark('italic', s.italic, 1, 'text-italic'),
      mark('underline', s.underline, 2, 'text-underline'),
      mark('strike', s.strike, 3, 'text-strikethrough'),
      mark('code', s.code, 4, 'code'),
      {
        name: 'link',
        text: s.link,
        icon: 'link',
        iconOnly: true,
        checked: on(5),
        onClick: () => {
          setHref(String(editor.getAttributes('link').href ?? ''));
          setInvalid(false);
          setPanel((open) => (open === 'link' ? null : 'link'));
        },
      },
      {
        name: 'colour',
        text: s.colour,
        icon: (
          <span className="cgw-bubble-opens">
            <CgIcon name="text-color" /> ▾
          </span>
        ),
        iconOnly: true,
        onClick: () => setPanel((open) => (open === 'colour' ? null : 'colour')),
      },
    ];
    if (comment) list.push(comment);
    if (aiAvailable && host.ai)
      list.push({
        name: 'askAi',
        text: editorString(host, 'askAi'),
        icon: <span aria-hidden="true">✦</span>,
        iconOnly: true,
        beginGroup: true,
        onClick: () => {
          const { from, to } = editor.state.selection;
          const text = textOfRange(editor, from, to, host);
          if (!text.trim()) return;
          setPanel(null);
          host.ai?.askAboutSelection({ from, to, text });
        },
      });
    return list;
  }, [shown, s, snap.commentOnly, canComment, host, editor, kind, marks, aiAvailable]);

  if (!shown || !s) return null;

  const applyLink = () => {
    const value = href.trim();
    if (!value) {
      editor.chain().focus().extendMarkRange('link').unsetMark('link').run();
      setPanel(null);
      return;
    }
    const candidate = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(value) ? `https://${value}` : value;
    const safe = safeHref(candidate);
    if (!safe) {
      setInvalid(true);
      return;
    }
    editor.chain().focus().extendMarkRange('link').setMark('link', { href: safe }).run();
    setPanel(null);
  };
  const setColour = (type: 'textColour' | 'highlight', token: ColourToken | null) => {
    const chain = editor.chain().focus();
    if (token) chain.setMark(type, { token }).run();
    else chain.unsetMark(type).run();
    setPanel(null);
  };

  const panels: Record<Exclude<Panel, null>, () => ReactNode> = {
    link: () => (
      <form
        className="cgw-bubble-link"
        onSubmit={(event) => {
          event.preventDefault();
          applyLink();
        }}
      >
        <input
          autoFocus
          dir="ltr"
          className="cgw-bubble-input"
          aria-label={s.linkAddress}
          placeholder={s.linkPlaceholder}
          aria-invalid={invalid}
          value={href}
          onChange={(event) => {
            setHref(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setPanel(null);
              editor.commands.focus();
            }
          }}
        />
        {invalid && (
          <span className="cgw-bubble-error" role="alert">
            {s.linkInvalid}
          </span>
        )}
        {editor.isActive('link') && (
          <>
            <PanelButton
              label={s.openLink}
              onPress={() => host.openExternal?.(String(editor.getAttributes('link').href))}
            >
              ↗
            </PanelButton>
            <PanelButton
              label={s.removeLink}
              onPress={() => {
                editor.chain().focus().extendMarkRange('link').unsetMark('link').run();
                setPanel(null);
              }}
            >
              ✕
            </PanelButton>
          </>
        )}
      </form>
    ),
    colour: () => (
      <div className="cgw-bubble-colours">
        {(['textColour', 'highlight'] as const).map((type) => (
          <div
            key={type}
            className="cgw-bubble-swatches"
            role="group"
            aria-label={type === 'textColour' ? s.textColour : s.highlight}
          >
            <PanelButton label={s.defaultColour} onPress={() => setColour(type, null)}>
              <span className="cgw-swatch" data-default="" />
            </PanelButton>
            {COLOUR_TOKENS.map((token) => (
              <PanelButton
                key={token}
                label={s[`colour_${token}`] ?? token}
                active={editor.isActive(type, { token })}
                onPress={() => setColour(type, token)}
              >
                <span
                  className={`cgw-swatch cgw-${type === 'textColour' ? 'colour' : 'highlight'}`}
                  data-colour={type === 'textColour' ? token : undefined}
                  data-highlight={type === 'highlight' ? token : undefined}
                >
                  ●
                </span>
              </PanelButton>
            ))}
          </div>
        ))}
      </div>
    ),
    turnInto: () => (
      <div className="cgw-bubble-menu" role="menu">
        {BLOCK_ACTIONS.filter((action) => action.turnInto).map((action) => (
          <button
            key={action.name}
            type="button"
            role="menuitem"
            className="cgw-bubble-menu-item"
            onClick={() => {
              void action.apply(editor, host);
              setPanel(null);
            }}
          >
            <span className="cgw-bubble-menu-icon" aria-hidden="true">
              <CgIcon name={action.glyph} />
            </span>
            {host.blockName?.(action.name) ?? action.name}
          </button>
        ))}
      </div>
    ),
  };

  return (
    <CgSelectionToolbar
      ref={surface}
      className="cgw-bubble"
      label={s.formatting}
      rect={rect}
      items={items}
      autoCollapseText={false}
      panel={panel && !snap.commentOnly ? panels[panel]() : undefined}
      onEscape={() => {
        setPanel(null);
        editor.commands.focus();
      }}
    />
  );
}
