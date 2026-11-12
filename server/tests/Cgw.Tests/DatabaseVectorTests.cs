using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Databases;

namespace Cgw.Tests;

/// <summary>
/// The C# port of packages/workspace/src/db against the shared vectors
/// (packages/workspace/vectors/db-*.json, written by the core stream's vectors.test.ts): every
/// case, read the way that test reads it.
/// </summary>
public sealed class DatabaseVectorTests(ServerFixture server)
{
    private JsonElement Vectors(string name)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "vectors", name)));
        return doc.RootElement.Clone();
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    internal static PropertyDef Def(JsonElement e) => PropertyDef.Parse((JsonObject)JsonNode.Parse(e.GetRawText())!);

    internal static Schema Database(JsonElement e)
    {
        var id = Str(e, "id") ?? "";
        var version = e.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : 1;
        var defs = Schema.ParseDefs(JsonNode.Parse(e.GetProperty("properties").GetRawText()) as JsonArray);
        return new Schema(Guid.TryParse(id, out var g) ? g : Guid.Empty, version, defs, id);
    }

    internal static RowData Row(JsonElement e)
    {
        DateTimeOffset? At(string name) => Str(e, name) is { } s && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
        var values = new Dictionary<string, object>(StringComparer.Ordinal);
        if (e.TryGetProperty("values", out var v) && v.ValueKind == JsonValueKind.Object)
            foreach (var p in v.EnumerateObject())
                if (Raw.From(p.Value) is { } value) values[p.Name] = value;
        var computed = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (e.TryGetProperty("computed", out var c) && c.ValueKind == JsonValueKind.Object)
            foreach (var p in c.EnumerateObject()) computed[p.Name] = Raw.From(p.Value);
        return new RowData
        {
            Id = Guid.Parse(Str(e, "id")!),
            DatabaseId = Guid.TryParse(Str(e, "databaseId"), out var d) ? d : Guid.Empty,
            Title = Str(e, "title") ?? "",
            OrderKey = Str(e, "orderKey") ?? "",
            IsTemplate = e.TryGetProperty("isTemplate", out var t) && t.ValueKind == JsonValueKind.True,
            Trashed = Str(e, "trashedAt") is { Length: > 0 },
            CreatedAt = At("createdAt"),
            UpdatedAt = At("updatedAt"),
            CreatedBy = Str(e, "createdBy"),
            UpdatedBy = Str(e, "updatedBy"),
            Values = values,
            Computed = computed,
        };
    }

    /// <summary>JSON equality as the vectors mean it: numbers by value, objects by their keys.</summary>
    internal static bool Same(JsonNode? actual, JsonElement expected)
    {
        using var doc = JsonDocument.Parse(actual?.ToJsonString() ?? "null");
        return Same(doc.RootElement, expected);
    }

    private static bool Same(JsonElement actual, JsonElement expected)
    {
        if (expected.ValueKind is JsonValueKind.True or JsonValueKind.False) return actual.ValueKind == expected.ValueKind;
        if (actual.ValueKind != expected.ValueKind) return false;
        switch (expected.ValueKind)
        {
            case JsonValueKind.Number: return actual.GetDouble() == expected.GetDouble();
            case JsonValueKind.String: return actual.GetString() == expected.GetString();
            case JsonValueKind.Array:
                return actual.GetArrayLength() == expected.GetArrayLength()
                    && actual.EnumerateArray().Zip(expected.EnumerateArray()).All(p => Same(p.First, p.Second));
            case JsonValueKind.Object:
            {
                var a = actual.EnumerateObject().ToList();
                var e = expected.EnumerateObject().ToList();
                return a.Count == e.Count && e.All(k => actual.TryGetProperty(k.Name, out var v) && Same(v, k.Value));
            }
            default: return true;
        }
    }

    private static JsonNode? Json(object? value) => ValueJson.ToNode(value);

    private static void Check(List<string> failures, string name, JsonNode? actual, JsonElement expected)
    {
        if (!Same(actual, expected)) failures.Add($"{name}: expected {expected.GetRawText()}, got {actual?.ToJsonString() ?? "null"}");
    }

    [Fact]
    public void Coercion_conversion_ids_numbers_and_cells_match_the_vectors()
    {
        var failures = new List<string>();
        var count = 0;
        foreach (var c in Vectors("db-convert-vectors.json").EnumerateArray())
        {
            var kind = Str(c, "kind");
            var name = $"{kind}: {Str(c, "name")}";
            count++;
            switch (kind)
            {
                case "coerce":
                    Check(failures, name, Json(Values.Coerce(Def(c.GetProperty("def")), Raw.From(c.GetProperty("raw")))), c.GetProperty("expected"));
                    break;
                case "convert":
                    Check(failures, name, Json(Conversion.Value(Def(c.GetProperty("from")), Def(c.GetProperty("to")), Raw.From(c.GetProperty("value")))), c.GetProperty("expected"));
                    break;
                case "convertProperty":
                {
                    var (def, values) = Conversion.Property(Def(c.GetProperty("from")), (JsonObject)JsonNode.Parse(c.GetProperty("to").GetRawText())!,
                        c.GetProperty("values").EnumerateArray().Select(Raw.From).ToList(), Str(c, "databaseId")!);
                    Check(failures, name, new JsonObject { ["def"] = def.DeepClone(), ["values"] = new JsonArray(values.Select(Json).ToArray()) }, c.GetProperty("expected"));
                    break;
                }
                case "derivedOption":
                {
                    var taken = c.GetProperty("taken").EnumerateArray().Select(t => t.GetString()!).ToHashSet(StringComparer.Ordinal);
                    var (id, colour) = DbIds.Derived(Str(c, "databaseId")!, Str(c, "propertyId")!, Str(c, "optionName")!, taken);
                    Check(failures, name, new JsonObject { ["id"] = id, ["colour"] = colour }, c.GetProperty("expected"));
                    break;
                }
                case "numberText":
                    Check(failures, name, JsonValue.Create(JsNumber.ToString(c.GetProperty("value").GetDouble())), c.GetProperty("expected"));
                    break;
                case "parseNumber":
                    Check(failures, name, Json(DbText.ParseNumber(Str(c, "text")!)), c.GetProperty("expected"));
                    break;
                case "parseBoolean":
                    Check(failures, name, Json(DbText.ParseBoolean(Str(c, "text")!)), c.GetProperty("expected"));
                    break;
                case "parseDate":
                    Check(failures, name, Json(DbDates.ParseDateText(Str(c, "text")!)), c.GetProperty("expected"));
                    break;
                case "cells":
                {
                    var schema = Database(c.GetProperty("database"));
                    foreach (var one in c.GetProperty("cases").EnumerateArray())
                    {
                        Dictionary<string, object?>? computed = null;
                        if (one.TryGetProperty("computed", out var given) && given.ValueKind == JsonValueKind.Object)
                            computed = given.EnumerateObject().ToDictionary(p => p.Name, p => Raw.From(p.Value), StringComparer.Ordinal);
                        var def = schema[Str(one, "propertyId")!];
                        var cell = def is null ? null : Cells.Read(def, Row(one.GetProperty("row")), computed);
                        Check(failures, $"{name}: {Str(one, "name")}", Json(cell), one.GetProperty("expected"));
                    }
                    break;
                }
                default:
                    failures.Add($"Teach this test {kind}");
                    break;
            }
        }
        Assert.True(count > 200, $"Only {count} vectors");
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void Queries_match_the_vectors()
    {
        var failures = new List<string>();
        var count = 0;
        foreach (var suite in Vectors("db-query-vectors.json").EnumerateArray())
        {
            var schema = Database(suite.GetProperty("database"));
            var rows = suite.GetProperty("rows").EnumerateArray().Select(Row).ToList();
            foreach (var c in suite.GetProperty("cases").EnumerateArray())
            {
                count++;
                var spec = c.GetProperty("spec");
                var query = new QuerySpec
                {
                    Filter = spec.TryGetProperty("filter", out var f) ? Raw.From(f) : null,
                    Sorts = spec.TryGetProperty("sorts", out var s) ? QuerySpec.ReadSorts(s) : [],
                    Group = spec.TryGetProperty("group", out var g) ? QuerySpec.ReadGroup(g) : null,
                    Search = Str(spec, "search"),
                };
                var ctx = c.GetProperty("ctx");
                var people = ctx.TryGetProperty("people", out var p) && p.ValueKind == JsonValueKind.Object
                    ? p.EnumerateObject().ToDictionary(x => x.Name, x => x.Value.GetString()!, StringComparer.Ordinal)
                    : null;
                var context = new QueryContext(Str(ctx, "today") ?? "", ctx.GetProperty("offsetMinutes").GetDouble(), Str(ctx, "me"), people);
                var result = Query.Run(schema, rows, query, context, Str(c, "groupKey"));
                var actual = new JsonObject
                {
                    ["rows"] = new JsonArray(result.Rows.Select(r => (JsonNode?)JsonValue.Create(r.IdText)).ToArray()),
                    ["groups"] = result.Groups is null ? null : new JsonArray(result.Groups.Select(x => (JsonNode?)new JsonObject { ["key"] = x.Key, ["count"] = x.Count }).ToArray()),
                };
                Check(failures, $"{Str(suite, "name")}: {Str(c, "name")}", actual, c.GetProperty("expected"));
            }
        }
        Assert.True(count > 30, $"Only {count} vectors");
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void Formulas_match_the_vectors()
    {
        var failures = new List<string>();
        var count = 0;
        foreach (var suite in Vectors("db-formula-vectors.json").EnumerateArray())
        {
            var schema = Database(suite.GetProperty("database"));
            var kind = Str(suite, "kind");
            foreach (var c in suite.GetProperty("cases").EnumerateArray())
            {
                count++;
                var expression = Str(c, "expression")!;
                var name = $"{kind}: {Str(suite, "name")}: {expression}";
                switch (kind)
                {
                    case "toNames":
                        Check(failures, name, JsonValue.Create(Formulas.ToNames(schema, expression)), c.GetProperty("expected"));
                        break;
                    case "toIds":
                        Check(failures, name, JsonValue.Create(Formulas.ToIds(schema, expression)), c.GetProperty("expected"));
                        break;
                    default:
                    {
                        var (value, type) = Compute.Expression(schema, Row(suite.GetProperty("row")), expression);
                        Check(failures, name, new JsonObject { ["value"] = Json(value), ["type"] = type }, c.GetProperty("expected"));
                        break;
                    }
                }
            }
        }
        Assert.True(count > 100, $"Only {count} vectors");
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    /// <summary>The vectors' related rows: the held databases' rows the ids name.</summary>
    private sealed class Held(List<Schema> held, List<RowData> rows) : IRelatedRows
    {
        public (Schema Schema, IReadOnlyDictionary<string, RowData> Rows)? Rows(string databaseId, IReadOnlyList<string> rowIds)
        {
            var schema = held.FirstOrDefault(d => d.IdText == databaseId);
            if (schema is null) return null;
            return (schema, rows.Where(r => r.DatabaseId.ToString() == databaseId && rowIds.Contains(r.IdText)).ToDictionary(r => r.IdText, StringComparer.Ordinal));
        }
    }

    private static Dictionary<string, object>? ValuesOf(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        var values = new Dictionary<string, object>(StringComparer.Ordinal);
        if (e.TryGetProperty("values", out var v) && v.ValueKind == JsonValueKind.Object)
            foreach (var p in v.EnumerateObject())
                if (Raw.From(p.Value) is { } value) values[p.Name] = value;
        return values;
    }

    [Fact]
    public void Rollups_formulas_and_relations_match_the_vectors()
    {
        var failures = new List<string>();
        var count = 0;
        foreach (var suite in Vectors("db-compute-vectors.json").EnumerateArray())
        {
            var kind = Str(suite, "kind");
            foreach (var c in suite.GetProperty("cases").EnumerateArray())
            {
                count++;
                var name = $"{kind}: {Str(c, "name")}";
                switch (kind)
                {
                    case "computeRow":
                    {
                        var related = new Held(suite.GetProperty("held").EnumerateArray().Select(Database).ToList(), suite.GetProperty("rows").EnumerateArray().Select(Row).ToList());
                        var result = Compute.Row(Database(suite.GetProperty("database")), Row(c.GetProperty("row")), related);
                        Check(failures, name, new JsonObject(result.Select(p => KeyValuePair.Create(p.Key, Json(p.Value)))), c.GetProperty("expected"));
                        break;
                    }
                    case "relationChange":
                    {
                        var before = c.GetProperty("before");
                        var after = c.GetProperty("after");
                        var rowId = Str(after, "id") ?? Str(before, "id") ?? "";
                        var edits = Relations.Change(Database(suite.GetProperty("database")), rowId, ValuesOf(before), ValuesOf(after));
                        Check(failures, name, new JsonArray(edits.Select(e => (JsonNode?)new JsonObject
                        {
                            ["databaseId"] = e.DatabaseId,
                            ["rowId"] = e.RowId,
                            ["propertyId"] = e.PropertyId,
                            ["add"] = new JsonArray(e.Add.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()),
                            ["remove"] = new JsonArray(e.Remove.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()),
                        }).ToArray()), c.GetProperty("expected"));
                        break;
                    }
                    case "relationTypeChange":
                    {
                        var database = Database(suite.GetProperty("database"));
                        var before = Def(c.GetProperty("before"));
                        var after = Def(c.GetProperty("after"));
                        var target = c.TryGetProperty("target", out var t) && t.ValueKind == JsonValueKind.Object
                            ? Database(t)
                            : before.RelationDatabase == database.IdText ? database : null;
                        var effects = Relations.TypeChangeEffects(database, before, after, target);
                        Check(failures, name, new JsonArray(effects.Select(e => (JsonNode?)new JsonObject
                        {
                            ["databaseId"] = e.DatabaseId,
                            ["properties"] = new JsonArray(e.Properties.Select(x => (JsonNode?)x.DeepClone()).ToArray()),
                        }).ToArray()), c.GetProperty("expected"));
                        break;
                    }
                    default:
                    {
                        var edit = c.GetProperty("edit");
                        var result = Relations.Apply(c.TryGetProperty("current", out var current) ? Raw.From(current) : null, new RelationEdit("", "", "",
                            edit.GetProperty("add").EnumerateArray().Select(x => x.GetString()!).ToList(),
                            edit.GetProperty("remove").EnumerateArray().Select(x => x.GetString()!).ToList()));
                        Check(failures, name, Json(result), c.GetProperty("expected"));
                        break;
                    }
                }
            }
        }
        Assert.True(count > 20, $"Only {count} vectors");
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void Csv_matches_the_vectors()
    {
        var failures = new List<string>();
        var count = 0;
        foreach (var c in Vectors("db-csv-vectors.json").EnumerateArray())
        {
            count++;
            var kind = Str(c, "kind");
            var name = $"{kind}: {Str(c, "name")}";
            switch (kind)
            {
                case "parse":
                    Check(failures, name, new JsonArray(Csv.Parse(Str(c, "text")!).Select(r => (JsonNode?)new JsonArray(r.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray())).ToArray()), c.GetProperty("expected"));
                    break;
                case "infer":
                {
                    var header = c.GetProperty("header").EnumerateArray().Select(x => x.GetString()!).ToList();
                    var rows = c.GetProperty("rows").EnumerateArray().Select(r => r.EnumerateArray().Select(x => x.GetString()!).ToArray()).ToList();
                    var defs = Csv.InferProperties(header, rows).Select(PropertyDef.Parse).ToList();
                    Check(failures, name, new JsonArray(defs.Select(d =>
                    {
                        var o = new JsonObject { ["name"] = d.Name, ["type"] = d.Type };
                        if (d.OptionList is { } options) o["options"] = new JsonArray(options.Select(x => (JsonNode?)JsonValue.Create(x.Name)).ToArray());
                        if (d.Json.ContainsKey("date")) o["includeTime"] = d.IncludeTime;
                        return (JsonNode?)o;
                    }).ToArray()), c.GetProperty("expected"));
                    break;
                }
                case "textToValue":
                    Check(failures, name, Json(Csv.TextToValue(Def(c.GetProperty("def")), Str(c, "text")!)), c.GetProperty("expected"));
                    break;
                case "export":
                {
                    var view = c.GetProperty("view");
                    var config = view.TryGetProperty("config", out var cfg) ? JsonNode.Parse(cfg.GetRawText()) as JsonObject : null;
                    var lookups = c.GetProperty("lookups");
                    Dictionary<string, string> Map(string key) => lookups.TryGetProperty(key, out var m) && m.ValueKind == JsonValueKind.Object
                        ? m.EnumerateObject().ToDictionary(x => x.Name, x => x.Value.GetString()!, StringComparer.Ordinal)
                        : [];
                    var text = Csv.WriteText(Database(c.GetProperty("database")), config, c.GetProperty("rows").EnumerateArray().Select(Row).ToList(),
                        new CsvLookups { People = Map("people"), Rows = Map("rows"), Files = Map("files") });
                    Check(failures, name, JsonValue.Create(text), c.GetProperty("expected"));
                    break;
                }
                default:
                    failures.Add($"Teach this test {kind}");
                    break;
            }
        }
        Assert.True(count > 40, $"Only {count} vectors");
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }
}
