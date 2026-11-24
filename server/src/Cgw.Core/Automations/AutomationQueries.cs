using System.Security.Cryptography;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sync;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Core.Automations;

public sealed record RunSummaryDto(string Status, string? Reason, DateTimeOffset StartedAt);

public sealed record AutomationItemDto(AutomationDto Rule, PersonRef? Author, RunSummaryDto? LastRun);

/// <summary>A database's rules for its rule editor, and what the caller may do with them.</summary>
public sealed record DatabaseAutomationsDto(
    IReadOnlyList<AutomationItemDto> Automations,
    /// <summary>Full access to the database: the caller makes, changes and deletes its rules.</summary>
    bool CanManage,
    /// <summary>An owner or admin: the caller's rules may call the workspace's webhooks (listed here).</summary>
    bool CanCallWebhooks,
    IReadOnlyList<WebhookRefDto> Webhooks,
    /// <summary>The workspace's time zone (null: UTC until one is set or a rule saved).</summary>
    string? TimeZone,
    /// <summary>Every rule of the workspace is switched off (Settings).</summary>
    bool AllOff);

public sealed record WebhookRefDto(Guid Id, string Name);

public sealed record WebhookDto(Guid Id, string Name, string Url, PersonRef CreatedBy, DateTimeOffset CreatedAt);

/// <summary>A webhook made, with its signing secret: shown this once, never again.</summary>
public sealed record WebhookMadeDto(WebhookDto Webhook, string Secret);

public sealed record WebhookRequest(string Name, string Url);

public sealed record RunDto(
    Guid Id,
    Guid AutomationId,
    string AutomationName,
    Guid DatabaseId,
    Guid? RowId,
    /// <summary>The row's title, when the caller can read it (a run's row may have gone since).</summary>
    string? RowTitle,
    string Trigger,
    int Depth,
    PersonRef? Actor,
    PersonRef Author,
    string Status,
    string? Reason,
    JsonElement Steps,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt);

public sealed record RunsDto(IReadOnlyList<RunDto> Runs, string? Next);

/// <summary>Settings → Automations (owners and admins): every rule of the workspace, the switches, the zone, the webhooks.</summary>
public sealed record WorkspaceAutomationsDto(
    bool AllOff,
    string? TimeZone,
    IReadOnlyList<WorkspaceAutomationDto> Automations,
    IReadOnlyList<WebhookDto> Webhooks);

public sealed record WorkspaceAutomationDto(AutomationDto Rule, string DatabaseTitle, PersonRef? Author, RunSummaryDto? LastRun, int RunsToday);

public sealed record AutomationSettingsRequest(bool? AllOff, string? TimeZone);

public sealed record AutomationSwitchRequest(bool Enabled);

public sealed record PressRequest(string PropertyId, Guid PressId);

public sealed record PressDto(long EventId, IReadOnlyList<string> Automations);

/// <summary>The webhooks' signing secrets under Data Protection, by workspace.</summary>
public sealed class WebhookKeys(IDataProtectionProvider protection)
{
    public const string Purpose = "Cgw.Automations.Webhook.v1";

    private IDataProtector For(Guid workspaceId) => protection.CreateProtector(Purpose, workspaceId.ToString("N"));

    public string Protect(Guid workspaceId, string secret) => For(workspaceId).Protect(secret);

