// A files cell's editor: the files by name (open, remove) and Upload, which stores each chosen
// file through the host (`assets.store`, as the editor's images do) and adds its id. Each upload
// and each removal is one write.
import { CgButton } from '@cashgear/ui';
import { useState } from 'react';
import type { DatabaseAssets } from '../host';
import { useDbT } from '../i18n';

export interface FilesEditorProps {
  ids: readonly string[];
  assets: DatabaseAssets | undefined;
  editable: boolean;
  onChange(ids: string[]): void;
}

export function FilesEditor({ ids, assets, editable, onChange }: FilesEditorProps) {
  const { t } = useDbT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const upload = async () => {
    if (!assets) return;
    setFailed(false);
    const files = await assets.pick([]);
    if (!files.length) return;
    setBusy(true);
    const added: string[] = [];
    for (const file of files) {
      try {
        const stored = await assets.store(file);
        if (stored) added.push(stored.assetId);
        else setFailed(true);
      } catch {
        setFailed(true);
      }
    }
    setBusy(false);
    if (added.length) onChange([...ids, ...added.filter((id) => !ids.includes(id))]);
  };

  return (
    <div className="cgw-files-editor">
      <ul className="cgw-files-list" aria-label={t('files.editor')}>
        {ids.map((id) => {
          const name = assets?.info(id)?.fileName ?? t('files.unknown');
          return (
            <li key={id} className="cgw-files-item">
              <button
                type="button"
                className="cgw-text-button cgw-files-name"
                dir="auto"
                aria-label={t('files.open', { name })}
                onClick={() => assets?.open(id)}
              >
                {name}
              </button>
              {editable ? (
                <button
                  type="button"
                  className="cgw-icon-button"
                  aria-label={t('files.remove', { name })}
                  onClick={() => onChange(ids.filter((x) => x !== id))}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </li>
          );
        })}
        {!ids.length ? <li className="cgw-picker-empty">{t('files.none')}</li> : null}
      </ul>
      {editable ? (
        assets ? (
          <CgButton
            appearance="outline"
            size="small"
            loading={busy}
            data-cg-initial-focus=""
            onClick={() => upload()}
          >
            {busy ? t('files.uploading') : t('files.upload')}
          </CgButton>
        ) : (
          <p className="cgw-picker-note">{t('files.noAssets')}</p>
        )
      ) : null}
      {failed ? (
        <p className="cgw-picker-note" role="alert">
          {t('files.failed')}
        </p>
      ) : null}
    </div>
  );
}
