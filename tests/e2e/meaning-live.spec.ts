// Phase 10's live check of search by meaning against the real Voyage AI (the definition of done:
// proven against the chosen embeddings provider). Skipped unless VOYAGE_API_KEY is set for
// Playwright and the e2e stack's API points at Voyage (start it with
// CGW_VOYAGE_BASE_URL=https://api.voyageai.com: scripts/server-stack.mjs). The key goes once to the
// workspace's settings, as an owner types it, and is removed at the end, which turns search by
// meaning off and deletes the workspace's vectors; it is never printed. meaning.spec.ts proves the
// same paths against the mock in every run.
import { expect, test, desktop } from './fixtures';
import { newAccount } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { signedInWorkspace } from './database';
import { workspaceIdOf } from './ecosystem';
import { MEANING, QUESTIONS, meaningTitles, writePage } from './meaning';

const KEY = process.env.VOYAGE_API_KEY;

test.skip(desktop || !KEY, 'Needs VOYAGE_API_KEY and the stack pointed at Voyage');

test('voyage-4 finds a page from a question sharing none of its words, in English, in Arabic and across the two, and the key leaves no trace', async ({
  page,
}) => {
  test.setTimeout(2400000);
  const account = await newAccount('Live meaning');
  await signedInWorkspace(page, account, 'Live meaning', null, async () => {
    throw new Error('The desktop is skipped');
  });
  const api = await apiSession(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Live meaning');
    await writePage(page, MEANING.refunds.title, [MEANING.refunds.text]);
    await writePage(page, MEANING.leave.title, [MEANING.leave.text]);
    await writePage(page, MEANING.other.title, [MEANING.other.text]);

    await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, {
      embeddings: { apiKey: KEY },
    });
    await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, {
      embeddings: { enabled: true },
    });
    const settings = (await api.get(`/api/v1/workspaces/${workspaceId}/ai-settings`)) as unknown;
    expect(JSON.stringify(settings)).not.toContain(KEY!);

    // English to English, Arabic to Arabic, and across the two; the unrelated page is never first.
    // A new Voyage account without a payment method takes about three requests a minute, so each
    // question is asked once every 21 s (a refused one answers 503 and is asked again).
    const finds = async (q: string, title: string) => {
      const end = Date.now() + 8 * 60000;
      for (;;) {
        const { status, titles } = await meaningTitles(api, workspaceId, q);
        if (status === 200 && titles.includes(title)) {
          expect(titles[0], q).not.toBe(MEANING.other.title);
          return titles;
        }
        if (Date.now() > end) throw new Error(`${q}: ${status} ${titles.join(' | ')}`);
        await page.waitForTimeout(21000);
      }
    };
    await finds(QUESTIONS.en, MEANING.refunds.title);
    await finds(QUESTIONS.ar, MEANING.leave.title);
    await finds(QUESTIONS.enToAr, MEANING.leave.title);
    await finds(QUESTIONS.arToEn, MEANING.refunds.title);
  } finally {
    // Removing the key turns search by meaning off and deletes the vectors.
    const id = await workspaceIdOf(api, 'Live meaning').catch(() => null);
    if (id) await api.put(`/api/v1/workspaces/${id}/ai-settings`, { embeddings: { apiKey: null } });
    await api.dispose();
  }
});
