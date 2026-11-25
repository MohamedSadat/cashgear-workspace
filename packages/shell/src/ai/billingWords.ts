// Settings → AI's words for Cash Gear's paid plans (Phase 18, M18.2): a section of the catalogue
// loaded with the plan's part of Settings, not with the app (`i18n/sections.ts`). The provider's name
// (Paddle) and the plans' names are placeholders, written as they are named in both languages.
import { section, type Strings } from '../i18n/sections';

export const billingEn = {
  title: 'Cash Gear’s plan',
  note: 'A paid plan gives the workspace a larger AI allowance on Cash Gear’s subscription each month. {{provider}} takes the payment: the card is typed into {{provider}}’s own pages, never into Cash Gear Workspace.',
  loading: 'Loading the plans…',
  failed: 'The plans could not be read. Try again later.',
  current: 'The workspace is on the {{plan}} plan.',
  none: 'The workspace is on no paid plan.',
  periodEnds: 'Paid until {{date}}.',
  cancels: 'It ends on {{date}}: it was cancelled.',
  pauses: 'It is paused from {{date}}.',
  pastDue: 'A payment failed. {{provider}} is trying again; the plan holds meanwhile.',
  ended: 'The last plan ended ({{status}}).',
  statusCanceled: 'cancelled',
  statusPaused: 'paused',
  allowance: '{{tokens}} tokens a month for AI, {{embeddings}} for search by meaning',
  price: '{{price}} a month',
  priceEvery: '{{price}} every {{count}} months',
  priceYear: '{{price}} a year',
  noPrice: 'Price shown at checkout',
  subscribe: 'Subscribe',
  subscribeTo: 'Subscribe to {{plan}}',
  switch: 'Switch to {{plan}}',
  switchConfirm:
    'Switch the workspace to {{plan}} now? {{provider}} charges or credits the difference for the rest of the period.',
  thisPlan: 'This plan',
  manage: 'Manage billing',
  manageNote: 'Payment method, invoices and cancelling are in {{provider}}’s portal.',
  opened:
    '{{provider}}’s checkout opened in a new tab. The plan shows here within a minute of paying.',
  waiting: 'Waiting for the payment…',
  refresh: 'Check again',
  ownersOnly: 'Only an owner subscribes the workspace or changes its plan.',
  problem: '{{provider}} could not be reached. Try again in a moment.',
  subscribed: 'The workspace is on a plan already: switch its plan instead.',
  plansLabel: 'Plans',
};

const billingAr: Strings<typeof billingEn> = {
  title: 'خطة كاش جير',
  note: 'تمنح الخطة المدفوعة مساحة العمل حصة شهرية أكبر من الذكاء الاصطناعي في اشتراك كاش جير. تتولى {{provider}} الدفع: تُكتب بيانات البطاقة في صفحات {{provider}} نفسها، ولا تصل أبدًا إلى مساحة عمل كاش جير.',
  loading: 'جارٍ تحميل الخطط…',
  failed: 'تعذّرت قراءة الخطط. حاول لاحقًا.',
  current: 'مساحة العمل على خطة {{plan}}.',
  none: 'مساحة العمل ليست على خطة مدفوعة.',
  periodEnds: 'مدفوعة حتى {{date}}.',
  cancels: 'تنتهي في {{date}}: أُلغيت.',
  pauses: 'تتوقف مؤقتًا من {{date}}.',
  pastDue: 'فشلت عملية دفع. تعيد {{provider}} المحاولة، وتبقى الخطة سارية في الأثناء.',
  ended: 'انتهت الخطة السابقة ({{status}}).',
  statusCanceled: 'أُلغيت',
  statusPaused: 'متوقفة مؤقتًا',
  allowance: '{{tokens}} وحدة شهريًا للذكاء الاصطناعي، و{{embeddings}} للبحث بالمعنى',
  price: '{{price}} شهريًا',
  priceEvery: '{{price}} كل {{count}} أشهر',
  priceYear: '{{price}} سنويًا',
  noPrice: 'يظهر السعر عند الدفع',
  subscribe: 'اشترك',
  subscribeTo: 'اشترك في {{plan}}',
  switch: 'انتقل إلى {{plan}}',
  switchConfirm:
    'هل تنقل مساحة العمل إلى {{plan}} الآن؟ تحتسب {{provider}} الفرق عن بقية المدة، دفعًا أو رصيدًا.',
  thisPlan: 'هذه الخطة',
  manage: 'إدارة الفوترة',
  manageNote: 'وسيلة الدفع والفواتير والإلغاء في بوابة {{provider}}.',
  opened:
    'فُتحت صفحة الدفع من {{provider}} في علامة تبويب جديدة. تظهر الخطة هنا خلال دقيقة من الدفع.',
  waiting: 'بانتظار الدفع…',
  refresh: 'تحقّق مجددًا',
  ownersOnly: 'وحده المالك يشترك لمساحة العمل أو يغيّر خطتها.',
  problem: 'تعذّر الوصول إلى {{provider}}. حاول بعد قليل.',
  subscribed: 'مساحة العمل على خطة بالفعل: غيّر خطتها بدلًا من ذلك.',
  plansLabel: 'الخطط',
};

export const billingWords = section('billing', billingEn, billingAr);
