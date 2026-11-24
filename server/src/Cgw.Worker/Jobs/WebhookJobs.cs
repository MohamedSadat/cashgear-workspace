using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core;
using Cgw.Core.Automations;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Microsoft.EntityFrameworkCore;
using DbSchema = Cgw.Core.Databases.Schema;

namespace Cgw.Worker.Jobs;

/// <summary>
/// A webhook step's body (DECISIONS.md, 2026-11-24: the properties the rule names, never a
/// person's email): the rule, the database and the row by id and title, and each named property as
/// its name, type and value as people read it (an option by its name, a person by their name, a
/// related row by its title when the author can read it, a file by its name).
/// </summary>
public static class WebhookBodies
{
    private static readonly JsonSerializerOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static async Task<string> BodyAsync(CgwDb db, Member author, AutomationRun run, Automation rule, DbSchema schema, RowData? row, IReadOnlyList<string> properties,
        Guid deliveryId, CancellationToken ct)
    {
        var database = await db.Pages.AsNoTracking().Where(p => p.Id == rule.DatabaseId).Select(p => p.Title).FirstOrDefaultAsync(ct) ?? "";
        var values = new JsonObject();
        if (row is not null)
        {
            var defs = properties.Select(schema.Live).OfType<PropertyDef>().ToList();
            var people = defs.Any(d => d.Type is PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy)
                ? await People.RefsAsync(db, defs.SelectMany(d => Ids(d, row)), ct) : [];
            foreach (var def in defs)
                values[def.Id] = new JsonObject { ["name"] = def.Name, ["type"] = def.Type, ["value"] = await ValueAsync(db, author, def, row, people, ct) };
        }
        var body = new JsonObject
        {
            ["id"] = deliveryId.ToString(),
            ["type"] = "automation.run",
            ["workspaceId"] = run.WorkspaceId.ToString(),
            ["automation"] = new JsonObject { ["id"] = rule.Id.ToString(), ["name"] = rule.Name },
            ["database"] = new JsonObject { ["id"] = rule.DatabaseId.ToString(), ["title"] = database },
            ["run"] = new JsonObject { ["id"] = run.Id.ToString(), ["trigger"] = run.Trigger, ["startedAt"] = run.StartedAt.ToString("O", CultureInfo.InvariantCulture) },
            ["row"] = row is null ? null : new JsonObject { ["id"] = row.Id.ToString(), ["title"] = row.Title },
            ["properties"] = values,
        };
        return body.ToJsonString(Options);
    }

