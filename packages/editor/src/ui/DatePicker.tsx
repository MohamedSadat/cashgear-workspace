// The date picker for a date mention (schema version 3): `@cashgear/ui`'s calendar in a flyout at
// the date, opened by a click on it or Enter on a selected one while the page is editable. The
// chosen day replaces the date (a calendar date: a time it held goes); an end before the new day
// goes too. Escape or a click elsewhere closes it and gives the editor its focus back.
import { CgCalendar, CgFlyout } from '@cashgear/ui';
import { isDateValue, localDate } from '@cgw/doc';
import type { Transaction } from '@tiptap/pm/state';
import { useCallback, useEffect, useRef, useState } from 'react';
import { localeOf } from '../dates';
import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';

interface Opened {
  anchor: HTMLElement;
  /** The day shown as chosen: the date's own day, or for an instant its day on this device. */
  day: string;
}

/** A date value's day on this device (`YYYY-MM-DD`). */
function dayOf(value: unknown): string {
  if (!isDateValue(value)) return localDate();
  if (value.length === 10) return value;
  return localDate(0, new Date(value));
}

export function DatePicker({
  editor: blockEditor,
  host,
}: {
  editor: BlockEditor;
  host: EditorHost;
}) {
  const editor = blockEditor.editor;
  const [opened, setOpened] = useState<Opened | null>(null);
  // Where the date is, followed through every change while the picker is open.
  const pos = useRef(-1);

  useEffect(() => {
    blockEditor.ui.openDatePicker = (at, anchor) => {
      pos.current = at;
      setOpened({ anchor, day: dayOf(editor.state.doc.nodeAt(at)?.attrs.date) });
    };
    return () => {
      blockEditor.ui.openDatePicker = null;
    };
  }, [blockEditor, editor]);

  const close = useCallback(
    (refocus: boolean) => {
      setOpened(null);
      pos.current = -1;
      if (refocus && !editor.isDestroyed) editor.commands.focus();
    },
    [editor],
  );

  useEffect(() => {
    if (!opened) return;
    const follow = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || pos.current < 0) return;
      const mapped = transaction.mapping.mapResult(pos.current, 1);
      if (mapped.deletedAfter) close(false);
      else pos.current = mapped.pos;
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [opened, editor, close]);

  if (!opened) return null;
  const choose = (day: string | null) => {
    const at = pos.current;
    const node = at >= 0 ? editor.state.doc.nodeAt(at) : null;
    if (day && node?.type.name === 'dateMention' && editor.isEditable) {
      const end = node.attrs.end;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(at, undefined, {
          ...node.attrs,
          date: day,
          end: isDateValue(end) && dayOf(end) >= day ? end : null,
        }),
      );
    }
    close(true);
  };
  const label = host.strings?.datePicker ?? '';
  return (
    <CgFlyout
      anchor={opened.anchor}
      open
      placement="bottom-start"
      maxHeight="calc(100vh - 8px)"
      className="cgw-date-picker"
      aria-label={label}
      role="dialog"
      onOpenChange={(open, details) => {
        if (!open) close(details.reason === 'escape');
      }}
    >
      <CgCalendar
        value={opened.day}
        locale={localeOf(host)}
        aria-label={label}
        autoFocus
        showClearButton={false}
        allowClear={false}
        onValueChange={(value) => choose(value)}
        onEscape={() => close(true)}
      />
    </CgFlyout>
  );
}
