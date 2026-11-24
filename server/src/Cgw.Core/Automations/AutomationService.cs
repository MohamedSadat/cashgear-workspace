using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Automations;

/// <summary>A rule as the server answers it (db/automations.ts <c>AutomationRecord</c>).</summary>
public sealed record AutomationDto(
    Guid Id,
    Guid WorkspaceId,
    Guid DatabaseId,
    string Name,
    bool Enabled,
    JsonElement Trigger,
    JsonElement Conditions,
    JsonElement Steps,
    Guid? AuthorId,
    long Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt)
{
    public static AutomationDto From(Automation a)
    {
        using var doc = JsonDocument.Parse(string.IsNullOrEmpty(a.Definition) ? "{}" : a.Definition);
        var root = doc.RootElement;
        JsonElement Part(string name, string fallback) =>
            root.TryGetProperty(name, out var value) ? value.Clone() : JsonDocument.Parse(fallback).RootElement.Clone();
        return new(a.Id, a.WorkspaceId, a.DatabaseId, a.Name, a.Enabled, Part("trigger", "{}"), Part("conditions", "null"), Part("steps", "[]"),
            a.AuthorId == Guid.Empty ? null : a.AuthorId, a.Version, a.CreatedAt, a.UpdatedAt);
    }
}

/// <summary>
/// A database's rules as records (Phase 15, M15.1; DATA_MODEL.md, Automations): the operations
/// <c>automation.upsert</c> and <c>automation.delete</c>, checked as the client checks them
/// (<see cref="AutomationRules.Check"/>) and then for what only the server knows: full access to the
/// database, at most 50 a database, webhooks by owners and admins only, a new row's database and
/// template, the people and groups a notice names. Each write is an <c>automation</c> change for the
/// database's readers. Call inside the operation's transaction, under the workspace's lock.
/// </summary>
public sealed class AutomationService(CgwDb db, Access access, ChangeLog changes, DatabaseOps databases, TimeProvider clock)
{
    public const string ChangeType = "automation";

    private DateTimeOffset Now => clock.GetUtcNow();

