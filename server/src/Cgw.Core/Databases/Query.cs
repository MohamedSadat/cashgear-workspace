using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cgw.Core.Databases;

/// <summary>What a query is evaluated against that the rows do not hold (db/types.ts <c>QueryContext</c>).</summary>
public sealed record QueryContext(string Today, double OffsetMinutes, string? Me, IReadOnlyDictionary<string, string>? People)
{
    public static QueryContext Utc(string? me = null) =>
        new(DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), 0, me, null);
}

public sealed record SortRule(string PropertyId, string Direction);

public sealed record GroupRule(string PropertyId, string? DateBy, bool HideEmpty, IReadOnlyList<string> Hidden);

public sealed record GroupCount(string Key, int Count);

/// <summary>A filter, sorts, a group and a search: one definition, evaluated as db/query.ts does.</summary>
public sealed class QuerySpec
{
    /// <summary>The filter as raw JSON values (<see cref="Raw"/>), a group or a condition.</summary>
    public object? Filter { get; init; }
    public IReadOnlyList<SortRule> Sorts { get; init; } = [];
    public GroupRule? Group { get; init; }
    public string? Search { get; init; }

    public static IReadOnlyList<SortRule> ReadSorts(JsonElement e) =>
        e.ValueKind != JsonValueKind.Array ? [] : e.EnumerateArray()
            .Where(s => s.ValueKind == JsonValueKind.Object && s.TryGetProperty("propertyId", out var p) && p.ValueKind == JsonValueKind.String)
            .Select(s => new SortRule(s.GetProperty("propertyId").GetString()!,
                s.TryGetProperty("direction", out var d) && d.ValueKind == JsonValueKind.String && d.GetString() == "desc" ? "desc" : "asc"))
            .ToList();

    public static GroupRule? ReadGroup(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("propertyId", out var p) || p.ValueKind != JsonValueKind.String) return null;
        var by = e.TryGetProperty("dateBy", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
        var hide = e.TryGetProperty("hideEmpty", out var h) && h.ValueKind == JsonValueKind.True;
        var hidden = e.TryGetProperty("hidden", out var x) && x.ValueKind == JsonValueKind.Array
            ? x.EnumerateArray().Where(k => k.ValueKind == JsonValueKind.String).Select(k => k.GetString()!).ToList()
            : [];
        return new GroupRule(p.GetString()!, by, hide, hidden);
    }

    public static object? ReadFilter(JsonElement e) => e.ValueKind == JsonValueKind.Object ? Raw.From(e) : null;

    /// <summary>A view's config as a query: its filter, sorts and group.</summary>
    public static QuerySpec FromView(string config)
    {
        using var doc = JsonDocument.Parse(string.IsNullOrEmpty(config) ? "{}" : config);
        var root = doc.RootElement;
        return new QuerySpec
        {
            Filter = root.TryGetProperty("filter", out var f) ? ReadFilter(f) : null,
            Sorts = root.TryGetProperty("sorts", out var s) ? ReadSorts(s) : [],
            Group = root.TryGetProperty("group", out var g) ? ReadGroup(g) : null,
        };
    }
}

/// <summary>
/// <c>queryRows</c> (db/query.ts): templates and trashed rows never; the search (every word must
/// start a word of the title); the filter (an ignored condition is left out of its group); the
/// sort (each rule, then order key, then id; empty values last both ways); and the groups.
/// </summary>
public static class Query
{
    public sealed record Result(List<RowData> Rows, List<GroupCount>? Groups);

    public const string DefaultDateBy = "month";

    /// <summary>Above this many rows a query filters and keys them in parallel.</summary>
    public static int ParallelFrom { get; set; } = 4000;

    /// <summary><c>normaliseText</c> (cheap in C#: no shared cache for many threads to contend for; a row keeps its title's).</summary>
    public static string Normal(string text) => text.Length == 0 ? text : TextNormaliser.Normalise(text);

