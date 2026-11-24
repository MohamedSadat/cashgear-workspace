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
    /// <summary>Phase 17: how often the runs waiting are looked at for those due (an answered approval goes on within it).</summary>
    public static TimeSpan WaitsEvery { get; set; } = TimeSpan.FromSeconds(1);

    private DateTimeOffset nextTimes = DateTimeOffset.MinValue;
    private DateTimeOffset nextWaits = DateTimeOffset.MinValue;
    private readonly DateDueCache dues = new(clock);

    /// <summary>The dates' cache, for the bench's breakdown of a read.</summary>
    public DateDueCache Dues => dues;

    /// <summary>The work one pass did, for the bench and the tests.</summary>
    public sealed record PassReport(int Events, int Runs, int DateRules, int DueRows, TimeSpan DateTime, int Waits = 0, TimeSpan WaitsTime = default);

    public PassReport? LastPass { get; private set; }

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var (events, runs) = await EventsAsync(services, ct);
        var waits = 0;
        var waitsTime = TimeSpan.Zero;
        if (clock.GetUtcNow() >= nextWaits)
        {
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            waits = await WaitsAsync(services, ct);
            waitsTime = System.Diagnostics.Stopwatch.GetElapsedTime(started);
            nextWaits = clock.GetUtcNow() + WaitsEvery;
        }
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
        LastPass = new PassReport(events, runs, dateRules, dueRows, dateTime, waits, waitsTime);
        return events >= Batch || waits >= Batch;
    }

    /// <summary>Runs the date and schedule pass at the next call, whatever its interval (tests).</summary>
    public void TimesNow() => nextTimes = DateTimeOffset.MinValue;

    /// <summary>Looks at the runs waiting at the next call, whatever its interval (tests).</summary>
    public void WaitsNow() => nextWaits = DateTimeOffset.MinValue;

    // Waits (Phase 17) -------------------------------------------------------------------------------

    /// <summary>
    /// The runs whose wait is due (its time, date, limit or deadline reached, a row's change or an
    /// answer that woke it), taken by one statement in the order they are due, each gone on from its
    /// place. One taken and not put down within <see cref="Stale"/> (a worker that stopped) is taken
    /// again, and goes on from the same place: its steps' ids are its own, so nothing happens twice.
    /// </summary>
    private async Task<int> WaitsAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        // Ids come back as binary(16), as raw SQL reads them.
        var raw = await db.Database.SqlQueryRaw<byte[]>("""
            WITH next AS (
                SELECT TOP (@batch) [Id], [TakenAt] FROM [AutomationRuns] WITH (UPDLOCK, READPAST)
                WHERE [Status] = 'waiting' AND [WaitUntil] <= @now AND ([TakenAt] IS NULL OR [TakenAt] < @stale) ORDER BY [WaitUntil])
            UPDATE next SET [TakenAt] = @now OUTPUT inserted.[Id]
            """,
            new Microsoft.Data.SqlClient.SqlParameter("@batch", Batch),
            new Microsoft.Data.SqlClient.SqlParameter("@stale", now - Stale),
            new Microsoft.Data.SqlClient.SqlParameter("@now", now)).ToListAsync(ct);
        if (raw.Count == 0) return 0;
        var taken = raw.Select(GuidBytes.FromBytes).ToList();
        var runs = await db.AutomationRuns.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(r => taken.Contains(r.Id)).OrderBy(r => r.WaitUntil).ToListAsync(ct);
        var runner = new AutomationRunner(services, states, clock, logger);
        foreach (var run in runs)
        {
            try
            {
                await runner.ResumeAsync(run, ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                // Left taken: looked at again once it is stale.
                logger.LogError(e, "Automation run {Run} could not go on", run.Id);
            }
        }
        return runs.Count;
    }

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
/// the workspace's zone), each row's in order. Read from SQL by the one property (<c>JSON_VALUE</c>),
/// never every value of every row; then, while the rule and the zone do not change, only the rows
/// written since (their <c>Seq</c> past the rows version read, as the query cache reads them), and
/// the whole again every <see cref="FullEvery"/> in case a row went without a stamp.
/// </summary>
public sealed class DateDueCache(TimeProvider clock)
{
    public static readonly TimeSpan FullEvery = TimeSpan.FromMinutes(10);

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

    private sealed record Entry(long Version, long RowsVersion, string Zone, DateTimeOffset ReadAt, Dictionary<Guid, DateTimeOffset> ByRow, Dues Dues);

    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, Entry> cache = new();

    /// <summary>The last read from SQL: whole or the rows written since, the rows read, the query's time and the rest (the bench).</summary>
    public (bool Full, int Rows, TimeSpan Sql, TimeSpan Work)? LastRead { get; private set; }

