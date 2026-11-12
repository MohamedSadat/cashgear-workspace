using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Cgw.Core.Databases;

/// <summary>What an export names by id: people, related rows, files.</summary>
public sealed class CsvLookups
{
    public IReadOnlyDictionary<string, string> People { get; init; } = new Dictionary<string, string>();
    public IReadOnlyDictionary<string, string> Rows { get; init; } = new Dictionary<string, string>();
    public IReadOnlyDictionary<string, string> Files { get; init; } = new Dictionary<string, string>();
}

/// <summary>
/// CSV (db/csv.ts). Parse (RFC 4180, leniently): a leading BOM dropped; records end at CRLF, LF or
/// a lone CR; the separator whichever of <c>, ; tab</c> appears most outside quotes in the first
/// record (ties: comma, semicolon, tab); empty lines skipped. Export: UTF-8 with a BOM, CRLF, the
/// view's shown properties with values in canonical form; text that a spreadsheet could run as a
/// formula gets one <c>'</c> before it, which import takes off.
/// </summary>
public static partial class Csv
{
    public const int MaxRows = 50_000;
    public const int MaxBytes = 20 * 1024 * 1024;

    private static readonly char[] Separators = [',', ';', '\t'];

    private static char SeparatorOf(string text)
    {
        var counts = new int[3];
        var quoted = false;
        foreach (var c in text)
        {
            if (c == '"') quoted = !quoted;
            else if (!quoted && c is '\n' or '\r') break;
            else if (!quoted && Array.IndexOf(Separators, c) is var at and >= 0) counts[at]++;
        }
        var best = 0;
        for (var i = 1; i < counts.Length; i++)
            if (counts[i] > counts[best]) best = i;
        return Separators[best];
    }

