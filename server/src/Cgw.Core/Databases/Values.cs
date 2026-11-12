using System.Text.Json.Nodes;

namespace Cgw.Core.Databases;

/// <summary>
/// Property type changes (db/convert.ts): a value is first read as what it holds (its source), by
/// its old type, then written as the new type by the conversion table. Coercion
/// (<see cref="Values.Coerce"/>) reads any JSON through the same table.
/// </summary>
public static class Conversion
{
    public const int RelationLimit = 1000;

    public abstract record Source;
    public sealed record TextSource(string Text) : Source;
    public sealed record NumberSource(double Value) : Source;
    public sealed record DateSource(DateValue Value) : Source;
    public sealed record CheckSource(bool Value) : Source;
    public sealed record OptionsSource(List<string> Ids, List<string> Names) : Source;
    public sealed record IdsSource(string Of, List<string> Ids, string? DatabaseId) : Source;

    private static TextSource? Text(string text) => DbText.Trim(text).Length == 0 ? null : new TextSource(text);

    private static List<string> IdList(object? value)
    {
        IReadOnlyList<object?> list = value is string s ? [s] : Raw.List(value) ?? [];
        var ids = new List<string>();
        foreach (var item in list)
            if (item is string id && DbText.Trim(id).Length > 0 && !ids.Contains(id, StringComparer.Ordinal)) ids.Add(id);
        return ids;
    }

    /// <summary>A formula's or rollup's result, read as a source.</summary>
    private static Source? ResultSource(object? value)
    {
        switch (value)
        {
            case double d: return double.IsFinite(d) ? new NumberSource(d) : null;
            case string s: return Text(s);
            case bool b: return new CheckSource(b);
        }
        if (Raw.List(value) is { } list)
        {
            var items = list.OfType<string>().Where(i => i.Length > 0).ToList();
            return items.Count > 0 ? Text(string.Join(", ", items)) : null;
        }
        if (Raw.IsError(value)) return null;
        return DbDates.Coerce(value) is { } date ? new DateSource(date) : null;
    }

    /// <summary>What a value of <paramref name="from"/> holds; null when it holds nothing.</summary>
    public static Source? SourceOf(PropertyDef from, object? value)
    {
        if (value is null) return null;
        switch (from.Type)
        {
            case PropertyTypes.Title or PropertyTypes.Text or PropertyTypes.Url or PropertyTypes.Email or PropertyTypes.Phone:
                return value is string s ? Text(s) : null;
            case PropertyTypes.Number:
                return value is double d && double.IsFinite(d) ? new NumberSource(d) : null;
            case PropertyTypes.Checkbox:
                return value is true ? new CheckSource(true) : null;
            case PropertyTypes.Date or PropertyTypes.CreatedTime or PropertyTypes.LastEditedTime:
                return DbDates.Coerce(value) is { } date ? new DateSource(date) : null;
            case PropertyTypes.Select or PropertyTypes.Status or PropertyTypes.MultiSelect:
            {
                var known = new List<OptionDef>();
                foreach (var id in IdList(value))
                {
                    var option = from.Options.FirstOrDefault(o => o.Id == id);
                    if (option is not null && !known.Contains(option)) known.Add(option);
                }
                return known.Count == 0 ? null : new OptionsSource(known.Select(o => o.Id).ToList(), known.Select(o => o.Name).ToList());
            }
            case PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy or PropertyTypes.Files or PropertyTypes.Relation:
            {
                var ids = IdList(value);
                if (ids.Count == 0) return null;
                var of = from.Type == PropertyTypes.Files ? "files" : from.Type == PropertyTypes.Relation ? "relation" : "person";
                return new IdsSource(of, ids, from.RelationDatabase);
            }
            case PropertyTypes.Formula or PropertyTypes.Rollup:
                return ResultSource(value);
            default:
                return null;
        }
    }

    /// <summary>What any JSON holds, by its shape alone (coercion of a value written to a property).</summary>
    public static Source? JsonSource(object? raw)
    {
        switch (raw)
        {
            case string s: return Text(s);
            case double d: return double.IsFinite(d) ? new NumberSource(d) : null;
            case bool b: return new CheckSource(b);
        }
        if (Raw.List(raw) is { } list)
        {
            var items = list.OfType<string>().Where(i => DbText.Trim(i).Length > 0).ToList();
            return items.Count > 0 ? Text(string.Join(", ", items)) : null;
        }
        return DbDates.Coerce(raw) is { } date ? new DateSource(date) : null;
    }

    private static string? TextOf(Source s) => s switch
    {
        TextSource t => t.Text,
        NumberSource n => JsNumber.ToString(n.Value),
        DateSource d => DbDates.DateText(d.Value),
        CheckSource c => c.Value ? "true" : "false",
        OptionsSource o => string.Join(", ", o.Names),
        _ => null,
    };

    /// <summary>The one option name a scalar source gives.</summary>
    private static string? NameOf(Source s) => s switch
    {
        TextSource t => DbText.Trim(t.Text) is { Length: > 0 } name ? name : null,
        OptionsSource or IdsSource => null,
        _ => TextOf(s),
    };

