// Phase 10's search by meaning for the specs (meaning.spec.ts, and the accessibility and Arabic
// walks): the mock Voyage AI provider's record of what it was sent (tests/mocks/ai, `POST
// /v1/embeddings`, its concept lexicon in `embeddings.mjs`), pages and questions that share no word
// but share their concepts, in English and Arabic, search by meaning turned on as an owner does,
// and a scene with the palette's "Related by meaning" and Settings' part of it on screen.
import type { Browser, Page } from '@playwright/test';
import { expect } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { signedInWorkspace } from './database';
import { sessionOf, workspaceIdOf, type Api } from './ecosystem';
import { aiAr, aiEn } from '../../packages/shell/src/ai/i18n';

export const MOCK_AI = process.env.CGW_MOCK_AI_URL ?? 'http://127.0.0.1:4286';
/** The workspace's (mock) Voyage AI key: the mock records only its hash. */
export const VOYAGE_KEY = 'pa-mock-voyage-e2e-key-0001';
/** The workspace's (mock) Anthropic key, for `ask`. */
export const ANTHROPIC_KEY = 'sk-mock-phase10-meaning-key-0001';

export interface EmbeddingCall {
  keyId: string | null;
  model: string | null;
  inputType: 'document' | 'query' | null;
  outputDtype: string | null;
  count: number;
  inputs: string[];
}

/** The mock provider's controls and its record of the embeddings asked for. */
export const mockEmbeddings = {
  reset: async () => void (await fetch(`${MOCK_AI}/__mock/reset`, { method: 'POST' })),
  calls: async () =>
    ((await (await fetch(`${MOCK_AI}/__mock/embeddings`)).json()) as { calls: EmbeddingCall[] })
      .calls,
};

/**
 * Pages and questions: no question shares a word with the page it means (the mock's stop words
 * aside), only its concepts (refund, customer, money, damage; vacation, employee).
 */
export const MEANING = {
  refunds: {
    title: 'Reimbursement guidelines',
    text: 'Clients who return faulty goods receive their funds within ten days.',
  },
  leave: { title: 'سياسة الإجازات', text: 'يحصل كل موظف على إجازة سنوية مدفوعة.' },
  /** For a page the person may not read: the refunds' concepts too. */
  hidden: {
    title: 'Private reimbursement notes',
    text: 'Faulty goods returned by clients: funds kept aside for the board.',
  },
  /** A page with none of the questions' concepts. */
  other: { title: 'Garage spaces', text: 'Cars park in the garage behind the office.' },
};
export const QUESTIONS = {
  /** English, for the English page. */
  en: 'How do buyers obtain a refund for a broken product?',
  /** Arabic, for the Arabic page. */
  ar: 'ما عدد أيام العطلة للعمال؟',
  /** English, for the Arabic page. */
  enToAr: 'When can staff take a holiday?',
  /** Arabic, for the English page. */
  arToEn: 'كيف يسترد الزبائن أموالهم عن البضاعة التالفة؟',
};

/** A page with this title and lines, typed, saved and synced; its id. */
export async function writePage(page: Page, title: string, lines: string[]) {
  await newPage(page, title);
  await editor(page).click();
  for (const [index, line] of lines.entries()) {
    if (index) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1]!;
}

/** Search by meaning turned on through the API, as an owner does in Settings. */
export async function embeddingsOn(api: Api, workspaceId: string) {
  await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, {
    embeddings: { apiKey: VOYAGE_KEY },
  });
  await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, {
    embeddings: { enabled: true },
  });
}

/** The titles the meaning route answers for `api`'s person; its status when it refuses. */
export async function meaningTitles(api: Api, workspaceId: string, q: string) {
  const answer = await api.raw(
    `/api/v1/workspaces/${workspaceId}/search/meaning?q=${encodeURIComponent(q)}&limit=10`,
  );
  if (answer.status !== 200) return { status: answer.status, titles: [] as string[] };
  const body = JSON.parse(answer.body) as { hits: { title: string }[] };
  return { status: 200, titles: body.hits.map((h) => h.title) };
}

/** Waits until the worker has embedded the page: the question finds it by meaning. */
export async function untilMeaningFinds(api: Api, workspaceId: string, q: string, title: string) {
  await expect
    .poll(async () => (await meaningTitles(api, workspaceId, q)).titles, {
      timeout: 180000,
      intervals: [1000, 2000, 5000],
    })
    .toContain(title);
}

/** The palette, opened by its shortcut, with `q` typed. */
export async function paletteSearch(page: Page, q: string) {
  await page.keyboard.press('Control+KeyK');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(q);
  return palette;
}

/** The palette's "Related by meaning" group, in the app's language. */
export const meaningGroup = (page: Page, language: 'en' | 'ar' = 'en') =>
  page
    .getByRole('dialog')
    .getByRole('group', { name: (language === 'ar' ? aiAr : aiEn).ai.meaningGroup });

export interface MeaningScene {
  api: Api;
  workspaceId: string;
  names: string[];
}

/**
 * An owner's synced workspace with the two pages, search by meaning on and their pages embedded;
 * made in English, the last page left open.
 */
export async function meaningScene(
  page: Page,
  name: string,
  signer: () => Promise<Browser>,
): Promise<MeaningScene> {
  await mockEmbeddings.reset();
  const account = await newAccount(name);
  const space = `${name} space`;
  await signedInWorkspace(page, account, space, null, signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, space);
  await writePage(page, MEANING.refunds.title, [MEANING.refunds.text]);
  await writePage(page, MEANING.leave.title, [MEANING.leave.text]);
  await embeddingsOn(api, workspaceId);
  await untilMeaningFinds(api, workspaceId, QUESTIONS.en, MEANING.refunds.title);
  await untilMeaningFinds(api, workspaceId, QUESTIONS.ar, MEANING.leave.title);
  return {
    api,
    workspaceId,
    names: [account.name, account.email, space, MEANING.refunds.title, MEANING.leave.title],
  };
}

/**
 * The scene's Phase 10 search screens in the app's language now, each handed to `check` once
 * drawn: the palette with a page found by meaning, then Settings' search by meaning.
 */
export async function meaningScreens(
  page: Page,
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  await paletteSearch(page, language === 'ar' ? QUESTIONS.arToEn : QUESTIONS.en);
  await expect(
    meaningGroup(page, language).getByRole('option', { name: new RegExp(MEANING.refunds.title) }),
  ).toBeVisible({ timeout: 30000 });
  await check('palette, related by meaning');
  await page.keyboard.press('Escape');
  await page.goto('/#/settings');
  await expect(page.getByTestId('embeddings-settings')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('embeddings-progress')).toBeVisible({ timeout: 30000 });
  await check('search by meaning settings');
}
