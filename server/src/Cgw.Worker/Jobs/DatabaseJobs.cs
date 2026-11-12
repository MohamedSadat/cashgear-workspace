using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Databases whose computed values wait (contract section 4: <c>ComputePending</c>): a formula or
/// rollup changed on a database too large to recompute inline, rows relating to a changed row
/// were too many, or a one-way relation's rollups read a row that changed. Every row of the
/// database is computed again and those whose results changed are written (stamped, in the feed),
/// in one transaction under the workspace's lock, so no edit lands between the read and the
/// write; the mark is cleared in the same transaction.
/// </summary>
public sealed class RecomputeJob(ILogger<RecomputeJob> logger) : IJob
{
    public string Name => "recompute";
    public TimeSpan Interval => TimeSpan.FromSeconds(2);
    private const int Batch = 5;

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var due = await db.Databases.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.ComputePending).OrderBy(d => d.UpdatedAt).Select(d => new { d.PageId, d.WorkspaceId }).Take(Batch).ToListAsync(ct);
        foreach (var database in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(database.WorkspaceId);
            await RecomputeAsync(services, db, database.WorkspaceId, database.PageId, ct);
        }
        return due.Count == Batch;
    }

    /// <summary>One database's rows computed again; returns how many changed.</summary>
    public async Task<int> RecomputeAsync(IServiceProvider services, CgwDb db, Guid workspaceId, Guid databaseId, CancellationToken ct)
    {
        var changes = services.GetRequiredService<ChangeLog>();
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(workspaceId, ct);
            var record = await db.Databases.FirstOrDefaultAsync(d => d.PageId == databaseId, ct);
            if (record is null || !record.ComputePending)
            {
                await tx.RollbackAsync(ct);
                return 0;
            }
            var schema = Cgw.Core.Databases.Schema.Parse(record.PageId, record.Version, record.Properties);
            record.RowsVersion++;
            record.ComputePending = false;
            record.UpdatedAt = DateTimeOffset.UtcNow;
            var changed = await DatabaseOps.RecomputeAllAsync(db, changes, record, schema, null, record.RowsVersion, ct);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
            if (changed > 0) logger.LogInformation("Recomputed {Count} rows of database {Database}", changed, databaseId);
            return changed;
        });
    }
}
