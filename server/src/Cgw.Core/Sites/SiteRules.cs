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

    public static SitesOptions From(IConfiguration configuration, bool production)
    {
        var value = configuration[PublicUrlKey];
        var origin = Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? uri.GetLeftPart(UriPartial.Authority).TrimEnd('/')
            : null;
        return new SitesOptions(origin ?? (production ? "" : DevPublicUrl));
    }

    public string SiteUrl(string slug) => $"{PublicUrl}/{slug}";
}
