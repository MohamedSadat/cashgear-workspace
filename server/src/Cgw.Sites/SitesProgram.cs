using System.Text;
using Cgw.Core;
using Cgw.Core.Assets;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Documents;
using Cgw.Core.Plugins;
using Cgw.Core.Sharing;
using Cgw.Core.Sites;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Primitives;

namespace Cgw.Sites;

/// <summary>
/// The Sites process (Phase 9, M9.1; DECISIONS.md, 2026-11-17): published pages as plain HTML on an
/// origin of their own (<c>pages.cashgearerp.com</c>; <c>http://localhost:5290</c> on a developer's
/// machine), so nothing a published page holds can read the app's or the API's session. It has no
/// sign-in code, never sets or reads a cookie, sends no script, and loads no Yjs library: it reads
/// the database and Blob Storage with the API's configuration names. Every answer carries a strict
/// Content Security Policy (one hashed stylesheet; images from the site and the blob account only).
/// Routes: <c>GET /{slug}</c>, <c>/{slug}/{pageId}</c>, <c>/{slug}/files/{assetId}</c>,
/// <c>/robots.txt</c>, <c>/health/live</c>, and (Phase 16) a form link's pages, <c>GET</c> and
/// <c>POST /_form/{token}</c> and <c>GET /_form/{token}/done</c> (FormPages); anything else is the
/// 404 page.
/// <para>
/// Phase 10: a second host, the plugins origin (<c>Plugins__PublicUrl</c>:
/// <c>plugins.cashgearerp.com</c>; <c>http://localhost:5291</c> on a developer's machine), answers
/// only <c>GET</c>/<c>HEAD /f/{ticket}/{*path}</c>: a third-party plugin's file, under a frame ticket
/// the API made for a member (stored hashed, found by its hash), with a sandboxing Content Security
/// Policy that allows no network. The process loads no Data Protection, as in 0.9.0. <c>/f/</c> on the pages host, and
/// anything else on the plugins host, is the 404 page.
/// </para>
/// <para>
/// Phase 14: any other host name is a site's own (a workspace's, proven by DNS, its certificate live):
/// the site's root at <c>/</c>, its pages at <c>/{pageId}</c>, its files at <c>/files/{assetId}</c>, a
/// <c>robots.txt</c> of its own, ACME's HTTP-01 answers at <c>/.well-known/acme-challenge/{token}</c>
/// while an order lasts (on the sites' own host too, by the token alone: where the IIS host's port 80
/// sends ACME's path of a name it does not bind yet), and <c>http</c> sent on to <c>https</c> in
/// Production; the slug's addresses of a site with such a name lead there (302). An address past its
/// window is answered 429 first (SiteLimits).
/// </para>
/// </summary>
public sealed class SitesProgram
{
    public static async Task Main(string[] args) => await Build(args).RunAsync();

    public static WebApplication Build(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.ConfigureKestrel(o => o.AddServerHeader = false);
        if (builder.Configuration["Logging:Format"] == "json")
        {
            builder.Logging.ClearProviders();
            builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
        }
        // Under IIS the console goes nowhere: warnings and errors to the Application event log too.
        if (OperatingSystem.IsWindows() && builder.Configuration["Logging:EventLog:Enabled"] == "true")
        {
            builder.Logging.AddEventLog(s =>
            {
                if (OperatingSystem.IsWindows()) s.SourceName = "Cash Gear Workspace sites";
            });
            builder.Logging.AddFilter<Microsoft.Extensions.Logging.EventLog.EventLogLoggerProvider>(level => level >= LogLevel.Warning);
        }
        builder.Services.AddCgwSites(builder.Configuration);
        builder.Services.AddHealthChecks();
        // Phase 14: one address's pages and files a minute, before anything reads the database.
        builder.Services.AddSiteLimits(builder.Configuration, PluginsOptions.From(builder.Configuration, builder.Environment.IsProduction()));

        var app = builder.Build();
        var local = app.Environment.IsDevelopment() || app.Environment.IsEnvironment("Testing");
        app.UseSiteHeaders(app.Services.GetRequiredService<BlobStore>(), hsts: !local);
        app.UseExceptionHandler(new ExceptionHandlerOptions
        {
            ExceptionHandler = async context =>
            {
                context.Response.StatusCode = 500;
                context.Response.ContentType = "text/plain; charset=utf-8";
                await context.Response.WriteAsync("Something went wrong.");
            },
        });
        app.UseRateLimiter();
        app.UsePluginsHost(app.Services.GetRequiredService<PluginsOptions>(), hsts: !local);
        app.UseSiteDomains(app.Services.GetRequiredService<SitesOptions>(), https: !local);
        app.MapSites();
        return app;
    }
}

