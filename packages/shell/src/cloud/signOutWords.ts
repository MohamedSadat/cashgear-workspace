// Settings → Account's sign-out, with the choice to remove the account's synced workspaces from
// this device (2026-11-21): a section of the catalogue loaded with Settings, not with the app
// (`i18n/sections.ts`); `SignOutSection` adds it before it draws.
import { section, type Strings } from '../i18n/sections';

export const signOutEn = {
  remove: "Also remove this account's workspaces from this device",
  removeNote:
    'They stay on the server and come back when you sign in again. Workspaces kept on this device only are not removed. Without this, they stay here hidden until this account signs in again.',
  removing: 'Sending your changes, then signing out…',
  waiting:
    'Nothing was removed and you are still signed in: {{number}} changes have not reached the server yet. Connect to the internet, wait until it says Synced, then try again.',
};

const signOutAr: Strings<typeof signOutEn> = {
  remove: 'إزالة مساحات العمل الخاصة بهذا الحساب من هذا الجهاز أيضًا',
  removeNote:
    'تبقى على الخادم وتعود عند تسجيل الدخول مرة أخرى. لا تُزال مساحات العمل المحفوظة على هذا الجهاز فقط. دون ذلك تبقى هنا مخفية حتى يسجّل هذا الحساب الدخول مرة أخرى.',
  removing: 'جارٍ إرسال تغييراتك ثم تسجيل الخروج…',
  waiting:
    'لم تتم إزالة أي شيء وما زلت مسجّل الدخول: لم يصل {{number}} من التغييرات إلى الخادم بعد. اتصل بالإنترنت وانتظر حتى تظهر عبارة تمت المزامنة، ثم حاول مرة أخرى.',
};

export const signOutWords = section('signOut', signOutEn, signOutAr);
