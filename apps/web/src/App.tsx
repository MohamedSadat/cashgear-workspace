import { useEffect, useLayoutEffect, useState } from 'react';
import { CgRadioGroup } from '@cashgear/ui';
import type { Theme, WorkspacePlatform } from './platform/platform';
import { directionOf, strings, type Language } from './strings';

const systemTheme = (): Theme =>
  matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

export function App({ platform }: { platform: WorkspacePlatform }) {
  const [theme, setTheme] = useState<Theme>(systemTheme);
  const [language, setLanguage] = useState<Language>('en');
  const text = strings[language];

  // Theme and direction live on <html>, so every control below follows them (D24).
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.dataset.cgTheme = theme;
    html.lang = language;
    html.dir = directionOf(language);
    document.title = text.title;
  }, [theme, language, text.title]);

  useEffect(() => {
    platform
      .setWindowTheme(theme)
      .catch((error: unknown) => console.warn('The window theme was not set:', error));
  }, [platform, theme]);

  return (
    <main className="cgw-scaffold">
      <h1>{text.title}</h1>
      <p>{text.intro}</p>
      <p data-testid="host-info">{text.host(platform.kind, __CGW_VERSION__)}</p>
      <CgRadioGroup<Theme>
        legend={text.theme}
        orientation="horizontal"
        value={theme}
        onValueChange={setTheme}
        options={[
          { value: 'light', label: text.light },
          { value: 'dark', label: text.dark },
        ]}
      />
      <CgRadioGroup<Language>
        legend={text.language}
        orientation="horizontal"
        value={language}
        onValueChange={setLanguage}
        options={[
          { value: 'en', label: <span lang="en">English</span> },
          { value: 'ar', label: <span lang="ar">العربية</span> },
        ]}
      />
    </main>
  );
}