    private static IEnumerable<Guid> Ids(PropertyDef def, RowData row) => def.Type switch
    {
        PropertyTypes.Person => (row.Values.GetValueOrDefault(def.Id) as string[] ?? []).Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty),
        PropertyTypes.CreatedBy => Guid.TryParse(row.CreatedBy, out var c) ? [c] : [],
        PropertyTypes.LastEditedBy => Guid.TryParse(row.UpdatedBy, out var u) ? [u] : [],
        _ => [],
    };

    private static JsonNode? Cell(object? value) => value switch
    {
        null => null,
        string s => s,
        double d => d,
        bool b => b,
        string[] list => new JsonArray(list.Select(x => (JsonNode?)x).ToArray()),
        DateValue date => new JsonObject { ["start"] = date.Start, ["end"] = date.End },
        _ => JsonSerializer.SerializeToNode(value),
    };

    private static async Task<JsonNode?> ValueAsync(CgwDb db, Member author, PropertyDef def, RowData row, IReadOnlyDictionary<Guid, PersonRef> people, CancellationToken ct)
    {
        var stored = row.Values.GetValueOrDefault(def.Id);
        switch (def.Type)
        {
            case PropertyTypes.Title:
                return row.Title;
            case PropertyTypes.Select or PropertyTypes.Status:
                return stored is string option ? def.Option(option)?.Name : null;
            case PropertyTypes.MultiSelect:
                return new JsonArray((stored as string[] ?? []).Select(def.Option).OfType<OptionDef>().Select(o => (JsonNode?)o.Name).ToArray());
            case PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy:
                // Names only: a person's email never leaves.
                return new JsonArray(Ids(def, row).Select(id => (JsonNode?)new JsonObject { ["id"] = id.ToString(), ["name"] = People.Of(people, id).Name }).ToArray());
            case PropertyTypes.Files:
            {
                var ids = (stored as string[] ?? []).Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).ToList();
                var names = await db.Assets.AsNoTracking().Where(a => ids.Contains(a.Id)).ToDictionaryAsync(a => a.Id, a => a.FileName, ct);
                return new JsonArray(ids.Where(names.ContainsKey).Select(id => (JsonNode?)new JsonObject { ["id"] = id.ToString(), ["name"] = names[id] }).ToArray());
            }
            case PropertyTypes.Relation:
            {
                var ids = (stored as string[] ?? []).Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).ToList();
                // Rows the author can read, by their titles.
                var levels = ids.Count == 0 || def.RelationDatabaseId is not { } target ? Levels.None : await new Access(db).PageLevelAsync(author, target);
                if (levels == Levels.None) return new JsonArray();
                var titles = await db.Pages.AsNoTracking().Where(p => ids.Contains(p.Id) && p.DeletedAt == null).ToDictionaryAsync(p => p.Id, p => p.Title, ct);
                return new JsonArray(ids.Where(titles.ContainsKey).Select(id => (JsonNode?)new JsonObject { ["id"] = id.ToString(), ["title"] = titles[id] }).ToArray());
            }
            case PropertyTypes.Formula or PropertyTypes.Rollup:
                return row.Computed.GetValueOrDefault(def.Id) is { } computed && Raw.Field(computed, "error") is null ? Cell(computed) : null;
            case PropertyTypes.CreatedTime:
                return row.CreatedAt?.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            case PropertyTypes.LastEditedTime:
                return row.UpdatedAt?.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            case PropertyTypes.Button:
                return null;
            default:
                return Cell(stored);
        }
    }
}

/// <summary>
/// Phase 15: webhooks called (DECISIONS.md, 2026-11-24): each queued call POSTed by
/// <see cref="WebhookSender"/>, signed with its webhook's secret; a call that fails is tried again
/// after 1 minute, 5, 30 and 2 hours, then given up; its run's step says delivered or failed.
/// </summary>
public sealed class WebhookJob(WebhookSender sender, WebhookKeys keys, TimeProvider clock, ILogger<WebhookJob> logger) : IJob
{
    public string Name => "webhooks";
    public TimeSpan Interval => TimeSpan.FromSeconds(1);
    public bool OwnLoop => true;

