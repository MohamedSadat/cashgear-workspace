using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker.Jobs;

/// <summary>
/// SQL and Blob can drift by minutes after a restore from backup (ARCHITECTURE.md, Backup). This
/// puts them back in step and is safe to run at any time:
/// - a ready snapshot row whose blob is missing is first undeleted (Blob soft delete); failing
///   that, the row is dropped and logged, and the page falls back to its previous snapshot and
///   updates;
/// - snapshot and export blobs that no row names, older than a day, are deleted (the day leaves
///   alone a writer that has put its blob and not yet its row);
/// - a ready asset whose blob is missing is undeleted, or else marked deleted with a problem.
/// Every "missing" is checked once more on its own before anything is changed.
/// </summary>
public sealed class ReconcileJob(BlobStore blob, DocStates states, ILogger<ReconcileJob> logger, TimeProvider clock) : IJob
{
    public string Name => "reconcile";
    public TimeSpan Interval => TimeSpan.FromHours(6);
    public static readonly TimeSpan OrphanAge = TimeSpan.FromDays(1);

    public sealed record Report(int SnapshotsUndeleted, int SnapshotsDropped, int OrphansDeleted, int AssetsUndeleted, int AssetsMissing);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var report = await ReconcileAsync(services.GetRequiredService<CgwDb>(), ct);
        if (report != new Report(0, 0, 0, 0, 0)) logger.LogWarning("Reconcile: {Report}", report);
        return false;
    }

    /// <summary>One pass; <paramref name="only"/> keeps it to one workspace's rows and blobs (tests).</summary>
    public async Task<Report> ReconcileAsync(CgwDb db, CancellationToken ct, Guid? only = null)
    {
        var listed = new Dictionary<string, DateTimeOffset?>(StringComparer.Ordinal);
        await foreach (var (name, created) in blob.ListAsync(only is { } one ? BlobStore.WorkspacePrefix(one) : "workspaces/", ct)) listed[name] = created;
        var snapshots = db.PageDocSnapshots.IgnoreQueryFilters([CgwDb.Tenant]).Where(s => only == null || s.WorkspaceId == only);
        var assets = db.Assets.IgnoreQueryFilters([CgwDb.Tenant]).Where(a => only == null || a.WorkspaceId == only);
        int undeleted = 0, dropped = 0, orphans = 0, assetsBack = 0, assetsGone = 0;

        // Rows whose blob is missing.
        // Pages of rows by offset; a row dropped here moves the rest back by one.
        for (var offset = 0; ;)
        {
            var batch = await snapshots.AsNoTracking().Where(s => s.Status == "ready")
                .OrderBy(s => s.Id).Skip(offset).Take(2000).Select(s => new { s.Id, s.PageId, s.BlobKey, s.Kind }).ToListAsync(ct);
            if (batch.Count == 0) break;
            var before = dropped;
            foreach (var row in batch.Where(r => !listed.ContainsKey(r.BlobKey)))
            {
                if (await blob.ExistsAsync(row.BlobKey, ct)) continue;
                if (await blob.UndeleteAsync(row.BlobKey, ct))
                {
                    undeleted++;
                    logger.LogWarning("Snapshot {Snapshot} of page {Page}: its blob was deleted and is back", row.Id, row.PageId);
                    continue;
                }
                dropped += await snapshots.Where(s => s.Id == row.Id).ExecuteDeleteAsync(ct);
                states.Forget(row.PageId);
                logger.LogError("Snapshot {Snapshot} ({Kind}) of page {Page} had no blob and was dropped", row.Id, row.Kind, row.PageId);
            }
            offset += batch.Count - (dropped - before);
        }

        // Blobs no row names.
        var old = clock.GetUtcNow() - OrphanAge;
        var candidates = listed.Where(b => b.Value is { } created && created < old).Select(b => b.Key)
            .Select(name => (Name: name, Parts: name.Split('/')))
            .Where(b => b.Parts is ["workspaces", _, "pages", _, "snapshots", _] or ["workspaces", _, "exports", _])
            .ToList();
        var snapshotBlobs = candidates.Where(b => b.Parts[2] == "pages").ToList();
        foreach (var chunk in snapshotBlobs.Chunk(1000))
        {
            var keys = chunk.Select(b => b.Name).ToList();
            var named = (await snapshots.AsNoTracking().Where(s => keys.Contains(s.BlobKey)).Select(s => s.BlobKey).ToListAsync(ct)).ToHashSet(StringComparer.Ordinal);
            foreach (var name in keys.Where(k => !named.Contains(k)))
            {
                await blob.DeleteAsync(name, ct);
                orphans++;
            }
        }
        var exportBlobs = candidates.Where(b => b.Parts[2] == "exports").ToList();
        var exports = db.WorkspaceExports.IgnoreQueryFilters([CgwDb.Tenant]).Where(e => only == null || e.WorkspaceId == only);
        foreach (var chunk in exportBlobs.Chunk(1000))
        {
            var keys = chunk.Select(b => b.Name).ToList();
            // An expired export's zip is gone on purpose; a row that still names one keeps it.
            var named = (await exports.AsNoTracking().Where(e => e.BlobKey != null && keys.Contains(e.BlobKey) && e.Status == "ready")
                .Select(e => e.BlobKey!).ToListAsync(ct)).ToHashSet(StringComparer.Ordinal);
            foreach (var name in keys.Where(k => !named.Contains(k)))
            {
                await blob.DeleteAsync(name, ct);
                orphans++;
            }
        }

        // Ready assets whose blob is missing.
        for (var offset = 0; ;)
        {
            var batch = await assets.AsNoTracking().Where(a => a.Status == AssetStatus.Ready)
                .OrderBy(a => a.Id).Skip(offset).Take(2000).Select(a => new { a.Id, a.BlobKey }).ToListAsync(ct);
            if (batch.Count == 0) break;
            var before = assetsGone;
            foreach (var row in batch.Where(r => !listed.ContainsKey(r.BlobKey)))
            {
                if (await blob.ExistsAsync(row.BlobKey, ct)) continue;
                if (await blob.UndeleteAsync(row.BlobKey, ct))
                {
                    assetsBack++;
                    continue;
                }
                assetsGone += await assets.Where(a => a.Id == row.Id && a.Status == AssetStatus.Ready).ExecuteUpdateAsync(s => s
                    .SetProperty(a => a.Status, AssetStatus.Deleted)
                    .SetProperty(a => a.Problem, "The file was missing from storage (reconcile)"), ct);
                logger.LogError("Asset {Asset} had no blob and is marked deleted", row.Id);
            }
            offset += batch.Count - (assetsGone - before);
        }
        return new Report(undeleted, dropped, orphans, assetsBack, assetsGone);
    }
}
