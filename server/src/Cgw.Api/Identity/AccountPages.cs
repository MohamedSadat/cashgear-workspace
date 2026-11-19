using System.Text;
using System.Text.Encodings.Web;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Identity;

namespace Cgw.Api.Identity;

/// <summary>A posted form's fields; binding an IFormCollection also requires the antiforgery token.</summary>
internal sealed class Form(IFormCollection form)
{
    private string? F(string name) => form.TryGetValue(name, out var v) ? v.ToString() : null;
    public string? Email => F("Email");
    public string? Password => F("Password");
    public string? DisplayName => F("DisplayName");
    public string? ReturnUrl => F("ReturnUrl");
    public string? Lang => F("Lang");
    public string? Code => F("Code");
    public Guid UserId => Guid.TryParse(F("UserId"), out var id) ? id : Guid.Empty;
    /// <summary>Phase 11: a passkey ceremony's answer, as the page's script serialised it (PublicKeyCredential JSON).</summary>
    public string? Credential => F("Credential");
    /// <summary>Phase 11: a new passkey's name.</summary>
    public string? Name => F("Name");
}

/// <summary>
/// Phase 11: the one script the account pages have (<c>/account/passkey.js</c>, Identity/passkey.js
/// embedded): the passkey ceremonies, nothing inline. Served with its hash as the page's integrity.
/// </summary>
internal static class PasskeyScript
{
    public static readonly byte[] Bytes = Load();
    public static readonly string Integrity = "sha256-" + Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(Bytes));
    /// <summary>In the script's address, so a new script is never read from an old cache.</summary>
    public static readonly string Version = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Bytes))[..12];

    private static byte[] Load()
    {
        using var stream = typeof(PasskeyScript).Assembly.GetManifestResourceStream("Cgw.Api.Identity.passkey.js")
            ?? throw new InvalidOperationException("The passkey script is not in the assembly.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return Encoding.UTF8.GetBytes(reader.ReadToEnd());
    }
}

/// <summary>
/// The sign-in pages, served by the API on its own origin (ARCHITECTURE.md, Authentication). The
/// web app sends people here and gets them back with a cookie; the desktop app opens them in the
/// system browser through /connect/authorize. Passwords are typed only here, never into the app.
/// Forms carry an antiforgery token; every value written into a page is HTML-encoded. Nothing
/// changes on a GET: a link in a mail opens a page whose button does the work, so a mail scanner
/// that follows links confirms nothing.
/// </summary>
public static class AccountPages
{
    /// <summary>The consent form's button field (Continue or Cancel) on /connect/authorize.</summary>
    public const string ConsentField = "cgw_consent";

    private static readonly Dictionary<string, string> En = new()
    {
        ["product"] = "Cash Gear Workspace",
        ["signIn"] = "Sign in",
        ["signInTitle"] = "Sign in to Cash Gear Workspace",
        ["signUp"] = "Create an account",
        ["email"] = "Email",
        ["password"] = "Password",
        ["newPassword"] = "New password (at least 10 characters)",
        ["name"] = "Your name",
        ["forgot"] = "Forgot your password?",
        ["haveAccount"] = "Already have an account? Sign in",
        ["invalid"] = "The email or password is not right. Repeated wrong tries pause signing in for 15 minutes.",
        ["notConfirmed"] = "Confirm your email first. We can send the link again.",
        ["resend"] = "Send the link again",
        ["checkMail"] = "Check your email",
        ["checkMailBody"] = "If the address can be used, a mail with a link is on its way. A sign-up link lasts 24 hours, a password link one hour.",
        ["confirmTitle"] = "Confirm your email",
        ["confirmBody"] = "Press Confirm to finish making your account.",
        ["confirmButton"] = "Confirm",
        ["confirmed"] = "Your email is confirmed",
        ["confirmedBody"] = "You can sign in now.",
        ["badLink"] = "This link is not valid or has expired.",
        ["forgotTitle"] = "Reset your password",
        ["forgotBody"] = "We will mail you a link to choose a new password.",
        ["sendLink"] = "Send the link",
        ["resetTitle"] = "Choose a new password",
        ["resetDone"] = "Your password is changed. Every device has been signed out.",
        ["save"] = "Save",
        ["consentTitle"] = "Sign in the desktop app",
        ["consentAsk"] = "Sign in the Cash Gear Workspace desktop app on this computer as {0}?",
        ["consentOnly"] = "Only continue if you just pressed Sign in in the app.",
        ["continue"] = "Continue",
        ["cancel"] = "Cancel",
        ["expired"] = "The page had expired. Read it again and choose.",
        ["deleteTitle"] = "Delete your account",
        ["deleteAs"] = "Signed in as {0}.",
        ["deleteBody"] = "Workspaces only you are in are deleted, and you leave the others. Your edits in shared pages stay, shown as “Deleted user”. This cannot be undone.",
        ["deleteButton"] = "Delete my account",
        ["deleteWrong"] = "The password is not right. Repeated wrong tries pause this for 15 minutes.",
        ["deleteHeld"] = "You are the only owner of a workspace that has other members: make one of them an owner first.",
        ["deleteDone"] = "Your account is deleted",
        ["deleteDoneBody"] = "Every device has been signed out.",
        ["other"] = "العربية",
        ["otherLang"] = "ar",
        ["back"] = "Back to Cash Gear Workspace",
        // Phase 11: passkeys.
        ["or"] = "or",
        ["passkeySignIn"] = "Sign in with a passkey",
        ["passkeyRefused"] = "The passkey was not accepted. Try again, or sign in with your password.",
        ["passkeyFailed"] = "The passkey could not be used. Try again.",
        ["passkeyCancelled"] = "No passkey was used.",
        ["passkeyUnsupported"] = "This browser cannot use passkeys.",
        ["passkeyExists"] = "This passkey is on your account already.",
        ["passkeyAddTitle"] = "Add a passkey",
        ["passkeyAddBody"] = "A passkey signs you in with your device's screen lock (your fingerprint, your face or a PIN) instead of your password. Your password keeps working.",
        ["passkeyName"] = "Name, to tell your passkeys apart",
        ["passkeyAddButton"] = "Add a passkey",
        ["passkeyAdded"] = "Your passkey is added",
        ["passkeyAddedBody"] = "You can sign in with it from now on. You can close this page.",
        ["passkeyLimit"] = "Your account has 20 passkeys, the most it can have. Remove one in Settings first.",
        ["passkeyTaken"] = "This passkey cannot be added.",
        ["passkeyBadName"] = "A name of 1 to 60 characters is needed.",
        ["passkeyDefault"] = "Passkey",
        ["passkeyNotAccepted"] = "The passkey was not accepted.",
        ["reauthTitle"] = "Confirm it is you",
        ["reauthBody"] = "Before you add a way to sign in, confirm it is you.",
        ["reauthPasskey"] = "Confirm with a passkey",
        ["reauthAgain"] = "Sign in again to go on.",
        ["deletePasskey"] = "Delete my account with a passkey",
        ["deleteSignInAgain"] = "To delete your account, sign in again first.",
    };

