using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 13's server budget (IMPLEMENTATION_PLAN.md, Phase 13, Performance benchmarks): retrieval by
/// meaning over 1,000,000 chunks in one workspace, p95 ≤ 300 ms less the provider's time, through
/// <see cref="MeaningSearch"/> as the route calls it (the approximate index: past 200,000 chunks), warm
/// and after a change of five pages; and the acceptance's recall: at least 0.95 of the exact search's
/// first ten pages, over questions near the seeded topics. The first load, the exact ranking's time
/// and the copy's memory are tracked. Vectors are clustered as real embeddings are
/// (<see cref="VectorKit"/>). Runs only when PHASE13_BENCH is set; build with <c>-c Release</c>.
/// Figures go into bench/results/phase13-server.json.
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase13Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE13_BENCH"));
    public const double BudgetMs = 300;
    public const double RecallFloor = 0.95;
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
    public async Task Retrieval_by_meaning_over_a_million_chunks_and_its_recall()
    {
        Assert.SkipWhen(!Asked, "Set PHASE13_BENCH=1 (bench/phase13.mjs does)");
        var chunks = Setting("PHASE13_CHUNKS", 1_000_000);
        var perPage = Setting("PHASE13_CHUNKS_A_PAGE", 10);
        var runs = Setting("PHASE13_RUNS", 60);
        var questions = Setting("PHASE13_QUESTIONS", 50);
        var ws = await Ws.Create(server);
        await EmbedKit.TurnOn(ws);
        var kit = new VectorKit(13, topics: Setting("PHASE13_TOPICS", 400), subtopicsEach: 10);
        var seeded = Stopwatch.GetTimestamp();
        var ids = await kit.SeedAsync(server, ws, chunks, perPage);
        var seedMs = Stopwatch.GetElapsedTime(seeded).TotalMilliseconds;

        await using var scope = server.Api.Services.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<TenantScope>().Enter(ws.Id);
        var member = new Member(ws.Id, ws.Account.Id, Roles.Owner);
        var meaning = scope.ServiceProvider.GetRequiredService<MeaningSearch>();
        var cache = scope.ServiceProvider.GetRequiredService<EmbeddingsCache>();
        var options = scope.ServiceProvider.GetRequiredService<EmbeddingsOptions>();
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        cache.Drop(ws.Id);
        var generation = (await db.AiSettings.AsNoTracking().SingleAsync()).EmbeddingsGeneration;

        // The first search loads the copy.
        var first = Stopwatch.GetTimestamp();
        var loaded = await cache.RankAsync(db, ws.Id, generation, "voyage-4", kit.Question(0), 0.3, CancellationToken.None);
        var firstMs = Stopwatch.GetElapsedTime(first).TotalMilliseconds;
        Assert.True(loaded.Timings.Loaded);
        Assert.True(loaded.Timings.Approximate);
        Assert.Equal(chunks, loaded.Timings.Chunks);
        var copyBytes = cache.Bytes;

        // Recall: the approximate ranking's first ten pages against the exact one's, near the topics.
        var recalls = new List<double>();
        var exactMs = new List<double>();
        var nearMs = new List<double>();
        for (var q = 0; q < questions; q++)
        {
            var question = kit.Question(kit.NextSubtopic());
            var t = Stopwatch.GetTimestamp();
            var exact = await cache.RankAsync(db, ws.Id, generation, "voyage-4", question, 0.0, CancellationToken.None, candidates: int.MaxValue);
            exactMs.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
            t = Stopwatch.GetTimestamp();
            var near = await cache.RankAsync(db, ws.Id, generation, "voyage-4", question, 0.0, CancellationToken.None);
            nearMs.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
            recalls.Add(VectorKit.Recall(exact.Ranked.Select(c => c.PageId).ToList(), near.Ranked.Select(c => c.PageId).ToList()));
        }

        // The route's whole path, warm, the provider's own time taken off.
        var route = new List<double>();
        var providerMs = new List<double>();
        var approximate = 0;
        for (var i = 0; i < runs; i++)
        {
            var t = Stopwatch.GetTimestamp();
            var result = await meaning.SearchAsync(member, Question, 10, CancellationToken.None);
            var total = Stopwatch.GetElapsedTime(t).TotalMilliseconds;
            Assert.True(result.Ok, result.Failure?.Title);
            route.Add(total - result.Value!.ProviderTime.TotalMilliseconds);
            providerMs.Add(result.Value.ProviderTime.TotalMilliseconds);
            if (result.Value.Timings.Approximate) approximate++;
        }

        // After a change of five pages: their vectors written again (with their changes), then a search.
        var random = new Random(31);
        var changed = new List<double>();
        for (var i = 0; i < Math.Max(10, runs / 3); i++)
        {
            await using (var write = server.NewDb(ws.Id))
            {
                var few = Enumerable.Range(0, 5).Select(_ => ids[random.Next(ids.Count)]).Distinct().ToList();
                await write.PageEmbeddings.Where(e => few.Contains(e.PageId)).ExecuteDeleteAsync();
                foreach (var page in few)
                {
                    var subtopic = kit.NextSubtopic();
                    for (var c = 0; c < perPage; c++)
                        write.PageEmbeddings.Add(new PageEmbedding { WorkspaceId = ws.Id, PageId = page, Chunk = c, Model = "voyage-4", TextHash = new byte[32], Vector = MemoryMarshal.AsBytes<sbyte>(kit.Chunk(subtopic)).ToArray(), TextVersion = 2, PageVersion = 2, CreatedAt = DateTimeOffset.UtcNow });
                    write.EmbeddingChanges.Add(new EmbeddingChange { WorkspaceId = ws.Id, PageId = page, CreatedAt = DateTimeOffset.UtcNow });
                }
                await write.SaveChangesAsync();
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
            ["pages"] = ids.Count,
            ["approximateFrom"] = options.ApproximateFrom,
            ["candidates"] = options.Candidates,
            ["seedMs"] = Math.Round(seedMs),
            ["budgetMs"] = BudgetMs,
            ["firstLoad"] = new JsonObject { ["ms"] = Math.Round(firstMs, 1), ["loadMs"] = Math.Round(loaded.Timings.Sync.TotalMilliseconds, 1) },
            ["copyMb"] = Math.Round(copyBytes / 1048576.0, 1),
            ["recall"] = new JsonObject
            {
                ["questions"] = recalls.Count,
                ["mean"] = Math.Round(recalls.Average(), 4),
                ["min"] = Math.Round(recalls.Min(), 2),
                ["floor"] = RecallFloor,
            },
            ["exactRanking"] = Stats(exactMs),
            ["approximateRanking"] = Stats(nearMs),
            ["warm"] = Stats(route),
            ["warmApproximate"] = approximate,
            ["afterChange"] = Stats(changed),
            ["providerMs"] = Stats(providerMs),
            ["at"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        var file = Path.Combine(server.Root, "bench", "results", "phase13-server.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        Assert.Equal(runs, approximate);
        Assert.True(recalls.Average() >= RecallFloor, $"recall {recalls.Average():0.000}");
        Assert.True(Percentile(route, 0.95) <= BudgetMs, $"warm p95 {Percentile(route, 0.95):0.0} ms");
        Assert.True(Percentile(changed, 0.95) <= BudgetMs, $"after a change p95 {Percentile(changed, 0.95):0.0} ms");
    }
}