public static class SitesHost
{
    /// <summary>What the Sites process runs on: the core's data, a share link's readers, the site's own.</summary>
    public static IServiceCollection AddCgwSites(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddCgwData(configuration);
        services.AddMemoryCache();
        services.AddScoped<Access>();
        services.AddScoped<DocService>();
        services.AddScoped<AssetService>();
        services.AddScoped<SharedReader>();
        services.AddScoped<SharedDatabases>();
        services.AddSingleton<DatabaseRowCache>();
        services.AddSingleton<SiteCache>();
        services.AddScoped<SiteReader>();
        // Phase 14: the sites' own host name, and the addresses of a site at its own.
        services.AddSingleton(sp => SitesOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddSingleton(sp => PayPageOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        // Phase 10: the plugins host. Frame tickets are stored hashed (found by their hash): this
        // process holds no Data Protection, and its identity is denied the key ring's table.
        services.AddSingleton(sp => PluginsOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddSingleton<PluginFiles>();
        return services;
    }

    /// <summary>
    /// "Empty" read as every powerful feature given an empty allowlist: a published page may use
    /// none (an empty header would leave the browser's defaults).
    /// </summary>
    public const string PermissionsPolicy =
        "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), "
        + "magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), "
        + "serial=(), usb=(), xr-spatial-tracking=()";

    public const string IndexedKey = "cgw.indexed";

    /// <summary>Set on an answer of a plugin's file: it carries the plugin's own headers, not a site's.</summary>
    public const string PluginFileKey = "cgw.pluginFile";

    /// <summary>The policy: nothing but the one stylesheet, and images from the site and the blob account.</summary>
    public static string ContentSecurityPolicy(BlobStore blob)
    {
        var account = blob.Container.Uri.GetLeftPart(UriPartial.Authority);
        return $"default-src 'none'; style-src {SiteStyle.Hash}; img-src 'self' {account}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    }

    /// <summary>Every answer's headers, set as it starts; a cookie never leaves, whatever set it.</summary>
    public static IApplicationBuilder UseSiteHeaders(this IApplicationBuilder app, BlobStore blob, bool hsts)
    {
        var csp = ContentSecurityPolicy(blob);
        return app.Use(async (context, next) =>
        {
            context.Response.OnStarting(() =>
            {
                var headers = context.Response.Headers;
                headers.Remove("Set-Cookie");
                if (context.Items[PluginFileKey] is true) return Task.CompletedTask;
                // Phase 16: a form link's page posts its answers; every other page posts nothing.
                // Phase 18: the pay page runs Paddle's checkout, and only it.
                headers.ContentSecurityPolicy = context.Items[FormPages.PolicyKey] as string ?? csp;
                headers.XContentTypeOptions = "nosniff";
                headers["Referrer-Policy"] = "no-referrer";
                headers["Cross-Origin-Opener-Policy"] = context.Items[PayPages.OpenerKey] as string ?? "same-origin";
                headers["Cross-Origin-Resource-Policy"] = "same-origin";
                headers["Permissions-Policy"] = context.Items[PayPages.PermissionsKey] as string ?? PermissionsPolicy;
                if (hsts && context.Request.IsHttps) headers.StrictTransportSecurity = "max-age=31536000";
                if (context.Items[IndexedKey] is not true) headers["X-Robots-Tag"] = "noindex";
                return Task.CompletedTask;
            });
            await next();
        });
    }

    private static readonly string Missing = SiteRenderer.NotFound();

    /// <summary>
    /// The plugins host (Phase 10), ahead of the sites' routes: on that host, a plugin's file or the
    /// 404 page; on any other, <c>/f/</c> is the 404 page and everything else goes on to the sites.
    /// </summary>
    public static IApplicationBuilder UsePluginsHost(this IApplicationBuilder app, PluginsOptions options, bool hsts)
    {
        var host = options.Host;
        return app.Use(async (context, next) =>
        {
            var onPlugins = host is not null && string.Equals(context.Request.Host.Value, host, StringComparison.OrdinalIgnoreCase);
            if (!onPlugins)
            {
                if (context.Request.Path.StartsWithSegments("/f")) await NotFound(context).ExecuteAsync(context);
                else await next();
                return;
            }
            if (!Readable(context) || !await PluginFileAsync(context, hsts)) await NotFound(context).ExecuteAsync(context);
        });
    }

    /// <summary>
    /// <c>/f/{ticket}/{*path}</c>: the ticket opened, the plugin live, on and of the ticket's bundle,
    /// the path one of the bundle's files; false (the 404 page) for anything else. Phase 13: with the
    /// plugin's own Content Security Policy (its approved hosts), read as it was when the ticket was made.
    /// </summary>
    private static async Task<bool> PluginFileAsync(HttpContext context, bool hsts)
    {
        var path = context.Request.Path.Value ?? "";
        if (!path.StartsWith("/f/", StringComparison.Ordinal)) return false;
        var rest = path[3..];
        var slash = rest.IndexOf('/');
        if (slash <= 0 || slash == rest.Length - 1) return false;
        var services = context.RequestServices;
        var files = services.GetRequiredService<PluginFiles>();
        var ct = context.RequestAborted;
        var db = services.GetRequiredService<CgwDb>();
        var ticket = await files.TicketAsync(db, rest[..slash], ct);
        if (ticket is null) return false;
        var plugin = await files.PluginAsync(db, ticket.PluginId, ct, ticket.MadeAt);
        if (plugin is not { Live: true, Enabled: true } || plugin.WorkspaceId != ticket.WorkspaceId || plugin.BundleHash != ticket.BundleHash) return false;
        if (!plugin.Files.TryGetValue(rest[(slash + 1)..], out var file)) return false;
        var bytes = await files.BytesAsync(plugin, file, ct);
        if (bytes is null) return false;
        context.Items[PluginFileKey] = true;
        var response = context.Response;
        var headers = response.Headers;
        response.StatusCode = 200;
        response.ContentType = file.ContentType;
        response.ContentLength = bytes.LongLength;
        headers.ContentSecurityPolicy = plugin.Csp;
        headers.XContentTypeOptions = "nosniff";
        headers["Referrer-Policy"] = "no-referrer";
        headers.CacheControl = "private, max-age=600";
        // A sandboxed frame's origin is null: its module scripts are read with CORS.
        headers.AccessControlAllowOrigin = "*";
        headers["Permissions-Policy"] = PermissionsPolicy;
        headers["X-Robots-Tag"] = "noindex";
        if (hsts && context.Request.IsHttps) headers.StrictTransportSecurity = "max-age=31536000";
        if (HttpMethods.IsGet(context.Request.Method)) await response.Body.WriteAsync(bytes, ct);
        return true;
    }

    /// <summary>
    /// Phase 14: a host name that is neither the sites' own nor the plugins' (which answers before
    /// this): a site's own, or the 404 page.
    /// </summary>
    public static IApplicationBuilder UseSiteDomains(this IApplicationBuilder app, SitesOptions sites, bool https)
    {
        var own = sites.Host;
        return app.Use(async (context, next) =>
        {
            var host = context.Request.Host.Host.ToLowerInvariant();
            // Without its own address (Sites__PublicUrl) the process cannot tell a site's own name
            // from its own: every host is served as the sites' (0.13.0's behaviour).
            if (own.Length == 0 || host.Length == 0)
            {
                await next();
                return;
            }
            if (host == own)
            {
                // ACME's path of a name the IIS host does not bind yet: its port 80 sends it here
                // (docs/OPERATIONS.md), answered by the token alone.
                if (Readable(context) && await ChallengeAsync(context, null) is { } answer) await answer.ExecuteAsync(context);
                else await next();
                return;
            }
            var result = Readable(context) ? await DomainAsync(context, host, https) : NotFound(context);
            await result.ExecuteAsync(context);
        });
    }

    private const string ChallengePath = "/.well-known/acme-challenge/";

    /// <summary>ACME's HTTP-01 answer (RFC 8555, 8.3) at its path, the 404 page for another token, or null off that path.</summary>
    private static async Task<IResult?> ChallengeAsync(HttpContext http, string? host)
    {
        var path = http.Request.Path.Value ?? "/";
        if (!path.StartsWith(ChallengePath, StringComparison.Ordinal)) return null;
        var token = path[ChallengePath.Length..];
        if (token.Length is 0 or > 128 || !token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return NotFound(http);
        var reader = http.RequestServices.GetRequiredService<SiteReader>();
        if (await reader.ChallengeAsync(host, token, http.RequestAborted) is not { } answer) return NotFound(http);
        http.Response.Headers.CacheControl = "no-store";
        return Results.Text(answer, "text/plain; charset=utf-8");
    }

    private static async Task<IResult> DomainAsync(HttpContext http, string host, bool https)
    {
        var reader = http.RequestServices.GetRequiredService<SiteReader>();
        var ct = http.RequestAborted;
        var path = http.Request.Path.Value ?? "/";
        if (await ChallengeAsync(http, host) is { } challenge) return challenge;
        if (await reader.StateByHostAsync(host, ct) is not { } state) return NotFound(http);
        if (https && !http.Request.IsHttps)
            return Results.Redirect($"https://{host}{http.Request.Path}{http.Request.QueryString}", permanent: true, preserveMethod: true);
        if (path == "/robots.txt")
        {
            http.Response.Headers.CacheControl = "no-cache";
            if (state.Site.Indexing) http.Items[IndexedKey] = true;
            return Results.Text("User-agent: *\n" + (state.Site.Indexing ? "Allow: /\n" : "Disallow: /\n"), "text/plain; charset=utf-8");
        }
        if (path == "/") return await PageAsync(state, null, http);
        var rest = path[1..];
        if (Guid.TryParse(rest, out var pageId) && rest.Length == 36) return await PageAsync(state, pageId, http);
        if (rest.StartsWith("files/", StringComparison.Ordinal) && Guid.TryParse(rest["files/".Length..], out var assetId))
            return await FileAsync(state, assetId, http);
        return NotFound(http);
    }

    /// <summary>A slug's address of a site that has its own host name: there, with the same path and query (302).</summary>
    private static IResult? ToDomain(SiteState state, HttpContext http, string rest)
    {
        if (state.Domain is not { } host) return null;
        var sites = http.RequestServices.GetRequiredService<SitesOptions>();
        http.Response.Headers.CacheControl = "no-cache";
        return Results.Redirect(sites.DomainUrl(host) + (rest.Length == 0 ? "/" : rest) + http.Request.QueryString, permanent: false);
    }

    private static async Task<IResult> FileAsync(SiteState state, Guid assetId, HttpContext http)
    {
        var reader = http.RequestServices.GetRequiredService<SiteReader>();
        if (await reader.FileAsync(state, assetId, http.RequestAborted) is not { } url) return NotFound(http);
        http.Response.Headers.CacheControl = "no-store";
        if (state.Site.Indexing) http.Items[IndexedKey] = true;
        return Results.Redirect(url.Url, permanent: false);
    }

    private static IResult NotFound(HttpContext http)
    {
        http.Response.Headers.CacheControl = "no-cache";
        return Results.Content(Missing, "text/html; charset=utf-8", Encoding.UTF8, 404);
    }

    private static bool Readable(HttpContext http) => HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method);

    public static WebApplication MapSites(this WebApplication app)
    {
        app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });

        app.Map("/robots.txt", async (HttpContext http, SiteReader reader) =>
        {
            if (!Readable(http)) return NotFound(http);
            http.Response.Headers.CacheControl = "no-cache";
            return Results.Text(await reader.RobotsAsync(http.RequestAborted), "text/plain; charset=utf-8");
        });

        // Phase 16: a form link's pages, under a path no slug can take.
        app.MapFormPages();
        // Phase 18: the pay page, where Paddle's checkout opens.
        app.MapPayPages();

        app.Map("/{slug}", (string slug, HttpContext http, SiteReader reader) => SlugAsync(slug, null, http, reader));
        app.Map("/{slug}/{pageId:guid}", (string slug, Guid pageId, HttpContext http, SiteReader reader) => SlugAsync(slug, pageId, http, reader));

        // A file a page of the site shows, checked now: a redirect to a signed URL of a few minutes.
        app.Map("/{slug}/files/{assetId:guid}", async (string slug, Guid assetId, HttpContext http, SiteReader reader) =>
        {
            if (!Readable(http) || await reader.StateAsync(slug, http.RequestAborted) is not { } state) return NotFound(http);
            return ToDomain(state, http, $"/files/{assetId}") ?? await FileAsync(state, assetId, http);
        });

        app.MapFallback((HttpContext http) => NotFound(http));
        return app;
    }

    private static async Task<IResult> SlugAsync(string slug, Guid? pageId, HttpContext http, SiteReader reader)
    {
        if (!Readable(http)) return NotFound(http);
        if (await reader.StateAsync(slug, http.RequestAborted) is not { } state) return NotFound(http);
        return ToDomain(state, http, pageId is { } id ? $"/{id}" : "") ?? await PageAsync(state, pageId, http);
    }

    private static async Task<IResult> PageAsync(SiteState state, Guid? pageId, HttpContext http)
    {
        var ct = http.RequestAborted;
        var reader = http.RequestServices.GetRequiredService<SiteReader>();
        var cache = http.RequestServices.GetRequiredService<SiteCache>();
        var page = pageId is { } id ? state.Scope.Pages.FirstOrDefault(p => p.Id == id) : state.Scope.Root;
        if (page is null) return NotFound(http);
        var number = 1;
        if (page.Kind == PageKinds.Database && http.Request.Query["page"] is { Count: 1 } given)
            number = int.TryParse(given.ToString(), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var n) && n is >= 1 and <= 100_000 ? n : 1;
        var key = await reader.KeyAsync(state, page, number, ct);
        var rendered = cache.Page(key);
        if (rendered is null)
        {
            var html = SiteRenderer.Render(await reader.LoadAsync(state, page, number, ct));
            var body = Encoding.UTF8.GetBytes(html);
            var tag = "\"" + Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(body))[..27].Replace('+', '-').Replace('/', '_') + "\"";
            rendered = new RenderedPage(body, tag);
            cache.PutPage(key, rendered);
        }
        var headers = http.Response.Headers;
        headers.CacheControl = "no-cache";
        headers.ETag = rendered.ETag;
        if (state.Site.Indexing) http.Items[IndexedKey] = true;
        if (Matches(http.Request.Headers.IfNoneMatch, rendered.ETag)) return Results.StatusCode(304);
        return Results.Bytes(rendered.Body, "text/html; charset=utf-8");
    }

    private static bool Matches(StringValues ifNoneMatch, string tag) =>
        ifNoneMatch.SelectMany(v => (v ?? "").Split(',')).Select(v => v.Trim()).Any(v => v == tag || v == "*");
}
