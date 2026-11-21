using System.Text;
using System.Text.RegularExpressions;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Ai;

/// <summary>
/// A row's property values as embedded (Phase 13, M13.3; decisions, 2026-11-21): text, number,
/// select, status, date, checkbox, URL and email values, and formulas and rollups, as one
/// "Name: value" line each in the database's order, before the row's own text; never a person,
/// created-by or edited-by value, nor a formula or rollup that reads one (a rollup of a relation or
/// files neither, whose result would be ids). Multi-select, phone, a relation's titles and files are
/// left out. Read as the API and the worker read rows (stored values and computed results); the same
/// text for the embedding and for a hit's snippet.
/// </summary>
public static partial class EmbeddingValues
{
    /// <summary>The longest a value's line is (its characters past it cut, a word kept whole).</summary>
    public const int MaxValue = 1_000;

    private static readonly HashSet<string> Direct = new(StringComparer.Ordinal)
    {
        PropertyTypes.Text, PropertyTypes.Number, PropertyTypes.Select, PropertyTypes.Status,
        PropertyTypes.Date, PropertyTypes.Checkbox, PropertyTypes.Url, PropertyTypes.Email,
    };

    private static bool People(string type) => type is PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy;

    [GeneratedRegex("""prop\(\s*"([^"]*)"\s*\)""")]
    private static partial Regex PropReference();

    private static readonly CsvLookups NoLookups = new();

    /// <summary>The properties whose values a row of <paramref name="schema"/> embeds, in the database's order (the title is the chunk's head, not a value).</summary>
    public static async Task<IReadOnlyList<PropertyDef>> PropertiesAsync(Schema schema, Func<Guid, Task<Schema?>> schemas)
    {
        var list = new List<PropertyDef>();
        foreach (var def in schema.Properties)
            if (!def.Trashed && def.Type != PropertyTypes.Title && await EmbeddedAsync(schema, def, schemas))
                list.Add(def);
        return list;
    }

    private static async Task<bool> EmbeddedAsync(Schema schema, PropertyDef def, Func<Guid, Task<Schema?>> schemas)
    {
        if (Direct.Contains(def.Type)) return true;
        return def.Type is PropertyTypes.Formula or PropertyTypes.Rollup && await FreeOfPeopleAsync(schema, def, schemas, [], 0);
    }

    /// <summary>
    /// Whether what is read from <paramref name="def"/> holds nothing of a person: not a person's
    /// type; a formula of such properties only; a rollup over a live relation of such a property that
    /// is no relation and no files. A cycle, a property gone or too deep a chain holds something.
    /// </summary>
    private static async Task<bool> FreeOfPeopleAsync(Schema schema, PropertyDef def, Func<Guid, Task<Schema?>> schemas, HashSet<string> seen, int depth)
    {
        if (def.Trashed || People(def.Type)) return false;
        if (depth > 8 || !seen.Add($"{schema.IdText}/{def.Id}")) return false;
        switch (def.Type)
        {
            case PropertyTypes.Formula:
                foreach (Match match in PropReference().Matches(def.Expression ?? ""))
                    if (schema.Live(match.Groups[1].Value) is { } read && !await FreeOfPeopleAsync(schema, read, schemas, seen, depth + 1))
                        return false;
                return true;
            case PropertyTypes.Rollup:
            {
                if (def.RollupRelation is not { } relationId || schema.Live(relationId) is not { Type: PropertyTypes.Relation } relation
                    || relation.RelationDatabaseId is not { } target) return false;
                if (await schemas(target) is not { } other || def.RollupTarget is not { } targetId || other.Live(targetId) is not { } targetDef) return false;
                if (targetDef.Type is PropertyTypes.Relation or PropertyTypes.Files) return false;
                return await FreeOfPeopleAsync(other, targetDef, schemas, seen, depth + 1);
            }
            default:
                return true;
        }
    }

    /// <summary>The row's values as lines, "Name: value", one each that is not empty; '' when none.</summary>
    public static string Text(IReadOnlyList<PropertyDef> properties, RowData row)
    {
        var text = new StringBuilder();
        foreach (var def in properties)
        {
            var value = EmbeddingText.TitleLine(Csv.CellText(def, row, NoLookups));
            if (value.Length == 0) continue;
            if (value.Length > MaxValue)
            {
                var cut = value.LastIndexOf(' ', MaxValue - 1);
                var end = cut > MaxValue / 2 ? cut : MaxValue;
                if (char.IsHighSurrogate(value[end - 1])) end--;
                value = value[..end];
            }
            var name = EmbeddingText.TitleLine(def.Name);
            if (text.Length > 0) text.Append('\n');
            text.Append(name.Length > 0 ? name + ": " + value : value);
        }
        return text.ToString();
    }

    /// <summary>What of a row is cut into chunks after its title: its values, a blank line, then its own text.</summary>
    public static string Body(string values, string? text) =>
        values.Length == 0 ? text ?? "" : string.IsNullOrWhiteSpace(text) ? values : values + "\n\n" + text;

    /// <summary>
    /// Each row's values as lines (<see cref="Text"/>), for rows of databases of the caller's tenant
    /// scope; a row not found, or of a database gone, is absent. Also each row's database version,
    /// which the vectors are kept by (a property renamed or added changes every row's text).
    /// </summary>
    public static async Task<Dictionary<Guid, (string Text, long SchemaVersion)>> ForRowsAsync(CgwDb db, IReadOnlyCollection<Guid> rowIds, CancellationToken ct)
    {
        var answer = new Dictionary<Guid, (string, long)>();
        if (rowIds.Count == 0) return answer;
        var rows = await RowStore.ByIdsAsync(db, rowIds, ct);
        var records = new Dictionary<Guid, WorkspaceDatabase?>();
        async Task<WorkspaceDatabase?> RecordAsync(Guid id)
        {
            if (records.TryGetValue(id, out var known)) return known;
            return records[id] = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == id, ct);
        }
        async Task<Schema?> SchemaAsync(Guid id) => await RecordAsync(id) is { } record ? DatabaseService.SchemaOf(record) : null;
        var properties = new Dictionary<Guid, IReadOnlyList<PropertyDef>>();
        foreach (var row in rows)
        {
            if (await RecordAsync(row.DatabaseId) is not { } record) continue;
            if (!properties.TryGetValue(row.DatabaseId, out var list))
                properties[row.DatabaseId] = list = await PropertiesAsync(DatabaseService.SchemaOf(record), SchemaAsync);
            answer[row.Id] = (Text(list, row), record.Version);
        }
        return answer;
    }
}
