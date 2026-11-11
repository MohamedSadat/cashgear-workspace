import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createWorkspace, waitSaved } from './helpers';

// Phase 1 exit criterion 11: dark and light themes, by screenshot. Each theme's screenshot is
// read back pixel by pixel: the page, the sidebar and the top bar are drawn in that theme's own
// colours, its text stands out from them, and the two themes look different. The screenshots are
// attached to the report. (No pixel baselines: CI's fonts render a little differently.)

interface Sample {
  x: number;
  y: number;
  rendered: [number, number, number];
  expected: [number, number, number];
}

/** Reads a PNG screenshot back in the page: the colour at each point, and its luminance range. */
async function analyse(page: Page, png: Buffer, points: { x: number; y: number }[]) {
  return page.evaluate(
    async ({ data, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      // Screenshot pixels per CSS pixel (a scaled screen draws more).
      const scale = image.width / innerWidth;
      const pixel = (x: number, y: number) =>
        [
          ...context
            .getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1)
            .data.slice(0, 3),
        ] as [number, number, number];
      // The colour the page means at a point: the first background that is not transparent.
      const intended = (x: number, y: number): [number, number, number] => {
        let el = document.elementFromPoint(x, y) as HTMLElement | null;
        while (el) {
          const match = getComputedStyle(el)
            .backgroundColor.match(/[\d.]+/g)
            ?.map(Number);
          if (match && (match.length === 3 || match[3] > 0.99))
            return [match[0], match[1], match[2]];
          el = el.parentElement;
        }
        return [255, 255, 255];
      };
      const samples = points.map(({ x, y }) => ({
        x,
        y,
        rendered: pixel(x, y),
        expected: intended(x, y),
      }));
      // The title: its darkest and lightest pixels.
      const title = document.querySelector('.cgw-title')!.getBoundingClientRect();
      const lum = ([r, g, b]: number[]) => {
        const c = [r, g, b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const data2 = context.getImageData(
        title.x * scale,
        title.y * scale,
        title.width * scale,
        title.height * scale,
      ).data;
      let lo = 1;
      let hi = 0;
      for (let i = 0; i < data2.length; i += 4) {
        const l = lum([data2[i], data2[i + 1], data2[i + 2]]);
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
      }
      return {
        samples,
        titleContrast: (hi + 0.05) / (lo + 0.05),
        background: lum(samples[0].rendered),
      };
    },
    { data: png.toString('base64'), points },
  );
}

const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3);

test('light and dark themes draw the app in their own colours', async ({
  page: first,
  restart,
}, testInfo) => {
  const shots: Record<string, Buffer> = {};
  let page = first;
  for (const theme of ['light', 'dark'] as const) {
    await page.goto('/');
    // Each theme on a new workspace: a cleared browser profile, or the desktop app started again
    // on new data.
    if (theme === 'dark') page = await restart({ fresh: true });
    await page.goto('/');
    await page.evaluate((value) => localStorage.setItem('cgw-theme', value), theme);
    await createWorkspace(page, `Theme ${theme}`);
    await waitSaved(page);
    await expect(page.locator('html')).toHaveAttribute('data-cg-theme', theme);
    await page.mouse.move(0, 0);
    const png = await page.screenshot();
    shots[theme] = png;
    await testInfo.attach(`${theme}.png`, { body: png, contentType: 'image/png' });
    // A point in the page's empty margin, in the sidebar's empty foot, and in the top bar above
    // its text, from where they are drawn (the desktop window's size depends on the screen).
    const points = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const area = box('.cgw-page-area');
      const side = box('.cgw-sidebar-body');
      const top = box('.cgw-topbar');
      return [
        { x: Math.round(area.right - 24), y: Math.round(area.bottom - 24) },
        { x: Math.round(side.left + 12), y: Math.round(side.bottom - 12) },
        { x: Math.round(top.left + top.width * 0.6), y: Math.round(top.top + 3) },
      ];
    });
    const result = await analyse(page, png, points);
    for (const sample of result.samples as Sample[])
      expect(
        close(sample.rendered, sample.expected),
        `${theme} at ${sample.x},${sample.y}: drew ${sample.rendered}, meant ${sample.expected}`,
      ).toBe(true);
    if (theme === 'light') expect(result.background).toBeGreaterThan(0.8);
    else expect(result.background).toBeLessThan(0.05);
    expect(result.titleContrast).toBeGreaterThan(7);
  }
  // The two screenshots differ almost everywhere.
  const differ = await page.evaluate(
    async ({ a, b }) => {
      const load = async (data: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = [await load(a), await load(b)];
      let changed = 0;
      for (let i = 0; i < x.length; i += 4)
        if (
          Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) >
          60
        )
          changed++;
      return changed / (x.length / 4);
    },
    { a: shots.light.toString('base64'), b: shots.dark.toString('base64') },
  );
  expect(differ).toBeGreaterThan(0.6);
});