    /// <summary>The records of a CSV text, each a list of fields (db/csv.ts <c>parseCsv</c>).</summary>
    public static List<string[]> Parse(string input)
    {
        var text = input.StartsWith('\ufeff') ? input[1..] : input;
        var separator = SeparatorOf(text);
        var records = new List<string[]>();
        var record = new List<string>();
        var field = new StringBuilder();
        var inField = false;
        var any = false;
        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (c == '"' && !inField)
            {
                inField = any = true;
                i++;
                while (i < text.Length)
                {
                    if (text[i] == '"')
                    {
                        if (i + 1 >= text.Length || text[i + 1] != '"')
                        {
                            i++;
                            break;
                        }
                        i++;
                    }
                    field.Append(text[i++]);
                }
            }
            else if (c == separator)
            {
                record.Add(field.ToString());
                field.Clear();
                inField = false;
                any = true;
                i++;
            }
            else if (c is '\r' or '\n')
            {
                record.Add(field.ToString());
                if (any) records.Add([.. record]);
                record.Clear();
                field.Clear();
                inField = any = false;
                i += c == '\r' && i + 1 < text.Length && text[i + 1] == '\n' ? 2 : 1;
            }
            else
            {
                field.Append(c);
                inField = any = true;
                i++;
            }
        }
        if (any)
        {
            record.Add(field.ToString());
            records.Add([.. record]);
        }
        return records;
    }

    // Guard -----------------------------------------------------------------------------------------

    [GeneratedRegex("^'*[=+\\-@\\t\\r]")]
    private static partial Regex RiskyPattern();

    /// <summary>A text field as export writes it: one <c>'</c> before risky text (CSV injection).</summary>
    public static string Guard(string text) => RiskyPattern().IsMatch(text) ? "'" + text : text;

    /// <summary>A text field as import reads it: one leading <c>'</c> taken off risky text that has one.</summary>
    public static string Unguard(string text) => text.StartsWith('\'') && RiskyPattern().IsMatch(text) ? text[1..] : text;

    // Import ----------------------------------------------------------------------------------------

    private static readonly HashSet<string> TextKinds =
    [
        PropertyTypes.Title, PropertyTypes.Text, PropertyTypes.Url, PropertyTypes.Email, PropertyTypes.Phone,
        PropertyTypes.Select, PropertyTypes.Status, PropertyTypes.MultiSelect,
    ];

    /// <summary>A CSV cell as a value of the def: the text conversion, after <see cref="Unguard"/> for text kinds.</summary>
    public static object? TextToValue(PropertyDef def, string text) =>
        Values.FromText(def, TextKinds.Contains(def.Type) ? Unguard(text) : text);

    [GeneratedRegex(@"^https?://[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+\z", RegexOptions.IgnoreCase)]
    private static partial Regex UrlPattern();

    [GeneratedRegex(@"^[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff@]+@[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff@]+\.[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff@]+\z")]
    private static partial Regex EmailPattern();

    /// <summary>A new database's properties from a file (db/csv.ts <c>inferProperties</c>).</summary>
    public static List<JsonObject> InferProperties(IReadOnlyList<string> header, IReadOnlyList<string[]> rows, string databaseId = "", Func<string>? newId = null)
    {
        newId ??= DbIds.New;
        var width = Math.Max(header.Count, Math.Max(rows.Count == 0 ? 0 : rows.Max(r => r.Length), 1));
        var defs = new List<JsonObject>();
        for (var col = 0; col < width; col++)
        {
            var given = Unguard(DbText.Trim(col < header.Count ? header[col] : ""));
            var name = given.Length > 0 ? given : col == 0 ? "Name" : $"Column {col + 1}";
            if (col == 0)
            {
                defs.Add(new JsonObject { ["id"] = PropertyDef.TitleId, ["name"] = name, ["type"] = PropertyTypes.Title });
                continue;
            }
            var id = newId();
            var cells = rows.Select(r => DbText.Trim(col < r.Length ? r[col] : "")).Where(c => c.Length > 0).ToList();
            defs.Add(InferColumn(id, name, cells, databaseId));
        }
        return defs;
    }

    private static JsonObject InferColumn(string id, string name, List<string> cells, string databaseId)
    {
        JsonObject Def(string type) => new() { ["id"] = id, ["name"] = name, ["type"] = type };
        if (cells.Count == 0) return Def(PropertyTypes.Text);
        if (cells.All(c => DbText.ParseNumber(c) is not null))
        {
            var def = Def(PropertyTypes.Number);
            def["number"] = new JsonObject { ["format"] = "number", ["decimals"] = null };
            return def;
        }
        if (cells.All(c => DbText.ParseBoolean(c) is not null)) return Def(PropertyTypes.Checkbox);
        var dates = cells.Select(DbDates.ParseDateText).ToList();
        if (dates.All(d => d is not null))
        {
            var includeTime = dates.Any(d => !DbDates.IsDateOnly(d!.Start) || (!string.IsNullOrEmpty(d!.End) && !DbDates.IsDateOnly(d.End)));
            var def = Def(PropertyTypes.Date);
            def["date"] = new JsonObject { ["includeTime"] = includeTime };
            return def;
        }
        if (cells.All(c => UrlPattern().IsMatch(c))) return Def(PropertyTypes.Url);
        if (cells.All(c => EmailPattern().IsMatch(c))) return Def(PropertyTypes.Email);
        var distinct = new List<string>();
        foreach (var c in cells.Select(Unguard))
            if (!distinct.Contains(c, StringComparer.Ordinal)) distinct.Add(c);
        if (distinct.Count <= 50 && cells.Count >= 2 * distinct.Count)
        {
            var options = new JsonArray();
            var taken = new HashSet<string>(StringComparer.Ordinal);
            foreach (var option in distinct)
            {
                var (optionId, colour) = DbIds.Derived(databaseId, id, option, taken);
                taken.Add(optionId);
                options.Add(new JsonObject { ["id"] = optionId, ["name"] = option, ["colour"] = colour });
            }
            var def = Def(PropertyTypes.Select);
            def["options"] = options;
            return def;
        }
        return Def(PropertyTypes.Text);
    }

    // Export ----------------------------------------------------------------------------------------

    /// <summary>The properties a view shows: the title first, then <c>order</c>, then the rest in database order; hidden and deleted ones left out.</summary>
    public static List<PropertyDef> Shown(Schema schema, JsonObject? config)
    {
        var props = config?["properties"] as JsonObject;
        static IEnumerable<string> Strings(JsonNode? node) => (node as JsonArray)?.OfType<JsonValue>().Select(v => v.TryGetValue<string>(out var s) ? s : null).OfType<string>() ?? [];
        var hidden = Strings(props?["hidden"]).ToHashSet(StringComparer.Ordinal);
        var live = schema.Properties.Where(p => !p.Trashed).ToList();
        var shown = new List<PropertyDef>();
        if (live.FirstOrDefault(p => p.Type == PropertyTypes.Title) is { } title) shown.Add(title);
        void Add(PropertyDef? def)
        {
            if (def is not null && !hidden.Contains(def.Id) && !shown.Contains(def)) shown.Add(def);
        }
        foreach (var id in Strings(props?["order"])) Add(live.FirstOrDefault(p => p.Id == id));
        foreach (var def in live) Add(def);
        return shown;
    }

    private static string Named(IReadOnlyDictionary<string, string> lookup, string id) => lookup.GetValueOrDefault(id) ?? id;

    /// <summary>A cell's canonical text (unguarded); '' when empty or an error.</summary>
    public static string CellText(PropertyDef def, RowData row, CsvLookups lookups) => Canonical(def, Cells.Read(def, row), lookups);

    private static string Canonical(PropertyDef def, object? cell, CsvLookups lookups)
    {
        if (cell is null || Raw.IsError(cell)) return "";
        string List(object? ids, IReadOnlyDictionary<string, string> lookup) =>
            string.Join(", ", (Raw.List(ids) ?? []).Select(id => Named(lookup, id as string ?? "")));
        switch (def.Type)
        {
            case PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy: return List(cell, lookups.People);
            case PropertyTypes.Relation: return List(cell, lookups.Rows);
            case PropertyTypes.Files: return List(cell, lookups.Files);
            case PropertyTypes.Select or PropertyTypes.Status or PropertyTypes.MultiSelect:
            {
                var names = Cells.FormulaCell(def, cell);
                return names switch
                {
                    string[] list => string.Join(", ", list),
                    string s => s,
                    _ => "",
                };
            }
        }
        switch (cell)
        {
            case string s: return s;
            case double d: return JsNumber.ToString(d);
            case bool b: return b ? "true" : "false";
        }
        if (Raw.List(cell) is { } items)
            return string.Join(", ", items.Select(item => item is string id
                ? lookups.People.GetValueOrDefault(id) ?? lookups.Rows.GetValueOrDefault(id) ?? lookups.Files.GetValueOrDefault(id) ?? id
                : ""));
        return DbDates.Coerce(cell) is { } date ? DbDates.DateText(date) : "";
    }

    private static string Field(string text) =>
        text.IndexOfAny([',', '"', '\r', '\n']) >= 0 ? "\"" + text.Replace("\"", "\"\"") + "\"" : text;

    /// <summary><c>rowsToCsv</c>: the rows in the order given, templates and trashed rows left out, as text.</summary>
    public static string WriteText(Schema schema, JsonObject? viewConfig, IEnumerable<RowData> rows, CsvLookups lookups)
    {
        var shown = Shown(schema, viewConfig);
        var sb = new StringBuilder("\ufeff");
        sb.Append(string.Join(",", shown.Select(d => Field(Guard(d.Name))))).Append("\r\n");
        foreach (var row in rows)
        {
            if (row.IsTemplate || row.Trashed) continue;
            sb.Append(string.Join(",", shown.Select(d =>
            {
                var cell = Cells.Read(d, row);
                var text = Canonical(d, cell, lookups);
                return Field(cell is double ? text : Guard(text));
            }))).Append("\r\n");
        }
        return sb.ToString();
    }

    /// <summary>The export's bytes: <see cref="WriteText"/> in UTF-8 (its BOM is the text's first character).</summary>
    public static byte[] Write(Schema schema, JsonObject? viewConfig, IEnumerable<RowData> rows, CsvLookups lookups) =>
        Encoding.UTF8.GetBytes(WriteText(schema, viewConfig, rows, lookups));
}
