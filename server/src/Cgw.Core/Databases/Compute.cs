using System.Globalization;

namespace Cgw.Core.Databases;

/// <summary>What the rules read of a row: its page's fields and its values (a <c>RowRecord</c>'s).</summary>
public sealed class RowData
{
    public required Guid Id { get; init; }
    public Guid DatabaseId { get; set; }
    public string Title { get; set; } = "";
    public string OrderKey { get; set; } = "";
    public bool IsTemplate { get; set; }
    public bool Trashed { get; set; }
    public DateTimeOffset? CreatedAt { get; set; }
    public DateTimeOffset? UpdatedAt { get; set; }
    public string? CreatedBy { get; set; }
    public string? UpdatedBy { get; set; }
    public Dictionary<string, object> Values { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, object?> Computed { get; set; } = new(StringComparer.Ordinal);
    public long? ComputedVersion { get; set; }

    private string? idText;
    public string IdText => idText ??= Id.ToString();

    private string? normalTitle;
    /// <summary>The title as <c>normaliseText</c> gives it, made once (rows in the query cache are read by many queries).</summary>
    public string NormalTitle => normalTitle ??= TextNormaliser.Normalise(Title);
}

/// <summary>The rows a rollup reads: a database's schema and the rows of it it holds, by id; null when it is not held.</summary>
public interface IRelatedRows
{
    (Schema Schema, IReadOnlyDictionary<string, RowData> Rows)? Rows(string databaseId, IReadOnlyList<string> rowIds);
}

public sealed class NoRelatedRows : IRelatedRows
{
    public static readonly NoRelatedRows Instance = new();
    public (Schema Schema, IReadOnlyDictionary<string, RowData> Rows)? Rows(string databaseId, IReadOnlyList<string> rowIds) => null;
}

/// <summary>What a cell reads as for display, filters, sorts, groups and formulas (db/values.ts <c>cellOf</c>).</summary>
public static class Cells
{
    public static string Instant(DateTimeOffset at) =>
        DbDates.InstantText(Math.Floor((at.UtcDateTime - DateTime.UnixEpoch).TotalMilliseconds)) ?? "";

    private static DateValue? InstantCell(DateTimeOffset? at) => at is { } t && DbDates.ParsePoint(Instant(t)) is { } start ? new DateValue(start) : null;

    private static string[]? StringList(object? value)
    {
        if (Raw.List(value) is not { } list) return null;
        var strings = list.OfType<string>().Where(s => s.Length > 0).ToArray();
        return strings.Length > 0 ? strings : null;
    }

    /// <summary>
    /// What a cell of <paramref name="def"/> reads as on <paramref name="row"/>: empty is null; a
    /// value whose shape does not fit the type reads as empty; a deleted property reads as empty;
    /// formulas and rollups from <paramref name="computed"/> when it has the property, else the row's.
    /// </summary>
    public static object? Read(PropertyDef def, RowData row, IReadOnlyDictionary<string, object?>? computed = null)
    {
        if (def.Trashed) return null;
        var value = row.Values.GetValueOrDefault(def.Id);
        switch (def.Type)
        {
            case PropertyTypes.Title:
                return row.Title.Length > 0 ? row.Title : null;
            case PropertyTypes.CreatedTime:
                return InstantCell(row.CreatedAt);
            case PropertyTypes.LastEditedTime:
                return InstantCell(row.UpdatedAt);
            case PropertyTypes.CreatedBy:
                return string.IsNullOrEmpty(row.CreatedBy) ? null : new[] { row.CreatedBy };
            case PropertyTypes.LastEditedBy:
                return string.IsNullOrEmpty(row.UpdatedBy) ? null : new[] { row.UpdatedBy };
            case PropertyTypes.Formula:
            case PropertyTypes.Rollup:
                if (computed is not null && computed.TryGetValue(def.Id, out var mine)) return mine;
                return row.Computed.GetValueOrDefault(def.Id);
            case PropertyTypes.Checkbox:
                return value is true;
            case PropertyTypes.Number:
                return value is double d && double.IsFinite(d) ? d : null;
            case PropertyTypes.Text or PropertyTypes.Url or PropertyTypes.Email or PropertyTypes.Phone:
                return value is string { Length: > 0 } s ? s : null;
            case PropertyTypes.Date:
            {
                if (!Raw.IsObject(value) || Raw.Field(value, "start") is not string start || !DbDates.IsPoint(start)) return null;
                var end = Raw.Field(value, "end") is string e && e.Length > 0 && DbDates.IsPoint(e) ? e : null;
                // A stored date that is already what it reads as is read as itself.
                return value is DateValue stored && stored.End == end ? stored : new DateValue(start, end);
            }
            case PropertyTypes.Select or PropertyTypes.Status:
                return value is string id && def.OptionIndex(id) >= 0 ? id : null;
            case PropertyTypes.MultiSelect:
            {
                var list = StringList(value)?.Where(id => def.OptionIndex(id) >= 0).Distinct(StringComparer.Ordinal).ToArray();
                return list is { Length: > 0 } ? list : null;
            }
            case PropertyTypes.Person or PropertyTypes.Files or PropertyTypes.Relation:
                return StringList(value);
            default:
                return null;
        }
    }

