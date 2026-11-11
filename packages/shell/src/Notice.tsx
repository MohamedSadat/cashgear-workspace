import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/** A short notice at the bottom of the window: what happened, and a way to dismiss it. */
export function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const timer = window.setTimeout(onClose, 8000);
    return () => window.clearTimeout(timer);
  }, [text, onClose]);
  return (
    <div className="cgw-notice" role="alert">
      <span>{text}</span>
      <button type="button" className="cgw-link-button" onClick={onClose}>
        {t('frame.close')}
      </button>
    </div>
  );
}