    public string? Unprotect(Guid workspaceId, string cipher)
    {
        try
        {
            return For(workspaceId).Unprotect(cipher);
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    /// <summary>A new secret: 32 random bytes as lower-case hex, prefixed so it reads as one.</summary>
    public static string NewSecret() => "cgwh_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
}

/// <summary>Where webhooks may go: https on 443 to a public address, or (tests only) http to loopback.</summary>
public sealed class WebhookOptions(bool allowLoopback)
{
    public bool AllowLoopback { get; } = allowLoopback;

    public static WebhookOptions From(IConfiguration configuration, IHostEnvironment environment) =>
        new(configuration["Automations:AllowLoopback"] == "true" && !environment.IsProduction());

    /// <summary>
    /// An address a webhook may be made with: https, port 443, no user or password, a name or an
    /// address that is public; in tests also http to a loopback address. The name's addresses are
    /// checked again at every connect (WebhookSender).
    /// </summary>
    public bool Allowed(string url)
    {
        if (url.Length > 2048 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo) || uri.Host.Length == 0) return false;
        if (AllowLoopback && uri.IsLoopback && uri.Scheme is "http" or "https") return true;
        if (uri.Scheme != "https" || uri.Port != 443 || uri.Fragment.Length > 0) return false;
        if (System.Net.IPAddress.TryParse(uri.Host.Trim('[', ']'), out var address)) return Previews.SafeFetcher.Public(address);
        return uri.Host.Contains('.') && !uri.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase) && !uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>
/// The rules' routes (Phase 15, M15.1 and M15.3): a database's rules and their runs for the rule
/// editor, a row's runs, Settings → Automations (owners and admins: every rule, the switches, the
/// time zone, the webhooks), and a button's press (an event for the worker, once per press).
/// </summary>
public sealed class AutomationQueries(CgwDb db, Access access, ChangeLog changes, AutomationService automations, WebhookKeys keys, WebhookOptions webhooks,
    Audit audit, TimeProvider clock)
{
    public const int DefaultRuns = 50;
    public const int MaxRuns = 200;
    public const int MaxWebhooks = 50;

    private async Task<Dictionary<Guid, RunSummaryDto>> LastRunsAsync(IReadOnlyCollection<Guid> ids, CancellationToken ct)
    {
        if (ids.Count == 0) return [];
        var last = await db.AutomationRuns.AsNoTracking().Where(r => ids.Contains(r.AutomationId))
            .GroupBy(r => r.AutomationId).Select(g => g.OrderByDescending(r => r.StartedAt).First()).ToListAsync(ct);
        return last.ToDictionary(r => r.AutomationId, r => new RunSummaryDto(r.Status, r.Reason, r.StartedAt));
    }

    public async Task<Result<DatabaseAutomationsDto>> ForDatabaseAsync(Member member, Guid databaseId, string level, CancellationToken ct)
    {
        var rules = await db.Automations.AsNoTracking().Where(a => a.DatabaseId == databaseId && a.DeletedAt == null).OrderBy(a => a.CreatedAt).ToListAsync(ct);
        var people = await People.RefsAsync(db, rules.Select(r => r.AuthorId), ct);
        var lastRuns = await LastRunsAsync(rules.Select(r => r.Id).ToList(), ct);
        var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId, ct);
        var hooks = member.IsAdmin
            ? await db.Webhooks.AsNoTracking().OrderBy(w => w.Name).Select(w => new WebhookRefDto(w.Id, w.Name)).ToListAsync(ct)
            : [];
        return new DatabaseAutomationsDto(
            [.. rules.Select(r => new AutomationItemDto(AutomationDto.From(r), people.TryGetValue(r.AuthorId, out var p) ? p : null, lastRuns.GetValueOrDefault(r.Id)))],
            level == Levels.Full, member.IsAdmin, hooks, workspace.TimeZone, workspace.AutomationsOff);
    }

    private static string? Cursor(DateTimeOffset at, Guid id) => $"{at.UtcTicks}:{id:N}";

    private static (long Ticks, Guid Id)? ParseCursor(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var parts = text.Split(':');
        return parts.Length == 2 && long.TryParse(parts[0], out var ticks) && Guid.TryParse(parts[1], out var id) ? (ticks, id) : null;
    }

    private async Task<RunsDto> RunsAsync(Member member, IQueryable<AutomationRun> query, string? before, int? limit, CancellationToken ct)
    {
        var take = Math.Clamp(limit ?? DefaultRuns, 1, MaxRuns);
        if (ParseCursor(before) is { } cursor)
        {
            var at = new DateTimeOffset(cursor.Ticks, TimeSpan.Zero);
            query = query.Where(r => r.StartedAt < at || (r.StartedAt == at && r.Id.CompareTo(cursor.Id) < 0));
        }
        var runs = await query.OrderByDescending(r => r.StartedAt).ThenByDescending(r => r.Id).Take(take + 1).AsNoTracking().ToListAsync(ct);
        var more = runs.Count > take;
        if (more) runs.RemoveAt(runs.Count - 1);
        var ruleIds = runs.Select(r => r.AutomationId).Distinct().ToList();
        var names = await db.Automations.AsNoTracking().Where(a => ruleIds.Contains(a.Id)).ToDictionaryAsync(a => a.Id, a => a.Name, ct);
        var rowIds = runs.Where(r => r.RowId is not null).Select(r => r.RowId!.Value).Distinct().ToList();
        var titles = new Dictionary<Guid, string>();
        if (rowIds.Count > 0)
        {
            var levels = await access.LevelsAsync(member, rowIds, ct);
            foreach (var page in await db.Pages.AsNoTracking().Where(p => rowIds.Contains(p.Id) && p.DeletedAt == null).Select(p => new { p.Id, p.Title }).ToListAsync(ct))
                if (levels.GetValueOrDefault(page.Id, Levels.None) != Levels.None) titles[page.Id] = page.Title;
        }
        var people = await People.RefsAsync(db, runs.Select(r => r.AuthorId).Concat(runs.Where(r => r.ActorId is not null).Select(r => r.ActorId!.Value)), ct);
        var list = runs.Select(r => new RunDto(r.Id, r.AutomationId, names.GetValueOrDefault(r.AutomationId, ""), r.DatabaseId, r.RowId,
            r.RowId is { } row ? titles.GetValueOrDefault(row) : null, r.Trigger, r.Depth, r.ActorId is { } actor ? People.Of(people, actor) : null,
            People.Of(people, r.AuthorId), r.Status, r.Reason, Json.Element(r.Steps, "[]"), r.StartedAt, r.EndedAt)).ToList();
        return new RunsDto(list, more && runs.Count > 0 ? Cursor(runs[^1].StartedAt, runs[^1].Id) : null);
    }

    /// <summary>A rule's runs, newest first: for those with full access to its database, and owners and admins.</summary>
    public async Task<Result<RunsDto>> RuleRunsAsync(Member member, Guid databaseId, string level, Guid automationId, string? before, int? limit, CancellationToken ct)
    {
        if (level != Levels.Full && !member.IsAdmin) return Failure.Denied("A rule's runs are read with full access to its database");
        if (!await db.Automations.AnyAsync(a => a.Id == automationId && a.DatabaseId == databaseId, ct)) return Failure.NotFound("No such automation");
        return await RunsAsync(member, db.AutomationRuns.Where(r => r.AutomationId == automationId), before, limit, ct);
    }

    /// <summary>A row's runs, newest first: for whoever can read the row (its database's level).</summary>
    public async Task<Result<RunsDto>> RowRunsAsync(Member member, Guid databaseId, Guid rowId, string? before, int? limit, CancellationToken ct)
    {
        if (!await db.Pages.AnyAsync(p => p.Id == rowId && p.ParentPageId == databaseId && p.Kind == PageKinds.Row && p.DeletedAt == null, ct))
            return Failure.NotFound("No such row");
        return await RunsAsync(member, db.AutomationRuns.Where(r => r.RowId == rowId), before, limit, ct);
    }

    // Settings -------------------------------------------------------------------------------------------

    public async Task<Result<WorkspaceAutomationsDto>> ForWorkspaceAsync(Member member, CancellationToken ct)
    {
        if (!member.IsAdmin) return Failure.Denied("Settings → Automations is for owners and admins");
        var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId, ct);
        var rules = await db.Automations.AsNoTracking().Where(a => a.DeletedAt == null).OrderBy(a => a.CreatedAt).ToListAsync(ct);
        var ids = rules.Select(r => r.Id).ToList();
        var databaseIds = rules.Select(r => r.DatabaseId).Distinct().ToList();
        var titles = await db.Pages.AsNoTracking().Where(p => databaseIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Title, ct);
        var hooks = await db.Webhooks.AsNoTracking().OrderBy(w => w.Name).ToListAsync(ct);
        var people = await People.RefsAsync(db, rules.Select(r => r.AuthorId).Concat(hooks.Select(h => h.CreatedBy)), ct);
        var lastRuns = await LastRunsAsync(ids, ct);
        var since = clock.GetUtcNow().AddDays(-1);
        var today = ids.Count == 0 ? [] : await db.AutomationRuns.AsNoTracking().Where(r => ids.Contains(r.AutomationId) && r.StartedAt >= since)
            .GroupBy(r => r.AutomationId).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count, ct);
        return new WorkspaceAutomationsDto(workspace.AutomationsOff, workspace.TimeZone,
            [.. rules.Select(r => new WorkspaceAutomationDto(AutomationDto.From(r), titles.GetValueOrDefault(r.DatabaseId, ""),
                people.TryGetValue(r.AuthorId, out var p) ? p : null, lastRuns.GetValueOrDefault(r.Id), today.GetValueOrDefault(r.Id)))],
            [.. hooks.Select(h => Dto(h, people))]);
    }

    private static WebhookDto Dto(Webhook h, IReadOnlyDictionary<Guid, PersonRef> people) => new(h.Id, h.Name, h.Url, People.Of(people, h.CreatedBy), h.CreatedAt);

    /// <summary>Runs <paramref name="work"/> in a transaction under the workspace's lock, then flushes the feed.</summary>
    private async Task<T> LockedAsync<T>(Guid workspaceId, Func<Task<T>> work, CancellationToken ct)
    {
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(workspaceId, ct);
            var result = await work();
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
            return result;
        });
    }

    /// <summary>The switch for every rule and the time zone (owners and admins).</summary>
    public async Task<Result<WorkspaceAutomationsDto>> UpdateSettingsAsync(Member member, Actor actor, AutomationSettingsRequest request, CancellationToken ct)
    {
        if (!member.IsAdmin) return Failure.Denied("Settings → Automations is for owners and admins");
        if (request.TimeZone is not null && !AutomationTimes.IsZone(request.TimeZone)) return new Failure(Codes.TimeZoneUnknown, 400, "Not a time zone this server knows");
        await LockedAsync(member.WorkspaceId, async () =>
        {
            var workspace = await db.Workspaces.FirstAsync(w => w.Id == member.WorkspaceId, ct);
            if (request.AllOff is { } off && off != workspace.AutomationsOff)
            {
                workspace.AutomationsOff = off;
                audit.Add(actor, "automations.switch", member.WorkspaceId, "workspace", member.WorkspaceId, new { off });
                await automations.RecountAsync(workspace, null, ct);
                // Every rule's editor and Settings shows the switch: each rule's change tells them.
                foreach (var rule in await db.Automations.Where(a => a.DeletedAt == null).ToListAsync(ct))
                    changes.Add(AutomationService.ChangeType, rule.Id, "upsert", rule.Version, member.UserId);
            }
            if (request.TimeZone is { } zone && zone != workspace.TimeZone)
            {
                workspace.TimeZone = zone;
                audit.Add(actor, "automations.timeZone", member.WorkspaceId, "workspace", member.WorkspaceId, new { zone });
                // Schedules run next by the new zone.
                var tz = AutomationTimes.Zone(zone);
                var now = clock.GetUtcNow();
                foreach (var rule in await db.Automations.Where(a => a.DeletedAt == null && a.TriggerKind == "schedule").ToListAsync(ct))
                    if (System.Text.Json.Nodes.JsonNode.Parse(rule.Definition)?["trigger"] is System.Text.Json.Nodes.JsonObject trigger)
                        rule.NextAt = AutomationTimes.Next(trigger, tz, now);
            }
            return true;
        }, ct);
        return await ForWorkspaceAsync(member, ct);
    }

    /// <summary>
    /// A rule switched on or off without saving it (its author stays): by whoever has full access to
    /// its database, and owners and admins from Settings.
    /// </summary>
    public async Task<Result<AutomationDto>> SwitchAsync(Member member, Guid automationId, bool enabled, CancellationToken ct)
    {
        var rule = await db.Automations.AsNoTracking().FirstOrDefaultAsync(a => a.Id == automationId && a.DeletedAt == null, ct);
        if (rule is null || (!member.IsAdmin && await access.PageLevelAsync(member, rule.DatabaseId) == Levels.None)) return Failure.NotFound("No such automation");
        if (!member.IsAdmin && await access.PageLevelAsync(member, rule.DatabaseId) != Levels.Full) return Failure.Denied("A rule is switched with full access to its database");
        return await LockedAsync(member.WorkspaceId, async () =>
        {
            var tracked = await db.Automations.FirstAsync(a => a.Id == automationId, ct);
            if (tracked.Enabled == enabled) return AutomationDto.From(tracked);
            tracked.Enabled = enabled;
            tracked.Version++;
            tracked.UpdatedAt = clock.GetUtcNow();
            if (enabled && tracked.TriggerKind == "date") tracked.ScannedUntil = clock.GetUtcNow();
            if (enabled && tracked.TriggerKind == "schedule" && System.Text.Json.Nodes.JsonNode.Parse(tracked.Definition)?["trigger"] is System.Text.Json.Nodes.JsonObject trigger)
            {
                var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId, ct);
                tracked.NextAt = AutomationTimes.Next(trigger, AutomationTimes.Zone(workspace.TimeZone), clock.GetUtcNow());
            }
            var ws = await db.Workspaces.FirstAsync(w => w.Id == member.WorkspaceId, ct);
            await automations.RecountAsync(ws, [tracked.DatabaseId], ct);
            changes.Add(AutomationService.ChangeType, tracked.Id, "upsert", tracked.Version, member.UserId);
            return AutomationDto.From(tracked);
        }, ct);
    }

    // Webhooks ------------------------------------------------------------------------------------------

    public async Task<Result<IReadOnlyList<WebhookDto>>> WebhooksAsync(Member member, CancellationToken ct)
    {
        if (!member.IsAdmin) return Failure.Denied("Webhooks are for owners and admins");
        var hooks = await db.Webhooks.AsNoTracking().OrderBy(w => w.Name).ToListAsync(ct);
        var people = await People.RefsAsync(db, hooks.Select(h => h.CreatedBy), ct);
        return hooks.Select(h => Dto(h, people)).ToList();
    }

    public async Task<Result<WebhookMadeDto>> CreateWebhookAsync(Member member, Actor actor, WebhookRequest request, CancellationToken ct)
    {
        if (!member.IsAdmin) return Failure.Denied("Webhooks are for owners and admins");
        var name = (request.Name ?? "").Trim();
        if (name.Length is 0 or > 200) return Failure.Invalid("A name of 1 to 200 characters is needed");
        var url = (request.Url ?? "").Trim();
        if (!webhooks.Allowed(url)) return new Failure(Codes.WebhookAddress, 400, "A webhook calls an https address on a public host, on port 443");
        if (await db.Webhooks.CountAsync(ct) >= MaxWebhooks) return Failure.Conflict(Codes.LimitSize, $"A workspace has at most {MaxWebhooks} webhooks");
        var secret = WebhookKeys.NewSecret();
        var hook = new Webhook
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            Name = name,
            Url = url,
            SecretCipher = keys.Protect(member.WorkspaceId, secret),
            CreatedBy = member.UserId,
            CreatedAt = clock.GetUtcNow(),
        };
        db.Webhooks.Add(hook);
        audit.Add(actor, "webhook.create", member.WorkspaceId, "webhook", hook.Id, new { host = new Uri(url).Host });
        await db.SaveChangesAsync(ct);
        var people = await People.RefsAsync(db, [member.UserId], ct);
        return new WebhookMadeDto(Dto(hook, people), secret);
    }

    /// <summary>A webhook removed: rules that call it fail that step from now on (their run log says so).</summary>
    public async Task<Result<bool>> DeleteWebhookAsync(Member member, Actor actor, Guid webhookId, CancellationToken ct)
    {
        if (!member.IsAdmin) return Failure.Denied("Webhooks are for owners and admins");
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == webhookId, ct);
        if (hook is null) return Failure.NotFound("No such webhook");
        db.Webhooks.Remove(hook);
        await db.WebhookDeliveries.Where(d => d.WebhookId == webhookId && d.Status == DeliveryStatuses.Pending)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.Status, DeliveryStatuses.Failed).SetProperty(d => d.LastError, "The webhook was removed"), ct);
        audit.Add(actor, "webhook.delete", member.WorkspaceId, "webhook", hook.Id, null);
        await db.SaveChangesAsync(ct);
        return true;
    }

    // A button's press -----------------------------------------------------------------------------------

    /// <summary>
    /// A button pressed on a row: an event the worker runs the button's rules for, as their authors,
    /// once per <c>pressId</c> (a press sent again answers the same event). Needs edit on the row.
    /// </summary>
    public async Task<Result<PressDto>> PressAsync(Member member, Guid databaseId, string level, Guid rowId, PressRequest request, CancellationToken ct)
    {
        if (!Levels.AtLeast(level, Levels.Edit)) return Failure.Denied("A button is pressed with edit access to its row");
        var row = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == rowId && p.ParentPageId == databaseId && p.Kind == PageKinds.Row && p.DeletedAt == null, ct);
        if (row is null) return Failure.NotFound("No such row");
        if (row.TrashedAt is not null || row.IsTemplate) return Failure.Conflict(Codes.AutomationNone, "A button in the trash or on a template does nothing");
        var record = await db.Databases.AsNoTracking().FirstAsync(d => d.PageId == databaseId, ct);
        if (Schema.Parse(record.PageId, record.Version, record.Properties).Live(request.PropertyId ?? "") is not { Type: PropertyTypes.Button })
            return Failure.Invalid("Not a button of this database");
        if (await db.AutomationEvents.AsNoTracking().FirstOrDefaultAsync(e => e.PressId == request.PressId, ct) is { } again)
            return again.RowId == rowId ? new PressDto(again.Id, []) : Failure.Invalid("That press was another row's");
        var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId, ct);
        var names = workspace.AutomationsOff ? [] : (await db.Automations.AsNoTracking()
                .Where(a => a.DatabaseId == databaseId && a.DeletedAt == null && a.Enabled && a.TriggerKind == "button").ToListAsync(ct))
            .Where(a => System.Text.Json.Nodes.JsonNode.Parse(a.Definition)?["trigger"]?["propertyId"]?.GetValue<string>() == request.PropertyId)
            .Select(a => a.Name).ToList();
        if (names.Count == 0) return Failure.Conflict(Codes.AutomationNone, "No automation is switched on for this button");
        var press = new AutomationEvent
        {
            WorkspaceId = member.WorkspaceId,
            DatabaseId = databaseId,
            RowId = rowId,
            Kind = EventKinds.Button,
            Changed = JsonSerializer.Serialize(new[] { request.PropertyId }),
            ActorId = member.UserId,
            PressId = request.PressId,
            CreatedAt = clock.GetUtcNow(),
        };
        db.AutomationEvents.Add(press);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // The same press, sent twice at once: the first one's event.
            db.ChangeTracker.Clear();
            var first = await db.AutomationEvents.AsNoTracking().FirstAsync(e => e.PressId == request.PressId, ct);
            return new PressDto(first.Id, []);
        }
        return new PressDto(press.Id, names);
    }
}