    /// <summary>Whether a cell reads as empty: null, '', [] or an error.</summary>
    public static bool IsEmpty(object? cell) => cell is null || cell is "" || Raw.List(cell) is { Count: 0 } || Raw.IsError(cell);

    /// <summary>A cell as formulas read it: options by name (db/rollup.ts <c>formulaCell</c>).</summary>
    public static object? FormulaCell(PropertyDef def, object? cell)
    {
        if (cell is null) return null;
        if (def.Type is PropertyTypes.Select or PropertyTypes.Status)
            return cell is string id ? def.Options.FirstOrDefault(o => o.Id == id)?.Name : null;
        if (def.Type == PropertyTypes.MultiSelect && Raw.List(cell) is { } ids)
        {
            var names = ids.Select(id => def.Options.FirstOrDefault(o => o.Id == id as string)?.Name ?? "").Where(n => n.Length > 0).ToArray();
            return names.Length > 0 ? names : null;
        }
        return cell;
    }
}

/// <summary>Rollups (db/rollup.ts): a property of the related rows, reduced by a function.</summary>
public static class Rollups
{
    public static readonly HashSet<string> Functions =
    [
        "count", "countValues", "countUnique", "countEmpty", "countNotEmpty", "percentEmpty", "percentNotEmpty",
        "sum", "average", "median", "min", "max", "range", "earliest", "latest", "checked", "unchecked", "percentChecked", "showOriginal",
    ];

    private static readonly HashSet<string> NumberFunctions = ["sum", "average", "median", "min", "max", "range"];
    private static readonly HashSet<string> DateFunctions = ["earliest", "latest"];
    private static readonly HashSet<string> CheckFunctions = ["checked", "unchecked", "percentChecked"];

    private static CellError Error(string code) => new(code);

    private static string UniqueKey(object? cell) => cell switch
    {
        double d => "n:" + JsNumber.ToString(d),
        bool b => "b:" + (b ? "true" : "false"),
        string s => "t:" + s,
        _ when Raw.IsObject(cell) => "d:" + Formulas.FormatValue(cell is DateValue dv ? dv : DbDates.Coerce(cell)),
        _ => "",
    };

    private static (string? Type, string? Error) TargetType(Schema schema, PropertyDef def)
    {
        if (def.Type == PropertyTypes.Formula)
        {
            if (!schema.Compiled.Formulas.TryGetValue(def.Id, out var formula)) return (null, Formulas.UnknownProperty);
            return formula.Error is { } error ? (null, error) : (formula.Type ?? "empty", null);
        }
        if (def.Type == PropertyTypes.Rollup) return (Formulas.RollupType(def.RollupFunction), null);
        return (Formulas.TypeOfProperty(def.Type), null);
    }

    private static object? Finite(double n) => double.IsFinite(n) ? (n == 0 ? 0.0 : n) : Error(Formulas.Range);

