using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Cgw.Tests;

/// <summary>
/// Phase 13, M13.5: AI on Cash Gear's subscription. Its keys come from the host's settings only; a
/// workspace chooses them instead of its own; each call reserves its most of the month's allowance
/// before it is sent and settles after; calls at once never pass it together; past it, 429
/// <c>ai.limit</c> with <c>reason: "allowance"</c>; the worker's embedding waits for the next month.
/// </summary>
public sealed class SubscriptionTests(ServerFixture server)
{
    /// <summary>An API with Cash Gear's keys and these allowances (a key of its own each test, so the mock's record is its own).</summary>
    private (WebApplicationFactory<Program> Api, string AnthropicKey, string VoyageKey) Plan(long completions, long embeddings, Guid? only = null, long? onlyCompletions = null)
    {
        var anthropic = AiKit.NewKey();
        var voyage = EmbedKit.NewKey();
        var api = server.Variant(b =>
        {
            b.UseSetting("Ai:Subscription:AnthropicKey", anthropic)
                .UseSetting("Ai:Subscription:VoyageKey", voyage)
                .UseSetting("Ai:Subscription:MonthlyTokens", completions.ToString(System.Globalization.CultureInfo.InvariantCulture))
                .UseSetting("Ai:Subscription:EmbeddingsMonthlyTokens", embeddings.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (only is { } id && onlyCompletions is { } tokens)
                b.UseSetting($"Ai:Subscription:Workspaces:{id}:MonthlyTokens", tokens.ToString(System.Globalization.CultureInfo.InvariantCulture));
        });
        return (api, anthropic, voyage);
    }

    private static async Task<HttpClient> SignedIn(WebApplicationFactory<Program> api, Account account)
    {
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, account.Email, account.Password);
        return client;
    }

    private static object Summarise(Ws ws, Guid page) => AiKit.Body(ws, "summarise", page, new { text = "The quarterly close is due on Friday." });

