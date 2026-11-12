using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cgw.Core.Databases;

// The C# side of packages/workspace/src/db (contract section 2): the same records, values and
// rules, held together by the shared vectors in packages/workspace/vectors/db-*.json.
//
// A value is an object as JavaScript would see the JSON: string, double, bool, null, a list
// (string[], or object?[] when it holds anything else), an object (Dictionary<string, object?>);
// the rules also make DateValue and CellError, which read as the objects they write. Raw holds the
// questions JavaScript asks of them (typeof, Array.isArray, a field).

/// <summary>A date or a span (<c>YYYY-MM-DD</c>, or a UTC instant <c>YYYY-MM-DDTHH:mm:ssZ</c>).</summary>
public sealed record DateValue(string Start, string? End = null);

/// <summary>A formula or rollup that could not be computed, with its code (<c>formula.type</c>, ...).</summary>
public sealed record CellError(string Error);

public static class Raw
{
    public static object? From(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.String => e.GetString(),
        JsonValueKind.Number => e.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Array => e.EnumerateArray().All(x => x.ValueKind == JsonValueKind.String)
            ? e.EnumerateArray().Select(x => x.GetString()!).ToArray()
            : e.EnumerateArray().Select(From).ToArray(),
        JsonValueKind.Object when DateShape(e) is { } date => date,
        JsonValueKind.Object => e.EnumerateObject().GroupBy(p => p.Name).ToDictionary(g => g.Key, g => From(g.Last().Value), StringComparer.Ordinal),
        _ => null,
    };

    public static object? From(JsonNode? node) => node is null ? null : From(JsonSerializer.SerializeToElement(node));

    /// <summary>
    /// An object holding only a text <c>start</c> and an <c>end</c> that is text, null or absent
    /// reads as a <see cref="DateValue"/> (what it is to every rule; one object less per cell).
    /// </summary>
    private static DateValue? DateShape(JsonElement e)
    {
        string? start = null, end = null;
        foreach (var p in e.EnumerateObject())
        {
            if (p.Name == "start" && p.Value.ValueKind == JsonValueKind.String) start = p.Value.GetString();
            else if (p.Name == "end" && p.Value.ValueKind is JsonValueKind.String) end = p.Value.GetString();
            else if (p.Name == "end" && p.Value.ValueKind is JsonValueKind.Null) end = null;
            else return null;
        }
        return start is null ? null : new DateValue(start, end);
    }

    /// <summary><c>typeof x === 'object' &amp;&amp; x !== null &amp;&amp; !Array.isArray(x)</c>.</summary>
    public static bool IsObject(object? x) => x is DateValue or CellError or Dictionary<string, object?>;

    public static object? Field(object? x, string name) => x switch
    {
        DateValue d => name == "start" ? d.Start : name == "end" ? d.End : null,
        CellError e => name == "error" ? e.Error : null,
        Dictionary<string, object?> o => o.GetValueOrDefault(name),
        _ => null,
    };

    public static bool HasField(object? x, string name) => x switch
    {
        DateValue d => name == "start" || (name == "end" && d.End is not null),
        CellError => name == "error",
        Dictionary<string, object?> o => o.ContainsKey(name),
        _ => false,
    };

    /// <summary><c>Array.isArray(x) ? x : null</c>.</summary>
    public static IReadOnlyList<object?>? List(object? x) => x switch
    {
        string[] s => s,
        object?[] o => o,
        _ => null,
    };

    /// <summary>An error cell: an object whose <c>error</c> is text.</summary>
    public static bool IsError(object? x) => x is CellError || (x is Dictionary<string, object?> o && o.GetValueOrDefault("error") is string);

    public static string? ErrorOf(object? x) => x is CellError e ? e.Error : Field(x, "error") as string;

    /// <summary>A number as JavaScript compares it (finite or not).</summary>
    public static bool IsFinite(object? x) => x is double d && double.IsFinite(d);
}

public static class PropertyTypes
{
    public const string Title = "title";
    public const string Text = "text";
    public const string Number = "number";
    public const string Date = "date";
    public const string Checkbox = "checkbox";
    public const string Select = "select";
    public const string MultiSelect = "multiSelect";
    public const string Status = "status";
    public const string Person = "person";
    public const string Url = "url";
    public const string Email = "email";
    public const string Phone = "phone";
    public const string Files = "files";
    public const string Relation = "relation";
    public const string Formula = "formula";
    public const string Rollup = "rollup";
    public const string CreatedTime = "createdTime";
    public const string CreatedBy = "createdBy";
    public const string LastEditedTime = "lastEditedTime";
    public const string LastEditedBy = "lastEditedBy";

