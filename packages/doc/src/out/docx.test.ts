// Phase 19, M19.2: the Word writer held to Phase 8's reader by a round trip. A page holding every
// block, inline node and mark, in English and in Arabic, is written and read back; what comes back
// is the page's blocks, marks and directions, apart from the losses listed (ARCHITECTURE.md, "Word,
// PDF and print"): its title and icon as the title; a row's properties as a table first; a
// direction set left to right as none; a toggle as a paragraph and a callout as one with its icon
// first; a block nested under one that is not a list item at the top; no divider; text colour
// gone and orange highlighted yellow; code without its language; a table without its widths; an
// image without its width and alignment, its caption a paragraph after it; a file, a bookmark, a
// child page, a mention and a date as text (links kept); the table of contents as its lines; what
// the shell resolved as its table, picture and lines; a sub-page's title as a first heading.
import { describe, expect, it } from 'vitest';
import type { DocJSON } from '../binding';
import { readDocx } from '../docx';
import { writeDocx, xml } from './docx';
import { everyBlockInput } from './fixtures';

const text = (data: string | Uint8Array) =>
  typeof data === 'string' ? data : new TextDecoder().decode(data);

function written(language: 'en' | 'ar') {
  const parts = writeDocx(everyBlockInput(language));
  const byPath = new Map(parts.map((p) => [p.path, p.data]));
  const read = readDocx(
    {
      document: text(byPath.get('word/document.xml')!),
      styles: text(byPath.get('word/styles.xml')!),
      numbering: text(byPath.get('word/numbering.xml')!),
      relationships: text(byPath.get('word/_rels/document.xml.rels')!),
      headersAndFooters: parts.filter((p) => /word\/(header|footer)\d+\.xml$/.test(p.path)).length,
    },
    { image: (path, alt) => `image:${path}${alt ? `:${alt}` : ''}` },
  );
  return { parts, byPath, read };
}

