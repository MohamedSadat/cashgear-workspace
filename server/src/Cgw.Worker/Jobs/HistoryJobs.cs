using Cgw.Core;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.History;
using Cgw.Core.Sync;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Versions people asked for (named, preRestore): each pending row becomes a full state written
/// to Blob from the page's current validated state, then the row says ready.
/// </summary>
public sealed class SnapshotJob(DocStates states, BlobStore blob) : IJob
{
    public string Name => "snapshots";
    public TimeSpan Interval => TimeSpan.FromSeconds(1);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var pending = await db.PageDocSnapshots.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(s => s.Status == "pending").OrderBy(s => s.CreatedAt).Take(20)
            .Select(s => new { s.Id, s.WorkspaceId }).ToListAsync(ct);
        foreach (var row in pending)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(row.WorkspaceId);
            await WriteAsync(db, row.Id, ct);
        }
        return pending.Count == 20;
    }

    public async Task WriteAsync(CgwDb db, Guid snapshotId, CancellationToken ct)
    {
        var snapshot = await db.PageDocSnapshots.FirstOrDefaultAsync(s => s.Id == snapshotId && s.Status == "pending", ct);
        if (snapshot is null) return;
        var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == snapshot.PageId, ct);
        if (page is null || page.DeletedAt is not null)
        {
            db.PageDocSnapshots.Remove(snapshot);
            await db.SaveChangesAsync(ct);
            return;
        }
        var state = Yjs.Compact(await states.LoadAsync(db, page, ct));
        // The blob first, then the row says ready: a reader never sees a ready row without its blob.
        await blob.PutAsync(snapshot.BlobKey, state, "application/octet-stream", ct);
        snapshot.Epoch = page.DocEpoch;
        snapshot.UpToSeq = page.DocHeadSeq;
        snapshot.SizeBytes = state.Length;
        snapshot.Status = "ready";
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>
/// History snapshots on a schedule (SYNC_DESIGN.md, Version history): one <c>auto</c> snapshot per
/// hour of activity per page (a page whose document moved since its last one, once that is an hour
/// old), kept for 30 days, then one per day; named and preRestore versions are kept for ever. The
/// extra rows go first, then their blobs, so no row ever names a missing blob.
/// </summary>
public sealed class HistoryJob(DocStates states, BlobStore blob, TimeProvider clock) : IJob
{
    public string Name => "history";
    public TimeSpan Interval => TimeSpan.FromMinutes(1);
    public static TimeSpan AutoEvery { get; set; } = TimeSpan.FromHours(1);
    public static TimeSpan KeepAll { get; set; } = TimeSpan.FromDays(30);
    private const int Batch = 20;

