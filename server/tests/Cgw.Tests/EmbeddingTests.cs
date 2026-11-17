using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Cgw.Tests;

/// <summary>Steps the embeddings tests share: the switch, a page's text, the worker's pass, the mock's record.</summary>
public static class EmbedKit
{
    /// <summary>A Voyage key of its own for each test, so the mock's record of it is that test's alone.</summary>
    public static string NewKey() => "pa-test-" + Guid.NewGuid().ToString("N");

    public static Task<HttpResponseMessage> Put(HttpClient client, Guid workspace, object embeddings) =>
        AiKit.Put(client, workspace, new { embeddings });

    /// <summary>Turns embeddings on with a fresh key (as the workspace's owner), and gives the key.</summary>
    public static async Task<string> TurnOn(Ws ws, string? model = null)
    {
        var key = NewKey();
        var response = await Put(ws.Client, ws.Id, model is null ? new { enabled = true, apiKey = key } : new { enabled = true, apiKey = key, model });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return key;
    }

    private static readonly HttpClient Mock = new();

    /// <summary>The embeddings calls the mock received with this key, oldest first.</summary>
    public static async Task<List<JsonElement>> Calls(ServerFixture server, string key)
    {
        var all = await Mock.GetFromJsonAsync<JsonElement>($"{server.AiMockUrl}/__mock/embeddings?keyId={AiKit.KeyId(key)}");
        return all.GetProperty("calls").EnumerateArray().Select(c => c.Clone()).ToList();
    }

    public static async Task Fault(ServerFixture server, string key, int status, int times = 1)
    {
        var response = await Mock.PostAsJsonAsync($"{server.AiMockUrl}/__mock/fault", new { keyId = AiKit.KeyId(key), endpoint = "embeddings", status, times });
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    /// <summary>
    /// Sets a page's derived text as the worker's derive would (a page with no document has its
    /// head at 0, so the derive has caught up), its version one higher each time.
    /// </summary>
    public static async Task SetText(ServerFixture server, Guid workspace, Guid page, string text)
    {
        await using var db = server.NewDb(workspace);
        var row = await db.PageDocDerived.FirstOrDefaultAsync(d => d.PageId == page);
        if (row is null) db.PageDocDerived.Add(row = new PageDocDerived { PageId = page, WorkspaceId = workspace, Json = [], Outgoing = "{}" });
        row.UpToSeq++;
        row.PlainText = text;
        row.SearchText = TextNormaliser.Normalise(text);
        row.UpdatedAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.SaveChangesAsync();
    }

    /// <summary>A page with a title and a text, ready to be embedded.</summary>
    public static async Task<Guid> Page(ServerFixture server, Ws ws, string title, string text, Guid? parent = null, Guid? section = null, string orderKey = "a0")
    {
        var page = (await ws.NewPage(title, parent, orderKey, section)).GetProperty("id").GetGuid();
        await SetText(server, ws.Id, page, text);
        return page;
    }

    /// <summary>
    /// The worker's embed job's passes, over this workspace only (tests run side by side: another's
    /// workspace, its key and the faults queued for it are left alone), until nothing more is due.
    /// False when the workspace's embeddings are off.
    /// </summary>
    public static async Task<bool> Embed(ServerFixture server, Guid workspace)
    {
        var job = Kit.Job<EmbedJob>(server);
        for (var round = 0; round < 50; round++)
            if (!await Kit.InWorker(server, workspace, (_, db) => job.PassAsync(db, workspace, CancellationToken.None))) break;
        await using var check = server.NewDb(workspace);
        return await check.AiSettings.AnyAsync(s => s.EmbeddingsEnabled && s.EmbeddingsKeyCipher != null);
    }

    public static async Task<List<PageEmbedding>> Vectors(ServerFixture server, Guid workspace, Guid? page = null)
    {
        await using var db = server.NewDb(workspace);
        return await db.PageEmbeddings.AsNoTracking().Where(e => page == null || e.PageId == page).OrderBy(e => e.PageId).ThenBy(e => e.Chunk).ToListAsync();
    }

    public static async Task<HttpResponseMessage> Search(HttpClient client, Guid workspace, string q, int? limit = null) =>
        await client.GetAsync($"/api/v1/workspaces/{workspace}/search/meaning?q={Uri.EscapeDataString(q)}" + (limit is null ? "" : $"&limit={limit}"));

    public static async Task<List<JsonElement>> Hits(HttpClient client, Guid workspace, string q, int? limit = null)
    {
        var response = await Search(client, workspace, q, limit);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return (await Kit.Json(response)).GetProperty("hits").EnumerateArray().ToList();
    }

    public static HashSet<Guid> Ids(IEnumerable<JsonElement> hits) => hits.Select(h => h.GetProperty("pageId").GetGuid()).ToHashSet();

    // Texts the mock's lexicon reads as sharing concepts (tests/mocks/ai/embeddings.mjs).
    public const string RefundTitle = "Refund policy";
    public const string RefundText = "Customers may return goods within 30 days for a full refund of their money.";
    public const string RefundQuestion = "How can a buyer get reimbursed?";
    public const string HolidayTitle = "Holiday schedule";
    public const string HolidayText = "The office is closed on public holidays and every employee has annual leave.";
}

/// <summary>
/// Phase 10, embeddings (M10.2): the settings by role, the key never answered, logged or audited, the
/// off switch (nothing sent, every vector deleted), and the worker's chunks: made again on a change,
/// kept when unchanged, removed on trash and delete, made again on a model change, backed off on a
/// provider failure. The provider is the mock in <c>tests/mocks/ai</c> (its <c>/v1/embeddings</c>).
/// </summary>
public sealed class EmbeddingTests(ServerFixture server)
{
    [Fact]
    public async Task Embeddings_are_off_until_an_owner_or_admin_turns_them_on_with_a_key_that_is_never_shown()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");