    public static readonly HashSet<string> All =
    [
        Title, Text, Number, Date, Checkbox, Select, MultiSelect, Status, Person, Url, Email, Phone, Files,
        Relation, Formula, Rollup, CreatedTime, CreatedBy, LastEditedTime, LastEditedBy,
    ];

    /// <summary>Types whose value is stored on the row (db/types.ts <c>STORED_TYPES</c>).</summary>
    public static readonly HashSet<string> Stored =
        [Text, Number, Date, Checkbox, Select, MultiSelect, Status, Person, Url, Email, Phone, Files, Relation];

    public static bool IsStored(string type) => Stored.Contains(type);
    public static bool IsComputed(string type) => type is Formula or Rollup;
    /// <summary>db/convert.ts <c>isOptionType</c>.</summary>
    public static bool HasOptions(string type) => type is Select or MultiSelect or Status;
}

public sealed record OptionDef(string Id, string Name, string Colour, string? Group, bool HasGroup);

/// <summary>
/// A property definition read from its JSON (db/types.ts <c>PropertyDef</c>). The JSON object is
/// what is stored and sent: fields this server does not know stay in it.
/// </summary>
public sealed class PropertyDef
{
    public const string TitleId = "title";

    public required string Id { get; init; }
    public string Name { get; init; } = "";
    public required string Type { get; init; }
    /// <summary>Null when the def has no <c>options</c> at all.</summary>
    public IReadOnlyList<OptionDef>? OptionList { get; init; }
    public IReadOnlyList<OptionDef> Options => OptionList ?? [];
    public bool IncludeTime { get; init; }
    /// <summary>The relation's database id as written (compared as text, as the TypeScript does).</summary>
    public string? RelationDatabase { get; init; }
    public Guid? RelationDatabaseId => Guid.TryParse(RelationDatabase, out var id) ? id : null;
    public string? ReversePropertyId { get; init; }
    public bool HasRelation { get; init; }
    public string? RollupRelation { get; init; }
    public string? RollupTarget { get; init; }
    public string? RollupFunction { get; init; }
    public bool HasRollup { get; init; }
    public string? Expression { get; init; }
    public bool Trashed { get; init; }
    public required JsonObject Json { get; init; }

    private Dictionary<string, int>? positions;

    /// <summary>An option's place in the def (the first with the id), or -1 when the property no longer has it.</summary>
    public int OptionIndex(string id)
    {
        if (OptionList is null) return -1;
        var known = positions;
        if (known is null)
        {
            // Built whole, then published: queries read a def from many threads at once.
            known = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < OptionList.Count; i++) known.TryAdd(OptionList[i].Id, i);
            positions = known;
        }
        return known.GetValueOrDefault(id, -1);
    }

    public OptionDef? Option(string id) => OptionIndex(id) is var i and >= 0 ? Options[i] : null;

    private static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    public static PropertyDef Parse(JsonObject json)
    {
        List<OptionDef>? options = null;
        if (json["options"] is JsonArray list)
        {
            options = [];
            foreach (var item in list)
                if (item is JsonObject o)
                    options.Add(new OptionDef(Str(o["id"]) ?? "", Str(o["name"]) ?? "", Str(o["colour"]) ?? "default", Str(o["group"]), o.ContainsKey("group")));
        }
        var relation = json["relation"] as JsonObject;
        var rollup = json["rollup"] as JsonObject;
        var trashed = json["trashedAt"];
        return new PropertyDef
        {
            Id = Str(json["id"]) ?? "",
            Name = Str(json["name"]) ?? "",
            Type = Str(json["type"]) ?? "",
            OptionList = options,
            IncludeTime = json["date"] is JsonObject date && date["includeTime"] is JsonValue t && t.TryGetValue<bool>(out var b) && b,
            RelationDatabase = Str(relation?["databaseId"]),
            ReversePropertyId = Str(relation?["reversePropertyId"]),
            HasRelation = relation is not null,
            RollupRelation = Str(rollup?["relationPropertyId"]),
            RollupTarget = Str(rollup?["targetPropertyId"]),
            RollupFunction = Str(rollup?["fn"]),
            HasRollup = rollup is not null,
            Expression = Str((json["formula"] as JsonObject)?["expression"]),
            // JavaScript's truthiness of `trashedAt`.
            Trashed = trashed is JsonValue tv && (tv.TryGetValue<string>(out var ts) ? ts.Length > 0 : tv.TryGetValue<bool>(out var tb) ? tb : tv.TryGetValue<double>(out var tn) && tn != 0 && !double.IsNaN(tn))
                || trashed is JsonObject or JsonArray,
            Json = json,
        };
    }
}

