using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 17's server budgets (IMPLEMENTATION_PLAN.md, Phase 17, Performance benchmarks;
/// bench/phase17.mjs gates them):
/// <list type="bullet">
/// <item>with 10,000 runs waiting, a pass of the worker finds those due within 200 ms: a rule that
/// waits a day, 10,000 of its runs written waiting (their waits ending over the next 30 days), then
/// passes with 50 made due each, the job's own time to take and read them (<see
/// cref="AutomationJob.PassReport.WaitsFindTime"/>) p95; passes with none due tracked;</item>
/// <item>10,000 reminders due in one minute, every one in the inbox within 60 s: 10,000 rows whose
/// date-times fall over the next 40 seconds, a reminder of each at its time for one of 20 members,
/// and the reminders' job run each second as the worker runs it; each one's lag from its moment to
/// its inbox entry, the largest gated;</item>
/// <item>the table with sub-items: 50,000 rows of which 10,000 are parents (four sub-items each),
/// the server's query nesting them (its first page) p95 within Phase 4's server query budget,
/// 300 ms (the browser's first rows are bench/phase17.mjs's).</item>
/// </list>
/// Rows come through the import route; the runs, the reminders and the sub-items' Parent values are
/// written straight into SQL (the bench seeds them as a long-used workspace holds them, faster than
/// 10,000 operations). Runs only when PHASE17_BENCH is set, so <c>pnpm server:test</c> skips it;
/// build it with <c>-c Release</c>. Figures go into bench/results/phase17-server.json.
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase17Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE17_BENCH"));

    private static int Setting(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

    private static double Percentile(IReadOnlyCollection<double> values, double p)
    {
        if (values.Count == 0) return 0;
        var sorted = values.Order().ToArray();
        return sorted[Math.Min(sorted.Length - 1, Math.Max(0, (int)Math.Ceiling(p * sorted.Length) - 1))];
    }

    private static JsonObject Stats(IReadOnlyCollection<double> ms) => new()
    {
        ["runs"] = ms.Count,
        ["p50"] = Math.Round(Percentile(ms, 0.5), 1),
        ["p95"] = Math.Round(Percentile(ms, 0.95), 1),
        ["max"] = ms.Count == 0 ? 0 : Math.Round(ms.Max(), 1),
        ["mean"] = ms.Count == 0 ? 0 : Math.Round(ms.Average(), 1),
    };

    private static readonly object Lock = new();

    /// <summary>Each figure merged into the one file (the three facts write their own part).</summary>
    private void Record(string part, JsonObject value)
    {
        var file = Path.Combine(server.Root, "bench", "results", "phase17-server.json");
        lock (Lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var all = File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file)) as JsonObject ?? [] : [];
            all[part] = value;
            all["environment"] = new JsonObject
            {
                ["os"] = RuntimeInformation.OSDescription,
                ["cores"] = Environment.ProcessorCount,
                ["sql"] = Environment.GetEnvironmentVariable("CGW_TEST_SQL") is { Length: > 0 } ? "CGW_TEST_SQL" : "LocalDB",
#if DEBUG
                ["build"] = "Debug",
#else
                ["build"] = "Release",
#endif
            };
            all["at"] = DateTimeOffset.UtcNow.ToString("O");
            File.WriteAllText(file, all.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        }
    }

    private static string Instant(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    private static async Task<int> Import(Ws ws, Guid database, string csv, string[] columns)
    {
        var import = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv, columns, header = true });
        Assert.True(import.IsSuccessStatusCode, await import.Content.ReadAsStringAsync());
        return (int)(await Kit.Json(import)).GetProperty("created").GetInt64();
    }

    [Fact]
    public async Task With_ten_thousand_runs_waiting_a_pass_finds_those_due_within_200_ms()
    {
        Assert.SkipWhen(!Asked, "Set PHASE17_BENCH=1 (bench/phase17.mjs does)");
        var count = Setting("PHASE17_WAITING", 10_000);
        var passes = Setting("PHASE17_PASSES", 20);
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Waiting", AutomationTests.Properties.DeepClone().AsArray());
        var rule = Guid.CreateVersion7();
        var steps = new JsonArray(
            new JsonObject { ["kind"] = "wait", ["until"] = new JsonObject { ["kind"] = "time", ["minutes"] = 1440 } },
            new JsonObject { ["kind"] = "set", ["values"] = new JsonObject { ["pText001"] = "a day on" } });
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, AutomationTests.Added, steps))));
        var row = (await DatabaseTests.NewRow(ws, database, "Waited on")).GetProperty("id").GetGuid();
        // The rule's runs, waiting: as many as the budget names, their waits ending over 30 days.
        var definition = await Kit.InWorker(server, ws.Id, (_, db) => db.Automations.Where(a => a.Id == rule).Select(a => a.Definition).SingleAsync());
        var now = DateTimeOffset.UtcNow;
        var random = new Random(17);
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            for (var start = 0; start < count; start += 2000)
            {
                for (var i = start; i < Math.Min(count, start + 2000); i++)
                    db.AutomationRuns.Add(new AutomationRun
                    {
                        Id = Guid.CreateVersion7(),
                        WorkspaceId = ws.Id,
                        AutomationId = rule,
                        DatabaseId = database,
                        RowId = row,
                        DueKey = $"bench:{i}",
                        Trigger = "rowAdded",
                        Depth = 1,
                        AuthorId = ws.Account.Id,
                        Status = RunStatuses.Waiting,
                        Steps = """[{"index":0,"path":"0","kind":"wait","status":"waiting"}]""",
                        StartedAt = now,
                        Definition = definition,
                        Place = "0",
                        WaitKind = WaitKinds.Time,
                        WaitedAt = now,
                        WaitUntil = now.AddMinutes(60 + random.Next(30 * 1440)),
                    });
                await db.SaveChangesAsync();
                db.ChangeTracker.Clear();
            }
            return 0;
        });
        var job = Kit.Job<AutomationJob>(server);
        async Task<AutomationJob.PassReport> Pass()
        {
            job.WaitsNow();
            await server.RunJob<AutomationJob>(1);
            return job.LastPass!;
        }
        // None due: tracked.
        var none = new List<double>();
        for (var i = 0; i < passes; i++) none.Add((await Pass()).WaitsFindTime.TotalMilliseconds);
        // Fifty made due before each pass: found, and gone on with (their time apart).
        var found = new List<double>();
        var gone = new List<double>();
        for (var i = 0; i < passes + 3; i++)
        {
            await Kit.InWorker(server, ws.Id, async (_, db) =>
            {
                var due = await db.AutomationRuns.Where(r => r.AutomationId == rule && r.Status == RunStatuses.Waiting)
                    .OrderBy(r => r.WaitUntil).Take(50).Select(r => r.Id).ToListAsync();
                // A day passed for them: their waits began a day ago and end now, so they go on.
                return await db.AutomationRuns.Where(r => due.Contains(r.Id)).ExecuteUpdateAsync(s => s
                    .SetProperty(r => r.WaitUntil, DateTimeOffset.UtcNow.AddSeconds(-1))
                    .SetProperty(r => r.WaitedAt, DateTimeOffset.UtcNow.AddDays(-1).AddMinutes(-1)));
            });
            var report = await Pass();
            Assert.Equal(50, report.Waits);
            if (i < 3) continue;
            found.Add(report.WaitsFindTime.TotalMilliseconds);
            gone.Add((report.WaitsTime - report.WaitsFindTime).TotalMilliseconds);
        }
        var waiting = await Kit.InWorker(server, ws.Id, (_, db) => db.AutomationRuns.CountAsync(r => r.AutomationId == rule && r.Status == RunStatuses.Waiting));
        Assert.Equal(count - 50 * (passes + 3), waiting);
        Record("waits", new JsonObject
        {
            ["waiting"] = count,
            ["stillWaiting"] = waiting,
            ["noneDue"] = Stats(none),
            ["found"] = Stats(found),
            ["goneOnWith50"] = Stats(gone),
        });
        Assert.True(Percentile(found, 0.95) <= 200, $"Finding the runs due took {Percentile(found, 0.95):0.0} ms at p95");
    }

    [Fact]
    public async Task Ten_thousand_reminders_due_in_a_minute_reach_the_inbox_within_sixty_seconds()
    {
        Assert.SkipWhen(!Asked, "Set PHASE17_BENCH=1 (bench/phase17.mjs does)");
        var count = Setting("PHASE17_REMINDERS", 10_000);
        var people = Setting("PHASE17_PEOPLE", 20);
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Reminded", [
            DatabaseTests.Prop("pWhen001", "date", "When", new JsonObject { ["date"] = new JsonObject { ["includeTime"] = true } }),
        ]);
        var members = new List<Guid> { ws.Account.Id };
        for (var i = 1; i < people; i++) members.Add((await Kit.Join(server, ws, "member")).Id);
        // The rows' moments over 40 seconds, from 30 seconds after the seeding starts.
        var first = DateTimeOffset.UtcNow.AddSeconds(30 + count / 1000.0);
        var csv = new StringBuilder("Name,When\n");
        var moments = new DateTimeOffset[count];
        for (var i = 0; i < count; i++)
        {
            moments[i] = DateTimeOffset.FromUnixTimeSeconds(first.ToUnixTimeSeconds() + i * 40L / count);
            csv.Append(CultureInfo.InvariantCulture, $"Due {i},{Instant(moments[i])}\n");
        }
        Assert.Equal(count, await Import(ws, database, csv.ToString(), ["title", "pWhen001"]));
        var rows = (await Kit.InWorker(server, ws.Id, (_, db) => db.Pages.Where(p => p.ParentPageId == database && !p.IsTemplate)
            .Select(p => new { p.Id, p.Title }).ToListAsync())).ToDictionary(p => p.Title, p => p.Id);
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            for (var i = 0; i < count; i++)
                db.RowReminders.Add(new RowReminder
                {
                    Id = Guid.CreateVersion7(),
                    WorkspaceId = ws.Id,
                    DatabaseId = database,
                    RowId = rows[$"Due {i}"],
                    PropertyId = "pWhen001",
                    UserId = members[i % members.Count],
                    BeforeMinutes = 0,
                    DueAt = moments[i],
                    CreatedAt = DateTimeOffset.UtcNow,
                });
            await db.SaveChangesAsync();
            await db.Databases.Where(d => d.PageId == database).ExecuteUpdateAsync(s => s.SetProperty(d => d.Reminders, count));
            return 0;
        });
        Assert.True(DateTimeOffset.UtcNow < moments[0], "The seeding took longer than the moments' start");

        // The reminders' job each second, as the worker runs it, until every one is sent.
        var last = moments[^1];
        while (DateTimeOffset.UtcNow < last.AddSeconds(90))
        {
            await server.RunJob<ReminderJob>(20);
            var left = await Kit.InWorker(server, ws.Id, (_, db) => db.RowReminders.CountAsync(r => r.DatabaseId == database && (r.SentFor == null || r.SentFor != r.DueAt)));
            if (left == 0) break;
            await Task.Delay(1000);
        }
        var sent = await Kit.InWorker(server, ws.Id, (_, db) => db.Notifications.Where(n => n.Kind == NotificationKinds.Reminder && n.WorkspaceId == ws.Id)
            .Select(n => new { n.PageId, n.UserId, n.CreatedAt }).ToListAsync());
        Assert.Equal(count, sent.Count);
        var byRow = Enumerable.Range(0, count).ToDictionary(i => rows[$"Due {i}"], i => moments[i]);
        var lags = sent.Select(n => (n.CreatedAt - byRow[n.PageId]).TotalSeconds).ToList();
        Record("reminders", new JsonObject
        {
            ["reminders"] = count,
            ["people"] = members.Count,
            ["inboxed"] = sent.Count,
            ["lagSeconds"] = Stats(lags),
            ["spanSeconds"] = Math.Round((last - moments[0]).TotalSeconds, 1),
        });
        Assert.True(lags.Max() <= 60, $"A reminder reached the inbox {lags.Max():0.0} s after its time");
        Assert.True(lags.Min() >= 0, "A reminder was sent before its time");
    }

    [Fact]
    public async Task A_table_of_fifty_thousand_rows_with_ten_thousand_parents_answers_its_tree_within_300_ms()
    {
        Assert.SkipWhen(!Asked, "Set PHASE17_BENCH=1 (bench/phase17.mjs does)");
        var count = Setting("PHASE17_ROWS", 50_000);
        var parents = count / 5;
        var runs = Setting("PHASE17_QUERY_RUNS", 20);
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Fifty thousand tasks", new JsonArray(DatabaseTests.Prop("pNum0001", "number", "Points")));
        JsonObject Relation(string id, string name, string reverse, string role) => DatabaseTests.Prop(id, "relation", name, new JsonObject
        {
            ["relation"] = new JsonObject { ["databaseId"] = database.ToString(), ["reversePropertyId"] = reverse, ["role"] = role },
        });
        Assert.Equal("applied", (await DatabaseTests.DbUpdate(ws, database,
            [Relation("pPrnt001", "Parent", "pSubs001", "parent"), Relation("pSubs001", "Sub-items", "pPrnt001", "subItems")])).GetProperty("status").GetString());
        var csv = new StringBuilder("Name,Points\n");
        for (var i = 0; i < count; i++) csv.Append(CultureInfo.InvariantCulture, $"Task {i:00000},{i % 100}\n");
        var started = Stopwatch.GetTimestamp();
        Assert.Equal(count, await Import(ws, database, csv.ToString(), ["title", "pNum0001"]));
        var importMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        // Rows after the first fifth are sub-items, four to each parent, by their Parent value.
        var rows = (await Kit.InWorker(server, ws.Id, (_, db) => db.Pages.Where(p => p.ParentPageId == database && !p.IsTemplate)
            .Select(p => new { p.Id, p.Title }).ToListAsync())).OrderBy(p => p.Title, StringComparer.Ordinal).Select(p => p.Id).ToList();
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            var values = new JsonArray();
            for (var i = parents; i < rows.Count; i++)
                values.Add(new JsonObject { ["i"] = Convert.ToHexString(GuidBytes.ToBytes(rows[i])), ["p"] = rows[(i - parents) % parents].ToString() });
            // Stamped past the database's rows version, so the rows' cache reads them again as after any write.
            await db.Database.ExecuteSqlRawAsync("""
                DECLARE @v bigint = (SELECT [RowsVersion] + 1 FROM [Databases] WHERE [PageId] = @db);
                UPDATE r SET r.[Values] = JSON_MODIFY(r.[Values], '$."pPrnt001"', JSON_QUERY(CONCAT('["', j.p, '"]'))), r.[Seq] = @v
                FROM [DatabaseRows] r JOIN OPENJSON(@json) WITH (i varchar(32), p varchar(36)) j ON r.[PageId] = CONVERT(binary(16), j.i, 2);
                UPDATE [Databases] SET [RowsVersion] = @v WHERE [PageId] = @db;
                """, new Microsoft.Data.SqlClient.SqlParameter("@json", values.ToJsonString()),
                new Microsoft.Data.SqlClient.SqlParameter("@db", GuidBytes.ToBytes(database)));
            return 0;
        });

        async Task<(double Ms, JsonElement Answer)> Query()
        {
            var at = Stopwatch.GetTimestamp();
            var response = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/query", new
            {
                tree = "pPrnt001", sorts = Array.Empty<object>(), group = (object?)null, limit = 100,
                context = new { today = "2026-03-01", offsetMinutes = 0, me = (string?)null },
            });
            var ms = Stopwatch.GetElapsedTime(at).TotalMilliseconds;
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            return (ms, await Kit.Json(response));
        }
        var (coldMs, cold) = await Query();
        Assert.Equal(100, cold.GetProperty("rows").GetArrayLength());
        Assert.Equal(4, cold.GetProperty("tree")[0].GetProperty("children").GetInt32());
        Assert.Equal(1, cold.GetProperty("tree")[1].GetProperty("depth").GetInt32());
        var warm = new List<double>();
        for (var i = 0; i < runs + 3; i++)
        {
            var (ms, _) = await Query();
            if (i >= 3) warm.Add(ms);
        }
        Record("tree", new JsonObject
        {
            ["rows"] = count,
            ["parents"] = parents,
            ["importMs"] = Math.Round(importMs),
            ["coldMs"] = Math.Round(coldMs, 1),
            ["query"] = Stats(warm),
        });
        Assert.True(Percentile(warm, 0.95) <= 300, $"The tree's first page took {Percentile(warm, 0.95):0.0} ms at p95");
    }
}
