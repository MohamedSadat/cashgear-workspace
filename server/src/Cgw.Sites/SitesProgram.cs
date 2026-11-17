using System.Text;
using Cgw.Core;
using Cgw.Core.Assets;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Documents;
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
/// <c>/robots.txt</c>, <c>/health/live</c>; anything else is the 404 page.
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
                headers.ContentSecurityPolicy = csp;
                headers.XContentTypeOptions = "nosniff";
                headers["Referrer-Policy"] = "no-referrer";
                headers["Cross-Origin-Opener-Policy"] = "same-origin";
                headers["Cross-Origin-Resource-Policy"] = "same-origin";
                headers["Permissions-Policy"] = PermissionsPolicy;
                if (hsts && context.Request.IsHttps) headers.StrictTransportSecurity = "max-age=31536000";
                if (context.Items[IndexedKey] is not true) headers["X-Robots-Tag"] = "noindex";
                return Task.CompletedTask;
            });
            await next();
        });
    }

    private static readonly string Missing = SiteRenderer.NotFound();

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

        app.Map("/{slug}", (string slug, HttpContext http, SiteReader reader, SiteCache cache) => PageAsync(slug, null, http, reader, cache));
        app.Map("/{slug}/{pageId:guid}", (string slug, Guid pageId, HttpContext http, SiteReader reader, SiteCache cache) => PageAsync(slug, pageId, http, reader, cache));

        // A file a page of the site shows, checked now: a redirect to a signed URL of a few minutes.
        app.Map("/{slug}/files/{assetId:guid}", async (string slug, Guid assetId, HttpContext http, SiteReader reader) =>
        {
            if (!Readable(http) || await reader.StateAsync(slug, http.RequestAborted) is not { } state) return NotFound(http);
            if (await reader.FileAsync(state, assetId, http.RequestAborted) is not { } url) return NotFound(http);
            http.Response.Headers.CacheControl = "no-store";
            if (state.Site.Indexing) http.Items[IndexedKey] = true;
            return Results.Redirect(url.Url, permanent: false);
        });

        app.MapFallback((HttpContext http) => NotFound(http));
        return app;
    }

    private static async Task<IResult> PageAsync(string slug, Guid? pageId, HttpContext http, SiteReader reader, SiteCache cache)
    {
        if (!Readable(http)) return NotFound(http);
        var ct = http.RequestAborted;
        if (await reader.StateAsync(slug, ct) is not { } state) return NotFound(http);
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
