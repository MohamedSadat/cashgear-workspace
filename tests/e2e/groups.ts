// Phase 11's groups for the specs (groups.spec.ts, the accessibility and Arabic walks, and the
// share dialog's one picker where older specs add a person): the picker driven as a person does
// (type part of a name, choose the option, Add), a group made and changed in Settings → Members →
// Groups, and a scene with every new screen on it: Settings' groups (a group being changed, a
// delete asked), the share dialog with a group's row and the picker open, and a workbook's access.
import type { Browser, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, syncStatus, type TestAccount } from './cloud';
import { signedInWorkspace } from './database';
import { escapeRegExp, invite, newWorkbook, sessionOf, workspaceIdOf, type Api } from './ecosystem';

/** The interface's words these helpers use, in each language. */
export const GROUP_WORDS = {
  en: {
    page: 'Page',
    pageActions: 'Page actions',
    share: 'Share…',
    picker: 'Person or group',
    add: 'Add',
    access: 'Access',
    cancel: 'Cancel',
  },
  ar: {
    page: 'الصفحة',
    pageActions: 'إجراءات الصفحة',
    share: 'مشاركة…',
    picker: 'شخص أو مجموعة',
    add: 'إضافة',
    access: 'الوصول',
    cancel: 'إلغاء',
  },
} as const;

/** The share dialog of the page on screen, from the top bar's page menu, its list read. */
export async function openShare(page: Page, language: 'en' | 'ar' = 'en') {
  const words = GROUP_WORDS[language];
  await page
    .getByRole('region', { name: words.page })
    .getByRole('button', { name: words.pageActions })
    .click();
  await page.getByRole('menuitem', { name: words.share }).click();
  const dialog = page.getByRole('dialog');
  // The picker is drawn once the list has been read and said this person has full access.
  await expect(dialog.locator('#cgw-share-person')).toBeVisible({ timeout: 30000 });
  return dialog;
}

/**
 * Adds someone or a group to an access list through its one picker (the share dialog's or a
 * workbook's): part of the name or address typed, the option chosen, then Add. `option` matches
 * the option's name (a person's is their name and address, a group's its name and people).
 */
export async function pickPrincipal(
  page: Page,
  dialog: Locator,
  query: string,
  option: RegExp,
  language: 'en' | 'ar' = 'en',
) {
  const words = GROUP_WORDS[language];
  const box = dialog.getByRole('combobox', { name: words.picker });
  await box.fill(query);
  // The list is drawn over the page, outside the dialog's own box.
  await page.getByRole('option', { name: option }).click();
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByRole('button', { name: words.add, exact: true }).click();
}

/** Settings → Members → Groups, read. */
export async function groupsSettings(page: Page) {
  await page.goto('/#/settings');
  const section = page.getByTestId('groups-settings');
  await expect(section).toBeVisible({ timeout: 30000 });
  return section;
}

/** A group made in Settings with these people (by their names as listed), as an owner does. */
export async function makeGroup(page: Page, name: string, people: string[]) {
  const section = await groupsSettings(page);
  await section.getByTestId('group-new').click();
  const form = section.getByTestId('group-form');
  await form.getByLabel('Name of the new group').fill(name);
  for (const person of people)
    await form.getByRole('checkbox', { name: new RegExp(`^${escapeRegExp(person)}`) }).check();
  await form.getByRole('button', { name: 'Create the group', exact: true }).click();
  await expect(section.getByTestId('groups-status')).toHaveText(`“${name}” is made.`);
  const row = section.locator('[data-group-id]', { hasText: name });
  await expect(row).toContainText(`People: ${people.length}`);
  return (await row.getAttribute('data-group-id'))!;
}

/** A group's people changed in Settings: `add` checked, `remove` unchecked, then saved. */
export async function changeGroupPeople(
  page: Page,
  name: string,
  { add = [], remove = [] }: { add?: string[]; remove?: string[] },
) {
  const section = await groupsSettings(page);
  await section.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  const form = section.getByTestId('group-edit');
  for (const person of add)
    await form.getByRole('checkbox', { name: new RegExp(`^${escapeRegExp(person)}`) }).check();
  for (const person of remove)
    await form.getByRole('checkbox', { name: new RegExp(`^${escapeRegExp(person)}`) }).uncheck();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByTestId('groups-status')).toHaveText(`“${name}” is saved.`);
}

/** A member's user id, by their address. */
export async function memberId(api: Api, workspaceId: string, account: TestAccount) {
  const members = (await api.get(`/api/v1/workspaces/${workspaceId}/members`)) as {
    userId: string;
    email: string;
  }[];
  return members.find((m) => m.email.toLowerCase() === account.email.toLowerCase())!.userId;
}