/** A compact outline of a document: each block on a line, its kind, direction, text and marks. */
function outline(doc: DocJSON): string[] {
  const lines: string[] = [];
  const inline = (nodes: DocJSON[] | undefined) =>
    (nodes ?? [])
      .map((n) => {
        if (n.type === 'hardBreak') return '⏎';
        if (n.type !== 'text') return `{${n.type}}`;
        const marks = (n.marks ?? [])
          .map((m) =>
            m.type === 'link'
              ? `link=${String(m.attrs?.href)}`
              : m.type === 'highlight'
                ? `highlight=${String(m.attrs?.token)}`
                : m.type,
          )
          .join(',');
        return marks ? `«${n.text}»[${marks}]` : n.text;
      })
      .join('');
  const walk = (blocks: DocJSON[] | undefined, depth: number) => {
    for (const b of blocks ?? []) {
      const pad = '  '.repeat(depth);
      const [body, ...rest] = b.content ?? [];
      const a = body?.attrs ?? {};
      const dir = a.dir === 'rtl' ? ' rtl' : '';
      switch (body?.type) {
        case 'textBody': {
          const extra = [
            a.kind === 'heading' ? a.level : null,
            a.kind === 'checkItem' ? (a.checked ? 'x' : 'o') : null,
            a.start ? `from ${String(a.start)}` : null,
          ].filter((x) => x !== null);
          lines.push(
            `${pad}${String(a.kind)}${extra.length ? `(${extra.join(',')})` : ''}${dir}: ${inline(body.content)}`,
          );
          break;
        }
        case 'codeBlock':
          lines.push(`${pad}code: ${JSON.stringify(body.content?.[0]?.text ?? '')}`);
          break;
        case 'table':
          lines.push(
            `${pad}table${a.headerRow ? ' header' : ''}: ${(body.content ?? [])
              .map((row) =>
                (row.content ?? [])
                  .map((cell) => {
                    const span = `${cell.attrs?.colspan !== 1 ? `c${String(cell.attrs?.colspan)}` : ''}${cell.attrs?.rowspan !== 1 ? `r${String(cell.attrs?.rowspan)}` : ''}`;
                    return `${inline(cell.content)}${span ? `{${span}}` : ''}`;
                  })
                  .join(' | '),
              )
              .join(' / ')}`,
          );
          break;
        default:
          lines.push(`${pad}${String(body?.type)}: ${JSON.stringify(a)}`);
      }
      walk(rest, depth + 1);
    }
  };
  walk(doc.content, 0);
  // Intl writes bidi marks into Arabic dates: spelled out, so the outline shows them.
  return lines.map((line) =>
    line.replace(/\p{Cf}/gu, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>`),
  );
}

describe('the Word writer, read back by the reader', () => {
  it('gives the English page back as written, apart from the listed losses', () => {
    const { read } = written('en');
    expect(read.title).toBe('📊 Quarterly report');
    expect(read.skipped).toEqual({ headersAndFooters: 2 });
    expect(outline(read.doc)).toMatchInlineSnapshot(`
      [
        "table: Status | In progress / Due | 2026-12-01",
        "heading(1): Heading one",
        "paragraph: Heading one",
        "paragraph: Heading two",
        "paragraph: Heading three",
        "paragraph: Plain «bold»[bold] «italic»[italic] «underline»[underline] «struck»[strike] «code»[code] «a link»[link=https://example.com/a?b=1&c=2] red text «yellow»[highlight=yellow] «orange»[highlight=yellow]",
        "paragraph: See «🗓️ The year’s plan»[link=https://workspace.example/#/p/01936f6e-0000-7000-8000-00000000b003] on 26 Nov 2026 by @Sara⏎next line",
        "heading(2): Heading two",
        "bulletItem: Apples",
        "  bulletItem: Green apples",
        "    bulletItem: Small ones",
        "bulletItem: Bananas",
        "numberedItem(from 3): Third step",
        "numberedItem: Fourth step",
        "  numberedItem: A step within",
        "numberedItem: Fifth step",
        "checkItem(x): Done already",
        "checkItem(o): Still open",
        "  checkItem(o): An item under it",
        "heading(3): Heading three",
        "quote: A quotation that stands apart.",
        "paragraph: 💡 Mind the step.",
        "paragraph: More, folded",
        "paragraph: Inside the toggle.",
        "paragraph: A paragraph under a paragraph.",
        "paragraph: A paragraph under a paragraph.",
        "code: "const a = 1;\\n\\n\\tconst b = a + 2; // <ok> & \\"done\\""",
        "table header: Region | Sales / «North and South»[bold]{r2} | 120 / 80 / East{c2}",
        "image: {"assetId":"image:word/media/image1.png:Two squares","alt":"Two squares"}",
        "paragraph: A small picture",
        "paragraph: An image not on this device",
        "paragraph: 📎 Budget.xlsx",
        "paragraph: «https://example.com/bookmark»[link=https://example.com/bookmark]",
        "paragraph: «A child page»[link=https://workspace.example/#/p/01936f6e-0000-7000-8000-00000000b002]",
        "paragraph: Tasks",
        "table header: Task | Status / In progress (2){c2} / Write the report | In progress / Review it | In progress / Done (1){c2} / Send it | Done",
        "paragraph: And 997 more rows",
        "image: {"assetId":"image:word/media/image2.png:Budget","alt":"Budget"}",
        "paragraph: Budget",
        "paragraph: Cash Gear ERP: Vendors (its data is not exported)",
        "image: {"assetId":"image:word/media/image3.png:Tasks by status","alt":"Tasks by status"}",
        "paragraph: Tasks by status",
        "paragraph: Board: Tasks",
        "paragraph: Text of a block from a later build",
        "paragraph: English, set left to right.",
        "paragraph rtl: يكتب هذا السطر من اليمين إلى اليسار.",
        "paragraph: The last line.",
        "heading(1): Notes, a sub-page",
        "paragraph: The sub-page’s own text.",
      ]
    `);
  });

  it('gives the Arabic page back with every block right to left', () => {
    const { read } = written('ar');
    expect(read.title).toBe('📊 تقرير الربع');
    expect(outline(read.doc)).toMatchInlineSnapshot(`
      [
        "table: الحالة | قيد العمل / الموعد | 2026-12-01",
        "heading(1) rtl: العنوان الأول",
        "paragraph rtl: العنوان الأول",
        "paragraph rtl: العنوان الثاني",
        "paragraph rtl: العنوان الثالث",
        "paragraph rtl: نص عادي «عريض»[bold] «مائل»[italic] «مسطر»[underline] «مشطوب»[strike] «code»[code] «رابط»[link=https://example.com/a?b=1&c=2] نص أحمر «أصفر»[highlight=yellow] «برتقالي»[highlight=yellow]",
        "paragraph rtl: انظر «🗓️ خطة السنة»[link=https://workspace.example/#/p/01936f6e-0000-7000-8000-00000000b003] في 26<U+200F>/11<U+200F>/2026 من @سارة⏎السطر التالي",
        "heading(2) rtl: العنوان الثاني",
        "bulletItem rtl: تفاح",
        "  bulletItem rtl: تفاح أخضر",
        "    bulletItem rtl: الصغير منه",
        "bulletItem rtl: موز",
        "numberedItem(from 3) rtl: الخطوة الثالثة",
        "numberedItem rtl: الخطوة الرابعة",
        "  numberedItem rtl: خطوة داخلها",
        "numberedItem rtl: الخطوة الخامسة",
        "checkItem(x) rtl: تم بالفعل",
        "checkItem(o) rtl: ما زال مفتوحا",
        "  checkItem(o) rtl: بند تحته",
        "heading(3) rtl: العنوان الثالث",
        "quote rtl: اقتباس قائم بذاته.",
        "paragraph rtl: 💡 انتبه للدرجة.",
        "paragraph rtl: المزيد، مطوي",
        "paragraph rtl: داخل القائمة المطوية.",
        "paragraph rtl: فقرة تحت فقرة.",
        "paragraph rtl: فقرة تحت فقرة.",
        "code: "const a = 1;\\n\\n\\tconst b = a + 2; // <ok> & \\"done\\""",
        "table header: المنطقة | المبيعات / «الشمال والجنوب»[bold]{r2} | 120 / 80 / الشرق{c2}",
        "image: {"assetId":"image:word/media/image1.png:مربعان","alt":"مربعان"}",
        "paragraph rtl: صورة صغيرة",
        "paragraph rtl: صورة ليست على هذا الجهاز",
        "paragraph rtl: 📎 الميزانية.xlsx",
        "paragraph: «https://example.com/bookmark»[link=https://example.com/bookmark]",
        "paragraph rtl: «صفحة فرعية»[link=https://workspace.example/#/p/01936f6e-0000-7000-8000-00000000b002]",
        "paragraph rtl: المهام",
        "table header: المهمة | الحالة / قيد العمل (2){c2} / كتابة التقرير | قيد العمل / المراجعة | قيد العمل / تم (1){c2} / الإرسال | تم",
        "paragraph rtl: و997 صفوف أخرى",
        "image: {"assetId":"image:word/media/image2.png:الميزانية","alt":"الميزانية"}",
        "paragraph rtl: الميزانية",
        "paragraph rtl: Cash Gear ERP: الموردون (بياناته لا تصدر)",
        "image: {"assetId":"image:word/media/image3.png:المهام حسب الحالة","alt":"المهام حسب الحالة"}",
        "paragraph rtl: المهام حسب الحالة",
        "paragraph rtl: لوحة: المهام",
        "paragraph rtl: نص كتلة من إصدار لاحق",
        "paragraph: English, set left to right.",
        "paragraph rtl: يكتب هذا السطر من اليمين إلى اليسار.",
        "paragraph rtl: السطر الأخير.",
        "heading(1) rtl: ملاحظات، صفحة فرعية",
        "paragraph rtl: نص الصفحة الفرعية.",
      ]
    `);
  });

  it('writes XML text safely: the five escaped, characters XML refuses taken out', () => {
    expect(xml(`a<b>&"c"${String.fromCharCode(1)}${String.fromCharCode(0xfffe)}`)).toBe(
      'a&lt;b&gt;&amp;&quot;c&quot;',
    );
  });
});
