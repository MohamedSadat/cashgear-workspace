using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Cgw.Core.Databases;
using Cgw.Core.Sync;

namespace Cgw.Core.Automations;

/// <summary>A refused rule: <see cref="Reason"/> names the part, as packages/workspace/src/db/automations.ts does.</summary>
public sealed class AutomationInvalid(string reason, string message) : OpFailure("invalid", message)
{
    public string Reason { get; } = reason;
}

/// <summary>A change of a row, as an <c>AutomationEvent</c> holds it (db/automations.ts <c>RowChange</c>).</summary>
public sealed record RowChange(string Kind, IReadOnlyList<string> Changed, IReadOnlyDictionary<string, object> Before, IReadOnlyDictionary<string, object> After, string? PropertyId = null);

/// <summary>
/// The rules' own rules, ported from packages/workspace/src/db/automations.ts and held to it by
/// packages/workspace/vectors/db-automation-vectors.json: what a rule is (<see cref="Check"/>) and
/// which change of a row starts its trigger (<see cref="Starts"/>).
/// </summary>
public static partial class AutomationRules
{
    public const int MaxAutomations = 50;
    public const int MaxSteps = 20;
    public const int MaxStepValues = 50;
    public const int MaxRecipients = 100;
    public const int MaxMessage = 1000;
    public const int MaxName = 200;
    public const int MaxOffsetMinutes = 43_200;
    public const int MaxChars = 100_000;
    public const int MaxDepth = 3;
    public const int RuleRunsPerMinute = 100;
    public const int WorkspaceRunsPerMinute = 1000;
    public const int RunsKeptDays = 30;

    /// <summary>Triggers a change of a row starts (the others are reached by time or a press).</summary>
    public static bool IsEventTrigger(string kind) => kind is "rowAdded" or "propertyChanged";

    private static readonly HashSet<string> Operators =
    [
        "is", "isNot", "contains", "doesNotContain", "startsWith", "endsWith", "isEmpty", "isNotEmpty", "eq", "ne", "gt", "lt", "ge", "le",
        "before", "after", "onOrBefore", "onOrAfter", "group",
    ];

    private static readonly HashSet<string> PeopleTypes = [PropertyTypes.Person, PropertyTypes.CreatedBy, PropertyTypes.LastEditedBy];
    private static readonly HashSet<string> DateTriggerTypes = [PropertyTypes.Date, PropertyTypes.CreatedTime];

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")]
    private static partial Regex Uuid();

    [GeneratedRegex("^([01][0-9]|2[0-3]):[0-5][0-9]$")]
    private static partial Regex Time();

    public static bool IsId(JsonNode? node) => Str(node) is { } s && Uuid().IsMatch(s);
    public static bool IsTimeOfDay(JsonNode? node) => Str(node) is { } s && Time().IsMatch(s);

    private static AutomationInvalid Fail(string reason, string message) => new(reason, message);

    private static string? Str(JsonNode? node) => node is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;
    private static bool IsNumber(JsonNode? node) => node is JsonValue v && v.GetValueKind() == JsonValueKind.Number;
    private static bool IsBool(JsonNode? node) => node is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False;
    private static bool IsNull(JsonNode? node) => node is null || (node is JsonValue v && v.GetValueKind() == JsonValueKind.Null);

    /// <summary>A whole number within the range (JavaScript's <c>Number.isInteger</c>: 2.0 is whole).</summary>
    private static bool Whole(JsonNode? node, double min, double max) =>
        IsNumber(node) && node!.GetValue<double>() is var d && d == Math.Floor(d) && d >= min && d <= max;

    private static PropertyDef? Live(Schema db, JsonNode? id) => Str(id) is { } s ? db.Live(s) : null;
    private static bool Writable(PropertyDef def) => def.Type == PropertyTypes.Title || PropertyTypes.IsStored(def.Type);

    private static JsonNode? Copy(JsonNode? node) => node?.DeepClone();

    // Filters ------------------------------------------------------------------------------------------

    private static JsonNode CheckFilterValue(JsonNode? value, string reason)
    {
        if (Str(value) is not null || IsBool(value) || IsNumber(value)) return value!.DeepClone();
        if (value is JsonObject o && o.Count == 1)
        {
            if (Str(o["date"]) is { } date) return new JsonObject { ["date"] = date };
            if (Str(o["relative"]) is { } relative) return new JsonObject { ["relative"] = relative };
            if (o["me"] is JsonValue me && me.GetValueKind() == JsonValueKind.True) return new JsonObject { ["me"] = true };
        }
        throw Fail(reason, "Not a filter value");
    }

