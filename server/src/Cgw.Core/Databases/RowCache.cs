using System.Collections.Concurrent;
using Cgw.Core.Data;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Databases;

/// <summary>
/// The query engine's rows (contract section 4; DECISIONS.md, Phase 4: in memory): each
/// database's rows that can enter a query (not trashed, not templates, not deleted), kept per
/// database at the rows version they were read at. A query reads the database's
/// <c>RowsVersion</c>; when it has moved, only the rows written since are read (each row carries
/// the version it was last written at, <c>DatabaseRows.Seq</c>, indexed), so an edit costs the next
/// query one small read, not a reload. Bounded by rows held in all: the least recently used
/// databases are dropped first. Every API instance holds its own; none can serve a stale answer,
/// since the version is read from the database on every query.
/// </summary>
public sealed class DatabaseRowCache(IConfiguration configuration)
{
    /// <summary>A snapshot is never changed once published: queries read it without a lock.</summary>
    public sealed class Snapshot(long version, Dictionary<Guid, RowData> rows)
    {
        public long Version { get; } = version;
        public IReadOnlyDictionary<Guid, RowData> Rows { get; } = rows;
    }

    private sealed class Entry
    {
        public readonly SemaphoreSlim Lock = new(1, 1);
        public volatile Snapshot? Current;
        public long LastUsed;
    }

    private readonly ConcurrentDictionary<Guid, Entry> entries = new();
    private long clock;

    /// <summary>Rows held in all, across databases (Databases__CacheRows).</summary>
    public int Budget { get; } = int.TryParse(configuration["Databases:CacheRows"], out var n) && n > 0 ? n : 300_000;

    public int Held => entries.Values.Sum(e => e.Current?.Rows.Count ?? 0);

    private static bool Queryable(RowData row) => !row.Trashed && !row.IsTemplate;

    public async Task<Snapshot> RowsAsync(CgwDb db, WorkspaceDatabase record, CancellationToken ct)
    {
        var entry = entries.GetOrAdd(record.PageId, _ => new Entry());
        entry.LastUsed = Interlocked.Increment(ref clock);
        if (entry.Current is { } current && current.Version == record.RowsVersion) return current;
        await entry.Lock.WaitAsync(ct);
        try
        {
            current = entry.Current;
            if (current is not null && current.Version == record.RowsVersion) return current;
            Snapshot next;
            if (current is null || current.Version > record.RowsVersion)
            {
                var all = await RowStore.AllAsync(db, record.PageId, ct);
                next = new Snapshot(record.RowsVersion, all.Where(Queryable).ToDictionary(r => r.Id));
            }
            else
            {
                // Only what was written since: rows stamped after the version held (a row written
                // again since the version was read comes as it is now; the next refresh reads it again).
                var changed = await RowStore.ChangedAsync(db, record.PageId, current.Version, ct);
                var rows = new Dictionary<Guid, RowData>(current.Rows);
                foreach (var (row, gone) in changed)
                {
                    if (gone || !Queryable(row)) rows.Remove(row.Id);
                    else rows[row.Id] = row;
                }
                next = new Snapshot(record.RowsVersion, rows);
            }
            entry.Current = next;
            Evict(record.PageId);
            return next;
        }
        finally
        {
            entry.Lock.Release();
        }
    }

    /// <summary>The least recently used databases go until what is held fits the budget (the one in use stays).</summary>
    private void Evict(Guid keep)
    {
        var held = Held;
        if (held <= Budget) return;
        foreach (var (id, entry) in entries.OrderBy(e => e.Value.LastUsed).ToList())
        {
            if (held <= Budget) break;
            if (id == keep) continue;
            held -= entry.Current?.Rows.Count ?? 0;
            entries.TryRemove(id, out _);
        }
    }

    public void Forget(Guid databaseId) => entries.TryRemove(databaseId, out _);
}
