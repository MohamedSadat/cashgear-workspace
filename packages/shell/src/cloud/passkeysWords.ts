// Settings → Account → Passkeys' words (Phase 11, M11.2): a section of the catalogue loaded with
// Settings, not with the app (`i18n/sections.ts`); `PasskeysSettings` adds it before it draws.
import { section, type Strings } from '../i18n/sections';

export const passkeysEn = {
  title: 'Passkeys',
  intro:
    'A passkey signs you in without your password: your device asks for your fingerprint, face or PIN, or your password manager keeps it. Passkeys are added on the sign-in pages.',
  none: 'No passkeys yet.',
  loadFailed: 'The passkeys could not be read. Try again later.',
  added: 'Added {{when}}',
  lastUsed: 'Last used {{when}}',
  neverUsed: 'Not used yet',
  add: 'Add a passkey',
  full: 'An account has at most {{number}} passkeys. Remove one to add another.',
  inBrowser:
    'Add the passkey in your browser, then come back here: the list is read again when you do.',
  rename: 'Rename',
  renameLabel: 'Rename {{name}}',
  name: 'Name of the passkey',
  renamed: 'The passkey is now called “{{name}}”.',
  remove: 'Remove',
  removeLabel: 'Remove {{name}}',
  removeTitle: 'Remove the passkey “{{name}}”?',
  removeBody:
    'You can no longer sign in with it. Sessions it signed in stay signed in until you sign them out under “Devices signed in”.',
  removeConfirm: 'Remove the passkey',
  removed: '“{{name}}” is removed.',
  invalid: 'A passkey’s name is 1 to 60 characters.',
  gone: 'That passkey was removed meanwhile.',
};

const passkeysAr: Strings<typeof passkeysEn> = {
  title: 'مفاتيح المرور',
  intro:
    'يسجّل مفتاح المرور دخولك دون كلمة المرور: يطلب جهازك بصمتك أو وجهك أو رمزه السري، أو يحفظه مدير كلمات المرور. تُضاف مفاتيح المرور في صفحات تسجيل الدخول.',
  none: 'لا توجد مفاتيح مرور بعد.',
  loadFailed: 'تعذّرت قراءة مفاتيح المرور. حاول مرة أخرى لاحقًا.',
  added: 'أُضيف {{when}}',
  lastUsed: 'آخر استخدام {{when}}',
  neverUsed: 'لم يُستخدم بعد',
  add: 'إضافة مفتاح مرور',
  full: 'للحساب {{number}} مفتاح مرور على الأكثر. أزل واحدًا لتضيف غيره.',
  inBrowser: 'أضف مفتاح المرور في متصفحك، ثم عد إلى هنا: تُقرأ القائمة من جديد عند عودتك.',
  rename: 'إعادة تسمية',
  renameLabel: 'إعادة تسمية {{name}}',
  name: 'اسم مفتاح المرور',
  renamed: 'صار اسم مفتاح المرور «{{name}}».',
  remove: 'إزالة',
  removeLabel: 'إزالة {{name}}',
  removeTitle: 'إزالة مفتاح المرور «{{name}}»؟',
  removeBody:
    'لن تتمكن بعد الآن من تسجيل الدخول به. تبقى الجلسات التي سجّل دخولها مسجّلة حتى تسجّل خروجها من «الأجهزة المسجّل فيها الدخول».',
  removeConfirm: 'إزالة مفتاح المرور',
  removed: 'أُزيل «{{name}}».',
  invalid: 'اسم مفتاح المرور من حرف واحد إلى ٦٠ حرفًا.',
  gone: 'أُزيل مفتاح المرور هذا في الأثناء.',
};

export const passkeysWords = section('passkeys', passkeysEn, passkeysAr);