/** A page's access list as the server holds it, the groups' rows with it. */
export async function serverAccess(api: Api, pageId: string) {
  return (await api.get(`/api/v1/pages/${pageId}/permissions?principals=group`)) as {
    restricted: boolean;
    yourLevel: string;
    entries: {
      principalType: string;
      principalId: string;
      level: string;
      displayName: string | null;
      email: string | null;
      peopleCount?: number | null;
    }[];
  };
}

export interface GroupsScene {
  api: Api;
  workspaceId: string;
  pageId: string;
  /** Names that are the people's or their workspace's (allowed in the Arabic check). */
  names: string[];
  dispose(): Promise<void>;
}

/**
 * An owner's synced workspace with two members by invitation (no browser of their own), two
 * groups (Designers with both, Writers with one), a page shared with Designers at comment and a
 * workbook shared with Designers at view; made in English, the page left open.
 */
export async function groupsScene(
  page: Page,
  name: string,
  signer: () => Promise<Browser>,
): Promise<GroupsScene> {
  const account = await newAccount(name);
  const space = `${name} space`;
  await signedInWorkspace(page, account, space, null, signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, space);
  const people: { account: TestAccount; api: Api }[] = [];
  for (const who of ['Basma', 'Cyrus']) {
    const member = await newAccount(who);
    people.push({ account: member, api: await invite(api, workspaceId, member) });
  }
  const ids = await Promise.all(people.map((p) => memberId(api, workspaceId, p.account)));
  const designers = (await api.post(`/api/v1/workspaces/${workspaceId}/groups`, {
    name: 'Designers',
    people: ids,
  })) as { id: string };
  await api.post(`/api/v1/workspaces/${workspaceId}/groups`, { name: 'Writers', people: [ids[0]] });
  await newPage(page, 'Plans for the team');
  await page.keyboard.type('Shared with a group.');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const pageId = new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1]!;
  await api.put(`/api/v1/pages/${pageId}/permissions`, {
    restricted: false,
    principals: ['group'],
    entries: [{ principalType: 'group', principalId: designers.id, level: 'comment' }],
  });
  const workbookId = await newWorkbook(api, workspaceId, 'Budget');
  await api.put(`/api/v1/workbooks/${workbookId}/permissions`, {
    restricted: false,
    principals: ['group'],
    entries: [{ principalType: 'group', principalId: designers.id, level: 'view' }],
  });
  return {
    api,
    workspaceId,
    pageId,
    names: [
      account.name,
      account.email,
      space,
      'Designers',
      'Writers',
      'Plans for the team',
      'Budget',
      ...people.flatMap((p) => [p.account.name, p.account.email]),
    ],
    dispose: async () => {
      for (const p of people) await p.api.dispose().catch(() => {});
      await api.dispose();
    },
  };
}

/**
 * The scene's Phase 11 screens in the app's language now, each handed to `check` once drawn:
 * Settings' groups with Designers being changed, its delete asked (and cancelled), the share
 * dialog with the group's row and the picker's list open, and the workbook's access.
 */
export async function groupsScreens(
  page: Page,
  scene: GroupsScene,
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  const words = GROUP_WORDS[language];
  const section = await groupsSettings(page);
  await expect(section.locator('[data-group-id]')).toHaveCount(2, { timeout: 30000 });
  // Designers is listed first (by name): its Edit, then (when the form is closed) its Delete.
  const designers = section.locator('[data-group-id]').first();
  await expect(designers).toContainText('Designers');
  await designers.locator('button:not(.is-danger)').click();
  await expect(section.getByTestId('group-edit')).toBeVisible();
  await check('groups settings, a group being changed');
  await section.getByTestId('group-edit').getByRole('button', { name: words.cancel }).click();
  await designers.locator('button.is-danger').click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toBeVisible();
  await check('a group’s delete asked');
  await ask.getByRole('button', { name: words.cancel }).click();
  await expect(ask).toHaveCount(0);

  await page.goto(`/#/p/${scene.pageId}`);
  await expect(editor(page)).toContainText('Shared with a group.', { timeout: 30000 });
  const dialog = await openShare(page, language);
  await expect(dialog.locator('[data-principal="group"]')).toHaveCount(1, { timeout: 30000 });
  const box = dialog.getByRole('combobox', { name: words.picker });
  await box.click();
  await box.press('ArrowDown');
  await expect(page.getByRole('option').first()).toBeVisible();
  await expect(page.getByRole('option', { name: /^Writers/ })).toBeVisible();
  await check('share dialog, a group listed and the picker open');
  // Escape closes the list, then the dialog.
  await box.press('Escape');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.goto('/#/workbooks');
  await page.getByRole('button', { name: `${words.access}: Budget` }).click();
  const access = page.getByRole('dialog');
  await expect(access.locator('[data-principal="group"]')).toHaveCount(1, { timeout: 30000 });
  await check('a workbook’s access with a group');
  await page.keyboard.press('Escape');
}
