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
public sealed record RowChange(string Kind, IReadOnlyList<string> Changed, IReadOnlyDictionary<string, object> Before, IReadOnlyDictionary<string, object> After, string? PropertyId = null, string? FormId = null);

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
    /// <summary>Phase 17: a wait, and an approval's deadline, last at most 90 days.</summary>
    public const int MaxWaitMinutes = 129_600;
    public const int MaxBranches = 10;
    /// <summary>Phase 17: steps nest in branches and approvals at most three levels deep (the rule's own list is the first).</summary>
    public const int MaxNesting = 3;
    /// <summary>Phase 17: every step of a rule, inside branches and approvals too.</summary>
    public const int MaxAllSteps = 50;
    public const int MaxComment = 1000;
    /// <summary>The step kinds this server keeps (<c>/version</c>'s <c>stepKinds</c>): 4 before 0.17.0.</summary>
    public const int StepKinds = 7;

    /// <summary>Triggers a change of a row starts (the others are reached by time or a press); Phase 16: a form's answer too.</summary>
    public static bool IsEventTrigger(string kind) => kind is "rowAdded" or "propertyChanged" or "formAnswered";

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
            case "formAnswered":
                // Phase 16: which views are forms of the database is checked by AutomationService.
                if (!IsId(t["viewId"])) throw Fail("trigger.form", "A form trigger names its form");
                return new JsonObject { ["kind"] = "formAnswered", ["viewId"] = Str(t["viewId"]) };
            case "recurring":
            {
                // Phase 17: which rows are the database's templates is checked by AutomationService.
                if (!IsId(t["templateId"])) throw Fail("trigger.template", "A repeating row names its template");
                if (!Recurrence.IsDay(Str(t["start"]))) throw Fail("trigger", "A series starts on a day");
                if (Recurrence.Kept(t["rule"]) is not { } kept) throw Fail("trigger.recurrence", "Not a recurrence");
                var start = Str(t["start"])!;
                if (Recurrence.Between(Recurrence.Read(t["rule"])!, start, start, "9999-12-31", 1).Count == 0)
                    throw Fail("trigger.recurrence", "The recurrence never falls on a day");
                var mode = Str(t["mode"]);
                if (mode is not ("date" or "done")) throw Fail("trigger", "A series goes by its days or by the last row being done");
                var at = IsNull(t["at"]) ? null : t["at"];
                if (at is not null && !IsTimeOfDay(at)) throw Fail("trigger", "A time of day is HH:mm");
                var dateProperty = IsNull(t["dateProperty"]) ? null : t["dateProperty"];
                if (dateProperty is not null && Live(db, dateProperty) is not { Type: PropertyTypes.Date })
                    throw Fail("trigger.property", "A series writes its day into a date property");
                string? done = null;
                if (mode == "done")
                {
                    if (Live(db, t["doneProperty"]) is not { } def || def.Type is not (PropertyTypes.Checkbox or PropertyTypes.Status))
                        throw Fail("trigger.property", "Done is a checkbox checked or a status complete");
                    done = def.Id;
                }
                return new JsonObject
                {
                    ["kind"] = "recurring",
                    ["templateId"] = Str(t["templateId"]),
                    ["start"] = start,
                    ["rule"] = kept,
                    ["mode"] = mode,
                    ["at"] = Copy(at),
                    ["dateProperty"] = Copy(dateProperty),
                    ["doneProperty"] = done,
                };
            }
            default:
                throw Fail("trigger", "Not a trigger");
        }
    }

    // Steps ----------------------------------------------------------------------------------------------

    private static JsonNode? CheckStepValue(JsonNode? value, PropertyDef? def, bool rowTrigger, bool answered)
    {
        if (IsNull(value)) return null;
        if (value is JsonObject o && o.ContainsKey("dynamic"))
        {
            switch (Str(o["dynamic"]))
            {
                case "approver":
                    if (o.Count != 1) throw Fail("step.value", "Not a value a step writes");
                    if (!answered) throw Fail("step.value", "\"Who answered\" is known on an approval's answered paths only");
                    if (def is not null && def.Type != PropertyTypes.Person) throw Fail("step.value", "\"Who answered\" is written into a person");
                    return new JsonObject { ["dynamic"] = "approver" };
                case "comment":
                    if (o.Count != 1) throw Fail("step.value", "Not a value a step writes");
                    if (!answered) throw Fail("step.value", "A comment is known on an approval's answered paths only");
                    if (def is not null && def.Type != PropertyTypes.Text && def.Type != PropertyTypes.Title) throw Fail("step.value", "A comment is written into a text");
                    return new JsonObject { ["dynamic"] = "comment" };
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

    private static JsonObject CheckValues(JsonNode? value, Schema? db, bool rowTrigger, bool atLeastOne, bool answered)
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
            // A title is text, or (Phase 17) an approval's comment.
            var comment = raw is JsonObject d && Str(d["dynamic"]) == "comment";
            if (id == PropertyDef.TitleId && !IsNull(raw) && Str(raw) is null && !comment) throw Fail("step.value", "A title is text");
            output[id] = CheckStepValue(raw, def, rowTrigger, answered);
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

    /// <summary>What a step is checked within (db/automations.ts <c>StepCtx</c>).</summary>
    private sealed class StepCtx(Schema db, bool rowTrigger, string trigger, Func<Guid, Schema?> target)
    {
        public Schema Db { get; } = db;
        public bool RowTrigger { get; } = rowTrigger;
        /// <summary>Phase 17: the rule's trigger (a notice is a reminder only of a date reached).</summary>
        public string Trigger { get; } = trigger;
        public Func<Guid, Schema?> Target { get; } = target;
        /// <summary>On an approval's approved or rejected path.</summary>
        public bool Answered { get; init; }
        /// <summary>The list's level: the rule's own steps are 1.</summary>
        public int Level { get; init; } = 1;
        /// <summary>Steps met so far in the whole rule (shared by every level).</summary>
        public int[] Count { get; init; } = [0];

        public StepCtx Inner(bool answered) => new(Db, RowTrigger, Trigger, Target) { Answered = answered, Level = Level + 1, Count = Count };
    }

    private static (JsonArray People, JsonArray Groups, JsonArray Properties) CheckRecipients(JsonObject step, StepCtx ctx)
    {
        var people = CheckIds(step["people"], "step.recipients");
        var groups = CheckIds(step["groups"], "step.recipients");
        var properties = step["personProperties"] ?? new JsonArray();
        if (properties is not JsonArray list || list.Count > MaxRecipients) throw Fail("step.recipients", "At most 100 person properties");
        foreach (var id in list)
            if (Live(ctx.Db, id) is not { } def || !PeopleTypes.Contains(def.Type))
                throw Fail("step.recipients", "A notice goes to the people of a person property");
        if (!ctx.RowTrigger && list.Count > 0) throw Fail("step.recipients", "A schedule has no row whose people to tell");
        if (people.Count == 0 && groups.Count == 0 && list.Count == 0) throw Fail("step.recipients", "A notice goes to someone");
        return (people, groups, Distinct(list.Select(x => Str(x)!)));
    }

    /// <summary>A list a branch or an approval holds: 0 to 20 steps, one level deeper.</summary>
    private static JsonArray CheckList(JsonNode? value, StepCtx ctx, bool answered)
    {
        if (IsNull(value)) return [];
        if (value is not JsonArray list || list.Count > MaxSteps) throw Fail("steps", "A path holds at most 20 steps");
        var inner = ctx.Inner(answered);
        var output = new JsonArray();
        foreach (var step in list) output.Add(CheckStep(step, inner));
        return output;
    }

    private static JsonObject CheckWait(JsonNode? value, StepCtx ctx)
    {
        if (value is not JsonObject w) throw Fail("step.wait", "A wait says what it waits for");
        switch (Str(w["kind"]))
        {
            case "time":
                if (!Whole(w["minutes"], 1, MaxWaitMinutes)) throw Fail("step.wait", "A wait is whole minutes, at most 90 days");
                return new JsonObject { ["kind"] = "time", ["minutes"] = Copy(w["minutes"]) };
            case "date":
            {
                if (!ctx.RowTrigger) throw Fail("step.wait", "A schedule has no row whose date to wait for");
                if (Live(ctx.Db, w["propertyId"]) is not { } def || !DateTriggerTypes.Contains(def.Type))
                    throw Fail("step.wait", "A wait for a date names a date or created-time property");
                if (!Whole(w["offsetMinutes"], -MaxOffsetMinutes, MaxOffsetMinutes)) throw Fail("step.wait", "The offset is whole minutes, at most 30 days either way");
                var at = IsNull(w["at"]) ? null : w["at"];
                if (at is not null && !IsTimeOfDay(at)) throw Fail("step.wait", "A time of day is HH:mm");
                return new JsonObject { ["kind"] = "date", ["propertyId"] = def.Id, ["offsetMinutes"] = Copy(w["offsetMinutes"]), ["at"] = Copy(at) };
            }
            case "match":
                if (!ctx.RowTrigger) throw Fail("step.wait", "A schedule has no row to wait on");
                if (!Whole(w["minutes"], 1, MaxWaitMinutes)) throw Fail("step.wait", "A wait is whole minutes, at most 90 days");
                return new JsonObject { ["kind"] = "match", ["conditions"] = CheckGroup(w["conditions"], "step.wait"), ["minutes"] = Copy(w["minutes"]) };
            default:
                throw Fail("step.wait", "Not something a wait waits for");
        }
    }

    private static JsonObject CheckStep(JsonNode? value, StepCtx ctx)
    {
        var db = ctx.Db;
        var rowTrigger = ctx.RowTrigger;
        if (++ctx.Count[0] > MaxAllSteps) throw Fail("steps", "A rule has at most 50 steps in all");
        if (value is not JsonObject step) throw Fail("step.kind", "A step is an object");
        var when = IsNull(step["when"]) ? null : CheckGroup(step["when"], "step.when");
        if (when is not null && !rowTrigger) throw Fail("step.when", "A schedule has no row to put conditions on");
        switch (Str(step["kind"]))
        {
            case "set":
                if (!rowTrigger) throw Fail("step.kind", "A schedule has no row to set");
                return new JsonObject { ["kind"] = "set", ["values"] = CheckValues(step["values"], db, rowTrigger, true, ctx.Answered), ["when"] = when };
            case "addRow":
            {
                if (!IsId(step["databaseId"])) throw Fail("step.database", "A new row names its database");
                var template = IsNull(step["templateId"]) ? null : step["templateId"];
                if (template is not null && !IsId(template)) throw Fail("step.database", "Not a template id");
                var databaseId = Guid.Parse(Str(step["databaseId"])!);
                var into = Str(step["databaseId"]) == db.IdText ? db : ctx.Target(databaseId);
                return new JsonObject
                {
                    ["kind"] = "addRow",
                    ["databaseId"] = Str(step["databaseId"]),
                    ["templateId"] = Copy(template),
                    ["values"] = CheckValues(step["values"] ?? new JsonObject(), into, rowTrigger, false, ctx.Answered),
                    ["when"] = when,
                };
            }
            case "notify":
            {
                var (people, groups, properties) = CheckRecipients(step, ctx);
                if (Str(step["message"]) is not { } message || message.Length > MaxMessage) throw Fail("step.message", "A notice is at most 1,000 characters");
                // Phase 17: a reminder of a date reached, kept only when it is one.
                if (!IsNull(step["reminder"]) && !IsBool(step["reminder"])) throw Fail("step.reminder", "A reminder is true or false");
                var reminder = IsBool(step["reminder"]) && step["reminder"]!.GetValue<bool>();
                if (reminder && ctx.Trigger != "date") throw Fail("step.reminder", "A reminder is of a date reached");
                var notify = new JsonObject
                {
                    ["kind"] = "notify",
                    ["people"] = people,
                    ["groups"] = groups,
                    ["personProperties"] = properties,
                    ["message"] = message,
                };
                if (reminder) notify["reminder"] = true;
                notify["when"] = when;
                return notify;
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
            case "wait":
                return new JsonObject { ["kind"] = "wait", ["until"] = CheckWait(step["until"], ctx), ["when"] = when };
            case "branch":
            {
                if (!rowTrigger) throw Fail("step.kind", "A schedule has no row to branch on");
                if (ctx.Level >= MaxNesting) throw Fail("step.nesting", "Steps nest at most three levels");
                if (step["branches"] is not JsonArray paths || paths.Count < 1 || paths.Count > MaxBranches)
                    throw Fail("step.branch", "A branch has 1 to 10 paths besides \"otherwise\"");
                var branches = new JsonArray();
                foreach (var path in paths)
                {
                    if (path is not JsonObject p) throw Fail("step.branch", "A path is an object");
                    var condition = CheckGroup(p["when"], "step.branch");
                    branches.Add(new JsonObject { ["when"] = condition, ["steps"] = CheckList(p["steps"], ctx, ctx.Answered) });
                }
                return new JsonObject { ["kind"] = "branch", ["branches"] = branches, ["otherwise"] = CheckList(step["otherwise"], ctx, ctx.Answered), ["when"] = when };
            }
            case "approval":
            {
                if (ctx.Level >= MaxNesting) throw Fail("step.nesting", "Steps nest at most three levels");
                var (people, groups, properties) = CheckRecipients(step, ctx);
                if (Str(step["mode"]) is not ("any" or "all")) throw Fail("step.approval", "An approval goes on by any one answer or by all");
                if (Str(step["message"]) is not { } message || message.Length > MaxMessage) throw Fail("step.message", "A notice is at most 1,000 characters");
                if (!Whole(step["deadlineMinutes"], 1, MaxWaitMinutes)) throw Fail("step.approval", "A deadline is whole minutes, at most 90 days");
                return new JsonObject
                {
                    ["kind"] = "approval",
                    ["people"] = people,
                    ["groups"] = groups,
                    ["personProperties"] = properties,
                    ["mode"] = Str(step["mode"]),
                    ["message"] = message,
                    ["deadlineMinutes"] = Copy(step["deadlineMinutes"]),
                    ["approved"] = CheckList(step["approved"], ctx, true),
                    ["rejected"] = CheckList(step["rejected"], ctx, true),
                    ["noAnswer"] = CheckList(step["noAnswer"], ctx, false),
                    ["when"] = when,
                };
            }
            default:
                throw Fail("step.kind", "Not a step");
        }
    }

    /// <summary>Phase 17: the step lists a step holds (db/automations.ts <c>childLists</c>).</summary>
    public static IEnumerable<JsonArray> ChildLists(JsonObject step)
    {
        switch (Str(step["kind"]))
        {
            case "branch":
                foreach (var path in (step["branches"] as JsonArray ?? []).OfType<JsonObject>()) yield return path["steps"] as JsonArray ?? [];
                yield return step["otherwise"] as JsonArray ?? [];
                break;
            case "approval":
                yield return step["approved"] as JsonArray ?? [];
                yield return step["rejected"] as JsonArray ?? [];
                yield return step["noAnswer"] as JsonArray ?? [];
                break;
        }
    }

    /// <summary>Phase 17: every step, inside branches and approvals too, with its path (db/automations.ts <c>allSteps</c>).</summary>
    public static IEnumerable<(JsonObject Step, string Path)> AllSteps(JsonArray steps, string prefix = "")
    {
        for (var i = 0; i < steps.Count; i++)
        {
            if (steps[i] is not JsonObject step) continue;
            var path = prefix.Length == 0 ? i.ToString(System.Globalization.CultureInfo.InvariantCulture) : $"{prefix}/{i}";
            yield return (step, path);
            var l = 0;
            foreach (var list in ChildLists(step))
            {
                foreach (var inner in AllSteps(list, $"{path}/{l}")) yield return inner;
                l++;
            }
        }
    }

    /// <summary>Phase 17: whether a rule waits on its row (a date or conditions), so its rows' changes are written for it.</summary>
    public static bool WatchesRows(JsonArray steps) =>
        AllSteps(steps).Any(s => Str(s.Step["kind"]) == "wait" && s.Step["until"] is JsonObject u && Str(u["kind"]) is "date" or "match");

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
        var kind = Str(trigger["kind"])!;
        if (conditions is not null && kind == "recurring") throw Fail("conditions", "A repeating row is made whatever it holds");
        // Phase 17: a repeating row's rule makes its row itself, so it may have no steps of its own.
        var fewest = kind == "recurring" ? 0 : 1;
        if (rule["steps"] is not JsonArray steps || steps.Count < fewest || steps.Count > MaxSteps)
            throw Fail("steps", fewest == 1 ? "A rule has 1 to 20 steps" : "A rule has at most 20 steps");
        var checkedSteps = new JsonArray();
        var ctx = new StepCtx(db, rowTrigger, kind, target);
        foreach (var step in steps) checkedSteps.Add(CheckStep(step, ctx));
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
            case "formAnswered":
                return change.Kind == EventKindsText.Added && change.FormId is { Length: > 0 } form && form == Str(trigger["viewId"]);
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
