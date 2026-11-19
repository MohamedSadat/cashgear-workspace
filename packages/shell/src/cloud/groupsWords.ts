// Settings → Members → Groups' words (Phase 11, M11.1): a section of the catalogue loaded with
// Settings, not with the app (`i18n/sections.ts`); `GroupsSettings` adds it before it draws.
import { section, type Strings } from '../i18n/sections';

export const groupsEn = {
  title: 'Groups',
  intro:
    'Share pages and workbooks with a group at once: its people get the access the group is given. Guests are never in a group.',
  readOnly: 'Only owners and admins can make and change groups.',
  none: 'No groups yet.',
  loadFailed: 'The groups could not be read. Try again later.',
  people: 'People: {{number}}',
  nobody: 'No one is in it yet.',
  noMembers: 'The workspace has no members to add yet.',
  new: 'New group',
  newName: 'Name of the new group',
  newPeople: 'People in the new group',
  create: 'Create the group',
  created: '“{{name}}” is made.',
  edit: 'Edit',
  editLabel: 'Edit {{name}}',
  name: 'Name of the group',
  peopleIn: 'People in {{name}}',
  saved: '“{{name}}” is saved.',
  delete: 'Delete',
  deleteLabel: 'Delete {{name}}',
  deleteTitle: 'Delete the group “{{name}}”?',
  deleteBody:
    'People in it: {{number}}. They lose the access the group gives them, and the pages and workbooks shared with it no longer list it. This cannot be undone.',
  deleteConfirm: 'Delete the group',
  deleted: '“{{name}}” is deleted.',
  denied: 'Only an owner or admin can change groups.',
  invalid:
    'The server did not take that: a name is 1 to 100 characters, a workspace has at most 200 groups, and only its members can be in one.',
  nameTaken: 'Another group is already called “{{name}}”.',
  stale: '“{{name}}” was changed meanwhile, so this shows it as it is now. Make your change again.',
  gone: 'That group was deleted meanwhile.',
};

const groupsAr: Strings<typeof groupsEn> = {
  title: 'المجموعات',
  intro:
    'شارك الصفحات والمصنفات مع مجموعة دفعة واحدة: يحصل أشخاصها على الوصول الممنوح للمجموعة. لا يكون الضيوف في أي مجموعة.',
  readOnly: 'لا ينشئ المجموعات ويغيّرها إلا المالكون والمسؤولون.',
  none: 'لا توجد مجموعات بعد.',
  loadFailed: 'تعذّرت قراءة المجموعات. حاول مرة أخرى لاحقًا.',
  people: 'الأشخاص: {{number}}',
  nobody: 'لا أحد فيها بعد.',
  noMembers: 'ليس في مساحة العمل أعضاء لإضافتهم بعد.',
  new: 'مجموعة جديدة',
  newName: 'اسم المجموعة الجديدة',
  newPeople: 'الأشخاص في المجموعة الجديدة',
  create: 'إنشاء المجموعة',
  created: 'أُنشئت «{{name}}».',
  edit: 'تعديل',
  editLabel: 'تعديل {{name}}',
  name: 'اسم المجموعة',
  peopleIn: 'الأشخاص في {{name}}',
  saved: 'حُفظت «{{name}}».',
  delete: 'حذف',
  deleteLabel: 'حذف {{name}}',
  deleteTitle: 'حذف المجموعة «{{name}}»؟',
  deleteBody:
    'الأشخاص فيها: {{number}}. يفقدون الوصول الذي تمنحه لهم المجموعة، ولن تُدرج بعد الآن في الصفحات والمصنفات المشاركة معها. لا يمكن التراجع عن ذلك.',
  deleteConfirm: 'حذف المجموعة',
  deleted: 'حُذفت «{{name}}».',
  denied: 'لا يغيّر المجموعات إلا مالك أو مسؤول.',
  invalid:
    'لم يقبل الخادم ذلك: الاسم من حرف واحد إلى ١٠٠ حرف، ولمساحة العمل ٢٠٠ مجموعة على الأكثر، ولا يكون في المجموعة إلا أعضاء مساحة العمل.',
  nameTaken: 'توجد مجموعة أخرى باسم «{{name}}».',
  stale: 'تغيّرت «{{name}}» في الأثناء، فهذا يعرضها كما هي الآن. أعد تغييرك.',
  gone: 'حُذفت تلك المجموعة في الأثناء.',
};

export const groupsWords = section('groups', groupsEn, groupsAr);
