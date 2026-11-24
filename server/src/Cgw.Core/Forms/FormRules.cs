using System.Text.Json.Nodes;
using Cgw.Core.Databases;

namespace Cgw.Core.Forms;

/// <summary>A form's question (db/forms.ts <c>FormQuestion</c>).</summary>
public sealed record FormQuestion(string PropertyId, string? Label, string? Help, bool Required, IReadOnlyList<string>? Options);

/// <summary>A page of questions, shown when its condition matches the answers before it.</summary>
public sealed record FormPage(string? Title, string? Description, IReadOnlyList<FormQuestion> Questions, JsonObject? When);

/// <summary>A form as it is drawn and checked (db/forms.ts <c>FormConfig</c>), every field present.</summary>
public sealed record FormConfig(string? Title, string? Description, IReadOnlyList<FormPage> Pages, string? Thanks, string? Submit, string Language)
{
    public static readonly FormConfig Empty = new(null, null, [], null, null, "en");
}

/// <summary>Why an answer is refused, naming its question (null for the whole answer).</summary>
public sealed record FormProblem(string? PropertyId, string Reason);

/// <summary>An answer kept: the row's title and values, and the pages it showed.</summary>
public sealed record FormAnswer(string Title, Dictionary<string, object> Values, IReadOnlyList<int> Pages);

/// <summary>
/// The form rules (Phase 16), ported from packages/workspace/src/db/forms.ts and held to it by
/// packages/workspace/vectors/db-form-vectors.json: a view's form read for the app or a link
/// (<see cref="Read"/>), the pages an answer shows (<see cref="Next"/>, <see cref="Previous"/>), and
/// what an answer keeps or why it is refused (<see cref="Check"/>).
/// </summary>
public static class FormRules
{
    public const int MaxPages = 20;
    public const int MaxQuestions = 100;
    public const int MaxLabel = 200;
    public const int MaxHelp = 1000;
    public const int MaxText = 2000;
    public const int MaxAnswerText = 10_000;
    public const int MaxAnswerTitle = 1000;
    /// <summary>A link's answer as posted, at most: the API's and the Sites process's limit.</summary>
    public const int MaxAnswerBytes = 65_536;
    public const int AnswersPerMinute = 10;
    public const int AnswersPerDay = 100;

    public static readonly string[] LinkTypes =
    [
        PropertyTypes.Title, PropertyTypes.Text, PropertyTypes.Number, PropertyTypes.Select, PropertyTypes.MultiSelect, PropertyTypes.Status,
        PropertyTypes.Date, PropertyTypes.Checkbox, PropertyTypes.Url, PropertyTypes.Email, PropertyTypes.Phone,
    ];

    public static readonly string[] AppTypes = [.. LinkTypes, PropertyTypes.Person, PropertyTypes.Files, PropertyTypes.Relation];

    private static readonly HashSet<string> TextTypes = [PropertyTypes.Title, PropertyTypes.Text, PropertyTypes.Url, PropertyTypes.Email, PropertyTypes.Phone];

    private static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>Text cut to <paramref name="max"/> UTF-16 units; anything else, or an empty text, is null.</summary>
    private static string? Words(JsonNode? node, int max) =>
        Str(node) is { Length: > 0 } s ? (s.Length > max ? s[..max] : s) : null;

    /// <summary>A filter group's shape (two levels, 50 children each), or null (forms.ts <c>readGroup</c>).</summary>
    private static JsonObject? ReadGroup(JsonNode? value, int depth = 1)
    {
        if (value is not JsonObject g || Str(g["kind"]) != "group") return null;
        if (Str(g["op"]) is not ("and" or "or")) return null;
        if (g["children"] is not JsonArray children || children.Count > 50) return null;
        var list = new JsonArray();
        foreach (var child in children)
        {
            if (child is JsonObject o && Str(o["kind"]) == "group")
            {
                if (depth >= 2) return null;
                if (ReadGroup(o, depth + 1) is not { } inner) return null;
                list.Add(inner);
                continue;
            }
            if (child is not JsonObject c || Str(c["kind"]) != "condition" || !DbIds.IsPropertyId(Str(c["propertyId"]))) return null;
            if (Str(c["operator"]) is not { } op) return null;
            var condition = new JsonObject { ["kind"] = "condition", ["propertyId"] = Str(c["propertyId"]), ["operator"] = op };
            if (c.ContainsKey("value")) condition["value"] = c["value"]?.DeepClone();
            list.Add(condition);
        }
        return new JsonObject { ["kind"] = "group", ["op"] = Str(g["op"]), ["children"] = list };
    }

