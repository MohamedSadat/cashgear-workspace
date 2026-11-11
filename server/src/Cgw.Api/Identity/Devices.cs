using Cgw.Core;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using OpenIddict.Abstractions;
using OpenIddict.Core;
using OpenIddict.EntityFrameworkCore.Models;

namespace Cgw.Api.Identity;

/// <summary>Whether a session's device is still signed in; checked on every cookie request.</summary>
public sealed class DeviceGate(CgwDb db, IMemoryCache cache)
{
    private static readonly TimeSpan Fresh = TimeSpan.FromSeconds(15);

    public async Task<bool> IsActiveAsync(Guid? deviceId)
    {
        if (deviceId is not { } id) return false;
        return await cache.GetOrCreateAsync(("device", id), async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = Fresh;
            return await db.Devices.AsNoTracking().AnyAsync(d => d.Id == id && d.RevokedAt == null);
        });
    }

    public void Forget(Guid deviceId) => cache.Remove(("device", deviceId));
}

/// <summary>A desktop install or browser profile (DATA_MODEL.md, Devices); signing one out ends its session.</summary>
public sealed class Devices(CgwDb db, DeviceGate gate, IOpenIddictAuthorizationManager authorizations, Audit audit, TimeProvider clock)
{
    public async Task<Device> CreateAsync(Guid userId, string platform, string name)
    {
        var now = clock.GetUtcNow();
        var device = new Device
        {
            Id = Guid.CreateVersion7(),
            UserId = userId,
            Platform = platform,
            Name = Trim(name),
            CreatedAt = now,
            LastSeenAt = now,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device;
    }

    /// <summary>A short name from a browser's user agent, without the version noise.</summary>
    public static string NameFromUserAgent(string? agent)
    {
        agent ??= "";
        var browser = agent.Contains("Edg/") ? "Edge" : agent.Contains("Chrome/") ? "Chrome" : agent.Contains("Firefox/") ? "Firefox" : agent.Contains("Safari/") ? "Safari" : "Browser";
        var system = agent.Contains("Windows") ? "Windows" : agent.Contains("Mac OS") ? "macOS" : agent.Contains("Android") ? "Android" : agent.Contains("iPhone") || agent.Contains("iPad") ? "iOS" : agent.Contains("Linux") ? "Linux" : "";
        return system.Length > 0 ? $"{browser} on {system}" : browser;
    }

    private static string Trim(string name)
    {
        var clean = new string(name.Where(c => !char.IsControl(c)).ToArray()).Trim();
        return clean.Length == 0 ? "Device" : clean.Length > 100 ? clean[..100] : clean;
    }

    /// <summary>Last seen, written at most every few minutes.</summary>
    public async Task TouchAsync(Guid deviceId)
    {
        var now = clock.GetUtcNow();
        await db.Devices.Where(d => d.Id == deviceId && d.LastSeenAt < now.AddMinutes(-5))
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.LastSeenAt, now));
    }

    public async Task<bool> RevokeAsync(Guid userId, Guid deviceId, Actor actor)
    {
        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId && d.UserId == userId);
        if (device is null) return false;
        if (device.RevokedAt is null)
        {
            device.RevokedAt = clock.GetUtcNow();
            if (device.AuthorizationId is { } authorizationId
                && await authorizations.FindByIdAsync(authorizationId.ToString()) is { } authorization)
                await authorizations.TryRevokeAsync(authorization);
            audit.Add(actor, "device.revoke", targetType: "device", targetId: deviceId);
            await db.SaveChangesAsync();
        }
        gate.Forget(deviceId);
        return true;
    }

    public async Task RevokeAllAsync(Guid userId, Actor actor)
    {
        var ids = await db.Devices.Where(d => d.UserId == userId && d.RevokedAt == null).Select(d => d.Id).ToListAsync();
        foreach (var id in ids) await RevokeAsync(userId, id, actor);
    }
}

/// <summary>
/// Loopback redirect URIs for the desktop (RFC 8252, 7.3): the app listens on a free port it
/// picks, so the port is not part of the match. Everything else about the URI must be equal.
/// </summary>
public sealed class LoopbackApplicationManager(
    IOpenIddictApplicationCache<OpenIddictEntityFrameworkCoreApplication<Guid>> cache,
    Microsoft.Extensions.Logging.ILogger<OpenIddictApplicationManager<OpenIddictEntityFrameworkCoreApplication<Guid>>> logger,
    Microsoft.Extensions.Options.IOptionsMonitor<OpenIddictCoreOptions> options,
    IOpenIddictApplicationStore<OpenIddictEntityFrameworkCoreApplication<Guid>> store)
    : OpenIddictApplicationManager<OpenIddictEntityFrameworkCoreApplication<Guid>>(cache, logger, options, store)
{
    public const string Registered = "http://127.0.0.1/callback";

    public override async ValueTask<bool> ValidateRedirectUriAsync(
        OpenIddictEntityFrameworkCoreApplication<Guid> application, [System.Diagnostics.CodeAnalysis.StringSyntax("Uri")] string uri, CancellationToken cancellationToken = default) =>
        await base.ValidateRedirectUriAsync(application, Normalise(uri), cancellationToken);

    public override async ValueTask<bool> ValidatePostLogoutRedirectUriAsync(
        OpenIddictEntityFrameworkCoreApplication<Guid> application, [System.Diagnostics.CodeAnalysis.StringSyntax("Uri")] string uri, CancellationToken cancellationToken = default) =>
        await base.ValidatePostLogoutRedirectUriAsync(application, Normalise(uri), cancellationToken);

    /// <summary><c>http://127.0.0.1:PORT/path</c> compares as <c>http://127.0.0.1/path</c>.</summary>
    public static string Normalise(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return uri;
        if (parsed.Scheme != Uri.UriSchemeHttp || parsed.Host is not ("127.0.0.1" or "[::1]") || !string.IsNullOrEmpty(parsed.Query) || !string.IsNullOrEmpty(parsed.Fragment)) return uri;
        return $"http://{parsed.Host}{parsed.AbsolutePath}";
    }
}