    private sealed class Extra
    {
        public byte[] Id { get; set; } = [];
        public string BlobKey { get; set; } = "";
    }

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        var made = await AutoAsync(db, now, ct);
        var pruned = await RetainAsync(db, now, ct);
        return made == Batch || pruned == 500;
    }

    /// <summary>Makes the auto snapshots due at <paramref name="now"/>; <paramref name="only"/> keeps it to one workspace (tests).</summary>
    public async Task<int> AutoAsync(CgwDb db, DateTimeOffset now, CancellationToken ct, Guid? only = null)
    {
        var recent = now - AutoEvery;
        var snapshots = db.PageDocSnapshots.IgnoreQueryFilters([CgwDb.Tenant]);
        var live = db.Workspaces.Where(w => w.DeletedAt == null && (only == null || w.Id == only)).Select(w => w.Id);
        var due = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.DocHeadSeq > 0 && p.DeletedAt == null && live.Contains(p.WorkspaceId))
            .Where(p => !snapshots.Any(s => s.PageId == p.Id && s.Kind == SnapshotKinds.Auto
                && (s.CreatedAt > recent || (s.Epoch == p.DocEpoch && s.UpToSeq >= p.DocHeadSeq))))
            .OrderBy(p => p.Id).Select(p => new { p.Id, p.WorkspaceId }).Take(Batch).ToListAsync(ct);
        foreach (var row in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(row.WorkspaceId);
            var page = await db.Pages.AsNoTracking().FirstAsync(p => p.Id == row.Id, ct);
            var state = Yjs.Compact(await states.LoadAsync(db, page, ct));
            var snapshot = new PageDocSnapshot
            {
                Id = Guid.CreateVersion7(),
                PageId = page.Id,
                WorkspaceId = page.WorkspaceId,
                Epoch = page.DocEpoch,
                UpToSeq = page.DocHeadSeq,
                SizeBytes = state.Length,
                Kind = SnapshotKinds.Auto,
                Status = "ready",
                CreatedAt = now,
            };
            snapshot.BlobKey = BlobStore.SnapshotKey(page.WorkspaceId, page.Id, snapshot.Id);
            await blob.PutAsync(snapshot.BlobKey, state, "application/octet-stream", ct);
            db.PageDocSnapshots.Add(snapshot);
            await db.SaveChangesAsync(ct);
        }
        return due.Count;
    }

    /// <summary>Auto snapshots older than 30 days: the last of each page's day stays, the rest go (a named query).</summary>
    public async Task<int> RetainAsync(CgwDb db, DateTimeOffset now, CancellationToken ct, Guid? only = null)
    {
        var cutoff = now - KeepAll;
        var extra = await db.Database.SqlQueryRaw<Extra>(
            """
            SELECT TOP (500) r.Id, r.BlobKey FROM (
                SELECT s.Id, s.BlobKey, ROW_NUMBER() OVER (
                    PARTITION BY s.PageId, CAST(SWITCHOFFSET(s.CreatedAt, '+00:00') AS date)
                    ORDER BY s.CreatedAt DESC, s.Id DESC) AS n
                FROM PageDocSnapshots s
                WHERE s.Kind = 'auto' AND s.Status = 'ready' AND s.CreatedAt < @cutoff
                    AND (@only IS NULL OR s.WorkspaceId = @only)
            ) r
            WHERE r.n > 1
            """,
            new Microsoft.Data.SqlClient.SqlParameter("@cutoff", System.Data.SqlDbType.DateTimeOffset) { Value = cutoff },
            new Microsoft.Data.SqlClient.SqlParameter("@only", System.Data.SqlDbType.Binary, 16) { Value = only is { } id ? GuidBytes.ToBytes(id) : DBNull.Value }).ToListAsync(ct);
        foreach (var chunk in extra.Chunk(500))
        {
            var ids = chunk.Select(e => GuidBytes.FromBytes(e.Id)).ToList();
            await db.PageDocSnapshots.IgnoreQueryFilters([CgwDb.Tenant]).Where(s => ids.Contains(s.Id)).ExecuteDeleteAsync(ct);
            foreach (var row in chunk) await blob.DeleteAsync(row.BlobKey, ct);
        }
        return extra.Count;
    }
}

