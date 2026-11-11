// The English catalogue. `ar.ts` must have exactly the same keys: its type is derived from this
// one, so a missing or extra key fails the typecheck, and `t()` only accepts keys that exist.
export const en = {
  app: {
    title: 'Cash Gear Workspace',
    loading: 'Loading…',
    version: 'Version {{version}}',
  },
  language: {
    label: 'Language',
    en: 'English',
    ar: 'العربية',
  },
  theme: {
    label: 'Theme',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
  },
  frame: {
    sidebar: 'Sidebar',
    main: 'Page',
    collapseSidebar: 'Hide the sidebar',
    expandSidebar: 'Show the sidebar',
    openMenu: 'Open the menu',
    settings: 'Settings',
    close: 'Close',
    home: 'Home',
    emptyTitle: 'No page is open',
    emptyBody: 'Choose a page in the sidebar, or create one.',
    notFound: 'This page does not exist on this device.',
    platformWeb: 'Web',
    platformDesktop: 'Desktop',
  },
  settings: {
    title: 'Settings',
    appearance: 'Appearance',
    about: 'About',
  },
  commands: {
    group: {
      navigation: 'Navigation',
      page: 'Page',
      app: 'App',
    },
    toggleSidebar: 'Show or hide the sidebar',
    openSettings: 'Open settings',
    themeLight: 'Use the light theme',
    themeDark: 'Use the dark theme',
    themeSystem: 'Follow the system theme',
    languageEnglish: 'Switch to English',
    languageArabic: 'Switch to Arabic',
  },
  keywords: {
    sidebar: 'sidebar panel tree',
    settings: 'settings preferences options',
    theme: 'theme dark light colour color appearance',
    language: 'language english arabic',
  },
} as const;
