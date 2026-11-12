using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Databases;

/// <summary>
/// The tree rules' reach into databases (contract section 1): rows are not in the closure table,
/// so what happens to a database page's subtree happens to its rows here, many at a time: they
/// go to the trash with it and come back with it, follow it to another section, and go for good
/// with it. Call under the workspace's lock, in the operation's transaction, after saving what is
/// tracked (the statements read the pages as they are).
/// </summary>
public static class DatabaseTree
{
    private static SqlParameter Bin(string name, Guid? id) =>
        new(name, System.Data.SqlDbType.Binary, 16) { Value = id is { } g ? GuidBytes.ToBytes(g) : DBNull.Value };

    private static SqlParameter At(string name, DateTimeOffset at) => new(name, System.Data.SqlDbType.DateTimeOffset) { Value = at };

    /// <summary>A database's rows version raised, and every one of its rows stamped with it (the query cache reads them again).</summary>
    private static async Task StampAllAsync(CgwDb db, IEnumerable<Guid> databaseIds, DateTimeOffset now, CancellationToken ct)
    {
        foreach (var id in databaseIds.Distinct())
        {
            var record = await db.Databases.FirstOrDefaultAsync(d => d.PageId == id, ct);
            if (record is null) continue;
            record.RowsVersion++;
            record.UpdatedAt = now;
            var seq = record.RowsVersion;
            await db.DatabaseRows.Where(r => r.DatabaseId == id).ExecuteUpdateAsync(s => s.SetProperty(r => r.Seq, seq), ct);
        }
    }

    private static async Task RecountAsync(CgwDb db, ChangeLog changes, IEnumerable<Guid> databaseIds, Guid? actor, CancellationToken ct)
    {
        foreach (var id in databaseIds.Distinct())
        {
            var record = await db.Databases.FirstOrDefaultAsync(d => d.PageId == id, ct);
            if (record is null) continue;
            record.RowCount = await RowStore.CountAsync(db, id, ct);
            changes.Add("database", id, "upsert", record.Version, actor);
        }
    }

    private static List<Guid> Databases(IEnumerable<Page> pages) => pages.Where(p => p.Kind == PageKinds.Database).Select(p => p.Id).ToList();

    /// <summary>The rows of the subtree's databases not in the trash go with it, under its root.</summary>
    public static async Task TrashAsync(CgwDb db, ChangeLog changes, IEnumerable<Page> subtree, Guid root, Guid actor, DateTimeOffset now, CancellationToken ct)
    {
        var databases = Databases(subtree);
        if (databases.Count == 0) return;
        await db.SaveChangesAsync(ct);
        var ids = await RowStore.RowIdsAsync(db, databases, p => p.TrashedAt == null && p.DeletedAt == null, ct);
        if (ids.Count == 0) return;
        await RowStore.UpdatePagesAsync(db, ids, "p.[TrashedAt] = @now, p.[TrashRootId] = @root, p.[TrashedBy] = @by, p.[Version] = p.[Version] + 1",
            [At("@now", now), Bin("@root", root), Bin("@by", actor)], ct);
        await StampAllAsync(db, databases, now, ct);
        await RecountAsync(db, changes, databases, actor, ct);
        await changes.AddPagesAsync(ids, "upsert", actor, ct);
    }

    /// <summary>The rows that went to the trash with this root come back with it.</summary>
    public static async Task RestoreAsync(CgwDb db, ChangeLog changes, IEnumerable<Page> subtree, Guid root, Guid actor, DateTimeOffset now, CancellationToken ct)
    {
        var databases = Databases(subtree);
        if (databases.Count == 0) return;
        await db.SaveChangesAsync(ct);
        var ids = await RowStore.RowIdsAsync(db, databases, p => p.TrashRootId == root && p.DeletedAt == null, ct);
        if (ids.Count == 0) return;
        await RowStore.UpdatePagesAsync(db, ids, "p.[TrashedAt] = NULL, p.[TrashRootId] = NULL, p.[TrashedBy] = NULL, p.[Version] = p.[Version] + 1", [], ct);
        await StampAllAsync(db, databases, now, ct);
        await RecountAsync(db, changes, databases, actor, ct);
        await changes.AddPagesAsync(ids, "upsert", actor, ct);
    }

