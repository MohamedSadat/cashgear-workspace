// Settings → Plugins' words for a plugin's network (Phase 13, M13.1): a section of the catalogue
// loaded with Settings, not with the app (`i18n/sections.ts`); `PluginsSection` adds it before it
// draws. Hosts are shown as written, left to right, in their own elements.
import { section, type Strings } from '../i18n/sections';

export const pluginNetworkEn = {
  field: 'Connects to',
  addNote:
    'It can send what it is given in a block, and what it receives, to these hosts and no others. Adding it allows them.',
  rowsAddNote:
    'It is shown the rows of the database view a block names, as each reader may read them, and it can send them to these hosts. Adding it allows both.',
  updateWaits:
    'This version also asks to connect to the hosts marked new. They wait until you allow them in its row.',
  newHost: 'new',
  connects: 'Connects to',
  waiting: 'Waiting for approval',
  allow: 'Allow hosts',
  allowNamed: 'Allow hosts for {{name}}',
  allowTitle: 'Allow {{name}} to connect',
  allowNote: '{{name}} will be able to send what it is given in a block to these hosts:',
  rowsAllowNote:
    '{{name}} is shown the rows of the database view a block names, and will be able to send them to these hosts:',
  allowConfirm: 'Allow',
  stop: 'Stop network',
  stopNamed: 'Stop network for {{name}}',
  allowed: '{{name}} can now connect to {{hosts}}.',
  stopped: '{{name}} no longer connects to anything.',
  hostReserved: 'The plugin names one of Cash Gear’s own hosts in its network.',
};

const pluginNetworkAr: Strings<typeof pluginNetworkEn> = {
  field: 'يتصل بـ',
  addNote:
    'يمكنه أن يرسل ما يُعطى له في الكتلة، وما يتلقاه، إلى هذه المضيفات دون غيرها. إضافته تسمح بها.',
  rowsAddNote:
    'تُعرض عليه صفوف عرض قاعدة البيانات الذي تسمّيه الكتلة، كما يحق لكل قارئ قراءتها، ويمكنه أن يرسلها إلى هذه المضيفات. إضافته تسمح بالأمرين.',
  updateWaits:
    'يطلب هذا الإصدار أيضًا الاتصال بالمضيفات المعلَّمة بأنها جديدة. تبقى منتظرة حتى تسمح بها في صفّه.',
  newHost: 'جديد',
  connects: 'يتصل بـ',
  waiting: 'في انتظار الموافقة',
  allow: 'السماح بالمضيفات',
  allowNamed: 'السماح بالمضيفات لـ {{name}}',
  allowTitle: 'السماح لـ {{name}} بالاتصال',
  allowNote: 'سيتمكن {{name}} من إرسال ما يُعطى له في الكتلة إلى هذه المضيفات:',
  rowsAllowNote:
    'تُعرض على {{name}} صفوف عرض قاعدة البيانات الذي تسمّيه الكتلة، وسيتمكن من إرسالها إلى هذه المضيفات:',
  allowConfirm: 'السماح',
  stop: 'إيقاف الاتصال بالشبكة',
  stopNamed: 'إيقاف الاتصال بالشبكة لـ {{name}}',
  allowed: 'أصبح بإمكان {{name}} الاتصال بـ {{hosts}}.',
  stopped: 'لم يعد {{name}} يتصل بأي شيء.',
  hostReserved: 'تسمّي الإضافة أحد مضيفات كاش جير نفسها في شبكتها.',
};

export const pluginNetworkWords = section('pluginNetwork', pluginNetworkEn, pluginNetworkAr);
