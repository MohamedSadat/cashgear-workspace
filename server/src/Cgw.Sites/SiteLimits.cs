using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.RateLimiting;
using Cgw.Core.Plugins;
using Cgw.Core.Sites;
using Microsoft.AspNetCore.RateLimiting;

namespace Cgw.Sites;

/// <summary>
/// The Sites process's rate limit (Phase 14, M14.3; decisions, 2026-11-22): one address may ask 300
/// pages and files a minute of every site together (<c>RateLimits:sites</c>), and 1,200 of the plugins
/// host (<c>RateLimits:sitesPlugins</c>: a frame fetches many files), a sliding window of six 10 s
/// segments; an IPv6 address counted by its /64. <c>robots.txt</c>, <c>/health/live</c> and ACME's
/// challenges are outside it. Past it: 429 with <c>Retry-After</c> and a page in English and Arabic,
/// answered before anything reads the database (the limiter runs before every route, so the site, and
/// its language, are never known to it).
/// </summary>
public static class SiteLimits
{
    public const string PagesKey = "RateLimits:sites";
    public const string PluginsKey = "RateLimits:sitesPlugins";
    public const int Pages = 300;
    public const int Plugins = 1200;
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
    public const int Segments = 6;

    /// <summary>Whose window: an IPv4 address (a mapped one too) as it is, an IPv6 address by its first 64 bits.</summary>
    public static string Partition(IPAddress? address)
    {
        if (address is null) return "unknown";
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return address.ToString();
        var bytes = address.GetAddressBytes();
        for (var i = 8; i < 16; i++) bytes[i] = 0;
        return new IPAddress(bytes) + "/64";
    }

    /// <summary>Paths outside the limit: what crawlers, IIS and ACME's validators ask.</summary>
    public static bool Outside(PathString path) =>
        path.Equals("/robots.txt", StringComparison.Ordinal) || path.Equals("/health/live", StringComparison.Ordinal)
        || path.StartsWithSegments("/.well-known/acme-challenge", StringComparison.Ordinal);

    public static IServiceCollection AddSiteLimits(this IServiceCollection services, IConfiguration configuration, PluginsOptions plugins)
    {
        static int Limit(IConfiguration c, string key, int fallback) =>
            int.TryParse(c[key], NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0 ? n : fallback;
        var pages = Limit(configuration, PagesKey, Pages);
        var pluginFiles = Limit(configuration, PluginsKey, Plugins);
        var pluginsHost = plugins.Host;
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
            {
                if (Outside(context.Request.Path)) return RateLimitPartition.GetNoLimiter("");
                var onPlugins = pluginsHost is not null && string.Equals(context.Request.Host.Value, pluginsHost, StringComparison.OrdinalIgnoreCase);
                var key = (onPlugins ? "plugins:" : "sites:") + Partition(context.Connection.RemoteIpAddress);
                return RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
                {
                    PermitLimit = onPlugins ? pluginFiles : pages,
                    Window = Window,
                    SegmentsPerWindow = Segments,
                    QueueLimit = 0,
                    AutoReplenishment = true,
                });
            });
            options.OnRejected = async (rejected, ct) =>
            {
                var response = rejected.HttpContext.Response;
                var wait = rejected.Lease.TryGetMetadata(MetadataName.RetryAfter, out var after) && after > TimeSpan.Zero ? after : Window / Segments;
                response.Headers.RetryAfter = ((int)Math.Ceiling(wait.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
                response.Headers.CacheControl = "no-store";
                response.ContentType = "text/html; charset=utf-8";
                await response.Body.WriteAsync(TooMany, ct);
            };
        });
        return services;
    }

    private static readonly byte[] TooMany = Encoding.UTF8.GetBytes(SiteRenderer.TooMany());
}
