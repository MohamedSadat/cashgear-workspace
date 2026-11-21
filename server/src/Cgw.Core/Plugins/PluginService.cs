using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Cgw.Core.Workbooks;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Plugins;

/// <summary>A workspace's plugin as the routes answer it (the streams contract's <c>WorkspacePlugin</c>).</summary>
public sealed record WorkspacePluginDto(
    Guid Id,
    string Type,
    int Version,
    PluginText Name,
    PluginText? Description,
    PluginReads Reads,
    int Height,
    IReadOnlyList<string> Keywords,
    bool Enabled,
    long SizeBytes,
    UserRefDto AddedBy,
    DateTimeOffset AddedAt,
    DateTimeOffset UpdatedAt,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] PluginNetworkDto? Network = null);

/// <summary>
/// Phase 13: the hosts a plugin's manifest names, and those an owner or admin approved (the ones it
/// reaches); a host named and not approved waits. Null when the manifest names none.
/// </summary>
public sealed record PluginNetworkDto(IReadOnlyList<string> Hosts, IReadOnlyList<string> Approved);

public sealed record WorkspacePluginsDto(IReadOnlyList<WorkspacePluginDto> Plugins);

/// <summary>
/// <c>PATCH /workspaces/{id}/plugins/{pluginId}</c>: turn it on or off; Phase 13, set the hosts of
/// its manifest it may reach (<c>approvedHosts</c>, each one its manifest names).
/// </summary>
public sealed record PluginPatch
{
    public bool? Enabled { get; init; }
    public IReadOnlyList<string>? ApprovedHosts { get; init; }
}

/// <summary>A frame's address on the plugins origin, and when its ticket ends.</summary>
public sealed record PluginFrameDto(string Url, DateTimeOffset ExpiresAt);

/// <summary>
/// Where plugins are served (Phase 10): <c>Plugins__PublicUrl</c>, the Sites process's second host
/// (<c>https://plugins.cashgearerp.com</c> in production; <c>http://localhost:5291</c> on a
/// developer's machine and in e2e). The API builds a frame's address from it, never from a request.
/// <see cref="FrameAncestors"/> are the Workspace origins that may frame a plugin (<c>Web__Origins</c>).
/// </summary>
public sealed record PluginsOptions(string PublicUrl, IReadOnlyList<string> FrameAncestors, bool Production = false, IReadOnlyList<string>? OwnHosts = null)
{
    public const string PublicUrlKey = "Plugins:PublicUrl";
    public const string DevPublicUrl = "http://localhost:5291";

    /// <summary>The web app's and the desktop's origins on a developer's machine (the API's own default).</summary>
    public static readonly string[] DevOrigins =
        ["http://127.0.0.1:5273", "http://127.0.0.1:4273", "http://localhost:5273", "http://localhost:4273", "http://tauri.localhost", "tauri://localhost"];

    public static PluginsOptions From(IConfiguration configuration, bool production)
    {
        var value = configuration[PublicUrlKey];
        var origin = Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? uri.GetLeftPart(UriPartial.Authority).TrimEnd('/')
            : null;
        var origins = (configuration.GetSection("Web:Origins").Get<string[]>() ?? (production ? [] : DevOrigins))
            .Where(o => Uri.TryCreate(o, UriKind.Absolute, out var u) && u.Authority.Length > 0 && o.All(c => c is > ' ' and < '\u007f' and not ';' and not ','))
            .Select(o => o.TrimEnd('/'))
            .Distinct(StringComparer.Ordinal).ToArray();
        var publicUrl = origin ?? (production ? "" : DevPublicUrl);
        // Phase 13: this server's own hosts, which no plugin may name as its network.
        var own = origins.Append(publicUrl).Append(configuration["Api:PublicUrl"] ?? "").Append(configuration["Sites:PublicUrl"] ?? "")
            .Select(o => Uri.TryCreate(o, UriKind.Absolute, out var u) ? u.Authority : null).OfType<string>()
            .Where(h => h.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        return new PluginsOptions(publicUrl, origins, production, own);
    }

    /// <summary>The plugins host as a request names it (<c>Host</c>), or null when there is none.</summary>
    public string? Host => Uri.TryCreate(PublicUrl, UriKind.Absolute, out var uri) ? uri.Authority : null;

    public string FrameUrl(string ticket, string entry) =>
        $"{PublicUrl}/f/{ticket}/{string.Join('/', entry.Split('/').Select(Uri.EscapeDataString))}";
}

/// <summary>What a frame ticket names: the workspace, the plugin and the bundle it was made for.</summary>
public sealed record PluginTicket(Guid WorkspaceId, Guid PluginId, string BundleHash)
{
    public DateTimeOffset ExpiresAt { get; init; }