    private static readonly Dictionary<string, string> Ar = new()
    {
        ["product"] = "مساحة عمل كاش جير",
        ["signIn"] = "تسجيل الدخول",
        ["signInTitle"] = "تسجيل الدخول إلى مساحة عمل كاش جير",
        ["signUp"] = "إنشاء حساب",
        ["email"] = "البريد الإلكتروني",
        ["password"] = "كلمة المرور",
        ["newPassword"] = "كلمة مرور جديدة (عشرة أحرف على الأقل)",
        ["name"] = "اسمك",
        ["forgot"] = "نسيت كلمة المرور؟",
        ["haveAccount"] = "لديك حساب؟ سجّل الدخول",
        ["invalid"] = "البريد الإلكتروني أو كلمة المرور غير صحيحة. تؤدي المحاولات الخاطئة المتكررة إلى إيقاف تسجيل الدخول ١٥ دقيقة.",
        ["notConfirmed"] = "أكّد بريدك الإلكتروني أولًا. يمكننا إرسال الرابط مرة أخرى.",
        ["resend"] = "إرسال الرابط مرة أخرى",
        ["checkMail"] = "تحقّق من بريدك الإلكتروني",
        ["checkMailBody"] = "إن كان العنوان صالحًا فرسالة فيها رابط في الطريق إليك. يبقى رابط إنشاء الحساب صالحًا ٢٤ ساعة، ورابط كلمة المرور ساعة واحدة.",
        ["confirmTitle"] = "تأكيد بريدك الإلكتروني",
        ["confirmBody"] = "اضغط «تأكيد» لإكمال إنشاء حسابك.",
        ["confirmButton"] = "تأكيد",
        ["confirmed"] = "تم تأكيد بريدك الإلكتروني",
        ["confirmedBody"] = "يمكنك تسجيل الدخول الآن.",
        ["badLink"] = "هذا الرابط غير صالح أو انتهت صلاحيته.",
        ["forgotTitle"] = "إعادة تعيين كلمة المرور",
        ["forgotBody"] = "سنرسل إليك رابطًا لاختيار كلمة مرور جديدة.",
        ["sendLink"] = "إرسال الرابط",
        ["resetTitle"] = "اختر كلمة مرور جديدة",
        ["resetDone"] = "تم تغيير كلمة المرور، وسُجّل الخروج من كل الأجهزة.",
        ["save"] = "حفظ",
        ["consentTitle"] = "تسجيل الدخول إلى تطبيق سطح المكتب",
        ["consentAsk"] = "هل تريد تسجيل الدخول إلى تطبيق مساحة عمل كاش جير لسطح المكتب على هذا الكمبيوتر باسم {0}؟",
        ["consentOnly"] = "لا تتابع إلا إذا ضغطت للتو على «تسجيل الدخول» في التطبيق.",
        ["continue"] = "متابعة",
        ["cancel"] = "إلغاء",
        ["expired"] = "انتهت صلاحية الصفحة. اقرأها مرة أخرى واختر.",
        ["deleteTitle"] = "حذف حسابك",
        ["deleteAs"] = "مسجّل الدخول باسم {0}.",
        ["deleteBody"] = "تُحذف مساحات العمل التي لا يشاركك فيها أحد، وتغادر المساحات الأخرى. تبقى تعديلاتك في الصفحات المشتركة باسم «مستخدم محذوف». لا يمكن التراجع عن ذلك.",
        ["deleteButton"] = "حذف حسابي",
        ["deleteWrong"] = "كلمة المرور غير صحيحة. تؤدي المحاولات الخاطئة المتكررة إلى إيقاف ذلك ١٥ دقيقة.",
        ["deleteHeld"] = "أنت المالك الوحيد لمساحة عمل فيها أعضاء آخرون: اجعل أحدهم مالكًا أولًا.",
        ["deleteDone"] = "تم حذف حسابك",
        ["deleteDoneBody"] = "سُجّل الخروج من كل الأجهزة.",
        ["other"] = "English",
        ["otherLang"] = "en",
        ["back"] = "العودة إلى مساحة عمل كاش جير",
        // Phase 11: مفاتيح المرور.
        ["or"] = "أو",
        ["passkeySignIn"] = "تسجيل الدخول بمفتاح مرور",
        ["passkeyRefused"] = "لم يُقبل مفتاح المرور. حاول مرة أخرى، أو سجّل الدخول بكلمة المرور.",
        ["passkeyFailed"] = "تعذّر استخدام مفتاح المرور. حاول مرة أخرى.",
        ["passkeyCancelled"] = "لم يُستخدم أي مفتاح مرور.",
        ["passkeyUnsupported"] = "لا يدعم هذا المتصفح مفاتيح المرور.",
        ["passkeyExists"] = "مفتاح المرور هذا مضاف إلى حسابك بالفعل.",
        ["passkeyAddTitle"] = "إضافة مفتاح مرور",
        ["passkeyAddBody"] = "يتيح لك مفتاح المرور تسجيل الدخول بقفل شاشة جهازك (بصمة إصبعك أو وجهك أو رمز سري) بدلًا من كلمة المرور. تبقى كلمة المرور صالحة.",
        ["passkeyName"] = "الاسم، لتمييز مفاتيح المرور بعضها من بعض",
        ["passkeyAddButton"] = "إضافة مفتاح مرور",
        ["passkeyAdded"] = "تمت إضافة مفتاح المرور",
        ["passkeyAddedBody"] = "يمكنك تسجيل الدخول به من الآن. يمكنك إغلاق هذه الصفحة.",
        ["passkeyLimit"] = "في حسابك ٢٠ مفتاح مرور، وهو الحد الأقصى. احذف أحدها من الإعدادات أولًا.",
        ["passkeyTaken"] = "لا يمكن إضافة مفتاح المرور هذا.",
        ["passkeyBadName"] = "يلزم اسم من حرف واحد إلى ٦٠ حرفًا.",
        ["passkeyDefault"] = "مفتاح مرور",
        ["passkeyNotAccepted"] = "لم يُقبل مفتاح المرور.",
        ["reauthTitle"] = "تأكيد هويتك",
        ["reauthBody"] = "قبل إضافة طريقة لتسجيل الدخول، أكّد أنك أنت.",
        ["reauthPasskey"] = "التأكيد بمفتاح مرور",
        ["reauthAgain"] = "سجّل الدخول مرة أخرى للمتابعة.",
        ["deletePasskey"] = "حذف حسابي بمفتاح مرور",
        ["deleteSignInAgain"] = "لحذف حسابك، سجّل الدخول مرة أخرى أولًا.",
    };

