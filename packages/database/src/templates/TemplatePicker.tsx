// The dialog the shell shows when a database is made (the sidebar's "New database", the editor's
// "Database" slash item): an empty database or one of the built-in templates, each with what it
// holds. Create applies the operations that make it through the host (planned on the device,
// then synced) and says which database and view were made, for the shell to open or to put in
// its block.
import { CgButton, CgPopup } from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { useId, useMemo, useState } from 'react';
import type { ViewType } from '../core';
import type { DatabaseHost } from '../host';
import { useDbT } from '../i18n';
import { viewType } from '../views/registry';
import {
  TEMPLATE_ICONS,
  TEMPLATE_IDS,
  makeDatabase,
  templateViews,
  type DatabasePlace,
  type MakeContext,
  type TemplateChoice,
} from './databaseTemplates';
import './templates.css';

export interface TemplatePickerProps {
  host: Pick<DatabaseHost, 'newId' | 'me' | 'queryContext' | 'apply'>;
  place: DatabasePlace;
  /** The database was made: its id and its first view's. */
  onCreated(made: { databaseId: Id; viewId: Id; title: string }): void;
  onCancel(): void;
  /** The choice selected at first (default: an empty database). */
  initial?: TemplateChoice;
}

const CHOICES: TemplateChoice[] = ['blank', ...TEMPLATE_IDS];

export function TemplatePicker({
  host,
  place,
  onCreated,
  onCancel,
  initial = 'blank',
}: TemplatePickerProps) {
  const { t } = useDbT();
  const id = useId();
  const [choice, setChoice] = useState<TemplateChoice>(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const context = (): MakeContext => {
    const ctx = host.queryContext();
    return {
      t,
      newId: () => host.newId(),
      me: host.me()?.id ?? null,
      today: ctx.today,
      offsetMinutes: ctx.offsetMinutes,
    };
  };
  // What each template's views are called, for the list (made once per language).
  const views = useMemo(() => {
    const ctx: MakeContext = {
      t,
      newId: () => '',
      me: null,
      today: '2026-01-01',
      offsetMinutes: 0,
    };
    return Object.fromEntries(CHOICES.map((c) => [c, templateViews(c, ctx)])) as Record<
      TemplateChoice,
      { name: string; type: ViewType }[]
    >;
  }, [t]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const made = makeDatabase(choice, place, context());
    try {
      await host.apply(made.ops);
      onCreated({ databaseId: made.databaseId, viewId: made.viewId, title: made.title });
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const name = (c: TemplateChoice) =>
    c === 'blank' ? t('templates.blank') : t(`templates.${c}.name`);
  const description = (c: TemplateChoice) =>
    c === 'blank' ? t('templates.blankDescription') : t(`templates.${c}.description`);

  return (
    <CgPopup
      open
      headerText={t('templates.title')}
      closeButtonAriaLabel={t('templates.close')}
      width="min(40rem, calc(100vw - 24px))"
      className="cgw-tpl-dialog"
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      footer={
        <div className="cgw-tpl-actions">
          {failed ? (
            <span className="cgw-tpl-error" role="alert">
              {t('templates.failed')}
            </span>
          ) : null}
          <CgButton appearance="ghost" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </CgButton>
          <CgButton intent="primary" onClick={() => void create()} disabled={busy}>
            {busy ? t('templates.creating') : t('templates.create')}
          </CgButton>
        </div>
      }
    >
      <div className="cgw-tpl" role="radiogroup" aria-label={t('templates.choose')}>
        {CHOICES.map((c) => (
          <label
            key={c}
            className="cgw-tpl-choice"
            data-checked={choice === c || undefined}
            onDoubleClick={() => {
              setChoice(c);
              void create();
            }}
          >
            <input
              type="radio"
              name={`${id}-template`}
              value={c}
              checked={choice === c}
              data-cg-initial-focus={choice === c ? '' : undefined}
              onChange={() => setChoice(c)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void create();
                }
              }}
            />
            <span className="cgw-tpl-icon" aria-hidden="true">
              {TEMPLATE_ICONS[c] ?? '▦'}
            </span>
            <span className="cgw-tpl-text">
              <span className="cgw-tpl-name">{name(c)}</span>
              <span className="cgw-tpl-description">{description(c)}</span>
              <span className="cgw-tpl-views">
                {views[c].map((v, i) => (
                  <span key={i} className="cgw-tpl-view">
                    <span aria-hidden="true">{viewType(v.type).glyph} </span>
                    {v.name}
                  </span>
                ))}
              </span>
            </span>
          </label>
        ))}
      </div>
    </CgPopup>
  );
}
