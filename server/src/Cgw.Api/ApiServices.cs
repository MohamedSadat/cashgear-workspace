using System.Security.Cryptography.X509Certificates;
using Cgw.Api.Identity;
using Cgw.Api.Infrastructure;
using Cgw.Api.Modules;
using Cgw.Core;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using OpenIddict.Abstractions;
using OpenIddict.Server;
using OpenIddict.Validation.AspNetCore;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Cgw.Api;

public static class ApiServices
{
    public const string CorsPolicy = "web";
    public const string Scheme = "cgw";
    public const string DesktopClientId = "cgw-desktop";
    public const string CsrfHeader = "X-CSRF-TOKEN";

    /// <summary>The browser origins of the web app and the desktop webview (Web__Origins).</summary>
    public static string[] Origins(IConfiguration configuration) =>
        configuration.GetSection("Web:Origins").Get<string[]>()
        ?? ["http://localhost:5273", "http://localhost:4273", "http://tauri.localhost", "tauri://localhost"];

    public static IServiceCollection AddCgwApi(this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment)
    {
        var origins = Origins(configuration);
        services.AddCors(o => o.AddPolicy(CorsPolicy, p => p
            .WithOrigins(origins)
            .AllowCredentials()
            .WithHeaders("Content-Type", "Authorization", CsrfHeader, Correlation.Header, "If-Match")
            .WithExposedHeaders(Correlation.Header, "ETag", "Retry-After")
            .WithMethods("GET", "POST", "PUT", "PATCH", "DELETE")
            .SetPreflightMaxAge(TimeSpan.FromHours(1))));

        // Cookies and Identity tokens are protected with keys kept in the database, so every API
        // instance and every restart reads the same ones. On Windows hosts they are encrypted at rest
        // with DPAPI (DataProtection__Dpapi=true).
        var protection = services.AddDataProtection().SetApplicationName("cgw");
        if (!StartupTasks.GeneratingDocument) protection.PersistKeysToDbContext<CgwDb>();
        if (configuration["DataProtection:Dpapi"] == "true" && OperatingSystem.IsWindows()) protection.ProtectKeysWithDpapi(protectToLocalMachine: true);

        services.AddIdentityCore<User>(o =>
            {
                o.User.RequireUniqueEmail = true;
                o.SignIn.RequireConfirmedEmail = true;
                o.SignIn.RequireConfirmedAccount = true;
                // Length, not composition (NIST SP 800-63B).
                o.Password.RequiredLength = 10;
                o.Password.RequireDigit = false;
                o.Password.RequireLowercase = false;
                o.Password.RequireUppercase = false;
                o.Password.RequireNonAlphanumeric = false;
                o.Lockout.AllowedForNewUsers = true;
                o.Lockout.MaxFailedAccessAttempts = 5;
                o.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                o.Tokens.EmailConfirmationTokenProvider = TokenOptions.DefaultProvider;
            })
            .AddEntityFrameworkStores<CgwDb>()
            .AddSignInManager()
            .AddDefaultTokenProviders();
        services.Configure<DataProtectionTokenProviderOptions>(o => o.TokenLifespan = TimeSpan.FromHours(24));
        // A changed password or a removed account ends cookie sessions within a minute.
        services.Configure<SecurityStampValidatorOptions>(o => o.ValidationInterval = TimeSpan.FromMinutes(1));

        services.AddAuthentication(o =>
            {
                o.DefaultScheme = Scheme;
                o.DefaultChallengeScheme = Scheme;
                o.DefaultForbidScheme = Scheme;
            })
            // A request with a bearer token is the desktop app; anything else is the web cookie.
            .AddPolicyScheme(Scheme, "Cookie or bearer", o => o.ForwardDefaultSelector = context =>
                context.Request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.Ordinal)
                    ? OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme
                    : IdentityConstants.ApplicationScheme)
            .AddIdentityCookies();
        services.ConfigureApplicationCookie(o =>
        {
            o.Cookie.Name = "cgw_session";
            o.Cookie.HttpOnly = true;
            o.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            o.Cookie.SameSite = SameSiteMode.Lax;
            o.ExpireTimeSpan = TimeSpan.FromDays(14);
            o.SlidingExpiration = true;
            o.LoginPath = "/account/signin";
            o.Events = new CookieAuthenticationEvents
            {
                OnRedirectToLogin = context => Unauthorised(context, 401),
                OnRedirectToAccessDenied = context => Unauthorised(context, 403),
                OnValidatePrincipal = async context =>
                {
                    await SecurityStampValidator.ValidatePrincipalAsync(context);
                    if (context.Principal is null) return;
                    var gate = context.HttpContext.RequestServices.GetRequiredService<DeviceGate>();
                    if (!await gate.IsActiveAsync(context.Principal.DeviceId()))
                    {
                        context.RejectPrincipal();
                        await context.HttpContext.SignOutAsync(IdentityConstants.ApplicationScheme);
                    }
                },
            };
        });
        services.AddAntiforgery(o =>
        {
            o.HeaderName = CsrfHeader;
            o.Cookie.Name = "cgw_xsrf";
            o.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            o.Cookie.SameSite = SameSiteMode.Lax;
        });
        services.AddAuthorization();
        services.AddMemoryCache();

