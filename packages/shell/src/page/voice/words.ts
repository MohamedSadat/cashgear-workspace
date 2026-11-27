// The voice note's words (after 0.19.0): a section of the catalogue loaded with an open page, not
// with the app (`i18n/sections.ts`); `PageView` adds it before its slash menu lists "Voice note",
// and the recorder uses it too.
import { section, type Strings } from '../../i18n/sections';

export const voiceEn = {
  // The slash menu's entry and the words that find it (blockCommands.ts).
  block: 'Voice note',
  keywords: 'voice note audio record recording microphone',
  title: 'Record a voice note',
  ready: 'Press Record to start. The browser asks to use the microphone the first time.',
  limit: 'A voice note can be up to {{minutes}} minutes long; recording stops then.',
  record: 'Record',
  stop: 'Stop',
  again: 'Record again',
  insert: 'Insert',
  cancel: 'Cancel',
  asking: 'Waiting for the microphone…',
  recording: 'Recording',
  recorded: 'Listen to it before you insert it.',
  preview: 'The recording',
  denied:
    'The microphone is not allowed for this site. Allow it in the browser’s site settings, then try again.',
  none: 'No microphone was found.',
  failed: 'The recording could not start.',
  empty: 'Nothing was recorded. Try again.',
  fileName: 'Voice note',
};

export const voiceAr: Strings<typeof voiceEn> = {
  block: 'ملاحظة صوتية',
  keywords: 'ملاحظة صوتية صوت تسجيل ميكروفون',
  title: 'تسجيل ملاحظة صوتية',
  ready: 'اضغط «تسجيل» للبدء. يطلب المتصفح استخدام الميكروفون في المرة الأولى.',
  limit: 'يمكن أن تصل الملاحظة الصوتية إلى {{minutes}} دقيقة، ويتوقف التسجيل عندها.',
  record: 'تسجيل',
  stop: 'إيقاف',
  again: 'إعادة التسجيل',
  insert: 'إدراج',
  cancel: 'إلغاء',
  asking: 'في انتظار الميكروفون…',
  recording: 'جارٍ التسجيل',
  recorded: 'استمع إليه قبل إدراجه.',
  preview: 'التسجيل',
  denied:
    'الميكروفون غير مسموح به لهذا الموقع. اسمح به من إعدادات الموقع في المتصفح، ثم حاول مرة أخرى.',
  none: 'لم يُعثر على ميكروفون.',
  failed: 'تعذّر بدء التسجيل.',
  empty: 'لم يُسجَّل شيء. حاول مرة أخرى.',
  fileName: 'ملاحظة صوتية',
};

export const voiceWords = section('voice', voiceEn, voiceAr);