    private static JsonObject CheckCondition(JsonNode? value, string reason)
    {
        if (value is not JsonObject c || Str(c["kind"]) != "condition") throw Fail(reason, "A condition is an object");
        if (!DbIds.IsPropertyId(Str(c["propertyId"]))) throw Fail(reason, "A condition names a property");
        if (Str(c["operator"]) is not { } op || !Operators.Contains(op)) throw Fail(reason, "Not a filter operator");
        var output = new JsonObject { ["kind"] = "condition", ["propertyId"] = Str(c["propertyId"]), ["operator"] = op };
        if (c.ContainsKey("value")) output["value"] = CheckFilterValue(c["value"], reason);
        return output;
    }

    private static JsonObject CheckGroup(JsonNode? value, string reason, int depth = 1)
    {
        if (value is not JsonObject g || Str(g["kind"]) != "group") throw Fail(reason, "Conditions are a filter group");
        if (Str(g["op"]) is not ("and" or "or")) throw Fail(reason, "A group is \"and\" or \"or\"");
        if (g["children"] is not JsonArray children || children.Count > 50) throw Fail(reason, "A group holds at most 50 conditions");
        var list = new JsonArray();
        foreach (var child in children)
        {
            if (child is JsonObject o && Str(o["kind"]) == "group")
            {
                if (depth >= 2) throw Fail(reason, "Conditions nest at most two levels");
                list.Add(CheckGroup(child, reason, depth + 1));
            }
            else list.Add(CheckCondition(child, reason));
        }
        return new JsonObject { ["kind"] = "group", ["op"] = Str(g["op"]), ["children"] = list };
    }

    // Triggers -------------------------------------------------------------------------------------------

    private static JsonObject? CheckTriggerValue(JsonNode? value)
    {
        if (IsNull(value)) return null;
        if (value is not JsonObject o || Str(o["operator"]) is not { } op || !Operators.Contains(op))
            throw Fail("trigger", "From and to are an operator and a value");
        var output = new JsonObject { ["operator"] = op };
        if (o.ContainsKey("value")) output["value"] = CheckFilterValue(o["value"], "trigger");
        return output;
    }

    private static JsonObject CheckTrigger(JsonNode? value, Schema db)
    {
        if (value is not JsonObject t) throw Fail("trigger", "A rule has a trigger");
        switch (Str(t["kind"]))
        {
            case "rowAdded":
                return new JsonObject { ["kind"] = "rowAdded" };
            case "propertyChanged":
            {
                var id = IsNull(t["propertyId"]) ? null : t["propertyId"];
                if (id is not null && (Live(db, id) is not { } def || !Writable(def)))
                    throw Fail("trigger.property", "A change is watched on the title or a stored property");
                var from = CheckTriggerValue(t["from"]);
                var to = CheckTriggerValue(t["to"]);
                if (id is null && (from is not null || to is not null)) throw Fail("trigger", "From and to need the property they are about");
                return new JsonObject { ["kind"] = "propertyChanged", ["propertyId"] = Copy(id), ["from"] = from, ["to"] = to };
            }
            case "date":
            {
                if (Live(db, t["propertyId"]) is not { } def || !DateTriggerTypes.Contains(def.Type))
                    throw Fail("trigger.property", "A date trigger names a date or created-time property");
                if (!Whole(t["offsetMinutes"], -MaxOffsetMinutes, MaxOffsetMinutes)) throw Fail("trigger", "The offset is whole minutes, at most 30 days either way");
                var at = IsNull(t["at"]) ? null : t["at"];
                if (at is not null && !IsTimeOfDay(at)) throw Fail("trigger", "A time of day is HH:mm");
                return new JsonObject { ["kind"] = "date", ["propertyId"] = def.Id, ["offsetMinutes"] = Copy(t["offsetMinutes"]), ["at"] = Copy(at) };
            }
            case "schedule":
            {
                var every = Str(t["every"]);
                if (every is not ("day" or "week" or "month")) throw Fail("trigger", "A schedule is every day, week or month");
                if (!IsTimeOfDay(t["at"])) throw Fail("trigger", "A time of day is HH:mm");
                var output = new JsonObject { ["kind"] = "schedule", ["every"] = every, ["at"] = Str(t["at"]), ["weekday"] = null, ["day"] = null };
                if (every == "week")
                {
                    if (!Whole(t["weekday"], 0, 6)) throw Fail("trigger", "A weekly schedule names its day");
                    output["weekday"] = Copy(t["weekday"]);
                }
                if (every == "month")
                {
                    if (!Whole(t["day"], 1, 31)) throw Fail("trigger", "A monthly schedule names its day");
                    output["day"] = Copy(t["day"]);
                }
                return output;
            }
            case "button":
            {
                if (Live(db, t["propertyId"]) is not { Type: PropertyTypes.Button } def) throw Fail("trigger.property", "A button trigger names a button property");
                return new JsonObject { ["kind"] = "button", ["propertyId"] = def.Id };
            }
            default:
                throw Fail("trigger", "Not a trigger");
        }
    }

