import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { caretSettled, editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount } from './cloud';
import { signedInWorkspace, signers } from './database';
import { commentScene, select } from './collab';
import { phase7Scene, phase7Screens } from './phase7';
import { pluginScene, pluginScreens } from './plugins';
import { ERP10_THEIRS, erp10Scene, erp10Screens } from './erp10';
import { meaningScene, meaningScreens } from './meaning';
import { groupsScene, groupsScreens } from './groups';
import { SSO_REFUSED, ssoScene, ssoScreens } from './sso';
import { chartScene, chartScreens } from './chart';
import { gridScene, gridScreens } from './grid';
import { ERP12_THEIRS, englishIn, erp12Scene, erp12Screens } from './erp12';
import { planScene, planScreens } from './plan';
import { everySettingsTab } from './settings';
import {
  REAL_ERP,
  REAL_SHEET,
  connectErp,
  erpBlock,
  expectLive,
  insertErpBlock,
  insertExistingWorkbook,
  linkWorkspace,
  mockErp,
  mockSheet,
  newWorkbook,
  sessionOf,
  sheetBlock,
  watchAppErrors,
  workbookOf,
  workspaceIdOf,
} from './ecosystem';

// Phase 1 exit criterion 12: in Arabic the app is right to left and no string of its own is left
// in English. Each main screen is walked: every visible text node, label, placeholder and tooltip
// outside what the person wrote (page titles, page content, the workspace name) must have no
// English word. Key names are allowed: shortcuts are shown as the keys are labelled; and so is the
// CSV format's name (Phase 4: "Import a CSV file…"), which Arabic writes as it is, and from Phase 5
// the Cash Gear products' names («فتح في Cash Gear Sheet», «بيانات ERP»), which are not translated;
// from Phase 7 also the AI provider's and its models' names (Anthropic, Claude Opus 5.5), shown in
// Settings' AI section on every screen walked there; from Phase 10 the embeddings provider's and
// its models' names (Voyage AI, voyage-4), in the same section; from Phase 13 the model this server
// runs itself (voyage-4-nano); from Phase 14 the example host name Settings → Publishing gives
// (docs.example.com, `EXAMPLE_HOST`), a name in no language, shown on every screen walked there;
// from Phase 18 the completion model this server runs (qwen3.5-4b) and the payment provider's name
// (Paddle), in Settings' AI section on every screen walked there.
// The palette's "Related by meaning" group lists pages, as its others do.

/**
 * Groups whose options are what the person wrote, by their names: the palette's page results and
 * recent pages (a title, and a line of the page's text): `search.pages`, `workspace.recent`.
 */
const OWN_GROUPS = ['الصفحات', 'الأخيرة', 'ذات صلة بالمعنى'];
/** The breadcrumb's landmark (`page.breadcrumbs`). */
const BREADCRUMBS = 'موقع هذه الصفحة';

const KEYS =
  /\b(Ctrl|Shift|Alt|Enter|Esc|Tab|Backspace|Delete|Del|Space|Cmd|Option|F\d+|CSV|Cash Gear (?:Sheet|ERP|Workspace)|ERP|Anthropic|Claude(?: (?:Opus|Sonnet|Haiku) \d+(?:\.\d+)?)?|Voyage AI|voyage-4(?:-large|-lite|-nano)?|qwen3\.5-4b|Paddle|docs\.example\.com)\b/g;

/**
 * What the person wrote or another system holds, beyond the main screens' own (Phase 5): names
 * of people, workspaces, workbooks and companies, and the ERP's records.
 */
interface Theirs {
  /** Elements whose text is theirs. */
  within?: string[];
  /** Words that are theirs wherever they appear (a name inside an Arabic sentence). */
  names?: string[];
}