    /// <summary>The waits after each failed attempt; the last attempt's failure gives up.</summary>
    public static readonly TimeSpan[] Backoff = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30), TimeSpan.FromHours(2)];

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        var due = await db.WebhookDeliveries.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.Status == DeliveryStatuses.Pending && d.NextAt <= now).OrderBy(d => d.NextAt).Take(20).ToListAsync(ct);
        foreach (var delivery in due)
        {
            var hook = await db.Webhooks.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(w => w.Id == delivery.WebhookId, ct);
            WebhookOutcome outcome;
            if (hook is null) outcome = new WebhookOutcome(false, null, "The webhook was removed");
            else if (keys.Unprotect(hook.WorkspaceId, hook.SecretCipher) is not { } secret) outcome = new WebhookOutcome(false, null, "The webhook's secret cannot be read");
            else outcome = await sender.SendAsync(hook.Url, secret, hook.Id, delivery.Id, delivery.Body, ct);
            var attempts = delivery.Attempts + 1;
            var last = hook is null || outcome.Delivered || attempts > Backoff.Length;
            var status = outcome.Delivered ? DeliveryStatuses.Delivered : last ? DeliveryStatuses.Failed : DeliveryStatuses.Pending;
            var next = last ? delivery.NextAt : clock.GetUtcNow() + Backoff[attempts - 1];
            await db.WebhookDeliveries.IgnoreQueryFilters([CgwDb.Tenant]).Where(d => d.Id == delivery.Id).ExecuteUpdateAsync(s => s
                .SetProperty(d => d.Attempts, attempts)
                .SetProperty(d => d.Status, status)
                .SetProperty(d => d.LastStatus, outcome.Status)
                .SetProperty(d => d.LastError, outcome.Error)
                .SetProperty(d => d.NextAt, next)
                .SetProperty(d => d.DeliveredAt, outcome.Delivered ? clock.GetUtcNow() : null), ct);
            if (status != DeliveryStatuses.Pending) await StepAsync(db, delivery, status, outcome, attempts, ct);
            if (!outcome.Delivered) logger.LogInformation("Webhook {Webhook} attempt {Attempt}: {Error}", delivery.WebhookId, attempts, outcome.Error);
        }
        return due.Count == 20;
    }

    /// <summary>The run's step reads as delivered or failed, with the answer's status.</summary>
    private static async Task StepAsync(CgwDb db, WebhookDelivery delivery, string status, WebhookOutcome outcome, int attempts, CancellationToken ct)
    {
        var run = await db.AutomationRuns.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(r => r.Id == delivery.RunId, ct);
        if (run is null || JsonNode.Parse(run.Steps) is not JsonArray steps) return;
        foreach (var step in steps.OfType<JsonObject>())
        {
            if ((int?)step["index"] != delivery.StepIndex) continue;
            step["status"] = status;
            step["code"] = status == DeliveryStatuses.Delivered ? null : outcome.Status is { } code ? $"http.{code}" : "webhook.unreached";
            step["count"] = attempts;
        }
        await db.AutomationRuns.IgnoreQueryFilters([CgwDb.Tenant]).Where(r => r.Id == run.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.Steps, steps.ToJsonString()), ct);
    }
}

/// <summary>Phase 15: runs, rules deleted and changes taken, kept 30 days (DECISIONS.md, 2026-11-24).</summary>
public sealed class AutomationRetentionJob(TimeProvider clock) : IJob
{
    public string Name => "automationRetention";
    public TimeSpan Interval => TimeSpan.FromHours(1);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var before = clock.GetUtcNow().AddDays(-AutomationRules.RunsKeptDays);
        // Phase 17: a run waiting is kept however long ago it started (a wait lasts up to 90 days); an ended one 30 days after it ended.
        var runs = await db.AutomationRuns.IgnoreQueryFilters([CgwDb.Tenant]).Where(r => r.Status != RunStatuses.Waiting && r.StartedAt < before && (r.EndedAt == null || r.EndedAt < before))
            .Take(5000).Select(r => r.Id).ToListAsync(ct);
        if (runs.Count > 0)
        {
            await db.WebhookDeliveries.IgnoreQueryFilters([CgwDb.Tenant]).Where(d => runs.Contains(d.RunId)).ExecuteDeleteAsync(ct);
            await db.AutomationApprovals.IgnoreQueryFilters([CgwDb.Tenant]).Where(a => runs.Contains(a.RunId)).ExecuteDeleteAsync(ct);
            await db.AutomationRuns.IgnoreQueryFilters([CgwDb.Tenant]).Where(r => runs.Contains(r.Id)).ExecuteDeleteAsync(ct);
        }
        await db.AutomationEvents.IgnoreQueryFilters([CgwDb.Tenant]).Where(e => e.DoneAt != null && e.DoneAt < before).ExecuteDeleteAsync(ct);
        var tenant = new[] { CgwDb.Tenant };
        var gone = await db.Automations.IgnoreQueryFilters(tenant).Where(a => a.DeletedAt != null && a.DeletedAt < before
            && !db.AutomationRuns.IgnoreQueryFilters(tenant).Any(r => r.AutomationId == a.Id)).Select(a => a.Id).Take(1000).ToListAsync(ct);
        if (gone.Count > 0) await db.Automations.IgnoreQueryFilters([CgwDb.Tenant]).Where(a => gone.Contains(a.Id)).ExecuteDeleteAsync(ct);
        return runs.Count == 5000;
    }
}