    private static string? Text(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    /// <summary>A database page the member has full access to, not in the trash, with its record.</summary>
    private async Task<(Page Page, WorkspaceDatabase Record)> ManagedAsync(Member member, Guid databaseId, CancellationToken ct)
    {
        var page = await db.Pages.FirstOrDefaultAsync(p => p.Id == databaseId && p.DeletedAt == null, ct) ?? throw new OpFailure(Codes.NotFound, "Database not found");
        var level = await access.PageLevelAsync(member, page.Id);
        if (level == Levels.None) throw new OpFailure(Codes.NotFound, "Database not found");
        if (page.Kind != PageKinds.Database) throw new OpFailure("invalid", "Not a database");
        if (level != Levels.Full) throw new OpFailure(Codes.AccessDenied, "A database's automations are changed with full access to it");
        if (page.TrashedAt is not null) throw new OpFailure("page.trashed", "The database is in the trash");
        var record = await databases.DatabaseAsync(page.Id, ct) ?? throw new OpFailure(Codes.NotFound, "Database not found");
        return (page, record);
    }

    private static Schema SchemaOf(WorkspaceDatabase record) => Schema.Parse(record.PageId, record.Version, record.Properties);

    public async Task<AutomationDto> UpsertAsync(Member member, Guid id, JsonElement payload, CancellationToken ct)
    {
        if (!Guid.TryParse(Text(payload, "id"), out var given) || given != id) throw new OpFailure("invalid", "Id mismatch");
        if (!Guid.TryParse(Text(payload, "workspaceId"), out var ws) || ws != member.WorkspaceId) throw new OpFailure("invalid", "Id mismatch");
        if (!Guid.TryParse(Text(payload, "databaseId"), out var databaseId)) throw new OpFailure("invalid", "A rule names its database");
        var (_, record) = await ManagedAsync(member, databaseId, ct);
        var rule = await db.Automations.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (rule is not null && rule.DatabaseId != databaseId) throw new OpFailure("invalid", "A rule stays with its database");
        if (rule?.DeletedAt is not null) throw new OpFailure(Codes.NotFound, "The rule was deleted");
        if (rule is null && await db.Automations.IgnoreQueryFilters([CgwDb.Tenant]).AnyAsync(a => a.Id == id, ct)) throw new OpFailure("invalid", "Rule exists");

        // The databases its steps add rows to, read first (the check reads their properties).
        var node = JsonNode.Parse(payload.GetRawText());
        var targets = new Dictionary<Guid, Schema?>();
        foreach (var (step, _) in AutomationRules.AllSteps(node?["steps"] as JsonArray ?? []))
            if ((string?)(step["kind"] as JsonValue) == "addRow" && step["databaseId"] is JsonValue v && v.TryGetValue<string>(out var text)
                && Guid.TryParse(text, out var target) && !targets.ContainsKey(target))
                targets[target] = await databases.DatabaseAsync(target, ct) is { } other ? SchemaOf(other) : null;
        var schema = SchemaOf(record);
        var kept = AutomationRules.Check(node, schema, member.WorkspaceId.ToString(), t => targets.GetValueOrDefault(t));
        await CheckServerRulesAsync(member, databaseId, kept, ct);

        var definition = AutomationRules.DefinitionOf(kept);
        var trigger = (JsonObject)kept["trigger"]!;
        var kind = (string)trigger["kind"]!;
        var enabled = kept["enabled"]!.GetValue<bool>();
        var now = Now;
        var workspace = await db.Workspaces.FirstAsync(w => w.Id == member.WorkspaceId, ct);
        // A workspace made before 0.15.0 takes the zone of the first person to save a rule there.
        if (workspace.TimeZone is null && AutomationTimes.IsZone(Text(payload, "timeZone"))) workspace.TimeZone = Text(payload, "timeZone");
        if (rule is null)
        {
            if (await db.Automations.CountAsync(a => a.DatabaseId == databaseId && a.DeletedAt == null, ct) >= AutomationRules.MaxAutomations)
                throw new OpFailure(Codes.AutomationLimit, $"A database holds at most {AutomationRules.MaxAutomations} automations");
            rule = new Automation { Id = id, WorkspaceId = member.WorkspaceId, DatabaseId = databaseId, Version = 0, CreatedAt = now };
            db.Automations.Add(rule);
        }
        var before = rule.Definition;
        var wasOn = rule.Enabled;
        rule.Definition = definition.ToJsonString();
        rule.Name = (string)kept["name"]!;
        rule.TriggerKind = kind;
        rule.Enabled = enabled;
        rule.AuthorId = member.UserId;
        rule.Version++;
        rule.UpdatedAt = now;
        rule.WatchesRows = AutomationRules.WatchesRows((JsonArray)kept["steps"]!);
        // Phase 17: switched off, its waiting runs stop; changed, they finish by what they started with.
        if (wasOn && !enabled) await StopWaitingAsync(db, rule.Id, "rule.off", now, ct);
        var triggerChanged = !JsonNode.DeepEquals(JsonNode.Parse(before == "" ? "{}" : before)?["trigger"], trigger);
        // A date trigger runs for moments from when it was switched on or changed, never before.
        rule.ScannedUntil = kind == "date" ? (triggerChanged || !wasOn || rule.ScannedUntil is null ? now : rule.ScannedUntil) : null;
        rule.NextAt = kind == "schedule" ? AutomationTimes.Next(trigger, AutomationTimes.Zone(workspace.TimeZone), now) : null;
        await RecountAsync(workspace, [databaseId], ct);
        changes.Add(ChangeType, rule.Id, "upsert", rule.Version, member.UserId);
        return AutomationDto.From(rule);
    }

    /// <summary>What the client cannot check: who may call webhooks, which webhooks, databases, templates, people and groups there are.</summary>
    private async Task CheckServerRulesAsync(Member member, Guid databaseId, JsonObject rule, CancellationToken ct)
    {
        // Phase 16: "a form is answered" names a form view of this database.
        if (rule["trigger"] is JsonObject trigger && (string?)trigger["kind"] == "formAnswered")
        {
            var form = Guid.Parse((string)trigger["viewId"]!);
            if (!await db.DatabaseViews.AnyAsync(v => v.Id == form && v.DatabaseId == databaseId && v.Type == DatabaseOps.FormView, ct))
                throw new AutomationInvalid("trigger.form", "The form is not a form view of this database");
        }
        foreach (var (step, _) in AutomationRules.AllSteps((JsonArray)rule["steps"]!))
        {
            switch ((string?)step["kind"])
            {
                case "webhook":
                {
                    if (!member.IsAdmin) throw new OpFailure(Codes.AccessDenied, "Only owners and admins save a rule that calls a webhook");
                    var hook = Guid.Parse((string)step["webhookId"]!);
                    if (!await db.Webhooks.AnyAsync(w => w.Id == hook, ct)) throw new OpFailure(Codes.NotFound, "No such webhook");
                    break;
                }
                case "addRow":
                {
                    var target = Guid.Parse((string)step["databaseId"]!);
                    var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == target && p.DeletedAt == null, ct);
                    if (page is null || page.Kind != PageKinds.Database || await access.PageLevelAsync(member, target) == Levels.None)
                        throw new OpFailure(Codes.NotFound, "The new row's database is not there");
                    if (!Levels.AtLeast(await access.PageLevelAsync(member, target), Levels.Edit))
                        throw new OpFailure(Codes.AccessDenied, "Adding rows there needs edit on that database");
                    if (step["templateId"] is JsonValue t && t.TryGetValue<string>(out var text))
                    {
                        var template = Guid.Parse(text);
                        if (!await db.Pages.AnyAsync(p => p.Id == template && p.ParentPageId == target && p.Kind == PageKinds.Row && p.IsTemplate && p.DeletedAt == null, ct))
                            throw new OpFailure(Codes.NotFound, "No such template in that database");
                    }
                    break;
                }
                case "notify":
                case "approval":
                {
                    var people = ((JsonArray)step["people"]!).Select(x => Guid.Parse((string)x!)).ToList();
                    if (people.Count > 0 && await db.WorkspaceMembers.CountAsync(m => people.Contains(m.UserId), ct) != people.Count)
                        throw new OpFailure(Codes.NotFound, "A person the notice names is not in the workspace");
                    var groups = ((JsonArray)step["groups"]!).Select(x => Guid.Parse((string)x!)).ToList();
                    if (groups.Count > 0 && await db.WorkspaceGroups.CountAsync(g => groups.Contains(g.Id), ct) != groups.Count)
                        throw new OpFailure(Codes.NotFound, "A group the notice names is not in the workspace");
                    break;
                }
            }
        }
    }

