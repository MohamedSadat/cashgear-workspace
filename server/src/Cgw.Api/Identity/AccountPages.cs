using System.Text;
using System.Text.Encodings.Web;
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
/// Forms carry an antiforgery token; every value written into a page is HTML-encoded.
/// </summary>
public static class AccountPages
{
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
        ["invalid"] = "The email or password is not right.",
        ["lockedOut"] = "Too many tries. Wait 15 minutes, or reset your password.",
        ["notConfirmed"] = "Confirm your email first. We can send the link again.",
        ["resend"] = "Send the link again",
        ["checkMail"] = "Check your email",
        ["checkMailBody"] = "If the address can be used, a mail with a link is on its way. The link lasts 24 hours.",
        ["confirmed"] = "Your email is confirmed",
        ["confirmedBody"] = "You can sign in now.",
        ["badLink"] = "This link is not valid or has expired.",
        ["forgotTitle"] = "Reset your password",
        ["forgotBody"] = "We will mail you a link to choose a new password.",
        ["sendLink"] = "Send the link",
        ["resetTitle"] = "Choose a new password",
        ["resetDone"] = "Your password is changed. Every device has been signed out.",
        ["save"] = "Save",
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
        ["invalid"] = "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
        ["lockedOut"] = "محاولات كثيرة. انتظر ١٥ دقيقة أو أعد تعيين كلمة المرور.",
        ["notConfirmed"] = "أكّد بريدك الإلكتروني أولًا. يمكننا إرسال الرابط مرة أخرى.",
        ["resend"] = "إرسال الرابط مرة أخرى",
        ["checkMail"] = "تحقّق من بريدك الإلكتروني",
        ["checkMailBody"] = "إن كان العنوان صالحًا فرسالة فيها رابط في الطريق إليك. يبقى الرابط صالحًا ٢٤ ساعة.",
        ["confirmed"] = "تم تأكيد بريدك الإلكتروني",
        ["confirmedBody"] = "يمكنك تسجيل الدخول الآن.",
        ["badLink"] = "هذا الرابط غير صالح أو انتهت صلاحيته.",
        ["forgotTitle"] = "إعادة تعيين كلمة المرور",
        ["forgotBody"] = "سنرسل إليك رابطًا لاختيار كلمة مرور جديدة.",
        ["sendLink"] = "إرسال الرابط",
        ["resetTitle"] = "اختر كلمة مرور جديدة",
        ["resetDone"] = "تم تغيير كلمة المرور، وسُجّل الخروج من كل الأجهزة.",
        ["save"] = "حفظ",
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
        .error{color:var(--bad);font-weight:600}.links{margin-top:1.25rem;display:flex;flex-direction:column;gap:.4rem}a{color:var(--accent)}
        .product{color:var(--muted);margin:0 0 .25rem;font-size:.9rem}nav{margin-top:1.5rem;font-size:.9rem}
        """;

    private static string E(string? s) => HtmlEncoder.Default.Encode(s ?? "");

    private static IResult Page(HttpContext http, string lang, string title, string body)
    {
        var t = lang == "ar" ? Ar : En;
        var dir = lang == "ar" ? "rtl" : "ltr";
        var query = http.Request.Query.Where(q => q.Key != "lang").Select(q => $"{Uri.EscapeDataString(q.Key)}={Uri.EscapeDataString(q.Value.ToString())}");
        var other = $"{http.Request.Path}?{string.Join("&", query.Append("lang=" + t["otherLang"]))}";
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
        var out_ = new StringBuilder($"""<input type="hidden" name="{tokens.FormFieldName}" value="{E(tokens.RequestToken)}">""");
        foreach (var (name, value) in fields)
            out_.Append($"""<input type="hidden" name="{name}" value="{E(value)}">""");
        return out_.ToString();
    }

    private static string Q(string? returnUrl, string lang) => $"?lang={lang}&returnUrl={Uri.EscapeDataString(returnUrl ?? "")}";

    private static IResult SignInPage(HttpContext http, IAntiforgery af, string lang, string? returnUrl, string? error, string? email)
    {
        var t = lang == "ar" ? Ar : En;
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
                SignInOutcome.LockedOut => SignInPage(http, af, lang, form.ReturnUrl, "lockedOut", form.Email),
                SignInOutcome.NotConfirmed => SignInPage(http, af, lang, form.ReturnUrl, "notConfirmed", form.Email),
                _ => SignInPage(http, af, lang, form.ReturnUrl, "invalid", form.Email),
            };
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapPost("/resend", async (HttpContext http, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            await service.ResendConfirmationAsync(form.Email ?? "", lang, form.ReturnUrl, http);
            var t = lang == "ar" ? Ar : En;
            return Message(http, lang, t["checkMail"], t["checkMailBody"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapGet("/signup", (HttpContext http, IAntiforgery af, string? returnUrl, string? lang) => SignUp(http, af, L(http, lang), returnUrl, null)).AllowAnonymous();

        pages.MapPost("/signup", async (HttpContext http, IAntiforgery af, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var result = await service.RegisterAsync(form.Email ?? "", form.DisplayName ?? "", form.Password ?? "", lang, form.ReturnUrl, http);
            if (!result.Ok) return SignUp(http, af, lang, form.ReturnUrl, result.Failure!.Title, form.Email, form.DisplayName);
            var t = lang == "ar" ? Ar : En;
            return Message(http, lang, t["checkMail"], t["checkMailBody"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapGet("/confirm", async (HttpContext http, AccountService service, Guid userId, string? code, string? returnUrl, string? lang) =>
        {
            var l = L(http, lang);
            var t = l == "ar" ? Ar : En;
            var result = await service.ConfirmAsync(userId, code ?? "", http);
            return result.Ok
                ? Message(http, l, t["confirmed"], t["confirmedBody"], $"/account/signin{Q(returnUrl, l)}", t["signIn"])
                : Message(http, l, t["badLink"], t["badLink"], $"/account/signin{Q(returnUrl, l)}", t["signIn"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapGet("/forgot", (HttpContext http, IAntiforgery af, string? returnUrl, string? lang) =>
        {
            var l = L(http, lang);
            var t = l == "ar" ? Ar : En;
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
            var t = lang == "ar" ? Ar : En;
            return Message(http, lang, t["checkMail"], t["checkMailBody"]);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);

        pages.MapGet("/reset", (HttpContext http, IAntiforgery af, Guid userId, string? code, string? returnUrl, string? lang) =>
            Reset(http, af, L(http, lang), userId, code, returnUrl, null)).AllowAnonymous();

        pages.MapPost("/reset", async (HttpContext http, IAntiforgery af, AccountService service, IFormCollection posted) =>
        {
            var form = new Form(posted);
            var lang = L(http, form.Lang);
            var t = lang == "ar" ? Ar : En;
            var result = await service.ResetAsync(form.UserId, form.Code ?? "", form.Password ?? "", http);
            return result.Ok
                ? Message(http, lang, t["resetTitle"], t["resetDone"], $"/account/signin{Q(form.ReturnUrl, lang)}", t["signIn"])
                : Reset(http, af, lang, form.UserId, form.Code, form.ReturnUrl, result.Failure!.Title);
        }).AllowAnonymous().RequireRateLimiting(Infrastructure.RateLimits.SignIn);
    }

    private static IResult SignUp(HttpContext http, IAntiforgery af, string lang, string? returnUrl, string? error, string? email = null, string? name = null)
    {
        var t = lang == "ar" ? Ar : En;
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
        var t = lang == "ar" ? Ar : En;
        var message = error is null ? "" : $"""<p class="error" role="alert">{E(error)}</p>""";
        return Page(http, lang, t["resetTitle"], $"""
            {message}
            <form method="post" action="/account/reset">{Hidden(af, http, ("ReturnUrl", returnUrl), ("Lang", lang), ("UserId", userId.ToString()), ("Code", code))}
            <label for="password">{E(t["newPassword"])}</label><input id="password" name="Password" type="password" autocomplete="new-password" required minlength="10" dir="ltr">
            <button type="submit">{E(t["save"])}</button></form>
            """);
    }
}