    private const string Css = """
        :root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1b1d21;--muted:#5b616b;--line:#d5d9e0;--accent:#1f5fbf;--accent-text:#fff;--bad:#a4262c}
        @media (prefers-color-scheme:dark){:root{--bg:#16181c;--card:#1f2228;--text:#eceef2;--muted:#a9b0bb;--line:#3a3f48;--accent:#7fb0ff;--accent-text:#0b1a33;--bad:#ff9a9f}}
        *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,"Segoe UI",Tahoma,sans-serif}
        main{width:min(26rem,100% - 2rem);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:2rem}
        h1{font-size:1.4rem;margin:0 0 1rem}p{margin:.5rem 0}label{display:block;margin:1rem 0 .25rem;font-weight:600}
        input{width:100%;padding:.6rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
        input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
        button{margin-top:1.25rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;cursor:pointer}
        button.secondary{margin-top:.75rem;background:transparent;color:var(--accent);border:1px solid var(--line)}button.danger{background:var(--bad);color:var(--accent-text)}
        .error{color:var(--bad);font-weight:600}.links{margin-top:1.25rem;display:flex;flex-direction:column;gap:.4rem}a{color:var(--accent)}
        .product{color:var(--muted);margin:0 0 .25rem;font-size:.9rem}nav{margin-top:1.5rem;font-size:.9rem}
        [hidden]{display:none!important}button:disabled{opacity:.6;cursor:progress}
        .or{display:flex;align-items:center;gap:.75rem;margin:1.25rem 0 0;color:var(--muted)}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
        """;

    private static string E(string? s) => HtmlEncoder.Default.Encode(s ?? "");

    private static Dictionary<string, string> T(string lang) => lang == "ar" ? Ar : En;

    /// <summary>A sentence with a value in it, the value isolated so an address reads right in Arabic.</summary>
    private static string With(string template, string value)
    {
        var parts = template.Split("{0}");
        return $"{E(parts[0])}<strong><bdi>{E(value)}</bdi></strong>{E(parts.Length > 1 ? parts[1] : "")}";
    }

    /// <param name="query">The page's parameters for the other language's link, when they are not the request's query (a page answering a POST).</param>
    /// <param name="script">
    /// Phase 11: the page runs a passkey ceremony, so it loads the one script the API serves
    /// (<c>script-src 'self'</c>, its integrity checked, fetches to this origin only, no DOM sink
    /// taking a string). Every other page has no script at all.
    /// </param>
    /// <param name="path">The page the other language's link opens, when it is not the request's (a POST answered on another page's behalf).</param>
    internal static IResult Page(HttpContext http, string lang, string title, string body, IEnumerable<KeyValuePair<string, string>>? query = null, bool script = false, string? path = null)
    {
        var t = T(lang);
        var dir = lang == "ar" ? "rtl" : "ltr";
        var pairs = (query ?? http.Request.Query.SelectMany(q => q.Value.Select(v => KeyValuePair.Create(q.Key, v ?? ""))))
            .Where(q => q.Key != "lang")
            .Select(q => $"{Uri.EscapeDataString(q.Key)}={Uri.EscapeDataString(q.Value)}");
        var other = $"{path ?? http.Request.Path}?{string.Join("&", pairs.Append("lang=" + t["otherLang"]))}";
        var scriptTag = script ? $"""<script src="/account/passkey.js?v={PasskeyScript.Version}" integrity="{PasskeyScript.Integrity}" defer></script>""" : "";
        var html = $"""
            <!doctype html>
            <html lang="{lang}" dir="{dir}">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>{E(title)} · {E(t["product"])}</title><link rel="stylesheet" href="/account/style.css">{scriptTag}</head>
            <body><main><p class="product">{E(t["product"])}</p><h1>{E(title)}</h1>{body}
            <nav><a href="{E(other)}" lang="{t["otherLang"]}">{E(t["other"])}</a></nav></main></body></html>
            """;
        // A form's redirect chain counts for form-action: back to the web app, or on to the
        // desktop's loopback listener through /connect/authorize.
        var origins = string.Join(" ", ApiServices.Origins(http.RequestServices.GetRequiredService<IConfiguration>()));
        var scripts = script ? "script-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; " : "";
        http.Response.Headers.ContentSecurityPolicy =
            $"default-src 'none'; {scripts}style-src 'self'; img-src 'self'; form-action 'self' {origins} http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'";
        http.Response.Headers.CacheControl = "no-store";
        return Results.Content(html, "text/html; charset=utf-8", Encoding.UTF8);
    }