    /// <summary>
    /// A view's form (its config's <c>form</c>) as it is drawn and checked, for a link or the app
    /// (forms.ts <c>readForm</c>): 20 pages and 100 questions at most, a question only of a live
    /// property of a type the mode asks, each property once, its options only the property's own in
    /// its order, words cut to their lengths, a condition only a filter group's shape.
    /// </summary>
    public static FormConfig Read(JsonNode? config, Schema db, bool link)
    {
        if ((config as JsonObject)?["form"] is not JsonObject value) return FormConfig.Empty;
        var allowed = (link ? LinkTypes : AppTypes).ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var pages = new List<FormPage>();
        foreach (var raw in value["pages"] as JsonArray ?? [])
        {
            if (pages.Count >= MaxPages) break;
            if (raw is not JsonObject page) continue;
            var questions = new List<FormQuestion>();
            foreach (var q in page["questions"] as JsonArray ?? [])
            {
                if (seen.Count >= MaxQuestions) break;
                if (q is not JsonObject question) continue;
                if (Str(question["propertyId"]) is not { } id || db.Live(id) is not { } def || seen.Contains(def.Id)) continue;
                seen.Add(def.Id);
                if (!allowed.Contains(def.Type)) continue;
                List<string>? options = null;
                if (PropertyTypes.HasOptions(def.Type) && question["options"] is JsonArray given)
                {
                    var wanted = given.Select(Str).Where(DbIds.IsShortId).ToHashSet(StringComparer.Ordinal);
                    options = def.Options.Select(o => o.Id).Where(wanted.Contains).ToList();
                }
                questions.Add(new FormQuestion(def.Id, Words(question["label"], MaxLabel), Words(question["help"], MaxHelp),
                    question["required"] is JsonValue r && r.TryGetValue<bool>(out var required) && required, options));
            }
            pages.Add(new FormPage(Words(page["title"], MaxLabel), Words(page["description"], MaxText), questions, ReadGroup(page["when"])));
        }
        return new FormConfig(Words(value["title"], MaxLabel), Words(value["description"], MaxText), pages,
            Words(value["thanks"], MaxText), Words(value["submit"], MaxLabel), Str(value["language"]) == "ar" ? "ar" : "en");
    }

    /// <summary>The form as forms.ts writes it (the vectors' shape).</summary>
    public static JsonObject ToJson(FormConfig form) => new()
    {
        ["title"] = form.Title,
        ["description"] = form.Description,
        ["pages"] = new JsonArray(form.Pages.Select(p => (JsonNode)new JsonObject
        {
            ["title"] = p.Title,
            ["description"] = p.Description,
            ["questions"] = new JsonArray(p.Questions.Select(q => (JsonNode)new JsonObject
            {
                ["propertyId"] = q.PropertyId,
                ["label"] = q.Label,
                ["help"] = q.Help,
                ["required"] = q.Required,
                ["options"] = q.Options is null ? null : new JsonArray(q.Options.Select(o => (JsonNode)JsonValue.Create(o)).ToArray()),
            }).ToArray()),
            ["when"] = p.When?.DeepClone(),
        }).ToArray()),
        ["thanks"] = form.Thanks,
        ["submit"] = form.Submit,
        ["language"] = form.Language,
    };

    private static RowData AnswersRow(Schema db, IReadOnlyDictionary<string, object> values)
    {
        var row = new RowData { Id = Guid.Empty, DatabaseId = db.Id, OrderKey = "a0" };
        foreach (var (key, value) in values)
        {
            if (key == PropertyDef.TitleId)
            {
                if (value is string title) row.Title = title;
                continue;
            }
            row.Values[key] = value;
        }
        return row;
    }

