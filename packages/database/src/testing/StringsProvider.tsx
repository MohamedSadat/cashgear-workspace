// The views' strings for a page that has no shell around it (the browser harness, tests): an
// i18next instance holding only this package's catalogues.
import { useMemo, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createDatabaseI18n } from '../i18n';

export function StringsProvider({
  language,
  children,
}: {
  language: 'en' | 'ar';
  children: ReactNode;
}) {
  const i18n = useMemo(() => createDatabaseI18n(language), [language]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
