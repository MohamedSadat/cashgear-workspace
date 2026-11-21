using System.Data;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 10's server budget (IMPLEMENTATION_PLAN.md, Phase 10, Performance benchmarks): retrieval
/// by meaning over 100,000 chunks in one workspace, p95 ≤ 300 ms apart from the provider's time to
/// embed the question (the mock's own time, measured by the provider's call, is taken off), warm
/// and after a change of a few pages; and the first search's load of the copy, tracked. In process,
/// through <see cref="MeaningSearch"/> as the route calls it, on SQL Server and the mock provider.
/// Runs only when PHASE10_BENCH is set (<c>pnpm server:test</c> skips it); build with <c>-c
/// Release</c>. Figures go into bench/results/phase10-server.json.
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase10Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE10_BENCH"));
    public const double BudgetMs = 300;
    private const string Question = "How can a buyer get reimbursed?";

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
    };

    [Fact]
    public async Task Retrieval_by_meaning_over_a_hundred_thousand_chunks()
    {
        Assert.SkipWhen(!Asked, "Set PHASE10_BENCH=1 (bench/phase10.mjs does)");
        var chunks = Setting("PHASE10_CHUNKS", 100_000);
        var perPage = Setting("PHASE10_CHUNKS_A_PAGE", 10);
        var runs = Setting("PHASE10_RUNS", 60);
        var pages = (chunks + perPage - 1) / perPage;
        var ws = await Ws.Create(server);
        var key = await EmbedKit.TurnOn(ws);
        var random = new Random(10);
        // The question's vector as the provider (the mock) gives it, so the chunks planted near it are found.
        var provider = server.Api.Services.GetRequiredService<IEmbeddingProvider>();
        var question = (await provider.EmbedAsync(new EmbeddingCall([Question], EmbeddingCall.Query, "voyage-4", key), CancellationToken.None)).Vectors[0];

        // The workspace's pages, then their vectors, written directly (the worker would take hours of provider calls).
        var ids = Enumerable.Range(0, pages).Select(_ => Guid.CreateVersion7()).ToList();
        var now = DateTimeOffset.UtcNow;
        await using (var db = server.NewDb(ws.Id))
        {
            foreach (var batch in ids.Chunk(2000))
            {
                db.Pages.AddRange(batch.Select((id, i) => new Page
                {
                    Id = id,
                    WorkspaceId = ws.Id,
                    SectionId = ws.Shared,
                    OrderKey = "a" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture),
                    Title = $"Bench page {i}",
                    SearchTitle = $"bench page {i}",
                    CreatedBy = ws.Account.Id,
                    UpdatedBy = ws.Account.Id,
                    CreatedAt = now,
                    UpdatedAt = now,
                }));
                await db.SaveChangesAsync();
                db.ChangeTracker.Clear();
            }
        }
        // About 1 % of the chunks near the question (so the permission walk has pages to read), the rest at random.
        byte[] Chunk(Random r) => MemoryMarshal.AsBytes<sbyte>(Vector(r, r.Next(100) == 0 ? question : null)).ToArray();
        var table = new DataTable();
        foreach (var (name, type) in new (string, Type)[] { ("WorkspaceId", typeof(byte[])), ("PageId", typeof(byte[])), ("Chunk", typeof(int)), ("Model", typeof(string)),
                     ("TextHash", typeof(byte[])), ("Vector", typeof(byte[])), ("TextVersion", typeof(long)), ("PageVersion", typeof(long)), ("CreatedAt", typeof(DateTimeOffset)) })
            table.Columns.Add(name, type);
        var workspaceBytes = GuidBytes.ToBytes(ws.Id);
        var written = 0;
        foreach (var page in ids)
            for (var c = 0; c < perPage && written < chunks; c++, written++)
                table.Rows.Add(workspaceBytes, GuidBytes.ToBytes(page), c, "voyage-4", new byte[32], Chunk(random), 1L, 1L, now);
        var loadStarted = Stopwatch.GetTimestamp();
        using (var bulk = new SqlBulkCopy(server.SqlConnection) { DestinationTableName = "PageEmbeddings", BatchSize = 10_000, BulkCopyTimeout = 600 })
        {
            foreach (DataColumn column in table.Columns) bulk.ColumnMappings.Add(column.ColumnName, column.ColumnName);
            await bulk.WriteToServerAsync(table);
        }
        var seedMs = Stopwatch.GetElapsedTime(loadStarted).TotalMilliseconds;

        // The copy loaded on the first search, then the route's whole path timed (the provider's own time
        // taken off), and the ranking alone.
        await using var scope = server.Api.Services.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<TenantScope>().Enter(ws.Id);
        var member = new Member(ws.Id, ws.Account.Id, Roles.Owner);
        var meaning = scope.ServiceProvider.GetRequiredService<MeaningSearch>();
        var cache = scope.ServiceProvider.GetRequiredService<EmbeddingsCache>();
        var db2 = scope.ServiceProvider.GetRequiredService<CgwDb>();
        cache.Drop(ws.Id);
        var settings = await db2.AiSettings.AsNoTracking().SingleAsync();

        var first = Stopwatch.GetTimestamp();
        var (ranked, timings, _) = await cache.RankAsync(db2, ws.Id, settings.EmbeddingsGeneration, "voyage-4", question, 0.3, CancellationToken.None);
        var firstMs = Stopwatch.GetElapsedTime(first).TotalMilliseconds;
        Assert.True(timings.Loaded);
        Assert.Equal(chunks, timings.Chunks);
        Assert.NotEmpty(ranked);

        var warm = new List<double>();
        var route = new List<double>();
        var providerMs = new List<double>();
        for (var i = 0; i < runs; i++)
        {
            var t = Stopwatch.GetTimestamp();
            var result = await meaning.SearchAsync(member, Question, 10, CancellationToken.None);
            var total = Stopwatch.GetElapsedTime(t).TotalMilliseconds;
            Assert.True(result.Ok, result.Failure?.Title);
            route.Add(total - result.Value!.ProviderTime.TotalMilliseconds);
            providerMs.Add(result.Value.ProviderTime.TotalMilliseconds);
            t = Stopwatch.GetTimestamp();
            var (hits, _, _) = await cache.RankAsync(db2, ws.Id, settings.EmbeddingsGeneration, "voyage-4", question, 0.3, CancellationToken.None);
            warm.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
            Assert.NotEmpty(hits);
        }

        // After a change of a few pages: their vectors written again (with their changes), then a search.
        var changed = new List<double>();
        for (var i = 0; i < Math.Max(10, runs / 3); i++)
        {
            await using (var db = server.NewDb(ws.Id))
            {
                var few = Enumerable.Range(0, 5).Select(_ => ids[random.Next(ids.Count)]).Distinct().ToList();
                await db.PageEmbeddings.Where(e => few.Contains(e.PageId)).ExecuteDeleteAsync();
                foreach (var page in few)
                {
                    for (var c = 0; c < perPage; c++)
                        db.PageEmbeddings.Add(new PageEmbedding { WorkspaceId = ws.Id, PageId = page, Chunk = c, Model = "voyage-4", TextHash = new byte[32], Vector = Chunk(random), TextVersion = 2, PageVersion = 2, CreatedAt = DateTimeOffset.UtcNow });
                    db.EmbeddingChanges.Add(new EmbeddingChange { WorkspaceId = ws.Id, PageId = page, CreatedAt = DateTimeOffset.UtcNow });
                }
                await db.SaveChangesAsync();
            }
            var t = Stopwatch.GetTimestamp();
            var result = await meaning.SearchAsync(member, Question, 10, CancellationToken.None);
            var total = Stopwatch.GetElapsedTime(t).TotalMilliseconds;
            Assert.True(result.Ok, result.Failure?.Title);
            Assert.False(result.Value!.Timings.Loaded);
            changed.Add(total - result.Value.ProviderTime.TotalMilliseconds);
        }

        var results = new JsonObject
        {
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
            ["chunks"] = chunks,
            ["pages"] = pages,
            ["seedMs"] = Math.Round(seedMs),
            ["budgetMs"] = BudgetMs,
            ["firstLoad"] = new JsonObject { ["ms"] = Math.Round(firstMs, 1), ["loadMs"] = Math.Round(timings.Sync.TotalMilliseconds, 1), ["scoreMs"] = Math.Round(timings.Score.TotalMilliseconds, 1) },
            ["warmRanking"] = Stats(warm),
            ["warm"] = Stats(route),
            ["afterChange"] = Stats(changed),
            ["providerMs"] = Stats(providerMs),
            ["at"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        var file = Path.Combine(server.Root, "bench", "results", "phase10-server.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        Assert.True(Percentile(route, 0.95) <= BudgetMs, $"warm p95 {Percentile(route, 0.95):0.0} ms");
        Assert.True(Percentile(changed, 0.95) <= BudgetMs, $"after a change p95 {Percentile(changed, 0.95):0.0} ms");
    }

    /// <summary>A random int8 vector, or one near <paramref name="near"/> (its values with a little noise).</summary>
    private static sbyte[] Vector(Random random, sbyte[]? near)
    {
        var vector = new sbyte[1024];
        for (var i = 0; i < vector.Length; i++)
            vector[i] = near is null ? (sbyte)random.Next(-40, 41) : (sbyte)Math.Clamp(near[i] + random.Next(-10, 11), -128, 127);
        return vector;
    }
}