/// <summary>A database's properties, parsed once per version.</summary>
public sealed class Schema
{
    public Guid Id { get; }
    public string IdText { get; }
    public long Version { get; }
    public IReadOnlyList<PropertyDef> Properties { get; }
    private readonly Dictionary<string, PropertyDef> byId;

    public Schema(Guid id, long version, IReadOnlyList<PropertyDef> properties, string? idText = null)
    {
        Id = id;
        IdText = idText ?? id.ToString();
        Version = version;
        Properties = properties;
        byId = new Dictionary<string, PropertyDef>(StringComparer.Ordinal);
        foreach (var def in properties) byId.TryAdd(def.Id, def);
    }

    /// <summary>The first property with the id, deleted or not.</summary>
    public PropertyDef? this[string id] => byId.GetValueOrDefault(id);

    /// <summary>Not deleted: the properties that show, compute and filter.</summary>
    public PropertyDef? Live(string id) => byId.GetValueOrDefault(id) is { Trashed: false } def ? def : null;

    private Formulas.Compiled? compiled;

    /// <summary>The database's formulas, parsed and checked once (formula/compile.ts).</summary>
    public Formulas.Compiled Compiled => compiled ??= Formulas.Compile(this);

    public static Schema Parse(Guid id, long version, string json) => new(id, version, ParseDefs(JsonNode.Parse(json) as JsonArray));

    public static List<PropertyDef> ParseDefs(JsonArray? array) =>
        array?.OfType<JsonObject>().Select(PropertyDef.Parse).ToList() ?? [];
}

/// <summary>Reading and writing values as JSON.</summary>
public static class ValueJson
{
    public static object? Read(JsonElement e) => Raw.From(e);

    public static JsonNode? ToNode(object? value) => value switch
    {
        null => null,
        string s => JsonValue.Create(s),
        double d => JsonValue.Create(d),
        bool b => JsonValue.Create(b),
        DateValue date => date.End is null
            ? new JsonObject { ["start"] = date.Start }
            : new JsonObject { ["start"] = date.Start, ["end"] = date.End },
        CellError error => new JsonObject { ["error"] = error.Error },
        string[] list => new JsonArray(list.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()),
        object?[] list => new JsonArray(list.Select(ToNode).ToArray()),
        Dictionary<string, object?> o => new JsonObject(o.Select(p => KeyValuePair.Create(p.Key, ToNode(p.Value)))),
        _ => throw new ArgumentException($"Not a value: {value.GetType().Name}"),
    };

    public static void Write(Utf8JsonWriter w, object? value)
    {
        switch (value)
        {
            case null: w.WriteNullValue(); break;
            case string s: w.WriteStringValue(s); break;
            case double d: w.WriteNumberValue(d); break;
            case bool b: w.WriteBooleanValue(b); break;
            case DateValue date:
                w.WriteStartObject();
                w.WriteString("start", date.Start);
                if (date.End is not null) w.WriteString("end", date.End);
                w.WriteEndObject();
                break;
            case CellError error:
                w.WriteStartObject();
                w.WriteString("error", error.Error);
                w.WriteEndObject();
                break;
            case string[] list:
                w.WriteStartArray();
                foreach (var x in list) w.WriteStringValue(x);
                w.WriteEndArray();
                break;
            case object?[] list:
                w.WriteStartArray();
                foreach (var x in list) Write(w, x);
                w.WriteEndArray();
                break;
            case Dictionary<string, object?> o:
                w.WriteStartObject();
                foreach (var (k, v) in o)
                {
                    w.WritePropertyName(k);
                    Write(w, v);
                }
                w.WriteEndObject();
                break;
            default: throw new ArgumentException($"Not a value: {value.GetType().Name}");
        }
    }

    /// <summary>Stored values by property id, from their JSON column; null values are absent.</summary>
    public static Dictionary<string, object> ReadMap(string json)
    {
        var map = new Dictionary<string, object>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(json)) return map;
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return map;
        foreach (var p in doc.RootElement.EnumerateObject())
            if (Read(p.Value) is { } value) map[p.Name] = value;
        return map;
    }

    /// <summary>The computed map: a null result is kept as null.</summary>
    public static Dictionary<string, object?> ReadCells(string json)
    {
        var map = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(json)) return map;
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return map;
        foreach (var p in doc.RootElement.EnumerateObject()) map[p.Name] = Read(p.Value);
        return map;
    }

    public static string WriteMap<T>(IReadOnlyDictionary<string, T> map)
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            foreach (var (key, value) in map)
            {
                w.WritePropertyName(key);
                Write(w, value);
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    public static string WriteVersions(IReadOnlyDictionary<string, long> map) => JsonSerializer.Serialize(map);

    public static Dictionary<string, long> ReadVersions(string json)
    {
        var map = new Dictionary<string, long>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(json)) return map;
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return map;
        foreach (var p in doc.RootElement.EnumerateObject())
            if (p.Value.ValueKind == JsonValueKind.Number && p.Value.TryGetInt64(out var v)) map[p.Name] = v;
        return map;
    }

    /// <summary>Two values as their JSON (plan.ts <c>sameValue</c>).</summary>
    public static bool Same(object? a, object? b) =>
        ReferenceEquals(a, b) || (ToNode(a)?.ToJsonString() ?? "null") == (ToNode(b)?.ToJsonString() ?? "null");
}