    /// <summary>
    /// Phase 11: a form a passkey ceremony fills (the page's script): its options come from
    /// <paramref name="options"/> (a POST with the antiforgery header), its answer goes in the hidden
    /// <c>Credential</c> field and the form is posted as any other, so the page's words, its errors
    /// and where it goes next are the same as the password's. The words the script may say are the
    /// form's attributes, in the page's language. <paramref name="inside"/> is the form's own
    /// fields and its button (<c>data-passkey-start</c>). <paramref name="autofill"/>: the browser
    /// is asked for passkeys in the email field's autofill as the page opens (conditional mediation).
    /// </summary>
    private static string PasskeyForm(IAntiforgery af, HttpContext http, string lang, string mode, string action, string options, string inside, bool autofill, params (string Name, string? Value)[] fields)
    {
        var t = T(lang);
        var conditional = autofill ? " data-conditional=\"true\"" : "";
        return $"""
            <form method="post" action="{action}" data-passkey="{mode}" data-options="{E(options)}"{conditional} data-status="passkey-status" data-header="{ApiServices.CsrfHeader}" data-msg-failed="{E(t["passkeyFailed"])}" data-msg-cancelled="{E(t["passkeyCancelled"])}" data-msg-exists="{E(t["passkeyExists"])}">{Hidden(af, http, [.. fields, ("Credential", "")])}
            {inside}</form>
            <p id="passkey-status" class="error" role="status"></p>
            """;
    }

    private static string Hidden(IAntiforgery antiforgery, HttpContext http, params (string Name, string? Value)[] fields)
    {
        var tokens = antiforgery.GetAndStoreTokens(http);
        var out_ = new StringBuilder($"""<input type="hidden" name="{E(tokens.FormFieldName)}" value="{E(tokens.RequestToken)}">""");
        foreach (var (name, value) in fields)
            out_.Append($"""<input type="hidden" name="{E(name)}" value="{E(value)}">""");
        return out_.ToString();
    }

    private static string Q(string? returnUrl, string lang) => $"?lang={lang}&returnUrl={Uri.EscapeDataString(returnUrl ?? "")}";

    /// <summary>The sign-in page, coming back to <paramref name="back"/> (a local page <see cref="AccountService.SafeReturn"/> keeps).</summary>
    internal static string SignInFor(string back, string lang) => $"/account/signin?lang={lang}&returnUrl={Uri.EscapeDataString(back)}";

    private static string DeleteUrl(string lang, string? returnUrl) =>
        $"/account/delete?lang={lang}" + (string.IsNullOrEmpty(returnUrl) ? "" : $"&returnUrl={Uri.EscapeDataString(returnUrl)}");

