// Settings → AI's words for Cash Gear's subscription and the local embedding model, and the AI
// panel's refusal past an allowance (Phase 13, M13.4 and M13.5): a section of the catalogue loaded
// with those screens, not with the app (`i18n/sections.ts`); each adds it before it draws. Product
// and model names are placeholders, written as they are named in both languages.
import { section, type Strings } from '../i18n/sections';

export const aiPlanEn = {
  keyLegend: 'Which key AI uses',
  keyOwn: 'The workspace’s own {{provider}} key',
  keySubscription: 'Cash Gear’s subscription',
  subscriptionNote:
    'Cash Gear pays for these calls, up to the workspace’s allowance each month. No key of the workspace’s own is needed.',
  subscriptionUse: 'This month: {{used}} of {{allowance}} tokens used.',
  subscriptionHeld: '{{reserved}} more are held by calls under way.',
  embeddingsLegend: 'Where search by meaning is made',
  sourceOwn: '{{provider}}, with the workspace’s own key',
  sourceSubscription: '{{provider}}, on Cash Gear’s subscription',
  sourceLocal: 'On this server ({{model}})',
  localNote:
    'Pages are embedded on this server: no text leaves it for search by meaning. Choosing it embeds every page again.',
  allowance: 'This workspace has used its AI allowance on Cash Gear’s subscription for this month.',
};

const aiPlanAr: Strings<typeof aiPlanEn> = {
  keyLegend: 'المفتاح الذي يستخدمه الذكاء الاصطناعي',
  keyOwn: 'مفتاح {{provider}} الخاص بمساحة العمل',
  keySubscription: 'اشتراك كاش جير',
  subscriptionNote:
    'تدفع كاش جير ثمن هذه الاستدعاءات حتى الحصة الشهرية لمساحة العمل. لا حاجة إلى مفتاح خاص بمساحة العمل.',
  subscriptionUse: 'هذا الشهر: استُخدم {{used}} من {{allowance}} وحدة.',
  subscriptionHeld: 'و{{reserved}} أخرى محجوزة لاستدعاءات جارية.',
  embeddingsLegend: 'أين يجري البحث بالمعنى',
  sourceOwn: '{{provider}}، بمفتاح مساحة العمل',
  sourceSubscription: '{{provider}}، باشتراك كاش جير',
  sourceLocal: 'على هذا الخادم ({{model}})',
  localNote:
    'تُحوَّل الصفحات إلى متجهات على هذا الخادم: لا يغادره أي نص من أجل البحث بالمعنى. اختياره يعيد معالجة كل الصفحات.',
  allowance: 'استنفدت مساحة العمل حصتها الشهرية من الذكاء الاصطناعي في اشتراك كاش جير.',
};

export const aiPlanWords = section('aiPlan', aiPlanEn, aiPlanAr);
