using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core;
using Cgw.Core.Automations;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Notifications;
using Cgw.Core.Sync;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;
using DbSchema = Cgw.Core.Databases.Schema;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Phase 15, M15.2: the rules' runner (DATA_MODEL.md, Automations; DECISIONS.md, 2026-11-24).
/// Takes the rows' changes and presses in the order they reached the server, the dates reached and
/// the schedules due; runs each matching rule's conditions and steps as its author, through the
/// same operations and checks a person's edit goes through (<see cref="OpsService"/>), each with an
/// id made from the run so a run taken again changes nothing twice; records the run, its steps and
/// how it ended. A change a run made starts rules up to <see cref="AutomationRules.MaxDepth"/> deep;
/// a rule makes at most 100 runs a minute and a workspace 1,000; dates and schedules are read in the
/// workspace's time zone. Nothing here holds an ERP session or key: no step reaches the ERP.
/// </summary>
public sealed class AutomationJob(DocStates states, TimeProvider clock, ILogger<AutomationJob> logger) : IJob
{
    public string Name => "automations";
    /// <summary>A change's first step shows in an open tab within 2 s (the Phase 15 budget): the queue is read often.</summary>
    public TimeSpan Interval => TimeSpan.FromMilliseconds(100);
    public bool OwnLoop => true;

    public const int Batch = 100;
    /// <summary>An event or a run taken this long ago and not finished was left by a worker that stopped: taken again.</summary>
    public static readonly TimeSpan Stale = TimeSpan.FromMinutes(5);
    /// <summary>How often dates and schedules are looked at.</summary>
    public static TimeSpan TimesEvery { get; set; } = TimeSpan.FromSeconds(15);

    private DateTimeOffset nextTimes = DateTimeOffset.MinValue;
    private readonly DateDueCache dues = new();

    /// <summary>The work one pass did, for the bench and the tests.</summary>
    public sealed record PassReport(int Events, int Runs, int DateRules, int DueRows, TimeSpan DateTime);

