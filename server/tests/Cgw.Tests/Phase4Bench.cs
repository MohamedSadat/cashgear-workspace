using System.Diagnostics;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 4's server budgets (contract section 7; bench/phase4.mjs gates them): the server query
/// at 50,000 rows with one filter and one sort (p95 ≤ 300 ms), the first page of a 50,000-row
/// database, and an import of 50,000 rows, measured in process through the real API on SQL Server.
/// They run only when PHASE4_BENCH is set, so <c>pnpm server:test</c> skips them; build them with
/// <c>-c Release</c>. Figures go into bench/results/phase4-server.json.
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase4Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE4_BENCH"));
    private static readonly Lock ResultsGate = new();

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

    private static double Ms(long started) => Stopwatch.GetElapsedTime(started).TotalMilliseconds;

    private void Record(string section, JsonNode value)
    {
        lock (ResultsGate)
        {
            var file = Path.Combine(server.Root, "bench", "results", "phase4-server.json");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var results = File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file))!.AsObject() : new JsonObject();
            results["environment"] = new JsonObject
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
            results[section] = value;
            results["at"] = DateTimeOffset.UtcNow.ToString("O");
            File.WriteAllText(file, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        }
    }

    [Fact]
    public async Task Fifty_thousand_rows_imported_queried_and_paged()
    {
        Assert.SkipWhen(!Asked, "Set PHASE4_BENCH=1 (bench/phase4.mjs does)");
        var count = Setting("PHASE4_ROWS", 50_000);
        var runs = Setting("PHASE4_QUERY_RUNS", 60);
        var ws = await Ws.Create(server);
        var stages = new JsonArray(new[] { "Backlog", "Planned", "Doing", "Review", "Done" }
            .Select((name, i) => (JsonNode?)new JsonObject { ["id"] = $"optStg0{i}", ["name"] = name, ["colour"] = "default" }).ToArray());
        var database = await DatabaseTests.NewDatabase(ws, "Fifty thousand", [
            DatabaseTests.Prop("pNum0001", "number", "Amount"),
            DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = stages }),
            DatabaseTests.Prop("pDate001", "date", "Due", new JsonObject { ["date"] = new JsonObject { ["includeTime"] = false } }),
            DatabaseTests.Prop("pText001", "text", "Notes"),
        ]);
        var random = new Random(4);
        var csv = new StringBuilder("Name,Amount,Stage,Due,Notes\n");
        var names = new[] { "Backlog", "Planned", "Doing", "Review", "Done" };
        for (var i = 0; i < count; i++)
            csv.Append($"Task {i},{random.Next(0, 100_000)},{names[random.Next(5)]},2026-{random.Next(1, 13):00}-{random.Next(1, 29):00},note {random.Next(1000)}\n");

        // Import: 50,000 rows in batches, each its own transaction.
        var started = Stopwatch.GetTimestamp();
        var import = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import",
            new { csv = csv.ToString(), columns = new[] { "title", "pNum0001", "pSel0001", "pDate001", "pText001" }, header = true });
        var importMs = Ms(started);
        Assert.True(import.IsSuccessStatusCode, await import.Content.ReadAsStringAsync());
        Assert.Equal(count, (await Kit.Json(import)).GetProperty("created").GetInt64());
        Record("import", new JsonObject { ["rows"] = count, ["ms"] = Math.Round(importMs, 1), ["rowsPerSecond"] = Math.Round(count / importMs * 1000) });

        var context = new { today = "2026-03-01", offsetMinutes = 0 };
        async Task<double> Query(object body)
        {
            var t = Stopwatch.GetTimestamp();
            var response = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/query", body);
            var ms = Ms(t);
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            return ms;
        }

        // The first page of the database (no filter): cold (the cache reads every row), then warm.
        var cold = await Query(new { context, limit = 100 });
        var warm = new List<double>();
        for (var i = 0; i < runs; i++) warm.Add(await Query(new { context, limit = 100 }));
        var fetch = new List<double>();
        for (var i = 0; i < 10; i++)
        {
            var t = Stopwatch.GetTimestamp();
            var rows = await ws.Client.GetAsync($"/api/v1/databases/{database}/rows?limit=500");
            fetch.Add(Ms(t));
            Assert.True(rows.IsSuccessStatusCode);
        }
        Record("firstPage", new JsonObject { ["coldMs"] = Math.Round(cold, 1), ["query"] = Stats(warm), ["rowsRoute500"] = Stats(fetch) });

        // One filter and one sort, a different threshold each time: the budget's figure, after a
        // few queries to warm the code (a server answering queries runs it optimised).
        for (var i = 0; i < 6; i++)
            await Query(new { filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pNum0001", @operator = "lt", value = i } } }, sorts = new[] { new { propertyId = i % 2 == 0 ? "pDate001" : "title", direction = "asc" } }, context, limit = 100 });
        var measured = new List<double>();
        for (var i = 0; i < runs; i++)
        {
            var filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pNum0001", @operator = "ge", value = random.Next(0, 90_000) } } };
            var sorts = new[] { new { propertyId = i % 2 == 0 ? "pDate001" : "title", direction = i % 3 == 0 ? "desc" : "asc" } };
            measured.Add(await Query(new { filter, sorts, context, limit = 100 }));
        }
        var slowest = new JsonArray(measured.Select((ms, i) => (ms, i)).OrderByDescending(x => x.ms).Take(5)
            .Select(x => (JsonNode?)new JsonObject { ["run"] = x.i, ["ms"] = Math.Round(x.ms, 1), ["sort"] = x.i % 2 == 0 ? "date" : "title" }).ToArray());
        // The engine alone (no HTTP, no SQL): the cached rows through the C# queryRows.
        var engine = new List<double>();
        var parts = new JsonObject();
        await using (var scratch = server.NewDb(ws.Id))
        {
            var record = await scratch.Databases.AsNoTracking().SingleAsync(d => d.PageId == database);
            var schema = Cgw.Core.Databases.Schema.Parse(record.PageId, record.Version, record.Properties);
            var snapshot = await new Cgw.Core.Databases.DatabaseRowCache(new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build()).RowsAsync(scratch, record, CancellationToken.None);
            var ctx = new Cgw.Core.Databases.QueryContext("2026-03-01", 0, null, null);
            for (var i = 0; i < runs; i++)
            {
                var spec = new Cgw.Core.Databases.QuerySpec
                {
                    Filter = Cgw.Core.Databases.Raw.From(JsonSerializer.SerializeToElement(new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pNum0001", @operator = "ge", value = random.Next(0, 90_000) } } })),
                    Sorts = [new Cgw.Core.Databases.SortRule(i % 2 == 0 ? "pDate001" : "title", i % 3 == 0 ? "desc" : "asc")],
                };
                var t = Stopwatch.GetTimestamp();
                Cgw.Core.Databases.Query.Run(schema, snapshot.Rows.Values, spec, ctx);
                engine.Add(Ms(t));
            }
            var none = new Cgw.Core.Databases.QuerySpec();
            var t0 = Stopwatch.GetTimestamp();
            Cgw.Core.Databases.Query.Run(schema, snapshot.Rows.Values, none, ctx);
            parts["noFilterNoSortMs"] = Math.Round(Ms(t0), 1);
        }

        // The same after an edit each time: the cache reads only the rows written since.
        var someRow = (await Kit.Json(await ws.Client.GetAsync($"/api/v1/databases/{database}/rows?limit=1"))).GetProperty("rows")[0].GetProperty("id").GetGuid();
        var afterEdit = new List<double>();
        for (var i = 0; i < Math.Min(runs, 20); i++)
        {
            await ws.Push(ws.Op("row.update", someRow, new { values = new { pNum0001 = i } }));
            var filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pSel0001", @operator = "is", value = "optStg02" } } };
            afterEdit.Add(await Query(new { filter, sorts = new[] { new { propertyId = "pNum0001", direction = "desc" } }, context, limit = 100 }));
        }
        // Grouped (a board): counts over the filtered rows and the first page of one group.
        var grouped = new List<double>();
        for (var i = 0; i < Math.Min(runs, 20); i++)
            grouped.Add(await Query(new { group = new { propertyId = "pSel0001" }, groupKey = $"optStg0{i % 5}", sorts = new[] { new { propertyId = "pNum0001", direction = "asc" } }, context, limit = 50 }));
        Record("query", new JsonObject
        {
            ["rows"] = count,
            ["filterAndSort"] = Stats(measured),
            ["slowest"] = slowest,
            ["engineOnly"] = Stats(engine),
            ["engineParts"] = parts,
            ["gcCollections"] = new JsonObject { ["gen0"] = GC.CollectionCount(0), ["gen1"] = GC.CollectionCount(1), ["gen2"] = GC.CollectionCount(2) },
            ["afterAnEdit"] = Stats(afterEdit),
            ["groupedPage"] = Stats(grouped),
            ["budgetP95"] = 300,
        });

        // The feed and the tree stay as cheap with 50,000 rows in the workspace: rows are not in
        // Access.AllLevelsAsync (the filtered index), so the tree reads pages and databases only.
        var tree = new List<double>();
        for (var i = 0; i < 10; i++)
        {
            var t = Stopwatch.GetTimestamp();
            await ws.Tree();
            tree.Add(Ms(t));
        }
        Record("treeWith50000Rows", Stats(tree));
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(count, (await db.Databases.SingleAsync(d => d.PageId == database)).RowCount);
    }
}
