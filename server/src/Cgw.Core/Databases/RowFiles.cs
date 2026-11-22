using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Databases;

/// <summary>
/// The index of rows' files (Phase 14, M14.1; <see cref="DatabaseRowFile"/>): what a row's files
/// cells hold, written with its values in the same transaction on every server path (the ops' flush,
/// a type change, a deletion for good, the purge), so a member's read, the clean-up and a site's
/// check need not scan the rows' values. Every files property counts, a deleted one too.
/// </summary>
public static class RowFiles
{
    /// <summary>The (property, asset) pairs a row's values hold in the schema's files properties, each once.</summary>
    public static List<(string PropertyId, Guid AssetId)> Of(Schema schema, IReadOnlyDictionary<string, object> values)
    {
        var pairs = new List<(string, Guid)>();
        foreach (var def in schema.Properties)
        {
            if (def.Type != PropertyTypes.Files || values.GetValueOrDefault(def.Id) is not string[] ids) continue;
            foreach (var id in ids)
                if (Guid.TryParse(id, out var asset) && !pairs.Contains((def.Id, asset))) pairs.Add((def.Id, asset));
        }
        return pairs;
    }

    /// <summary>Whether two lists of pairs hold the same, in any order.</summary>
    public static bool Same(IReadOnlyCollection<(string, Guid)> a, IReadOnlyCollection<(string, Guid)> b) =>
        a.Count == b.Count && a.All(b.Contains);

    /// <summary>One row's files as they are now: its index rows replaced, set-based. Call inside the write's transaction.</summary>
    public sealed record Entry(Guid RowId, IReadOnlyList<(string PropertyId, Guid AssetId)> Files);

    /// <summary>
    /// Replaces these rows' index rows (of one database) with the files given, in two statements a
    /// few thousand rows; <paramref name="fresh"/> skips the delete for rows just made.
    /// </summary>
    public static async Task ReplaceAsync(CgwDb db, Guid workspaceId, Guid databaseId, IReadOnlyList<Entry> rows, CancellationToken ct, bool fresh = false)
    {
        foreach (var chunk in rows.Chunk(2000))
        {
            if (!fresh)
            {
                var ids = JsonSerializer.Serialize(chunk.Select(r => Convert.ToHexString(GuidBytes.ToBytes(r.RowId))));
                await db.Database.ExecuteSqlRawAsync("""
                    DELETE f FROM [DatabaseRowFiles] f INNER JOIN OPENJSON(@ids) j ON f.[RowId] = CONVERT(binary(16), j.[value], 2)
                    """, [new SqlParameter("@ids", System.Data.SqlDbType.NVarChar, -1) { Value = ids }], ct);
            }
            var files = chunk.SelectMany(r => r.Files.Select(f => new
            {
                r = Convert.ToHexString(GuidBytes.ToBytes(r.RowId)),
                p = f.PropertyId,
                a = Convert.ToHexString(GuidBytes.ToBytes(f.AssetId)),
            })).ToList();
            if (files.Count == 0) continue;
            await db.Database.ExecuteSqlRawAsync("""
                INSERT INTO [DatabaseRowFiles] ([RowId], [PropertyId], [AssetId], [DatabaseId], [WorkspaceId])
                SELECT CONVERT(binary(16), j.[r], 2), j.[p], CONVERT(binary(16), j.[a], 2), @db, @ws
                FROM OPENJSON(@files) WITH ([r] char(32) '$.r', [p] varchar(16) '$.p', [a] char(32) '$.a') j
                """,
                [
                    new SqlParameter("@files", System.Data.SqlDbType.NVarChar, -1) { Value = JsonSerializer.Serialize(files) },
                    new SqlParameter("@db", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(databaseId) },
                    new SqlParameter("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(workspaceId) },
                ], ct);
        }
    }

    /// <summary>These rows hold no files any more (deleted for good).</summary>
    public static async Task ClearAsync(CgwDb db, IReadOnlyCollection<Guid> rowIds, CancellationToken ct)
    {
        foreach (var chunk in Chunked.Of(rowIds))
            await db.DatabaseRowFiles.Where(f => chunk.Contains(f.RowId)).ExecuteDeleteAsync(ct);
    }

    /// <summary>A property that is not files any more holds none in any row.</summary>
    public static async Task ClearPropertyAsync(CgwDb db, Guid databaseId, string propertyId, CancellationToken ct) =>
        await db.DatabaseRowFiles.Where(f => f.DatabaseId == databaseId && f.PropertyId == propertyId).ExecuteDeleteAsync(ct);
}