    public PassReport? LastPass { get; private set; }

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var (events, runs) = await EventsAsync(services, ct);
        var dateRules = 0;
        var dueRows = 0;
        var dateTime = TimeSpan.Zero;
        if (clock.GetUtcNow() >= nextTimes)
        {
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            (dateRules, dueRows, var dateRuns) = await DatesAsync(services, ct);
            dateTime = System.Diagnostics.Stopwatch.GetElapsedTime(started);
            runs += dateRuns + await SchedulesAsync(services, ct);
            nextTimes = clock.GetUtcNow() + TimesEvery;
        }
        LastPass = new PassReport(events, runs, dateRules, dueRows, dateTime);
        return events >= Batch;
    }

    /// <summary>Runs the date and schedule pass at the next call, whatever its interval (tests).</summary>
    public void TimesNow() => nextTimes = DateTimeOffset.MinValue;

    // Events --------------------------------------------------------------------------------------------

    private async Task<(int Events, int Runs)> EventsAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        // Taken in order, by one statement: a second worker takes the next ones.
        var taken = await db.Database.SqlQueryRaw<long>("""
            WITH next AS (
                SELECT TOP (@batch) [Id], [TakenAt] FROM [AutomationEvents] WITH (UPDLOCK, READPAST)
                WHERE [DoneAt] IS NULL AND ([TakenAt] IS NULL OR [TakenAt] < @stale) ORDER BY [Id])
            UPDATE next SET [TakenAt] = @now OUTPUT inserted.[Id]
            """,
            new Microsoft.Data.SqlClient.SqlParameter("@batch", Batch),
            new Microsoft.Data.SqlClient.SqlParameter("@stale", now - Stale),
            new Microsoft.Data.SqlClient.SqlParameter("@now", now)).ToListAsync(ct);
        if (taken.Count == 0) return (0, 0);
        var events = await db.AutomationEvents.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(e => taken.Contains(e.Id)).OrderBy(e => e.Id).ToListAsync(ct);
        var runner = new AutomationRunner(services, states, clock, logger);
        var runs = 0;
        foreach (var change in events)
        {
            try
            {
                runs += await runner.OnEventAsync(change, ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                // One change that cannot be run never holds the queue: it is logged and left done.
                logger.LogError(e, "Automation event {Event} failed", change.Id);
            }
            await db.AutomationEvents.IgnoreQueryFilters([CgwDb.Tenant]).Where(e => e.Id == change.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(e => e.DoneAt, clock.GetUtcNow()), ct);
        }
        return (events.Count, runs);
    }

    // Dates -----------------------------------------------------------------------------------------------

    /// <summary>
    /// Every date rule switched on: the rows whose date (moved by the offset) was reached since the
    /// last pass, each run once (its due key). A database's dates are read from SQL only when its rows
    /// changed since (<see cref="DateDueCache"/>), so a pass over 50,000 unchanged rows reads none.
    /// </summary>
    private async Task<(int Rules, int Rows, int Runs)> DatesAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var rules = await db.Automations.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(a => a.TriggerKind == "date" && a.Enabled && a.DeletedAt == null).ToListAsync(ct);
        if (rules.Count == 0) return (0, 0, 0);
        var workspaces = await WorkspacesAsync(db, rules.Select(r => r.WorkspaceId), ct);
        var runner = new AutomationRunner(services, states, clock, logger);
        var now = clock.GetUtcNow();
        var due = 0;
        var runs = 0;
        foreach (var rule in rules)
        {
            if (!workspaces.TryGetValue(rule.WorkspaceId, out var workspace) || workspace.AutomationsOff) continue;
            var trigger = (JsonObject)JsonNode.Parse(rule.Definition)!["trigger"]!;
            var from = rule.ScannedUntil ?? now;
            var zone = AutomationTimes.Zone(workspace.TimeZone);
            var record = await db.Databases.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(d => d.PageId == rule.DatabaseId, ct);
            if (record is null) continue;
            var list = await dues.ForAsync(db, rule, trigger, record, zone, ct);
            var reached = list.Between(from, now);
            due += reached.Count;
            foreach (var (row, at) in reached)
            {
                try
                {
                    if (await runner.OnDateAsync(rule, row, at, ct)) runs++;
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    logger.LogError(e, "Automation {Rule} on row {Row} failed", rule.Id, row);
                }
            }
            await db.Automations.IgnoreQueryFilters([CgwDb.Tenant]).Where(a => a.Id == rule.Id && a.Version == rule.Version)
                .ExecuteUpdateAsync(s => s.SetProperty(a => a.ScannedUntil, now), ct);
        }
        return (rules.Count, due, runs);
    }

    private static async Task<Dictionary<Guid, Workspace>> WorkspacesAsync(CgwDb db, IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = ids.Distinct().ToList();
        return await db.Workspaces.AsNoTracking().Where(w => list.Contains(w.Id) && w.DeletedAt == null).ToDictionaryAsync(w => w.Id, ct);
    }

    // Schedules -------------------------------------------------------------------------------------------

    private async Task<int> SchedulesAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        var rules = await db.Automations.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(a => a.TriggerKind == "schedule" && a.Enabled && a.DeletedAt == null && a.NextAt != null && a.NextAt <= now).ToListAsync(ct);
        if (rules.Count == 0) return 0;
        var workspaces = await WorkspacesAsync(db, rules.Select(r => r.WorkspaceId), ct);
        var runner = new AutomationRunner(services, states, clock, logger);
        var runs = 0;
        foreach (var rule in rules)
        {
            if (!workspaces.TryGetValue(rule.WorkspaceId, out var workspace)) continue;
            var trigger = (JsonObject)JsonNode.Parse(rule.Definition)!["trigger"]!;
            // A missed run (the worker stopped) runs once, then the schedule goes on from now.
            if (!workspace.AutomationsOff)
            {
                try
                {
                    if (await runner.OnScheduleAsync(rule, rule.NextAt!.Value, ct)) runs++;
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    logger.LogError(e, "Automation {Rule}'s schedule failed", rule.Id);
                }
            }
            var next = AutomationTimes.Next(trigger, AutomationTimes.Zone(workspace.TimeZone), now);
            await db.Automations.IgnoreQueryFilters([CgwDb.Tenant]).Where(a => a.Id == rule.Id && a.Version == rule.Version)
                .ExecuteUpdateAsync(s => s.SetProperty(a => a.NextAt, next), ct);
        }
        return runs;
    }
}

/// <summary>
/// The moments a database's dates reach a rule (its trigger's property, offset and time of day in
/// the workspace's zone), each row's in order, kept while the database's rows and the rule do not
/// change: read from SQL by the one property (<c>JSON_VALUE</c>), never every value of every row.
/// </summary>
public sealed class DateDueCache
{
    public sealed class Dues(List<(DateTimeOffset At, Guid Row)> sorted)
    {
        public int Count => sorted.Count;

        /// <summary>Those reached after <paramref name="from"/> and up to <paramref name="to"/>.</summary>
        public List<(Guid Row, DateTimeOffset At)> Between(DateTimeOffset from, DateTimeOffset to)
        {
            var lo = 0;
            var hi = sorted.Count;
            while (lo < hi)
            {
                var mid = (lo + hi) / 2;
                if (sorted[mid].At <= from) lo = mid + 1;
                else hi = mid;
            }
            var list = new List<(Guid, DateTimeOffset)>();
            for (var i = lo; i < sorted.Count && sorted[i].At <= to; i++) list.Add((sorted[i].Row, sorted[i].At));
            return list;
        }
    }

    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, (long Version, long RowsVersion, string Zone, Dues Dues)> cache = new();

