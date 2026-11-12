using System.Text;
using System.Text.Encodings.Web;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Microsoft.AspNetCore.Antiforgery;

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
    private static IResult Page(HttpContext http, string lang, string title, string body, IEnumerable<KeyValuePair<string, string>>? query = null)
    {
        var t = T(lang);
        var dir = lang == "ar" ? "rtl" : "ltr";
        var pairs = (query ?? http.Request.Query.SelectMany(q => q.Value.Select(v => KeyValuePair.Create(q.Key, v ?? ""))))
            .Where(q => q.Key != "lang")
            .Select(q => $"{Uri.EscapeDataString(q.Key)}={Uri.EscapeDataString(q.Value)}");
        var other = $"{http.Request.Path}?{string.Join("&", pairs.Append("lang=" + t["otherLang"]))}";
        var html = $"""
            <!doctype html>
            <html lang="{lang}" dir="{dir}">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>{E(title)} · {E(t["product"])}</title><link rel="stylesheet" href="/account/style.css"></head>
            <body><main><p class="product">{E(t["product"])}</p><h1>{E(title)}</h1>{body}
            <nav><a href="{E(other)}" lang="{t["otherLang"]}">{E(t["other"])}</a></nav></main></body></html>
            """;
        // A form's redirect chain counts for form-action: back to the web app, or on to the
        // desktop's loopback listener through /connect/authorize.
        var origins = string.Join(" ", ApiServices.Origins(http.RequestServices.GetRequiredService<IConfiguration>()));
        http.Response.Headers.ContentSecurityPolicy =
            $"default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' {origins} http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'";
        http.Response.Headers.CacheControl = "no-store";
        return Results.Content(html, "text/html; charset=utf-8", Encoding.UTF8);
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

    private static IResult SignInPage(HttpContext http, IAntiforgery af, string lang, string? returnUrl, string? error, string? email)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(t[error])}</p>""";
        var resend = error == "notConfirmed"
            ? $"""<form method="post" action="/account/resend">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang), ("Email", email))}<button type="submit">{E(t["resend"])}</button></form>"""
            : "";
        return Page(http, lang, t["signInTitle"], $"""
            {message}{resend}
            <form method="post" action="/account/signin">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang))}
            <label for="email">{E(t["email"])}</label><input id="email" name="Email" type="email" autocomplete="username" required value="{E(email)}" dir="ltr">
            <label for="password">{E(t["password"])}</label><input id="password" name="Password" type="password" autocomplete="current-password" required dir="ltr">
            <button type="submit">{E(t["signIn"])}</button></form>
            <div class="links"><a href="/account/signup{Q(returnUrl, lang)}">{E(t["signUp"])}</a><a href="/account/forgot{Q(returnUrl, lang)}">{E(t["forgot"])}</a></div>
            """);
    }

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
        // again, on this page only: the app opens it (the desktop in the system browser).
        pages.MapGet("/delete", async (HttpContext http, IAntiforgery af, AccountService service, string? returnUrl, string? lang) =>
        {
            var l = L(http, lang);
            var user = await service.CurrentAsync(http.User);
            if (user is null) return Results.Redirect(SignInFor(DeleteUrl(l, returnUrl), l));
            return Delete(http, af, service, l, user.Email!, returnUrl, null);
        }).AllowAnonymous();

        pages.MapPost("/delete", async (HttpContext http, IAntiforgery af, AccountService service, AccountDeletion deletion, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var t = T(lang);
            var user = await service.CurrentAsync(http.User);
            if (user is null) return Results.Redirect(SignInFor(DeleteUrl(lang, form.ReturnUrl), lang));
            if (!await service.ConfirmPasswordAsync(user, form.Password ?? "", http))
                return Delete(http, af, service, lang, user.Email!, form.ReturnUrl, t["deleteWrong"]);
            var result = await deletion.DeleteAsync(user.Id, http.Actor());
            if (!result.Ok)
                return Delete(http, af, service, lang, user.Email!, form.ReturnUrl,
                    result.Failure!.Code == Codes.Conflict && lang == "ar" ? t["deleteHeld"] : result.Failure.Title);
            await service.SignOutAsync(http);
            var back = string.IsNullOrEmpty(form.ReturnUrl) ? null : service.SafeReturn(form.ReturnUrl);
            return Message(http, lang, t["deleteDone"], t["deleteDoneBody"], back, t["back"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);
    }

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

    private static IResult Delete(HttpContext http, IAntiforgery af, AccountService service, string lang, string email, string? returnUrl, string? error)
    {
        var t = T(lang);
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(error)}</p>""";
        var back = string.IsNullOrEmpty(returnUrl) ? "" : $"""<div class="links"><a href="{E(service.SafeReturn(returnUrl))}">{E(t["back"])}</a></div>""";
        var query = new List<KeyValuePair<string, string>>();
        if (!string.IsNullOrEmpty(returnUrl)) query.Add(KeyValuePair.Create("returnUrl", returnUrl));
        return Page(http, lang, t["deleteTitle"], $"""
            {message}<p>{With(t["deleteAs"], email)}</p>
            <p>{E(t["deleteBody"])}</p>
            <form method="post" action="/account/delete">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang))}
            <label for="password">{E(t["password"])}</label><input id="password" name="Password" type="password" autocomplete="current-password" required dir="ltr">
            <button type="submit" class="danger">{E(t["deleteButton"])}</button></form>
            {back}
            """, query);
    }
}
