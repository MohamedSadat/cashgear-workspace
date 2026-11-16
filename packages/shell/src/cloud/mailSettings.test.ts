// Phase 8, M8.5: the account's mail choice in Settings. It reads the choice, writes each new one,
// puts the saved one back when a write fails, ignores a late answer to an older write, and reads
// in English and Arabic.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createI18n } = await import('../i18n');
const { MailSettingsSection } = await import('./MailSettings');
type MailMode = import('./MailSettings').MailMode;
type MailSettingsApi = import('./MailSettings').MailSettingsApi;

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(api: MailSettingsApi, language: 'en' | 'ar' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      h(I18nextProvider, { i18n: createI18n(language) }, h(MailSettingsSection, { api })),
    ),
  );
  return container;
}

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 200 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

/** A fake server: the choice it holds, what it was asked, and writes the test can hold back. */
function fakeApi(initial: MailMode = 'on') {
  let held = initial;
  const writes: MailMode[] = [];
  const gates: { mode: MailMode; release: (ok: boolean) => void }[] = [];
  let hold = false;
  const api: MailSettingsApi = {
    notificationSettings: () => Promise.resolve({ email: held }),
    setNotificationSettings: (email) => {
      writes.push(email);
      if (!hold) {
        held = email;
        return Promise.resolve({ email });
      }
      return new Promise((resolve, reject) =>
        gates.push({
          mode: email,
          release: (ok) => {
            if (!ok) return reject(new Error('refused'));
            held = email;
            resolve({ email });
          },
        }),
      );
    },
  };
  return {
    api,
    writes,
    gates,
    hold: (on: boolean) => {
      hold = on;
    },
    held: () => held,
  };
}

const radio = (container: HTMLElement, value: MailMode) =>
  container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
const status = (container: HTMLElement) =>
  container.querySelector('[data-testid="mail-settings-status"]')!.textContent;

describe('mail settings', () => {
  it('shows the saved choice and writes a new one', async () => {
    const fake = fakeApi('on');
    const container = render(fake.api);
    await until(() => !!radio(container, 'on'), 'the choices');
    expect(radio(container, 'on').checked).toBe(true);
    expect(container.querySelector('h3')!.textContent).toBe('Email notifications');
    expect(container.querySelector('legend')!.textContent).toBe('Send me mail');
    const labels = [...container.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toEqual([
      'For each mention and reply, at most every 15 minutes',
      'A daily summary',
      'Off',
    ]);
    // The intro describes the group for screen readers.
    expect(container.querySelector('fieldset')!.getAttribute('aria-describedby')).toContain(
      'cgw-mail-intro',
    );

    act(() => radio(container, 'digest').click());
    await until(() => status(container) === 'Saved.', 'the save');
    expect(fake.writes).toEqual(['digest']);
    expect(fake.held()).toBe('digest');
    expect(radio(container, 'digest').checked).toBe(true);
  });

  it('puts the saved choice back when a write fails, and a late answer changes nothing', async () => {
    const fake = fakeApi('digest');
    const container = render(fake.api);
    await until(() => !!radio(container, 'digest'), 'the choices');
    fake.hold(true);
    act(() => radio(container, 'off').click());
    expect(status(container)).toBe('Saving…');
    expect(radio(container, 'off').checked).toBe(true);
    await act(async () => fake.gates.shift()!.release(false));
    await until(() => status(container) === 'Your choice was not saved. Try again.', 'the failure');
    expect(radio(container, 'digest').checked).toBe(true);

    // Two writes at once: the newer one's answer stands, whatever comes after it.
    act(() => radio(container, 'off').click());
    act(() => radio(container, 'on').click());
    const [older, newer] = fake.gates.splice(0);
    await act(async () => newer!.release(true));
    await until(() => status(container) === 'Saved.', 'the newer save');
    await act(async () => older!.release(false));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(status(container)).toBe('Saved.');
    expect(radio(container, 'on').checked).toBe(true);
  });

  it('says when the settings cannot be read, and reads them again', async () => {
    const fake = fakeApi('off');
    let fail = true;
    const api: MailSettingsApi = {
      ...fake.api,
      notificationSettings: () =>
        fail ? Promise.reject(new Error('offline')) : fake.api.notificationSettings(),
    };
    const container = render(api);
    await until(() => !!container.querySelector('[role="alert"]'), 'the alert');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'Your mail settings could not be read.',
    );
    fail = false;
    act(() => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    await until(() => !!radio(container, 'off'), 'the choices');
    expect(radio(container, 'off').checked).toBe(true);
  });

  it('reads in Arabic', async () => {
    const container = render(fakeApi('on').api, 'ar');
    await until(() => !!radio(container, 'on'), 'the choices');
    expect(container.querySelector('h3')!.textContent).toBe('إشعارات البريد الإلكتروني');
    expect([...container.querySelectorAll('label')].map((l) => l.textContent)).toEqual([
      'عن كل إشارة وردّ، مرة كل ١٥ دقيقة على الأكثر',
      'ملخصًا يوميًا',
      'لا ترسل',
    ]);
    for (const text of [...container.querySelectorAll('label')].map((l) => l.textContent ?? ''))
      expect(text).toMatch(/\p{Script=Arabic}/u);
  });
});