async function english(page: Page, screen: string, theirs: Theirs = {}): Promise<string[]> {
  return page.evaluate(
    ({ screen, keys, theirs, ownGroups, breadcrumbs }) => {
      const keyNames = new RegExp(keys, 'g');
      // The breadcrumb, by its landmark's name: the section's and the pages' names.
      const crumbs = `nav[aria-label="${breadcrumbs}"]`;
      // What the person wrote: page titles (the sidebar, breadcrumbs, the title, search
      // results), the page itself, and the workspace's name.
      const own = [
        '.cgw-editor',
        '.cgw-title',
        '.cgw-tree-title',
        crumbs,
        '.cgw-workspace-switcher',
        'kbd',
        '[lang="en"]',
        ...(theirs.within ?? []),
      ].join(', ');
      // The search results' groups (by their names): every option in them is a page's.
      const groups = [...document.querySelectorAll('[role="group"]')].filter((group) => {
        const by = group.getAttribute('aria-labelledby');
        const name = by
          ? document.getElementById(by)?.textContent
          : group.getAttribute('aria-label');
        return !!name && ownGroups.includes(name.trim());
      });
      const theirsAt = (el: Element) =>
        !!el.closest(own) ||
        groups.some((group) => group.contains(el) && !!el.closest('[role="option"]'));
      const titles = [
        ...[...document.querySelectorAll('.cgw-tree-title')].map((el) => el.textContent!),
        ...(theirs.names ?? []),
      ];
      const strip = (text: string) => {
        let out = text;
        for (const title of titles) out = out.split(title).join(' ');
        return out.replace(keyNames, ' ');
      };
      const visible = (el: Element) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const found: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || theirsAt(parent) || parent.closest('[aria-hidden="true"]')) continue;
        if (!visible(parent)) continue;
        const text = strip(node.textContent ?? '');
        if (/[A-Za-z]{2,}/.test(text)) found.push(`${screen}: text "${node.textContent!.trim()}"`);
      }
      for (const el of document.querySelectorAll('[aria-label], [placeholder], [title]')) {
        // A crumb's tooltip is its page's or section's name (the "…" button's are the app's).
        if (el.closest('.cgw-editor') || el.matches(`${crumbs} li > :is(a, span)`) || !visible(el))
          continue;
        for (const name of ['aria-label', 'placeholder', 'title']) {
          const value = el.getAttribute(name);
          if (value && /[A-Za-z]{2,}/.test(strip(value)))
            found.push(`${screen}: ${name} "${value}" on <${el.tagName.toLowerCase()}>`);
        }
      }
      return found;
    },
    {
      screen,
      keys: KEYS.source,
      theirs,
      ownGroups: OWN_GROUPS,
      breadcrumbs: BREADCRUMBS,
    },
  );
}

test('the Arabic interface is right to left, with no English of its own', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const found: string[] = [];
  found.push(...(await english(page, 'first run')));

  await page.getByLabel('اسم مساحة العمل').fill('مساحتي');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('عنوان الصفحة')).toHaveValue('البداية');
  await waitSaved(page);
  found.push(...(await english(page, 'page')));

  // The page header's own buttons, shown on hover.
  await page.locator('.cgw-page-header').hover();
  found.push(...(await english(page, 'page header')));

  await page.keyboard.press('Control+KeyK');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  found.push(...(await english(page, 'palette')));
  await palette.getByRole('combobox').fill('ب');
  found.push(...(await english(page, 'palette with a query')));
  await page.keyboard.press('Escape');

  await editor(page).locator('[data-block] .cgw-body').first().click();
  await expect(editor(page)).toBeFocused();
  // The editor reads the click's caret a moment later on a busy runner (Phase 6, 1414cd0).
  await caretSettled(page);
  await page.keyboard.press('Control+Slash');
  await expect(page.getByRole('menu')).toBeVisible();
  found.push(...(await english(page, 'block menu')));
  await page.keyboard.press('Escape');

  await editor(page).locator('[data-block] .cgw-body').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.getByRole('listbox')).toBeVisible();
  found.push(...(await english(page, 'slash menu')));
  await page.keyboard.press('Escape');

  await page.getByRole('treeitem', { name: /البداية/ }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  found.push(...(await english(page, 'row menu')));
  await page.keyboard.press('Escape');

  await everySettingsTab(page, async (tab) => {
    found.push(...(await english(page, `settings: ${tab}`)));
  });

  await page.goto('/#/trash');
  await expect(page.locator('.cgw-page-area')).toBeVisible();
  found.push(...(await english(page, 'trash')));

  // Narrow screens are a browser's (the desktop window is at least 800 px wide).
  if (!desktop) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'إظهار الشريط الجانبي' }).click();
    await expect(page.locator('#cgw-drawer')).toHaveAttribute('aria-hidden', 'false');
    found.push(...(await english(page, 'drawer')));
  }

  expect(found, found.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});

