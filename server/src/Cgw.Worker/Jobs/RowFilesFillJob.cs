using System.Data;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Phase 14 (M14.1): the index of rows' files filled once for every row written before it, every
/// database with a files property in every workspace, a few thousand rows a transaction under the
/// workspace's lock (as every writer of rows takes it, so no write lands between the read and the
/// index). Done once: <see cref="Done"/> in <c>JobStates</c>; the asset clean-up deletes nothing until
/// then, since 0.13.0 counted a row's file as held by nothing.
/// </summary>
public sealed class RowFilesFillJob(TimeProvider clock) : IJob
{
    public const string JobName = "rowFilesFill";
    public const string Done = "rowFilesFill:done";
    private const int Batch = 2000;

    public string Name => JobName;
    public TimeSpan Interval => TimeSpan.FromMinutes(10);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        if (await db.JobStates.AnyAsync(j => j.Name == Done, ct)) return false;
        var databases = await db.Databases.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.Properties.Contains("\"" + PropertyTypes.Files + "\""))
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), d => d.WorkspaceId, w => w.Id, (d, _) => new { d.PageId, d.WorkspaceId })
            .ToListAsync(ct);
        foreach (var database in databases)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(database.WorkspaceId);
            for (var skip = 0; ; skip += Batch)
            {
                await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
                await new ChangeLog(db, clock).LockAsync(database.WorkspaceId, ct);
                var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == database.PageId, ct);
                if (record is null) break;
                var schema = DatabaseService.SchemaOf(record);
                var rows = await db.DatabaseRows.AsNoTracking().Where(r => r.DatabaseId == record.PageId)
                    .OrderBy(r => r.PageId).Skip(skip).Take(Batch).Select(r => new { r.PageId, r.Values }).ToListAsync(ct);
                var entries = rows.Select(r => new RowFiles.Entry(r.PageId, RowFiles.Of(schema, ValueJson.ReadMap(r.Values)))).ToList();
                await RowFiles.ReplaceAsync(db, record.WorkspaceId, record.PageId, entries, ct);
                await tx.CommitAsync(ct);
                if (rows.Count < Batch) break;
            }
        }
        db.ChangeTracker.Clear();
        var now = clock.GetUtcNow();
        db.JobStates.Add(new JobState { Name = Done, LastRunAt = now, LastOkAt = now, Runs = databases.Count });
        await db.SaveChangesAsync(ct);
        return false;
    }
}