    public async Task<Dues> ForAsync(CgwDb db, Automation rule, JsonObject trigger, WorkspaceDatabase record, TimeZoneInfo zone, CancellationToken ct)
    {
        if (cache.TryGetValue(rule.Id, out var known) && known.Version == rule.Version && known.RowsVersion == record.RowsVersion && known.Zone == zone.Id)
            return known.Dues;
        var property = (string)trigger["propertyId"]!;
        var offset = (int)trigger["offsetMinutes"]!;
        var at = (string?)trigger["at"];
        var schema = DbSchema.Parse(record.PageId, record.Version, record.Properties);
        var list = new List<(DateTimeOffset, Guid)>();
        if (schema.Live(property) is { } def)
        {
            if (def.Type == PropertyTypes.CreatedTime)
            {
                foreach (var row in await Rows(db, record.PageId).Select(p => new { p.Id, p.CreatedAt }).ToListAsync(ct))
                    list.Add((AutomationTimes.Due(row.CreatedAt, offset), row.Id));
            }
            else
            {
                // The property's start alone, as text: a few bytes a row.
                var path = $"$.\"{property}\".start";
                var rows = await db.Database.SqlQueryRaw<DateRow>("""
                    SELECT r.[PageId] AS [Id], JSON_VALUE(r.[Values], @path) AS [Start]
                    FROM [DatabaseRows] r INNER JOIN [Pages] p ON p.[Id] = r.[PageId]
                    WHERE r.[DatabaseId] = @database AND p.[DeletedAt] IS NULL AND p.[TrashedAt] IS NULL AND p.[IsTemplate] = 0
                        AND JSON_VALUE(r.[Values], @path) IS NOT NULL
                    """,
                    new Microsoft.Data.SqlClient.SqlParameter("@path", path),
                    new Microsoft.Data.SqlClient.SqlParameter("@database", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(record.PageId) })
                    .ToListAsync(ct);
                foreach (var row in rows)
                    if (AutomationTimes.Due(row.Start, offset, at, zone) is { } when) list.Add((when, GuidBytes.FromBytes(row.Id)));
            }
        }
        list.Sort((a, b) => a.Item1.CompareTo(b.Item1));
        var dues = new Dues(list);
        cache[rule.Id] = (rule.Version, record.RowsVersion, zone.Id, dues);
        return dues;
    }

    private static IQueryable<Page> Rows(CgwDb db, Guid database) =>
        db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.ParentPageId == database && p.Kind == PageKinds.Row && p.DeletedAt == null && p.TrashedAt == null && !p.IsTemplate);

    public sealed class DateRow
    {
        public byte[] Id { get; set; } = [];
        public string? Start { get; set; }
    }
}

