import { expect, test } from './fixtures';
import { blocks, createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';

// Phase 1 exit criteria 3 to 7: edit block documents, slash commands, formatting, drag and
// reorder with ids unchanged, images and tables. Runs in Chrome and Edge.

test.describe('the block editor', () => {
  test('types, splits into blocks and saves', async ({ page }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await newPage(page, 'Notes');
    await page.keyboard.type('First line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line');
    await waitSaved(page);
    expect((await blocks(page)).map((b) => b.text)).toEqual(['First line', 'Second line']);
    const [first, second] = await blocks(page);
    expect(first.id).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(second.id).not.toBe(first.id);
    // Undo through Yjs takes the last typing away.
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await blocks(page)).map((b) => b.text).join('|'))
      .not.toContain('Second line');
    expect(errors).toEqual([]);
  });

  test('turns Markdown shortcuts into blocks and marks', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page);
    for (const line of ['# Title', '## Section', '- bullet', '1. numbered', '[] task', '> quote']) {
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
      // Leave list kinds: Enter on an empty item turns it back into a paragraph.
      if (/^(-|1\.|\[\])/.test(line)) await page.keyboard.press('Enter');
    }
    await page.keyboard.type('plain **bold** and `code` and ~~gone~~ ');
    await page.keyboard.press('Enter');
    await page.keyboard.type('---');
    const kinds = (await blocks(page)).map((b) => b.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['heading', 'bulletItem', 'numberedItem', 'checkItem', 'quote']),
    );
    await expect(editor(page).locator('h1', { hasText: 'Title' })).toBeVisible();
    await expect(editor(page).locator('h2', { hasText: 'Section' })).toBeVisible();
    await expect(editor(page).locator('strong', { hasText: 'bold' })).toBeVisible();
    await expect(editor(page).locator('code', { hasText: 'code' })).toBeVisible();
    await expect(editor(page).locator('s', { hasText: 'gone' })).toBeVisible();
    await expect(editor(page).locator('hr')).toBeVisible();
  });

  test('slash menu inserts blocks, filtered in English and in Arabic', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page);
    await page.keyboard.type('/head');
    const menu = page.getByRole('listbox', { name: 'Commands' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option').first()).toHaveText(/Heading 1/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await page.keyboard.type('Made by slash');
    await expect(editor(page).locator('h2', { hasText: 'Made by slash' })).toBeVisible();
    await page.keyboard.press('Enter');
    // A keyword in Arabic finds the command in the English interface too.
    await page.keyboard.type('/جدول');
    await expect(menu.getByRole('option').first()).toHaveText(/Table/);
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('table')).toBeVisible();
    // Escape closes the menu and leaves the slash as typed text.
    await editor(page).locator('h2', { hasText: 'Made by slash' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/qu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(editor(page)).toContainText('/qu');
  });

  test('slash menu in the Arabic interface', async ({ page }) => {
    await createWorkspace(page);
    await page.goto('/#/settings');
    await page
      .getByRole('group', { name: 'Language' })
      .getByRole('radio', { name: 'العربية' })
      .check();
    await page.goBack();
    await page
      .getByRole('button', { name: /^إضافة صفحة في/ })
      .first()
      .click();
    // The new page is open once its title is empty.
    await expect(page.getByLabel('عنوان الصفحة')).toHaveValue('');
    await page.getByLabel('عنوان الصفحة').fill('تجربة');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/عنو');
    const menu = page.getByRole('listbox', { name: 'الأوامر' });
    await expect(menu.getByRole('option').first()).toHaveText(/عنوان 1/);
    await page.keyboard.press('Enter');
    await page.keyboard.type('عنوان عربي');
    const heading = editor(page).locator('h1', { hasText: 'عنوان عربي' });
    await expect(heading).toBeVisible();
    // Direction from the first strong character: right to left.
    expect(await heading.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    // An English keyword works in the Arabic interface.
    await page.keyboard.press('Enter');
    await page.keyboard.type('/bullet');
    await expect(menu.getByRole('option').first()).toHaveText(/قائمة نقطية/);
  });

  test('bubble toolbar formats a selection and edits a link', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page);
    await page.keyboard.type('format these words');
    await page.keyboard.press('Shift+Home');
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Bold' }).click();
    await expect(editor(page).locator('strong')).toHaveText('format these words');
    await toolbar.getByRole('button', { name: 'Italic' }).click();
    await expect(editor(page).locator('em')).toHaveText('format these words');
    await toolbar.getByRole('button', { name: 'Link' }).click();
    const address = page.getByLabel('Link address');
    await address.fill('javascript:alert(1)');
    await address.press('Enter');
    await expect(toolbar.getByRole('alert')).toBeVisible();
    await expect(editor(page).locator('a')).toHaveCount(0);
    await address.fill('example.com/report');
    await address.press('Enter');
    await expect(editor(page).locator('a')).toHaveAttribute('href', 'https://example.com/report');
    await expect(editor(page).locator('a')).toHaveAttribute('rel', /noopener/);
    // Turn into from the toolbar keeps the text.
    await page.keyboard.press('Shift+Home');
    await toolbar.getByRole('button', { name: 'Turn into' }).click();
    await page.getByRole('menuitem', { name: 'Quote' }).click();
    await expect(editor(page).locator('[data-kind="quote"]')).toContainText('format these words');
  });

  test('moves blocks by keyboard and by drag, keeping their ids', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page);
    for (const text of ['Alpha', 'Beta', 'Gamma']) {
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type('Delta');
    const before = await blocks(page);
    const idOf = (text: string) => before.find((b) => b.text === text)!.id;
    // Alt+Shift+Up moves Delta above Gamma.
    await page.keyboard.press('Alt+Shift+ArrowUp');
    expect((await blocks(page)).map((b) => b.text)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
    // Tab puts Delta inside Beta; Shift+Tab takes it back out.
    await page.keyboard.press('Tab');
    await expect(editor(page).locator('[data-block] > [data-block]')).toHaveText('Delta');
    await page.keyboard.press('Shift+Tab');
    await expect(editor(page).locator('[data-block] > [data-block]')).toHaveCount(0);
    // Drag Alpha's handle below Gamma.
    const alpha = editor(page).locator('[data-block]', { hasText: 'Alpha' }).first();
    await alpha.hover();
    const handle = page.locator('.cgw-handle');
    await expect(handle).toBeVisible();
    const gamma = editor(page).locator('[data-block]', { hasText: 'Gamma' }).first();
    const from = (await handle.boundingBox())!;
    const box = (await gamma.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, box.y + box.height - 4, { steps: 8 });
    await page.mouse.up();
    const after = await blocks(page);
    expect(after.map((b) => b.text)).toEqual(['Beta', 'Delta', 'Gamma', 'Alpha']);
    for (const block of after) expect(block.id).toBe(idOf(block.text));
    // Block selection: Esc selects the block, Delete removes it.
    await editor(page).locator('[data-block]', { hasText: 'Delta' }).click();
    await page.keyboard.press('Escape');
    await expect(editor(page).locator('.is-block-selected')).toHaveCount(1);
    await page.keyboard.press('Delete');
    expect((await blocks(page)).map((b) => b.text)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  test('tables: insert, type across cells with Tab, add a row and a header column', async ({
    page,
  }) => {
    await createWorkspace(page);
    await newPage(page);
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');
    const table = editor(page).locator('table');
    await expect(table.locator('tr')).toHaveCount(3);
    for (const text of ['Name', 'Qty', 'Price']) {
      await page.keyboard.type(text);
      await page.keyboard.press('Tab');
    }
    await expect(table.locator('tr').first()).toHaveText('NameQtyPrice');
    const tools = page.getByRole('toolbar', { name: 'Table' });
    await tools.getByRole('button', { name: 'Add a row below' }).click();
    await expect(table.locator('tr')).toHaveCount(4);
    await tools.getByRole('button', { name: 'Header column' }).click();
    await expect(table).toHaveAttribute('data-header-column', 'true');
    await expect(table).toHaveAttribute('data-header-row', 'true');
  });

  test('images: pick a file, then it shows from local bytes with a caption', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page);
    // A 2x2 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDJAB4kNAEYTAgf7kJrYAAAAAElFTkSuQmCC',
      'base64',
    );
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.type('/image');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
    const image = editor(page).locator('figure.cgw-image img');
    await expect(image).toHaveAttribute('src', /^blob:/);
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
    await page.getByLabel('Add a caption').fill('Quarterly chart');
    await page.getByLabel('Add a caption').press('Enter');
    await expect(page.getByLabel('Add a caption')).toHaveValue('Quarterly chart');
  });

  test('copy and paste blocks gives the copies new ids; Markdown pastes as blocks', async ({
    page,
  }) => {
    await createWorkspace(page);
    await newPage(page);
    await page.keyboard.type('One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Two');
    await page.keyboard.press('Control+a');
    const copied = await editor(page).evaluate((root) => {
      const data = new DataTransfer();
      root.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return Object.fromEntries(data.types.map((type) => [type, data.getData(type)]));
    });
    expect(Object.keys(copied)).toEqual(
      expect.arrayContaining(['application/x-cgw-slice+json', 'text/html', 'text/plain']),
    );
    expect(copied['text/plain']).toContain('One');
    await page.keyboard.press('Control+End');
    // The browser moves the caret; the editor reads it on the next task. Enter before that would
    // still act on the whole selection.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
    await page.keyboard.press('Enter');
    const paste = (types: Record<string, string>) =>
      editor(page).evaluate((root, items) => {
        const data = new DataTransfer();
        for (const [type, value] of Object.entries(items)) data.setData(type, value);
        root.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, types);
    await paste(copied);
    const all = await blocks(page);
    expect(all.map((b) => b.text).filter(Boolean)).toEqual(['One', 'Two', 'One', 'Two']);
    expect(new Set(all.map((b) => b.id)).size).toBe(all.length);
    await page.keyboard.press('Enter');
    await paste({ 'text/plain': '## Pasted\n\n- [x] done item\n- plain item' });
    await expect(editor(page).locator('h2', { hasText: 'Pasted' })).toBeVisible();
    await expect(editor(page).locator('[data-kind="checkItem"][data-checked="true"]')).toHaveText(
      'done item',
    );
  });
});
