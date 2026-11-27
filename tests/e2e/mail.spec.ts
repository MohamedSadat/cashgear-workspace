// Phase 8, M8.5: mail for mentions and replies, against the e2e server stack (scripts/
// server-stack.mjs --e2e mails a mention once it has been unread 5 s, Mail__NotificationDelaySeconds),
// read from its pickup folder (.cgw-dev/e2e/mail). A person mentioned while away gets one mail in
// their language that opens the block; none for a page they can no longer read; none once they have
// read it in the app; one click (the List-Unsubscribe-Post address) turns mail off; with mail off
// nothing is sent. The settings' section in English and Arabic, and Axe on it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, desktop } from './fixtures';
import { editor } from './helpers';
import { API } from './cloud';
import { restrict, sharedPage, sleep, team, type Team } from './collab';

test.skip(desktop, 'Two people in browser profiles of their own');

const MAIL = join(resolve(import.meta.dirname, '../..'), '.cgw-dev/e2e/mail');
/** The stack's delay (5 s) and the worker's loops, with room to spare. */
const WAIT = 20_000;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Mail {
  file: string;
  to: string;
  subject: string;
  headers: Map<string, string>;
  text: string;
  html: string;
}

/** RFC 2047 words (=?utf-8?b?...?= and ?q?) in a header, decoded. */
function words(value: string) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, kind: string, data: string) =>
      kind.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64').toString('utf8')
        : Buffer.from(
            data
              .replace(/_/g, ' ')
              .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
                String.fromCharCode(parseInt(hex, 16)),
              ),
            'latin1',
          ).toString('utf8'),
    );
}

/** A body part decoded by its transfer encoding. */
function decode(part: string) {
  const split = part.search(/\r?\n\r?\n/);
  const head = part.slice(0, split);
  const body = part.slice(split).trim();
  if (/content-transfer-encoding:\s*base64/i.test(head))
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head))
    return Buffer.from(
      body
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      'latin1',
    ).toString('utf8');
  return body;
}

/** The notification mails (those with a List-Unsubscribe header) to an address, parsed. */
function notificationMails(address: string): Mail[] {
  let files: string[];
  try {
    files = readdirSync(MAIL).filter((f) => f.endsWith('.eml'));
  } catch {
    // The folder appears with the first mail.
    return [];
  }
  const out: Mail[] = [];
  for (const file of files.sort()) {
    let raw: string;
    try {
      raw = readFileSync(join(MAIL, file), 'utf8');
    } catch {
      continue;
    }
    const top = raw.slice(0, raw.search(/\r?\n\r?\n/)).replace(/\r?\n[ \t]+/g, ' ');
    const headers = new Map<string, string>();
    for (const line of top.split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at > 0) headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
    }
    const to = headers.get('to') ?? '';
    if (!to.toLowerCase().includes(address.toLowerCase()) || !headers.has('list-unsubscribe'))
      continue;
    const boundary = /boundary="?([^";]+)"?/i.exec(headers.get('content-type') ?? '')?.[1];
    const parts = boundary ? raw.split(`--${boundary}`).slice(1, -1) : [raw];
    const text = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    const html = parts.find((p) => /content-type:\s*text\/html/i.test(p));
    out.push({
      file,
      to,
      subject: words(headers.get('subject') ?? ''),
      headers,
      text: text ? decode(text) : '',
      html: html ? decode(html) : '',
    });
  }
  return out;
}

async function waitForMail(address: string, count = 1) {
  await expect.poll(() => notificationMails(address).length, { timeout: 60_000 }).toBe(count);
  return notificationMails(address);
}

/** A UUIDv7, as the app makes its ids: the comment routes take no other. */
function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The owner's comment on a block, naming the team's first member. */
async function mention(t: Team, pageId: string, blockId: string, text: string) {
  await t.owner.api.post(`/api/v1/pages/${pageId}/comments/threads`, {
    id: uuidv7(),
    blockId,
    anchor: { start: null, end: null },
    quote: '',
    comment: {
      id: uuidv7(),
      body: [
        { type: 'text', text },
        { type: 'userMention', attrs: { userId: t.members[0]!.id } },
      ],
    },
  });
}

let current: Team | null = null;
test.afterEach(async () => {
  await current?.close();
  current = null;
});

