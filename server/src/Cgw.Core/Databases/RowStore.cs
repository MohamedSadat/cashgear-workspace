using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Databases;

/// <summary>
/// Rows read and written many at a time: a type change converting every row, a recompute, the
/// query cache's refresh, an import. Writes are one statement per few thousand rows (OPENJSON),
/// never one per row.
/// </summary>
public static class RowStore
{
    private sealed record Raw(
        Guid PageId, Guid DatabaseId, string Values, string Computed, long? ComputedVersion, long Seq,
        string Title, string OrderKey, bool IsTemplate, DateTimeOffset? TrashedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
        Guid CreatedBy, Guid UpdatedBy, DateTimeOffset? DeletedAt);

    /// <summary>Rows joined to their pages, filtered before the projection (EF cannot filter on a projected record).</summary>
    private static IQueryable<Raw> Query(CgwDb db, System.Linq.Expressions.Expression<Func<RowAndPage, bool>> where) =>
        db.DatabaseRows.AsNoTracking().Join(db.Pages.AsNoTracking(), r => r.PageId, p => p.Id, (r, p) => new RowAndPage { Row = r, Page = p })
            .Where(where)
            .Select(x => new Raw(
                x.Row.PageId, x.Row.DatabaseId, x.Row.Values, x.Row.Computed, x.Row.ComputedVersion, x.Row.Seq, x.Page.Title, x.Page.OrderKey,
                x.Page.IsTemplate, x.Page.TrashedAt, x.Page.CreatedAt, x.Page.UpdatedAt, x.Page.CreatedBy, x.Page.UpdatedBy, x.Page.DeletedAt));

    public sealed class RowAndPage
    {
        public DatabaseRow Row { get; init; } = null!;
        public Page Page { get; init; } = null!;
    }

    public static RowData ToData(Page page, DatabaseRow row, Dictionary<string, object>? values = null, Dictionary<string, object?>? computed = null) => new()
    {
        Id = page.Id,
        DatabaseId = row.DatabaseId,
        Title = page.Title,
        OrderKey = page.OrderKey,
        IsTemplate = page.IsTemplate,
        Trashed = page.TrashedAt is not null,
        CreatedAt = page.CreatedAt,
        UpdatedAt = page.UpdatedAt,
        CreatedBy = page.CreatedBy == Guid.Empty ? null : page.CreatedBy.ToString(),
        UpdatedBy = page.UpdatedBy == Guid.Empty ? null : page.UpdatedBy.ToString(),
        Values = values ?? ValueJson.ReadMap(row.Values),
        Computed = computed ?? ValueJson.ReadCells(row.Computed),
        ComputedVersion = row.ComputedVersion,
    };

    private static RowData ToData(Raw r) => new()
    {
        Id = r.PageId,
        DatabaseId = r.DatabaseId,
        Title = r.Title,
        OrderKey = r.OrderKey,
        IsTemplate = r.IsTemplate,
        Trashed = r.TrashedAt is not null,
        CreatedAt = r.CreatedAt,
        UpdatedAt = r.UpdatedAt,
        CreatedBy = r.CreatedBy == Guid.Empty ? null : r.CreatedBy.ToString(),
        UpdatedBy = r.UpdatedBy == Guid.Empty ? null : r.UpdatedBy.ToString(),
        Values = ValueJson.ReadMap(r.Values),
        Computed = ValueJson.ReadCells(r.Computed),
        ComputedVersion = r.ComputedVersion,
    };

    /// <summary>Every row of a database not deleted for good, trashed rows and templates included.</summary>
    public static async Task<List<RowData>> AllAsync(CgwDb db, Guid databaseId, CancellationToken ct) =>
        (await Query(db, x => x.Row.DatabaseId == databaseId && x.Page.DeletedAt == null).ToListAsync(ct)).Select(ToData).ToList();

    /// <summary>These rows, those not deleted for good.</summary>
    public static async Task<List<RowData>> ByIdsAsync(CgwDb db, IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = new List<RowData>();
        foreach (var chunk in Chunked.Of(ids.Distinct()))
            list.AddRange((await Query(db, x => chunk.Contains(x.Row.PageId) && x.Page.DeletedAt == null).ToListAsync(ct)).Select(ToData));
        return list;
    }

    /// <summary>The rows written after <paramref name="since"/>, deleted ones too (the query cache's refresh).</summary>
    public static async Task<List<(RowData Row, bool Gone)>> ChangedAsync(CgwDb db, Guid databaseId, long since, CancellationToken ct) =>
        (await Query(db, x => x.Row.DatabaseId == databaseId && x.Row.Seq > since).ToListAsync(ct))
            .Select(r => (ToData(r), r.DeletedAt is not null)).ToList();