    public async Task<Dues> ForAsync(CgwDb db, Automation rule, JsonObject trigger, WorkspaceDatabase record, TimeZoneInfo zone, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        cache.TryGetValue(rule.Id, out var known);
        var same = known is not null && known.Version == rule.Version && known.Zone == zone.Id && now - known.ReadAt < FullEvery;
        if (same && known!.RowsVersion == record.RowsVersion) return known.Dues;
        var property = (string)trigger["propertyId"]!;
        var offset = (int)trigger["offsetMinutes"]!;
        var at = (string?)trigger["at"];
        var schema = DbSchema.Parse(record.PageId, record.Version, record.Properties);
        var byRow = same ? new Dictionary<Guid, DateTimeOffset>(known!.ByRow) : [];
        if (schema.Live(property) is { } def)
        {
            var created = def.Type == PropertyTypes.CreatedTime;
            // The property's start alone, as text: a few bytes a row, read once (a second
            // JSON_VALUE in the filter doubled the read: 50,000 rows in 530 ms against 300). A row
            // read again that is no longer live, or holds no date, leaves the list.
            var path = $"$.\"{property}\".start";
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            var rows = await db.Database.SqlQueryRaw<DateRow>(same
                ? """
                  SELECT r.[PageId] AS [Id], JSON_VALUE(r.[Values], @path) AS [Start], p.[CreatedAt],
                      CAST(CASE WHEN p.[DeletedAt] IS NULL AND p.[TrashedAt] IS NULL AND p.[IsTemplate] = 0 THEN 1 ELSE 0 END AS bit) AS [Live]
                  FROM [DatabaseRows] r INNER JOIN [Pages] p ON p.[Id] = r.[PageId]
                  WHERE r.[DatabaseId] = @database AND r.[Seq] > @since
                  """
                : """
                  SELECT r.[PageId] AS [Id], JSON_VALUE(r.[Values], @path) AS [Start], p.[CreatedAt], CAST(1 AS bit) AS [Live]
                  FROM [DatabaseRows] r INNER JOIN [Pages] p ON p.[Id] = r.[PageId]
                  WHERE r.[DatabaseId] = @database AND p.[DeletedAt] IS NULL AND p.[TrashedAt] IS NULL AND p.[IsTemplate] = 0
                  """,
                new Microsoft.Data.SqlClient.SqlParameter("@path", path),
                new Microsoft.Data.SqlClient.SqlParameter("@database", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(record.PageId) },
                new Microsoft.Data.SqlClient.SqlParameter("@since", System.Data.SqlDbType.BigInt) { Value = same ? known!.RowsVersion : 0L })
                .ToListAsync(ct);
            var sql = System.Diagnostics.Stopwatch.GetElapsedTime(started);
            // Dates repeat (a day without a time most of all): each worked out once a read.
            var dues = new Dictionary<string, DateTimeOffset?>(StringComparer.Ordinal);
            foreach (var row in rows)
            {
                var id = GuidBytes.FromBytes(row.Id);
                DateTimeOffset? when = null;
                if (row.Live && created) when = AutomationTimes.Due(row.CreatedAt, offset);
                else if (row.Live && row.Start is { } start && !dues.TryGetValue(start, out when))
                    dues[start] = when = AutomationTimes.Due(start, offset, at, zone);
                if (when is { } due) byRow[id] = due;
                else byRow.Remove(id);
            }
            LastRead = (!same, rows.Count, sql, System.Diagnostics.Stopwatch.GetElapsedTime(started) - sql);
        }
        else byRow.Clear();
        var list = new List<(DateTimeOffset, Guid)>(byRow.Count);
        foreach (var (row, due) in byRow) list.Add((due, row));
        list.Sort((a, b) => a.Item1 != b.Item1 ? a.Item1.CompareTo(b.Item1) : a.Item2.CompareTo(b.Item2));
        var entry = new Entry(rule.Version, record.RowsVersion, zone.Id, same ? known!.ReadAt : now, byRow, new Dues(list));
        cache[rule.Id] = entry;
        return entry.Dues;
    }

