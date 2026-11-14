namespace Cgw.Api.Infrastructure;

/// <summary>
/// The shortcuts a developer's machine takes, each a setting of its own and each refused in
/// Production (<see cref="ProductionChecks"/>):
/// <list type="bullet">
/// <item><c>Api__AllowHttp</c>: plain http (the server stack on <c>http://127.0.0.1:5280</c>, the
/// rehearsal): OpenIddict's endpoints answer it, and the session and antiforgery cookies are
/// Secure only on https requests. Off unless set, in every environment.</item>
/// <item><c>OpenIddict__EphemeralKeys</c>: signing and encryption keys made at start and lost at
/// stop, in place of the certificate store.</item>
/// <item><c>Api__PublicUrlFromRequest</c>: mail links built from the request's Host header when
/// <c>Api__PublicUrl</c> is not set.</item>
/// </list>
/// The last two are on in Development and Testing unless set, and off everywhere else, Staging
/// included.
/// </summary>
public sealed record Shortcuts(bool AllowHttp, bool EphemeralKeys, bool PublicUrlFromRequest)
{
    public const string AllowHttpKey = "Api:AllowHttp";
    public const string EphemeralKeysKey = "OpenIddict:EphemeralKeys";
    public const string PublicUrlFromRequestKey = "Api:PublicUrlFromRequest";

    public static readonly string[] Keys = [AllowHttpKey, EphemeralKeysKey, PublicUrlFromRequestKey];

    public static bool IsLocal(IHostEnvironment environment) => environment.IsDevelopment() || environment.IsEnvironment("Testing");

    public static Shortcuts From(IConfiguration configuration, IHostEnvironment environment)
    {
        var local = IsLocal(environment);
        bool Flag(string key, bool otherwise) => configuration[key] is { Length: > 0 } value ? string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) : otherwise;
        return new Shortcuts(Flag(AllowHttpKey, false), Flag(EphemeralKeysKey, local), Flag(PublicUrlFromRequestKey, local));
    }
}

/// <summary>
/// What Production refuses to start without, and what it refuses to start with: the web app's
/// origins, the public URL mail links are built from, DPAPI over the keys kept in the database (on
/// Windows), Sheet's origins and the ERP's base (Phase 5), and none of the development
/// <see cref="Shortcuts"/>.
/// </summary>
public static class ProductionChecks
{
    public static List<string> Problems(IConfiguration configuration, IHostEnvironment environment, bool windows)
    {
        var problems = new List<string>();
        if (!environment.IsProduction()) return problems;
        var origins = configuration.GetSection("Web:Origins").Get<string[]>() ?? [];
        if (origins.Length == 0 || origins.Any(o => !Uri.TryCreate(o, UriKind.Absolute, out _)))
            problems.Add("Set Web__Origins__0 (and __1, ...) to the web app's and the desktop webview's origins.");
        if (!Uri.TryCreate(configuration["Api:PublicUrl"], UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps)
            problems.Add("Set Api__PublicUrl to the API's public https origin.");
        if (windows && configuration["DataProtection:Dpapi"] != "true")
            problems.Add("Set DataProtection__Dpapi=true: the cookie and token keys in the database are otherwise kept in the clear.");
        // Phase 5: where Sheet and the ERP are comes from here alone, never from a link.
        static bool Https(string? value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps;
        if (!Https(configuration[Cgw.Core.Workbooks.Integrations.SheetOriginKey]))
            problems.Add("Set Sheet__Origin to Sheet's https origin (launch links open it).");
        var sheetOrigins = configuration.GetSection(Cgw.Core.Workbooks.Integrations.SheetOriginsKey).Get<string[]>() ?? [];
        if (sheetOrigins.Length == 0 || sheetOrigins.Any(o => !Https(o)))
            problems.Add("Set Sheet__Origins__0 (and __1, ...) to Sheet's https origins (they redeem tickets and read workbooks).");
        if (!Https(configuration[Cgw.Core.Workbooks.Integrations.ErpApiBaseKey]))
            problems.Add("Set Erp__ApiBase to the ERP API's https base (the only ERP a link may name).");
        foreach (var key in Shortcuts.Keys)
            if (string.Equals(configuration[key], "true", StringComparison.OrdinalIgnoreCase))
                problems.Add($"{key.Replace(":", "__", StringComparison.Ordinal)} is for a developer's machine and is refused in Production.");
        return problems;
    }

    public static void Enforce(IConfiguration configuration, IHostEnvironment environment)
    {
        var problems = Problems(configuration, environment, OperatingSystem.IsWindows());
        if (problems.Count > 0)
            throw new InvalidOperationException("The API does not start in Production like this. " + string.Join(" ", problems));
    }
}

/// <summary>
/// The session and antiforgery cookies' names. Outside Development and Testing they carry the
/// <c>__Host-</c> prefix (Secure, <c>Path=/</c>, no <c>Domain</c>), so another host of the same
/// site cannot set or shadow them. A developer's machine, or any host told to allow plain http,
/// keeps the plain names: a browser refuses a <c>__Host-</c> cookie that is not Secure.
/// </summary>
public sealed record CookieNames(string Session, string Antiforgery)
{
    public static CookieNames For(IHostEnvironment environment, Shortcuts shortcuts) =>
        Shortcuts.IsLocal(environment) || shortcuts.AllowHttp
            ? new CookieNames("cgw_session", "cgw_xsrf")
            : new CookieNames("__Host-cgw_session", "__Host-cgw_xsrf");
}