    [Fact]
    public async Task A_workspace_on_the_subscription_uses_ai_with_no_key_of_its_own_and_is_refused_past_its_allowance()
    {
        var ws = await Ws.Create(server);
        var (api, anthropic, _) = Plan(completions: 50_000, embeddings: 0);
        var owner = await SignedIn(api, ws.Account);
        var member = await Kit.Join(server, ws, "member");
        var memberClient = await SignedIn(api, member);
        var page = await Kit.PageWithText(server, ws);

        // Offered: owners and admins see the allowance; members see only where the key comes from.
        var settings = await AiKit.Settings(owner, ws.Id);
        Assert.Equal("own", settings.GetProperty("keySource").GetString());
        var plan = settings.GetProperty("subscription");
        Assert.Equal(50_000, plan.GetProperty("allowance").GetInt64());
        Assert.Equal(0, plan.GetProperty("used").GetInt64());
        Assert.False((await AiKit.Settings(memberClient, ws.Id)).TryGetProperty("subscription", out _));

        // On, with no key of its own: Cash Gear's key goes to the provider.
        var on = await AiKit.Put(owner, ws.Id, new { keySource = "subscription", enabled = true });
        Assert.True(on.IsSuccessStatusCode, await on.Content.ReadAsStringAsync());
        Assert.True((await Kit.Json(on)).GetProperty("enabled").GetBoolean());
        Assert.False((await Kit.Json(on)).GetProperty("hasKey").GetBoolean());
        var lines = await AiKit.Lines(await AiKit.Complete(memberClient, Summarise(ws, page)));
        Assert.Equal("done", lines[^1].GetProperty("type").GetString());
        Assert.Single(await AiKit.Sent(server, anthropic));

        // Metered as the subscription's, its reservation gone; the settings count it.
        await using (var db = server.NewDb(ws.Id))
        {
            var usage = await db.AiUsage.SingleAsync(u => u.Action == "summarise");
            Assert.True(usage.Subscription);
            Assert.True(usage.InputTokens + usage.OutputTokens > 0);
            Assert.Empty(await db.AiReservations.ToListAsync());
        }
        var used = (await AiKit.Settings(owner, ws.Id)).GetProperty("subscription").GetProperty("used").GetInt64();
        Assert.True(used > 0);

        // Past the allowance: what is used and a call's most would pass it. Nothing is sent.
        await using (var db = server.NewDb(ws.Id))
        {
            db.AiUsage.Add(new AiUsage { Id = Guid.CreateVersion7(), WorkspaceId = ws.Id, Action = "rewrite", Model = "claude-opus-5-5", InputTokens = 40_000, Outcome = "ok", CreatedAt = DateTimeOffset.UtcNow, Subscription = true });
            await db.SaveChangesAsync();
        }
        var refused = await AiKit.Complete(memberClient, Summarise(ws, page));
        Assert.Equal((HttpStatusCode)429, refused.StatusCode);
        var problem = await Kit.Json(refused);
        Assert.Equal("ai.limit", problem.GetProperty("code").GetString());
        Assert.Equal("allowance", problem.GetProperty("reason").GetString());
        Assert.Single(await AiKit.Sent(server, anthropic));
        // Last month's use and a lapsed reservation count for nothing.
        await using (var db = server.NewDb(ws.Id))
        {
            await db.AiUsage.Where(u => u.InputTokens == 40_000).ExecuteUpdateAsync(s => s.SetProperty(u => u.CreatedAt, DateTimeOffset.UtcNow.AddDays(-40)));
            db.AiReservations.Add(new AiReservation { Id = Guid.CreateVersion7(), WorkspaceId = ws.Id, Kind = AiAllowance.Completions, Tokens = 45_000, CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-20), ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-5) });
            await db.SaveChangesAsync();
        }
        Assert.Equal("done", (await AiKit.Lines(await AiKit.Complete(memberClient, Summarise(ws, page))))[^1].GetProperty("type").GetString());

        // Its own key again: nothing of the subscription is used.
        var own = AiKit.NewKey();
        Assert.True((await AiKit.Put(owner, ws.Id, new { keySource = "own", apiKey = own })).IsSuccessStatusCode);
        await AiKit.Lines(await AiKit.Complete(memberClient, Summarise(ws, page)));
        Assert.Single(await AiKit.Sent(server, own));
        await using (var db = server.NewDb(ws.Id))
            Assert.False((await db.AiUsage.OrderByDescending(u => u.CreatedAt).FirstAsync(u => u.Action == "summarise")).Subscription);

        // The audit names the source, never a key.
        await using (var db = server.NewDb(ws.Id))
        {
            var audits = await db.AuditLog.Where(a => a.Action == "ai.settings").Select(a => a.Detail!).ToListAsync();
            Assert.Contains(audits, d => d.Contains("\"keySource\":\"subscription\"", StringComparison.Ordinal));
            Assert.DoesNotContain(audits, d => d.Contains(anthropic, StringComparison.Ordinal) || d.Contains(own, StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task Calls_at_once_never_pass_the_allowance_together()
    {
        var ws = await Ws.Create(server);
        // Room for two calls' reservations (each its 16,000-token output limit and a little more), not three.
        var (api, anthropic, _) = Plan(completions: 36_000, embeddings: 0);
        var owner = await SignedIn(api, ws.Account);
        var page = await Kit.PageWithText(server, ws);
        Assert.True((await AiKit.Put(owner, ws.Id, new { keySource = "subscription", enabled = true })).IsSuccessStatusCode);
        // The provider holds each answer a second, so all five are under way at once.
        await AiKit.Script(server, anthropic, new { text = "A summary.", latencyMs = 1500, times = 5 });
        var answers = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => AiKit.Complete(owner, Summarise(ws, page))));
        Assert.Equal(2, answers.Count(a => a.StatusCode == HttpStatusCode.OK));
        Assert.Equal(3, answers.Count(a => a.StatusCode == (HttpStatusCode)429));
        foreach (var answer in answers.Where(a => a.IsSuccessStatusCode)) await AiKit.Lines(answer);
        Assert.Equal(2, (await AiKit.Sent(server, anthropic)).Count);
        await using var db = server.NewDb(ws.Id);
        Assert.Empty(await db.AiReservations.ToListAsync());
    }

    [Fact]
    public async Task The_subscription_is_offered_only_to_a_workspace_with_an_allowance()
    {
        var ws = await Ws.Create(server);
        // Every workspace has 50,000; this one none.
        var (api, _, _) = Plan(completions: 50_000, embeddings: 0, only: ws.Id, onlyCompletions: 0);
        var owner = await SignedIn(api, ws.Account);
        Assert.False((await AiKit.Settings(owner, ws.Id)).TryGetProperty("subscription", out _));
        var refused = await AiKit.Put(owner, ws.Id, new { keySource = "subscription", enabled = true });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("request.invalid", await Kit.Code(refused));
        // A server without Cash Gear's keys offers it to no one (the fixture's own API).
        Assert.False((await AiKit.Settings(ws.Client, ws.Id)).TryGetProperty("subscription", out _));
        Assert.Equal(HttpStatusCode.BadRequest, (await AiKit.Put(ws.Client, ws.Id, new { keySource = "subscription" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await AiKit.Put(owner, ws.Id, new { keySource = "theirs" })).StatusCode);
        Assert.Equal("AiSubscriptionOptions { Anthropic = True, Voyage = True }", api.Services.GetRequiredService<AiSubscriptionOptions>().ToString());
    }

    [Fact]
    public async Task Search_by_meaning_on_the_subscription_reserves_each_call_and_the_worker_waits_past_the_allowance()
    {
        var ws = await Ws.Create(server);
        var (api, _, voyage) = Plan(completions: 0, embeddings: 2_000);
        var owner = await SignedIn(api, ws.Account);
        var on = await EmbedKit.Put(owner, ws.Id, new { keySource = "subscription", enabled = true });
        Assert.True(on.IsSuccessStatusCode, await on.Content.ReadAsStringAsync());
        var embeddings = (await Kit.Json(on)).GetProperty("embeddings");
        Assert.True(embeddings.GetProperty("enabled").GetBoolean());
        Assert.Equal("subscription", embeddings.GetProperty("keySource").GetString());
        Assert.Equal(2_000, embeddings.GetProperty("subscription").GetProperty("allowance").GetInt64());

        // The worker on the subscription (the fixture's own worker has no plan: one made here).
        var page = await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var job = new EmbedJob(server.Worker.GetRequiredService<IEmbeddingProvider>(), server.Worker.GetRequiredService<EmbeddingKeys>(),
            server.Worker.GetRequiredService<EmbeddingsOptions>(), api.Services.GetRequiredService<AiSubscriptionOptions>(), TimeProvider.System, NullLogger<EmbedJob>.Instance);
        for (var round = 0; round < 10; round++)
            if (!await Kit.InWorker(server, ws.Id, (_, db) => job.PassAsync(db, ws.Id, CancellationToken.None))) break;
        Assert.NotEmpty(await EmbedKit.Vectors(server, ws.Id, page));
        Assert.NotEmpty(await EmbedKit.Calls(server, voyage));

        // A question, on the subscription too.
        var hits = await EmbedKit.Hits(owner, ws.Id, EmbedKit.RefundQuestion);
        Assert.Contains(page, EmbedKit.Ids(hits));
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.All(await db.AiUsage.Where(u => u.Action == "embed" || u.Action == "search").ToListAsync(), u => Assert.True(u.Subscription));
            Assert.Empty(await db.AiReservations.ToListAsync());
        }

        // Past the allowance: a question is refused, and the worker waits for the next month.
        await using (var db = server.NewDb(ws.Id))
        {
            db.AiUsage.Add(new AiUsage { Id = Guid.CreateVersion7(), WorkspaceId = ws.Id, Action = "embed", Model = "voyage-4", InputTokens = 2_000, Outcome = "ok", CreatedAt = DateTimeOffset.UtcNow, Subscription = true });
            await db.SaveChangesAsync();
        }
        var refused = await EmbedKit.Search(owner, ws.Id, EmbedKit.RefundQuestion);
        Assert.Equal((HttpStatusCode)429, refused.StatusCode);
        Assert.Equal("allowance", (await Kit.Json(refused)).GetProperty("reason").GetString());
        await EmbedKit.Page(server, ws, EmbedKit.HolidayTitle, EmbedKit.HolidayText, orderKey: "a5");
        await Kit.InWorker(server, ws.Id, (_, db) => job.PassAsync(db, ws.Id, CancellationToken.None));
        Assert.True(job.BackedOff(ws.Id));
    }
}
