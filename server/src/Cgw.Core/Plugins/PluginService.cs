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
    DateTimeOffset UpdatedAt);

public sealed record WorkspacePluginsDto(IReadOnlyList<WorkspacePluginDto> Plugins);

/// <summary><c>PATCH /workspaces/{id}/plugins/{pluginId}</c>: turn it on or off.</summary>
public sealed record PluginPatch(bool? Enabled);

/// <summary>A frame's address on the plugins origin, and when its ticket ends.</summary>
public sealed record PluginFrameDto(string Url, DateTimeOffset ExpiresAt);

/// <summary>
/// Where plugins are served (Phase 10): <c>Plugins__PublicUrl</c>, the Sites process's second host
/// (<c>https://plugins.cashgearerp.com</c> in production; <c>http://localhost:5291</c> on a
/// developer's machine and in e2e). The API builds a frame's address from it, never from a request.
/// <see cref="FrameAncestors"/> are the Workspace origins that may frame a plugin (<c>Web__Origins</c>).
/// </summary>
public sealed record PluginsOptions(string PublicUrl, IReadOnlyList<string> FrameAncestors)
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
        return new PluginsOptions(origin ?? (production ? "" : DevPublicUrl), origins);
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
/// its own prefix, written before the row names them. Every write takes the workspace's lock. The
/// list is read by clients on start and after Settings' changes: no change goes to the feed.
/// </summary>
public sealed class PluginService(CgwDb db, BlobStore blob, ChangeLog changes, Audit audit, PluginsOptions options, TimeProvider clock)
{
    public static string Prefix(Guid workspaceId, Guid pluginId, string bundleHash) => $"{BlobStore.WorkspacePrefix(workspaceId)}plugins/{pluginId}/{bundleHash}/";

    /// <summary>Everything a plugin holds in storage, every bundle of it.</summary>
    public static string PluginPrefix(Guid workspaceId, Guid pluginId) => $"{BlobStore.WorkspacePrefix(workspaceId)}plugins/{pluginId}/";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static PluginManifest ManifestOf(WorkspacePlugin row) => JsonSerializer.Deserialize<PluginManifest>(row.Manifest, Json)!;

    public static IReadOnlyList<PluginFile> FilesOf(WorkspacePlugin row) => JsonSerializer.Deserialize<List<PluginFile>>(row.Files, Json) ?? [];

    private async Task<List<WorkspacePluginDto>> DtosAsync(IReadOnlyList<WorkspacePlugin> rows, CancellationToken ct)
    {
        var people = await People.RefsAsync(db, rows.Select(r => r.AddedBy), ct);
        return rows.Select(r =>
        {
            var manifest = ManifestOf(r);
            var by = People.Of(people, r.AddedBy);
            return new WorkspacePluginDto(r.Id, r.Type, r.Version, manifest.Name, manifest.Description, manifest.Reads, manifest.Height, manifest.Keywords,
                r.Enabled, r.SizeBytes, new UserRefDto(by.Id, by.Name), r.AddedAt, r.UpdatedAt);
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
    /// </summary>
    public async Task<Result<(WorkspacePluginDto Plugin, bool Created)>> AddAsync(Member member, Actor actor, byte[] zip, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin adds a plugin");
        var (bundle, problems) = PluginBundle.Read(zip);
        if (bundle is null) return Invalid(problems);
        var manifest = bundle.Manifest;
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
                };
                db.WorkspacePlugins.Add(row);
                audit.Add(actor, "plugin.add", member.WorkspaceId, "plugin", id, new { type = manifest.Type, version = manifest.Version, bundleHash = bundle.Hash });
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
                });
                row.Version = manifest.Version;
                row.Manifest = manifestJson;
                row.Files = filesJson;
                row.BundleHash = bundle.Hash;
                row.BlobPrefix = prefix;
                row.SizeBytes = bundle.Size;
                row.UpdatedBy = member.UserId;
                row.UpdatedAt = now;
            }
            await db.SaveChangesAsync(ct);
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

    /// <summary>Turns a live plugin on or off (<c>plugin.enable</c>, <c>plugin.disable</c>).</summary>
    public async Task<Result<WorkspacePluginDto>> PatchAsync(Member member, Actor actor, Guid pluginId, PluginPatch? patch, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin turns a plugin on or off");
        if (patch?.Enabled is not { } enabled) return Failure.Invalid("Send enabled");
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var row = await db.WorkspacePlugins.FirstOrDefaultAsync(p => p.Id == pluginId && p.RemovedAt == null, ct);
        if (row is null) return Failure.NotFound("No such plugin");
        if (row.Enabled != enabled)
        {
            row.Enabled = enabled;
            row.UpdatedBy = member.UserId;
            row.UpdatedAt = clock.GetUtcNow();
            audit.Add(actor, enabled ? "plugin.enable" : "plugin.disable", member.WorkspaceId, "plugin", row.Id, new { type = row.Type, version = row.Version, bundleHash = row.BundleHash });
            await db.SaveChangesAsync(ct);
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
        await db.SaveChangesAsync(ct);
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