    /// <summary>A row's columns to write: null leaves one as it is.</summary>
    public sealed record Write(Guid Id, string? Values = null, string? Versions = null, string? Computed = null, long? ComputedVersion = null);

    /// <summary>Writes rows of one database in a few statements, each stamped with <paramref name="seq"/>.</summary>
    public static async Task WriteAsync(CgwDb db, IReadOnlyList<Write> rows, long seq, CancellationToken ct)
    {
        foreach (var chunk in rows.Chunk(2000))
        {
            var json = JsonSerializer.Serialize(chunk.Select(r => new
            {
                i = Convert.ToHexString(GuidBytes.ToBytes(r.Id)),
                v = r.Values,
                p = r.Versions,
                c = r.Computed,
                cv = r.ComputedVersion,
            }));
            await db.Database.ExecuteSqlRawAsync("""
                UPDATE r SET
                    r.[Values] = COALESCE(j.[v], r.[Values]),
                    r.[PropertyVersions] = COALESCE(j.[p], r.[PropertyVersions]),
                    r.[Computed] = COALESCE(j.[c], r.[Computed]),
                    r.[ComputedVersion] = COALESCE(j.[cv], r.[ComputedVersion]),
                    r.[Seq] = @seq
                FROM [DatabaseRows] r
                INNER JOIN OPENJSON(@rows) WITH ([i] char(32) '$.i', [v] nvarchar(max) '$.v', [p] nvarchar(max) '$.p', [c] nvarchar(max) '$.c', [cv] bigint '$.cv') j
                    ON r.[PageId] = CONVERT(binary(16), j.[i], 2)
                """,
                [new SqlParameter("@rows", System.Data.SqlDbType.NVarChar, -1) { Value = json }, new SqlParameter("@seq", System.Data.SqlDbType.BigInt) { Value = seq }], ct);
        }
    }

    /// <summary>Raises these pages' versions (and, for an edit, last edited time and by) in a few statements.</summary>
    public static async Task BumpPagesAsync(CgwDb db, IReadOnlyCollection<Guid> ids, Guid? editor, DateTimeOffset now, CancellationToken ct)
    {
        foreach (var chunk in ids.Chunk(5000))
        {
            var json = JsonSerializer.Serialize(chunk.Select(id => Convert.ToHexString(GuidBytes.ToBytes(id))));
            var parameters = new List<SqlParameter> { new("@ids", System.Data.SqlDbType.NVarChar, -1) { Value = json } };
            var edit = "";
            if (editor is { } who)
            {
                edit = ", p.[UpdatedAt] = @now, p.[UpdatedBy] = @by";
                parameters.Add(new SqlParameter("@now", System.Data.SqlDbType.DateTimeOffset) { Value = now });
                parameters.Add(new SqlParameter("@by", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(who) });
            }
            // Only constants go into the text; every value is a parameter.
            var sql = $"""
                UPDATE p SET p.[Version] = p.[Version] + 1{edit}
                FROM [Pages] p INNER JOIN OPENJSON(@ids) j ON p.[Id] = CONVERT(binary(16), j.[value], 2)
                """;
            await db.Database.ExecuteSqlRawAsync(sql, parameters, ct);
        }
    }

    /// <summary>A new row as an import makes it: its page's own fields and its values' JSON.</summary>
    public sealed record NewRow(Guid Id, string OrderKey, string Title, string Values, string Versions, string Computed);

