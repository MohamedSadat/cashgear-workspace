// The form view (Phase 16, M16.1): a database's properties as questions, answered as rows. Who can
// edit the database answers it here (offline too: the row goes through the outbox like any other,
// marked by its form) and edits its questions; everyone else reads them. "Share form" is its link
// (`FormShare`), kept by the server. It reads no rows: its count of answers is the server's.
import { CgButton } from '@cashgear/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CellFlyout } from '../../cells/CellFlyout';
import { useDatabaseContext } from '../../context';
import type { FormState } from '../../host';
import type { ViewProps } from '../types';
import { formOf, withForm } from './config';
import { FormAnswer } from './FormAnswer';
import { FormBuilder } from './FormBuilder';
import { FormShare } from './FormShare';
import { useFormT } from './words';
import './form.css';

export function FormView({ database, view }: ViewProps) {
  const { host, actions, editable } = useDatabaseContext();
  const { ft } = useFormT();
  const form = useMemo(() => formOf(view, database, 'app'), [view, database]);
  const asks = form.pages.some((p) => p.questions.length > 0);
  const [mode, setMode] = useState<'edit' | 'answer'>(() =>
    editable && !asks ? 'edit' : 'answer',
  );
  const [share, setShare] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<FormState | null>(null);
  const forms = host.forms;
  const title = form.title || view.name || ft('untitled');

  const read = useCallback(() => {
    if (!forms?.online()) return;
    forms.state(database.id, view.id).then(setState, () => undefined);
  }, [forms, database.id, view.id]);
  useEffect(read, [read]);

  return (
    <div className="cgw-db-form" data-form-view={view.id} dir="auto">
      <div className="cgw-db-form-bar">
        {editable ? (
          <div className="cgw-db-form-modes" role="group" aria-label={ft('modes')}>
            <CgButton
              size="small"
              appearance={mode === 'edit' ? 'solid' : 'ghost'}
              aria-pressed={mode === 'edit'}
              onClick={() => setMode('edit')}
            >
              {ft('editMode')}
            </CgButton>
            <CgButton
              size="small"
              appearance={mode === 'answer' ? 'solid' : 'ghost'}
              aria-pressed={mode === 'answer'}
              onClick={() => setMode('answer')}
            >
              {ft('answerMode')}
            </CgButton>
          </div>
        ) : null}
        {state ? (
          <span className="cgw-db-form-count" data-answers={state.answers}>
            {ft('answers', { number: state.answers })}
          </span>
        ) : null}
        {forms ? (
          <CgButton
            appearance="outline"
            size="small"
            aria-haspopup="dialog"
            onClick={(event) => setShare(event.currentTarget)}
          >
            {ft('share.button')}
          </CgButton>
        ) : null}
      </div>
      {mode === 'edit' && editable ? (
        <FormBuilder
          database={database}
          form={form}
          onChange={(next) => void actions.updateView(view, withForm(database, view.config, next))}
        />
      ) : (
        <FormAnswer
          key={view.id}
          database={database}
          form={form}
          title={title}
          disabled={!editable}
          onSubmit={async (answer) => {
            const id = await actions.createRow({
              title: answer.title,
              values: answer.values,
              formId: view.id,
            });
            if (!id) throw new Error('not.found');
            read();
          }}
        />
      )}
      {share && forms ? (
        <CellFlyout
          anchor={share}
          label={ft('share.title')}
          width="min(380px, calc(100vw - 16px))"
          className="cgw-db-panel-flyout"
          onClose={() => setShare(null)}
        >
          <FormShare forms={forms} view={view} onChange={setState} />
        </CellFlyout>
      ) : null}
    </div>
  );
}
