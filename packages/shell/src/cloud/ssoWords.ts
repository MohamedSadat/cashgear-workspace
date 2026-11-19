// Settings → Single sign-on's words (Phase 11, M11.3), and Settings → Account's password: a
// section of the catalogue loaded with Settings, not with the app (`i18n/sections.ts`);
// `SsoSettings` and `PasswordSettings` add it before they draw. The sign-in page's link is quoted
// as the API's page writes it.
import { section, type Strings } from '../i18n/sections';

export const ssoEn = {
  title: 'Single sign-on',
  intro:
    'People whose addresses are in your organisation’s domains can sign in through its own provider, with no password here. Only the workspace’s owners see this.',
  protocol: 'The provider’s protocol:',
  loadFailed: 'The single sign-on settings could not be read. Try again later.',
  providerTitle: 'Your provider',
  redirect: 'Redirect address',
  redirectNote:
    'Register this address at your provider as the application’s redirect address (where sign-in comes back to).',
  copy: 'Copy {{what}}',
  copied: 'Copied {{what}}',
  whatRedirect: 'the redirect address',
  whatName: 'the record name for {{domain}}',
  whatValue: 'the record value for {{domain}}',
  copyFailed: 'Could not copy. Select the text and copy it.',
  issuer: 'Issuer',
  issuerNote:
    'The provider’s address, as it names itself; its settings are read from there when you save.',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  secretSet: 'A secret is set. It is never shown again: type a new one to replace it.',
  secretNone: 'No secret is set.',
  secretRemoving: 'The secret is removed when you save.',
  removeSecret: 'Remove the secret',
  keepSecret: 'Keep the secret',
  join: 'People of these domains join the workspace as members',
  joinNote:
    'When off, signing in makes their account, and only the people you invite join the workspace.',
  hours: 'Session length (hours)',
  hoursNote:
    'From {{min}} to {{max}} hours. A session made through the provider ends then, however much it is used.',
  hoursInvalid: 'A session lasts from {{min}} to {{max}} whole hours.',
  tested: 'Tested {{when}}: an owner signed in through it.',
  untested:
    "Not tested yet. Before sign-on can be required, an owner signs in through the provider once: sign out, then on the sign-in page choose “Sign in with your organisation's account”.",
  save: 'Save the provider',
  saved: 'The provider is saved.',
  removeProvider: 'Remove the provider',
  removeProviderTitle: 'Remove the provider?',
  removeProviderBody:
    'People of your domains can no longer sign in through it, and sign-on required for a domain turns off: they sign in with a password or a passkey again. Your domains stay proven.',
  providerRemoved: 'The provider is removed. Sign-on is no longer required for any domain.',
  domainsTitle: 'Domains',
  domainsIntro:
    'Prove each of your organisation’s domains with a text record in its DNS. A domain belongs to one workspace.',
  domainsNone: 'No domains yet.',
  domain: 'Domain to add',
  add: 'Add the domain',
  added: '{{domain}} is added. Create its record, then press Verify.',
  verifiedOn: 'Verified {{when}}',
  unverified: 'Not verified yet',
  recordIntro: 'Create this text record at your DNS host, then press Verify:',
  recordName: 'Name',
  recordValue: 'Value',
  verify: 'Verify',
  verifyLabel: 'Verify {{domain}}',
  verified: '{{domain}} is verified.',
  require: 'Require sign-in through the provider',
  requireLabel: 'Require sign-in through the provider for {{domain}}',
  requireNote:
    'Its people then sign in only through your provider. Turning it on signs out those of them signed in another way; the workspace’s owners keep their password and their sessions.',
  requireTitle: 'Require sign-on for {{domain}}?',
  requireBody:
    'People of {{domain}} can then sign in only through your provider: those signed in with a password or a passkey are signed out now, on every device. The workspace’s owners are not, and keep their password.',
  requireConfirm: 'Require sign-on',
  requiredOn: 'Sign-on is now required for {{domain}}.',
  requiredOff: 'Sign-on is no longer required for {{domain}}.',
  remove: 'Remove',
  removeLabel: 'Remove {{domain}}',
  removeDomainTitle: 'Remove {{domain}}?',
  removeDomainBody:
    'Its people can no longer sign in through your provider, and sign-on is no longer required for it. To use it again, add it and prove it again.',
  removeDomainConfirm: 'Remove the domain',
  removed: '{{domain}} is removed.',
  domainTaken:
    '{{domain}} is proven by another workspace already. A domain belongs to one workspace: it must be removed there first.',
  dnsNotFound:
    'The record for {{domain}} was not found yet. DNS can take a while to show a new record: try again in a few minutes.',
  notTested:
    "Sign-on cannot be required yet: an owner must first sign in through the provider. Sign out, then on the sign-in page choose “Sign in with your organisation's account”.",
  discoveryFailed:
    'The provider’s settings could not be read from {{issuer}}. Check the issuer, and that the provider can be reached.',
  stale:
    'Single sign-on was changed meanwhile: it is shown again as it is now. Make your change again.',
  invalidProvider:
    'The server did not take these values. The issuer is the provider’s secure web address; the client ID is 1 to 256 characters; a secret is 1 to 500 characters with no spaces.',
  invalidDomain:
    'That is not a domain name the server takes: it needs at least one dot, and no “*”.',
  domainAdded: '{{domain}} is added already.',
  domainGone: '{{domain}} was removed meanwhile.',
  providerGone: 'The provider was removed meanwhile.',
  denied: 'Only the workspace’s owners can change single sign-on.',
  passwordTitle: 'Password',
  passwordNone:
    'This account has no password: it signs in through your organisation’s account. You can set one too, by a link sent to {{email}}.',
  setPassword: 'Set a password',
  passwordSent:
    'A link to set a password is on its way to {{email}}. Open it, choose a password, then sign in with it whenever you like.',
  passwordByOrganisation:
    'Your organisation signs this account in through its own sign-in: a password does not sign it in.',
};