    private static List<string> NamesNeeded(string to, Source? s)
    {
        if (s is null or OptionsSource or IdsSource) return [];
        if (to == PropertyTypes.MultiSelect && s is TextSource t) return DbText.SplitNames(t.Text);
        return NameOf(s) is { } name ? [name] : [];
    }

    private static OptionDef? ByName(IReadOnlyList<OptionDef> options, string? name) =>
        name is null ? null : options.FirstOrDefault(o => o.Name == name);

    private static string? OneName(Source s) => s is OptionsSource { Names.Count: 1 } o ? o.Names[0] : null;

    private static double Zeroless(double n) => n == 0 ? 0 : n;

    /// <summary>A source written as <paramref name="to"/>'s type: the table.</summary>
    public static object? ToTarget(PropertyDef to, Source s)
    {
        switch (to.Type)
        {
            case PropertyTypes.Title or PropertyTypes.Text:
            {
                var text = TextOf(s);
                return !string.IsNullOrEmpty(text) && DbText.Trim(text).Length > 0 ? text : null;
            }
            case PropertyTypes.Url or PropertyTypes.Email or PropertyTypes.Phone:
                return TextOf(s) is { } written && DbText.Trim(written) is { Length: > 0 } trimmed ? trimmed : null;
            case PropertyTypes.Number:
                switch (s)
                {
                    case NumberSource n: return Zeroless(n.Value);
                    case TextSource numberText: return DbText.ParseNumber(numberText.Text);
                    case CheckSource c: return c.Value ? 1.0 : null;
                }
                return OneName(s) is { } numberName ? DbText.ParseNumber(numberName) : null;
            case PropertyTypes.Date:
                switch (s)
                {
                    case DateSource d: return d.Value;
                    case TextSource dateText: return DbDates.ParseDateText(dateText.Text);
                }
                return OneName(s) is { } dateName ? DbDates.ParseDateText(dateName) : null;
            case PropertyTypes.Checkbox:
            {
                bool? checkedValue = s switch
                {
                    CheckSource c => c.Value,
                    NumberSource n => n.Value != 0,
                    TextSource word => DbText.ParseBoolean(word.Text),
                    OptionsSource => OneName(s) is { } name ? DbText.ParseBoolean(name) : null,
                    _ => null,
                };
                return checkedValue == true ? true : null;
            }
            case PropertyTypes.Select or PropertyTypes.Status:
            {
                var options = to.Options;
                if (s is OptionsSource o)
                {
                    foreach (var id in o.Ids)
                        if (options.Any(x => x.Id == id)) return id;
                    foreach (var name in o.Names)
                        if (ByName(options, name) is { } option) return option.Id;
                    return null;
                }
                return ByName(options, NameOf(s))?.Id;
            }
            case PropertyTypes.MultiSelect:
            {
                var options = to.Options;
                List<string?> found = s switch
                {
                    OptionsSource o => o.Ids.Select((id, i) => options.Any(x => x.Id == id) ? id : ByName(options, o.Names[i])?.Id).ToList(),
                    TextSource parts => DbText.SplitNames(parts.Text).Select(name => ByName(options, name)?.Id).ToList(),
                    _ => [ByName(options, NameOf(s))?.Id],
                };
                var unique = new List<string>();
                foreach (var id in found)
                    if (id is not null && !unique.Contains(id, StringComparer.Ordinal)) unique.Add(id);
                return unique.Count > 0 ? unique.ToArray() : null;
            }
            case PropertyTypes.Person or PropertyTypes.Files:
                return s is IdsSource ids && ids.Of == to.Type ? ids.Ids.ToArray() : null;
            case PropertyTypes.Relation:
                return s is IdsSource { Of: "relation", DatabaseId: { } database } rows && database == to.RelationDatabase
                    ? rows.Ids.Take(RelationLimit).ToArray()
                    : null;
            default:
                return null;
        }
    }

    /// <summary>A value of <paramref name="from"/> as <paramref name="to"/>'s type; null is no value.</summary>
    public static object? Value(PropertyDef from, PropertyDef to, object? value) =>
        SourceOf(from, value) is { } s ? ToTarget(to, s) : null;

    public static bool CanChangeType(string from, string to) => from == to || (from != PropertyTypes.Title && to != PropertyTypes.Title);

    private static JsonObject Shape(JsonObject option, string type)
    {
        var copy = (JsonObject)option.DeepClone();
        if (type == PropertyTypes.Status && !copy.ContainsKey("group")) copy["group"] = "todo";
        return copy;
    }

