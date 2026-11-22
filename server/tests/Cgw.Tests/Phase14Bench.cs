using System.Diagnostics;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sharing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 14's server budget (bench/phase14.mjs gates it): a site's or share link's check of a file
/// in a database of 50,000 rows holding 100,000 files, p95 ≤ 20 ms, by the index of rows' files; and,
/// beside it for comparison, 0.13.0's scan of the rows' values (<c>Values LIKE '%id%'</c>). Runs only
/// when PHASE14_BENCH is set; build with <c>-c Release</c>. Figures go into bench/results/phase14-server.json.
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase14Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE14_BENCH"));

    private static int Setting(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

    private static double Percentile(IReadOnlyCollection<double> values, double p)
    {
        var sorted = values.Order().ToArray();
        return sorted.Length == 0 ? 0 : sorted[Math.Min(sorted.Length - 1, Math.Max(0, (int)Math.Ceiling(p * sorted.Length) - 1))];
    }

    private static JsonObject Stats(IReadOnlyCollection<double> ms) => new()
    {
        ["runs"] = ms.Count,
        ["p50"] = Math.Round(Percentile(ms, 0.5), 2),
        ["p95"] = Math.Round(Percentile(ms, 0.95), 2),
        ["max"] = ms.Count == 0 ? 0 : Math.Round(ms.Max(), 2),
    };

    [Fact]
    public async Task A_file_check_in_a_database_of_fifty_thousand_rows_by_the_index()
    {
        Assert.SkipWhen(!Asked, "Set PHASE14_BENCH=1 (bench/phase14.mjs does)");
        var count = Setting("PHASE14_ROWS", 50_000);
        var runs = Setting("PHASE14_RUNS", 300);
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Site")).GetProperty("id").GetGuid();
        var database = await DatabaseTests.NewDatabase(ws, "Attachments", [
            DatabaseTests.Prop("pFil0001", "files", "Files"),
            DatabaseTests.Prop("pText001", "text", "Notes"),
        ], parent: root);
        var csv = new StringBuilder("Name,Notes\n");
        for (var i = 0; i < count; i++) csv.Append($"Row {i},note {i % 1000}\n");
        var import = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import",
            new { csv = csv.ToString(), columns = new[] { "title", "pText001" }, header = true });
        Assert.True(import.IsSuccessStatusCode, await import.Content.ReadAsStringAsync());

        // Two files a row, written as the server writes values, the index beside them.
        var files = new List<Guid>(count * 2);
        await using (var db = server.NewDb(ws.Id))
        {
            var rows = await db.DatabaseRows.AsNoTracking().Where(r => r.DatabaseId == database).Select(r => new { r.PageId, r.Values }).ToListAsync();
            var schema = DatabaseService.SchemaOf(await db.Databases.AsNoTracking().SingleAsync(d => d.PageId == database));
            var writes = new List<RowStore.Write>(rows.Count);
            var entries = new List<RowFiles.Entry>(rows.Count);
            foreach (var row in rows)
            {
                var values = ValueJson.ReadMap(row.Values);
                Guid a = Guid.CreateVersion7(), b = Guid.CreateVersion7();
                files.Add(a);
                files.Add(b);
                values["pFil0001"] = new[] { a.ToString(), b.ToString() };
                writes.Add(new RowStore.Write(row.PageId, Values: ValueJson.WriteMap(values)));
                entries.Add(new RowFiles.Entry(row.PageId, RowFiles.Of(schema, values)));
            }
            await using var tx = await db.Database.BeginTransactionAsync();
            await RowStore.WriteAsync(db, writes, 1, CancellationToken.None);
            await RowFiles.ReplaceAsync(db, ws.Id, database, entries, CancellationToken.None);
            await tx.CommitAsync();
        }

        await using var scope = server.Api.Services.CreateAsyncScope();
        var sql = scope.ServiceProvider.GetRequiredService<CgwDb>();
        sql.Scope.Enter(ws.Id);
        var pages = await scope.ServiceProvider.GetRequiredService<SharedReader>().ScopeAsync(root);
        Assert.NotNull(pages);
        var shared = scope.ServiceProvider.GetRequiredService<SharedDatabases>();
        var random = new Random(14);
        // Warm: the JIT and the plan.
        for (var i = 0; i < 20; i++) Assert.True(await shared.ShowsFileAsync(pages!, files[random.Next(files.Count)]));
        var index = new List<double>(runs);
        for (var i = 0; i < runs; i++)
        {
            var asset = files[random.Next(files.Count)];
            var started = Stopwatch.GetTimestamp();
            Assert.True(await shared.ShowsFileAsync(pages!, asset));
            index.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
        var misses = new List<double>(runs / 3);
        for (var i = 0; i < runs / 3; i++)
        {
            var started = Stopwatch.GetTimestamp();
            Assert.False(await shared.ShowsFileAsync(pages!, Guid.CreateVersion7()));
            misses.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
        // 0.13.0's way, for comparison: the rows whose values hold the id's text.
        var scan = new List<double>();
        for (var i = 0; i < 12; i++)
        {
            var text = files[random.Next(files.Count)].ToString();
            var started = Stopwatch.GetTimestamp();
            var found = await sql.DatabaseRows.AsNoTracking().Where(r => r.DatabaseId == database && r.Values.Contains(text))
                .Join(sql.Pages.Where(p => p.DeletedAt == null && p.TrashedAt == null && !p.IsTemplate), r => r.PageId, p => p.Id, (r, p) => new { r.PageId, r.Values })
                .OrderBy(r => r.PageId).Take(50).ToListAsync();
            scan.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            Assert.Single(found);
        }

        var file = Path.Combine(server.Root, "bench", "results", "phase14-server.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var results = new JsonObject
        {
            ["at"] = DateTimeOffset.UtcNow.ToString("O"),
            ["environment"] = new JsonObject
            {
                ["os"] = RuntimeInformation.OSDescription,
                ["cores"] = Environment.ProcessorCount,
                ["sql"] = Environment.GetEnvironmentVariable("CGW_TEST_SQL") is { Length: > 0 } ? "CGW_TEST_SQL" : "LocalDB",
#if DEBUG
                ["build"] = "Debug",
#else
                ["build"] = "Release",
#endif
            },
            ["rows"] = count,
            ["files"] = files.Count,
            ["fileCheck"] = Stats(index),
            ["fileCheckMiss"] = Stats(misses),
            ["scan"] = Stats(scan),
        };
        File.WriteAllText(file, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }
}