    /// <summary>A database's rows are in its section: they follow it.</summary>
    public static async Task MoveAsync(CgwDb db, ChangeLog changes, IEnumerable<Page> subtree, Guid sectionId, Guid actor, DateTimeOffset now, CancellationToken ct)
    {
        var databases = Databases(subtree);
        if (databases.Count == 0) return;
        await db.SaveChangesAsync(ct);
        var ids = await RowStore.RowIdsAsync(db, databases, p => p.DeletedAt == null, ct);
        if (ids.Count == 0) return;
        await RowStore.UpdatePagesAsync(db, ids, "p.[SectionId] = @section, p.[Version] = p.[Version] + 1", [Bin("@section", sectionId)], ct);
        await StampAllAsync(db, databases, now, ct);
        await changes.AddPagesAsync(ids, "upsert", actor, ct);
    }

    /// <summary>
    /// Databases deleted for good: their rows become tombstones (a feed delete each), and their
    /// database records, views and row values go. Rows of other databases that named these rows in
    /// a relation keep the ids, which name nothing now (drawn as missing).
    /// </summary>
    public static async Task DeleteDatabasesAsync(CgwDb db, ChangeLog changes, IEnumerable<Page> subtree, Guid? actor, DateTimeOffset now, CancellationToken ct)
    {
        var databases = Databases(subtree);
        if (databases.Count == 0) return;
        await db.SaveChangesAsync(ct);
        var ids = await RowStore.RowIdsAsync(db, databases, p => p.DeletedAt == null, ct);
        if (ids.Count > 0)
        {
            await RowStore.UpdatePagesAsync(db, ids, "p.[DeletedAt] = @now, p.[Title] = N'', p.[SearchTitle] = N'', p.[Version] = p.[Version] + 1", [At("@now", now)], ct);
            await changes.AddPagesAsync(ids, "delete", actor, ct);
            foreach (var chunk in Chunked.Of(ids))
            {
                await db.Favourites.Where(f => chunk.Contains(f.PageId)).ExecuteDeleteAsync(ct);
                await db.PageVisits.Where(v => chunk.Contains(v.PageId)).ExecuteDeleteAsync(ct);
            }
        }
        foreach (var id in databases)
        {
            foreach (var view in await db.DatabaseViews.AsNoTracking().Where(v => v.DatabaseId == id).Select(v => new { v.Id, v.Version }).ToListAsync(ct))
                changes.Add("view", view.Id, "delete", view.Version + 1, actor);
            await db.DatabaseViews.Where(v => v.DatabaseId == id).ExecuteDeleteAsync(ct);
            await db.DatabaseRows.Where(r => r.DatabaseId == id).ExecuteDeleteAsync(ct);
            var record = await db.Databases.FirstOrDefaultAsync(d => d.PageId == id, ct);
            if (record is not null)
            {
                changes.Add("database", id, "delete", record.Version + 1, actor);
                db.Databases.Remove(record);
            }
        }
    }

    /// <summary>
    /// Rows deleted for good on their own (from the trash): their values go (the record stays,
    /// stamped, until the page is purged, so the query cache sees them leave) and their database's
    /// count is made again. Rows naming them in a relation keep the ids (as the planner does: no
    /// relation edits on a delete), which name nothing now; rollups reading them are made again by
    /// the worker.
    /// </summary>
    public static async Task DeleteRowsAsync(CgwDb db, ChangeLog changes, IEnumerable<Page> pages, Guid? actor, DateTimeOffset now, CancellationToken ct)
    {
        var rowPages = pages.Where(p => p.Kind == PageKinds.Row).ToList();
        if (rowPages.Count == 0) return;
        await db.SaveChangesAsync(ct);
        var ids = rowPages.Select(p => p.Id).ToList();
        var records = await db.DatabaseRows.Where(r => ids.Contains(r.PageId)).ToListAsync(ct);
        foreach (var group in records.GroupBy(r => r.DatabaseId))
        {
            var database = await db.Databases.FirstOrDefaultAsync(d => d.PageId == group.Key, ct);
            if (database is null) continue;
            database.RowsVersion++;
            database.UpdatedAt = now;
            foreach (var record in group)
            {
                record.Values = "{}";
                record.Computed = "{}";
                record.Seq = database.RowsVersion;
            }
            await db.SaveChangesAsync(ct);
            database.RowCount = await RowStore.CountAsync(db, database.PageId, ct);
            changes.Add("database", database.PageId, "upsert", database.Version, actor);
            // Databases whose rollups read this one (itself too) compute again without the rows.
            var text = database.PageId.ToString();
            await db.Databases.Where(d => d.Properties.Contains(text) && d.Properties.Contains("\"rollup\""))
                .ExecuteUpdateAsync(u => u.SetProperty(d => d.ComputePending, true), ct);
        }
    }
}