test('a person mentioned while away gets one mail in their language that opens the block', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const t = (current = await team(page, browser, ['Olive', 'Mona']));
  const mona = t.members[0]!;
  await mona.api.patch('/api/v1/account/me', { locale: 'ar' });
  const { pageId, ids } = await sharedPage(t, 'الميزانية', ['First line', 'Totals are here']);
  // Mona is away: her page is elsewhere.
  await mona.page.goto('about:blank');
  await mention(t, pageId, ids[1]!, 'راجعي الأرقام ');

  const [mail] = await waitForMail(mona.account.email);
  expect(mail!.subject).toContain('Olive');
  expect(mail!.subject).toContain('الميزانية');
  expect(mail!.html).toContain('<html lang="ar" dir="rtl">');
  expect(mail!.html).toContain('راجعي الأرقام @');
  expect(mail!.text).toContain('راجعي الأرقام @');
  expect(mail!.headers.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
  expect(mail!.headers.get('list-unsubscribe')).toMatch(
    /^<http:\/\/127\.0\.0\.1:5280\/mail\/unsubscribe\?token=[^>]+>$/,
  );
  // Its link opens the page at the block.
  const open = /http:\/\/127\.0\.0\.1:4273\/#\/p\/[0-9a-f-]{36}\/[0-9A-Za-z]{12}/.exec(
    mail!.text,
  )![0];
  expect(open).toBe(`http://127.0.0.1:4273/#/p/${pageId}/${ids[1]}`);
  await mona.page.goto(open);
  await expect(editor(mona.page).locator(`[data-block-id="${ids[1]}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(editor(mona.page)).toContainText('Totals are here');

  // Once: however long the worker runs, no second mail for it.
  await sleep(WAIT);
  expect(notificationMails(mona.account.email)).toHaveLength(1);
});

test('none for a page they can no longer read, and none once read in the app', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const t = (current = await team(page, browser, ['Olive', 'Ben']));
  const ben = t.members[0]!;
  const lost = await sharedPage(t, 'Taken away', ['Secret plans']);
  await mention(t, lost.pageId, lost.ids[0]!, 'Look ');
  // Taken from Ben before the delay is out.
  await restrict(t, lost.pageId, []);
  const read = await sharedPage(t, 'Read in the app', ['Seen already']);
  await mention(t, read.pageId, read.ids[0]!, 'And this ');
  // Ben reads it at once (the inbox's own call).
  await ben.api.post('/api/v1/account/notifications/read', { all: true });
  await sleep(WAIT);
  expect(notificationMails(ben.account.email)).toHaveLength(0);
});

test('one click in the mail turns mail off, and with mail off nothing is sent', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const t = (current = await team(page, browser, ['Olive', 'Cleo']));
  const cleo = t.members[0]!;
  // The page reaches Cleo's sidebar first (sharedPage opens it there); then she is away.
  const { pageId, ids } = await sharedPage(t, 'Plans', ['A line']);
  await cleo.page.goto('about:blank');
  await mention(t, pageId, ids[0]!, 'First ');
  const [mail] = await waitForMail(cleo.account.email);
  const address = /^<([^>]+)>$/.exec(mail!.headers.get('list-unsubscribe')!)![1]!;
  // What a mail client sends (RFC 8058): no cookie, no sign-in.
  const click = await fetch(address, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  expect(click.status).toBe(200);
  expect(
    ((await cleo.api.get('/api/v1/account/notification-settings')) as { email: string }).email,
  ).toBe('off');
  await mention(t, pageId, ids[0]!, 'Second ');
  await sleep(WAIT);
  expect(notificationMails(cleo.account.email)).toHaveLength(1);
  // A forged token answers the same and changes nothing.
  const forged = await fetch(`${API}/api/v1/mail/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'not-a-token' }),
  });
  expect(forged.status).toBe(204);
});

test('the mail settings: on, a daily summary or off, in English and Arabic, and Axe', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const t = (current = await team(page, browser, ['Olive']));
  await page.goto('/#/settings/account');
  const section = page.getByTestId('mail-settings');
  await expect(section.getByRole('heading', { name: 'Email notifications' })).toBeVisible();
  const group = section.getByRole('group', { name: 'Send me mail' });
  await expect(group.getByRole('radio', { name: /For each mention and reply/ })).toBeChecked();
  await group.getByRole('radio', { name: 'A daily summary' }).check();
  await expect(section.getByTestId('mail-settings-status')).toHaveText('Saved.');
  expect(
    ((await t.owner.api.get('/api/v1/account/notification-settings')) as { email: string }).email,
  ).toBe('digest');
  const english = await new AxeBuilder({ page })
    .include('[data-testid="mail-settings"]')
    .withTags(WCAG)
    .analyze();
  expect(english.violations.map((v) => v.id)).toEqual([]);

  await page.getByRole('radio', { name: 'العربية' }).check();
  await expect(section.getByRole('heading', { name: 'إشعارات البريد الإلكتروني' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(section.getByRole('radio', { name: 'ملخصًا يوميًا' })).toBeChecked();
  await section.getByRole('radio', { name: 'لا ترسل' }).check();
  await expect(section.getByTestId('mail-settings-status')).toHaveText('تم الحفظ.');
  const arabic = await new AxeBuilder({ page })
    .include('[data-testid="mail-settings"]')
    .withTags(WCAG)
    .analyze();
  expect(arabic.violations.map((v) => v.id)).toEqual([]);
  // Kept across a reload.
  await page.reload();
  await expect(
    page.getByTestId('mail-settings').getByRole('radio', { name: 'لا ترسل' }),
  ).toBeChecked({ timeout: 30_000 });
});
