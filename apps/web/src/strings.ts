/** The scaffold's two catalogues. Phase 1 replaces them with i18next (D24). */
export type Language = 'en' | 'ar';

export interface Strings {
  title: string;
  intro: string;
  host: (kind: 'web' | 'desktop', version: string) => string;
  theme: string;
  light: string;
  dark: string;
  language: string;
}

export const strings: Record<Language, Strings> = {
  en: {
    title: 'Cash Gear Workspace',
    intro: 'Pages, blocks and databases for the Cash Gear ecosystem.',
    host: (kind, version) => `${kind === 'desktop' ? 'Desktop' : 'Web'} ${version}`,
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    language: 'Language',
  },
  ar: {
    title: 'مساحة عمل كاش جير',
    intro: 'صفحات وكتل وقواعد بيانات لمنظومة كاش جير.',
    host: (kind, version) => `${kind === 'desktop' ? 'سطح المكتب' : 'الويب'} ${version}`,
    theme: 'المظهر',
    light: 'فاتح',
    dark: 'داكن',
    language: 'اللغة',
  },
};

export const directionOf = (language: Language): 'ltr' | 'rtl' =>
  language === 'ar' ? 'rtl' : 'ltr';
