// The bubble toolbar on a text selection: marks, link, colour and "turn into". A stand-in for
// Track U2's selection toolbar (a CgToolbar in a CgFlyout that follows a rectangle). Mousedown is
// prevented everywhere, so the editor keeps its selection while the toolbar is used.
import { CgIcon } from '@cashgear/ui';
import { COLOUR_TOKENS, safeHref, type ColourToken } from '@cgw/doc';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { BLOCK_ACTIONS } from '../actions';
import { currentBlock, firstBody } from '../blocks';
import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';
import { slashState } from '../slash';

type Panel = null | 'link' | 'colour' | 'turnInto';

interface Snapshot {
  show: boolean;
  key: string;
}

function snapshot(editor: Editor, focused: boolean): Snapshot {
  const { state } = editor;
  const { selection } = state;
  const inLink = editor.isActive('link');
  const show =
    editor.isEditable &&
    focused &&
    selection instanceof TextSelection &&
    (!selection.empty || inLink) &&
    !selection.$from.parent.type.spec.code &&
    !slashState(state).active;
  return { show, key: `${show}:${selection.from}:${selection.to}:${state.doc.content.size}` };
}

function useSelectionSnapshot(editor: Editor): Snapshot {
  const cache = useRef<Snapshot>({ show: false, key: '' });
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
        focused.current = !!into && !!document.querySelector('.cgw-bubble')?.contains(into);
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
    [editor],
  );
  return useSyncExternalStore(subscribe, () => {
    const next = snapshot(editor, focused.current || editor.isFocused);
    if (next.key !== cache.current.key) cache.current = next;
    return cache.current;
  });
}

function Button({
  label,
  active,
  onPress,
  children,
  expanded,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  children: ReactNode;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="cgw-bubble-button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      aria-expanded={expanded}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

export function BubbleToolbar({
  editor: blockEditor,
  host,
}: {
  editor: BlockEditor;
  host: EditorHost;
}) {
  const editor = blockEditor.editor;
  const snap = useSelectionSnapshot(editor);
  const [panel, setPanel] = useState<Panel>(null);
  const [href, setHref] = useState('');
  const [invalid, setInvalid] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: -9999, left: -9999 });
  const s = host.strings;

  useLayoutEffect(() => {
    if (!snap.show) {
      setPanel(null);
      return;
    }
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const el = bar.current;
    const width = el?.offsetWidth ?? 320;
    const height = el?.offsetHeight ?? 36;
    const centre = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
    const top = start.top - height - 8 < 8 ? end.bottom + 8 : start.top - height - 8;
    const left = Math.max(8, Math.min(centre - width / 2, window.innerWidth - width - 8));
    setPlace({ top, left });
  }, [snap, editor, panel]);

  if (!snap.show || !s) return null;

  const mark = (name: string) => () => editor.chain().focus().toggleMark(name).run();
  const block = currentBlock(editor.state);
  const body = block && firstBody(block);
  const kindName = (() => {
    if (!body) return '';
    if (body.node.type.name === 'codeBlock') return 'code';
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
  })();

  const openLink = () => {
    setHref(String(editor.getAttributes('link').href ?? ''));
    setInvalid(false);
    setPanel(panel === 'link' ? null : 'link');
  };
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

  return (
    <div
      ref={bar}
      className="cgw-bubble"
      role="toolbar"
      aria-label={s.formatting}
      style={{ top: place.top, left: place.left }}
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
    >
      <div className="cgw-bubble-row">
        <Button
          label={s.turnInto}
          expanded={panel === 'turnInto'}
          onPress={() => setPanel(panel === 'turnInto' ? null : 'turnInto')}
        >
          <span className="cgw-bubble-kind">{kindName}</span> ▾
        </Button>
        <span className="cgw-bubble-sep" />
        <Button label={s.bold} active={editor.isActive('bold')} onPress={mark('bold')}>
          <CgIcon name="text-bold" />
        </Button>
        <Button label={s.italic} active={editor.isActive('italic')} onPress={mark('italic')}>
          <CgIcon name="text-italic" />
        </Button>
        <Button
          label={s.underline}
          active={editor.isActive('underline')}
          onPress={mark('underline')}
        >
          <CgIcon name="text-underline" />
        </Button>
        <Button label={s.strike} active={editor.isActive('strike')} onPress={mark('strike')}>
          <CgIcon name="text-strikethrough" />
        </Button>
        <Button label={s.code} active={editor.isActive('code')} onPress={mark('code')}>
          {'</>'}
        </Button>
        <Button
          label={s.link}
          active={editor.isActive('link')}
          expanded={panel === 'link'}
          onPress={openLink}
        >
          <CgIcon name="link" />
        </Button>
        <Button
          label={s.colour}
          expanded={panel === 'colour'}
          onPress={() => setPanel(panel === 'colour' ? null : 'colour')}
        >
          <CgIcon name="text-color" /> ▾
        </Button>
      </div>
      {panel === 'link' && (
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
              <Button
                label={s.openLink}
                onPress={() => host.openExternal?.(String(editor.getAttributes('link').href))}
              >
                ↗
              </Button>
              <Button
                label={s.removeLink}
                onPress={() => {
                  editor.chain().focus().extendMarkRange('link').unsetMark('link').run();
                  setPanel(null);
                }}
              >
                ✕
              </Button>
            </>
          )}
        </form>
      )}
      {panel === 'colour' && (
        <div className="cgw-bubble-colours">
          {(['textColour', 'highlight'] as const).map((type) => (
            <div
              key={type}
              className="cgw-bubble-swatches"
              role="group"
              aria-label={type === 'textColour' ? s.textColour : s.highlight}
            >
              <Button label={s.defaultColour} onPress={() => setColour(type, null)}>
                <span className="cgw-swatch" data-default="" />
              </Button>
              {COLOUR_TOKENS.map((token) => (
                <Button
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
                </Button>
              ))}
            </div>
          ))}
        </div>
      )}
      {panel === 'turnInto' && (
        <div className="cgw-bubble-menu" role="menu">
          {BLOCK_ACTIONS.filter((action) => action.turnInto).map((action) => (
            <button
              key={action.name}
              type="button"
              role="menuitem"
              className="cgw-bubble-menu-item"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                void action.apply(editor, host);
                setPanel(null);
              }}
            >
              <span className="cgw-command-glyph" aria-hidden="true">
                {action.glyph}
              </span>
              {host.blockName?.(action.name) ?? action.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