    /// <summary>When the API made it (its expiry less its lifetime).</summary>
    public DateTimeOffset MadeAt => ExpiresAt - PluginTickets.Lifetime;
}

/// <summary>
/// Frame tickets (Phase 10; decided 2026-11-18): stored hashed, as the hub's are
/// (<see cref="RealtimeTicket"/>). A ticket is 32 random bytes, base64url in the frame's address,
/// kept only as their SHA-256 in <see cref="PluginFrameTicket"/> with the workspace, the plugin and
/// the bundle it was made for, for 10 minutes; not one use (the bundle's own files are fetched under
/// it). The API makes them for a member; the Sites process finds them by their hash. No key of any
/// kind is needed to make or check one, so the Sites process holds none.
/// </summary>
public static class PluginTickets
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);
    public const int TokenBytes = 32;

    /// <summary>A new ticket for the plugin's current bundle: its token (for the address) and its row (for the table).</summary>
    public static (string Token, PluginFrameTicket Row) New(Guid workspaceId, Guid pluginId, string bundleHash, Guid createdBy, DateTimeOffset now)
    {
        var bytes = RandomNumberGenerator.GetBytes(TokenBytes);
        return (WebEncoders.Base64UrlEncode(bytes), new PluginFrameTicket
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = workspaceId,
            PluginId = pluginId,
            BundleHash = bundleHash,
            TokenHash = SHA256.HashData(bytes),
            ExpiresAt = now + Lifetime,
            CreatedBy = createdBy,
            CreatedAt = now,
        });
    }

    /// <summary>The hash a token is kept as; null for anything that is not 32 bytes in base64url.</summary>
    public static byte[]? HashOf(string? token)
    {
        if (token is not { Length: 43 } || !token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return null;
        try
        {
            var bytes = WebEncoders.Base64UrlDecode(token);
            return bytes.Length == TokenBytes ? SHA256.HashData(bytes) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>What a token names while it lasts, across workspaces (the ticket says which); null when unknown or expired.</summary>
    public static async Task<PluginTicket?> FindAsync(CgwDb db, string? token, DateTimeOffset now, CancellationToken ct)
    {
        if (HashOf(token) is not { } hash) return null;
        var row = await db.PluginFrameTickets.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(t => t.TokenHash == hash && t.ExpiresAt > now)
            .Select(t => new { t.WorkspaceId, t.PluginId, t.BundleHash, t.ExpiresAt }).FirstOrDefaultAsync(ct);
        return row is null ? null : new PluginTicket(row.WorkspaceId, row.PluginId, row.BundleHash) { ExpiresAt = row.ExpiresAt };
    }
}

/// <summary>
/// A workspace's third-party plugins (Phase 10, M10.5; decisions, 2026-11-18): owners and admins add
/// a bundle, update it (same or higher version), turn it on or off and remove it, each audited
/// (<c>plugin.add</c>, <c>plugin.update</c>, <c>plugin.enable</c>, <c>plugin.disable</c>,
/// <c>plugin.remove</c>, with type, version and bundle hash); any member, guests too, reads the list
/// and asks for a frame of a plugin that is live and on. A bundle's files are private blobs under
/// its own prefix, written before the row names them. Every write takes the workspace's lock and,
/// from Phase 13, writes a <c>plugin</c> change in the feed in the same transaction (<c>upsert</c>
/// for an add, an update or a switch, <c>delete</c> for a removal), so an open tab reads the list
/// again without a reload; builds before 0.13.0 ignore the type.
/// </summary>
public sealed class PluginService(CgwDb db, BlobStore blob, ChangeLog changes, Audit audit, PluginsOptions options, TimeProvider clock)
{
    public static string Prefix(Guid workspaceId, Guid pluginId, string bundleHash) => $"{BlobStore.WorkspacePrefix(workspaceId)}plugins/{pluginId}/{bundleHash}/";

    /// <summary>Everything a plugin holds in storage, every bundle of it.</summary>
    public static string PluginPrefix(Guid workspaceId, Guid pluginId) => $"{BlobStore.WorkspacePrefix(workspaceId)}plugins/{pluginId}/";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The feed's type for a plugin's change (Phase 13): an event, no entity; the tab reads the list again.</summary>
    public const string ChangeType = "plugin";

    public static PluginManifest ManifestOf(WorkspacePlugin row) => JsonSerializer.Deserialize<PluginManifest>(row.Manifest, Json)!;

    public static IReadOnlyList<PluginFile> FilesOf(WorkspacePlugin row) => JsonSerializer.Deserialize<List<PluginFile>>(row.Files, Json) ?? [];

    /// <summary>The hosts approved for the plugin (Phase 13), as stored.</summary>
    public static IReadOnlyList<string> ApprovedOf(WorkspacePlugin row) => JsonSerializer.Deserialize<List<string>>(row.ApprovedHosts, Json) ?? [];

    /// <summary>The hosts the plugin reaches: approved ones its manifest names (never loopback in Production).</summary>
    public static IReadOnlyList<string> ReachedOf(WorkspacePlugin row, bool production) =>
        PluginHosts.Reached(ManifestOf(row).Network, ApprovedOf(row).ToHashSet(StringComparer.Ordinal), production);

    private static PluginNetworkDto? NetworkOf(PluginManifest manifest, WorkspacePlugin row) =>
        manifest.Network is { } network ? new PluginNetworkDto(network.Hosts, network.Hosts.Where(ApprovedOf(row).Contains).ToList()) : null;

    private async Task<List<WorkspacePluginDto>> DtosAsync(IReadOnlyList<WorkspacePlugin> rows, CancellationToken ct)
    {
        var people = await People.RefsAsync(db, rows.Select(r => r.AddedBy), ct);
        return rows.Select(r =>
        {
            var manifest = ManifestOf(r);
            var by = People.Of(people, r.AddedBy);
            return new WorkspacePluginDto(r.Id, r.Type, r.Version, manifest.Name, manifest.Description, manifest.Reads, manifest.Height, manifest.Keywords,
                r.Enabled, r.SizeBytes, new UserRefDto(by.Id, by.Name), r.AddedAt, r.UpdatedAt, NetworkOf(manifest, r));
        }).ToList();
    }

    public async Task<WorkspacePluginsDto> ListAsync(CancellationToken ct = default)
    {
        var rows = await db.WorkspacePlugins.AsNoTracking().Where(p => p.RemovedAt == null).OrderBy(p => p.Type).ToListAsync(ct);
        return new WorkspacePluginsDto(await DtosAsync(rows, ct));
    }

    public static Failure Invalid(IEnumerable<PluginProblem> problems) =>
        new(Codes.PluginInvalid, 400, "The plugin's bundle was refused")
        {
            Extensions = new Dictionary<string, object?>
            {
                ["errors"] = problems.Select(p => p.Path is null ? (object)new { code = p.Code } : new { code = p.Code, path = p.Path }).ToList(),
            },
        };

    /// <summary>
    /// A bundle added: a new type is made (<c>created</c>), a type already there gets the new bundle
    /// at the same or a higher version (<c>plugin.older</c> below it). Its files are written first;
    /// the bundle it replaced is unreachable at once (a frame ticket names its bundle) and its files go.
    /// Phase 13: the hosts its manifest names are approved by <paramref name="approve"/> (those the
    /// person adding it was shown and allowed); an update keeps the hosts already approved, so a host it
    /// adds waits until approved (here or by <see cref="PatchAsync"/>). A host of this server's own is
    /// <c>host.reserved</c>; a loopback host in Production is <c>manifest.invalid</c>.
    /// </summary>
    public async Task<Result<(WorkspacePluginDto Plugin, bool Created)>> AddAsync(Member member, Actor actor, byte[] zip, IReadOnlyCollection<string>? approve = null, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin adds a plugin");
        var (bundle, problems) = PluginBundle.Read(zip);
        if (bundle is null) return Invalid(problems);
        var manifest = bundle.Manifest;
        if (manifest.Network is { } asked)
        {
            if (asked.Hosts.Any(h => PluginHosts.Reserved(h, options.OwnHosts))) return Invalid([new(PluginBundle.HostReserved, PluginBundle.ManifestPath)]);
            if (options.Production && asked.Hosts.Any(PluginHosts.Loopback)) return Invalid([new(PluginBundle.ManifestInvalid, PluginBundle.ManifestPath)]);
        }
        var existing = await db.WorkspacePlugins.AsNoTracking().FirstOrDefaultAsync(p => p.Type == manifest.Type && p.RemovedAt == null, ct);
        if (existing is not null && existing.Version > manifest.Version) return Older(existing);
        var id = existing?.Id ?? Guid.CreateVersion7();
        var prefix = Prefix(member.WorkspaceId, id, bundle.Hash);
        foreach (var (file, bytes) in bundle.Files) await blob.PutAsync(prefix + file.Path, bytes, file.ContentType, ct);

        var now = clock.GetUtcNow();
        string? replaced = null;
        WorkspacePlugin row;
        try
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(member.WorkspaceId, ct);
            var current = await db.WorkspacePlugins.FirstOrDefaultAsync(p => p.Type == manifest.Type && p.RemovedAt == null, ct);
            if (current is not null && current.Id != id)
            {
                // Another add of the type won meanwhile: its row stands, these files go.
                await DeleteBlobsAsync(prefix, ct);
                return Failure.Conflict(Codes.Conflict, "The plugin was added meanwhile");
            }
            if (current is not null && current.Version > manifest.Version)
            {
                if (current.BlobPrefix != prefix) await DeleteBlobsAsync(prefix, ct);
                return Older(current);
            }
            var manifestJson = JsonSerializer.Serialize(manifest, Json);
            var filesJson = JsonSerializer.Serialize(bundle.Files.Select(f => f.File).ToList(), Json);
            // The hosts approved: those already approved (an update) and those approved now, of the ones it names.
            var named = manifest.Network?.Hosts ?? [];
            var before = current is null ? [] : ApprovedOf(current);
            var approved = named.Where(h => before.Contains(h) || (approve?.Contains(h) ?? false)).ToList();
            var network = manifest.Network is null ? null : new { hosts = named, approved };
            if (current is null)
            {
                row = new WorkspacePlugin
                {
                    Id = id,
                    WorkspaceId = member.WorkspaceId,
                    Type = manifest.Type,
                    Version = manifest.Version,
                    Manifest = manifestJson,
                    Files = filesJson,
                    BundleHash = bundle.Hash,
                    BlobPrefix = prefix,
                    SizeBytes = bundle.Size,
                    Enabled = true,
                    AddedBy = member.UserId,
                    AddedAt = now,
                    UpdatedBy = member.UserId,
                    UpdatedAt = now,
                    ApprovedHosts = JsonSerializer.Serialize(approved, Json),
                    HostsApprovedAt = approved.Count > 0 ? now : null,
                    HostsApprovedBy = approved.Count > 0 ? member.UserId : null,
                };
                db.WorkspacePlugins.Add(row);
                audit.Add(actor, "plugin.add", member.WorkspaceId, "plugin", id, new { type = manifest.Type, version = manifest.Version, bundleHash = bundle.Hash, network });
            }
            else
            {
                row = current;
                if (row.BlobPrefix != prefix) replaced = row.BlobPrefix;
                audit.Add(actor, "plugin.update", member.WorkspaceId, "plugin", id, new
                {
                    type = manifest.Type,
                    version = manifest.Version,
                    bundleHash = bundle.Hash,
                    from = new { version = row.Version, bundleHash = row.BundleHash },
                    network,
                });
                if (!approved.SequenceEqual(before))
                {
                    row.ApprovedHosts = JsonSerializer.Serialize(approved, Json);
                    if (approved.Except(before).Any())
                    {
                        row.HostsApprovedAt = now;
                        row.HostsApprovedBy = member.UserId;
                    }
                }
                row.Version = manifest.Version;
                row.Manifest = manifestJson;
                row.Files = filesJson;
                row.BundleHash = bundle.Hash;
                row.BlobPrefix = prefix;
                row.SizeBytes = bundle.Size;
                row.UpdatedBy = member.UserId;
                row.UpdatedAt = now;
            }
            changes.Add(ChangeType, id, "upsert", 1, member.UserId);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is SqlException { Number: 2601 or 2627 })
        {
            await DeleteBlobsAsync(prefix, ct);
            return Failure.Conflict(Codes.Conflict, "The plugin was added meanwhile");
        }
        if (replaced is not null) await DeleteBlobsAsync(replaced, CancellationToken.None);
        return ((await DtosAsync([row], ct))[0], existing is null);
    }

    private static Failure Older(WorkspacePlugin current) =>
        new(Codes.PluginOlder, 400, $"The workspace has version {current.Version} of this plugin: a bundle replaces it at the same or a higher version");

    private async Task DeleteBlobsAsync(string prefix, CancellationToken ct)
    {
        await foreach (var (name, _) in blob.ListAsync(prefix, ct)) await blob.DeleteAsync(name, ct);
    }

    /// <summary>
    /// Turns a live plugin on or off (<c>plugin.enable</c>, <c>plugin.disable</c>); Phase 13, sets the
    /// hosts it may reach, each one its manifest names (<c>plugin.network</c>).
    /// </summary>
    public async Task<Result<WorkspacePluginDto>> PatchAsync(Member member, Actor actor, Guid pluginId, PluginPatch? patch, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin turns a plugin on or off");
        if (patch is null || (patch.Enabled is null && patch.ApprovedHosts is null)) return Failure.Invalid("Send enabled or approvedHosts");
        if (patch.ApprovedHosts is { } hosts && (hosts.Count > PluginHosts.MaxHosts || hosts.Any(h => h is null) || hosts.Distinct(StringComparer.Ordinal).Count() != hosts.Count))
            return Failure.Invalid("approvedHosts is at most 10 distinct hosts its manifest names");
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var row = await db.WorkspacePlugins.FirstOrDefaultAsync(p => p.Id == pluginId && p.RemovedAt == null, ct);
        if (row is null) return Failure.NotFound("No such plugin");
        var changed = false;
        var now = clock.GetUtcNow();
        if (patch.ApprovedHosts is { } approve)
        {
            var named = ManifestOf(row).Network?.Hosts ?? [];
            if (approve.Any(h => !named.Contains(h))) return Failure.Invalid("approvedHosts names only hosts its manifest names");
            // In the manifest's order, so the same approval reads the same.
            var approved = named.Where(approve.Contains).ToList();
            var was = ApprovedOf(row);
            if (!approved.SequenceEqual(was))
            {
                row.ApprovedHosts = JsonSerializer.Serialize(approved, Json);
                if (approved.Except(was).Any())
                {
                    row.HostsApprovedAt = now;
                    row.HostsApprovedBy = member.UserId;
                }
                audit.Add(actor, "plugin.network", member.WorkspaceId, "plugin", row.Id, new { type = row.Type, version = row.Version, bundleHash = row.BundleHash, approved, was });
                changed = true;
            }
        }
        if (patch.Enabled is { } enabled && row.Enabled != enabled)
        {
            row.Enabled = enabled;
            audit.Add(actor, enabled ? "plugin.enable" : "plugin.disable", member.WorkspaceId, "plugin", row.Id, new { type = row.Type, version = row.Version, bundleHash = row.BundleHash });
            changed = true;
        }
        if (changed)
        {
            row.UpdatedBy = member.UserId;
            row.UpdatedAt = now;
            changes.Add(ChangeType, row.Id, "upsert", 1, member.UserId);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
        }
        await tx.CommitAsync(ct);
        return (await DtosAsync([row], ct))[0];
    }

    /// <summary>Removes a live plugin (<c>plugin.remove</c>): its row stays for the audit; the worker deletes its files a day later.</summary>
    public async Task<Result<bool>> RemoveAsync(Member member, Actor actor, Guid pluginId, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin removes a plugin");
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var row = await db.WorkspacePlugins.FirstOrDefaultAsync(p => p.Id == pluginId && p.RemovedAt == null, ct);
        if (row is null) return Failure.NotFound("No such plugin");
        row.RemovedAt = clock.GetUtcNow();
        row.RemovedBy = member.UserId;
        audit.Add(actor, "plugin.remove", member.WorkspaceId, "plugin", row.Id, new { type = row.Type, version = row.Version, bundleHash = row.BundleHash });
        changes.Add(ChangeType, row.Id, "delete", 1, member.UserId);
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }

    /// <summary>A frame of a plugin that is live and on, for any member: its entry's address under a 10-minute ticket.</summary>
    public async Task<Result<PluginFrameDto>> FrameAsync(Member member, Guid pluginId, CancellationToken ct = default)
    {
        var row = await db.WorkspacePlugins.AsNoTracking().FirstOrDefaultAsync(p => p.Id == pluginId && p.RemovedAt == null && p.Enabled, ct);
        if (row is null || options.PublicUrl.Length == 0) return Failure.NotFound("No such plugin");
        var (token, ticket) = PluginTickets.New(member.WorkspaceId, row.Id, row.BundleHash, member.UserId, clock.GetUtcNow());
        db.PluginFrameTickets.Add(ticket);
        await db.SaveChangesAsync(ct);
        return new PluginFrameDto(options.FrameUrl(token, ManifestOf(row).Entry), ticket.ExpiresAt);
    }
}