        services.AddOpenIddict()
            .AddCore(o =>
            {
                o.UseEntityFrameworkCore().UseDbContext<CgwDb>().ReplaceDefaultEntities<Guid>();
                // Loopback redirects (RFC 8252 7.3): any port, as the desktop picks a free one.
                o.ReplaceApplicationManager<OpenIddict.EntityFrameworkCore.Models.OpenIddictEntityFrameworkCoreApplication<Guid>, LoopbackApplicationManager>();
            })
            .AddServer(o =>
            {
                o.SetAuthorizationEndpointUris("connect/authorize")
                    .SetTokenEndpointUris("connect/token")
                    .SetEndSessionEndpointUris("connect/logout")
                    .SetRevocationEndpointUris("connect/revoke");
                o.AllowAuthorizationCodeFlow().RequireProofKeyForCodeExchange().AllowRefreshTokenFlow();
                o.RegisterScopes(Scopes.OfflineAccess, "workspace");
                o.SetAccessTokenLifetime(TimeSpan.FromMinutes(15));
                // The longest offline window (DECISIONS.md, defaults): the device must sign in again after it.
                o.SetRefreshTokenLifetime(TimeSpan.FromDays(30));
                var aspnet = o.UseAspNetCore()
                    .EnableAuthorizationEndpointPassthrough()
                    .EnableTokenEndpointPassthrough()
                    .EnableEndSessionEndpointPassthrough();
                if (!environment.IsProduction())
                {
                    aspnet.DisableTransportSecurityRequirement();
                    o.AddEphemeralEncryptionKey().AddEphemeralSigningKey();
                }
                else
                {
                    // The certificates live in the host's certificate store, never in a file or the repo.
                    o.Services.AddSingleton<Microsoft.Extensions.Options.IConfigureOptions<OpenIddictServerOptions>>(
                        new ProductionKeys(configuration));
                }
            })
            .AddValidation(o =>
            {
                o.UseLocalServer();
                o.UseAspNetCore();
                // A revoked device's tokens stop at once, not when they expire.
                o.EnableAuthorizationEntryValidation();
                o.EnableTokenEntryValidation();
            });

        services.AddScoped<DeviceGate>();
        services.AddScoped<Devices>();
        services.AddScoped<AccountService>();
        services.AddHostedService<StartupTasks>();
        services.AddCgwModules(configuration);
        return services;
    }

    /// <summary>API calls get a 401 or 403 problem; a browser page is sent to sign in.</summary>
    private static Task Unauthorised(Microsoft.AspNetCore.Authentication.RedirectContext<CookieAuthenticationOptions> context, int status)
    {
        if (context.Request.Path.StartsWithSegments("/api"))
        {
            context.Response.StatusCode = status;
            return Task.CompletedTask;
        }
        context.Response.Redirect(context.RedirectUri);
        return Task.CompletedTask;
    }

    public static IApplicationBuilder UseCgwSecurityHeaders(this IApplicationBuilder app) =>
        app.Use(async (context, next) =>
        {
            var headers = context.Response.Headers;
            headers.XContentTypeOptions = "nosniff";
            headers["Referrer-Policy"] = "no-referrer";
            headers.XFrameOptions = "DENY";
            if (context.Request.Path.StartsWithSegments("/api")) headers.CacheControl = "no-store";
            await next();
        });

    public static WebApplication MapCgwApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/v1").AddEndpointFilter<CsrfFilter>();
        api.MapGet("/version", () => TypedResults.Ok(new VersionInfo(typeof(ApiServices).Assembly.GetName().Version?.ToString(3) ?? "0.0.0", "v1")))
            .WithName("getVersion").AllowAnonymous().RequireRateLimiting(RateLimits.Anonymous);
        api.MapAccount();
        app.MapAccountPages();
        app.MapConnect();
        api.MapCgwModules();
        return app;
    }
}

public sealed record VersionInfo(string Version, string Api);

