// First-run content (DECISIONS.md, Phase 1): one "Getting started" page in each language, made
// as ordinary local edits, so they behave like any other page.
import { build, type DocJSON } from '@cgw/doc';
import type { WorkspaceSession } from './session';

const {
  docOf,
  heading,
  paragraph,
  bullet,
  numbered,
  todo,
  toggle,
  quote,
  callout,
  divider,
  code,
  text,
  table,
} = build;

function english(): DocJSON {
  return docOf(
    paragraph('Welcome to your workspace. Everything here is saved on this device as you type.'),
    heading(2, 'The basics'),
    todo(true, 'Open this page'),
    todo(
      false,
      'Type ',
      text('/', 'code'),
      ' on an empty line to add a heading, a list, a table or an image',
    ),
    todo(
      false,
      'Select text to make it ',
      text('bold', 'bold'),
      ', ',
      text('italic', 'italic'),
      ' or a link',
    ),
    todo(
      false,
      'Drag the handle beside a block to move it; press Tab to put it inside the block above',
    ),
    todo(false, 'Press Ctrl+K to search your pages and run commands'),
    heading(2, 'Shortcuts you can type'),
    bullet([text('# ', 'code'), ' a heading, ', text('## ', 'code'), ' a smaller one']),
    bullet([
      text('- ', 'code'),
      ' a bulleted list, ',
      text('1. ', 'code'),
      ' a numbered list, ',
      text('[] ', 'code'),
      ' a to-do',
    ]),
    bullet([
      text('> ', 'code'),
      ' a quote, ',
      text('```', 'code'),
      ' a code block, ',
      text('---', 'code'),
      ' a divider',
    ]),
    toggle(
      ['Click the arrow to open this toggle'],
      [paragraph('Toggles hide what is inside them until you open them.')],
    ),
    callout('💡', 'info', 'Pages can hold pages. Use the + beside a page in the sidebar.'),
    numbered(['Create a page']),
    numbered(['Give it a title and an icon']),
    numbered(['Write']),
    quote(
      'Arabic and English sit side by side: each paragraph takes its direction from its first letter.',
    ),
    paragraph('مرحبًا! هذه فقرة عربية داخل صفحة إنجليزية.'),
    table(
      [
        ['Shortcut', 'What it does'],
        ['Ctrl+K', 'Search and commands'],
        ['Ctrl+\\', 'Show or hide the sidebar'],
        ['Alt+Shift+↑ / ↓', 'Move a block up or down'],
      ],
      true,
    ),
    code('javascript', "console.log('Hello, workspace');"),
    divider(),
    paragraph('Your work stays on this device. Export the workspace from Settings to keep a copy.'),
  );
}

function arabic(): DocJSON {
  return docOf(
    paragraph('أهلًا بك في مساحة عملك. يُحفظ كل ما تكتبه هنا على هذا الجهاز أثناء الكتابة.'),
    heading(2, 'الأساسيات'),
    todo(true, 'افتح هذه الصفحة'),
    todo(false, 'اكتب ', text('/', 'code'), ' في سطر فارغ لإضافة عنوان أو قائمة أو جدول أو صورة'),
    todo(
      false,
      'حدّد نصًا لتجعله ',
      text('عريضًا', 'bold'),
      ' أو ',
      text('مائلًا', 'italic'),
      ' أو رابطًا',
    ),
    todo(false, 'اسحب المقبض بجانب الكتلة لنقلها، واضغط Tab لوضعها داخل الكتلة التي فوقها'),
    todo(false, 'اضغط Ctrl+K للبحث في صفحاتك وتشغيل الأوامر'),
    heading(2, 'اختصارات يمكنك كتابتها'),
    bullet([text('# ', 'code'), ' عنوان، و', text('## ', 'code'), ' عنوان أصغر']),
    bullet([
      text('- ', 'code'),
      ' قائمة نقطية، و',
      text('1. ', 'code'),
      ' قائمة مرقّمة، و',
      text('[] ', 'code'),
      ' مهمة',
    ]),
    bullet([
      text('> ', 'code'),
      ' اقتباس، و',
      text('```', 'code'),
      ' شيفرة، و',
      text('---', 'code'),
      ' فاصل',
    ]),
    toggle(
      ['انقر السهم لفتح هذه القائمة'],
      [paragraph('تُخفي القوائم القابلة للطي محتواها حتى تفتحها.')],
    ),
    callout(
      '💡',
      'info',
      'يمكن أن تحتوي الصفحات على صفحات. استخدم + بجانب الصفحة في الشريط الجانبي.',
    ),
    numbered(['أنشئ صفحة']),
    numbered(['أعطها عنوانًا ورمزًا']),
    numbered(['اكتب']),
    quote('تتجاور العربية والإنجليزية: تأخذ كل فقرة اتجاهها من أول حرف فيها.'),
    paragraph('Hello! This is an English paragraph inside an Arabic page.'),
    table(
      [
        ['الاختصار', 'وظيفته'],
        ['Ctrl+K', 'البحث والأوامر'],
        ['Ctrl+\\', 'إظهار الشريط الجانبي أو إخفاؤه'],
        ['Alt+Shift+↑ / ↓', 'نقل الكتلة للأعلى أو للأسفل'],
      ],
      true,
    ),
    divider(),
    paragraph('يبقى عملك على هذا الجهاز. صدّر مساحة العمل من الإعدادات للاحتفاظ بنسخة.'),
  );
}

export interface FirstRunNames {
  workspace: string;
  shared: string;
  private: string;
}

/** A new workspace with both Getting started pages; returns the page to open first. */
export async function createFirstWorkspace(
  session: WorkspaceSession,
  names: FirstRunNames,
  language: 'en' | 'ar',
): Promise<string> {
  const { shared } = await session.createWorkspace(names.workspace, {
    shared: names.shared,
    private: names.private,
  });
  const pages = [
    { language: 'en' as const, title: 'Getting started', json: english() },
    { language: 'ar' as const, title: 'البداية', json: arabic() },
  ];
  // The page in the interface language comes first.
  pages.sort((a) => (a.language === language ? -1 : 1));
  let first = '';
  for (const { title, json } of pages) {
    const page = await session.createPage(
      { sectionId: shared.id, parentPageId: null, title, icon: '👋' },
      json,
    );
    first ||= page.id;
  }
  return first;
}