    // Steps ----------------------------------------------------------------------------------------------

    private static JsonNode? CheckStepValue(JsonNode? value, PropertyDef? def, bool rowTrigger)
    {
        if (IsNull(value)) return null;
        if (value is JsonObject o && o.ContainsKey("dynamic"))
        {
            switch (Str(o["dynamic"]))
            {
                case "now":
                    if (o.Any(p => p.Key is not ("dynamic" or "days"))) throw Fail("step.value", "Not a value a step writes");
                    if (def is not null && def.Type != PropertyTypes.Date) throw Fail("step.value", "\"Now\" is written into a date");
                    if (o.ContainsKey("days") && !Whole(o["days"], -3650, 3650)) throw Fail("step.value", "Days are whole, at most ten years either way");
                    return o.ContainsKey("days") ? new JsonObject { ["dynamic"] = "now", ["days"] = Copy(o["days"]) } : new JsonObject { ["dynamic"] = "now" };
                case "actor":
                    if (o.Count != 1) throw Fail("step.value", "Not a value a step writes");
                    if (!rowTrigger) throw Fail("step.value", "A schedule has nobody who started it");
                    if (def is not null && def.Type != PropertyTypes.Person) throw Fail("step.value", "\"Who started it\" is written into a person");
                    return new JsonObject { ["dynamic"] = "actor" };
                case "row":
                    if (o.Count != 1) throw Fail("step.value", "Not a value a step writes");
                    if (!rowTrigger) throw Fail("step.value", "A schedule has no row");
                    if (def is not null && def.Type != PropertyTypes.Relation) throw Fail("step.value", "\"This row\" is written into a relation");
                    return new JsonObject { ["dynamic"] = "row" };
                default:
                    throw Fail("step.value", "Not a value a step writes");
            }
        }
        if (Str(value) is not null || IsBool(value) || IsNumber(value)) return value!.DeepClone();
        if (value is JsonArray list && list.Count <= 1000 && list.All(x => Str(x) is not null)) return list.DeepClone();
        if (value is JsonObject date && Str(date["start"]) is { } start && date.All(p => p.Key is "start" or "end")
            && (!date.ContainsKey("end") || IsNull(date["end"]) || Str(date["end"]) is not null))
            return Str(date["end"]) is { } end ? new JsonObject { ["start"] = start, ["end"] = end } : new JsonObject { ["start"] = start };
        throw Fail("step.value", "Not a value a step writes");
    }

    private static JsonObject CheckValues(JsonNode? value, Schema? db, bool rowTrigger, bool atLeastOne)
    {
        if (value is not JsonObject values) throw Fail("step.values", "A step writes an object of values");
        if (values.Count > MaxStepValues) throw Fail("step.values", "A step writes at most 50 values");
        if (atLeastOne && values.Count == 0) throw Fail("step.values", "A step sets at least one property");
        var output = new JsonObject();
        foreach (var (id, raw) in values)
        {
            if (!DbIds.IsPropertyId(id)) throw Fail("step.values", $"Not a property id: {id}");
            PropertyDef? def = null;
            if (db is not null)
            {
                def = db.Live(id);
                if (def is null || !Writable(def)) throw Fail("step.values", $"Property {id} is not one a step writes");
            }
            if (id == PropertyDef.TitleId && !IsNull(raw) && Str(raw) is null) throw Fail("step.value", "A title is text");
            output[id] = CheckStepValue(raw, def, rowTrigger);
        }
        return output;
    }

    private static JsonArray CheckIds(JsonNode? value, string reason, int max = MaxRecipients)
    {
        if (value is null) return [];
        if (value is not JsonArray list || list.Count > max || !list.All(IsId)) throw Fail(reason, $"At most {max} ids");
        return [.. list.Select(Str).Distinct(StringComparer.Ordinal).Select(s => (JsonNode)JsonValue.Create(s)!)];
    }

    private static JsonArray Distinct(IEnumerable<string> ids) => [.. ids.Distinct(StringComparer.Ordinal).Select(s => (JsonNode)JsonValue.Create(s)!)];

