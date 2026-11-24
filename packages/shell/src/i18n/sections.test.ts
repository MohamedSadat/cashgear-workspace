import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { groupsWords } from '../cloud/groupsWords';
import { passkeysWords } from '../cloud/passkeysWords';
import { offlineRowsWords } from '../cloud/offlineWords';
import { signOutWords } from '../cloud/signOutWords';
import { pluginNetworkWords } from '../plugins/networkWords';
import { aiPlanWords } from '../ai/planWords';
import { ssoWords } from '../cloud/ssoWords';
import { siteDomainsWords } from '../cloud/domainsWords';
import { automationsWords } from '../automations/words';
import { ar } from './ar';
import { flatten } from './catalogue';
import { en } from './en';
import { addSection, type Section } from './sections';

/** Every section a screen brings with it (sections.ts). */
const SECTIONS: Section[] = [
  groupsWords,
  passkeysWords,
  ssoWords,
  offlineRowsWords,
  signOutWords,
  pluginNetworkWords,
  aiPlanWords,
  siteDomainsWords,
  automationsWords,
];

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('sections of the catalogue loaded with their screens', () => {
  for (const words of SECTIONS) {
    const english = flatten(words.en);
    const arabic = flatten(words.ar);

    it(`${words.name}: has the same keys, no empty text and the same placeholders in both languages`, () => {
      expect([...arabic.keys()].sort()).toEqual([...english.keys()].sort());
      for (const [key, text] of [...english, ...arabic]) expect(text.trim(), key).not.toBe('');
      for (const [key, text] of english)
        expect(placeholders(arabic.get(key)!), key).toEqual(placeholders(text));
    });

    it(`${words.name}: translates every Arabic string`, () => {
      for (const [key, text] of arabic)
        expect(/[A-Za-z]/.test(text.replace(/\{\{\w+\}\}/g, '')), key).toBe(false);
    });

    it(`${words.name}: takes no key of the app's own catalogue`, () => {
      expect(Object.keys(en)).not.toContain(words.name);
    });
  }

  it('are merged once into an instance, in both languages, and read as the catalogue is', () => {
    // As createI18n makes the app's (which also sets <html>'s language).
    const i18n = i18next.createInstance();
    void i18n.init({
      lng: 'en',
      fallbackLng: false,
      resources: { en: { translation: en }, ar: { translation: ar } },
      interpolation: { escapeValue: false },
      initAsync: false,
    });
    expect(i18n.exists('groups.title')).toBe(false);
    addSection(i18n, groupsWords);
    addSection(i18n, groupsWords);
    expect(i18n.t('groups.title')).toBe('Groups');
    expect(i18n.t('groups.people', { number: '3' })).toBe('People: 3');
    void i18n.changeLanguage('ar');
    expect(i18n.t('groups.title')).toBe('المجموعات');
    // The app's own words are untouched.
    expect(i18n.t('sync.synced')).toBe('متزامن');
  });
});
