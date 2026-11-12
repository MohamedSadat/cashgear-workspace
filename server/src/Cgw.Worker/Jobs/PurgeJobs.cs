using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Pages deleted for good (DATA_MODEL.md; SYNC_DESIGN.md: "permanent deletion of a page removes
/// its rows and blobs"): their update rows, snapshots and blobs, derived row, links, asset
/// references, permissions and share links go. The page row stays as a tombstone, with nothing of
/// its content left, so a late push still gets 410. Rows first, then blobs, so no row names a
/// missing blob; a blob left by a crash is the reconcile job's.
/// </summary>
public sealed class PagePurgeJob(DocStates states, BlobStore blob, TimeProvider clock) : IJob
{
    public string Name => "purgePages";
    public TimeSpan Interval => TimeSpan.FromMinutes(1);
    private const int Batch = 50;

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var due = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.DeletedAt != null && p.PurgedAt == null)
            .OrderBy(p => p.DeletedAt).Take(Batch).Select(p => new { p.Id, p.WorkspaceId }).ToListAsync(ct);
        foreach (var page in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(page.WorkspaceId);
            await PurgeAsync(db, page.WorkspaceId, page.Id, ct);
        }
        return due.Count == Batch;
    }

    public async Task PurgeAsync(CgwDb db, Guid workspaceId, Guid pageId, CancellationToken ct)
    {
        var keys = await db.PageDocSnapshots.Where(s => s.PageId == pageId).Select(s => s.BlobKey).ToListAsync(ct);
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            await db.PageDocUpdates.Where(u => u.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.PageDocSnapshots.Where(s => s.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.PageDocDerived.Where(d => d.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.PageDocCommands.Where(c => c.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.PageLinks.Where(l => l.FromPageId == pageId || l.ToPageId == pageId).ExecuteDeleteAsync(ct);
            await db.AssetRefs.Where(r => r.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.PagePermissions.Where(r => r.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.ShareLinks.Where(l => l.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.Favourites.Where(f => f.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.PageVisits.Where(v => v.PageId == pageId).ExecuteDeleteAsync(ct);
            await db.PageAncestors.Where(a => a.PageId == pageId || a.AncestorPageId == pageId).ExecuteDeleteAsync(ct);
            var now = clock.GetUtcNow();
            await db.Pages.Where(p => p.Id == pageId).ExecuteUpdateAsync(s => s
                .SetProperty(p => p.PurgedAt, now)
                .SetProperty(p => p.Title, "")
                .SetProperty(p => p.SearchTitle, "")
                .SetProperty(p => p.Icon, (string?)null)
                .SetProperty(p => p.CoverAssetId, (Guid?)null), ct);
            await tx.CommitAsync(ct);
        }
        states.Forget(pageId);
        foreach (var key in keys) await blob.DeleteAsync(key, ct);
        await foreach (var (name, _) in blob.ListAsync(BlobStore.PagePrefix(workspaceId, pageId), ct))
            await blob.DeleteAsync(name, ct);
    }
}

/// <summary>
/// Workspaces deleted more than 30 days ago (DATA_MODEL.md, Data export and deletion) lose every
/// row and every blob. The audit log is append-only and keeps its rows. Safe to stop at any point:
/// the next run carries on from what is left, and the workspace row goes last.
/// </summary>
public sealed class WorkspacePurgeJob(BlobStore blob, TimeProvider clock) : IJob
{
    public string Name => "purgeWorkspaces";
    public TimeSpan Interval => TimeSpan.FromHours(1);
    public static TimeSpan Keep { get; set; } = TimeSpan.FromDays(30);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var before = clock.GetUtcNow() - Keep;
        var due = await db.Workspaces.AsNoTracking().Where(w => w.DeletedAt != null && w.DeletedAt < before)
            .OrderBy(w => w.DeletedAt).Select(w => w.Id).Take(5).ToListAsync(ct);
        foreach (var id in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(id);
            await PurgeAsync(db, id, ct);
        }
        return due.Count == 5;
    }

    public async Task PurgeAsync(CgwDb db, Guid workspaceId, CancellationToken ct)
    {
        // Every tenant-owned table; the tenant filter scopes each delete to this workspace.
        if (db.TenantId != workspaceId) throw new InvalidOperationException("Enter the workspace's scope first.");
        await db.PageDocUpdates.ExecuteDeleteAsync(ct);
        await db.PageDocSnapshots.ExecuteDeleteAsync(ct);
        await db.PageDocDerived.ExecuteDeleteAsync(ct);
        await db.PageDocCommands.ExecuteDeleteAsync(ct);
        await db.PageLinks.ExecuteDeleteAsync(ct);
        await db.AssetRefs.ExecuteDeleteAsync(ct);
        await db.PagePermissions.ExecuteDeleteAsync(ct);
        await db.ShareLinks.ExecuteDeleteAsync(ct);
        await db.Favourites.ExecuteDeleteAsync(ct);
        await db.PageVisits.ExecuteDeleteAsync(ct);
        await db.PageAncestors.ExecuteDeleteAsync(ct);
        await db.Pages.ExecuteDeleteAsync(ct);
        await db.Sections.ExecuteDeleteAsync(ct);
        await db.Assets.ExecuteDeleteAsync(ct);
        await db.LinkPreviews.ExecuteDeleteAsync(ct);
        await db.WorkspaceExports.ExecuteDeleteAsync(ct);
        await db.WorkspaceChanges.ExecuteDeleteAsync(ct);
        await db.AppliedOps.ExecuteDeleteAsync(ct);
        await db.YjsClients.ExecuteDeleteAsync(ct);
        await db.WorkspaceInvites.ExecuteDeleteAsync(ct);
        await db.WorkspaceMembers.ExecuteDeleteAsync(ct);
        await foreach (var (name, _) in blob.ListAsync(BlobStore.WorkspacePrefix(workspaceId), ct))
            await blob.DeleteAsync(name, ct);
        await db.Workspaces.Where(w => w.Id == workspaceId).ExecuteDeleteAsync(ct);
    }
}