const ssoAr: Strings<typeof ssoEn> = {
  title: 'تسجيل الدخول الموحّد',
  intro:
    'يستطيع من عناوينهم في نطاقات مؤسستك تسجيل الدخول عبر مزوّدها الخاص، دون كلمة مرور هنا. لا يرى هذا إلا مالكو مساحة العمل.',
  protocol: 'بروتوكول المزوّد:',
  loadFailed: 'تعذّرت قراءة إعدادات تسجيل الدخول الموحّد. حاول مرة أخرى لاحقًا.',
  providerTitle: 'مزوّدك',
  redirect: 'عنوان إعادة التوجيه',
  redirectNote: 'سجّل هذا العنوان لدى مزوّدك عنوانًا لإعادة توجيه التطبيق (حيث يعود تسجيل الدخول).',
  copy: 'نسخ {{what}}',
  copied: 'نُسخ {{what}}',
  whatRedirect: 'عنوان إعادة التوجيه',
  whatName: 'اسم السجل للنطاق {{domain}}',
  whatValue: 'قيمة السجل للنطاق {{domain}}',
  copyFailed: 'تعذّر النسخ. حدّد النص وانسخه.',
  issuer: 'المُصدِر',
  issuerNote: 'عنوان المزوّد كما يسمّي نفسه؛ تُقرأ إعداداته منه عند الحفظ.',
  clientId: 'معرّف العميل',
  clientSecret: 'سر العميل',
  secretSet: 'السر محفوظ. لا يُعرض مرة أخرى أبدًا: اكتب سرًا جديدًا ليحل محله.',
  secretNone: 'لا يوجد سر محفوظ.',
  secretRemoving: 'يُزال السر عند الحفظ.',
  removeSecret: 'إزالة السر',
  keepSecret: 'إبقاء السر',
  join: 'ينضم أصحاب عناوين هذه النطاقات إلى مساحة العمل أعضاءً',
  joinNote: 'عند إيقافه، يُنشئ تسجيل الدخول حساباتهم، ولا ينضم إلى مساحة العمل إلا من تدعوهم.',
  hours: 'مدة الجلسة (بالساعات)',
  hoursNote:
    'من {{min}} إلى {{max}} ساعة. تنتهي عندها الجلسة التي تُنشأ عبر المزوّد، مهما استُخدمت.',
  hoursInvalid: 'تدوم الجلسة من {{min}} إلى {{max}} ساعة كاملة.',
  tested: 'جُرّب {{when}}: سجّل أحد المالكين دخوله عبره.',
  untested:
    'لم يُجرَّب بعد. قبل أن يصبح تسجيل الدخول الموحّد إلزاميًا، يسجّل أحد المالكين دخوله عبر المزوّد مرة واحدة: سجّل خروجك، ثم اختر في صفحة تسجيل الدخول «تسجيل الدخول بحساب مؤسستك».',
  save: 'حفظ المزوّد',
  saved: 'حُفظ المزوّد.',
  removeProvider: 'إزالة المزوّد',
  removeProviderTitle: 'إزالة المزوّد؟',
  removeProviderBody:
    'لن يتمكن أصحاب عناوين نطاقاتك بعد الآن من تسجيل الدخول عبره، ويتوقف إلزام تسجيل الدخول الموحّد لأي نطاق: يعودون إلى تسجيل الدخول بكلمة مرور أو مفتاح مرور. تبقى نطاقاتك مُثبتة.',
  providerRemoved: 'أُزيل المزوّد. لم يعد تسجيل الدخول الموحّد إلزاميًا لأي نطاق.',
  domainsTitle: 'النطاقات',
  domainsIntro:
    'أثبت كل نطاق من نطاقات مؤسستك بسجل نصي في نظام أسماء النطاقات الخاص به. ينتمي النطاق إلى مساحة عمل واحدة.',
  domainsNone: 'لا توجد نطاقات بعد.',
  domain: 'النطاق المراد إضافته',
  add: 'إضافة النطاق',
  added: 'أُضيف {{domain}}. أنشئ سجله، ثم اضغط «تحقّق».',
  verifiedOn: 'تُحقّق منه {{when}}',
  unverified: 'لم يُتحقّق منه بعد',
  recordIntro: 'أنشئ هذا السجل النصي لدى مزوّد نظام أسماء النطاقات، ثم اضغط «تحقّق»:',
  recordName: 'الاسم',
  recordValue: 'القيمة',
  verify: 'تحقّق',
  verifyLabel: 'تحقّق من {{domain}}',
  verified: 'تُحقّق من {{domain}}.',
  require: 'إلزام تسجيل الدخول عبر المزوّد',
  requireLabel: 'إلزام تسجيل الدخول عبر المزوّد للنطاق {{domain}}',
  requireNote:
    'عندها لا يسجّل أصحاب عناوينه الدخول إلا عبر مزوّدك. تشغيله يُخرج منهم من سجّل دخوله بطريقة أخرى؛ ويحتفظ مالكو مساحة العمل بكلمة مرورهم وجلساتهم.',
  requireTitle: 'إلزام تسجيل الدخول الموحّد للنطاق {{domain}}؟',
  requireBody:
    'لن يتمكن أصحاب عناوين {{domain}} بعدها من تسجيل الدخول إلا عبر مزوّدك: يُسجَّل الآن خروج من سجّل دخوله بكلمة مرور أو مفتاح مرور، على كل جهاز. أما مالكو مساحة العمل فلا، ويحتفظون بكلمة مرورهم.',
  requireConfirm: 'إلزام تسجيل الدخول الموحّد',
  requiredOn: 'صار تسجيل الدخول الموحّد إلزاميًا للنطاق {{domain}}.',
  requiredOff: 'لم يعد تسجيل الدخول الموحّد إلزاميًا للنطاق {{domain}}.',
  remove: 'إزالة',
  removeLabel: 'إزالة {{domain}}',
  removeDomainTitle: 'إزالة {{domain}}؟',
  removeDomainBody:
    'لن يتمكن أصحاب عناوينه بعد الآن من تسجيل الدخول عبر مزوّدك، ولن يبقى تسجيل الدخول الموحّد إلزاميًا له. لاستخدامه مجددًا، أضفه وأثبته من جديد.',
  removeDomainConfirm: 'إزالة النطاق',
  removed: 'أُزيل {{domain}}.',
  domainTaken:
    'أثبتت مساحة عمل أخرى {{domain}} من قبل. ينتمي النطاق إلى مساحة عمل واحدة: يجب أن يُزال منها أولًا.',
  dnsNotFound:
    'لم يُعثر على سجل {{domain}} بعد. قد يستغرق ظهور السجل الجديد في نظام أسماء النطاقات بعض الوقت: حاول مرة أخرى بعد دقائق.',
  notTested:
    'لا يمكن إلزام تسجيل الدخول الموحّد بعد: يجب أن يسجّل أحد المالكين دخوله عبر المزوّد أولًا. سجّل خروجك، ثم اختر في صفحة تسجيل الدخول «تسجيل الدخول بحساب مؤسستك».',
  discoveryFailed:
    'تعذّرت قراءة إعدادات المزوّد من {{issuer}}. تحقّق من المُصدِر، ومن إمكان الوصول إلى المزوّد.',
  stale: 'تغيّر تسجيل الدخول الموحّد في الأثناء: يُعرض من جديد كما هو الآن. أجرِ تغييرك مرة أخرى.',
  invalidProvider:
    'لم يقبل الخادم هذه القيم. المُصدِر هو عنوان المزوّد الآمن على الويب؛ ومعرّف العميل من حرف واحد إلى ٢٥٦ حرفًا؛ والسر من حرف واحد إلى ٥٠٠ حرف دون مسافات.',
  invalidDomain: 'هذا ليس اسم نطاق يقبله الخادم: يحتاج إلى نقطة واحدة على الأقل، ودون «*».',
  domainAdded: 'أُضيف {{domain}} من قبل.',
  domainGone: 'أُزيل {{domain}} في الأثناء.',
  providerGone: 'أُزيل المزوّد في الأثناء.',
  denied: 'لا يغيّر تسجيل الدخول الموحّد إلا مالكو مساحة العمل.',
  passwordTitle: 'كلمة المرور',
  passwordNone:
    'ليست لهذا الحساب كلمة مرور: يسجّل دخوله بحساب مؤسستك. يمكنك تعيين واحدة أيضًا، برابط يُرسل إلى {{email}}.',
  setPassword: 'تعيين كلمة مرور',
  passwordSent:
    'رابط تعيين كلمة المرور في طريقه إلى {{email}}. افتحه، واختر كلمة مرور، ثم سجّل الدخول بها متى شئت.',
  passwordByOrganisation:
    'تسجّل مؤسستك دخول هذا الحساب عبر تسجيل دخولها الخاص: لا تسجّل كلمة المرور دخوله.',
};

export const ssoWords = section('sso', ssoEn, ssoAr);
