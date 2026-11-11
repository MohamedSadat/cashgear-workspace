import type { Catalogue } from './catalogue';

// The Arabic catalogue. Same keys as `en.ts`; the type checks it.
export const ar: Catalogue = {
  app: {
    title: 'مساحة عمل كاش جير',
    loading: 'جارٍ التحميل…',
    version: 'الإصدار {{version}}',
  },
  language: {
    label: 'اللغة',
    en: 'English',
    ar: 'العربية',
  },
  theme: {
    label: 'المظهر',
    system: 'حسب النظام',
    light: 'فاتح',
    dark: 'داكن',
  },
  frame: {
    sidebar: 'الشريط الجانبي',
    main: 'الصفحة',
    collapseSidebar: 'إخفاء الشريط الجانبي',
    expandSidebar: 'إظهار الشريط الجانبي',
    openMenu: 'فتح القائمة',
    settings: 'الإعدادات',
    close: 'إغلاق',
    home: 'الرئيسية',
    emptyTitle: 'لا توجد صفحة مفتوحة',
    emptyBody: 'اختر صفحة من الشريط الجانبي أو أنشئ صفحة جديدة.',
    notFound: 'هذه الصفحة غير موجودة على هذا الجهاز.',
    platformWeb: 'الويب',
    platformDesktop: 'سطح المكتب',
  },
  settings: {
    title: 'الإعدادات',
    appearance: 'المظهر',
    about: 'حول التطبيق',
  },
  commands: {
    group: {
      navigation: 'التنقل',
      page: 'الصفحة',
      app: 'التطبيق',
    },
    toggleSidebar: 'إظهار الشريط الجانبي أو إخفاؤه',
    openSettings: 'فتح الإعدادات',
    themeLight: 'استخدام المظهر الفاتح',
    themeDark: 'استخدام المظهر الداكن',
    themeSystem: 'اتباع مظهر النظام',
    languageEnglish: 'التبديل إلى الإنجليزية',
    languageArabic: 'التبديل إلى العربية',
  },
  keywords: {
    sidebar: 'شريط جانبي لوحة شجرة',
    settings: 'إعدادات تفضيلات خيارات',
    theme: 'مظهر داكن فاتح لون ألوان',
    language: 'لغة إنجليزي عربي',
  },
};