    private static readonly Dictionary<string, string[]> Operators = new()
    {
        ["text"] = ["is", "isNot", "contains", "doesNotContain", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
        ["number"] = ["eq", "ne", "gt", "lt", "ge", "le", "isEmpty", "isNotEmpty"],
        ["date"] = ["is", "before", "after", "onOrBefore", "onOrAfter", "isEmpty", "isNotEmpty"],
        ["checkbox"] = ["is"],
        ["select"] = ["is", "isNot", "isEmpty", "isNotEmpty"],
        ["status"] = ["is", "isNot", "isEmpty", "isNotEmpty", "group"],
        ["list"] = ["contains", "doesNotContain", "isEmpty", "isNotEmpty"],
        ["files"] = ["isEmpty", "isNotEmpty"],
    };

    private static readonly string[] StatusGroups = ["todo", "inProgress", "complete"];

    /// <summary>The kind a property reads as for filters and sorts; null when it has none (a broken formula).</summary>
    public static string? KindOf(Schema schema, PropertyDef def)
    {
        switch (def.Type)
        {
            case PropertyTypes.Title or PropertyTypes.Text or PropertyTypes.Url or PropertyTypes.Email or PropertyTypes.Phone: return "text";
            case PropertyTypes.Number: return "number";
            case PropertyTypes.Date or PropertyTypes.CreatedTime or PropertyTypes.LastEditedTime: return "date";
            case PropertyTypes.Checkbox: return "checkbox";
            case PropertyTypes.Select: return "select";
            case PropertyTypes.Status: return "status";
            case PropertyTypes.MultiSelect or PropertyTypes.Person or PropertyTypes.Relation or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy: return "list";
            case PropertyTypes.Files: return "files";
            case PropertyTypes.Rollup:
                return Formulas.RollupType(def.RollupFunction) switch { "date" => "date", "list" => "list", _ => "number" };
            case PropertyTypes.Formula:
                return (schema.Compiled.Formulas.TryGetValue(def.Id, out var f) ? f.Type : null) switch
                {
                    "number" => "number",
                    "text" => "text",
                    "date" => "date",
                    "boolean" => "checkbox",
                    "list" => "list",
                    _ => null,
                };
            default: return null;
        }
    }

    /// <summary>A cell made to fit its kind; anything else (an error, a mismatch) is null.</summary>
    private static object? CellFor(PropertyDef def, string kind, RowData row, Func<RowData, IReadOnlyDictionary<string, object?>?>? computed)
    {
        var cell = Cells.Read(def, row, PropertyTypes.IsComputed(def.Type) ? computed?.Invoke(row) : null);
        if (cell is null || Raw.IsError(cell)) return null;
        switch (kind)
        {
            case "text": return cell is string { Length: > 0 } s ? s : null;
            case "number": return cell is double d && double.IsFinite(d) ? d : null;
            case "checkbox": return cell is bool ? cell : null;
            case "select" or "status": return cell as string;
            case "date":
                return Raw.IsObject(cell) && Raw.Field(cell, "start") is string start && DbDates.IsPoint(start) ? cell : null;
            default:
                return Raw.List(cell) is { Count: > 0 } ? cell : null;
        }
    }

    // Filters ---------------------------------------------------------------------------------------

    private enum Outcome { False, True, Ignored }

    private static Outcome Of(bool b) => b ? Outcome.True : Outcome.False;

    private static string? DateOf(object? value, QueryContext ctx)
    {
        if (value is string s) return DbDates.ParsePoint(s) is { } point ? DbDates.CalendarDate(point, ctx.OffsetMinutes) : null;
        if (!Raw.IsObject(value)) return null;
        if (Raw.HasField(value, "date") && Raw.Field(value, "date") is string date)
            return DbDates.ParsePoint(date) is { } point ? DbDates.CalendarDate(point, ctx.OffsetMinutes) : null;
        if (Raw.HasField(value, "relative")) return Raw.Field(value, "relative") is string relative ? DbDates.Relative(ctx.Today, relative) : null;
        return null;
    }

    private static Outcome Condition(Schema schema, RowData row, object node, QueryContext ctx, Func<RowData, IReadOnlyDictionary<string, object?>?>? computed)
    {
        if (Raw.Field(node, "propertyId") is not string id || schema[id] is not { } def || def.Trashed) return Outcome.Ignored;
        var kind = KindOf(schema, def);
        var op = Raw.Field(node, "operator") as string ?? "";
        if (kind is null || !Operators[kind].Contains(op)) return Outcome.Ignored;
        var cell = CellFor(def, kind, row, computed);
        if (op == "isEmpty") return Of(cell is null);
        if (op == "isNotEmpty") return Of(cell is not null);
        var value = Raw.Field(node, "value");
        switch (kind)
        {
            case "text":
            {
                if (value is not (string or double)) return Outcome.Ignored;
                var v = Normal(value is double d ? JsNumber.ToString(d) : (string)value);
                if (v.Length == 0) return Outcome.Ignored;
                var t = cell is null ? "" : Normal((string)cell);
                return Of(op switch
                {
                    "is" => t == v,
                    "isNot" => t != v,
                    "contains" => t.Contains(v, StringComparison.Ordinal),
                    "doesNotContain" => !t.Contains(v, StringComparison.Ordinal),
                    "startsWith" => t.StartsWith(v, StringComparison.Ordinal),
                    _ => t.EndsWith(v, StringComparison.Ordinal),
                });
            }
            case "number":
            {
                double? v = value is double d ? d : value is string s ? DbText.ParseNumber(s) : null;
                if (v is null || !double.IsFinite(v.Value)) return Outcome.Ignored;
                if (cell is null) return Of(op == "ne");
                var n = (double)cell;
                return Of(op switch
                {
                    "eq" => n == v,
                    "ne" => n != v,
                    "gt" => n > v,
                    "lt" => n < v,
                    "ge" => n >= v,
                    _ => n <= v,
                });
            }
            case "date":
            {
                var v = DateOf(value, ctx);
                if (v is null) return Outcome.Ignored;
                if (cell is null) return Outcome.False;
                var d = DbDates.CalendarDate((string)Raw.Field(cell, "start")!, ctx.OffsetMinutes);
                var c = string.CompareOrdinal(d, v);
                return Of(op switch
                {
                    "is" => c == 0,
                    "before" => c < 0,
                    "after" => c > 0,
                    "onOrBefore" => c <= 0,
                    _ => c >= 0,
                });
            }
            case "checkbox":
                if (value is not bool b) return Outcome.Ignored;
                return Of(cell is bool x && x == b);
            case "select" or "status":
            {
                if (op == "group")
                {
                    if (value is not string group || !StatusGroups.Contains(group)) return Outcome.Ignored;
                    if (cell is null) return Outcome.False;
                    var option = def.OptionIndex((string)cell) is var i and >= 0 ? def.Options[i] : null;
                    return Of((option?.Group ?? "todo") == group);
                }
                if (value is not string wanted) return Outcome.Ignored;
                return Of(op == "is" ? cell as string == wanted : cell as string != wanted);
            }
            case "list":
            {
                string? v;
                if (value is string s) v = s;
                else if (Raw.IsObject(value) && Raw.HasField(value, "me") && Raw.Field(value, "me") is true) v = ctx.Me;
                else return Outcome.Ignored;
                var has = v is not null && cell is not null && Raw.List(cell)!.Contains(v);
                return Of(op == "contains" ? has : !has);
            }
            default:
                return Outcome.Ignored;
        }
    }

    private static Outcome Evaluate(Schema schema, RowData row, object? node, QueryContext ctx, Func<RowData, IReadOnlyDictionary<string, object?>?>? computed)
    {
        if (!Raw.IsObject(node)) return Outcome.Ignored;
        if (Raw.Field(node, "kind") as string == "condition") return Condition(schema, row, node!, ctx, computed);
        var or = Raw.Field(node, "op") as string == "or";
        var outcome = Outcome.Ignored;
        foreach (var child in Raw.List(Raw.Field(node, "children")) ?? [])
        {
            var result = Evaluate(schema, row, child, ctx, computed);
            if (result == Outcome.Ignored) continue;
            if (or)
            {
                if (result == Outcome.True) return Outcome.True;
                outcome = Outcome.False;
            }
            else
            {
                if (result == Outcome.False) return Outcome.False;
                outcome = Outcome.True;
            }
        }
        return outcome;
    }

    /// <summary>Whether a row passes a filter (null passes every row).</summary>
    public static bool Matches(Schema schema, RowData row, object? filter, QueryContext ctx, Func<RowData, IReadOnlyDictionary<string, object?>?>? computed = null) =>
        filter is null || Evaluate(schema, row, filter, ctx, computed) != Outcome.False;

    // Sorts -----------------------------------------------------------------------------------------

    // A key: a double, a string, or an object[] of keys.
    public static int CompareKey(object a, object b)
    {
        if (a is object[] x && b is object[] y)
        {
            for (var i = 0; i < Math.Min(x.Length, y.Length); i++)
            {
                var c = CompareKey(x[i], y[i]);
                if (c != 0) return c;
            }
            return x.Length - y.Length;
        }
        if (a is double m && b is double n) return m < n ? -1 : m > n ? 1 : 0;
        var s = KeyString(a);
        var t = KeyString(b);
        return string.CompareOrdinal(s, t) switch { < 0 => -1, > 0 => 1, _ => 0 };
    }

    private static string KeyString(object key) => key switch
    {
        string s => s,
        double d => JsNumber.ToString(d),
        object[] list => string.Join(",", list.Select(KeyString)),
        _ => "",
    };

    private static int Ordinal(string a, string b) => string.CompareOrdinal(a, b) switch { < 0 => -1, > 0 => 1, _ => 0 };

    private static object PersonKey(IEnumerable<object?> ids, QueryContext ctx)
    {
        var key = new List<object>();
        foreach (var item in ids)
        {
            var id = item as string ?? "";
            key.Add(Normal(ctx.People?.GetValueOrDefault(id) ?? id));
            key.Add(id);
        }
        return key.ToArray();
    }

    private static int StatusRank(string? group) => group switch { "todo" => 0, "inProgress" => 1, "complete" => 2, _ => 0 };

    /// <summary>A cell's sort key; null is empty.</summary>
    private static object? SortKey(Schema schema, PropertyDef def, string kind, RowData row, QueryContext ctx, Func<RowData, IReadOnlyDictionary<string, object?>?>? computed)
    {
        var cell = CellFor(def, kind, row, computed);
        if (cell is null) return null;
        if (PropertyTypes.IsComputed(def.Type))
        {
            return cell switch
            {
                double n => new object[] { 0.0, n },
                string s => new object[] { 2.0, Normal(s) },
                bool b => new object[] { 3.0, b ? 1.0 : 0.0 },
                _ when Raw.List(cell) is { } list => new object[] { 4.0, (double)list.Count },
                _ => new object[] { 1.0, DbDates.PointMs((string)Raw.Field(cell, "start")!, ctx.OffsetMinutes) },
            };
        }
        switch (def.Type)
        {
            case PropertyTypes.Title:
                return row.NormalTitle;
            case PropertyTypes.Text or PropertyTypes.Url or PropertyTypes.Email or PropertyTypes.Phone:
                return Normal((string)cell);
            case PropertyTypes.Number:
                return (double)cell;
            case PropertyTypes.Date or PropertyTypes.CreatedTime or PropertyTypes.LastEditedTime:
                return DbDates.PointMs((string)Raw.Field(cell, "start")!, ctx.OffsetMinutes);
            case PropertyTypes.Checkbox:
                return cell is true ? 1.0 : 0.0;
            case PropertyTypes.Select:
                return (double)def.OptionIndex((string)cell);
            case PropertyTypes.Status:
            {
                var index = def.OptionIndex((string)cell);
                var group = index >= 0 ? def.Options[index].Group : null;
                return new object[] { (double)StatusRank(group ?? "todo"), (double)index };
            }
            case PropertyTypes.MultiSelect:
                return Raw.List(cell)!.Select(id => (object)(double)def.OptionIndex(id as string ?? "")).ToArray();
            case PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy:
                return PersonKey(Raw.List(cell)!, ctx);
            case PropertyTypes.Files or PropertyTypes.Relation:
                return (double)Raw.List(cell)!.Count;
            default:
                return null;
        }
    }

    private sealed record Rule(PropertyDef Def, string Kind, bool Desc);

    private static List<Rule> Rules(Schema schema, IReadOnlyList<SortRule> sorts)
    {
        var rules = new List<Rule>();
        foreach (var sort in sorts)
        {
            if (schema[sort.PropertyId] is not { Trashed: false } def) continue;
            if (KindOf(schema, def) is { } kind) rules.Add(new Rule(def, kind, sort.Direction == "desc"));
        }
        return rules;
    }

    private static object?[] KeysOf(Schema schema, List<Rule> rules, RowData row, QueryContext ctx, Func<RowData, IReadOnlyDictionary<string, object?>?>? computed) =>
        rules.Select(rule => SortKey(schema, rule.Def, rule.Kind, row, ctx, computed)).ToArray();

    private static int CompareKeys(List<Rule> rules, object?[] ka, object?[] kb)
    {
        for (var i = 0; i < rules.Count; i++)
        {
            var x = ka[i];
            var y = kb[i];
            if (x is null || y is null)
            {
                if (x is null && y is null) continue;
                return x is null ? 1 : -1;
            }
            var c = CompareKey(x, y);
            if (c != 0) return rules[i].Desc ? -c : c;
        }
        return 0;
    }

    private static int Compare(List<Rule> rules, object?[] ka, object?[] kb, string orderA, string idA, string orderB, string idB)
    {
        var c = CompareKeys(rules, ka, kb);
        if (c != 0) return c;
        c = Ordinal(orderA, orderB);
        return c != 0 ? c : Ordinal(idA, idB);
    }

    // Groups ----------------------------------------------------------------------------------------

    private static readonly HashSet<string> Groupable =
    [
        PropertyTypes.Select, PropertyTypes.Status, PropertyTypes.MultiSelect, PropertyTypes.Checkbox, PropertyTypes.Person,
        PropertyTypes.Date, PropertyTypes.CreatedTime, PropertyTypes.LastEditedTime, PropertyTypes.CreatedBy, PropertyTypes.LastEditedBy,
    ];

    private static PropertyDef? GroupDef(Schema schema, GroupRule? rule) =>
        rule is not null && schema[rule.PropertyId] is { Trashed: false } def && Groupable.Contains(def.Type) ? def : null;

    /// <summary>The groups a row shows in (never none; <c>''</c> is "no value").</summary>
    public static List<string> GroupKeys(Schema schema, RowData row, GroupRule rule, QueryContext ctx)
    {
        var def = GroupDef(schema, rule);
        if (def is null) return [""];
        var cell = Cells.Read(def, row);
        if (cell is null) return [""];
        switch (def.Type)
        {
            case PropertyTypes.Checkbox: return [cell is true ? "true" : "false"];
            case PropertyTypes.Select or PropertyTypes.Status: return [(string)cell];
            case PropertyTypes.MultiSelect or PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy:
                return Raw.List(cell)!.OfType<string>().Distinct(StringComparer.Ordinal).ToList();
            default:
                return [DbDates.Truncate(DbDates.CalendarDate((string)Raw.Field(cell, "start")!, ctx.OffsetMinutes), rule.DateBy ?? DefaultDateBy)];
        }
    }

    private static List<string> GroupOrder(PropertyDef def, Dictionary<string, int> present, QueryContext ctx)
    {
        switch (def.Type)
        {
            case PropertyTypes.Checkbox:
                return ["false", "true"];
            case PropertyTypes.Select or PropertyTypes.Status or PropertyTypes.MultiSelect:
                return new[] { "" }.Concat(def.Options.Select(o => o.Id).Distinct(StringComparer.Ordinal)).ToList();
            case PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy:
            {
                var ids = present.Keys.Where(k => k.Length > 0).ToList();
                string Name(string id) => Normal(ctx.People?.GetValueOrDefault(id) ?? id);
                ids.Sort((a, b) => Ordinal(Name(a), Name(b)) is var c and not 0 ? c : Ordinal(a, b));
                return [.. new[] { "" }, .. ids];
            }
            default:
            {
                var keys = present.Keys.Where(k => k.Length > 0).ToList();
                keys.Sort(Ordinal);
                return [.. new[] { "" }, .. keys];
            }
        }
    }

    /// <summary>
    /// Rows of a database as a view shows them: templates and trashed rows never; then the search,
    /// the filter, the sorts; then, with a group rule on a groupable property, the groups and their
    /// counts (rows whose every group is hidden are left out; with <paramref name="groupKey"/>, the
    /// rows of that group).
    /// </summary>
    public static Result Run(Schema schema, IEnumerable<RowData> rows, QuerySpec spec, QueryContext ctx, string? groupKey = null,
        Func<RowData, IReadOnlyDictionary<string, object?>?>? computed = null)
    {
        var terms = TextNormaliser.Terms(Normal(spec.Search ?? ""));
        bool Passes(RowData row)
        {
            if (row.IsTemplate || row.Trashed) return false;
            if (terms.Length > 0)
            {
                var words = row.NormalTitle.Split(' ');
                if (!terms.All(term => words.Any(word => word.StartsWith(term, StringComparison.Ordinal)))) return false;
            }
            return Matches(schema, row, spec.Filter, ctx, computed);
        }
        var rules = Rules(schema, spec.Sorts);
        // Each row's keys once, then one sort over the pairs. Many rows are filtered and keyed on
        // every core: the sort's order is total (order key, then id), so the filter's order does
        // not matter.
        var source = rows as IReadOnlyCollection<RowData> ?? rows.ToList();
        var keyed = source.Count > ParallelFrom
            ? source.AsParallel().Where(Passes).Select(r => (Row: r, Keys: KeysOf(schema, rules, r, ctx, computed))).ToArray()
            : source.Where(Passes).Select(r => (Row: r, Keys: KeysOf(schema, rules, r, ctx, computed))).ToArray();
        Array.Sort(keyed, (a, b) => Compare(rules, a.Keys, b.Keys, a.Row.OrderKey, a.Row.IdText, b.Row.OrderKey, b.Row.IdText));
        var result = keyed.Select(k => k.Row).ToList();

        var def = GroupDef(schema, spec.Group);
        if (def is null || spec.Group is null) return new Result(result, null);
        var rule = spec.Group;
        var keysByRow = new Dictionary<Guid, List<string>>();
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var row in result)
        {
            var groupKeys = GroupKeys(schema, row, rule, ctx);
            keysByRow[row.Id] = groupKeys;
            foreach (var key in groupKeys) counts[key] = counts.GetValueOrDefault(key) + 1;
        }
        var hidden = rule.Hidden.ToHashSet(StringComparer.Ordinal);
        var groups = new List<GroupCount>();
        foreach (var key in GroupOrder(def, counts, ctx))
        {
            var count = counts.GetValueOrDefault(key);
            if (hidden.Contains(key) || (rule.HideEmpty && count == 0)) continue;
            groups.Add(new GroupCount(key, count));
        }
        var shown = groups.Select(g => g.Key).ToHashSet(StringComparer.Ordinal);
        result = groupKey is not null
            ? result.Where(row => keysByRow[row.Id].Contains(groupKey)).ToList()
            : result.Where(row => keysByRow[row.Id].Any(shown.Contains)).ToList();
        return new Result(result, groups);
    }

