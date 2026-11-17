using System.Collections.Concurrent;
using System.Security.Cryptography;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Plugins;

/// <summary>A plugin as the plugins origin checks it: live, on, its bundle and its files by path.</summary>
public sealed record PluginServed(Guid Id, Guid WorkspaceId, bool Live, bool Enabled, string BundleHash, string BlobPrefix, IReadOnlyDictionary<string, PluginFile> Files);

/// <summary>
/// What the Sites process's plugins host reads (Phase 10): a frame ticket by its hash and a plugin's
/// row, each kept at most 30 s, and
/// its files' bytes from Blob Storage, kept in memory by their SHA-256 (at most 64 MB, the least
/// recently used going first), each checked against its hash when read.
/// </summary>
public sealed class PluginFiles(BlobStore blob, TimeProvider clock)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(30);
    public const long MaxBytes = 64L * 1024 * 1024;

    private readonly ConcurrentDictionary<Guid, (DateTimeOffset At, PluginServed? Plugin)> plugins = new();
    private readonly ConcurrentDictionary<string, (DateTimeOffset Until, PluginTicket? Ticket)> tickets = new(StringComparer.Ordinal);

    /// <summary>
    /// A frame ticket by its token: found by its hash while it lasts, kept here at most 30 s and never
    /// past its expiry (an unknown one 5 s).
    /// </summary>
    public async Task<PluginTicket?> TicketAsync(CgwDb db, string token, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (tickets.TryGetValue(token, out var kept) && now < kept.Until) return kept.Ticket;
        var ticket = await PluginTickets.FindAsync(db, token, now, ct);
        if (tickets.Count > 10_000) tickets.Clear();
        var until = ticket is null ? now + TimeSpan.FromSeconds(5) : (now + Lifetime < ticket.ExpiresAt ? now + Lifetime : ticket.ExpiresAt);
        if (PluginTickets.HashOf(token) is not null) tickets[token] = (until, ticket);
        return ticket;
    }
    private readonly ConcurrentDictionary<string, (long Used, byte[] Bytes)> bytes = new(StringComparer.Ordinal);
    private long held;
    private long used;

    /// <summary>The plugin by id across workspaces (the ticket says which), from the cache while it is fresh.</summary>
    public async Task<PluginServed?> PluginAsync(CgwDb db, Guid pluginId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (plugins.TryGetValue(pluginId, out var kept) && now - kept.At < Lifetime) return kept.Plugin;
        var row = await db.WorkspacePlugins.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(p => p.Id == pluginId, ct);
        var live = row is not null && await db.Workspaces.AsNoTracking().AnyAsync(w => w.Id == row.WorkspaceId && w.DeletedAt == null, ct);
        PluginServed? served = row is null
            ? null
            : new PluginServed(row.Id, row.WorkspaceId, row.RemovedAt is null && live, row.Enabled, row.BundleHash, row.BlobPrefix,
                PluginService.FilesOf(row).ToDictionary(f => f.Path, StringComparer.Ordinal));
        if (plugins.Count > 10_000) plugins.Clear();
        plugins[pluginId] = (now, served);
        return served;
    }

    /// <summary>A file's bytes, or null when the blob is missing or no longer what the bundle holds.</summary>
    public async Task<byte[]?> BytesAsync(PluginServed plugin, PluginFile file, CancellationToken ct)
    {
        if (bytes.TryGetValue(file.Sha256, out var kept))
        {
            bytes[file.Sha256] = (Interlocked.Increment(ref used), kept.Bytes);
            return kept.Bytes;
        }
        var read = await blob.GetAsync(plugin.BlobPrefix + file.Path, ct);
        if (read is null || Convert.ToHexStringLower(SHA256.HashData(read)) != file.Sha256) return null;
        if (read.LongLength <= MaxBytes / 4)
        {
            bytes[file.Sha256] = (Interlocked.Increment(ref used), read);
            Interlocked.Add(ref held, read.LongLength);
            while (Interlocked.Read(ref held) > MaxBytes)
            {
                var oldest = bytes.OrderBy(b => b.Value.Used).FirstOrDefault();
                if (oldest.Key is null || !bytes.TryRemove(oldest.Key, out var gone)) break;
                Interlocked.Add(ref held, -gone.Bytes.LongLength);
            }
        }
        return read;
    }

    /// <summary>
    /// A plugin file's Content Security Policy (decisions, 2026-11-18): a sandbox with scripts and
    /// nothing else, everything from the plugins origin only (named, not <c>'self'</c>, which a
    /// sandboxed document's opaque origin may not match), no network, no frames, no workers, no
    /// forms, framed only by Workspace's own origins.
    /// </summary>
    public static string ContentSecurityPolicy(PluginsOptions options)
    {
        var origin = options.PublicUrl;
        var ancestors = options.FrameAncestors.Count == 0 ? "'none'" : string.Join(' ', options.FrameAncestors);
        return $"sandbox allow-scripts; default-src 'none'; script-src {origin}; style-src {origin} 'unsafe-inline'; img-src {origin} data: blob:; "
            + $"font-src {origin}; media-src {origin}; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; "
            + $"frame-ancestors {ancestors}";
    }
}