    private static JsonObject CheckStep(JsonNode? value, Schema db, bool rowTrigger, Func<Guid, Schema?> target)
    {
        if (value is not JsonObject step) throw Fail("step.kind", "A step is an object");
        var when = IsNull(step["when"]) ? null : CheckGroup(step["when"], "step.when");
        if (when is not null && !rowTrigger) throw Fail("step.when", "A schedule has no row to put conditions on");
        switch (Str(step["kind"]))
        {
            case "set":
                if (!rowTrigger) throw Fail("step.kind", "A schedule has no row to set");
                return new JsonObject { ["kind"] = "set", ["values"] = CheckValues(step["values"], db, rowTrigger, true), ["when"] = when };
            case "addRow":
            {
                if (!IsId(step["databaseId"])) throw Fail("step.database", "A new row names its database");
                var template = IsNull(step["templateId"]) ? null : step["templateId"];
                if (template is not null && !IsId(template)) throw Fail("step.database", "Not a template id");
                var databaseId = Guid.Parse(Str(step["databaseId"])!);
                var into = Str(step["databaseId"]) == db.IdText ? db : target(databaseId);
                return new JsonObject
                {
                    ["kind"] = "addRow",
                    ["databaseId"] = Str(step["databaseId"]),
                    ["templateId"] = Copy(template),
                    ["values"] = CheckValues(step["values"] ?? new JsonObject(), into, rowTrigger, false),
                    ["when"] = when,
                };
            }
            case "notify":
            {
                var people = CheckIds(step["people"], "step.recipients");
                var groups = CheckIds(step["groups"], "step.recipients");
                var properties = step["personProperties"] ?? new JsonArray();
                if (properties is not JsonArray list || list.Count > MaxRecipients) throw Fail("step.recipients", "At most 100 person properties");
                foreach (var id in list)
                    if (Live(db, id) is not { } def || !PeopleTypes.Contains(def.Type))
                        throw Fail("step.recipients", "A notice goes to the people of a person property");
                if (!rowTrigger && list.Count > 0) throw Fail("step.recipients", "A schedule has no row whose people to tell");
                if (people.Count == 0 && groups.Count == 0 && list.Count == 0) throw Fail("step.recipients", "A notice goes to someone");
                if (Str(step["message"]) is not { } message || message.Length > MaxMessage) throw Fail("step.message", "A notice is at most 1,000 characters");
                return new JsonObject
                {
                    ["kind"] = "notify",
                    ["people"] = people,
                    ["groups"] = groups,
                    ["personProperties"] = Distinct(list.Select(x => Str(x)!)),
                    ["message"] = message,
                    ["when"] = when,
                };
            }
            case "webhook":
            {
                if (!IsId(step["webhookId"])) throw Fail("step.webhook", "A webhook step names its webhook");
                var properties = step["properties"] ?? new JsonArray();
                if (properties is not JsonArray list || list.Count > MaxStepValues * 2) throw Fail("step.webhook", "At most 100 properties");
                foreach (var id in list)
                    if (Live(db, id) is null) throw Fail("step.webhook", $"No property {Str(id)}");
                if (!rowTrigger && list.Count > 0) throw Fail("step.webhook", "A schedule has no row whose properties to send");
                return new JsonObject
                {
                    ["kind"] = "webhook",
                    ["webhookId"] = Str(step["webhookId"]),
                    ["properties"] = Distinct(list.Select(x => Str(x)!)),
                    ["when"] = when,
                };
            }
            default:
                throw Fail("step.kind", "Not a step");
        }
    }

    private static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>The length of a definition as JSON, as <c>JSON.stringify</c> counts it.</summary>
    public static int Length(JsonObject definition) => definition.ToJsonString(Compact).Length;