    /// <summary>A rollup's result on a row; <c>Missing</c> when the related rows are not held.</summary>
    public static (bool Held, object? Value) Compute(Schema schema, PropertyDef def, RowData row, IRelatedRows related)
    {
        var relation = def.HasRollup && def.RollupRelation is { } r ? schema[r] : null;
        if (!def.HasRollup || relation is null || relation.Trashed || relation.Type != PropertyTypes.Relation || !relation.HasRelation)
            return (true, Error(Formulas.UnknownProperty));
        var ids = Cells.Read(relation, row) as string[] ?? [];
        var got = related.Rows(relation.RelationDatabase ?? "", ids);
        if (got is not { } held) return (false, null);
        var target = def.RollupTarget is { } t ? held.Schema[t] : null;
        if (target is null || target.Trashed) return (true, Error(Formulas.UnknownProperty));
        var (kind, kindError) = TargetType(held.Schema, target);
        if (kindError is not null) return (true, Error(kindError));
        var fn = def.RollupFunction ?? "";
        bool Fits(string want) => kind == want || kind == "empty";
        if (NumberFunctions.Contains(fn) && !Fits("number")) return (true, Error(Formulas.TypeError));
        if (DateFunctions.Contains(fn) && !Fits("date")) return (true, Error(Formulas.TypeError));
        if (CheckFunctions.Contains(fn) && !Fits("boolean")) return (true, Error(Formulas.TypeError));

        var rows = new List<RowData>();
        foreach (var id in ids.Distinct(StringComparer.Ordinal))
            if (held.Rows.GetValueOrDefault(id) is { } x && !x.Trashed && !x.IsTemplate) rows.Add(x);
        var cells = rows.Select(x => Cells.Read(target, x)).ToList();
        var count = rows.Count;
        var empties = cells.Count(Cells.IsEmpty);
        var numbers = cells.OfType<double>().ToList();
        object? Fraction(int n) => count > 0 ? (double)n / count : null;
        var isChecked = cells.Count(c => c is true);
        switch (fn)
        {
            case "count": return (true, (double)count);
            case "countValues": return (true, (double)cells.Sum(c => Raw.List(c) is { } list ? list.Count : Cells.IsEmpty(c) ? 0 : 1));
            case "countUnique":
            {
                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var c in cells)
                {
                    if (Cells.IsEmpty(c)) continue;
                    if (Raw.List(c) is { } list)
                        foreach (var item in list) keys.Add("s:" + item);
                    else keys.Add(UniqueKey(c));
                }
                return (true, (double)keys.Count);
            }
            case "countEmpty": return (true, (double)empties);
            case "countNotEmpty": return (true, (double)(count - empties));
            case "percentEmpty": return (true, Fraction(empties));
            case "percentNotEmpty": return (true, Fraction(count - empties));
            case "sum": return (true, Finite(numbers.Aggregate(0.0, (a, b) => a + b)));
            case "average": return (true, numbers.Count > 0 ? Finite(numbers.Aggregate(0.0, (a, b) => a + b) / numbers.Count) : null);
            case "median":
            {
                if (numbers.Count == 0) return (true, null);
                var sorted = numbers.Order().ToList();
                var mid = sorted.Count >> 1;
                return (true, sorted.Count % 2 == 1 ? sorted[mid] : Finite((sorted[mid - 1] + sorted[mid]) / 2));
            }
            case "min": return (true, numbers.Count > 0 ? numbers.Min() : null);
            case "max": return (true, numbers.Count > 0 ? numbers.Max() : null);
            case "range": return (true, numbers.Count > 0 ? Finite(numbers.Max() - numbers.Min()) : null);
            case "earliest":
            case "latest":
            {
                DateValue? best = null;
                foreach (var c in cells)
                {
                    if (c is not DateValue d) continue;
                    var better = best is null || (fn == "earliest" ? DbDates.PointMs(d.Start) < DbDates.PointMs(best.Start) : DbDates.PointMs(d.Start) > DbDates.PointMs(best.Start));
                    if (better) best = d;
                }
                return (true, best is null ? null : new DateValue(best.Start));
            }
            case "checked": return (true, (double)isChecked);
            case "unchecked": return (true, (double)(count - isChecked));
            case "percentChecked": return (true, Fraction(isChecked));
            case "showOriginal":
            {
                var items = new List<string>();
                foreach (var c in cells)
                {
                    if (Cells.IsEmpty(c)) continue;
                    var value = Cells.FormulaCell(target, c);
                    if (value is string[] list) items.AddRange(list);
                    else if (value is not null) items.Add(Formulas.FormatValue(value));
                }
                return (true, items.Count > 0 ? items.ToArray() : null);
            }
            default:
                return (true, Error(Formulas.UnknownProperty));
        }
    }
}