// Phase 5's screens in Arabic: the workbook block and the ERP block on a page (before and after
// connecting), the block's view picker, the workbook list, the ERP settings section and the link
// screen; against the server stack and the mocks.
test('the Arabic workbook and ERP screens have no English of their own', async ({ page }) => {
  test.skip(desktop || REAL_SHEET || REAL_ERP, 'A browser against the mocks');
  test.setTimeout(240000);
  // The mocks as they start: an earlier spec's unused faults would fail the live view here.
  await mockSheet.reset();
  await mockErp.reset();
  const cloud = signers();
  const errors = watchAppErrors(page);
  const account = await newAccount('Rana');
  await signedInWorkspace(page, account, 'Rana space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Rana space');
    await newWorkbook(api, workspaceId, 'Budget', workbookOf([['Item'], ['Rent']]));
    await linkWorkspace(api, workspaceId, 'Rana space');
    await newPage(page, 'Plans');
    await page.keyboard.type('Before.');
    await page.keyboard.press('Enter');
    await insertErpBlock(page);
    await insertExistingWorkbook(page, 'Budget');
    await expectLive(sheetBlock(page), 'Rent');
    await waitSaved(page);
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // Names that are the person's or another system's: the workspace's and its sections' (made
    // in English), the workbook's, the ERP's company and users, the account's email, and this
    // account's devices (named by the server from their browsers: "Chrome on Windows", and
    // "Browser" for the tests' own API client), longest first.
    const theirs = {
      within: ['.cgw-sheet-name', '.cgw-erp-table tbody', '.cgw-workbooks td[dir="auto"]'],
      names: [
        account.name,
        account.email,
        'Rana space',
        'Workspace',
        'Private',
        'Budget',
        'Kit Trading',
        'Alice Haddad',
        'Dan Fawzy',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    const block = sheetBlock(page);
    await expect(block).toHaveAttribute('data-state', 'loaded', { timeout: 30000 });
    const erp = erpBlock(page);
    await expect(erp.getByTestId('erp-not-connected')).toBeVisible({ timeout: 30000 });
    found.push(...(await english(page, 'workbook and ERP blocks', theirs)));

    await block.locator('.cgw-sheet-icon').click();
    await expect(page.getByRole('menu')).toBeVisible();
    found.push(...(await english(page, 'workbook menu', theirs)));
    // "Change view" by its name: Phase 9 put "Version history" before it.
    await page.getByRole('menuitem', { name: 'تغيير العرض' }).click();
    await expect(block.locator('form.cgw-sheet-picker')).toBeVisible();
    found.push(...(await english(page, 'view picker', theirs)));
    await block.locator('form.cgw-sheet-picker button[type="button"]').click();

    await connectErp(page, erp, 'alice');
    await erp.locator('[data-connector="vendors"]').click();
    await expect(erp.getByTestId('erp-table')).toBeVisible({ timeout: 30000 });
    await erp.locator('.cgw-erp-toolbar button').nth(2).click();
    found.push(...(await english(page, 'ERP table and filter', theirs)));

    await page.goto('/#/workbooks');
    await expect(page.getByTestId('workbooks-table')).toBeVisible({ timeout: 30000 });
    found.push(...(await english(page, 'workbook list', theirs)));
    await page.goto('/#/settings/integrations');
    await expect(page.getByTestId('erp-settings').getByTestId('erp-links')).toBeVisible({
      timeout: 30000,
    });
    found.push(...(await english(page, 'settings with ERP', theirs)));
    const { ticket } = await mockErp.linkTicket('dan');
    await page.goto(`/#/erp-link/${ticket}`);
    await expect(page.getByTestId('erp-link-screen').locator('form')).toBeVisible({
      timeout: 30000,
    });
    found.push(...(await english(page, 'ERP link screen', theirs)));
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
    await cloud.close();
  }
});

// Phase 6's screens in Arabic: the comments panel (open threads with a reply and a mention, the
// resolved one, a draft), the presence bar and the sidebar's avatars, the inbox; against the
// server stack, two people on a page (collab.ts's scene, made in English).
test('the Arabic comments, inbox and presence have no English of their own', async ({ page }) => {
  test.skip(desktop, 'Two people in browser profiles of their own');
  test.setTimeout(240000);
  const scene = await commentScene(page);
  try {
    const { ids, t } = scene;
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(editor(page)).toContainText('A second paragraph to resolve.', { timeout: 30000 });
    await expect(page.getByTestId('presence-bar')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('side-presence').first()).toBeVisible();
    await editor(page).locator('[data-block] > .cgw-body').first().click();
    await page.keyboard.press('Control+Alt+Shift+KeyM');
    const comments = page.getByTestId('comments-panel');
    await expect(comments.locator('[data-thread-id][data-state="saved"]')).toHaveCount(1, {
      timeout: 20000,
    });
    await comments.locator('.cgw-comments-header button[aria-pressed]').click();
    await expect(comments.locator('[data-thread-id]')).toHaveCount(2);
    await select(page, ids[1], 2, 6);
    await page.keyboard.press('Control+Alt+KeyM');
    await expect(comments.getByTestId('comment-draft')).toBeVisible();
    // What the people wrote and are called, and the workspace's names (made in English).
    const theirs = {
      within: [
        '.cgw-comment-body',
        '.cgw-thread-quote',
        '.cgw-thread-quote-text',
        '[data-testid="comment-composer"]',
        '.cgw-inbox-excerpt',
      ],
      names: [
        t.owner.account.email,
        ...t.members.map((m) => m.account.email),
        'Team space',
        'Workspace',
        'Private',
        'Ada',
        'Ben',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    found.push(...(await english(page, 'comments panel, presence', theirs)));
    await page.keyboard.press('Escape');
    await page.goto('/#/inbox');
    await expect(page.getByTestId('inbox-list').locator('li')).toHaveCount(2, { timeout: 20000 });
    found.push(...(await english(page, 'inbox', theirs)));
    expect(found, found.join('\n')).toEqual([]);
    expect(t.owner.errors).toEqual([]);
  } finally {
    await scene.t.close();
  }
});

// Phase 7's screens in Arabic: a chart block, an ERP block editing a vendor and its review, the AI
// panel with a proposal, Settings' AI section; against the server stack, the mock ERP and the mock
// provider (phase7.ts's scene, made in English).
test('the Arabic chart, ERP editing, AI panel and AI settings have no English of their own', async ({
  page,
}) => {
  test.skip(desktop || REAL_ERP, 'A browser against the mocks');
  test.setTimeout(300000);
  const cloud = signers();
  const errors = watchAppErrors(page);
  const scene = await phase7Scene(page, 'Samira', cloud.signer);
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const theirs = {
      within: ['.cgw-erp-table tbody', '.cgw-erp-review-table tbody', '.cgw-ai-text'],
      names: [
        ...scene.names,
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await phase7Screens(page, 'ar', async (screen) => {
      found.push(...(await english(page, screen, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
    await cloud.close();
  }
});

// Phase 10's screens in Arabic: an ERP block editing Items on hand (a shared field's editor and
// note, every row changed, the review of each row, a conflict that needs no choice); against the
// server stack and the mock ERP (erp10.ts's scene, made in English).
test('the Arabic Items on hand editing, its review and conflict have no English of their own', async ({
  page,
}) => {
  test.skip(desktop || REAL_ERP, 'A browser against the mocks');
  test.setTimeout(300000);
  const cloud = signers();
  const errors = watchAppErrors(page, [
    /status of 409 .*\/api\/connect\/Connectors\/[^/ ]+\/Commit$/,
  ]);
  const scene = await erp10Scene(page, 'Samir', cloud.signer);
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const theirs = {
      within: ERP10_THEIRS,
      names: [
        ...scene.names,
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await erp10Screens(page, 'ar', async (screen) => {
      found.push(...(await english(page, screen, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
    await cloud.close();
  }
});

// Phase 10's search by meaning in Arabic: the palette's "Related by meaning" for an Arabic
// question, and Settings' part of it; against the server stack and the mock providers (meaning.ts's
// scene, made in English).
test('the Arabic related by meaning and its settings have no English of their own', async ({
  page,
}) => {
  test.skip(desktop, 'A browser against the mock providers');
  test.setTimeout(300000);
  const cloud = signers();
  const errors = watchAppErrors(page);
  const scene = await meaningScene(page, 'Salma', cloud.signer);
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const theirs = {
      names: [
        ...scene.names,
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await meaningScreens(page, 'ar', async (screen) => {
      found.push(...(await english(page, screen, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
    await cloud.close();
  }
});

// Phase 10's plugin screens in Arabic: a third-party plugin block's bar on the page, and
// Settings → Plugins (the list and the Add review dialog); against the server stack (plugins.ts's
// scene, made in English). The plugin's own name ("Notes") and type ("vendor.notes") are the
// author's, allowed as their content; the plugin frame itself is another origin's, not walked.
test('the Arabic plugin block and Settings → Plugins have no English of their own', async ({
  page,
}) => {
  test.skip(desktop, 'The plugins origin is framed by the web build; run in a browser');
  test.setTimeout(300000);
  const errors = watchAppErrors(page);
  const scene = await pluginScene(page, 'Sahar');
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const theirs = {
      within: ['.cgw-plugin-frame-bar', '.cgw-plugins-name', '.cgw-plugins-type'],
      // Settings also lists the account's devices, named by the server from their browsers
      // ("Chrome on Windows", and "Browser" for the tests' own API client), as above.
      names: [
        ...scene.names,
        'Notes',
        'vendor.notes',
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await pluginScreens(page, 'ar', async (screen) => {
      found.push(...(await english(page, screen, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
  }
});

// Phase 11's groups in Arabic: Settings → Members → Groups (a group being changed, its delete
// asked), the share dialog with a group's row and its one picker's list open, and a workbook's
// access with a group; against the server stack (groups.ts's scene, made in English). The groups',
// the people's, the page's and the workbook's names are theirs.
test('the Arabic groups in Settings, the share dialog and a workbook’s access have no English of their own', async ({
  page,
}) => {
  test.skip(desktop, 'Members invited by mail; the screens are the web build’s');
  test.setTimeout(300000);
  const cloud = signers();
  const errors = watchAppErrors(page);
  const scene = await groupsScene(page, 'Sami', cloud.signer);
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(editor(page)).toBeVisible({ timeout: 30000 });
    const theirs = {
      names: [
        ...scene.names,
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await groupsScreens(page, scene, 'ar', async (screen) => {
      found.push(...(await english(page, screen, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await scene.dispose();
    await cloud.close();
  }
});

// Phase 11's single sign-on in Arabic: Settings → Single sign-on (the provider set and not tested
// yet, a domain proven and one not, the unproven one's Verify refused in words) and each question
// it asks; against the server stack and the mock provider (sso.ts's scene, made in English). The
// domains, the provider's address and client, the protocol's name (OpenID Connect) and what is
// registered elsewhere as it is (the redirect address, a record's name and value) are theirs.
test('the Arabic single sign-on in Settings has no English of its own', async ({ page }) => {
  test.skip(desktop, 'The mock provider is reached by the web build; the screens are the same');
  test.setTimeout(300000);
  const cloud = signers();
  // The unproven domain's Verify is answered 400, which the browser logs.
  const errors = watchAppErrors(page, [SSO_REFUSED]);
  const scene = await ssoScene(page, 'Samira', cloud.signer);
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(editor(page)).toBeVisible({ timeout: 30000 });
    const theirs = {
      within: ['.cgw-sso-value', '.cgw-sso-name'],
      names: [
        ...scene.names,
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await ssoScreens(page, scene, 'ar', async (screen) => {
      found.push(...(await english(page, screen, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await scene.dispose();
    await cloud.close();
  }
});

// Phase 12's chart view in Arabic: its bars, its Layout settings, a pie and a chart with no group
// (chart.ts's scene, made in Arabic on this device: the Projects template's words are Arabic too).
// The chart's own words, the library's among them (its data table, its points' names, the keys it
// tells a screen reader to press), are the app's.
test('the Arabic chart view and its settings have no English of their own', async ({ page }) => {
  test.setTimeout(240000);
  const errors = watchErrors(page);
  const scene = await chartScene(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const found: string[] = [];
  await chartScreens(page, scene.language, 'ar', async (screen) => {
    found.push(...(await english(page, screen, { names: ['Workspace', 'Private'] })));
  });
  expect(found, found.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});

// Phase 12's grid in Arabic (M12.3): the table with a row's cell active, a title being edited and
// cancelled, the grouped table as a tree grid with a group's header active and collapsed, and a
// "New" line reached, each said in the live region in Arabic (grid.ts's scene, made in Arabic on
// this device: the Tasks template's words are Arabic too). The key the live region names (Enter)
// is a key's name.
test('the Arabic grid, its tree grid and what its live region says have no English of their own', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors = watchErrors(page);
  await gridScene(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const found: string[] = [];
  await gridScreens(page, 'ar', async (screen) => {
    found.push(...(await english(page, screen, { names: ['Workspace', 'Private'] })));
  });
  expect(found, found.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});

// Phase 12's ERP reports in Arabic (M12.6): AP aging with its parameters and totals, its date's
// calendar open, stock balance with its switch on, and the trial balance; against the server stack
// and the mock ERP (erp12.ts's scene, made in English). The page-wide walk leaves a page's blocks
// to their writer, so each screen also walks the block itself; the ERP's rows, totals and its
// lists' items (a vendor group's, a site's) are the ERP's own.
test('the Arabic ERP report blocks, their parameters, calendar and totals have no English of their own', async ({
  page,
}) => {
  test.skip(desktop || REAL_ERP, 'A browser against the mocks');
  test.setTimeout(300000);
  const cloud = signers();
  const errors = watchAppErrors(page);
  const scene = await erp12Scene(page, 'Sawsan', cloud.signer);
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const theirs = {
      within: ERP12_THEIRS,
      names: [
        ...scene.names,
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await erp12Screens(page, 'ar', async (screen, block) => {
      found.push(...(await english(page, screen, theirs)));
      found.push(...(await englishIn(block, `${screen}, in the block`, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
    await cloud.close();
  }
});

// Phase 13's screens in Arabic: Settings with AI on Cash Gear's subscription, search by meaning on
// this server and a plugin's hosts, a plugin update's review naming a new host, and the dialog that
// allows its hosts (plan.ts's scene, made in English). The plugin's name and hosts are its author's.
test('the Arabic subscription, this server’s model and a plugin’s hosts have no English of their own', async ({
  page,
}) => {
  test.skip(desktop, 'A browser against the e2e stack');
  test.setTimeout(300000);
  const cloud = signers();
  const errors = watchAppErrors(page);
  const scene = await planScene(page, 'Samar', cloud.signer);
  try {
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const theirs = {
      within: [
        '.cgw-plugins-name',
        '.cgw-plugins-type',
        '.cgw-plugins-hosts',
        '.cgw-plugins-network code',
      ],
      names: [
        ...scene.names,
        'Workspace',
        'Private',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    await planScreens(page, 'ar', async (screen) => {
      found.push(...(await english(page, screen, theirs)));
    });
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await cloud.close();
  }
});