/// <summary>Numbers as text, as JavaScript's <c>String(n)</c> writes them (contract: both sides the same).</summary>
public static class JsNumber
{
    public static string ToString(double value)
    {
        if (double.IsNaN(value)) return "NaN";
        if (double.IsPositiveInfinity(value)) return "Infinity";
        if (double.IsNegativeInfinity(value)) return "-Infinity";
        if (value == 0) return "0";
        var negative = value < 0;
        // The shortest digits that read back as the same double (.NET's "R"), then ECMAScript's
        // Number::toString layout: value = 0.digits × 10^n.
        var shortest = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var e = shortest.IndexOfAny(['E', 'e']);
        var mantissa = e >= 0 ? shortest[..e] : shortest;
        var exp = e >= 0 ? int.Parse(shortest[(e + 1)..], CultureInfo.InvariantCulture) : 0;
        var dot = mantissa.IndexOf('.');
        var intPart = dot >= 0 ? mantissa[..dot] : mantissa;
        var all = intPart + (dot >= 0 ? mantissa[(dot + 1)..] : "");
        var trimmed = all.TrimStart('0');
        var n = intPart.Length - (all.Length - trimmed.Length) + exp;
        var digits = trimmed.TrimEnd('0');
        if (digits.Length == 0) return "0";
        var k = digits.Length;
        var sb = new StringBuilder();
        if (negative) sb.Append('-');
        if (k <= n && n <= 21) sb.Append(digits).Append('0', n - k);
        else if (0 < n && n <= 21) sb.Append(digits, 0, n).Append('.').Append(digits, n, k - n);
        else if (-6 < n && n <= 0) sb.Append("0.").Append('0', -n).Append(digits);
        else
        {
            sb.Append(digits[0]);
            if (k > 1) sb.Append('.').Append(digits, 1, k - 1);
            sb.Append('e').Append(n - 1 >= 0 ? '+' : '-').Append(Math.Abs(n - 1).ToString(CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }
}

/// <summary>Property and option ids: 8 characters of base 62 (db/ids.ts).</summary>
public static class DbIds
{
    public const string Digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    /// <summary>The colours a derived option is given, picked by its hash.</summary>
    public static readonly string[] OptionColours = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

    public static bool IsPropertyId(string? id) => id == PropertyDef.TitleId || IsShortId(id);

    public static bool IsShortId(string? id) => id is { Length: 8 } && id.All(c => c is >= '0' and <= '9' or >= 'A' and <= 'Z' or >= 'a' and <= 'z');

    public static string New()
    {
        var chars = new StringBuilder(8);
        Span<byte> bytes = stackalloc byte[16];
        while (chars.Length < 8)
        {
            RandomNumberGenerator.Fill(bytes);
            // 248 = 4 × 62: bytes above it are dropped so every digit is equally likely.
            foreach (var b in bytes)
                if (b < 248 && chars.Length < 8) chars.Append(Digits[b % 62]);
        }
        return chars.ToString();
    }

    /// <summary>
    /// The id and colour of an option made for <paramref name="name"/> by a type change or an
    /// import (db/ids.ts <c>derivedOption</c>): SHA-256 of the UTF-8 of <c>databaseId NUL
    /// propertyId NUL name</c> (then <c>NUL attempt</c> from attempt 1 while the id is taken); the
    /// id is bytes 0 to 7, each mod 62; the colour byte 8 mod 9.
    /// </summary>
    public static (string Id, string Colour) Derived(string databaseId, string propertyId, string name, IReadOnlySet<string>? taken = null)
    {
        for (var attempt = 0; ; attempt++)
        {
            var parts = attempt > 0 ? $"{databaseId}\0{propertyId}\0{name}\0{attempt.ToString(CultureInfo.InvariantCulture)}" : $"{databaseId}\0{propertyId}\0{name}";
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(parts));
            var id = new StringBuilder(8);
            for (var i = 0; i < 8; i++) id.Append(Digits[hash[i] % 62]);
            if (taken is null || !taken.Contains(id.ToString())) return (id.ToString(), OptionColours[hash[8] % OptionColours.Length]);
        }
    }
}