/// <summary>
/// A row's formulas and rollups (db/compute.ts <c>computeRow</c>): rollups first, then formulas
/// in dependency order; a rollup whose related rows are not held is left out. Deleted properties
/// compute nothing.
/// </summary>
public static class Compute
{
    /// <summary>A value read by a formula, made to fit its static kind (else empty).</summary>
    private static object? Fit(object? value, string type)
    {
        if (value is null || Raw.IsError(value)) return null;
        switch (type)
        {
            case "number": return value is double d && double.IsFinite(d) ? d : null;
            case "text": return value as string;
            case "boolean": return value is bool b ? b : null;
            case "list": return Raw.List(value) is { } list ? list.OfType<string>().ToArray() : null;
            case "date":
            {
                if (!Raw.IsObject(value) || Raw.Field(value, "start") is not string start || !DbDates.IsPoint(start)) return null;
                return Raw.Field(value, "end") is string end && end.Length > 0 && DbDates.IsPoint(end) ? new DateValue(start, end) : new DateValue(start);
            }
            default:
                return value switch
                {
                    string or double or bool or string[] or DateValue => value,
                    _ when Raw.List(value) is { } items => items.OfType<string>().ToArray(),
                    _ when Raw.IsObject(value) => DbDates.Coerce(value),
                    _ => null,
                };
        }
    }

    public static Dictionary<string, object?> Row(Schema schema, RowData row, IRelatedRows related)
    {
        var compiled = schema.Compiled;
        var results = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var def in compiled.Rollups)
        {
            var (held, value) = Rollups.Compute(schema, def, row, related);
            if (held) results[def.Id] = value;
        }
        object? Read(PropertyDef def)
        {
            if (def.Type == PropertyTypes.Formula) return results.GetValueOrDefault(def.Id);
            if (def.Type == PropertyTypes.Rollup)
                return results.TryGetValue(def.Id, out var mine) ? mine : row.Computed.GetValueOrDefault(def.Id);
            return Cells.FormulaCell(def, Cells.Read(def, row));
        }
        foreach (var id in compiled.Order)
        {
            var formula = compiled.Formulas[id];
            if (formula.Error is { } error)
            {
                results[id] = new CellError(error);
                continue;
            }
            if (formula.Tree is null)
            {
                results[id] = null;
                continue;
            }
            try
            {
                var value = Formulas.Evaluate(formula.Tree, (propId, type) =>
                {
                    var cell = Read(compiled.Props[propId]);
                    if (Raw.IsError(cell)) throw new Formulas.FormulaException(Raw.ErrorOf(cell)!);
                    return Fit(cell, type);
                });
                results[id] = Formulas.Finish(value);
            }
            catch (Formulas.FormulaException e)
            {
                results[id] = new CellError(e.Code);
            }
        }
        return results;
    }

    public const string ExpressionId = "\u0000expression";

    /// <summary>An expression evaluated on a row as one more formula property of its database (compute.ts <c>evaluateFormula</c>).</summary>
    public static (object? Value, string? Type) Expression(Schema schema, RowData row, string expression, IRelatedRows? related = null)
    {
        var defs = schema.Properties.ToList();
        defs.Add(PropertyDef.Parse(new System.Text.Json.Nodes.JsonObject
        {
            ["id"] = ExpressionId,
            ["name"] = "",
            ["type"] = PropertyTypes.Formula,
            ["formula"] = new System.Text.Json.Nodes.JsonObject { ["expression"] = expression },
        }));
        var with = new Schema(schema.Id, schema.Version, defs, schema.IdText);
        var value = Row(with, row, related ?? NoRelatedRows.Instance).GetValueOrDefault(ExpressionId);
        return (value, with.Compiled.Formulas[ExpressionId].Type);
    }

    public static bool Same(IReadOnlyDictionary<string, object?> a, IReadOnlyDictionary<string, object?> b) =>
        a.Count == b.Count && a.All(p => b.TryGetValue(p.Key, out var other) && ValueJson.Same(p.Value, other));

    internal static string Iso(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