/// <summary>
/// Writes from a cookie session need the antiforgery header (D16); bearer requests (the desktop)
/// and anonymous ones do not carry a session to forge.
/// </summary>
public sealed class CsrfFilter(IAntiforgery antiforgery) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var method = http.Request.Method;
        var safe = HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method);
        var bearer = http.Request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.Ordinal);
        if (!safe && !bearer && http.Request.Cookies.ContainsKey("cgw_session"))
        {
            if (!await antiforgery.IsRequestValidAsync(http))
                return Problems.Of(Codes.RequestInvalid, 400, "The antiforgery token is missing or wrong");
        }
        return await next(context);
    }
}

/// <summary>Signing and encryption certificates from the store, by thumbprint (OpenIddict__*).</summary>
internal sealed class ProductionKeys(IConfiguration configuration) : Microsoft.Extensions.Options.IConfigureOptions<OpenIddictServerOptions>
{
    public void Configure(OpenIddictServerOptions options)
    {
        X509Certificate2 Load(string name)
        {
            var thumbprint = configuration[$"OpenIddict:{name}CertificateThumbprint"]
                ?? throw new InvalidOperationException($"Set OpenIddict__{name}CertificateThumbprint to a certificate in LocalMachine\\My.");
            using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
            store.Open(OpenFlags.ReadOnly);
            return store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false).FirstOrDefault()
                ?? throw new InvalidOperationException($"No certificate {thumbprint} in LocalMachine\\My.");
        }
        options.SigningCredentials.Add(new Microsoft.IdentityModel.Tokens.SigningCredentials(
            new Microsoft.IdentityModel.Tokens.X509SecurityKey(Load("Signing")), Microsoft.IdentityModel.Tokens.SecurityAlgorithms.RsaSha256));
        options.EncryptionCredentials.Add(new Microsoft.IdentityModel.Tokens.EncryptingCredentials(
            new Microsoft.IdentityModel.Tokens.X509SecurityKey(Load("Encryption")),
            Microsoft.IdentityModel.Tokens.SecurityAlgorithms.RsaOAEP,
            Microsoft.IdentityModel.Tokens.SecurityAlgorithms.Aes256CbcHmacSha512));
    }
}

/// <summary>
/// Work at start: the blob container, CORS on blob storage outside production, and the desktop
/// client's registration. Not run when the OpenAPI document is generated at build.
/// </summary>
internal sealed class StartupTasks(IServiceProvider services, IConfiguration configuration, IHostEnvironment environment, ILogger<StartupTasks> logger) : IHostedService
{
    /// <summary>The build's OpenAPI step starts the host with no database or storage to reach.</summary>
    public static bool GeneratingDocument =>
        System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";

    public async Task StartAsync(CancellationToken ct)
    {
        if (GeneratingDocument) return;
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        if (configuration["Database:MigrateOnStart"] == "true")
        {
            logger.LogWarning("Applying migrations at start (development only)");
            await Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.MigrateAsync(db.Database, ct);
        }
        var blob = scope.ServiceProvider.GetRequiredService<BlobStore>();
        await blob.EnsureContainerAsync(ct);
        if (!environment.IsProduction()) await blob.AllowOriginsAsync(ApiServices.Origins(configuration), ct);

        var applications = scope.ServiceProvider.GetRequiredService<IOpenIddictApplicationManager>();
        var descriptor = new OpenIddictApplicationDescriptor
        {
            ClientId = ApiServices.DesktopClientId,
            ClientType = ClientTypes.Public,
            ConsentType = ConsentTypes.Implicit,
            DisplayName = "Cash Gear Workspace (desktop)",
            RedirectUris = { new Uri(LoopbackApplicationManager.Registered) },
            PostLogoutRedirectUris = { new Uri(LoopbackApplicationManager.Registered) },
            Permissions =
            {
                Permissions.Endpoints.Authorization,
                Permissions.Endpoints.Token,
                Permissions.Endpoints.EndSession,
                Permissions.Endpoints.Revocation,
                Permissions.GrantTypes.AuthorizationCode,
                Permissions.GrantTypes.RefreshToken,
                Permissions.ResponseTypes.Code,
                Permissions.Prefixes.Scope + Scopes.OfflineAccess,
                Permissions.Prefixes.Scope + "workspace",
            },
            Requirements = { Requirements.Features.ProofKeyForCodeExchange },
        };
        var existing = await applications.FindByClientIdAsync(ApiServices.DesktopClientId, ct);
        if (existing is null) await applications.CreateAsync(descriptor, ct);
        else await applications.UpdateAsync(existing, descriptor, ct);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