/// <summary>
/// The hard restore (SYNC_DESIGN.md, Epoch change): the version's state replaces the document. In
/// one transaction, under the workspace's and the page's locks and the compactor's: the current
/// state is kept as a <c>preRestore</c> version (so the restore can itself be undone), the
/// version's state becomes a compaction snapshot at the next epoch, every update row of the old
/// epoch goes, and the page row's epoch and head move; a <c>page</c> change tells clients, who
/// set their unsent edits aside and pull the new epoch from the start.
/// </summary>
public sealed class HardRestoreJob(DocStates states, BlobStore blob, ILogger<HardRestoreJob> logger, TimeProvider clock) : IJob
{
    public string Name => "restore";
    public TimeSpan Interval => TimeSpan.FromSeconds(1);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var pending = await db.PageDocCommands.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(c => c.Status == CommandStatus.Pending).OrderBy(c => c.CreatedAt).Take(5)
            .Select(c => new { c.Id, c.WorkspaceId }).ToListAsync(ct);
        foreach (var command in pending)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(command.WorkspaceId);
            try
            {
                await RestoreAsync(services, db, command.Id, ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogError(e, "Hard restore {Command} failed", command.Id);
                db.ChangeTracker.Clear();
                await Fail(db, command.Id, e.Message, ct);
            }
        }
        return pending.Count == 5;
    }

    private async Task Fail(CgwDb db, Guid commandId, string why, CancellationToken ct)
    {
        var error = why.Length > 1000 ? why[..1000] : why;
        var at = clock.GetUtcNow();
        await db.PageDocCommands.Where(c => c.Id == commandId).ExecuteUpdateAsync(s => s
            .SetProperty(c => c.Status, CommandStatus.Failed)
            .SetProperty(c => c.Error, error)
            .SetProperty(c => c.CompletedAt, at), ct);
    }

    public async Task RestoreAsync(IServiceProvider services, CgwDb db, Guid commandId, CancellationToken ct)
    {
        var command = await db.PageDocCommands.AsNoTracking().FirstOrDefaultAsync(c => c.Id == commandId && c.Status == CommandStatus.Pending, ct);
        if (command is null) return;
        var version = await db.PageDocSnapshots.AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == command.SnapshotId && s.PageId == command.PageId && s.Status == "ready", ct);
        if (version is null)
        {
            await Fail(db, commandId, "The version is gone", ct);
            return;
        }
        var restored = await blob.GetAsync(version.BlobKey, ct);
        if (restored is null)
        {
            await Fail(db, commandId, "The version's blob is missing", ct);
            return;
        }
        var newState = Yjs.Compact(restored);
        var changes = services.GetRequiredService<ChangeLog>();
        var audit = services.GetRequiredService<Audit>();
        var written = new List<string>();
        List<PageDocSnapshot> older;
        int epoch;
        long head;
        try
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            // The workspace row, then the page's: the order every writer takes them in.
            await changes.LockAsync(command.WorkspaceId, ct);
            if (!await AppLock.TryAsync(db, $"compact:{command.PageId}", ct))
            {
                // A compaction is running: try again on the next pass.
                await tx.RollbackAsync(ct);
                return;
            }
            await db.Pages.Where(p => p.Id == command.PageId).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSeq, p => p.DocSeq), ct);
            var page = await db.Pages.FirstAsync(p => p.Id == command.PageId, ct);
            if (page.DeletedAt is not null)
            {
                await tx.RollbackAsync(ct);
                await Fail(db, commandId, "The page was deleted", ct);
                return;
            }
            var now = clock.GetUtcNow();
            var current = Yjs.Compact(await states.LoadAsync(db, page, ct));
            var before = new PageDocSnapshot
            {
                Id = Guid.CreateVersion7(),
                PageId = page.Id,
                WorkspaceId = page.WorkspaceId,
                Epoch = page.DocEpoch,
                UpToSeq = page.DocHeadSeq,
                SizeBytes = current.Length,
                Kind = SnapshotKinds.PreRestore,
                Name = null,
                Status = "ready",
                CreatedBy = command.RequestedBy,
                CreatedAt = now,
            };
            before.BlobKey = BlobStore.SnapshotKey(page.WorkspaceId, page.Id, before.Id);
            epoch = page.DocEpoch + 1;
            // Sequences keep rising across epochs, so (page, seq) stays unique; the snapshot covers them all.
            head = Math.Max(page.DocSeq, 1);
            var snapshot = new PageDocSnapshot
            {
                Id = Guid.CreateVersion7(),
                PageId = page.Id,
                WorkspaceId = page.WorkspaceId,
                Epoch = epoch,
                UpToSeq = head,
                SizeBytes = newState.Length,
                Kind = SnapshotKinds.Compaction,
                Status = "ready",
                CreatedBy = command.RequestedBy,
                CreatedAt = now,
            };
            snapshot.BlobKey = BlobStore.SnapshotKey(page.WorkspaceId, page.Id, snapshot.Id);
            await blob.PutAsync(before.BlobKey, current, "application/octet-stream", ct);
            written.Add(before.BlobKey);
            await blob.PutAsync(snapshot.BlobKey, newState, "application/octet-stream", ct);
            written.Add(snapshot.BlobKey);

            older = await db.PageDocSnapshots.Where(s => s.PageId == page.Id && s.Kind == SnapshotKinds.Compaction).ToListAsync(ct);
            db.PageDocSnapshots.RemoveRange(older);
            db.PageDocSnapshots.Add(before);
            db.PageDocSnapshots.Add(snapshot);
            await db.PageDocUpdates.Where(u => u.PageId == page.Id).ExecuteDeleteAsync(ct);
            // The derived JSON and text are made again from the new state.
            await db.PageDocDerived.Where(d => d.PageId == page.Id).ExecuteUpdateAsync(s => s.SetProperty(d => d.UpToSeq, -1L), ct);
            page.DocEpoch = epoch;
            page.DocSeq = head;
            page.DocHeadSeq = head;
            page.Version++;
            page.UpdatedAt = now;
            page.UpdatedBy = command.RequestedBy;
            changes.Add("page", page.Id, "upsert", page.Version, command.RequestedBy);
            audit.Add(new Actor(command.RequestedBy, null, null), "version.hardRestore", page.WorkspaceId, "page", page.Id,
                new { versionId = version.Id, commandId, epoch, preRestoreId = before.Id });
            var tracked = await db.PageDocCommands.FirstAsync(c => c.Id == commandId, ct);
            tracked.Status = CommandStatus.Done;
            tracked.CompletedAt = now;
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            foreach (var key in written) await blob.DeleteAsync(key, CancellationToken.None);
            throw;
        }
        foreach (var previous in older) await blob.DeleteAsync(previous.BlobKey, ct);
        states.Put(command.PageId, epoch, head, newState);
    }
}