    /// <summary>
    /// New rows of one database inserted set-based (an import): their pages and their values, one
    /// statement each per batch, every row at version 1, made by <paramref name="by"/> at
    /// <paramref name="now"/>, stamped <paramref name="seq"/>. Call inside the batch's transaction.
    /// </summary>
    public static async Task InsertAsync(CgwDb db, Guid workspaceId, Guid sectionId, Guid databaseId, IReadOnlyList<NewRow> rows, Guid by, DateTimeOffset now, long computedVersion, long seq, CancellationToken ct)
    {
        foreach (var chunk in rows.Chunk(2000))
        {
            var json = JsonSerializer.Serialize(chunk.Select(r => new
            {
                i = Convert.ToHexString(GuidBytes.ToBytes(r.Id)),
                o = r.OrderKey,
                t = r.Title,
                s = TextNormaliser.Normalise(r.Title),
                v = r.Values,
                p = r.Versions,
                c = r.Computed,
            }));
            SqlParameter[] Parameters() =>
            [
                new("@rows", System.Data.SqlDbType.NVarChar, -1) { Value = json },
                new("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(workspaceId) },
                new("@section", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(sectionId) },
                new("@db", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(databaseId) },
                new("@by", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(by) },
                new("@now", System.Data.SqlDbType.DateTimeOffset) { Value = now },
                new("@cv", System.Data.SqlDbType.BigInt) { Value = computedVersion },
                new("@seq", System.Data.SqlDbType.BigInt) { Value = seq },
            ];
            await db.Database.ExecuteSqlRawAsync("""
                INSERT INTO [Pages] ([Id], [WorkspaceId], [SectionId], [ParentPageId], [OrderKey], [Kind], [Title], [SearchTitle], [IsTemplate],
                    [Version], [DocSeq], [DocHeadSeq], [DocSchemaVersion], [DocEpoch], [DocStateHashSeq], [Restricted], [CreatedBy], [UpdatedBy], [CreatedAt], [UpdatedAt])
                SELECT CONVERT(binary(16), j.[i], 2), @ws, @section, @db, j.[o], N'row', j.[t], j.[s], 0,
                    1, 0, 0, 1, 0, 0, 0, @by, @by, @now, @now
                FROM OPENJSON(@rows) WITH ([i] char(32) '$.i', [o] nvarchar(200) '$.o', [t] nvarchar(1000) '$.t', [s] nvarchar(1000) '$.s') j;
                INSERT INTO [DatabaseRows] ([PageId], [WorkspaceId], [DatabaseId], [Values], [PropertyVersions], [Computed], [ComputedVersion], [Seq])
                SELECT CONVERT(binary(16), j.[i], 2), @ws, @db, j.[v], j.[p], j.[c], @cv, @seq
                FROM OPENJSON(@rows) WITH ([i] char(32) '$.i', [v] nvarchar(max) '$.v', [p] nvarchar(max) '$.p', [c] nvarchar(max) '$.c') j;
                """, Parameters(), ct);
        }
    }

    /// <summary>
    /// One statement per few thousand pages: <c>UPDATE p SET {set}</c> over these ids. Only
    /// parameter names and constants go into <paramref name="set"/>.
    /// </summary>
    public static async Task UpdatePagesAsync(CgwDb db, IReadOnlyCollection<Guid> ids, string set, IReadOnlyList<SqlParameter> parameters, CancellationToken ct)
    {
        foreach (var chunk in ids.Chunk(5000))
        {
            var json = JsonSerializer.Serialize(chunk.Select(id => Convert.ToHexString(GuidBytes.ToBytes(id))));
            var all = new List<SqlParameter> { new("@ids", System.Data.SqlDbType.NVarChar, -1) { Value = json } };
            // A parameter belongs to one command: each statement gets its own copies.
            all.AddRange(parameters.Select(p => new SqlParameter(p.ParameterName, p.SqlDbType, p.Size) { Value = p.Value }));
            var sql = $"""
                UPDATE p SET {set}
                FROM [Pages] p INNER JOIN OPENJSON(@ids) j ON p.[Id] = CONVERT(binary(16), j.[value], 2)
                """;
            await db.Database.ExecuteSqlRawAsync(sql, all, ct);
        }
    }

    /// <summary>Rows not trashed and not templates, counted again (after many rows changed at once).</summary>
    public static Task<int> CountAsync(CgwDb db, Guid databaseId, CancellationToken ct) =>
        db.DatabaseRows.Where(r => r.DatabaseId == databaseId)
            .Join(db.Pages, r => r.PageId, p => p.Id, (r, p) => p)
            .CountAsync(p => p.TrashedAt == null && p.DeletedAt == null && !p.IsTemplate, ct);

    /// <summary>The rows of these databases (by their index), as page ids, those whose pages pass <paramref name="where"/>.</summary>
    public static async Task<List<Guid>> RowIdsAsync(CgwDb db, IReadOnlyCollection<Guid> databaseIds, System.Linq.Expressions.Expression<Func<Page, bool>> where, CancellationToken ct)
    {
        var ids = new List<Guid>();
        foreach (var chunk in Chunked.Of(databaseIds))
            ids.AddRange(await db.DatabaseRows.AsNoTracking().Where(r => chunk.Contains(r.DatabaseId))
                .Join(db.Pages.AsNoTracking().Where(where), r => r.PageId, p => p.Id, (r, p) => p.Id)
                .ToListAsync(ct));
        return ids;
    }
}