    public async Task DeleteAsync(Member member, Guid id, CancellationToken ct)
    {
        var rule = await db.Automations.FirstOrDefaultAsync(a => a.Id == id && a.DeletedAt == null, ct) ?? throw new OpFailure(Codes.NotFound, "Rule not found");
        await ManagedAsync(member, rule.DatabaseId, ct);
        rule.DeletedAt = Now;
        rule.Enabled = false;
        rule.Version++;
        rule.UpdatedAt = Now;
        await StopWaitingAsync(db, rule.Id, "rule.deleted", Now, ct);
        var workspace = await db.Workspaces.FirstAsync(w => w.Id == member.WorkspaceId, ct);
        await RecountAsync(workspace, [rule.DatabaseId], ct);
        changes.Add(ChangeType, rule.Id, "delete", rule.Version, member.UserId);
    }

    /// <summary>
    /// Phase 17: a rule's waiting runs (every rule's, with none given) stopped, recorded with the
    /// reason, and their approvals still open closed. Inside the caller's transaction.
    /// </summary>
    public static async Task StopWaitingAsync(CgwDb db, Guid? automationId, string reason, DateTimeOffset now, CancellationToken ct)
    {
        var waiting = db.AutomationRuns.Where(r => r.Status == RunStatuses.Waiting && (automationId == null || r.AutomationId == automationId));
        var ids = await waiting.Select(r => r.Id).ToListAsync(ct);
        if (ids.Count == 0) return;
        await db.AutomationRuns.Where(r => ids.Contains(r.Id)).ExecuteUpdateAsync(s => s
            .SetProperty(r => r.Status, RunStatuses.Stopped)
            .SetProperty(r => r.Reason, reason)
            .SetProperty(r => r.WaitUntil, (DateTimeOffset?)null)
            .SetProperty(r => r.TakenAt, (DateTimeOffset?)null)
            .SetProperty(r => r.EndedAt, now), ct);
        await db.AutomationApprovals.Where(a => ids.Contains(a.RunId) && a.Outcome == null)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Outcome, ApprovalOutcomes.Stopped), ct);
    }

    /// <summary>
    /// Each database's <see cref="WorkspaceDatabase.EventRules"/>: its rules switched on that a
    /// change of a row starts (Phase 17: or whose steps wait on a row), or none while the workspace's rules are off. Tracked records change
    /// in place (the operation saves them); every database of the workspace with none given.
    /// </summary>
    public async Task RecountAsync(Workspace workspace, IReadOnlyCollection<Guid>? databaseIds, CancellationToken ct)
    {
        // Rules saved in this transaction are tracked and not yet written: count from the tracker too.
        await db.SaveChangesAsync(ct);
        var counts = await db.Automations.AsNoTracking()
            .Where(a => a.DeletedAt == null && a.Enabled && (a.TriggerKind == "rowAdded" || a.TriggerKind == "propertyChanged" || a.TriggerKind == "formAnswered" || a.WatchesRows))
            .Where(a => databaseIds == null || databaseIds.Contains(a.DatabaseId))
            .GroupBy(a => a.DatabaseId).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count, ct);
        var ids = databaseIds ?? (IReadOnlyCollection<Guid>)await db.Databases.Where(d => d.EventRules > 0).Select(d => d.PageId)
            .Concat(db.Automations.Where(a => a.DeletedAt == null).Select(a => a.DatabaseId)).Distinct().ToListAsync(ct);
        foreach (var id in ids)
        {
            if (await databases.DatabaseAsync(id, ct) is not { } record) continue;
            record.EventRules = workspace.AutomationsOff ? 0 : counts.GetValueOrDefault(id);
        }
    }
}
