using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Workbooks;

/// <summary>
/// Where Sheet and the ERP are (Phase 5 contracts, section 6), from configuration and never from a
/// link, a document or a message:
/// <list type="bullet">
/// <item><c>Sheet__Origin</c>: the one Sheet origin launch links open (dev: the mock Sheet).</item>
/// <item><c>Sheet__Origins</c>: the origins that may redeem a ticket and call the file-session
/// routes (their CORS policy), and that read workbooks from Blob Storage.</item>
/// <item><c>Workbooks__MaxSaveBytes</c>: the largest version a save or a copy may send (100 MB).</item>
/// <item><c>Erp__ApiBase</c>: the only ERP an ERP link may name.</item>
/// <item><c>Sheet__DesktopOrigins</c> (Phase 9, Track S6): the origins of Sheet's desktop app,
/// which alone may redeem a desktop launch ticket (default <c>http://tauri.localhost</c> and
/// <c>tauri://localhost</c>, in production too).</item>
/// </list>
/// Outside Production each has a development default (the mocks of <c>tests/mocks</c>, Sheet's dev
/// and preview servers); Production starts only with all of them set (<c>ProductionChecks</c>).
/// </summary>
public sealed record Integrations(string SheetOrigin, IReadOnlyList<string> SheetOrigins, long MaxSaveBytes, string ErpApiBase)
{
    public const string SheetOriginKey = "Sheet:Origin";
    public const string SheetOriginsKey = "Sheet:Origins";
    public const string SheetDesktopOriginsKey = "Sheet:DesktopOrigins";
    public const string MaxSaveBytesKey = "Workbooks:MaxSaveBytes";
    public const string ErpApiBaseKey = "Erp:ApiBase";

    /// <summary>Sheet's desktop WebView: Windows (WebView2) and macOS (WKWebView).</summary>
    public static readonly string[] DefaultDesktopOrigins = ["http://tauri.localhost", "tauri://localhost"];

    /// <summary>The origins a desktop launch ticket is redeemed from (INTEGRATIONS.md, Track S6).</summary>
    public IReadOnlyList<string> SheetDesktopOrigins { get; init; } = DefaultDesktopOrigins;

    /// <summary>The scheme and path of Sheet's desktop deep link; the ticket goes in the fragment.</summary>
    public const string DesktopLaunchBase = "cashgear-sheet://workspace/launch";

    public const string DevSheetOrigin = "http://127.0.0.1:4283";
    public const string DevErpApiBase = "http://127.0.0.1:4282";
    public const long DefaultMaxSaveBytes = 100L * 1024 * 1024;

    /// <summary>The mock Sheet, and Sheet's own dev (5173) and preview (4173) servers.</summary>
    public static readonly string[] DevSheetOrigins =
    [
        DevSheetOrigin, "http://127.0.0.1:4173", "http://localhost:4173", "http://127.0.0.1:5173", "http://localhost:5173",
    ];

    public static Integrations From(IConfiguration configuration, bool production)
    {
        var origin = Origin(configuration[SheetOriginKey]) ?? (production ? "" : DevSheetOrigin);
        var origins = (configuration.GetSection(SheetOriginsKey).Get<string[]>() ?? [])
            .Select(Origin).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
        if (origins.Length == 0 && !production) origins = DevSheetOrigins;
        var max = long.TryParse(configuration[MaxSaveBytesKey], NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0 ? n : DefaultMaxSaveBytes;
        var erp = Base(configuration[ErpApiBaseKey]) ?? (production ? "" : DevErpApiBase);
        var desktop = (configuration.GetSection(SheetDesktopOriginsKey).Get<string[]>() ?? [])
            .Select(DesktopOrigin).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
        return new Integrations(origin, origins, max, erp) { SheetDesktopOrigins = desktop.Length > 0 ? desktop : DefaultDesktopOrigins };
    }

    /// <summary>
    /// A desktop WebView's origin as it writes <c>Origin</c>: <c>http</c>, <c>https</c> or
    /// <c>tauri</c>, a host and an optional port, nothing else; null otherwise.
    /// </summary>
    public static string? DesktopOrigin(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https" or "tauri")
            || uri.Host.Length == 0 || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.AbsolutePath is not ("/" or ""))
            return null;
        return uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
    }

    /// <summary>Sheet's desktop deep link for a launch ticket (Track S6): never logged or kept by either side.</summary>
    public static string DesktopLaunchUrl(string ticket) => $"{DesktopLaunchBase}#ticket={ticket}";

    /// <summary><c>scheme://host[:port]</c> of an absolute http(s) URL, as a browser writes <c>Origin</c>; null otherwise.</summary>
    public static string? Origin(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)) return null;
        return uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
    }

    /// <summary>An absolute http(s) URL without a trailing slash, query or fragment: an API's base.</summary>
    public static string? Base(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
            return null;
        return (uri.GetLeftPart(UriPartial.Authority) + uri.AbsolutePath).TrimEnd('/');
    }

    /// <summary>The launch link Sheet opens: the ticket in the fragment, so it reaches no server's log.</summary>
    public string LaunchUrl(string ticket) => $"{SheetOrigin}/cloud#launch={ticket}";
}