    /// <summary>
    /// A property's type change (db/convert.ts <c>convertProperty</c>): the new def, with the
    /// options its values need (the caller's stay; from an option type, the old def's are added by
    /// id; then each name the values need that no option has, in first-seen order, with
    /// <see cref="DbIds.Derived"/>'s id and colour), and each value converted, in order.
    /// </summary>
    public static (JsonObject Def, List<object?> Values) Property(PropertyDef from, JsonObject to, IReadOnlyList<object?> values, string databaseId)
    {
        var target = PropertyDef.Parse(to);
        if (!CanChangeType(from.Type, target.Type)) throw new InvalidOperationException("The title property keeps its type");
        var def = (JsonObject)to.DeepClone();
        if (PropertyTypes.HasOptions(target.Type))
        {
            var options = new JsonArray();
            foreach (var option in (to["options"] as JsonArray)?.OfType<JsonObject>() ?? []) options.Add(Shape(option, target.Type));
            if (PropertyTypes.HasOptions(from.Type))
                foreach (var option in (from.Json["options"] as JsonArray)?.OfType<JsonObject>() ?? [])
                {
                    var id = option["id"]?.GetValue<string>();
                    if (!options.OfType<JsonObject>().Any(o => o["id"]?.GetValue<string>() == id)) options.Add(Shape(option, target.Type));
                }
            var names = new List<string>();
            foreach (var value in values)
                foreach (var name in NamesNeeded(target.Type, SourceOf(from, value)))
                    if (!names.Contains(name, StringComparer.Ordinal)) names.Add(name);
            foreach (var name in names)
            {
                if (options.OfType<JsonObject>().Any(o => o["name"] is JsonValue n && n.TryGetValue<string>(out var s) && s == name)) continue;
                var taken = options.OfType<JsonObject>().Select(o => o["id"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "").ToHashSet(StringComparer.Ordinal);
                var (id, colour) = DbIds.Derived(databaseId, target.Id, name, taken);
                var made = new JsonObject { ["id"] = id, ["name"] = name, ["colour"] = colour };
                if (target.Type == PropertyTypes.Status) made["group"] = "todo";
                options.Add(made);
            }
            def["options"] = options;
        }
        var parsed = PropertyDef.Parse(def);
        return (def, values.Select(v => Value(from, parsed, v)).ToList());
    }
}

/// <summary>Coercion, emptiness and cells (db/values.ts).</summary>
public static class Values
{
    public static bool IsEmptyValue(object? value) =>
        value is null || (value is string s && DbText.Trim(s).Length == 0) || Raw.List(value) is { Count: 0 };

    private static string? OptionOf(IReadOnlyList<OptionDef> options, object? raw)
    {
        string? name = null;
        if (raw is string s)
        {
            if (options.Any(o => o.Id == s)) return s;
            name = DbText.Trim(s);
        }
        else if (raw is double d && double.IsFinite(d)) name = JsNumber.ToString(d);
        else if (raw is bool b) name = b ? "true" : "false";
        else if (DbDates.Coerce(raw) is { } date) name = DbDates.DateText(date);
        return name is null ? null : options.FirstOrDefault(o => o.Name == name)?.Id;
    }

    private static string[] UniqueIds(IEnumerable<object?> list)
    {
        var ids = new List<string>();
        foreach (var id in list)
            if (id is string s && DbText.Trim(s).Length > 0 && !ids.Contains(s, StringComparer.Ordinal)) ids.Add(s);
        return ids.ToArray();
    }

    /// <summary>
    /// Any JSON written to a property, as its type's value (db/values.ts <c>coerceValue</c>); null
    /// is no value (the write clears it).
    /// </summary>
    public static object? Coerce(PropertyDef def, object? raw)
    {
        if (raw is null) return null;
        var options = def.Options;
        switch (def.Type)
        {
            case PropertyTypes.Select or PropertyTypes.Status:
            {
                foreach (var candidate in Raw.List(raw) ?? [raw])
                    if (OptionOf(options, candidate) is { } id) return id;
                return null;
            }
            case PropertyTypes.MultiSelect:
            {
                IReadOnlyList<object?> parts = Raw.List(raw)
                    ?? (raw is string s && !options.Any(o => o.Id == s) ? DbText.SplitNames(s).Cast<object?>().ToList() : [raw]);
                var ids = UniqueIds(parts.Select(p => OptionOf(options, p)));
                return ids.Length > 0 ? ids : null;
            }
            case PropertyTypes.Person or PropertyTypes.Files or PropertyTypes.Relation:
            {
                IReadOnlyList<object?> list = raw is string one ? [one] : Raw.List(raw) ?? [];
                var ids = UniqueIds(list);
                if (def.Type == PropertyTypes.Relation && ids.Length > Conversion.RelationLimit) ids = ids[..Conversion.RelationLimit];
                return ids.Length > 0 ? ids : null;
            }
            case PropertyTypes.Formula or PropertyTypes.Rollup or PropertyTypes.CreatedTime or PropertyTypes.CreatedBy
                or PropertyTypes.LastEditedTime or PropertyTypes.LastEditedBy:
                return null;
            default:
                return Conversion.JsonSource(raw) is { } source ? Conversion.ToTarget(def, source) : null;
        }
    }

    /// <summary>A cell's text as an import reads it (db/csv.ts <c>textToValue</c>): the text conversion.</summary>
    public static object? FromText(PropertyDef def, string text) => Conversion.Value(TextDef, def, text);

    private static readonly PropertyDef TextDef = PropertyDef.Parse(new JsonObject { ["id"] = "", ["name"] = "", ["type"] = PropertyTypes.Text });

    public static readonly string[] Colours = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
}
