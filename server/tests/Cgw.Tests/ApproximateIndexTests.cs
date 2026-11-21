using Cgw.Core.Ai;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 13, M13.4: the approximate index. Past its threshold a search scores only the chunks nearest
/// by their sign bits, finds at least 0.95 of the exact search's first ten, stays current as vectors
/// change, and asks wider when too few of its pages pass the permission check.
/// </summary>
public sealed class ApproximateIndexTests(ServerFixture server)
{
    private EmbeddingsCache Cache(int from, int candidates)
    {
        var options = server.Api.Services.GetRequiredService<EmbeddingsOptions>() with { ApproximateFrom = from, Candidates = candidates };
        return new EmbeddingsCache(options, TimeProvider.System);
    }

    [Fact]
    public async Task Past_its_threshold_a_search_is_approximate_and_finds_the_exact_searchs_first_ten()
    {
        var ws = await Ws.Create(server);
        await EmbedKit.TurnOn(ws);
        var kit = new VectorKit(13, topics: 40, subtopicsEach: 10);
        var pages = await kit.SeedAsync(server, ws, chunks: 20_000, perPage: 5);
        await using var db = server.NewDb(ws.Id);
        var generation = (await db.AiSettings.AsNoTracking().SingleAsync()).EmbeddingsGeneration;
        var cache = Cache(from: 5_000, candidates: 512);

        var recalls = new List<double>();
        for (var q = 0; q < 30; q++)
        {
            var question = kit.Question(kit.NextSubtopic());
            var exact = await cache.RankAsync(db, ws.Id, generation, "voyage-4", question, 0.0, CancellationToken.None, candidates: int.MaxValue);
            var near = await cache.RankAsync(db, ws.Id, generation, "voyage-4", question, 0.0, CancellationToken.None);
            Assert.True(exact.Complete);
            Assert.False(exact.Timings.Approximate);
            Assert.Equal(20_000, exact.Timings.Scored);
            Assert.False(near.Complete);
            Assert.True(near.Timings.Approximate);
            Assert.Equal(512, near.Timings.Scored);
            // Whatever it ranks is scored exactly: each page's score is the exact search's or below (its best chunk not among the candidates).
            var exactScores = exact.Ranked.ToDictionary(c => c.PageId, c => c.Score);
            Assert.All(near.Ranked, c => Assert.True(c.Score <= exactScores[c.PageId] + 1e-6));
            recalls.Add(VectorKit.Recall(exact.Ranked.Select(c => c.PageId).ToList(), near.Ranked.Select(c => c.PageId).ToList()));
        }
        Assert.True(recalls.Average() >= 0.95, $"recall {recalls.Average():0.000}");

        // Below its threshold every search is exact.
        var small = Cache(from: 50_000, candidates: 512);
        var plain = await small.RankAsync(db, ws.Id, generation, "voyage-4", kit.Question(0), 0.0, CancellationToken.None);
        Assert.True(plain.Complete);
        Assert.False(plain.Timings.Approximate);

        // Kept current: a page's vectors replaced by ones near a question are found by the next search;
        // a page whose vectors went is found no more.
        var target = kit.NextSubtopic();
        var asked = kit.Question(target);
        var moved = pages[17];
        var gone = (await cache.RankAsync(db, ws.Id, generation, "voyage-4", asked, 0.0, CancellationToken.None)).Ranked[0].PageId;
        await using (var write = server.NewDb(ws.Id))
        {
            await write.PageEmbeddings.Where(e => e.PageId == moved || e.PageId == gone).ExecuteDeleteAsync();
            write.PageEmbeddings.Add(new PageEmbedding
            {
                WorkspaceId = ws.Id,
                PageId = moved,
                Chunk = 0,
                Model = "voyage-4",
                TextHash = new byte[32],
                Vector = System.Runtime.InteropServices.MemoryMarshal.AsBytes<sbyte>(asked).ToArray(),
                TextVersion = 2,
                PageVersion = 2,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            write.EmbeddingChanges.Add(new EmbeddingChange { WorkspaceId = ws.Id, PageId = moved, CreatedAt = DateTimeOffset.UtcNow });
            write.EmbeddingChanges.Add(new EmbeddingChange { WorkspaceId = ws.Id, PageId = gone, CreatedAt = DateTimeOffset.UtcNow });
            await write.SaveChangesAsync();
        }
        var after = await cache.RankAsync(db, ws.Id, generation, "voyage-4", asked, 0.0, CancellationToken.None);
        Assert.False(after.Timings.Loaded);
        Assert.True(after.Timings.Approximate);
        Assert.Equal(moved, after.Ranked[0].PageId);
        Assert.DoesNotContain(after.Ranked, c => c.PageId == gone);
    }

    [Fact]
    public async Task Too_few_pages_the_person_may_read_among_the_candidates_widens_the_search_until_it_finds_them()
    {
        // An API whose copies are approximate from 10 chunks, scoring 16 at first.
        var api = server.Variant(b => b.UseSetting("Ai:EmbeddingsApproximateFrom", "10").UseSetting("Ai:EmbeddingsCandidates", "16"));
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var memberClient = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(memberClient, member.Email, member.Password);
        await EmbedKit.TurnOn(ws);
        // Forty pages about refunds, thirty of them restricted to the owner; thirty about holidays.
        var open = new List<Guid>();
        for (var i = 0; i < 40; i++)
        {
            var page = await EmbedKit.Page(server, ws, $"Refund case {i}", $"Customers {i} asked for a refund of their money on order n{i}.", orderKey: "a" + (i + 10) + "5");
            if (i % 4 == 0) open.Add(page);
            else await Kit.Share(ws, page, true);
        }
        for (var i = 0; i < 30; i++)
            await EmbedKit.Page(server, ws, $"Leave note {i}", $"The office is closed on holiday {i} and staff take annual leave.", orderKey: "b" + (i + 10) + "5");
        Assert.True(await EmbedKit.Embed(server, ws.Id));

        // The sixteen nearest chunks are mostly pages the member cannot read: the search asks wider and
        // finds the ten refund pages they can, as the exact search does.
        var hits = await EmbedKit.Hits(memberClient, ws.Id, EmbedKit.RefundQuestion, 10);
        Assert.Equal(open.ToHashSet(), EmbedKit.Ids(hits));
        var exact = await EmbedKit.Hits(member.Client, ws.Id, EmbedKit.RefundQuestion, 10);
        Assert.Equal(EmbedKit.Ids(exact), EmbedKit.Ids(hits));
    }
}
