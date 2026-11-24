using System.Globalization;

namespace Cgw.Core.Databases;

/// <summary>
/// Phase 17, M17.5: a database's rows' numbers (DATA_MODEL.md, Databases): given when the server
/// first stores a row, in the insert's transaction, from <c>Databases.NextNumber</c>, never reused
/// or changed, none on a template; a unique id property shows a row's number with its prefix
/// (db/values.ts <c>uniqueIdText</c>).
/// </summary>
public static class UniqueIds
{
    public const int MaxPrefix = 20;

    /// <summary>A unique id as it reads: <c>TASK-12</c>, the number alone with no prefix, or null when the row has none yet.</summary>
    public static string? Text(PropertyDef def, long? number)
    {
        if (number is not { } n) return null;
        var prefix = def.Json["uniqueId"]?["prefix"] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<string>(out var text) ? text.Trim() : "";
        var digits = n.ToString(CultureInfo.InvariantCulture);
        return prefix.Length > 0 ? $"{prefix}-{digits}" : digits;
    }

    /// <summary>
    /// Every row stored before 0.17.0 numbered in the order it was made (its page's creation, then
    /// its id), templates left out, and each database's next number after its last: the migration's
    /// step, run once; a database with no rows starts at 1.
    /// </summary>
    public const string BackfillSql = """
        WITH numbered AS (
            SELECT r.[PageId], r.[Number], ROW_NUMBER() OVER (PARTITION BY r.[DatabaseId] ORDER BY p.[CreatedAt], p.[Id]) AS [n]
            FROM [DatabaseRows] r INNER JOIN [Pages] p ON p.[Id] = r.[PageId]
            WHERE p.[IsTemplate] = 0)
        UPDATE numbered SET [Number] = [n];
        UPDATE d SET d.[NextNumber] = COALESCE((SELECT MAX(r.[Number]) FROM [DatabaseRows] r WHERE r.[DatabaseId] = d.[PageId]), 0) + 1
        FROM [Databases] d;
        """;
}
