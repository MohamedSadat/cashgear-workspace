using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// The change feed keeps 90 days (SYNC_DESIGN.md, Channel 2): older changes go, and each workspace
/// records the highest one removed (<c>Workspaces.ChangesPrunedSeq</c>), so a client whose cursor
/// is older is told so (410 <c>feed.expired</c>) and fetches the tree again, keeping its outbox,
/// instead of never seeing what it missed. In short transactions under the workspace's lock, the
/// mark and the delete together; the feed reads the mark after its rows, so it cannot miss one.
/// </summary>
public sealed class FeedRetentionJob(TimeProvider clock) : IJob
{
    public string Name => "feedRetention";
    public TimeSpan Interval => TimeSpan.FromMinutes(10);
    public static TimeSpan Keep { get; set; } = TimeSpan.FromDays(90);
    /// <summary>Changes removed in one transaction.</summary>
    private const int Batch = 2000;

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var cutoff = clock.GetUtcNow() - Keep;
        var due = await db.WorkspaceChanges.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(c => c.CreatedAt < cutoff).Select(c => c.WorkspaceId).Distinct().Take(20).ToListAsync(ct);
        var more = false;
        foreach (var workspaceId in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(workspaceId);
            more |= await PruneAsync(services, db, workspaceId, ct) == Batch;
        }
        return more || due.Count == 20;
    }

    /// <summary>Removes one batch of the workspace's changes older than the feed keeps; returns how many.</summary>
    public async Task<int> PruneAsync(IServiceProvider services, CgwDb db, Guid workspaceId, CancellationToken ct)
    {
        if (db.TenantId != workspaceId) throw new InvalidOperationException("Enter the workspace's scope first.");
        var cutoff = clock.GetUtcNow() - Keep;
        // The oldest changes, by sequence: everything up to the last of them goes.
        var upTo = await db.WorkspaceChanges.AsNoTracking().Where(c => c.CreatedAt < cutoff)
            .OrderBy(c => c.Seq).Take(Batch).Select(c => (long?)c.Seq).MaxAsync(ct);
        if (upTo is not { } seq) return 0;
        var changes = services.GetRequiredService<ChangeLog>();
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(workspaceId, ct);
        var removed = await db.WorkspaceChanges.Where(c => c.Seq <= seq).ExecuteDeleteAsync(ct);
        await db.Workspaces.Where(w => w.Id == workspaceId && w.ChangesPrunedSeq < seq)
            .ExecuteUpdateAsync(s => s.SetProperty(w => w.ChangesPrunedSeq, seq), ct);
        await tx.CommitAsync(ct);
        return removed;
    }
}

/// <summary>
/// Pages in the trash for 60 days are deleted for good (DECISIONS.md, 2026-11-12: Phase 3): each
/// trash root with the pages under it, exactly as a person's delete from the trash does it
/// (<see cref="PageDeletion"/>): tombstones, a feed <c>delete</c> for each, the purge job then
/// removing their documents, versions and files, and an audit entry
/// (<c>page.purgedByRetention</c>). A page restored meanwhile is left alone: the check is made
/// again under the workspace's lock.
/// </summary>
public sealed class TrashRetentionJob(TimeProvider clock) : IJob
{
    public string Name => "trashRetention";
    public TimeSpan Interval => TimeSpan.FromMinutes(10);
    public static TimeSpan Keep { get; set; } = TimeSpan.FromDays(60);
    private const int Batch = 20;

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var cutoff = clock.GetUtcNow() - Keep;
        var due = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.TrashedAt != null && p.TrashedAt < cutoff && p.DeletedAt == null && p.TrashRootId == p.Id)
            .OrderBy(p => p.TrashedAt).Select(p => new { p.Id, p.WorkspaceId }).Take(Batch).ToListAsync(ct);
        foreach (var root in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(root.WorkspaceId);
            await DeleteAsync(services, db, root.WorkspaceId, root.Id, ct);
        }
        return due.Count == Batch;
    }

    /// <summary>The trash roots of one workspace that are due (tests: the clock moved on).</summary>
    public async Task<int> DeleteDueAsync(IServiceProvider services, CgwDb db, Guid workspaceId, CancellationToken ct)
    {
        if (db.TenantId != workspaceId) throw new InvalidOperationException("Enter the workspace's scope first.");
        var cutoff = clock.GetUtcNow() - Keep;
        var roots = await db.Pages.AsNoTracking().Where(p => p.TrashedAt < cutoff && p.DeletedAt == null && p.TrashRootId == p.Id)
            .Select(p => p.Id).ToListAsync(ct);
        var deleted = 0;
        foreach (var root in roots)
        {
            db.ChangeTracker.Clear();
            if (await DeleteAsync(services, db, workspaceId, root, ct)) deleted++;
        }
        return deleted;
    }

    private async Task<bool> DeleteAsync(IServiceProvider services, CgwDb db, Guid workspaceId, Guid rootId, CancellationToken ct)
    {
        var changes = services.GetRequiredService<ChangeLog>();
        var audit = services.GetRequiredService<Audit>();
        var now = clock.GetUtcNow();
        var cutoff = now - Keep;
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(workspaceId, ct);
        var root = await db.Pages.AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == rootId && p.TrashRootId == rootId && p.TrashedAt < cutoff && p.DeletedAt == null, ct);
        if (root is null)
        {
            await tx.RollbackAsync(ct);
            return false;
        }
        var subtree = await PageDeletion.SubtreeAsync(db, rootId, ct);
        await PageDeletion.TombstoneAsync(db, changes, subtree, null, now, ct);
        audit.Add(Actor.System, "page.purgedByRetention", workspaceId, "page", rootId, new { pages = subtree.Count, trashedAt = root.TrashedAt });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }
}