/// <summary>One run's work: who it is, what it may do, each step through the operations.</summary>
public sealed class AutomationRunner(IServiceProvider services, DocStates states, TimeProvider clock, ILogger logger)
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private CgwDb Db => services.GetRequiredService<CgwDb>();

    /// <summary>An id made from a run and a part of it: the same whenever the run is taken again, ordered by the run's time.</summary>
    public static Guid Derived(DateTimeOffset at, Guid run, string part)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{run:N}:{part}"));
        Span<byte> b = stackalloc byte[16];
        var ms = at.ToUnixTimeMilliseconds();
        for (var i = 5; i >= 0; i--)
        {
            b[i] = (byte)(ms & 0xff);
            ms >>= 8;
        }
        b[6] = (byte)(0x70 | (hash[0] & 0x0f));
        b[7] = hash[1];
        b[8] = (byte)(0x80 | (hash[2] & 0x3f));
        hash.AsSpan(3, 7).CopyTo(b[9..]);
        return new Guid(b, bigEndian: true);
    }

    private sealed record RuleView(Automation Rule, DbSchema Schema, JsonObject Definition, JsonObject Trigger);

    private readonly Dictionary<Guid, List<RuleView>> rulesByDatabase = [];
    private readonly Dictionary<Guid, Workspace?> workspaces = [];

    private async Task<Workspace?> WorkspaceAsync(Guid id, CancellationToken ct)
    {
        if (workspaces.TryGetValue(id, out var known)) return known;
        return workspaces[id] = await Db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Id == id && w.DeletedAt == null, ct);
    }

    private async Task<List<RuleView>> RulesAsync(Guid workspaceId, Guid databaseId, CancellationToken ct)
    {
        if (rulesByDatabase.TryGetValue(databaseId, out var known)) return known;
        var db = Db;
        var record = await db.Databases.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(d => d.PageId == databaseId, ct);
        var list = new List<RuleView>();
        if (record is not null)
        {
            var schema = DbSchema.Parse(record.PageId, record.Version, record.Properties);
            foreach (var rule in await db.Automations.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .Where(a => a.WorkspaceId == workspaceId && a.DatabaseId == databaseId && a.Enabled && a.DeletedAt == null).OrderBy(a => a.CreatedAt).ToListAsync(ct))
            {
                var definition = (JsonObject)JsonNode.Parse(rule.Definition)!;
                list.Add(new RuleView(rule, schema, definition, (JsonObject)definition["trigger"]!));
            }
        }
        return rulesByDatabase[databaseId] = list;
    }

    private static QueryContext Context(TimeZoneInfo zone, DateTimeOffset now, Guid? me)
    {
        var local = TimeZoneInfo.ConvertTime(now, zone);
        return new QueryContext(local.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture), zone.GetUtcOffset(now).TotalMinutes, me?.ToString(), null);
    }

    private static Dictionary<string, object> Map(string json) => ValueJson.ReadMap(string.IsNullOrEmpty(json) ? "{}" : json);

    /// <summary>The rules a change or a press starts; returns how many ran.</summary>
    public async Task<int> OnEventAsync(AutomationEvent change, CancellationToken ct)
    {
        var workspace = await WorkspaceAsync(change.WorkspaceId, ct);
        if (workspace is null || workspace.AutomationsOff) return 0;
        var rules = await RulesAsync(change.WorkspaceId, change.DatabaseId, ct);
        if (rules.Count == 0) return 0;
        var zone = AutomationTimes.Zone(workspace.TimeZone);
        var ctx = Context(zone, clock.GetUtcNow(), change.ActorId);
        var changed = JsonSerializer.Deserialize<string[]>(change.Changed) ?? [];
        var rowChange = new RowChange(change.Kind, changed, Map(change.Before), Map(change.After), change.Kind == EventKinds.Button ? changed.FirstOrDefault() : null);
        var runs = 0;
        foreach (var view in rules)
        {
            if (!AutomationRules.Starts(view.Trigger, view.Schema, rowChange, ctx)) continue;
            if (await RunAsync(view, workspace, change.RowId, change.Id, null, change.Depth + 1, change.ActorId, ct)) runs++;
        }
        return runs;
    }

    public async Task<bool> OnDateAsync(Automation rule, Guid row, DateTimeOffset at, CancellationToken ct)
    {
        var workspace = await WorkspaceAsync(rule.WorkspaceId, ct);
        if (workspace is null) return false;
        var view = (await RulesAsync(rule.WorkspaceId, rule.DatabaseId, ct)).FirstOrDefault(v => v.Rule.Id == rule.Id);
        if (view is null) return false;
        return await RunAsync(view, workspace, row, null, $"date:{row:N}:{at.UtcTicks}", 1, null, ct);
    }

    public async Task<bool> OnScheduleAsync(Automation rule, DateTimeOffset at, CancellationToken ct)
    {
        var workspace = await WorkspaceAsync(rule.WorkspaceId, ct);
        if (workspace is null) return false;
        var view = (await RulesAsync(rule.WorkspaceId, rule.DatabaseId, ct)).FirstOrDefault(v => v.Rule.Id == rule.Id);
        if (view is null) return false;
        return await RunAsync(view, workspace, null, null, $"schedule:{at.UtcTicks}", 1, null, ct);
    }

    private sealed class StepRecord
    {
        public int Index { get; set; }
        public string Kind { get; set; } = "";
        public string Status { get; set; } = "";
        public string? Code { get; set; }
        public string? Detail { get; set; }
        public int? Count { get; set; }
    }

    /// <summary>
    /// One run of a rule: its record made first (a change or a moment starts a rule once), then its
    /// limits, its author's right to it, its conditions, and its steps in order. Returns whether a
    /// run was recorded.
    /// </summary>
    private async Task<bool> RunAsync(RuleView view, Workspace workspace, Guid? rowId, long? eventId, string? dueKey, int depth, Guid? actor, CancellationToken ct)
    {
        var db = Db;
        db.Scope.Switch(workspace.Id);
        var rule = view.Rule;
        var now = clock.GetUtcNow();
        var zone = AutomationTimes.Zone(workspace.TimeZone);
        var ctx = Context(zone, now, actor);
        RowData? row = null;
        if (rowId is { } id)
        {
            row = (await RowStore.ByIdsAsync(db, [id], ct)).FirstOrDefault();
            // A row gone since its change is no row to run for.
            if (row is null || row.Trashed || row.IsTemplate || row.DatabaseId != rule.DatabaseId) return false;
            // A rule's conditions not met is no run.
            if (view.Definition["conditions"] is JsonObject conditions && !Query.Matches(view.Schema, row, Raw.From(conditions), ctx)) return false;
        }

        var existing = await db.AutomationRuns.AsNoTracking().FirstOrDefaultAsync(r => r.AutomationId == rule.Id
            && ((eventId != null && r.EventId == eventId) || (dueKey != null && r.DueKey == dueKey)), ct);
        AutomationRun run;
        if (existing is not null)
        {
            // Taken again after a worker stopped: a run left running goes on (its steps change nothing twice).
            if (existing.Status != RunStatuses.Running) return false;
            run = existing;
        }
        else
        {
            run = new AutomationRun
            {
                Id = Guid.CreateVersion7(),
                WorkspaceId = workspace.Id,
                AutomationId = rule.Id,
                DatabaseId = rule.DatabaseId,
                RowId = rowId,
                EventId = eventId,
                DueKey = dueKey,
                Trigger = rule.TriggerKind,
                Depth = depth,
                ActorId = actor,
                AuthorId = rule.AuthorId,
                Status = RunStatuses.Running,
                StartedAt = now,
            };
            var since = now.AddMinutes(-1);
            if (depth > AutomationRules.MaxDepth) (run.Status, run.Reason) = (RunStatuses.Stopped, "depth");
            else if (await db.AutomationRuns.CountAsync(r => r.AutomationId == rule.Id && r.StartedAt >= since && r.Status != RunStatuses.Skipped, ct) >= AutomationRules.RuleRunsPerMinute)
                (run.Status, run.Reason) = (RunStatuses.Skipped, "limit.rule");
            else if (await db.AutomationRuns.CountAsync(r => r.StartedAt >= since && r.Status != RunStatuses.Skipped, ct) >= AutomationRules.WorkspaceRunsPerMinute)
                (run.Status, run.Reason) = (RunStatuses.Skipped, "limit.workspace");
            if (run.Status != RunStatuses.Running) run.EndedAt = now;
            db.AutomationRuns.Add(run);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                // Another worker made it first.
                db.ChangeTracker.Clear();
                return false;
            }
            db.ChangeTracker.Clear();
            if (run.Status != RunStatuses.Running) return true;
        }

        var steps = new List<StepRecord>();
        string status = RunStatuses.Done;
        string? reason = null;
        var member = await db.WorkspaceMembers.AsNoTracking().Where(m => m.UserId == rule.AuthorId)
            .Select(m => new Member(m.WorkspaceId, m.UserId, m.Role)).FirstOrDefaultAsync(ct);
        if (member is null) (status, reason) = (RunStatuses.Stopped, "author.gone");
        else if (await new Access(db).PageLevelAsync(member, rule.DatabaseId) != Levels.Full)
        {
            (status, reason) = (RunStatuses.Stopped, "author.access");
            await TellAuthorAsync(run, rule, reason, ct);
        }
        else
        {
            var stepList = (JsonArray)view.Definition["steps"]!;
            for (var i = 0; i < stepList.Count && status == RunStatuses.Done; i++)
            {
                var step = (JsonObject)stepList[i]!;
                var record = new StepRecord { Index = i, Kind = (string)step["kind"]! };
                steps.Add(record);
                // A step's conditions read the row as the steps before it left it.
                if (row is not null) row = (await RowStore.ByIdsAsync(db, [row.Id], ct)).FirstOrDefault();
                if (rowId is not null && row is null)
                {
                    (record.Status, record.Code) = ("failed", "row.gone");
                    (status, reason) = (RunStatuses.Stopped, "row.gone");
                    break;
                }
                if (step["when"] is JsonObject when && row is not null && !Query.Matches(view.Schema, row, Raw.From(when), ctx))
                {
                    record.Status = "skipped";
                    continue;
                }
                var (ok, code) = record.Kind switch
                {
                    "set" => await SetAsync(member, run, i, step, view.Schema, row!, zone, now, ct),
                    "addRow" => await AddRowAsync(member, run, i, step, row, zone, now, ct),
                    "notify" => await NotifyAsync(run, rule, i, step, row, record, ct),
                    "webhook" => await WebhookAsync(member, run, rule, i, step, view.Schema, row, workspace, ct),
                    _ => (false, "step.kind"),
                };
                record.Status = ok ? (record.Kind == "webhook" ? "queued" : "done") : "failed";
                record.Code = code;
                if (!ok)
                {
                    (status, reason) = (RunStatuses.Stopped, code);
                    // What its author can no longer do is told to them.
                    if (code is Codes.AccessDenied or Codes.NotFound or "webhook.access") await TellAuthorAsync(run, rule, code, ct);
                }
            }
        }
        await db.AutomationRuns.Where(r => r.Id == run.Id).ExecuteUpdateAsync(s => s
            .SetProperty(r => r.Status, status)
            .SetProperty(r => r.Reason, reason)
            .SetProperty(r => r.Steps, JsonSerializer.Serialize(steps, Web))
            .SetProperty(r => r.EndedAt, clock.GetUtcNow()), ct);
        return true;
    }

    /// <summary>Operations applied as the author, in a scope of their own, marked as this run's (its depth).</summary>
    private async Task<OpResultDto> ApplyAsync(Member member, AutomationRun run, OperationDto op, (Guid Id, byte[] Data, int Schema)? first, CancellationToken ct)
    {
        await using var scope = services.GetRequiredService<IServiceScopeFactory>().CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        db.Scope.Switch(member.WorkspaceId);
        scope.ServiceProvider.GetRequiredService<DatabaseOps>().Origin = (run.Id, run.Depth);
        var ops = scope.ServiceProvider.GetRequiredService<OpsService>();
        if (first is { } doc) ops.FirstDocuments[doc.Id] = (doc.Data, doc.Schema);
        var response = await ops.ApplyAsync(member, new Actor(member.UserId, null, null), new OpsRequest(null, [op]), ct);
        return response.Results[0];
    }

    private static OperationDto Op(Guid opId, string type, Guid workspace, Guid entity, object payload, DateTimeOffset at) =>
        new(opId, type, workspace, entity, null, JsonSerializer.SerializeToElement(payload, Web), at.ToString("O"));

    /// <summary>A step value worked out now (db/automations.ts <c>StepValue</c>); null leaves the property as it is.</summary>
    private static JsonNode? Resolve(JsonNode? value, PropertyDef? def, AutomationRun run, TimeZoneInfo zone, DateTimeOffset now, out bool skip)
    {
        skip = false;
        if (value is JsonObject o && (string?)o["dynamic"] is { } dynamic)
        {
            switch (dynamic)
            {
                case "now":
                {
                    var days = o["days"] is JsonValue d ? d.GetValue<double>() : 0;
                    if (def is { IncludeTime: true })
                        return new JsonObject { ["start"] = now.AddDays(days).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture) };
                    var local = TimeZoneInfo.ConvertTime(now, zone).Date.AddDays(days);
                    return new JsonObject { ["start"] = local.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) };
                }
                case "actor":
                    if (run.ActorId is not { } actor)
                    {
                        skip = true;
                        return null;
                    }
                    return new JsonArray(actor.ToString());
                case "row":
                    if (run.RowId is not { } row)
                    {
                        skip = true;
                        return null;
                    }
                    return new JsonArray(row.ToString());
            }
        }
        return value?.DeepClone();
    }

    private async Task<(bool, string?)> SetAsync(Member member, AutomationRun run, int index, JsonObject step, DbSchema schema, RowData row, TimeZoneInfo zone, DateTimeOffset now, CancellationToken ct)
    {
        var values = new JsonObject();
        string? title = null;
        foreach (var (id, raw) in (JsonObject)step["values"]!)
        {
            var value = Resolve(raw, schema.Live(id), run, zone, now, out var skip);
            if (skip) continue;
            if (id == PropertyDef.TitleId) title = (string?)value ?? "";
            else values[id] = value;
        }
        if (values.Count > 0)
        {
            var result = await ApplyAsync(member, run, Op(Derived(run.StartedAt, run.Id, $"{index}:values"), "row.update", member.WorkspaceId, row.Id, new { values }, now), null, ct);
            if (result.Status != "applied") return (false, result.Error?.Code);
        }
        if (title is not null)
        {
            var result = await ApplyAsync(member, run, Op(Derived(run.StartedAt, run.Id, $"{index}:title"), "page.update", member.WorkspaceId, row.Id, new { title }, now), null, ct);
            if (result.Status != "applied") return (false, result.Error?.Code);
        }
        return (true, null);
    }

    private async Task<(bool, string?)> AddRowAsync(Member member, AutomationRun run, int index, JsonObject step, RowData? source, TimeZoneInfo zone, DateTimeOffset now, CancellationToken ct)
    {
        var db = Db;
        var target = Guid.Parse((string)step["databaseId"]!);
        var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == target && p.DeletedAt == null && p.Kind == PageKinds.Database, ct);
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == target, ct);
        if (page is null || record is null) return (false, Codes.NotFound);
        var schema = DbSchema.Parse(record.PageId, record.Version, record.Properties);
        Page? template = null;
        DatabaseRow? templateRow = null;
        if (step["templateId"] is JsonValue t && Guid.TryParse((string?)t, out var templateId))
        {
            template = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == templateId && p.ParentPageId == target && p.IsTemplate && p.DeletedAt == null, ct);
            templateRow = template is null ? null : await db.DatabaseRows.AsNoTracking().FirstOrDefaultAsync(r => r.PageId == template.Id, ct);
        }
        var values = templateRow is null ? new JsonObject() : (JsonObject)JsonNode.Parse(templateRow.Values)!;
        string? title = template?.Title;
        foreach (var (property, raw) in (JsonObject)step["values"]!)
        {
            var value = Resolve(raw, schema.Live(property), run, zone, now, out var skip);
            if (skip) continue;
            if (property == PropertyDef.TitleId) title = (string?)value ?? "";
            else values[property] = value;
        }
        var id = Derived(run.StartedAt, run.Id, $"{index}:row");
        var last = await db.Pages.AsNoTracking().Where(p => p.ParentPageId == target && p.DeletedAt == null && p.Kind == PageKinds.Row)
            .Select(p => p.OrderKey).ToListAsync(ct);
        var orderKey = OrderKeys.Between(last.OrderBy(k => k, StringComparer.Ordinal).LastOrDefault(), null);
        (Guid, byte[], int)? first = null;
        if (template is { DocHeadSeq: > 0 })
        {
            // Its body, copied once, its block ids made now from the run (the same if taken again).
            var state = await states.LoadAsync(db, template, ct);
            var seed = SHA256.HashData(Encoding.UTF8.GetBytes($"{run.Id:N}:{index}:body"));
            try
            {
                var client = await ClientIdAsync(member, now, ct);
                first = (id, Yjs.CopyBody(state, id, client, seed), template.DocSchemaVersion);
            }
            catch (YdocException e)
            {
                logger.LogWarning(e, "The body of template {Template} could not be copied", template.Id);
            }
        }
        var payload = new
        {
            id,
            workspaceId = member.WorkspaceId,
            sectionId = page.SectionId,
            parentPageId = target,
            orderKey,
            kind = PageKinds.Row,
            title = title ?? "",
            icon = template?.Icon,
            coverAssetId = template?.CoverAssetId,
            isTemplate = false,
            templateOfPageId = template?.Id,
            version = 1,
            createdAt = now,
            updatedAt = now,
            trashedAt = (DateTimeOffset?)null,
            trashRootId = (Guid?)null,
            row = new { values },
        };
        var result = await ApplyAsync(member, run, Op(Derived(run.StartedAt, run.Id, $"{index}:create"), "page.create", member.WorkspaceId, id, payload, now), first, ct);
        return result.Status == "applied" ? (true, null) : (false, result.Error?.Code);
    }

    /// <summary>A Yjs client id of the author's for a body the server writes, issued as the device pool issues them.</summary>
    private async Task<ulong> ClientIdAsync(Member member, DateTimeOffset now, CancellationToken ct)
    {
        var db = Db;
        for (var attempt = 0; ; attempt++)
        {
            var id = (long)RandomNumberGenerator.GetInt32(1, int.MaxValue) * 2L + RandomNumberGenerator.GetInt32(0, 2);
            if (await db.YjsClients.AnyAsync(c => c.ClientId == id, ct) && attempt < 10) continue;
            db.YjsClients.Add(new YjsClient { WorkspaceId = member.WorkspaceId, ClientId = id, UserId = member.UserId, Origin = "automation", CreatedAt = now });
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
            return (ulong)id;
        }
    }

    private async Task<(bool, string?)> NotifyAsync(AutomationRun run, Automation rule, int index, JsonObject step, RowData? row, StepRecord record, CancellationToken ct)
    {
        var db = Db;
        var people = new HashSet<Guid>(((JsonArray)step["people"]!).Select(x => Guid.Parse((string)x!)));
        var groups = ((JsonArray)step["groups"]!).Select(x => Guid.Parse((string)x!)).ToList();
        if (groups.Count > 0)
            people.UnionWith(await db.WorkspaceGroupMembers.AsNoTracking().Where(g => groups.Contains(g.GroupId)).Select(g => g.UserId).ToListAsync(ct));
        var properties = ((JsonArray)step["personProperties"]!).Select(x => (string)x!).ToList();
        if (row is not null && properties.Count > 0)
        {
            var schema = DbSchema.Parse(rule.DatabaseId, 0, await db.Databases.AsNoTracking().Where(d => d.PageId == rule.DatabaseId).Select(d => d.Properties).FirstAsync(ct));
            foreach (var def in properties.Select(schema.Live).OfType<PropertyDef>())
            {
                var ids = def.Type switch
                {
                    PropertyTypes.CreatedBy => [row.CreatedBy ?? ""],
                    PropertyTypes.LastEditedBy => [row.UpdatedBy ?? ""],
                    _ => row.Values.GetValueOrDefault(def.Id) as string[] ?? [],
                };
                foreach (var id in ids) if (Guid.TryParse(id, out var g)) people.Add(g);
            }
        }
        // Only those who can read what the notice is about: the row, or the database for a schedule.
        var subject = row?.Id ?? rule.DatabaseId;
        var members = await db.WorkspaceMembers.AsNoTracking().Where(m => people.Contains(m.UserId))
            .Select(m => new Member(m.WorkspaceId, m.UserId, m.Role)).ToListAsync(ct);
        var told = new List<Member>();
        foreach (var member in members)
            if (await new Access(db).PageLevelAsync(member, subject) != Levels.None) told.Add(member);
        var message = (string)step["message"]!;
        var excerpt = message.Length > 200 ? message[..200] : message;
        var now = clock.GetUtcNow();
        await LockedAsync(run.WorkspaceId, async changes => await NotificationService.AddAsync(db, changes, told.Select(m => new Notification
        {
            Id = Derived(run.StartedAt, run.Id, $"{index}:notice:{m.UserId:N}"),
            WorkspaceId = run.WorkspaceId,
            UserId = m.UserId,
            Kind = NotificationKinds.Automation,
            PageId = subject,
            ActorUserId = rule.AuthorId,
            Excerpt = excerpt,
            DedupeKey = $"automation:{run.Id:N}:{index}",
            AutomationId = rule.Id,
            CreatedAt = now,
        }).ToList(), ct), ct);
        record.Count = told.Count;
        return (true, null);
    }

    /// <summary>A run that stopped for what its author can no longer do: told to them in the inbox (kind <c>automation</c>, its reason).</summary>
    private async Task TellAuthorAsync(AutomationRun run, Automation rule, string? reason, CancellationToken ct)
    {
        var db = Db;
        var member = await db.WorkspaceMembers.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == rule.AuthorId, ct);
        if (member is null) return;
        await LockedAsync(run.WorkspaceId, async changes => await NotificationService.AddAsync(db, changes, [new Notification
        {
            Id = Derived(run.StartedAt, run.Id, "stopped"),
            WorkspaceId = run.WorkspaceId,
            UserId = rule.AuthorId,
            Kind = NotificationKinds.Automation,
            // The database: its row may be what they can no longer read.
            PageId = rule.DatabaseId,
            ActorUserId = rule.AuthorId,
            Excerpt = "",
            DedupeKey = $"automationStop:{run.Id:N}",
            AutomationId = rule.Id,
            Reason = reason ?? "stopped",
            CreatedAt = clock.GetUtcNow(),
        }], ct), ct);
    }

    private async Task LockedAsync(Guid workspaceId, Func<ChangeLog, Task> work, CancellationToken ct)
    {
        var db = Db;
        var changes = services.GetRequiredService<ChangeLog>();
        var strategy = db.Database.CreateExecutionStrategy();
        await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(workspaceId, ct);
            await work(changes);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        });
        db.ChangeTracker.Clear();
    }

    private async Task<(bool, string?)> WebhookAsync(Member member, AutomationRun run, Automation rule, int index, JsonObject step, DbSchema schema, RowData? row, Workspace workspace, CancellationToken ct)
    {
        var db = Db;
        // Owners and admins only, at every run.
        if (!member.IsAdmin) return (false, "webhook.access");
        var webhookId = Guid.Parse((string)step["webhookId"]!);
        var hook = await db.Webhooks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == webhookId, ct);
        if (hook is null) return (false, "webhook.gone");
        if (await db.WebhookDeliveries.AnyAsync(d => d.RunId == run.Id && d.StepIndex == index, ct)) return (true, null);
        var deliveryId = Derived(run.StartedAt, run.Id, $"{index}:delivery");
        var body = await WebhookBodies.BodyAsync(db, member, run, rule, schema, row, ((JsonArray)step["properties"]!).Select(x => (string)x!).ToList(), deliveryId, ct);
        db.WebhookDeliveries.Add(new WebhookDelivery
        {
            Id = deliveryId,
            WorkspaceId = workspace.Id,
            WebhookId = hook.Id,
            RunId = run.Id,
            StepIndex = index,
            Body = body,
            NextAt = clock.GetUtcNow(),
            CreatedAt = clock.GetUtcNow(),
        });
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();
        return (true, null);
    }
}