    /// <summary>One question's answer: its value, nothing (not answered), or why it is refused.</summary>
    private static (object? Value, string? Problem) AnswerOf(PropertyDef def, FormQuestion question, object? raw)
    {
        if (Values.IsEmptyValue(raw) || (def.Type == PropertyTypes.Checkbox && raw is false))
            return (null, question.Required ? "answer.required" : null);
        object? value;
        if (def.Type == PropertyTypes.MultiSelect)
        {
            // Each choice on its own: one that is no option of the property is refused, never dropped.
            var one = new PropertyDef { Id = def.Id, Name = def.Name, Type = PropertyTypes.Select, OptionList = def.OptionList, Json = def.Json };
            var ids = new List<string>();
            foreach (var part in Raw.List(raw) ?? [raw])
            {
                if (Values.Coerce(one, part) is not string id) return (null, "answer.invalid");
                if (!ids.Contains(id, StringComparer.Ordinal)) ids.Add(id);
            }
            value = ids.Count > 0 ? ids.ToArray() : null;
        }
        else value = Values.Coerce(def, raw);
        if (value is null || Values.IsEmptyValue(value)) return (null, "answer.invalid");
        if (question.Options is { } shown && PropertyTypes.HasOptions(def.Type))
        {
            var chosen = value as string[] ?? [(string)value];
            if (chosen.Any(id => !shown.Contains(id, StringComparer.Ordinal))) return (null, "answer.option");
        }
        if (TextTypes.Contains(def.Type) && value is string text && text.Length > (def.Type == PropertyTypes.Title ? MaxAnswerTitle : MaxAnswerText))
            return (null, "answer.long");
        return (value, null);
    }

    private sealed record Walk(List<int> Shown, Dictionary<string, object> Values, List<FormProblem> Problems);

    private static Walk Pages(FormConfig form, Schema db, IReadOnlyDictionary<string, object?> raw, QueryContext ctx, int upTo = int.MaxValue)
    {
        var shown = new List<int>();
        var values = new Dictionary<string, object>(StringComparer.Ordinal);
        var problems = new List<FormProblem>();
        for (var i = 0; i < form.Pages.Count && i <= upTo; i++)
        {
            var page = form.Pages[i];
            if (page.When is { } when && !Query.Matches(db, AnswersRow(db, values), Raw.From(when), ctx)) continue;
            shown.Add(i);
            foreach (var question in page.Questions)
            {
                if (db.Live(question.PropertyId) is not { } def) continue;
                var (value, problem) = AnswerOf(def, question, raw.GetValueOrDefault(question.PropertyId));
                if (problem is not null) problems.Add(new FormProblem(def.Id, problem));
                if (value is not null) values[def.Id] = value;
            }
        }
        return new Walk(shown, values, problems);
    }

    /// <summary>The pages an answer shows, by index, in order.</summary>
    public static IReadOnlyList<int> Shown(FormConfig form, Schema db, IReadOnlyDictionary<string, object?> raw, QueryContext ctx) =>
        Pages(form, db, raw, ctx).Shown;

    /// <summary>The page shown after <paramref name="after"/> (-1 for the first), or null when it is the last.</summary>
    public static int? Next(FormConfig form, Schema db, IReadOnlyDictionary<string, object?> raw, QueryContext ctx, int after) =>
        Pages(form, db, raw, ctx).Shown.Where(i => i > after).Select(i => (int?)i).FirstOrDefault();

    /// <summary>The page shown before <paramref name="before"/>, or null.</summary>
    public static int? Previous(FormConfig form, Schema db, IReadOnlyDictionary<string, object?> raw, QueryContext ctx, int before) =>
        Pages(form, db, raw, ctx).Shown.Where(i => i < before).Select(i => (int?)i).LastOrDefault();

    /// <summary>
    /// An answer checked, the pages up to <paramref name="upTo"/> (forms.ts <c>checkAnswers</c>):
    /// the answer kept, or every problem in the order of the questions (a whole answer with nothing in
    /// it: <c>answer.empty</c>).
    /// </summary>
    public static (FormAnswer? Answer, IReadOnlyList<FormProblem> Problems) Check(FormConfig form, Schema db, IReadOnlyDictionary<string, object?> raw, QueryContext ctx, int upTo = int.MaxValue)
    {
        var walk = Pages(form, db, raw, ctx, upTo);
        if (walk.Problems.Count > 0) return (null, walk.Problems);
        if (upTo == int.MaxValue && walk.Values.Count == 0) return (null, [new FormProblem(null, "answer.empty")]);
        var title = walk.Values.Remove(PropertyDef.TitleId, out var t) && t is string s ? s : "";
        return (new FormAnswer(title, walk.Values, walk.Shown), []);
    }
}
