using System.Diagnostics;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 15's server budget (IMPLEMENTATION_PLAN.md, Phase 15, Performance benchmarks; bench/phase15.mjs
/// gates it): date triggers over a database of 50,000 rows found within 500 ms of the worker's time a
/// pass. A database of 50,000 rows with a date each (through the import route, every one in the
/// future), a date rule switched on, then the runner's passes, timed by the job itself
/// (<see cref="AutomationJob.PassReport.DateTime"/>: the dates' pass alone, the events' queue apart):
/// the first (every row's date read, the code not warm yet), passes with nothing changed, passes
/// after one row's date changed through the operations route (the rows written since read again: the
/// budget's figure for a database being edited), and passes after the rule was saved again (every
/// row's date read, as one is every ten minutes). Runs only when PHASE15_BENCH is set, so
/// <c>pnpm server:test</c> skips it; build it with <c>-c Release</c>. Figures go into
/// bench/results/phase15-server.json.
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase15Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE15_BENCH"));

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

    private void Record(JsonObject value)
    {
        var file = Path.Combine(server.Root, "bench", "results", "phase15-server.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        value["environment"] = new JsonObject
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
        value["at"] = DateTimeOffset.UtcNow.ToString("O");
        File.WriteAllText(file, value.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }

    [Fact]
    public async Task Date_triggers_over_fifty_thousand_rows_found_within_a_pass()
    {
        Assert.SkipWhen(!Asked, "Set PHASE15_BENCH=1 (bench/phase15.mjs does)");
        var count = Setting("PHASE15_ROWS", 50_000);
        var passes = Setting("PHASE15_PASSES", 20);
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Fifty thousand dates", [
            DatabaseTests.Prop("pWhen001", "date", "When", new JsonObject { ["date"] = new JsonObject { ["includeTime"] = false } }),
            DatabaseTests.Prop("pText001", "text", "Notes"),
        ]);
        // Every date in the year after next: none is reached while the bench runs.
        var random = new Random(15);
        var year = DateTimeOffset.UtcNow.Year + 2;
        var csv = new StringBuilder("Name,When\n");
        for (var i = 0; i < count; i++)
            csv.Append($"Task {i},{year}-{random.Next(1, 13):00}-{random.Next(1, 29):00}\n");
        var started = Stopwatch.GetTimestamp();
        var import = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import",
            new { csv = csv.ToString(), columns = new[] { "title", "pWhen001" }, header = true });
        var importMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        Assert.True(import.IsSuccessStatusCode, await import.Content.ReadAsStringAsync());
        Assert.Equal(count, (await Kit.Json(import)).GetProperty("created").GetInt64());

        // The rule, a day before each date, after the rows (as a person adds one to a database in use).
        var rule = Guid.CreateVersion7();
        JsonObject Rule() => AutomationTests.Rule(ws, rule, database,
            new JsonObject { ["kind"] = "date", ["propertyId"] = "pWhen001", ["offsetMinutes"] = -1440 },
            AutomationTests.SetNotes("due tomorrow"));
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, Rule())));
        var rows = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=50"))
            .GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("id").GetGuid()).ToList();

        var job = Kit.Job<AutomationJob>(server);
        async Task<AutomationJob.PassReport> Pass()
        {
            job.TimesNow();
            await server.RunJob<AutomationJob>(1);
            var report = job.LastPass!;
            Assert.True(report.DateRules >= 1);
            Assert.Equal(0, report.DueRows);
            return report;
        }

        // The first pass reads every row's date; then passes with nothing changed (the dates held).
        var first = (await Pass()).DateTime.TotalMilliseconds;
        var held = new List<double>();
        for (var i = 0; i < passes; i++) held.Add((await Pass()).DateTime.TotalMilliseconds);
        // A pass after a row's date changed reads the rows written since: the budget's figure,
        // after a few to warm the code (a worker that has run a while runs it optimised).
        var changed = new List<double>();
        for (var i = 0; i < passes + 3; i++)
        {
            var result = await DatabaseTests.RowUpdate(ws, rows[i % rows.Count],
                new { pWhen001 = new { start = $"{year}-{1 + i % 12:00}-{1 + i % 28:00}" } });
            Assert.Equal("applied", result.GetProperty("status").GetString());
            var ms = (await Pass()).DateTime.TotalMilliseconds;
            if (i >= 3) changed.Add(ms);
        }
        // A pass after the rule was saved again reads every row's date (as one does every
        // DateDueCache.FullEvery): every pass is in the budget, this one too.
        var full = new List<double>();
        var fullSql = new List<double>();
        for (var i = 0; i < Math.Max(4, passes / 2) + 2; i++)
        {
            Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, Rule())));
            var ms = (await Pass()).DateTime.TotalMilliseconds;
            if (i < 2) continue;
            full.Add(ms);
            Assert.True(job.Dues.LastRead is { Full: true }, "The rule saved again reads every date");
            fullSql.Add(job.Dues.LastRead!.Value.Sql.TotalMilliseconds);
        }
        Assert.Empty(await Kit.InWorker(server, ws.Id, (_, db) => db.AutomationRuns.Where(r => r.AutomationId == rule).ToListAsync()));

        Record(new JsonObject
        {
            ["rows"] = count,
            ["importMs"] = Math.Round(importMs),
            ["firstPassMs"] = Math.Round(first, 1),
            ["held"] = Stats(held),
            ["afterChange"] = Stats(changed),
            ["full"] = Stats(full),
            ["fullSql"] = Stats(fullSql),
        });
        Assert.True(Percentile(changed, 0.95) <= 500, $"A pass after a change took {Percentile(changed, 0.95):0.0} ms at p95");
        Assert.True(Percentile(full, 0.95) <= 500, $"A pass reading every date took {Percentile(full, 0.95):0.0} ms at p95");
    }
}