    public sealed class DateRow
    {
        public byte[] Id { get; set; } = [];
        public string? Start { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
        public bool Live { get; set; }
    }
}

/// <summary>One run's work: who it is, what it may do, each step through the operations.</summary>
public sealed class AutomationRunner(IServiceProvider services, DocStates states, TimeProvider clock, ILogger logger)
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    /// <summary>Phase 17: a wait on a date or on conditions is looked at again at least this often, whatever wakes it.</summary>
    public static readonly TimeSpan Recheck = TimeSpan.FromHours(1);

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
        // Phase 17: a change of a row wakes its runs that wait on its date or on conditions.
        var now = clock.GetUtcNow();
        await Db.AutomationRuns.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(r => r.RowId == change.RowId && r.Status == RunStatuses.Waiting && (r.WaitKind == WaitKinds.Date || r.WaitKind == WaitKinds.Match) && r.WaitUntil > now)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.WaitUntil, now), ct);
        var workspace = await WorkspaceAsync(change.WorkspaceId, ct);
        if (workspace is null || workspace.AutomationsOff) return 0;
        var rules = await RulesAsync(change.WorkspaceId, change.DatabaseId, ct);
        if (rules.Count == 0) return 0;
        var zone = AutomationTimes.Zone(workspace.TimeZone);
        var ctx = Context(zone, now, change.ActorId);
        var changed = JsonSerializer.Deserialize<string[]>(change.Changed) ?? [];
        var rowChange = new RowChange(change.Kind, changed, Map(change.Before), Map(change.After), change.Kind == EventKinds.Button ? changed.FirstOrDefault() : null,
            change.FormId?.ToString());
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
        public string? Path { get; set; }
        public string Kind { get; set; } = "";
        public string Status { get; set; } = "";
        public string? Code { get; set; }
        public string? Detail { get; set; }
        public int? Count { get; set; }
    }

    private enum Flow { Next, Wait, Stop }

    /// <summary>A run as its steps go: what it is for and as whom, the row as the steps left it, where it waits.</summary>
    private sealed class RunState(AutomationRun run, Automation rule, DbSchema schema, JsonObject definition, Workspace workspace, Member member)
    {
        public AutomationRun Run { get; } = run;
        public Automation Rule { get; } = rule;
        public DbSchema Schema { get; } = schema;
        public JsonObject Definition { get; } = definition;
        public Workspace Workspace { get; } = workspace;
        public Member Member { get; } = member;
        public TimeZoneInfo Zone { get; } = AutomationTimes.Zone(workspace.TimeZone);
        public RowData? Row { get; set; }
        public List<StepRecord> Steps { get; set; } = [];
        public Dictionary<string, int> Ordinals { get; } = AutomationRules.AllSteps((JsonArray)definition["steps"]!).Select((s, i) => (s.Path, i)).ToDictionary(x => x.Path, x => x.i);
        public JsonObject Context { get; set; } = [];
        public string? Reason { get; set; }
        public string? Place { get; set; }
        public string? WaitKind { get; set; }
        public DateTimeOffset? WaitUntil { get; set; }
        public DateTimeOffset? WaitedAt { get; set; }

        public StepRecord Record(string path, string kind)
        {
            var known = Steps.FirstOrDefault(s => s.Path == path || (s.Path is null && s.Index.ToString(System.Globalization.CultureInfo.InvariantCulture) == path));
            if (known is not null) return known;
            var record = new StepRecord { Index = Ordinals.GetValueOrDefault(path), Path = path, Kind = kind };
            Steps.Add(record);
            return record;
        }

        public Flow Waits(string path, string kind, DateTimeOffset until, DateTimeOffset waitedAt)
        {
            (Place, WaitKind, WaitUntil, WaitedAt) = (path, kind, until, waitedAt);
            return Flow.Wait;
        }
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

        var member = await AuthorAsync(run, rule, ct);
        if (member is null) return true;
        var st = new RunState(run, rule, view.Schema, view.Definition, workspace, member) { Row = row };
        var flow = await ListAsync(st, (JsonArray)view.Definition["steps"]!, "", null, ct);
        await FinishAsync(st, flow, ct);
        return true;
    }

    /// <summary>The run's author as a member with full access to its database, or null once its run is recorded stopped (and the author told).</summary>
    private async Task<Member?> AuthorAsync(AutomationRun run, Automation rule, CancellationToken ct)
    {
        var db = Db;
        var member = await db.WorkspaceMembers.AsNoTracking().Where(m => m.UserId == run.AuthorId)
            .Select(m => new Member(m.WorkspaceId, m.UserId, m.Role)).FirstOrDefaultAsync(ct);
        string? reason = null;
        if (member is null) reason = "author.gone";
        else if (await new Access(db).PageLevelAsync(member, rule.DatabaseId) != Levels.Full)
        {
            reason = "author.access";
            await TellAuthorAsync(run, rule, reason, ct);
        }
        if (reason is null) return member;
        await StopAsync(run, reason, null, ct);
        return null;
    }

    /// <summary>A run ended where it is (its steps as recorded), and its approvals still open closed.</summary>
    private async Task StopAsync(AutomationRun run, string reason, string? steps, CancellationToken ct)
    {
        var db = Db;
        await db.AutomationRuns.Where(r => r.Id == run.Id).ExecuteUpdateAsync(s => s
            .SetProperty(r => r.Status, RunStatuses.Stopped)
            .SetProperty(r => r.Reason, reason)
            .SetProperty(r => r.Steps, r => steps ?? r.Steps)
            .SetProperty(r => r.WaitUntil, (DateTimeOffset?)null)
            .SetProperty(r => r.TakenAt, (DateTimeOffset?)null)
            .SetProperty(r => r.EndedAt, clock.GetUtcNow()), ct);
        await db.AutomationApprovals.Where(a => a.RunId == run.Id && a.Outcome == null)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Outcome, ApprovalOutcomes.Stopped), ct);
    }

    /// <summary>The run's record as its steps left it: done, stopped, or waiting at its place.</summary>
    private async Task FinishAsync(RunState st, Flow flow, CancellationToken ct)
    {
        var db = Db;
        var run = st.Run;
        var steps = JsonSerializer.Serialize(st.Steps, Web);
        if (flow == Flow.Stop)
        {
            await StopAsync(run, st.Reason ?? "stopped", steps, ct);
            return;
        }
        var waiting = flow == Flow.Wait;
        var definition = waiting ? run.Definition ?? st.Definition.ToJsonString() : run.Definition;
        var context = st.Context.Count == 0 ? null : st.Context.ToJsonString();
        await db.AutomationRuns.Where(r => r.Id == run.Id).ExecuteUpdateAsync(s => s
            .SetProperty(r => r.Status, waiting ? RunStatuses.Waiting : RunStatuses.Done)
            .SetProperty(r => r.Reason, (string?)null)
            .SetProperty(r => r.Steps, steps)
            .SetProperty(r => r.Definition, definition)
            .SetProperty(r => r.Context, context)
            .SetProperty(r => r.Place, waiting ? st.Place : null)
            .SetProperty(r => r.WaitKind, waiting ? st.WaitKind : null)
            .SetProperty(r => r.WaitUntil, waiting ? st.WaitUntil : null)
            .SetProperty(r => r.WaitedAt, waiting ? st.WaitedAt : null)
            .SetProperty(r => r.TakenAt, (DateTimeOffset?)null)
            .SetProperty(r => r.EndedAt, waiting ? null : clock.GetUtcNow()), ct);
    }

    /// <summary>
    /// Phase 17: a waiting run taken by the worker goes on from its place, by the definition it
    /// started with, as the author it started as: the rule, its author's access and its row read
    /// again first, and the run stopped, recorded, if any is gone.
    /// </summary>
    public async Task ResumeAsync(AutomationRun run, CancellationToken ct)
    {
        var db = Db;
        var workspace = await WorkspaceAsync(run.WorkspaceId, ct);
        if (workspace is null)
        {
            await db.AutomationRuns.IgnoreQueryFilters([CgwDb.Tenant]).Where(r => r.Id == run.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(r => r.Status, RunStatuses.Stopped).SetProperty(r => r.Reason, "workspace.gone").SetProperty(r => r.EndedAt, clock.GetUtcNow()), ct);
            return;
        }
        db.Scope.Switch(workspace.Id);
        var rule = await db.Automations.AsNoTracking().FirstOrDefaultAsync(a => a.Id == run.AutomationId, ct);
        var off = workspace.AutomationsOff ? "automations.off" : rule is null || rule.DeletedAt is not null ? "rule.deleted" : !rule.Enabled ? "rule.off" : null;
        if (off is not null)
        {
            await StopAsync(run, off, null, ct);
            return;
        }
        var member = await AuthorAsync(run, rule!, ct);
        if (member is null) return;
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == run.DatabaseId, ct);
        if (record is null)
        {
            await StopAsync(run, Codes.NotFound, null, ct);
            return;
        }
        var schema = DbSchema.Parse(record.PageId, record.Version, record.Properties);
        var definition = (JsonObject)JsonNode.Parse(run.Definition ?? rule!.Definition)!;
        var st = new RunState(run, rule!, schema, definition, workspace, member)
        {
            Steps = JsonSerializer.Deserialize<List<StepRecord>>(run.Steps, Web) ?? [],
            Context = run.Context is { } c ? (JsonObject)JsonNode.Parse(c)! : [],
        };
        if (run.RowId is { } rowId)
        {
            st.Row = (await RowStore.ByIdsAsync(db, [rowId], ct)).FirstOrDefault();
            if (st.Row is null || st.Row.Trashed || st.Row.IsTemplate)
            {
                if (run.Place is { } place) st.Record(place, "").Status = "failed";
                st.Reason = "row.gone";
                await FinishAsync(st, Flow.Stop, ct);
                return;
            }
        }
        var flow = await ListAsync(st, (JsonArray)definition["steps"]!, "", run.Place, ct);
        await FinishAsync(st, flow, ct);
    }

    // Steps -----------------------------------------------------------------------------------------

    /// <summary>A list of steps run in order from its first, or (<paramref name="resume"/>) from a place inside it.</summary>
    private async Task<Flow> ListAsync(RunState st, JsonArray list, string prefix, string? resume, CancellationToken ct)
    {
        var start = 0;
        string? inner = null;
        if (resume is not null)
        {
            var slash = resume.IndexOf('/');
            start = int.Parse(slash < 0 ? resume : resume[..slash], System.Globalization.CultureInfo.InvariantCulture);
            inner = slash < 0 ? "" : resume[(slash + 1)..];
        }
        for (var i = start; i < list.Count; i++)
        {
            var path = prefix.Length == 0 ? i.ToString(System.Globalization.CultureInfo.InvariantCulture) : $"{prefix}/{i}";
            var step = (JsonObject)list[i]!;
            var flow = inner is not null && i == start ? await ResumeStepAsync(st, step, path, inner, ct) : await StepAsync(st, step, path, ct);
            if (flow != Flow.Next) return flow;
        }
        return Flow.Next;
    }

    /// <summary>The step a run waits at goes on, or the list inside it the run was in.</summary>
    private async Task<Flow> ResumeStepAsync(RunState st, JsonObject step, string path, string inner, CancellationToken ct)
    {
        var kind = (string)step["kind"]!;
        if (inner.Length > 0)
        {
            var slash = inner.IndexOf('/');
            var l = int.Parse(slash < 0 ? inner : inner[..slash], System.Globalization.CultureInfo.InvariantCulture);
            var lists = AutomationRules.ChildLists(step).ToList();
            if (l >= lists.Count) return Flow.Next;
            return await ListAsync(st, lists[l], $"{path}/{l}", slash < 0 ? null : inner[(slash + 1)..], ct);
        }
        var record = st.Record(path, kind);
        return kind switch
        {
            "wait" => await WaitAgainAsync(st, step, path, record, ct),
            "approval" => await DecideAsync(st, step, path, record, ct),
            _ => Flow.Next,
        };
    }

    private async Task<Flow> StepAsync(RunState st, JsonObject step, string path, CancellationToken ct)
    {
        var db = Db;
        var run = st.Run;
        var kind = (string)step["kind"]!;
        var record = st.Record(path, kind);
        // A step's conditions read the row as the steps before it left it.
        if (run.RowId is { } rowId)
        {
            st.Row = (await RowStore.ByIdsAsync(db, [rowId], ct)).FirstOrDefault();
            if (st.Row is null)
            {
                (record.Status, record.Code) = ("failed", "row.gone");
                st.Reason = "row.gone";
                return Flow.Stop;
            }
        }
        var now = clock.GetUtcNow();
        var ctx = Context(st.Zone, now, run.ActorId);
        if (step["when"] is JsonObject when && st.Row is not null && !Query.Matches(st.Schema, st.Row, Raw.From(when), ctx))
        {
            record.Status = "skipped";
            return Flow.Next;
        }
        var member = st.Member;
        switch (kind)
        {
            case "wait":
                return await WaitAsync(st, step, path, record, ct);
            case "branch":
            {
                var paths = (JsonArray)step["branches"]!;
                var taken = paths.Count;
                for (var b = 0; b < paths.Count; b++)
                    if (st.Row is not null && paths[b]!["when"] is JsonObject condition && Query.Matches(st.Schema, st.Row, Raw.From(condition), ctx))
                    {
                        taken = b;
                        break;
                    }
                (record.Status, record.Detail) = ("done", taken < paths.Count ? $"path:{taken}" : "otherwise");
                var list = taken < paths.Count ? (JsonArray)paths[taken]!["steps"]! : (JsonArray)step["otherwise"]!;
                return await ListAsync(st, list, $"{path}/{taken}", null, ct);
            }
            case "approval":
                return await AskAsync(st, step, path, record, ct);
        }
        var (ok, code) = kind switch
        {
            "set" => await SetAsync(st, path, step, st.Row!, now, ct),
            "addRow" => await AddRowAsync(st, path, step, now, ct),
            "notify" => await NotifyAsync(st, path, step, record, ct),
            "webhook" => await WebhookAsync(st, path, step, ct),
            _ => (false, "step.kind"),
        };
        record.Status = ok ? (kind == "webhook" ? "queued" : "done") : "failed";
        record.Code = code;
        if (ok) return Flow.Next;
        st.Reason = code;
        // What its author can no longer do is told to them.
        if (code is Codes.AccessDenied or Codes.NotFound or "webhook.access") await TellAuthorAsync(run, st.Rule, code, ct);
        return Flow.Stop;
    }

    // Waits -----------------------------------------------------------------------------------------

    private static string Iso(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>When a wait for a date ends for the row as it is (null: it holds no date).</summary>
    private static DateTimeOffset? DueOf(RunState st, JsonObject until)
    {
        if (st.Row is null || st.Schema.Live((string)until["propertyId"]!) is not { } def) return null;
        var offset = (int)until["offsetMinutes"]!;
        if (def.Type == PropertyTypes.CreatedTime) return st.Row.CreatedAt is { } made ? AutomationTimes.Due(made, offset) : null;
        return st.Row.Values.GetValueOrDefault(def.Id) is DateValue date ? AutomationTimes.Due(date.Start, offset, (string?)until["at"], st.Zone) : null;
    }

    private bool Matches(RunState st, JsonObject conditions) =>
        st.Row is not null && Query.Matches(st.Schema, st.Row, Raw.From(conditions), Context(st.Zone, clock.GetUtcNow(), st.Run.ActorId));

    private static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;

    /// <summary>A wait reached: it ends at once when what it waits for is there, else the run keeps its place.</summary>
    private Task<Flow> WaitAsync(RunState st, JsonObject step, string path, StepRecord record, CancellationToken ct)
    {
        _ = ct;
        var now = clock.GetUtcNow();
        var until = (JsonObject)step["until"]!;
        var kind = (string)until["kind"]!;
        DateTimeOffset target;
        switch (kind)
        {
            case WaitKinds.Time:
                target = now.AddMinutes((int)until["minutes"]!);
                break;
            case WaitKinds.Date:
            {
                var due = DueOf(st, until);
                if (due is null || due <= now)
                {
                    (record.Status, record.Code) = ("done", due is null ? "wait.noDate" : null);
                    return Task.FromResult(Flow.Next);
                }
                target = Min(due.Value, now.AddMinutes(AutomationRules.MaxWaitMinutes));
                break;
            }
            case WaitKinds.Match:
                if (Matches(st, (JsonObject)until["conditions"]!))
                {
                    record.Status = "done";
                    return Task.FromResult(Flow.Next);
                }
                target = now.AddMinutes((int)until["minutes"]!);
                break;
            default:
                (record.Status, record.Code) = ("failed", "step.kind");
                st.Reason = "step.kind";
                return Task.FromResult(Flow.Stop);
        }
        (record.Status, record.Detail) = ("waiting", Iso(target));
        return Task.FromResult(st.Waits(path, kind, kind == WaitKinds.Time ? target : Min(target, now + Recheck), now));
    }

    /// <summary>A waiting run's wait looked at again: it ends, waits on, or has waited as long as it may.</summary>
    private Task<Flow> WaitAgainAsync(RunState st, JsonObject step, string path, StepRecord record, CancellationToken ct)
    {
        _ = ct;
        var now = clock.GetUtcNow();
        var waitedAt = st.Run.WaitedAt ?? now;
        var until = (JsonObject)step["until"]!;
        var kind = (string)until["kind"]!;
        Flow Done()
        {
            record.Status = "done";
            return Flow.Next;
        }
        Flow Expired()
        {
            (record.Status, record.Code) = ("failed", "wait.expired");
            st.Reason = "wait.expired";
            return Flow.Stop;
        }
        switch (kind)
        {
            case WaitKinds.Time:
            {
                var end = waitedAt.AddMinutes((int)until["minutes"]!);
                return Task.FromResult(now >= end ? Done() : st.Waits(path, kind, end, waitedAt));
            }
            case WaitKinds.Date:
            {
                var due = DueOf(st, until);
                if (due is null || due <= now) return Task.FromResult(Done());
                var limit = waitedAt.AddMinutes(AutomationRules.MaxWaitMinutes);
                if (now >= limit) return Task.FromResult(Expired());
                record.Detail = Iso(Min(due.Value, limit));
                return Task.FromResult(st.Waits(path, kind, Min(Min(due.Value, limit), now + Recheck), waitedAt));
            }
            case WaitKinds.Match:
            {
                if (Matches(st, (JsonObject)until["conditions"]!)) return Task.FromResult(Done());
                var limit = waitedAt.AddMinutes((int)until["minutes"]!);
                if (now >= limit) return Task.FromResult(Expired());
                return Task.FromResult(st.Waits(path, kind, Min(limit, now + Recheck), waitedAt));
            }
            default:
                return Task.FromResult(Done());
        }
    }

    // Approvals -------------------------------------------------------------------------------------

    /// <summary>The members a notice or an approval goes to: its people, its groups' and its person properties', those who can read its page.</summary>
    private async Task<(List<Member> Members, Guid Subject)> RecipientsAsync(RunState st, JsonObject step, CancellationToken ct)
    {
        var db = Db;
        var row = st.Row;
        var people = new HashSet<Guid>(((JsonArray)step["people"]!).Select(x => Guid.Parse((string)x!)));
        var groups = ((JsonArray)step["groups"]!).Select(x => Guid.Parse((string)x!)).ToList();
        if (groups.Count > 0)
            people.UnionWith(await db.WorkspaceGroupMembers.AsNoTracking().Where(g => groups.Contains(g.GroupId)).Select(g => g.UserId).ToListAsync(ct));
        var properties = ((JsonArray)step["personProperties"]!).Select(x => (string)x!).ToList();
        if (row is not null && properties.Count > 0)
        {
            var schema = DbSchema.Parse(st.Rule.DatabaseId, 0, await db.Databases.AsNoTracking().Where(d => d.PageId == st.Rule.DatabaseId).Select(d => d.Properties).FirstAsync(ct));
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
        // Only those who can read what it is about: the row, or the database for a schedule.
        var subject = row?.Id ?? st.Rule.DatabaseId;
        var members = await db.WorkspaceMembers.AsNoTracking().Where(m => people.Contains(m.UserId))
            .Select(m => new Member(m.WorkspaceId, m.UserId, m.Role)).ToListAsync(ct);
        var readers = new List<Member>();
        foreach (var member in members)
            if (await new Access(db).PageLevelAsync(member, subject) != Levels.None) readers.Add(member);
        return (readers, subject);
    }

    /// <summary>An approval reached: each person asked in their inbox (and by mail), the run waiting for their answers or its deadline.</summary>
    private async Task<Flow> AskAsync(RunState st, JsonObject step, string path, StepRecord record, CancellationToken ct)
    {
        var db = Db;
        var run = st.Run;
        var (asked, subject) = await RecipientsAsync(st, step, ct);
        if (asked.Count == 0)
        {
            // Nobody who could answer: its "no answer" path at once.
            (record.Status, record.Code) = (ApprovalOutcomes.NoAnswer, "approval.nobody");
            return await ListAsync(st, (JsonArray)step["noAnswer"]!, $"{path}/2", null, ct);
        }
        var now = clock.GetUtcNow();
        var deadline = now.AddMinutes((int)step["deadlineMinutes"]!);
        var mode = (string)step["mode"]!;
        var message = (string)step["message"]!;
        var excerpt = message.Length > 200 ? message[..200] : message;
        await LockedAsync(run.WorkspaceId, async changes =>
        {
            var known = await db.AutomationApprovals.Where(a => a.RunId == run.Id && a.StepPath == path).Select(a => a.UserId).ToListAsync(ct);
            var approvals = asked.Where(m => !known.Contains(m.UserId)).Select(m => new AutomationApproval
            {
                Id = Derived(run.StartedAt, run.Id, $"{path}:approval:{m.UserId:N}"),
                WorkspaceId = run.WorkspaceId,
                RunId = run.Id,
                AutomationId = st.Rule.Id,
                DatabaseId = st.Rule.DatabaseId,
                RowId = run.RowId,
                StepPath = path,
                UserId = m.UserId,
                Mode = mode,
                DeadlineAt = deadline,
                CreatedAt = now,
            }).ToList();
            db.AutomationApprovals.AddRange(approvals);
            await NotificationService.AddAsync(db, changes, approvals.Select(a => new Notification
            {
                Id = Derived(run.StartedAt, run.Id, $"{path}:ask:{a.UserId:N}"),
                WorkspaceId = run.WorkspaceId,
                UserId = a.UserId,
                Kind = NotificationKinds.Approval,
                PageId = subject,
                ActorUserId = run.AuthorId,
                Excerpt = excerpt,
                DedupeKey = $"approval:{run.Id:N}:{path}",
                AutomationId = st.Rule.Id,
                ApprovalId = a.Id,
                CreatedAt = now,
            }).ToList(), ct);
        }, ct);
        (record.Status, record.Detail, record.Count) = ("waiting", Iso(deadline), asked.Count);
        return st.Waits(path, WaitKinds.Approval, deadline, now);
    }

    /// <summary>
    /// A waiting approval looked at again: decided by the first answer (<c>any</c>), or by every
    /// one asked approving or one rejecting (<c>all</c>), or past its deadline with no decision by
    /// "no answer"; then its path for that outcome.
    /// </summary>
    private async Task<Flow> DecideAsync(RunState st, JsonObject step, string path, StepRecord record, CancellationToken ct)
    {
        var db = Db;
        var run = st.Run;
        var asked = await db.AutomationApprovals.AsNoTracking().Where(a => a.RunId == run.Id && a.StepPath == path).ToListAsync(ct);
        var now = clock.GetUtcNow();
        var answered = asked.Where(a => a.Answer is not null).OrderBy(a => a.AnsweredAt).ThenBy(a => a.Id).ToList();
        string? outcome = null;
        List<AutomationApproval> deciders = [];
        if ((string)step["mode"]! == "all")
        {
            var reject = answered.FirstOrDefault(a => a.Answer == ApprovalAnswers.Reject);
            if (reject is not null) (outcome, deciders) = (ApprovalOutcomes.Rejected, [reject]);
            else if (asked.Count > 0 && answered.Count == asked.Count) (outcome, deciders) = (ApprovalOutcomes.Approved, answered);
        }
        else if (answered.Count > 0)
            (outcome, deciders) = (answered[0].Answer == ApprovalAnswers.Approve ? ApprovalOutcomes.Approved : ApprovalOutcomes.Rejected, [answered[0]]);
        var deadline = asked.Count > 0 ? asked.Min(a => a.DeadlineAt) : now;
        if (outcome is null)
        {
            if (now < deadline) return st.Waits(path, WaitKinds.Approval, deadline, run.WaitedAt ?? now);
            outcome = ApprovalOutcomes.NoAnswer;
        }
        await LockedAsync(run.WorkspaceId, async changes =>
        {
            await db.AutomationApprovals.Where(a => a.RunId == run.Id && a.StepPath == path).ExecuteUpdateAsync(s => s.SetProperty(a => a.Outcome, outcome), ct);
            // Everyone asked sees the outcome in their inbox.
            foreach (var n in await db.Notifications.AsNoTracking().Where(n => n.Kind == NotificationKinds.Approval && n.DedupeKey == $"approval:{run.Id:N}:{path}")
                .Select(n => new { n.Id, n.UserId }).ToListAsync(ct))
                changes.Add("notification", n.Id, "upsert", 1, run.AuthorId, n.UserId);
        }, ct);
        st.Context = outcome == ApprovalOutcomes.NoAnswer
            ? []
            : new JsonObject
            {
                ["approver"] = new JsonArray([.. deciders.Select(d => (JsonNode)JsonValue.Create(d.UserId.ToString())!)]),
                ["comment"] = string.Join("\n", deciders.Select(d => d.Comment).Where(c => !string.IsNullOrWhiteSpace(c))),
            };
        (record.Status, record.Count) = (outcome, answered.Count);
        var l = outcome switch { ApprovalOutcomes.Approved => 0, ApprovalOutcomes.Rejected => 1, _ => 2 };
        return await ListAsync(st, AutomationRules.ChildLists(step).ElementAt(l), $"{path}/{l}", null, ct);
    }

    // The four Phase 15 steps -----------------------------------------------------------------------

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
    private static JsonNode? Resolve(JsonNode? value, PropertyDef? def, RunState st, DateTimeOffset now, out bool skip)
    {
        skip = false;
        var run = st.Run;
        if (value is JsonObject o && (string?)o["dynamic"] is { } dynamic)
        {
            switch (dynamic)
            {
                case "now":
                {
                    var days = o["days"] is JsonValue d ? d.GetValue<double>() : 0;
                    if (def is { IncludeTime: true })
                        return new JsonObject { ["start"] = now.AddDays(days).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture) };
                    var local = TimeZoneInfo.ConvertTime(now, st.Zone).Date.AddDays(days);
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
                // Phase 17: the last approval's answer.
                case "approver":
                    if (st.Context["approver"] is not JsonArray approver)
                    {
                        skip = true;
                        return null;
                    }
                    return approver.DeepClone();
                case "comment":
                    if (st.Context["comment"] is not JsonValue comment)
                    {
                        skip = true;
                        return null;
                    }
                    return comment.DeepClone();
            }
        }
        return value?.DeepClone();
    }

    private async Task<(bool, string?)> SetAsync(RunState st, string path, JsonObject step, RowData row, DateTimeOffset now, CancellationToken ct)
    {
        var run = st.Run;
        var member = st.Member;
        var values = new JsonObject();
        string? title = null;
        foreach (var (id, raw) in (JsonObject)step["values"]!)
        {
            var value = Resolve(raw, st.Schema.Live(id), st, now, out var skip);
            if (skip) continue;
            if (id == PropertyDef.TitleId) title = (string?)value ?? "";
            else values[id] = value;
        }
        if (values.Count > 0)
        {
            var result = await ApplyAsync(member, run, Op(Derived(run.StartedAt, run.Id, $"{path}:values"), "row.update", member.WorkspaceId, row.Id, new { values }, now), null, ct);
            if (result.Status != "applied") return (false, result.Error?.Code);
        }
        if (title is not null)
        {
            var result = await ApplyAsync(member, run, Op(Derived(run.StartedAt, run.Id, $"{path}:title"), "page.update", member.WorkspaceId, row.Id, new { title }, now), null, ct);
            if (result.Status != "applied") return (false, result.Error?.Code);
        }
        return (true, null);
    }

    private async Task<(bool, string?)> AddRowAsync(RunState st, string path, JsonObject step, DateTimeOffset now, CancellationToken ct)
    {
        var db = Db;
        var run = st.Run;
        var member = st.Member;
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
            var value = Resolve(raw, schema.Live(property), st, now, out var skip);
            if (skip) continue;
            if (property == PropertyDef.TitleId) title = (string?)value ?? "";
            else values[property] = value;
        }
        var id = Derived(run.StartedAt, run.Id, $"{path}:row");
        var last = await db.Pages.AsNoTracking().Where(p => p.ParentPageId == target && p.DeletedAt == null && p.Kind == PageKinds.Row)
            .Select(p => p.OrderKey).ToListAsync(ct);
        var orderKey = OrderKeys.Between(last.OrderBy(k => k, StringComparer.Ordinal).LastOrDefault(), null);
        (Guid, byte[], int)? first = null;
        if (template is { DocHeadSeq: > 0 })
        {
            // Its body, copied once, its block ids made now from the run (the same if taken again).
            var state = await states.LoadAsync(db, template, ct);
            var seed = SHA256.HashData(Encoding.UTF8.GetBytes($"{run.Id:N}:{path}:body"));
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
        var result = await ApplyAsync(member, run, Op(Derived(run.StartedAt, run.Id, $"{path}:create"), "page.create", member.WorkspaceId, id, payload, now), first, ct);
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

    private async Task<(bool, string?)> NotifyAsync(RunState st, string path, JsonObject step, StepRecord record, CancellationToken ct)
    {
        var db = Db;
        var run = st.Run;
        var rule = st.Rule;
        var (told, subject) = await RecipientsAsync(st, step, ct);
        var message = (string)step["message"]!;
        var excerpt = message.Length > 200 ? message[..200] : message;
        var now = clock.GetUtcNow();
        await LockedAsync(run.WorkspaceId, async changes => await NotificationService.AddAsync(db, changes, told.Select(m => new Notification
        {
            Id = Derived(run.StartedAt, run.Id, $"{path}:notice:{m.UserId:N}"),
            WorkspaceId = run.WorkspaceId,
            UserId = m.UserId,
            Kind = NotificationKinds.Automation,
            PageId = subject,
            ActorUserId = run.AuthorId,
            Excerpt = excerpt,
            DedupeKey = $"automation:{run.Id:N}:{path}",
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
        var member = await db.WorkspaceMembers.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == run.AuthorId, ct);
        if (member is null) return;
        await LockedAsync(run.WorkspaceId, async changes => await NotificationService.AddAsync(db, changes, [new Notification
        {
            Id = Derived(run.StartedAt, run.Id, "stopped"),
            WorkspaceId = run.WorkspaceId,
            UserId = run.AuthorId,
            Kind = NotificationKinds.Automation,
            // The database: its row may be what they can no longer read.
            PageId = rule.DatabaseId,
            ActorUserId = run.AuthorId,
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

    private async Task<(bool, string?)> WebhookAsync(RunState st, string path, JsonObject step, CancellationToken ct)
    {
        var db = Db;
        var run = st.Run;
        var member = st.Member;
        // Owners and admins only, at every run.
        if (!member.IsAdmin) return (false, "webhook.access");
        var webhookId = Guid.Parse((string)step["webhookId"]!);
        var hook = await db.Webhooks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == webhookId, ct);
        if (hook is null) return (false, "webhook.gone");
        // A delivery a step: its place among every step of the run (a top-level step's index before Phase 17).
        var index = st.Ordinals.GetValueOrDefault(path);
        if (await db.WebhookDeliveries.AnyAsync(d => d.RunId == run.Id && d.StepIndex == index, ct)) return (true, null);
        var deliveryId = Derived(run.StartedAt, run.Id, $"{path}:delivery");
        var body = await WebhookBodies.BodyAsync(db, member, run, st.Rule, st.Schema, st.Row, ((JsonArray)step["properties"]!).Select(x => (string)x!).ToList(), deliveryId, ct);
        db.WebhookDeliveries.Add(new WebhookDelivery
        {
            Id = deliveryId,
            WorkspaceId = st.Workspace.Id,
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