    private static IResult SignInPage(HttpContext http, IAntiforgery af, string lang, string? returnUrl, string? error, string? email, bool fromPasskey = false)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(t[error])}</p>""";
        var resend = error == "notConfirmed"
            ? $"""<form method="post" action="/account/resend">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang), ("Email", email))}<button type="submit">{E(t["resend"])}</button></form>"""
            : "";
        // Phase 11: "Sign in with a passkey", shown by the script where the browser has passkeys;
        // the email field's "webauthn" token lets the browser offer them in its autofill too, but
        // not on a page saying why a sign-in failed (the person chooses again).
        var passkey = PasskeyForm(af, http, lang, "signin", "/account/signin/passkey", "/account/passkey/request-options?for=signin",
            $"""<button type="button" class="secondary" data-passkey-start>{E(t["passkeySignIn"])}</button>""",
            autofill: error is null, ("ReturnUrl", returnUrl), ("Lang", lang));
        return Page(http, lang, t["signInTitle"], $"""
            {message}{resend}
            <form method="post" action="/account/signin">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang))}
            <label for="email">{E(t["email"])}</label><input id="email" name="Email" type="email" autocomplete="username webauthn" required value="{E(email)}" dir="ltr">
            <label for="password">{E(t["password"])}</label><input id="password" name="Password" type="password" autocomplete="current-password" required dir="ltr">
            <button type="submit">{E(t["signIn"])}</button></form>
            <div data-passkey-show hidden><p class="or">{E(t["or"])}</p>{passkey}</div>
            <div class="links"><a href="/account/signup{Q(returnUrl, lang)}">{E(t["signUp"])}</a><a href="/account/forgot{Q(returnUrl, lang)}">{E(t["forgot"])}</a></div>
            """, fromPasskey ? new[] { KeyValuePair.Create("returnUrl", returnUrl ?? "") } : null, script: true, path: fromPasskey ? "/account/signin" : null);
    }

    /// <summary>The page adding a passkey (<c>return</c> kept), for the sign-in to come back to.</summary>
    internal static string AddPasskeyUrl(string lang, string? back) =>
        $"/account/passkeys/new?lang={lang}" + (string.IsNullOrEmpty(back) ? "" : $"&return={Uri.EscapeDataString(back)}");

    /// <summary>
    /// Phase 11: the person proves who they are again (the password, or a passkey of this account)
    /// before a passkey is added. An account with neither (single sign-on only, from Phase 11's
    /// M11.3) signs in again.
    /// </summary>
    private static IResult Reauthenticate(HttpContext http, IAntiforgery af, string lang, User user, bool hasPassword, bool hasPasskeys, string? back, string? error)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(t[error])}</p>""";
        var password = hasPassword
            ? $"""
              <form method="post" action="/account/passkeys/confirm">{Hidden(af, http, ("ReturnUrl", back), ("Lang", lang))}
              <label for="password">{E(t["password"])}</label><input id="password" name="Password" type="password" autocomplete="current-password" required dir="ltr">
              <button type="submit">{E(t["continue"])}</button></form>
              """
            : "";
        var passkey = hasPasskeys ? PasskeyChoice(af, http, lang, hasPassword, "confirm", "/account/passkeys/confirm", t["reauthPasskey"], "", ("ReturnUrl", back), ("Lang", lang)) : "";
        var again = !hasPassword && !hasPasskeys
            ? $"""<p>{E(t["reauthAgain"])}</p><div class="links"><a href="{E(SignInFor(AddPasskeyUrl(lang, back), lang))}">{E(t["signIn"])}</a></div>"""
            : "";
        return Page(http, lang, t["reauthTitle"], $"""
            {message}<p>{E(t["reauthBody"])}</p><p>{With(t["deleteAs"], user.Email!)}</p>
            {password}{passkey}{again}
            """, ReturnQuery(back), script: hasPasskeys, path: "/account/passkeys/new");
    }

    /// <summary>
    /// A passkey asked again for this account: after the password's form ("or" between them) or alone
    /// (then, where the browser has no passkeys, saying so). <paramref name="buttonClass"/> is the
    /// button's own class when it stands alone (<c>danger</c> for a deletion).
    /// </summary>
    private static string PasskeyChoice(IAntiforgery af, HttpContext http, string lang, bool afterPassword, string mode, string action, string label, string buttonClass, params (string Name, string? Value)[] fields)
    {
        var t = T(lang);
        var css = afterPassword ? "secondary" : buttonClass;
        var button = $"""<button type="button"{(css.Length > 0 ? $" class=\"{css}\"" : "")} data-passkey-start>{E(label)}</button>""";
        var form = PasskeyForm(af, http, lang, mode, action, "/account/passkey/request-options?for=confirm", button, autofill: false, fields);
        var or = afterPassword ? $"""<p class="or">{E(t["or"])}</p>""" : "";
        var unsupported = afterPassword ? "" : $"""<p data-passkey-hide>{E(t["passkeyUnsupported"])}</p>""";
        return $"""<div data-passkey-show hidden>{or}{form}</div>{unsupported}""";
    }

    /// <summary>Phase 11: the creation ceremony's page, its name field filled with where the passkey is made.</summary>
    private static IResult AddPasskey(HttpContext http, IAntiforgery af, AccountService service, string lang, string? back, string? error, string? name = null)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(t[error])}</p>""";
        var inside = $"""
            <label for="name">{E(t["passkeyName"])}</label><input id="name" name="Name" maxlength="{Passkeys.NameMax}" autocomplete="off" value="{E(name ?? DefaultPasskeyName(http, lang))}">
            <button type="button" data-passkey-start data-passkey-show hidden>{E(t["passkeyAddButton"])}</button>
            """;
        var form = PasskeyForm(af, http, lang, "create", "/account/passkeys/new", "/account/passkey/creation-options", inside, autofill: false, ("ReturnUrl", back), ("Lang", lang));
        var backLink = string.IsNullOrEmpty(back) ? "" : $"""<div class="links"><a href="{E(service.SafeReturn(back))}">{E(t["back"])}</a></div>""";
        return Page(http, lang, t["passkeyAddTitle"], $"""
            {message}<p>{E(t["passkeyAddBody"])}</p>
            {form}<p data-passkey-hide>{E(t["passkeyUnsupported"])}</p>{backLink}
            """, ReturnQuery(back), script: true, path: "/account/passkeys/new");
    }

    /// <summary>Where the passkey is made, as the devices list names a browser ("Chrome on Windows"); else "Passkey".</summary>
    private static string DefaultPasskeyName(HttpContext http, string lang)
    {
        var name = Devices.NameFromUserAgent(http.Request.Headers.UserAgent);
        return name == "Browser" ? T(lang)["passkeyDefault"] : name;
    }

    private static List<KeyValuePair<string, string>> ReturnQuery(string? back) =>
        string.IsNullOrEmpty(back) ? [] : [KeyValuePair.Create("return", back)];

    private static IResult Message(HttpContext http, string lang, string title, string body, string? link = null, string? linkText = null) =>
        Page(http, lang, title, $"""<p>{E(body)}</p>{(link is null ? "" : $"""<div class="links"><a href="{E(link)}">{E(linkText)}</a></div>""")}""");

    /// <summary>
    /// The desktop's sign-in, confirmed (RFC 8252, 8.6): the request's parameters go back to
    /// /connect/authorize as the form's fields (OpenIddict reads a POSTed request from its form),
    /// with the antiforgery token and the button pressed.
    /// </summary>
    internal static IResult Consent(HttpContext http, IAntiforgery af, string lang, string email, IReadOnlyList<KeyValuePair<string, string>> parameters, bool expired)
    {
        var t = T(lang);
        var fields = new StringBuilder(Hidden(af, http));
        foreach (var (name, value) in parameters)
            fields.Append($"""<input type="hidden" name="{E(name)}" value="{E(value)}">""");
        var message = expired ? $"""<p class="error" role="alert">{E(t["expired"])}</p>""" : "";
        return Page(http, lang, t["consentTitle"], $"""
            {message}<p>{With(t["consentAsk"], email)}</p>
            <p>{E(t["consentOnly"])}</p>
            <form method="post" action="/connect/authorize">{fields}
            <button type="submit" name="{ConsentField}" value="accept">{E(t["continue"])}</button>
            <button type="submit" name="{ConsentField}" value="deny" class="secondary">{E(t["cancel"])}</button></form>
            """, parameters);
    }

    public static void MapAccountPages(this WebApplication app)
    {
        var pages = app.MapGroup("/account").ExcludeFromDescription();
        string L(HttpContext http, string? lang) => AccountService.Language(lang, http);

        pages.MapGet("/style.css", (HttpContext http) =>
        {
            http.Response.Headers.CacheControl = "public, max-age=3600";
            return Results.Text(Css, "text/css; charset=utf-8");
        }).AllowAnonymous();

        pages.MapGet("/signin", (HttpContext http, IAntiforgery af, string? returnUrl, string? lang) =>
            SignInPage(http, af, L(http, lang), returnUrl, null, null)).AllowAnonymous();

        pages.MapPost("/signin", async (HttpContext http, IAntiforgery af, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var outcome = await service.PasswordSignInAsync(form.Email ?? "", form.Password ?? "", http);
            return outcome switch
            {
                SignInOutcome.Ok => Results.Redirect(service.SafeReturn(form.ReturnUrl)),
                SignInOutcome.NotConfirmed => SignInPage(http, af, lang, form.ReturnUrl, "notConfirmed", form.Email),
                // A locked account reads as a wrong password: the lockout is no sign the account exists.
                _ => SignInPage(http, af, lang, form.ReturnUrl, "invalid", form.Email),
            };
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapPost("/resend", async (HttpContext http, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            await service.ResendConfirmationAsync(form.Email ?? "", lang, form.ReturnUrl, http);
            var t = T(lang);
            return Message(http, lang, t["checkMail"], t["checkMailBody"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapGet("/signup", (HttpContext http, IAntiforgery af, string? returnUrl, string? lang) => SignUp(http, af, L(http, lang), returnUrl, null)).AllowAnonymous();

        pages.MapPost("/signup", async (HttpContext http, IAntiforgery af, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var result = await service.RegisterAsync(form.Email ?? "", form.DisplayName ?? "", form.Password ?? "", lang, form.ReturnUrl, http);
            if (!result.Ok) return SignUp(http, af, lang, form.ReturnUrl, result.Failure!.Title, form.Email, form.DisplayName);
            var t = T(lang);
            return Message(http, lang, t["checkMail"], t["checkMailBody"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        // The mail's link opens this page; its button confirms.
        pages.MapGet("/confirm", (HttpContext http, IAntiforgery af, Guid userId, string? code, string? returnUrl, string? lang) =>
        {
            var l = L(http, lang);
            var t = T(l);
            return Page(http, l, t["confirmTitle"], $"""
                <p>{E(t["confirmBody"])}</p>
                <form method="post" action="/account/confirm">{Hidden(af, http, ("UserId", userId.ToString()), ("Code", code), ("ReturnUrl", returnUrl), ("Lang", l))}
                <button type="submit">{E(t["confirmButton"])}</button></form>
                """);
        }).AllowAnonymous();

        pages.MapPost("/confirm", async (HttpContext http, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var l = L(http, form.Lang);
            var t = T(l);
            var result = await service.ConfirmAsync(form.UserId, form.Code ?? "", http);
            return result.Ok
                ? Message(http, l, t["confirmed"], t["confirmedBody"], $"/account/signin{Q(form.ReturnUrl, l)}", t["signIn"])
                : Message(http, l, t["badLink"], t["badLink"], $"/account/signin{Q(form.ReturnUrl, l)}", t["signIn"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapGet("/forgot", (HttpContext http, IAntiforgery af, string? returnUrl, string? lang) =>
        {
            var l = L(http, lang);
            var t = T(l);
            return Page(http, l, t["forgotTitle"], $"""
                <p>{E(t["forgotBody"])}</p>
                <form method="post" action="/account/forgot">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", l))}
                <label for="email">{E(t["email"])}</label><input id="email" name="Email" type="email" autocomplete="username" required dir="ltr">
                <button type="submit">{E(t["sendLink"])}</button></form>
                <div class="links"><a href="/account/signin{Q(returnUrl, l)}">{E(t["signIn"])}</a></div>
                """);
        }).AllowAnonymous();

        pages.MapPost("/forgot", async (HttpContext http, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            await service.ForgotAsync(form.Email ?? "", lang, form.ReturnUrl, http);
            var t = T(lang);
            return Message(http, lang, t["checkMail"], t["checkMailBody"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapGet("/reset", (HttpContext http, IAntiforgery af, Guid userId, string? code, string? returnUrl, string? lang) =>
            Reset(http, af, L(http, lang), userId, code, returnUrl, null)).AllowAnonymous();

        pages.MapPost("/reset", async (HttpContext http, IAntiforgery af, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var t = T(lang);
            var result = await service.ResetAsync(form.UserId, form.Code ?? "", form.Password ?? "", http);
            return result.Ok
                ? Message(http, lang, t["resetTitle"], t["resetDone"], $"/account/signin{Q(form.ReturnUrl, lang)}", t["signIn"])
                : Reset(http, af, lang, form.UserId, form.Code, form.ReturnUrl, result.Failure!.Title);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        // Deleting the account (DATA_MODEL.md, Data export and deletion) asks for the password
        // again, on this page only: the app opens it (the desktop in the system browser). Phase 11:
        // or a passkey of the account; an account with neither (single sign-on only) is deleted by a
        // session that signed in less than ten minutes ago, and is sent to sign in again otherwise.
        pages.MapGet("/delete", async (HttpContext http, IAntiforgery af, AccountService service, UserManager<User> users, Passkeys passkeys, string? returnUrl, string? lang) =>
        {
            var l = L(http, lang);
            var user = await service.CurrentAsync(http.User);
            if (user is null) return Results.Redirect(SignInFor(DeleteUrl(l, returnUrl), l));
            return Delete(http, af, service, l, user.Email!, await ProofAsync(users, passkeys, service, http, user), returnUrl, null);
        }).AllowAnonymous();

        pages.MapPost("/delete", async (HttpContext http, IAntiforgery af, AccountService service, UserManager<User> users, Passkeys passkeys, AccountDeletion deletion, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var t = T(lang);
            var user = await service.CurrentAsync(http.User);
            if (user is null) return Results.Redirect(SignInFor(DeleteUrl(lang, form.ReturnUrl), lang));
            var proof = await ProofAsync(users, passkeys, service, http, user);
            var byPasskey = !string.IsNullOrEmpty(form.Credential);
            var confirmed = byPasskey ? proof.Passkeys && await passkeys.ConfirmAsync(user, form.Credential, http)
                : proof.Password ? await service.ConfirmPasswordAsync(user, form.Password ?? "", http)
                : !proof.Passkeys && proof.Recent;
            if (!confirmed)
                return Delete(http, af, service, lang, user.Email!, proof, form.ReturnUrl,
                    t[byPasskey ? "passkeyNotAccepted" : proof.Password ? "deleteWrong" : "deleteSignInAgain"]);
            var result = await deletion.DeleteAsync(user.Id, http.Actor());
            if (!result.Ok)
                return Delete(http, af, service, lang, user.Email!, proof, form.ReturnUrl,
                    result.Failure!.Code == Codes.Conflict && lang == "ar" ? t["deleteHeld"] : result.Failure.Title);
            await service.SignOutAsync(http);
            var back = string.IsNullOrEmpty(form.ReturnUrl) ? null : service.SafeReturn(form.ReturnUrl);
            return Message(http, lang, t["deleteDone"], t["deleteDoneBody"], back, t["back"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        MapPasskeyPages(pages, L);
    }

    /// <summary>What can prove the signed-in person again: their password, a passkey, or (with neither) a recent sign-in.</summary>
    private sealed record Proof(bool Password, bool Passkeys, bool Recent);

    private static async Task<Proof> ProofAsync(UserManager<User> users, Passkeys passkeys, AccountService service, HttpContext http, User user) =>
        new(await users.HasPasswordAsync(user), await passkeys.CountAsync(user.Id) > 0, service.AuthenticatedRecently(http.User));

    /// <summary>
    /// Phase 11 (M11.2): the passkey ceremonies, on these pages only. Options and answers are
    /// POSTs carrying the antiforgery token (the options' as the header, the answers' in their form).
    /// Every answer is under the sign-in rate limit, as a password is; the options, which check
    /// nothing and which the sign-in page asks for as it opens (the browser's autofill), are under
    /// the anonymous one (and a session's under its own), so a sign-in costs the sign-in bucket one.
    /// </summary>
    private static void MapPasskeyPages(RouteGroupBuilder pages, Func<HttpContext, string?, string> L)
    {
        pages.MapGet("/passkey.js", (HttpContext http) =>
        {
            http.Response.Headers.CacheControl = "public, max-age=3600";
            return Results.Bytes(PasskeyScript.Bytes, "text/javascript; charset=utf-8");
        }).AllowAnonymous();

        // Options for navigator.credentials.get: signing in (any of the server's passkeys, the
        // browser offering the ones it has), or the signed-in account's own, asked again.
        pages.MapPost("/passkey/request-options", async Task<IResult> (HttpContext http, IAntiforgery af, AccountService service, Passkeys passkeys, [Microsoft.AspNetCore.Mvc.FromQuery(Name = "for")] string? purpose) =>
        {
            if (!await af.IsRequestValidAsync(http)) return Problems.Of(Codes.RequestInvalid, 400, "The antiforgery token is missing or wrong");
            User? user = null;
            if (purpose == "confirm")
            {
                user = await service.CurrentAsync(http.User);
                if (user is null) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
            }
            return Options(http, await passkeys.RequestOptionsAsync(user));
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.Anonymous);

        // Options for navigator.credentials.create: a session that proved who it is in the last ten
        // minutes, with fewer than 20 passkeys.
        pages.MapPost("/passkey/creation-options", async Task<IResult> (HttpContext http, IAntiforgery af, AccountService service, Passkeys passkeys) =>
        {
            if (!await af.IsRequestValidAsync(http)) return Problems.Of(Codes.RequestInvalid, 400, "The antiforgery token is missing or wrong");
            var user = await service.CurrentAsync(http.User);
            if (user is null) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
            if (!service.AuthenticatedRecently(http.User)) return Problems.Of(Codes.AccessDenied, 403, "Confirm it is you first");
            if (await passkeys.CountAsync(user.Id) >= Passkeys.Max) return Problems.Of(Codes.Conflict, 409, $"An account has at most {Passkeys.Max} passkeys");
            return Options(http, await passkeys.CreationOptionsAsync(user));
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.User);

        // Signing in with a passkey: the answer verified, then the password's own way on (a device,
        // the session's cookie, back to where the sign-in was asked from: the app, or the desktop's
        // /connect/authorize).
        pages.MapPost("/signin/passkey", async (HttpContext http, IAntiforgery af, AccountService service, Passkeys passkeys, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var outcome = await passkeys.SignInAsync(form.Credential, http);
            return outcome == SignInOutcome.Ok
                ? Results.Redirect(service.SafeReturn(form.ReturnUrl))
                : SignInPage(http, af, lang, form.ReturnUrl, "passkeyRefused", null, fromPasskey: true);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        // Adding a passkey, opened from Settings (?return= an address of the app to go back to).
        pages.MapGet("/passkeys/new", async (HttpContext http, IAntiforgery af, AccountService service, UserManager<User> users, Passkeys passkeys, [Microsoft.AspNetCore.Mvc.FromQuery(Name = "return")] string? back, string? lang) =>
        {
            var l = L(http, lang);
            var t = T(l);
            var user = await service.CurrentAsync(http.User);
            if (user is null) return Results.Redirect(SignInFor(AddPasskeyUrl(l, back), l));
            if (await passkeys.CountAsync(user.Id) >= Passkeys.Max) return Message(http, l, t["passkeyAddTitle"], t["passkeyLimit"], BackTo(service, back), t["back"]);
            if (!service.AuthenticatedRecently(http.User))
                return Reauthenticate(http, af, l, user, await users.HasPasswordAsync(user), await passkeys.CountAsync(user.Id) > 0, back, null);
            return AddPasskey(http, af, service, l, back, null);
        }).AllowAnonymous();

        pages.MapPost("/passkeys/new", async (HttpContext http, IAntiforgery af, AccountService service, UserManager<User> users, Passkeys passkeys, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var t = T(lang);
            var user = await service.CurrentAsync(http.User);
            if (user is null) return Results.Redirect(SignInFor(AddPasskeyUrl(lang, form.ReturnUrl), lang));
            // The options were made in the ten minutes; the answer may take the ceremony's five more.
            if (!service.AuthenticatedRecently(http.User, AccountService.Recent + PasskeySetup.Ceremony))
                return Reauthenticate(http, af, lang, user, await users.HasPasswordAsync(user), await passkeys.CountAsync(user.Id) > 0, form.ReturnUrl, null);
            var added = await passkeys.AddAsync(user, form.Credential, form.Name, DefaultPasskeyName(http, lang), http);
            return added switch
            {
                PasskeyAdded.Added => string.IsNullOrEmpty(form.ReturnUrl)
                    ? Message(http, lang, t["passkeyAdded"], t["passkeyAddedBody"])
                    : Results.Redirect(service.SafeReturn(form.ReturnUrl)),
                PasskeyAdded.Limit => Message(http, lang, t["passkeyAddTitle"], t["passkeyLimit"], BackTo(service, form.ReturnUrl), t["back"]),
                PasskeyAdded.Taken => AddPasskey(http, af, service, lang, form.ReturnUrl, "passkeyTaken", form.Name),
                PasskeyAdded.BadName => AddPasskey(http, af, service, lang, form.ReturnUrl, "passkeyBadName", form.Name),
                _ => AddPasskey(http, af, service, lang, form.ReturnUrl, "passkeyNotAccepted", form.Name),
            };
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        // The password or a passkey asked again before adding one: the same session counts as recent.
        pages.MapPost("/passkeys/confirm", async (HttpContext http, IAntiforgery af, AccountService service, UserManager<User> users, Passkeys passkeys, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var user = await service.CurrentAsync(http.User);
            var next = AddPasskeyUrl(lang, form.ReturnUrl);
            if (user is null) return Results.Redirect(SignInFor(next, lang));
            var hasPassword = await users.HasPasswordAsync(user);
            var hasPasskeys = await passkeys.CountAsync(user.Id) > 0;
            if (!string.IsNullOrEmpty(form.Credential))
            {
                if (hasPasskeys && await passkeys.ConfirmAsync(user, form.Credential, http))
                {
                    await service.ReauthenticatedAsync(user, AccountService.Methods.Passkey, http);
                    return Results.Redirect(next);
                }
                return Reauthenticate(http, af, lang, user, hasPassword, hasPasskeys, form.ReturnUrl, "passkeyNotAccepted");
            }
            if (hasPassword && await service.ConfirmPasswordAsync(user, form.Password ?? "", http))
            {
                await service.ReauthenticatedAsync(user, AccountService.Methods.Password, http);
                return Results.Redirect(next);
            }
            return Reauthenticate(http, af, lang, user, hasPassword, hasPasskeys, form.ReturnUrl, "deleteWrong");
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);
    }

    /// <summary>A ceremony's options as Identity made them (WebAuthn's JSON forms), never stored by anyone.</summary>
    private static IResult Options(HttpContext http, string json)
    {
        http.Response.Headers.CacheControl = "no-store";
        return Results.Content(json, "application/json; charset=utf-8", Encoding.UTF8);
    }

    private static string? BackTo(AccountService service, string? back) => string.IsNullOrEmpty(back) ? null : service.SafeReturn(back);

    private static IResult SignUp(HttpContext http, IAntiforgery af, string lang, string? returnUrl, string? error, string? email = null, string? name = null)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(error)}</p>""";
        return Page(http, lang, t["signUp"], $"""
            {message}
            <form method="post" action="/account/signup">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang))}
            <label for="name">{E(t["name"])}</label><input id="name" name="DisplayName" autocomplete="name" required maxlength="200" value="{E(name)}">
            <label for="email">{E(t["email"])}</label><input id="email" name="Email" type="email" autocomplete="username" required value="{E(email)}" dir="ltr">
            <label for="password">{E(t["newPassword"])}</label><input id="password" name="Password" type="password" autocomplete="new-password" required minlength="10" dir="ltr">
            <button type="submit">{E(t["signUp"])}</button></form>
            <div class="links"><a href="/account/signin{Q(returnUrl, lang)}">{E(t["haveAccount"])}</a></div>
            """);
    }

    private static IResult Reset(HttpContext http, IAntiforgery af, string lang, Guid userId, string? code, string? returnUrl, string? error)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(error)}</p>""";
        return Page(http, lang, t["resetTitle"], $"""
            {message}
            <form method="post" action="/account/reset">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang), ("UserId", userId.ToString()), ("Code", code))}
            <label for="password">{E(t["newPassword"])}</label><input id="password" name="Password" type="password" autocomplete="new-password" required minlength="10" dir="ltr">
            <button type="submit">{E(t["save"])}</button></form>
            """);
    }

    private static IResult Delete(HttpContext http, IAntiforgery af, AccountService service, string lang, string email, Proof proof, string? returnUrl, string? error)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(error)}</p>""";
        var back = string.IsNullOrEmpty(returnUrl) ? "" : $"""<div class="links"><a href="{E(service.SafeReturn(returnUrl))}">{E(t["back"])}</a></div>""";
        var query = new List<KeyValuePair<string, string>>();
        if (!string.IsNullOrEmpty(returnUrl)) query.Add(KeyValuePair.Create("returnUrl", returnUrl));
        var password = proof.Password
            ? $"""
              <form method="post" action="/account/delete">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang))}
              <label for="password">{E(t["password"])}</label><input id="password" name="Password" type="password" autocomplete="current-password" required dir="ltr">
              <button type="submit" class="danger">{E(t["deleteButton"])}</button></form>
              """
            : "";
        // Phase 11: a passkey of the account answers too.
        var passkey = proof.Passkeys
            ? PasskeyChoice(af, http, lang, proof.Password, "confirm", "/account/delete", t["deletePasskey"], "danger", ("ReturnUrl", returnUrl), ("Lang", lang))
            : "";
        // An account with neither (single sign-on only): a session that signed in just now.
        var recent = proof.Password || proof.Passkeys ? ""
            : proof.Recent
                ? $"""
                  <form method="post" action="/account/delete">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang))}
                  <button type="submit" class="danger">{E(t["deleteButton"])}</button></form>
                  """
                : $"""<p>{E(t["deleteSignInAgain"])}</p><div class="links"><a href="{E(SignInFor(DeleteUrl(lang, returnUrl), lang))}">{E(t["signIn"])}</a></div>""";
        return Page(http, lang, t["deleteTitle"], $"""
            {message}<p>{With(t["deleteAs"], email)}</p>
            <p>{E(t["deleteBody"])}</p>
            {password}{passkey}{recent}
            {back}
            """, query, script: proof.Passkeys, path: "/account/delete");
    }
}