    // Cursor ----------------------------------------------------------------------------------------

    /// <summary>The keyset cursor after a row: its sort keys, order key and id, opaque to clients.</summary>
    public static string Cursor(Schema schema, QuerySpec spec, RowData row, QueryContext ctx)
    {
        var rules = Rules(schema, spec.Sorts);
        var key = KeysOf(schema, rules, row, ctx, null);
        var json = new JsonObject
        {
            ["k"] = new JsonArray(key.Select(ToNode).ToArray()),
            ["o"] = row.OrderKey,
            ["i"] = row.IdText,
        };
        return System.Convert.ToBase64String(Encoding.UTF8.GetBytes(json.ToJsonString())).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static JsonNode? ToNode(object? part) => part switch
    {
        null => null,
        double d => JsonValue.Create(d),
        string s => JsonValue.Create(s),
        object[] list => new JsonArray(list.Select(ToNode).ToArray()),
        _ => null,
    };

    private static object? FromNode(JsonNode? node) => node switch
    {
        null => null,
        JsonArray list => list.Select(FromNode).Select(x => x ?? "").ToArray(),
        JsonValue v when v.TryGetValue<double>(out var d) => d,
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        _ => null,
    };

    /// <summary>Where the rows after a cursor start in the query's order; null when the cursor cannot be read.</summary>
    public static int? After(Schema schema, QuerySpec spec, List<RowData> ordered, string cursor, QueryContext ctx)
    {
        JsonObject? json;
        try
        {
            var text = cursor.Replace('-', '+').Replace('_', '/');
            text = text.PadRight(text.Length + (4 - text.Length % 4) % 4, '=');
            json = JsonNode.Parse(Encoding.UTF8.GetString(System.Convert.FromBase64String(text))) as JsonObject;
        }
        catch (Exception e) when (e is FormatException or JsonException)
        {
            return null;
        }
        if (json?["k"] is not JsonArray k || json["o"] is not JsonValue o || !o.TryGetValue<string>(out var orderKey)
            || json["i"] is not JsonValue i || !i.TryGetValue<string>(out var id)) return null;
        var rules = Rules(schema, spec.Sorts);
        if (k.Count != rules.Count) return null;
        var key = k.Select(FromNode).ToArray();
        int lo = 0, hi = ordered.Count;
        while (lo < hi)
        {
            var mid = (lo + hi) / 2;
            var row = ordered[mid];
            var c = Compare(rules, KeysOf(schema, rules, row, ctx, null), key, row.OrderKey, row.IdText, orderKey, id);
            if (c <= 0) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
}
