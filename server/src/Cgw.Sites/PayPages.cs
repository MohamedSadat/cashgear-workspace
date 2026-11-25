using System.Globalization;
using System.Reflection;
using System.Text;
using System.Text.Encodings.Web;

namespace Cgw.Sites;

/// <summary>
/// What the pay page needs of Paddle (<c>Billing__Paddle__ClientToken</c>, <c>__Environment</c> and,
/// outside Production, <c>__ScriptUrl</c>): the client-side token Paddle.js is initialised with,
/// public by Paddle's design. Never Paddle's API key or webhook secret: this process is given
/// neither. No token: no pay page (its 404).
/// </summary>
public sealed record PayPageOptions(string? ClientToken, bool Sandbox, string ScriptUrl)
{
    public const string PaddleScript = "https://cdn.paddle.com/paddle/v2/paddle.js";

    public static PayPageOptions From(IConfiguration configuration, bool production)
    {
        var paddle = configuration.GetSection("Billing:Paddle");
        var token = paddle["ClientToken"]?.Trim() is { Length: > 0 and <= 200 } t && t.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ? t : null;
        var sandbox = paddle["Environment"]?.Trim().ToLowerInvariant() switch
        {
            "sandbox" => true,
            "live" => false,
            _ => token?.StartsWith("test_", StringComparison.Ordinal) == true,
        };
        var script = !production && Uri.TryCreate(paddle["ScriptUrl"], UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" ? uri.ToString() : PaddleScript;
        return new PayPageOptions(token, sandbox, script);
    }

    /// <summary>Where Paddle's checkout comes from: Paddle's own hosts, or the mock's origin in tests.</summary>
    public string Sources => ScriptUrl == PaddleScript ? "https://*.paddle.com" : new Uri(ScriptUrl).GetLeftPart(UriPartial.Authority);
}

/// <summary>
/// Phase 18 (M18.2): the pay page, <c>/_pay/en</c> and <c>/_pay/ar</c> on the sites' own host, which
/// Paddle's transactions name as their checkout's address (Paddle adds <c>_ptxn</c>, the transaction):
/// Paddle.js, from Paddle, opens Paddle's own checkout over it, where the card is typed into Paddle's
/// frames. This origin has no sign-in, no cookie and no session, so Paddle's script can reach nothing
/// of the person's; the page shows only that the checkout is opening, and then that it is done. Its
/// policy allows Paddle's script, frames and calls, and payments in Paddle's frames, on these pages
/// only.
/// </summary>
public static class PayPages
{
    public const string PermissionsKey = "cgw.permissions";
    public const string OpenerKey = "cgw.opener";

    private static readonly string Script = ReadScript();

    private static string ReadScript()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Cgw.Sites.pay.js")!;
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    public static WebApplication MapPayPages(this WebApplication app)
    {
        app.Map("/_pay/{language}", (string language, HttpContext http, PayPageOptions options) =>
        {
            if (!HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method)) return Missing(http);
            if (options.ClientToken is not { } token || language is not ("en" or "ar")) return Missing(http);
            var sources = options.Sources;
            http.Items[FormPages.PolicyKey] =
                $"default-src 'none'; script-src 'self' {options.ScriptUrl}; frame-src {sources}; connect-src {sources}; "
                + $"img-src {sources} data:; style-src 'unsafe-inline' {sources}; font-src {sources}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
            // Paddle's frames may ask for Apple Pay and Google Pay, and PayPal opens a window of its own.
            http.Items[PermissionsKey] = SitesHost.PermissionsPolicy.Replace("payment=()", $"payment=(self \"{(sources.Contains('*') ? "https://buy.paddle.com\" \"https://sandbox-buy.paddle.com" : sources)}\")", StringComparison.Ordinal);
            http.Items[OpenerKey] = "same-origin-allow-popups";
            http.Response.Headers.CacheControl = "no-store";
            return Results.Content(Page(language, token, options), "text/html; charset=utf-8", Encoding.UTF8);
        });
        app.Map("/_pay/pay.js", (HttpContext http) =>
        {
            if (!HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method)) return Missing(http);
            http.Response.Headers.CacheControl = "public, max-age=3600";
            return Results.Content(Script, "text/javascript; charset=utf-8", Encoding.UTF8);
        });
        return app;
    }

    private static IResult Missing(HttpContext http)
    {
        http.Response.Headers.CacheControl = "no-cache";
        return Results.Content(Cgw.Core.Sites.SiteRenderer.NotFound(), "text/html; charset=utf-8", Encoding.UTF8, 404);
    }

    private static readonly (string Title, string Opening, string Done, string Closed) En =
        ("Cash Gear Workspace: checkout", "Opening Paddle’s checkout…", "Payment received. The workspace’s plan starts within a minute: you can close this tab and go back to Cash Gear Workspace.",
            "The checkout was closed. You can close this tab and go back to Cash Gear Workspace.");

    private static readonly (string Title, string Opening, string Done, string Closed) Ar =
        ("مساحة عمل كاش جير: الدفع", "جارٍ فتح صفحة الدفع من Paddle…", "تم استلام الدفعة. تبدأ خطة مساحة العمل خلال دقيقة: يمكنك إغلاق هذه الصفحة والعودة إلى مساحة عمل كاش جير.",
            "أُغلقت صفحة الدفع. يمكنك إغلاق هذه الصفحة والعودة إلى مساحة عمل كاش جير.");

    public static string Page(string language, string token, PayPageOptions options)
    {
        var words = language == "ar" ? Ar : En;
        var h = HtmlEncoder.Create(System.Text.Unicode.UnicodeRanges.All);
        var a = (string s) => h.Encode(s);
        var builder = new StringBuilder();
        builder.Append(CultureInfo.InvariantCulture, $"<!doctype html><html lang=\"{language}\" dir=\"{(language == "ar" ? "rtl" : "ltr")}\"><head><meta charset=\"utf-8\">");
        builder.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\">");
        builder.Append(CultureInfo.InvariantCulture, $"<title>{a(words.Title)}</title>");
        builder.Append("<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#fff;color:#1f2328}main{max-width:36rem;margin:0 auto}@media (prefers-color-scheme:dark){body{background:#16181c;color:#e6e8eb}}</style>");
        builder.Append(CultureInfo.InvariantCulture, $"</head><body><main><p id=\"state\" role=\"status\" data-done=\"{a(words.Done)}\" data-closed=\"{a(words.Closed)}\">{a(words.Opening)}</p></main>");
        builder.Append(CultureInfo.InvariantCulture, $"<script src=\"{a(options.ScriptUrl)}\"></script>");
        builder.Append(CultureInfo.InvariantCulture, $"<script src=\"/_pay/pay.js\" data-token=\"{a(token)}\" data-sandbox=\"{(options.Sandbox ? "1" : "0")}\" data-locale=\"{language}\"></script>");
        builder.Append("</body></html>");
        return builder.ToString();
    }
}