        var seen = (await AiKit.Settings(member.Client, ws.Id)).GetProperty("embeddings");
        Assert.False(seen.GetProperty("enabled").GetBoolean());
        Assert.Equal("voyage", seen.GetProperty("provider").GetString());
        Assert.Equal("voyage-4", seen.GetProperty("model").GetString());
        Assert.Equal(["voyage-4", "voyage-4-large", "voyage-4-lite"], seen.GetProperty("models").EnumerateArray().Select(m => m.GetString()));
        foreach (var hidden in new[] { "hasKey", "keySetAt", "keySetBy", "usage", "progress" })
            Assert.False(seen.TryGetProperty(hidden, out _), hidden);
        var owners = (await AiKit.Settings(ws.Client, ws.Id)).GetProperty("embeddings");
        Assert.False(owners.GetProperty("hasKey").GetBoolean());
        Assert.Equal(0, owners.GetProperty("usage").GetProperty("requests").GetInt32());

        var key = EmbedKit.NewKey();
        foreach (var other in new[] { member, guest })
        {
            var refused = await EmbedKit.Put(other.Client, ws.Id, new { enabled = true, apiKey = key });
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("access.denied", await Kit.Code(refused));
        }
        var noKey = await EmbedKit.Put(ws.Client, ws.Id, new { enabled = true });
        Assert.Equal(HttpStatusCode.BadRequest, noKey.StatusCode);
        Assert.Equal("ai.keyMissing", await Kit.Code(noKey));
        foreach (var bad in new object[] { new { apiKey = "short" }, new { apiKey = "has spaces in it, a lot of them" }, new { apiKey = 7 }, new { model = "voyage-9" } })
        {
            var refused = await EmbedKit.Put(ws.Client, ws.Id, bad);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }

