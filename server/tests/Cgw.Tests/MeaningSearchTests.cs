using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 10, search by meaning (M10.3): the permission check at query time, exactly as word
/// search's (restricted, a private section, a page hidden under a restricted one, trashed, a row
/// of a database the person cannot read, another workspace's, a guest), a page restricted or
/// trashed counting no more at once, the route's checks and failures, English and Arabic and
/// across the two, and <c>ask</c> with and without embeddings. No vector in any answer.
/// </summary>
public sealed class MeaningSearchTests(ServerFixture server)
{
    private static async Task<Guid> Row(Ws ws, Guid database, string title)
    {
        var id = Guid.CreateVersion7();
        var payload = DatabaseTests.PageJson(id, ws.Id, ws.Shared, database, "a0", title, "row");
        payload["row"] = new JsonObject { ["values"] = new JsonObject() };
        var result = (await ws.Push(ws.Op("page.create", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return id;
    }

    [Fact]
    public async Task Search_by_meaning_answers_only_pages_the_person_can_read_now()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var open = await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var restricted = await EmbedKit.Page(server, ws, "Refund rules for managers", "Reimbursement of customers above a limit needs a second payment check.", orderKey: "a1");
        await Kit.Share(ws, restricted, true);
        var hidden = await EmbedKit.Page(server, ws, "Refund appeals", "A buyer may appeal a refused reimbursement.", parent: restricted);
        var mine = await EmbedKit.Page(server, ws, "My refund notes", "Customers who asked me for their money back.", section: ws.Personal);
        var binned = await EmbedKit.Page(server, ws, "Old refund policy", "Customers had 14 days to return goods for a refund.", orderKey: "a2");
        var claims = await DatabaseTests.NewDatabase(ws, "Claims");
        await Kit.Share(ws, claims, true);
        var claim = await Row(ws, claims, "Customer refund claim");
        var unrelated = await EmbedKit.Page(server, ws, EmbedKit.HolidayTitle, EmbedKit.HolidayText, orderKey: "a3");
        await ws.Push(ws.Op("page.trash", binned, new { }));
        var elsewhere = await Ws.Create(server, ws.Account);
        var foreign = await EmbedKit.Page(server, elsewhere, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var key = await EmbedKit.TurnOn(ws);
        await EmbedKit.TurnOn(elsewhere);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.True(await EmbedKit.Embed(server, elsewhere.Id));
        Assert.NotEmpty(await EmbedKit.Vectors(server, ws.Id, claim));

        // A member: the open page only (no word of the question is in it).
        var response = await EmbedKit.Search(member.Client, ws.Id, EmbedKit.RefundQuestion);
        var text = await response.Content.ReadAsStringAsync();
        var hits = (await Kit.Json(response)).GetProperty("hits").EnumerateArray().ToList();
        var hit = Assert.Single(hits);
        Assert.Equal(open, hit.GetProperty("pageId").GetGuid());
        Assert.Equal(EmbedKit.RefundTitle, hit.GetProperty("title").GetString());
        Assert.Equal("page", hit.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, hit.GetProperty("databaseId").ValueKind);
        Assert.Equal(EmbedKit.RefundText, hit.GetProperty("snippet").GetString());
        var score = hit.GetProperty("score").GetDouble();
        Assert.InRange(score, EmbeddingsOptions.FloorDefault, 1);
        // The hit's members are the word search's, and no vector or chunk is in the answer.
        Assert.Equal(["databaseId", "kind", "pageId", "score", "snippet", "title"], hit.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal));
        Assert.DoesNotContain("embedding", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("vector", text, StringComparison.OrdinalIgnoreCase);

        // The owner: every page of theirs and the workspace's (restricted ones too, as an admin),
        // the row with its database, never the trashed page, the unrelated one or another workspace's.
        var owners = await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion, 20);
        Assert.Equal(new HashSet<Guid> { open, restricted, hidden, mine, claim }, EmbedKit.Ids(owners));
        var row = owners.Single(h => h.GetProperty("pageId").GetGuid() == claim);
        Assert.Equal(("row", claims), (row.GetProperty("kind").GetString(), row.GetProperty("databaseId").GetGuid()));
        Assert.True(owners.Zip(owners.Skip(1)).All(p => p.First.GetProperty("score").GetDouble() >= p.Second.GetProperty("score").GetDouble()));
        Assert.DoesNotContain(unrelated, EmbedKit.Ids(owners));
        Assert.DoesNotContain(foreign, EmbedKit.Ids(owners));

        // Shared with the member by name: found; the limit holds.
        await Kit.Share(ws, claims, true, ("user", member.Id, "view"));
        Assert.Equal(new HashSet<Guid> { open, claim }, EmbedKit.Ids(await EmbedKit.Hits(member.Client, ws.Id, EmbedKit.RefundQuestion)));
        Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion, 1));

        // Restricted or trashed: counted no more at once, before the worker runs.
        await Kit.Share(ws, open, true);
        Assert.Equal(new HashSet<Guid> { claim }, EmbedKit.Ids(await EmbedKit.Hits(member.Client, ws.Id, EmbedKit.RefundQuestion)));
        await ws.Push(ws.Op("page.trash", claim, new { }));
        Assert.Empty(await EmbedKit.Hits(member.Client, ws.Id, EmbedKit.RefundQuestion));
        Assert.DoesNotContain(claim, EmbedKit.Ids(await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion, 20)));

