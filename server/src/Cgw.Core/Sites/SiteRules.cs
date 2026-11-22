using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Sites;

/// <summary>
/// A site's address and words (DECISIONS.md, 2026-11-17: Phase 9): a slug of 3 to 63 of
/// <c>a-z</c>, <c>0-9</c> and <c>-</c>, starting and ending with a letter or a digit, with no
/// <c>--</c>, and none of the reserved words; the site's own words in English or Arabic.
/// </summary>
public static class SiteRules
{
    public const int MinSlug = 3;
    public const int MaxSlug = 63;

    /// <summary>Paths of the site's origin that are not sites, and names kept back.</summary>
    public static readonly HashSet<string> Reserved =
        ["api", "files", "assets", "static", "health", "robots-txt", "favicon-ico", "admin", "www", "cashgear"];

    public static readonly string[] Languages = ["en", "ar"];

    /// <summary>
    /// Phase 14: a site published, changed or unpublished (<c>entityId</c> its root page), told to
    /// whoever can read that page; the workspace's switch or domains changed (<c>entityId</c> the
    /// workspace), told to everyone in it. An open share dialog and Settings read again on either.
    /// </summary>
    public const string SiteChange = "site";
    public const string PublishingChange = "publishing";

    public const string ReasonPerson = "person";
    public const string ReasonPublishingOff = "publishing.off";
    /// <summary>The root page was deleted for good (the worker's purge), so no one could unpublish it.</summary>
    public const string ReasonPageDeleted = "page.deleted";

    /// <summary>Null when the slug may name a site; else why not, in a few words.</summary>
    public static string? SlugProblem(string? slug)
    {
        if (string.IsNullOrEmpty(slug)) return "slug is required";
        if (slug.StartsWith('_')) return "A slug does not start with _";
        if (slug.Length is < MinSlug or > MaxSlug) return $"A slug is {MinSlug} to {MaxSlug} characters";
        foreach (var c in slug)
            if (c is not ((>= 'a' and <= 'z') or (>= '0' and <= '9') or '-')) return "A slug is lower-case letters a to z, digits and -";
        if (slug[0] == '-' || slug[^1] == '-') return "A slug starts and ends with a letter or a digit";
        if (slug.Contains("--", StringComparison.Ordinal)) return "A slug has no --";
        if (Reserved.Contains(slug)) return $"{slug} is reserved";
        return null;
    }

    public static bool IsLanguage(string? language) => language is "en" or "ar";
}

/// <summary>
/// Where the sites are (Phase 9): <c>Sites__PublicUrl</c>, the Sites process's public origin
/// (<c>https://pages.cashgearerp.com</c> in production; <c>http://localhost:5290</c> on a developer's
/// machine and in e2e, a host other than the API's and the web app's <c>127.0.0.1</c>). The API builds
/// a site's address from it, never from a request.
/// </summary>
public sealed record SitesOptions(string PublicUrl)
{
    public const string PublicUrlKey = "Sites:PublicUrl";
    public const string DevPublicUrl = "http://localhost:5290";

    /// <summary>
    /// Phase 14: the server's own host names (the sites', the plugins', the API's, the web app's),
    /// which no workspace may take for a site, compared lower case without a port.
    /// </summary>
    public IReadOnlySet<string> OwnHosts { get; init; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>Phase 14: outside Production a site's host name may be a <c>*.localhost</c> name (the e2e stack's).</summary>
    public bool AllowLocalhost { get; init; }

    /// <summary>The sites' own host name, lower case, no port (<c>pages.cashgearerp.com</c>; <c>localhost</c> in development).</summary>
    public string Host => Uri.TryCreate(PublicUrl, UriKind.Absolute, out var uri) ? uri.Host.ToLowerInvariant() : "";

    public static SitesOptions From(IConfiguration configuration, bool production)
    {
        var value = configuration[PublicUrlKey];
        var origin = Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? uri.GetLeftPart(UriPartial.Authority).TrimEnd('/')
            : null;
        var own = new HashSet<string>(StringComparer.Ordinal);
        foreach (var key in new[] { PublicUrlKey, "Plugins:PublicUrl", "Api:PublicUrl", "Web:AppUrl" })
            if (Uri.TryCreate(configuration[key]?.Trim(), UriKind.Absolute, out var named)) own.Add(named.Host.ToLowerInvariant());
        foreach (var child in configuration.GetSection("Web:Origins").GetChildren())
            if (Uri.TryCreate(child.Value?.Trim(), UriKind.Absolute, out var named)) own.Add(named.Host.ToLowerInvariant());
        var options = new SitesOptions(origin ?? (production ? "" : DevPublicUrl)) { AllowLocalhost = !production };
        own.Add(options.Host);
        return options with { OwnHosts = own };
    }

    public string SiteUrl(string slug) => $"{PublicUrl}/{slug}";

    /// <summary>
    /// Phase 14: a site's address at its own host name: https in Production; elsewhere the sites'
    /// own scheme and port (<c>http://docs.example.localhost:5290</c> on a developer's machine).
    /// </summary>
    public string DomainUrl(string host)
    {
        if (!AllowLocalhost || !Uri.TryCreate(PublicUrl, UriKind.Absolute, out var uri)) return $"https://{host}";
        return uri.IsDefaultPort ? $"{uri.Scheme}://{host}" : $"{uri.Scheme}://{host}:{uri.Port}";
    }
}
