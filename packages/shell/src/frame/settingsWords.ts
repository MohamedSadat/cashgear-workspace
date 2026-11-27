// Settings' tabs (after 0.19.0, DECISIONS.md 2026-11-27): a section of the catalogue loaded with
// Settings, not with the app (`i18n/sections.ts`); `Settings` adds it before it draws.
import { section, type Strings } from '../i18n/sections';

export const settingsTabsEn = {
  label: 'Settings sections',
  previous: 'Earlier sections',
  next: 'Later sections',
  general: 'General',
  account: 'Account',
  members: 'Members',
  ai: 'AI',
  publishing: 'Publishing',
  integrations: 'Integrations',
  data: 'Data',
  showRecent: 'Show recent pages in the sidebar',
  // Settings' own words, here since 0.19.0 rather than in the start catalogues.
  appearance: 'Appearance',
  about: 'About',
  theme: 'Theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  platformWeb: 'Web',
  platformDesktop: 'Desktop',
  version: 'Version {{version}}',
  workbooksLink: 'See and manage the workspace’s workbooks',
};

const settingsTabsAr: Strings<typeof settingsTabsEn> = {
  label: 'أقسام الإعدادات',
  previous: 'الأقسام السابقة',
  next: 'الأقسام التالية',
  general: 'عام',
  account: 'الحساب',
  members: 'الأعضاء',
  ai: 'الذكاء الاصطناعي',
  publishing: 'النشر',
  integrations: 'التكاملات',
  data: 'البيانات',
  showRecent: 'إظهار الصفحات الأخيرة في الشريط الجانبي',
  appearance: 'المظهر',
  about: 'حول التطبيق',
  theme: 'المظهر',
  themeSystem: 'حسب النظام',
  themeLight: 'فاتح',
  themeDark: 'داكن',
  platformWeb: 'الويب',
  platformDesktop: 'سطح المكتب',
  version: 'الإصدار {{version}}',
  workbooksLink: 'عرض مصنفات مساحة العمل وإدارتها',
};

export const settingsTabsWords = section('settingsTabs', settingsTabsEn, settingsTabsAr);
