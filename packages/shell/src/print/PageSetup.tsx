// Phase 19, M19.1: Page setup, from a page's (or a row's) menu: the page's layout, which every
// reader prints by and the Word file's section takes. Paper, orientation and margins; a header and
// a footer of three places each, in which the fields are typed or inserted by their buttons; the
// default layout again. Whoever may edit the page changes it (the server checks again); anyone
// else sees it. Its words are the `print` section, loaded with it.
import { CgRadioGroup } from '@cashgear/ui';
import type { PageRecord, RowRecord } from '@cgw/workspace';
import {
  BAND_PLACES,
  LAYOUT_FIELDS,
  MAX_BAND_TEXT,
  bandParts,
  checkLayout,
  readLayout,
  withLayout,
  type BandPlace,
  type LayoutField,
  type PageLayout,
  type PageMargins,
  type PageOrientation,
  type PageSize,
} from '@cgw/workspace/layout';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import { useSection } from '../i18n/sections';
import { NAMES, printWords } from './words';
import './print.css';

type Band = 'header' | 'footer';

const FIELD_WORD: Record<LayoutField, string> = {
  title: 'print.setup.fieldTitle',
  date: 'print.setup.fieldDate',
  page: 'print.setup.fieldPage',
  pages: 'print.setup.fieldPages',
};

export function PageSetup({
  page,
  editable,
  onSave,
  onClose,
}: {
  page: PageRecord | RowRecord;
  editable: boolean;
  /** Saves the page's layout (null: the default again); rejects when it could not be. */
  onSave: (layout: Record<string, unknown> | null) => Promise<void>;
  onClose: () => void;
}) {
  useSection(printWords);
  const { t } = useTranslation();
  const [layout, setLayout] = useState<PageLayout>(() => readLayout(page.layout));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The place a field button puts its field in: the last one chosen, else the footer's centre.
  const last = useRef<{ band: Band; place: BandPlace; input: HTMLInputElement | null }>({
    band: 'footer',
    place: 'center',
    input: null,
  });
  const change = (part: Partial<PageLayout>) => setLayout((now) => ({ ...now, ...part }));
  const setPlace = (band: Band, place: BandPlace, text: string) =>
    setLayout((now) => ({ ...now, [band]: { ...now[band], [place]: text } }));

  const insert = (field: LayoutField) => {
    const { band, place, input } = last.current;
    const token = `{${field}}`;
    const text = layout[band][place];
    const at =
      input && document.activeElement !== input
        ? (input.selectionStart ?? text.length)
        : text.length;
    const end = input ? (input.selectionEnd ?? at) : at;
    const next = `${text.slice(0, at)}${token}${text.slice(end)}`.slice(0, MAX_BAND_TEXT);
    setPlace(band, place, next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const save = async (next: Record<string, unknown> | null) => {
    if (next && checkLayout(next))
      return setError(t('print.setup.tooLong', { number: MAX_BAND_TEXT }));
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch {
      setError(t('print.setup.failed'));
      setBusy(false);
    }
  };

  const places: Record<BandPlace, string> = {
    start: t('print.setup.start'),
    center: t('print.setup.center'),
    end: t('print.setup.end'),
  };
  const band = (name: Band) => (
    <fieldset className="cgw-print-band" key={name}>
      <legend>{t(`print.setup.${name}`)}</legend>
      <div className="cgw-print-places">
        {BAND_PLACES.map((place) => (
          <label key={place} className="cgw-print-place">
            <span>{places[place]}</span>
            <input
              className="cgw-input"
              dir="auto"
              value={layout[name][place]}
              maxLength={MAX_BAND_TEXT}
              disabled={!editable || busy}
              aria-label={t('print.setup.placeLabel', {
                band: t(`print.setup.${name}`),
                place: places[place],
              })}
              data-testid={`layout-${name}-${place}`}
              onFocus={(event) =>
                (last.current = { band: name, place, input: event.currentTarget })
              }
              onChange={(event) =>
                setPlace(name, place, event.currentTarget.value.replace(/\p{Cc}/gu, ' '))
              }
            />
          </label>
        ))}
      </div>
    </fieldset>
  );

  // What the first page's foot reads, its fields as the first page fills them.
  const footer = BAND_PLACES.map((place) =>
    bandParts(layout.footer[place])
      .map((part) =>
        'text' in part
          ? part.text
          : part.field === 'title'
            ? page.title || t('print.words.untitled')
            : part.field === 'date'
              ? new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
                  dateStyle: 'medium',
                }).format(new Date())
              : '1',
      )
      .join(''),
  )
    .filter((text) => text.trim())
    .join(' · ');

  return (
    <Dialog title={t('print.setup.title')} onClose={onClose}>
      <div className="cgw-print-setup" data-testid="page-setup">
        <p className="cgw-muted">{t('print.setup.intro', { word: NAMES.word })}</p>
        {!editable && (
          <p className="cgw-muted" role="note">
            {t('print.setup.readOnly')}
          </p>
        )}
        <div className="cgw-print-choices">
          <CgRadioGroup<PageSize>
            legend={t('print.setup.paper')}
            value={layout.size}
            disabled={!editable || busy}
            onValueChange={(size) => change({ size })}
            options={[
              { value: 'a4', label: NAMES.papers.a4 },
              { value: 'letter', label: NAMES.papers.letter },
            ]}
          />
          <CgRadioGroup<PageOrientation>
            legend={t('print.setup.orientation')}
            value={layout.orientation}
            disabled={!editable || busy}
            onValueChange={(orientation) => change({ orientation })}
            options={[
              { value: 'portrait', label: t('print.setup.portrait') },
              { value: 'landscape', label: t('print.setup.landscape') },
            ]}
          />
          <CgRadioGroup<PageMargins>
            legend={t('print.setup.margins')}
            value={layout.margins}
            disabled={!editable || busy}
            onValueChange={(margins) => change({ margins })}
            options={[
              { value: 'narrow', label: t('print.setup.narrow') },
              { value: 'normal', label: t('print.setup.normal') },
              { value: 'wide', label: t('print.setup.wide') },
            ]}
          />
        </div>
        {band('header')}
        {band('footer')}
        {editable && (
          <div className="cgw-print-fields" role="group" aria-label={t('print.setup.insert')}>
            <span className="cgw-muted">{t('print.setup.insert')}</span>
            {LAYOUT_FIELDS.map((field) => (
              <button
                key={field}
                type="button"
                className="cgw-button"
                disabled={busy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(field)}
              >
                {t(FIELD_WORD[field] as 'print.setup.fieldTitle')}
              </button>
            ))}
          </div>
        )}
        <p className="cgw-muted cgw-print-note">{t('print.setup.fieldsNote', NAMES.fields)}</p>
        <p className="cgw-print-preview" dir="auto" data-testid="layout-preview">
          {footer
            ? t('print.setup.preview', { footer })
            : BAND_PLACES.some((p) => layout.header[p].trim())
              ? null
              : t('print.setup.previewNone')}
        </p>
        {error && (
          <p className="cgw-print-error" role="alert">
            {error}
          </p>
        )}
        <div className="cgw-dialog-buttons">
          {editable && (
            <button
              type="button"
              className="cgw-button"
              disabled={busy}
              onClick={() => void save(null)}
            >
              {t('print.setup.reset')}
            </button>
          )}
          <button type="button" className="cgw-button" onClick={onClose}>
            {t('print.setup.cancel')}
          </button>
          {editable && (
            <button
              type="button"
              className="cgw-button is-primary"
              disabled={busy}
              onClick={() => void save(withLayout(page.layout, layout))}
            >
              {t('print.setup.save')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