        // A guest searches nothing by meaning; someone outside the workspace finds no workspace.
        var byGuest = await EmbedKit.Search(guest.Client, ws.Id, EmbedKit.RefundQuestion);
        Assert.Equal(HttpStatusCode.Forbidden, byGuest.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(byGuest));
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await EmbedKit.Search(outsider.Client, ws.Id, EmbedKit.RefundQuestion)).StatusCode);

        // Each question is one metered call (input type query), the person's.
        var questions = (await EmbedKit.Calls(server, key)).Where(c => c.GetProperty("inputType").GetString() == "query").ToList();
        Assert.All(questions, q => Assert.Equal(1, q.GetProperty("count").GetInt32()));
        await using var db = server.NewDb(ws.Id);
        var usage = await db.AiUsage.Where(u => u.Action == "search").ToListAsync();
        Assert.Equal(questions.Count, usage.Count);
        Assert.Contains(usage, u => u.UserId == member.Id);
        Assert.All(usage, u => Assert.Equal("ok", u.Outcome));
    }

    [Fact]
    public async Task A_question_finds_a_page_by_meaning_in_english_in_arabic_and_across_the_two()
    {
        var ws = await Ws.Create(server);
        var refund = await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var leave = await EmbedKit.Page(server, ws, "جدول العطل", "يحصل كل موظف على إجازة سنوية مدفوعة.", orderKey: "a1");
        await EmbedKit.TurnOn(ws);
        Assert.True(await EmbedKit.Embed(server, ws.Id));

        Assert.Equal(refund, Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion)).GetProperty("pageId").GetGuid());
        Assert.Equal(refund, Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, "كيف يسترد العميل أمواله؟")).GetProperty("pageId").GetGuid());
        Assert.Equal(leave, Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, "متى إجازات الموظفين؟")).GetProperty("pageId").GetGuid());
        Assert.Equal(leave, Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, "When is staff vacation?")).GetProperty("pageId").GetGuid());
        // A question near no page finds none: the floor.
        Assert.Empty(await EmbedKit.Hits(ws.Client, ws.Id, "Parking for cars"));
    }

    [Fact]
    public async Task The_route_checks_its_question_and_answers_provider_failures_with_their_codes()
    {
        var ws = await Ws.Create(server);
        await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var off = await EmbedKit.Search(ws.Client, ws.Id, "refund");
        Assert.Equal(HttpStatusCode.Forbidden, off.StatusCode);
        Assert.Equal("ai.disabled", await Kit.Code(off));
        var key = await EmbedKit.TurnOn(ws);
        foreach (var (q, limit) in new (string, int?)[] { ("", null), ("   ", null), (new string('a', 1_001), null), ("refund", 0), ("refund", 21) })
        {
            var refused = await EmbedKit.Search(ws.Client, ws.Id, q, limit);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }
        Assert.Empty(await EmbedKit.Calls(server, key));
        // 1,000 characters after trimming is still a question.
        Assert.True((await EmbedKit.Search(ws.Client, ws.Id, "  " + new string('a', 1_000) + "  ")).IsSuccessStatusCode);

        await EmbedKit.Fault(server, key, 429, times: 3);
        var busy = await EmbedKit.Search(ws.Client, ws.Id, EmbedKit.RefundQuestion);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, busy.StatusCode);
        Assert.Equal("ai.limit", await Kit.Code(busy));
        Assert.NotNull(busy.Headers.RetryAfter);
        await EmbedKit.Fault(server, key, 500, times: 3);
        var down = await EmbedKit.Search(ws.Client, ws.Id, EmbedKit.RefundQuestion);
        Assert.Equal(HttpStatusCode.BadGateway, down.StatusCode);
        Assert.Equal("ai.provider", await Kit.Code(down));
        // Once busy and given another try: the retry answers.
        await EmbedKit.Fault(server, key, 429, times: 1);
        Assert.True((await EmbedKit.Search(ws.Client, ws.Id, EmbedKit.RefundQuestion)).IsSuccessStatusCode);
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(["ok", "ai.limit", "ai.provider", "ok"], await db.AiUsage.Where(u => u.Action == "search").OrderBy(u => u.CreatedAt).Select(u => u.Outcome).ToListAsync());
    }

    [Fact]
    public async Task Ask_fuses_the_word_search_and_the_meaning_search_when_both_are_on_and_is_as_before_when_not()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        // Found by its words only (no concept of the question's), and by its meaning only.
        var word = "Quillwort" + Random.Shared.Next(1000, 9999);
        var byWords = await EmbedKit.Page(server, ws, $"{word} notes", "Nothing about money here.");
        var byMeaning = await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText, orderKey: "a1");
        var hidden = await EmbedKit.Page(server, ws, "Refund secrets", "Customers reimbursed in cash.", orderKey: "a2");
        await Kit.Share(ws, hidden, true);
        var completions = await AiKit.TurnOn(ws);
        var question = $"How can a buyer of {word} get reimbursed?";

        // Embeddings off: 0.9.0's sources, the word search's alone; nothing goes to the embeddings provider.
        var before = await AiKit.Lines(await AiKit.Complete(member.Client, AiKit.Body(ws, "ask", null, new { question })));
        var sourcesBefore = before.Single(l => l.GetProperty("type").GetString() == "sources").GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("pageId").GetGuid()).ToList();
        Assert.Equal([byWords], sourcesBefore);

        var key = await EmbedKit.TurnOn(ws);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        var after = await AiKit.Lines(await AiKit.Complete(member.Client, AiKit.Body(ws, "ask", null, new { question })));
        var sources = after.Single(l => l.GetProperty("type").GetString() == "sources").GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("pageId").GetGuid()).ToList();
        Assert.Equal(new HashSet<Guid> { byWords, byMeaning }, sources.ToHashSet());
        var sent = (await AiKit.Sent(server, completions)).Last();
        var user = AiKit.UserText(sent);
        Assert.Contains($"Title: {EmbedKit.RefundTitle}", user);
        Assert.Contains(EmbedKit.RefundText, user);
        Assert.DoesNotContain("Refund secrets", sent.GetRawText());
        Assert.DoesNotContain("reimbursed in cash", sent.GetRawText());
        Assert.Contains(await EmbedKit.Calls(server, key), c => c.GetProperty("inputType").GetString() == "query" && c.GetProperty("inputs")[0].GetString() == question);

        // The embeddings provider down: ask still answers, from the words.
        await EmbedKit.Fault(server, key, 500, times: 3);
        var fallback = await AiKit.Lines(await AiKit.Complete(member.Client, AiKit.Body(ws, "ask", null, new { question })));
        Assert.Equal([byWords], fallback.Single(l => l.GetProperty("type").GetString() == "sources").GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("pageId").GetGuid()).ToList());
        Assert.Equal("done", fallback[^1].GetProperty("type").GetString());

        // Completions off: ask is off, whatever embeddings say.
        Assert.True((await AiKit.Put(ws.Client, ws.Id, new { enabled = false })).IsSuccessStatusCode);
        var askOff = await AiKit.Complete(member.Client, AiKit.Body(ws, "ask", null, new { question }));
        Assert.Equal(HttpStatusCode.Forbidden, askOff.StatusCode);
        Assert.Equal("ai.disabled", await Kit.Code(askOff));
        Assert.NotEmpty(await EmbedKit.Hits(member.Client, ws.Id, EmbedKit.RefundQuestion));
    }

    [Fact]
    public void Reciprocal_rank_fusion_takes_the_eight_best_of_both_lists()
    {
        static List<(Guid, string)> List(params Guid[] ids) => ids.Select(id => (id, id.ToString())).ToList();
        var ids = Enumerable.Range(0, 12).Select(_ => Guid.CreateVersion7()).ToArray();
        // A page first in both lists beats every other; one in both beats one in a single list at the same rank.
        var fused = AiService.Fuse(List(ids[0], ids[1], ids[2]), List(ids[0], ids[3], ids[1]));
        Assert.Equal([ids[0], ids[1], ids[3], ids[2]], fused.Select(f => f.PageId));
        Assert.Equal(8, AiService.Fuse(List(ids[..6]), List(ids[6..])).Count);
        Assert.Equal(60, AiService.FusionK);
    }
}