    /// <summary>
    /// The rule as it is kept (db/automations.ts <c>checkAutomation</c>), or an
    /// <see cref="AutomationInvalid"/> naming what is wrong. <paramref name="target"/> gives the
    /// schema of another database a step adds rows to.
    /// </summary>
    public static JsonObject Check(JsonNode? value, Schema db, string workspaceId, Func<Guid, Schema?> target)
    {
        if (value is not JsonObject rule) throw Fail("rule", "A rule is an object");
        if (!IsId(rule["id"])) throw Fail("rule", "A rule has an id");
        if (Str(rule["databaseId"]) != db.IdText) throw Fail("rule", "A rule stays with its database");
        if (Str(rule["name"]) is not { } name || name.Length > MaxName) throw Fail("name", "A name of at most 200 characters");
        if (!IsBool(rule["enabled"])) throw Fail("rule", "A rule is on or off");
        var trigger = CheckTrigger(rule["trigger"], db);
        var rowTrigger = Str(trigger["kind"]) != "schedule";
        var conditions = IsNull(rule["conditions"]) ? null : CheckGroup(rule["conditions"], "conditions");
        if (conditions is not null && !rowTrigger) throw Fail("conditions", "A schedule has no row to put conditions on");
        if (rule["steps"] is not JsonArray steps || steps.Count < 1 || steps.Count > MaxSteps) throw Fail("steps", "A rule has 1 to 20 steps");
        var checkedSteps = new JsonArray();
        foreach (var step in steps) checkedSteps.Add(CheckStep(step, db, rowTrigger, target));
        var output = new JsonObject
        {
            ["id"] = Str(rule["id"]),
            ["workspaceId"] = Str(rule["workspaceId"]) ?? workspaceId,
            ["databaseId"] = db.IdText,
            ["name"] = name,
            ["enabled"] = rule["enabled"]!.GetValue<bool>(),
            ["trigger"] = trigger,
            ["conditions"] = conditions,
            ["steps"] = checkedSteps,
            ["authorId"] = IsId(rule["authorId"]) ? Str(rule["authorId"]) : null,
            ["version"] = IsNumber(rule["version"]) ? Copy(rule["version"]) : 0,
            ["createdAt"] = Str(rule["createdAt"]) ?? "",
            ["updatedAt"] = Str(rule["updatedAt"]) ?? "",
        };
        if (Length(DefinitionOf(output)) > MaxChars) throw Fail("size", "The rule is too large");
        return output;
    }

    /// <summary>What is stored as a rule's definition: its name, trigger, conditions and steps.</summary>
    public static JsonObject DefinitionOf(JsonObject rule) => new()
    {
        ["name"] = Copy(rule["name"]),
        ["trigger"] = Copy(rule["trigger"]),
        ["conditions"] = Copy(rule["conditions"]),
        ["steps"] = Copy(rule["steps"]),
    };

    // Which change starts a rule ---------------------------------------------------------------------

    private static RowData ValuesRow(Schema db, IReadOnlyDictionary<string, object> values)
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

    /// <summary>
    /// Whether the change starts a rule of this trigger (db/automations.ts <c>changeStarts</c>):
    /// <c>rowAdded</c> by a row added; <c>propertyChanged</c> by a change of its property (or of the
    /// title or any stored property, with none named) whose old value passes <c>from</c> and new one
    /// <c>to</c>; <c>button</c> by its press. Dates and schedules are reached by time.
    /// </summary>
    public static bool Starts(JsonObject trigger, Schema db, RowChange change, QueryContext ctx)
    {
        switch (Str(trigger["kind"]))
        {
            case "rowAdded":
                return change.Kind == EventKindsText.Added;
            case "button":
                return change.Kind == EventKindsText.Button && change.PropertyId == Str(trigger["propertyId"]) && Live(db, trigger["propertyId"]) is not null;
            case "propertyChanged":
            {
                if (change.Kind != EventKindsText.Changed) return false;
                if (IsNull(trigger["propertyId"]))
                    return change.Changed.Any(id => db.Live(id) is { } d && Writable(d));
                if (Live(db, trigger["propertyId"]) is not { } def || !Writable(def) || !change.Changed.Contains(def.Id)) return false;
                bool Passes(JsonNode? side, IReadOnlyDictionary<string, object> values)
                {
                    if (side is not JsonObject s) return true;
                    var condition = new JsonObject { ["kind"] = "condition", ["propertyId"] = def.Id, ["operator"] = Str(s["operator"]) };
                    if (s.ContainsKey("value")) condition["value"] = Copy(s["value"]);
                    var only = values.TryGetValue(def.Id, out var v) ? new Dictionary<string, object>(StringComparer.Ordinal) { [def.Id] = v } : [];
                    return Query.Matches(db, ValuesRow(db, only), Raw.From(condition), ctx);
                }
                return Passes(trigger["from"], change.Before) && Passes(trigger["to"], change.After);
            }
            default:
                return false;
        }
    }

    /// <summary>The event kinds as a change names them (Data/AutomationEntities.cs <c>EventKinds</c>).</summary>
    private static class EventKindsText
    {
        public const string Added = Data.EventKinds.Added;
        public const string Changed = Data.EventKinds.Changed;
        public const string Button = Data.EventKinds.Button;
    }
}