        // Embeddings may be on while completions are off.
        var on = await EmbedKit.Put(admin.Client, ws.Id, new { enabled = true, apiKey = key, model = "voyage-4-lite" });
        var onText = await on.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.OK, on.StatusCode);
        Assert.DoesNotContain(key, onText);
        var settings = JsonDocument.Parse(onText).RootElement;
        Assert.False(settings.GetProperty("enabled").GetBoolean());
        var embeddings = settings.GetProperty("embeddings");
        Assert.True(embeddings.GetProperty("enabled").GetBoolean());
        Assert.True(embeddings.GetProperty("hasKey").GetBoolean());
        Assert.Equal(admin.Id, embeddings.GetProperty("keySetBy").GetProperty("id").GetGuid());
        Assert.Equal("voyage-4-lite", embeddings.GetProperty("model").GetString());
        Assert.Equal(0, embeddings.GetProperty("progress").GetProperty("embedded").GetInt32());
        foreach (var reader in new[] { ws.Account, admin, member, guest })
        {
            var text = await reader.Client.GetStringAsync($"/api/v1/workspaces/{ws.Id}/ai-settings");
            Assert.DoesNotContain(key, text);
            Assert.DoesNotContain(key[^10..], text);
            Assert.True(JsonDocument.Parse(text).RootElement.GetProperty("embeddings").GetProperty("enabled").GetBoolean());
        }

        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.AiSettings.SingleAsync();
            Assert.NotNull(row.EmbeddingsKeyCipher);
            Assert.DoesNotContain(key[8..], row.EmbeddingsKeyCipher);
            Assert.Null(row.KeyCipher);
            var keys = server.Api.Services.GetRequiredService<EmbeddingKeys>();
            Assert.Equal(key, keys.Unprotect(ws.Id, row.EmbeddingsKeyCipher));
            Assert.Null(keys.Unprotect(Guid.CreateVersion7(), row.EmbeddingsKeyCipher));
            // Completions' key cipher does not open it either: a purpose of its own.
            Assert.Null(server.Api.Services.GetRequiredService<AiKeys>().Unprotect(ws.Id, row.EmbeddingsKeyCipher));
            var audits = await db.AuditLog.Where(a => a.Action == "ai.settings").ToListAsync();
            Assert.Single(audits);
            Assert.All(audits, a => Assert.DoesNotContain(key[8..], a.Detail ?? ""));
            Assert.Contains("\"embeddings\":{\"enabled\":true,\"model\":\"voyage-4-lite\",\"key\":\"set\"", audits[0].Detail);
        }

        // Removing the key turns them off.
        var removed = JsonDocument.Parse(await (await EmbedKit.Put(ws.Client, ws.Id, new { apiKey = (string?)null })).Content.ReadAsStringAsync()).RootElement.GetProperty("embeddings");
        Assert.False(removed.GetProperty("enabled").GetBoolean());
        Assert.False(removed.GetProperty("hasKey").GetBoolean());
        await using (var db = server.NewDb(ws.Id))
            Assert.Contains(await db.AuditLog.Where(a => a.Action == "ai.settings").Select(a => a.Detail).ToListAsync(), d => d!.Contains("\"key\":\"removed\""));

        // Off on this server: off for every workspace, whatever theirs say.
        Assert.True((await EmbedKit.Put(ws.Client, ws.Id, new { enabled = true, apiKey = key })).IsSuccessStatusCode);
        await using var api = server.Variant(b => b.UseSetting("Ai:Enabled", "false"));
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, ws.Account.Email, ws.Account.Password);
        Assert.False((await AiKit.Settings(client, ws.Id)).GetProperty("embeddings").GetProperty("enabled").GetBoolean());
        var serverOff = await EmbedKit.Search(client, ws.Id, "refund");
        Assert.Equal(HttpStatusCode.Forbidden, serverOff.StatusCode);
        Assert.Equal("ai.disabled", await Kit.Code(serverOff));
    }

    [Fact]
    public async Task With_embeddings_off_nothing_is_sent_and_turning_them_off_deletes_every_vector()
    {
        var ws = await Ws.Create(server);
        var page = await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var key = EmbedKit.NewKey();
        // A key set, embeddings not on: the worker sends nothing, search is off, ask is 0.9.0's.
        Assert.True((await EmbedKit.Put(ws.Client, ws.Id, new { apiKey = key })).IsSuccessStatusCode);
        Assert.False(await EmbedKit.Embed(server, ws.Id));
        var off = await EmbedKit.Search(ws.Client, ws.Id, EmbedKit.RefundQuestion);
        Assert.Equal(HttpStatusCode.Forbidden, off.StatusCode);
        Assert.Equal("ai.disabled", await Kit.Code(off));
        var completions = await AiKit.TurnOn(ws);
        var ask = await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "ask", null, new { question = "refund" })));
        Assert.Equal(page, Assert.Single(ask.Single(l => l.GetProperty("type").GetString() == "sources").GetProperty("pages").EnumerateArray()).GetProperty("pageId").GetGuid());
        Assert.Empty(await EmbedKit.Calls(server, key));
        Assert.Single(await AiKit.Sent(server, completions));

        // On: embedded; off: every vector goes in the same request, and the API's copy with them.
        Assert.True((await EmbedKit.Put(ws.Client, ws.Id, new { enabled = true })).IsSuccessStatusCode);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.NotEmpty(await EmbedKit.Vectors(server, ws.Id));
        Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion));
        var cache = server.Api.Services.GetRequiredService<EmbeddingsCache>();
        Assert.True(cache.Holds(ws.Id));
        var calls = (await EmbedKit.Calls(server, key)).Count;
        var turnedOff = await EmbedKit.Put(ws.Client, ws.Id, new { enabled = false });
        Assert.True(turnedOff.IsSuccessStatusCode);
        Assert.Empty(await EmbedKit.Vectors(server, ws.Id));
        Assert.False(cache.Holds(ws.Id));
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.Contains(await db.EmbeddingChanges.Select(c => c.PageId).ToListAsync(), id => id == page);
            Assert.Contains(await db.AuditLog.Where(a => a.Action == "ai.settings").Select(a => a.Detail).ToListAsync(), d => d!.Contains("\"embeddings\":{\"enabled\":false"));
        }
        Assert.False(await EmbedKit.Embed(server, ws.Id));
        await EmbedKit.SetText(server, ws.Id, page, EmbedKit.RefundText + " Changed.");
        Assert.False(await EmbedKit.Embed(server, ws.Id));
        await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "ask", null, new { question = "refund" })));
        Assert.Equal(calls, (await EmbedKit.Calls(server, key)).Count);
        Assert.Empty(await EmbedKit.Vectors(server, ws.Id));

        // On again: every page embedded again, a new generation.
        Assert.True((await EmbedKit.Put(ws.Client, ws.Id, new { enabled = true })).IsSuccessStatusCode);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.NotEmpty(await EmbedKit.Vectors(server, ws.Id, page));
        await using var after = server.NewDb(ws.Id);
        Assert.Equal(2, (await after.AiSettings.SingleAsync()).EmbeddingsGeneration);
    }

    [Fact]
    public async Task The_worker_embeds_chunks_again_on_a_change_keeps_them_when_unchanged_and_removes_them_on_trash_and_delete()
    {
        var ws = await Ws.Create(server);
        var long1 = string.Join("\n", Enumerable.Range(1, 30).Select(i => $"Paragraph {i}: the warehouse keeps stock of every item in aisle {i}, counted each week by the staff."));
        var page = await EmbedKit.Page(server, ws, "Warehouse handbook", long1);
        var titleOnly = (await ws.NewPage("Supplier list")).GetProperty("id").GetGuid();
        var empty = (await ws.NewPage("")).GetProperty("id").GetGuid();
        var key = await EmbedKit.TurnOn(ws);
        Assert.True(await EmbedKit.Embed(server, ws.Id));

        var first = await EmbedKit.Vectors(server, ws.Id, page);
        var chunks = EmbeddingText.Chunks("Warehouse handbook", long1);
        Assert.True(chunks.Count >= 2);
        Assert.Equal(chunks.Count, first.Count);
        Assert.Equal(Enumerable.Range(0, chunks.Count), first.Select(e => e.Chunk));
        Assert.All(first, e => Assert.Equal(1024, e.Vector.Length));
        Assert.All(first, e => Assert.Equal("voyage-4", e.Model));
        Assert.All(chunks, c => Assert.StartsWith("Warehouse handbook\n\n", c.Text, StringComparison.Ordinal));
        Assert.Equal(chunks.Select(c => Convert.ToHexString(EmbeddingText.Hash(c.Text))), first.Select(e => Convert.ToHexString(e.TextHash)));
        // A title alone is one chunk; a page with nothing to embed holds one empty row.
        Assert.Single(await EmbedKit.Vectors(server, ws.Id, titleOnly));
        var none = Assert.Single(await EmbedKit.Vectors(server, ws.Id, empty));
        Assert.Empty(none.Vector);
        var calls = await EmbedKit.Calls(server, key);
        Assert.All(calls, c => Assert.Equal("document", c.GetProperty("inputType").GetString()));
        Assert.All(calls, c => Assert.Equal(1024, c.GetProperty("outputDimension").GetInt32()));
        Assert.All(calls, c => Assert.Equal("int8", c.GetProperty("outputDtype").GetString()));
        Assert.All(calls, c => Assert.True(c.GetProperty("count").GetInt32() <= 128));
        var sent = calls.Sum(c => c.GetProperty("count").GetInt32());
        Assert.Equal(chunks.Count + 1, sent);

        // Nothing changed: no call, no new row. A move (the page's version) changes nothing sent.
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.Equal(calls.Count, (await EmbedKit.Calls(server, key)).Count);
        await ws.Push(ws.Op("page.update", page, new { icon = "📦" }));
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.Equal(calls.Count, (await EmbedKit.Calls(server, key)).Count);
        Assert.Equal(first.Select(e => e.Id), (await EmbedKit.Vectors(server, ws.Id, page)).Select(e => e.Id));

        // The last paragraph changed: only the chunks whose text changed are sent.
        var long2 = long1.Replace("aisle 30, counted", "aisle 30, refunded", StringComparison.Ordinal);
        await EmbedKit.SetText(server, ws.Id, page, long2);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        var changed = (await EmbedKit.Calls(server, key)).Skip(calls.Count).ToList();
        var resent = changed.SelectMany(c => c.GetProperty("inputs").EnumerateArray().Select(i => i.GetString()!)).ToList();
        Assert.NotEmpty(resent);
        Assert.True(resent.Count < chunks.Count);
        Assert.All(resent, text => Assert.Contains("refunded", text, StringComparison.Ordinal));
        var second = await EmbedKit.Vectors(server, ws.Id, page);
        Assert.Equal(EmbeddingText.Chunks("Warehouse handbook", long2).Count, second.Count);

        // A title change changes every chunk (each starts with the title's line).
        await ws.Push(ws.Op("page.update", page, new { title = "Stock handbook" }));
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.All(await EmbedKit.Vectors(server, ws.Id, page), e => Assert.True(e.Id > second.Max(s => s.Id)));

        // Trashed: removed; restored: embedded again; deleted for good: removed.
        await ws.Push(ws.Op("page.trash", page, new { }));
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.Empty(await EmbedKit.Vectors(server, ws.Id, page));
        await ws.Push(ws.Op("page.restore", page, new { }));
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.NotEmpty(await EmbedKit.Vectors(server, ws.Id, page));
        await ws.Push(ws.Op("page.trash", titleOnly, new { }));
        await ws.Push(ws.Op("page.delete", titleOnly, new { }));
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.Empty(await EmbedKit.Vectors(server, ws.Id, titleOnly));

        // Metered: one row a call, the worker's with no person; never audited.
        await using var db = server.NewDb(ws.Id);
        var usage = await db.AiUsage.Where(u => u.Action == "embed").ToListAsync();
        Assert.Equal((await EmbedKit.Calls(server, key)).Count, usage.Count);
        Assert.All(usage, u => Assert.Null(u.UserId));
        Assert.All(usage, u => Assert.True(u.InputTokens > 0));
        Assert.False(await db.AuditLog.AnyAsync(a => a.Action.StartsWith("ai.embed")));
        var settings = (await AiKit.Settings(ws.Client, ws.Id)).GetProperty("embeddings");
        Assert.Equal(usage.Count, settings.GetProperty("usage").GetProperty("requests").GetInt32());
        Assert.Equal(usage.Sum(u => u.InputTokens), settings.GetProperty("usage").GetProperty("tokens").GetInt64());
        Assert.Equal(settings.GetProperty("progress").GetProperty("pages").GetInt32(), settings.GetProperty("progress").GetProperty("embedded").GetInt32());
    }

    [Fact]
    public async Task A_model_change_embeds_every_page_again_and_the_old_vectors_go_as_the_new_ones_land()
    {
        var ws = await Ws.Create(server);
        var a = await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var b = await EmbedKit.Page(server, ws, EmbedKit.HolidayTitle, EmbedKit.HolidayText, orderKey: "a1");
        var key = await EmbedKit.TurnOn(ws);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion));
        Assert.All(await EmbedKit.Vectors(server, ws.Id), e => Assert.Equal("voyage-4", e.Model));

        var changed = await EmbedKit.Put(ws.Client, ws.Id, new { model = "voyage-4-large" });
        Assert.True(changed.IsSuccessStatusCode);
        var progress = (await Kit.Json(changed)).GetProperty("embeddings").GetProperty("progress");
        Assert.Equal(0, progress.GetProperty("embedded").GetInt32());
        // Until the new vectors land, the old model's stay, and search (by the new model) finds nothing.
        Assert.All(await EmbedKit.Vectors(server, ws.Id), e => Assert.Equal("voyage-4", e.Model));
        Assert.Empty(await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion));
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        var vectors = await EmbedKit.Vectors(server, ws.Id);
        Assert.All(vectors, e => Assert.Equal("voyage-4-large", e.Model));
        Assert.Equal(new HashSet<Guid> { a, b }, vectors.Select(v => v.PageId).ToHashSet());
        Assert.Contains(await EmbedKit.Calls(server, key), c => c.GetProperty("model").GetString() == "voyage-4-large");
        Assert.Equal(a, Assert.Single(await EmbedKit.Hits(ws.Client, ws.Id, EmbedKit.RefundQuestion)).GetProperty("pageId").GetGuid());
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(2, (await db.AiSettings.SingleAsync()).EmbeddingsGeneration);
    }

    [Fact]
    public async Task A_provider_failure_backs_the_workspace_off_and_is_metered_and_the_key_is_never_logged()
    {
        var ws = await Ws.Create(server);
        var page = await EmbedKit.Page(server, ws, EmbedKit.RefundTitle, EmbedKit.RefundText);
        var key = await EmbedKit.TurnOn(ws);
        var job = Kit.Job<EmbedJob>(server);
        await EmbedKit.Fault(server, key, 500, times: 3);
        await EmbedKit.Embed(server, ws.Id);
        Assert.True(job.BackedOff(ws.Id));
        Assert.Empty(await EmbedKit.Vectors(server, ws.Id));
        // Three attempts (two retries), then given up and metered once with its code.
        Assert.Equal(3, (await EmbedKit.Calls(server, key)).Count);
        await using (var db = server.NewDb(ws.Id))
            Assert.Equal("ai.provider", (await db.AiUsage.SingleAsync(u => u.Action == "embed")).Outcome);
        var progress = (await AiKit.Settings(ws.Client, ws.Id)).GetProperty("embeddings").GetProperty("progress");
        Assert.Equal(1, progress.GetProperty("pages").GetInt32() - progress.GetProperty("embedded").GetInt32());
        // While backed off, the worker leaves the workspace alone.
        await EmbedKit.Embed(server, ws.Id);
        Assert.Equal(3, (await EmbedKit.Calls(server, key)).Count);
        job.Forgive(ws.Id);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.NotEmpty(await EmbedKit.Vectors(server, ws.Id, page));

        // A refused key, on the question: 502 ai.keyInvalid; the key in no log line.
        var logs = new CapturedLogs();
        await using var api = server.Variant(b => b.ConfigureLogging(l => l.AddProvider(logs).SetMinimumLevel(LogLevel.Trace)));
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, ws.Account.Email, ws.Account.Password);
        var invalid = "pa-mock-invalid-" + Guid.NewGuid().ToString("N");
        Assert.True((await EmbedKit.Put(client, ws.Id, new { apiKey = invalid })).IsSuccessStatusCode);
        var refused = await EmbedKit.Search(client, ws.Id, EmbedKit.RefundQuestion);
        Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
        Assert.Equal("ai.keyInvalid", await Kit.Code(refused));
        Assert.DoesNotContain(invalid[16..], await refused.Content.ReadAsStringAsync());
        Assert.NotEmpty(logs.Entries);
        Assert.DoesNotContain(logs.Entries, e => e.Message.Contains(invalid[16..], StringComparison.Ordinal) || e.Message.Contains(key[8..], StringComparison.Ordinal));
    }

    [Fact]
    public void Chunks_are_cut_at_paragraphs_then_sentences_then_spaces_with_an_overlap_and_the_title_first()
    {
        Assert.Empty(EmbeddingText.Chunks("", ""));
        Assert.Equal("A title", Assert.Single(EmbeddingText.Chunks("A  title\n", "  ")).Text);
        var one = Assert.Single(EmbeddingText.Chunks("T", "Short text."));
        Assert.Equal("T\n\nShort text.", one.Text);
        Assert.Equal("Short text.", one.Own);

        var paragraphs = string.Join("\n", Enumerable.Range(0, 12).Select(i => new string((char)('a' + i), 299) + "."));
        var cut = EmbeddingText.Chunks("Title", paragraphs);
        Assert.True(cut.Count >= 2);
        Assert.All(cut, c => Assert.True(c.Own.Length <= EmbeddingText.Target));
        // Cut at a paragraph's end, and the next starts about 200 characters back.
        Assert.EndsWith(".\n", cut[0].Own, StringComparison.Ordinal);
        var overlap = cut[0].Own[^150..];
        Assert.Contains(overlap.TrimEnd('\n'), cut[1].Own, StringComparison.Ordinal);

        var sentences = string.Concat(Enumerable.Repeat("This is a sentence of words. ", 600));
        var bySentence = EmbeddingText.Chunks("T", sentences);
        Assert.EndsWith(". ", bySentence[0].Own, StringComparison.Ordinal);
        var words = string.Join(' ', Enumerable.Repeat("word", 2000));
        Assert.EndsWith(" ", EmbeddingText.Chunks("T", words)[0].Own, StringComparison.Ordinal);
        // At most 200 chunks a page.
        Assert.Equal(EmbeddingText.MaxChunks, EmbeddingText.Chunks("T", new string('x', 1_000_000)).Count);
        // Deterministic: a prefix long enough cuts its first chunks alike.
        var full = EmbeddingText.Chunks("T", sentences);
        var prefix = EmbeddingText.Chunks("T", sentences[..((2 + 2) * EmbeddingText.Target)]);
        Assert.Equal(full[1].Own, prefix[1].Own);
        Assert.True(EmbeddingText.Snippet(sentences).Length <= 200);
    }

    [Fact]
    public void Voyage_is_sent_its_own_field_names_and_its_answer_is_read_by_index()
    {
        var body = JsonSerializer.SerializeToElement(VoyageProvider.Body(new EmbeddingCall(["a", "b"], EmbeddingCall.Document, "voyage-4", "pa-secret-key-0000000000")));
        Assert.Equal(["input", "input_type", "model", "output_dimension", "output_dtype", "truncation"], body.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal));
        Assert.Equal(1024, body.GetProperty("output_dimension").GetInt32());
        Assert.Equal("int8", body.GetProperty("output_dtype").GetString());
        Assert.True(body.GetProperty("truncation").GetBoolean());
        Assert.DoesNotContain("pa-secret", body.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("pa-secret", new EmbeddingCall(["a"], "query", "voyage-4", "pa-secret-key-0000000000").ToString(), StringComparison.Ordinal);

        var vector = new JsonArray(Enumerable.Range(0, 1024).Select(i => (JsonNode?)JsonValue.Create(i % 256 - 128)).ToArray());
        var answer = new JsonObject
        {
            ["object"] = "list",
            ["data"] = new JsonArray(
                new JsonObject { ["object"] = "embedding", ["embedding"] = vector.DeepClone(), ["index"] = 1 },
                new JsonObject { ["object"] = "embedding", ["embedding"] = vector.DeepClone(), ["index"] = 0 }),
            ["model"] = "voyage-4",
            ["usage"] = new JsonObject { ["total_tokens"] = 12 },
        };
        var read = VoyageProvider.Read(JsonSerializer.SerializeToElement(answer), 2, TimeSpan.Zero);
        Assert.Equal(12, read.Tokens);
        Assert.Equal(-128, read.Vectors[0][0]);
        Assert.Equal(127, read.Vectors[1][255]);
        answer["data"]!.AsArray().RemoveAt(0);
        Assert.Throws<AiProviderException>(() => VoyageProvider.Read(JsonSerializer.SerializeToElement(answer), 2, TimeSpan.Zero));

        // The integer dot product the search scores with.
        var x = Enumerable.Range(0, 1024).Select(i => (sbyte)(i % 7 - 3)).ToArray();
        var y = Enumerable.Range(0, 1024).Select(i => (sbyte)(i % 11 - 5)).ToArray();
        Assert.Equal(x.Zip(y).Sum(p => p.First * p.Second), VectorMath.Dot(x, y));
    }

    [Fact]
    public async Task A_real_embedding_when_a_voyage_key_is_set_in_the_environment()
    {
        var key = Environment.GetEnvironmentVariable("VOYAGE_API_KEY");
        Assert.SkipWhen(string.IsNullOrEmpty(key), "Set VOYAGE_API_KEY to run three small embeddings against Voyage's API");
        var options = EmbeddingsOptions.From(new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), production: true);
        var provider = new VoyageProvider(options, new HttpClient());
        var documents = await provider.EmbedAsync(new EmbeddingCall(
            [$"{EmbedKit.RefundTitle}\n\n{EmbedKit.RefundText}", $"{EmbedKit.HolidayTitle}\n\n{EmbedKit.HolidayText}", "سياسة الاسترداد\n\nيمكن للعملاء إرجاع البضائع خلال 30 يومًا واسترداد أموالهم كاملة."],
            EmbeddingCall.Document, "voyage-4", key!), TestContext.Current.CancellationToken);
        var question = await provider.EmbedAsync(new EmbeddingCall([EmbedKit.RefundQuestion], EmbeddingCall.Query, "voyage-4", key!), TestContext.Current.CancellationToken);
        Assert.Equal(3, documents.Vectors.Count);
        Assert.All(documents.Vectors, v => Assert.Equal(1024, v.Length));
        Assert.True(documents.Tokens > 0);
        float Cosine(sbyte[] a, sbyte[] b) => VectorMath.Dot(a, b) / (VectorMath.Norm(a) * VectorMath.Norm(b));
        var refund = Cosine(question.Vectors[0], documents.Vectors[0]);
        var holiday = Cosine(question.Vectors[0], documents.Vectors[1]);
        var arabic = Cosine(question.Vectors[0], documents.Vectors[2]);
        TestContext.Current.SendDiagnosticMessage($"voyage-4 cosine: refund {refund:0.000}, holiday {holiday:0.000}, Arabic refund {arabic:0.000}; floor {options.FloorOf("voyage-4"):0.00}");
        Assert.True(refund > holiday, $"refund {refund} holiday {holiday}");
        Assert.True(refund >= options.FloorOf("voyage-4"), $"refund {refund}");
        Assert.True(arabic >= options.FloorOf("voyage-4"), $"Arabic {arabic}");
    }
}
