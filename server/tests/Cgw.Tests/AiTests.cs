using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cgw.Core.Ai;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>Steps the AI tests share: a workspace with AI on, completions read line by line, the mock provider's record.</summary>
public static class AiKit
{
    /// <summary>A key of its own for each test, so the mock's record of it is that test's alone.</summary>
    public static string NewKey() => "sk-test-" + Guid.NewGuid().ToString("N");

    /// <summary>How the mock names a key: the first 16 hex digits of its SHA-256.</summary>
    public static string KeyId(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];

    public static async Task<HttpResponseMessage> Put(HttpClient client, Guid workspace, object body) =>
        await client.PutAsJsonAsync($"/api/v1/workspaces/{workspace}/ai-settings", body);

    public static async Task<JsonElement> Settings(HttpClient client, Guid workspace) =>
        await client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{workspace}/ai-settings");

    /// <summary>Turns AI on for a workspace with a fresh key (as its owner), and gives the key.</summary>
    public static async Task<string> TurnOn(Ws ws, string? model = null)
    {
        var key = NewKey();
        var response = await Put(ws.Client, ws.Id, model is null ? new { enabled = true, apiKey = key } : new { enabled = true, apiKey = key, model });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return key;
    }

    public static Task<HttpResponseMessage> Complete(HttpClient client, object body) =>
        client.PostAsJsonAsync("/api/v1/ai/complete", body);

    public static object Body(Ws ws, string action, Guid? pageId, object input, string language = "en") =>
        new { workspaceId = ws.Id, action, pageId, language, input };

    /// <summary>The NDJSON stream's lines.</summary>
    public static async Task<List<JsonElement>> Lines(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/x-ndjson", response.Content.Headers.ContentType?.MediaType);
        var text = await response.Content.ReadAsStringAsync();
        return text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => JsonDocument.Parse(l).RootElement.Clone()).ToList();
    }

    public static string Text(IEnumerable<JsonElement> lines) =>
        string.Concat(lines.Where(l => l.GetProperty("type").GetString() == "text").Select(l => l.GetProperty("text").GetString()));

    private static readonly HttpClient Mock = new();

    /// <summary>What the mock provider was sent with this key, oldest first.</summary>
    public static async Task<List<JsonElement>> Sent(ServerFixture server, string key)
    {
        var all = await Mock.GetFromJsonAsync<JsonElement>($"{server.AiMockUrl}/__mock/requests?keyId={KeyId(key)}");
        return all.GetProperty("requests").EnumerateArray().Select(r => r.Clone()).ToList();
    }

    public static async Task Script(ServerFixture server, string key, object script)
    {
        var json = JsonSerializer.SerializeToElement(script);
        var body = new Dictionary<string, object?> { ["keyId"] = KeyId(key) };
        foreach (var p in json.EnumerateObject()) body[p.Name] = p.Value;
        var response = await Mock.PostAsJsonAsync($"{server.AiMockUrl}/__mock/script", body);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    public static async Task Fault(ServerFixture server, string key, object fault)
    {
        var json = JsonSerializer.SerializeToElement(fault);
        var body = new Dictionary<string, object?> { ["keyId"] = KeyId(key) };
        foreach (var p in json.EnumerateObject()) body[p.Name] = p.Value;
        var response = await Mock.PostAsJsonAsync($"{server.AiMockUrl}/__mock/fault", body);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    /// <summary>The user message the provider was sent, as text.</summary>
    public static string UserText(JsonElement request)
    {
        var content = request.GetProperty("body").GetProperty("messages")[0].GetProperty("content");
        return content.ValueKind == JsonValueKind.String
            ? content.GetString()!
            : string.Concat(content.EnumerateArray().Where(b => b.GetProperty("type").GetString() == "text").Select(b => b.GetProperty("text").GetString()));
    }

    public static string SystemText(JsonElement request)
    {
        var system = request.GetProperty("body").GetProperty("system");
        return system.ValueKind == JsonValueKind.String
            ? system.GetString()!
            : string.Concat(system.EnumerateArray().Select(b => b.GetProperty("text").GetString()));
    }
}

/// <summary>
/// AI on the server (INTEGRATIONS.md, AI, As agreed for 0.7.0): settings and the key, the off
/// switch, what each completion sends, permission filtering for <c>ask</c>, the stream, metering and
/// audit, provider failures. The provider is the mock in <c>tests/mocks/ai</c>, reached through
/// Anthropic's own SDK as in production.
/// </summary>
public sealed class AiTests(ServerFixture server)
{
    [Fact]
    public async Task Ai_is_off_until_an_owner_or_admin_turns_it_on_with_a_key_and_the_key_is_never_shown()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");

        // Off by default; members see the state, never the key's details.
        var seen = await AiKit.Settings(member.Client, ws.Id);
        Assert.False(seen.GetProperty("enabled").GetBoolean());
        Assert.Equal("anthropic", seen.GetProperty("provider").GetString());
        Assert.Equal("claude-opus-5-5", seen.GetProperty("model").GetString());
        Assert.Equal(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], seen.GetProperty("models").EnumerateArray().Select(m => m.GetString()));
        Assert.False(seen.TryGetProperty("hasKey", out _));
        Assert.False(seen.TryGetProperty("usage", out _));
        var owners = await AiKit.Settings(ws.Client, ws.Id);
        Assert.False(owners.GetProperty("hasKey").GetBoolean());
        Assert.Equal(0, owners.GetProperty("usage").GetProperty("requests").GetInt32());

        // Only owners and admins change it; on needs a key; a key and a model are checked.
        var key = AiKit.NewKey();
        foreach (var other in new[] { member, guest })
        {
            var refused = await AiKit.Put(other.Client, ws.Id, new { enabled = true, apiKey = key });
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("access.denied", await Kit.Code(refused));
        }
        var noKey = await AiKit.Put(ws.Client, ws.Id, new { enabled = true });
        Assert.Equal(HttpStatusCode.BadRequest, noKey.StatusCode);
        Assert.Equal("ai.keyMissing", await Kit.Code(noKey));
        foreach (var bad in new object[] { new { apiKey = "short" }, new { apiKey = "has spaces in it, a lot of them" }, new { apiKey = 42 }, new { model = "gpt-9" } })
        {
            var refused = await AiKit.Put(ws.Client, ws.Id, bad);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/ai-settings")).StatusCode);

        var on = await AiKit.Put(admin.Client, ws.Id, new { enabled = true, apiKey = key, model = "claude-sonnet-5-5" });
        var onText = await on.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.OK, on.StatusCode);
        Assert.DoesNotContain(key, onText);
        var settings = JsonDocument.Parse(onText).RootElement;
        Assert.True(settings.GetProperty("enabled").GetBoolean());
        Assert.True(settings.GetProperty("hasKey").GetBoolean());
        Assert.Equal(admin.Id, settings.GetProperty("keySetBy").GetProperty("id").GetGuid());
        Assert.Equal("claude-sonnet-5-5", settings.GetProperty("model").GetString());
        foreach (var reader in new[] { ws.Account, admin, member, guest })
        {
            var text = await reader.Client.GetStringAsync($"/api/v1/workspaces/{ws.Id}/ai-settings");
            Assert.DoesNotContain(key, text);
            Assert.DoesNotContain(key[^8..], text);
            Assert.True(JsonDocument.Parse(text).RootElement.GetProperty("enabled").GetBoolean());
        }
        // Changing the model keeps the key.
        Assert.True((await AiKit.Put(ws.Client, ws.Id, new { model = "claude-haiku-5-5" })).IsSuccessStatusCode);
        Assert.True((await AiKit.Settings(ws.Client, ws.Id)).GetProperty("hasKey").GetBoolean());

        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.AiSettings.SingleAsync();
            Assert.NotNull(row.KeyCipher);
            Assert.DoesNotContain(key, row.KeyCipher);
            Assert.DoesNotContain(key[8..], row.KeyCipher);
            // The cipher opens for its own workspace only.
            var keys = server.Api.Services.GetRequiredService<AiKeys>();
            Assert.Equal(key, keys.Unprotect(ws.Id, row.KeyCipher));
            Assert.Null(keys.Unprotect(Guid.CreateVersion7(), row.KeyCipher));
            var audits = await db.AuditLog.Where(a => a.Action == "ai.settings").ToListAsync();
            Assert.Equal(2, audits.Count);
            Assert.All(audits, a => Assert.DoesNotContain(key[8..], a.Detail ?? ""));
            Assert.Contains(audits, a => a.ActorUserId == admin.Id && a.Detail!.Contains("\"key\":\"set\""));
        }

        // Removing the key turns AI off.
        var removed = JsonDocument.Parse(await (await AiKit.Put(ws.Client, ws.Id, new { apiKey = (string?)null })).Content.ReadAsStringAsync()).RootElement;
        Assert.False(removed.GetProperty("enabled").GetBoolean());
        Assert.False(removed.GetProperty("hasKey").GetBoolean());
        var off = await AiKit.Complete(member.Client, AiKit.Body(ws, "generatePage", null, new { prompt = "A plan" }));
        Assert.Equal(HttpStatusCode.Forbidden, off.StatusCode);
        Assert.Equal("ai.disabled", await Kit.Code(off));
        Assert.Empty(await AiKit.Sent(server, key));
        await using (var db = server.NewDb(ws.Id))
            Assert.Contains(await db.AuditLog.Where(a => a.Action == "ai.settings").Select(a => a.Detail).ToListAsync(), d => d!.Contains("\"key\":\"removed\""));
    }

    [Fact]
    public async Task With_ai_off_nothing_is_built_or_sent_for_any_action()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Off")).GetProperty("id").GetGuid();
        var key = AiKit.NewKey();
        // A key is set, but AI is not turned on.
        Assert.True((await AiKit.Put(ws.Client, ws.Id, new { apiKey = key })).IsSuccessStatusCode);
        var inputs = new (string Action, object Input)[]
        {
            ("rewrite", new { text = "Hello", instruction = "improve" }),
            ("summarise", new { text = "Hello" }),
            ("actionItems", new { text = "Hello" }),
            ("generatePage", new { prompt = "Hello" }),
            ("generateDatabase", new { prompt = "Hello" }),
            ("ask", new { question = "Off" }),
            ("erpChanges", new { instruction = "x" }),
        };
        foreach (var (action, input) in inputs)
        {
            var response = await AiKit.Complete(ws.Client, AiKit.Body(ws, action, page, input));
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal("ai.disabled", await Kit.Code(response));
        }
        // Off on this server: the same, for a workspace that has it on.
        Assert.True((await AiKit.Put(ws.Client, ws.Id, new { enabled = true })).IsSuccessStatusCode);
        await using var api = server.Variant(b => b.UseSetting("Ai:Enabled", "false"));
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, ws.Account.Email, ws.Account.Password);
        Assert.False((await AiKit.Settings(client, ws.Id)).GetProperty("enabled").GetBoolean());
        var serverOff = await AiKit.Complete(client, AiKit.Body(ws, "rewrite", page, new { text = "Hello", instruction = "improve" }));
        Assert.Equal(HttpStatusCode.Forbidden, serverOff.StatusCode);
        Assert.Equal("ai.disabled", await Kit.Code(serverOff));
        Assert.Empty(await AiKit.Sent(server, key));
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(0, await db.AiUsage.CountAsync());
    }

    [Fact]
    public async Task A_rewrite_streams_sends_only_its_fields_and_is_metered_and_audited_without_content()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Letter")).GetProperty("id").GetGuid();
        var key = await AiKit.TurnOn(ws);

        var response = await AiKit.Complete(member.Client, AiKit.Body(ws, "rewrite", page,
            new { text = "Dear team, the plan is late.", instruction = "improve", secret = "Not-For-The-Model-7731", target = "ar", prompt = "ignored too" }));
        var lines = await AiKit.Lines(response);
        Assert.Equal("start", lines[0].GetProperty("type").GetString());
        Assert.True(Guid.TryParse(lines[0].GetProperty("requestId").GetString(), out var requestId));
        Assert.Equal("claude-opus-5-5", lines[0].GetProperty("model").GetString());
        Assert.Equal("[rewritten] Dear team, the plan is late.", AiKit.Text(lines));
        var done = lines[^1];
        Assert.Equal("done", done.GetProperty("type").GetString());
        Assert.Equal("end", done.GetProperty("stopReason").GetString());
        var outputTokens = done.GetProperty("usage").GetProperty("outputTokens").GetInt64();
        Assert.True(outputTokens > 0);

        // What reached the provider: the workspace's model, adaptive thinking, low effort, the
        // fallback, the fixed instructions and the selected text. Nothing else the client sent.
        var sent = Assert.Single(await AiKit.Sent(server, key));
        var body = sent.GetProperty("body");
        Assert.Equal("claude-opus-5-5", body.GetProperty("model").GetString());
        Assert.True(body.GetProperty("stream").GetBoolean());
        Assert.Equal("adaptive", body.GetProperty("thinking").GetProperty("type").GetString());
        Assert.Equal("low", body.GetProperty("output_config").GetProperty("effort").GetString());
        Assert.False(body.GetProperty("output_config").TryGetProperty("format", out _));
        Assert.Equal("default", body.GetProperty("fallbacks").GetString());
        Assert.Contains("server-side-fallback-2026-07-01", sent.GetProperty("beta").EnumerateArray().Select(b => b.GetString()));
        Assert.Equal("<text>\nDear team, the plan is late.\n</text>", AiKit.UserText(sent));
        Assert.StartsWith("Cash Gear Workspace AI task: rewrite.", AiKit.SystemText(sent));
        var all = sent.GetRawText();
        Assert.DoesNotContain("Not-For-The-Model-7731", all);
        Assert.DoesNotContain("ignored too", all);
        Assert.DoesNotContain("Letter", all);
        Assert.Equal(["content", "role"], body.GetProperty("messages")[0].EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal));
        Assert.Single(body.GetProperty("messages").EnumerateArray());

        await using var db = server.NewDb(ws.Id);
        var usage = await db.AiUsage.SingleAsync();
        Assert.Equal(("rewrite", "ok", (Guid?)member.Id, (Guid?)page), (usage.Action, usage.Outcome, usage.UserId, usage.PageId));
        Assert.Equal(outputTokens, usage.OutputTokens);
        Assert.True(usage.InputTokens > 0);
        var audit = await db.AuditLog.SingleAsync(a => a.Action == "ai.complete");
        Assert.Equal(member.Id, audit.ActorUserId);
        Assert.Equal(page, audit.TargetId);
        Assert.Contains(requestId.ToString("D"), audit.Detail);
        Assert.DoesNotContain("Dear team", audit.Detail);
        Assert.DoesNotContain("rewritten", audit.Detail);
        Assert.Equal(1, (await AiKit.Settings(ws.Client, ws.Id)).GetProperty("usage").GetProperty("requests").GetInt32());
    }

    [Fact]
    public async Task Each_action_asks_for_its_own_answer_and_haiku_runs_without_the_fallback()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Notes")).GetProperty("id").GetGuid();
        var key = await AiKit.TurnOn(ws, "claude-haiku-5-5");

        var items = await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "actionItems", page, new { text = "TODO: call the bank\nLunch was good" })));
        Assert.Equal("""{"items":[{"text":"call the bank"}]}""", AiKit.Text(items));
        var database = await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "generateDatabase", null, new { prompt = "Tasks" }, "ar")));
        Assert.Equal("Generated: Tasks", JsonDocument.Parse(AiKit.Text(database)).RootElement.GetProperty("name").GetString());
        var generated = await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "generatePage", page, new { prompt = "Onboarding" })));
        Assert.StartsWith("# Onboarding", AiKit.Text(generated));

        var sent = await AiKit.Sent(server, key);
        Assert.Equal(["actionItems", "generateDatabase", "generatePage"], sent.Select(s => s.GetProperty("action").GetString()));
        foreach (var request in sent)
        {
            var body = request.GetProperty("body");
            Assert.Equal("claude-haiku-5-5", body.GetProperty("model").GetString());
            Assert.False(body.TryGetProperty("fallbacks", out _));
            Assert.DoesNotContain("server-side-fallback-2026-07-01", request.GetProperty("beta").EnumerateArray().Select(b => b.GetString()));
        }
        var format = sent[0].GetProperty("body").GetProperty("output_config").GetProperty("format");
        Assert.Equal("json_schema", format.GetProperty("type").GetString());
        Assert.Equal("items", format.GetProperty("schema").GetProperty("required")[0].GetString());
        Assert.Equal("medium", sent[1].GetProperty("body").GetProperty("output_config").GetProperty("effort").GetString());
        Assert.Contains("Write names and values in Arabic", AiKit.SystemText(sent[1]));
        Assert.Contains("Write in English", AiKit.SystemText(sent[2]));
    }

    [Fact]
    public async Task Ask_sends_only_the_pages_the_person_can_read()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var word = "Quillwort" + Random.Shared.Next(1000, 9999);
        var shared = (await ws.NewPage($"{word} plan")).GetProperty("id").GetGuid();
        var restricted = (await ws.NewPage($"{word} salaries", orderKey: "a1")).GetProperty("id").GetGuid();
        await Kit.Share(ws, restricted, true);
        var mine = (await ws.NewPage($"{word} diary", section: ws.Personal)).GetProperty("id").GetGuid();
        var binned = (await ws.NewPage($"{word} old", orderKey: "a2")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", binned, new { }));
        var elsewhere = await Ws.Create(server, ws.Account);
        await elsewhere.NewPage($"{word} elsewhere");
        var key = await AiKit.TurnOn(ws);

        var lines = await AiKit.Lines(await AiKit.Complete(member.Client, AiKit.Body(ws, "ask", null, new { question = $"What does the {word} say?" })));
        var sources = lines.Single(l => l.GetProperty("type").GetString() == "sources").GetProperty("pages").EnumerateArray().ToList();
        Assert.Equal(shared, Assert.Single(sources).GetProperty("pageId").GetGuid());
        Assert.Contains("[1]", AiKit.Text(lines));
        var sent = Assert.Single(await AiKit.Sent(server, key));
        var user = AiKit.UserText(sent);
        Assert.Contains($"Title: {word} plan", user);
        foreach (var hidden in new[] { "salaries", "diary", "old", "elsewhere" })
            Assert.DoesNotContain($"{word} {hidden}", sent.GetRawText());
        Assert.Equal("medium", sent.GetProperty("body").GetProperty("output_config").GetProperty("effort").GetString());

        // The owner reads the restricted page and their own private one.
        var owners = await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "ask", null, new { question = word })));
        var ownerSources = owners.Single(l => l.GetProperty("type").GetString() == "sources").GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("pageId").GetGuid()).ToHashSet();
        Assert.Equal(new HashSet<Guid> { shared, restricted, mine }, ownerSources);

        // Nothing found: nothing is sent, and the answer is empty.
        var nothing = await AiKit.Lines(await AiKit.Complete(member.Client, AiKit.Body(ws, "ask", null, new { question = "Xylophonequark" + Guid.NewGuid().ToString("N")[..6] })));
        Assert.Empty(nothing.Single(l => l.GetProperty("type").GetString() == "sources").GetProperty("pages").EnumerateArray());
        Assert.Equal("done", nothing[^1].GetProperty("type").GetString());
        Assert.Equal(2, (await AiKit.Sent(server, key)).Count);

        // Guests do not use the workspace's AI.
        var byGuest = await AiKit.Complete(guest.Client, AiKit.Body(ws, "ask", null, new { question = word }));
        Assert.Equal(HttpStatusCode.Forbidden, byGuest.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(byGuest));
    }

    [Fact]
    public async Task A_page_and_the_input_are_checked_before_anything_is_sent()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var key = await AiKit.TurnOn(ws);
        var open = (await ws.NewPage("Open")).GetProperty("id").GetGuid();
        var hidden = (await ws.NewPage("Hidden", section: ws.Personal)).GetProperty("id").GetGuid();
        var other = await Ws.Create(server, ws.Account);
        var foreign = (await other.NewPage("Foreign")).GetProperty("id").GetGuid();

        async Task Refused(HttpClient client, object body, HttpStatusCode status, string code)
        {
            var response = await AiKit.Complete(client, body);
            Assert.Equal(status, response.StatusCode);
            Assert.Equal(code, await Kit.Code(response));
        }
        var rewrite = new { text = "Hello", instruction = "improve" };
        await Refused(member.Client, AiKit.Body(ws, "rewrite", hidden, rewrite), HttpStatusCode.NotFound, "not.found");
        await Refused(member.Client, AiKit.Body(ws, "rewrite", foreign, rewrite), HttpStatusCode.NotFound, "not.found");
        await Refused(member.Client, AiKit.Body(ws, "rewrite", null, rewrite), HttpStatusCode.BadRequest, "request.invalid");
        await Refused(member.Client, AiKit.Body(ws, "translateEverything", open, rewrite), HttpStatusCode.BadRequest, "request.invalid");
        await Refused(member.Client, AiKit.Body(ws, "rewrite", open, rewrite, "fr"), HttpStatusCode.BadRequest, "request.invalid");
        await Refused(member.Client, AiKit.Body(ws, "rewrite", open, new { text = "Hello", instruction = "rhyme" }), HttpStatusCode.BadRequest, "request.invalid");
        await Refused(member.Client, AiKit.Body(ws, "rewrite", open, new { text = "Hello", instruction = "translate", target = "fr" }), HttpStatusCode.BadRequest, "request.invalid");
        await Refused(member.Client, AiKit.Body(ws, "rewrite", open, new { text = "  ", instruction = "improve" }), HttpStatusCode.BadRequest, "request.invalid");
        await Refused(member.Client, AiKit.Body(ws, "rewrite", open, new { text = new string('a', 20_001), instruction = "improve" }), HttpStatusCode.RequestEntityTooLarge, "limit.size");
        await Refused(member.Client, AiKit.Body(ws, "summarise", open, new { text = new string('a', 100_001) }), HttpStatusCode.RequestEntityTooLarge, "limit.size");
        await Refused(member.Client, AiKit.Body(ws, "ask", null, new { question = new string('a', 1_001) }), HttpStatusCode.RequestEntityTooLarge, "limit.size");
        await Refused(member.Client, AiKit.Body(ws, "generatePage", null, new { prompt = new string('a', 4_001) }), HttpStatusCode.RequestEntityTooLarge, "limit.size");
        await Refused(member.Client, AiKit.Body(ws, "summarise", open, "just text"), HttpStatusCode.BadRequest, "request.invalid");
        await Refused(member.Client, AiKit.Body(ws, "summarise", open, new { text = new string('a', 1_100_000) }), HttpStatusCode.RequestEntityTooLarge, "limit.size");
        var outsider = await server.NewAccount();
        await Refused(outsider.Client, AiKit.Body(ws, "generatePage", null, new { prompt = "x" }), HttpStatusCode.NotFound, "not.found");
        Assert.Empty(await AiKit.Sent(server, key));
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(0, await db.AiUsage.CountAsync());
    }

    [Fact]
    public async Task Provider_failures_are_problems_before_the_stream_and_error_lines_after()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Faults")).GetProperty("id").GetGuid();
        var rewrite = AiKit.Body(ws, "rewrite", page, new { text = "Hello there", instruction = "shorter" });

        // A key the provider refuses.
        var invalid = "sk-mock-invalid-" + Guid.NewGuid().ToString("N");
        Assert.True((await AiKit.Put(ws.Client, ws.Id, new { enabled = true, apiKey = invalid })).IsSuccessStatusCode);
        var refusedKey = await AiKit.Complete(ws.Client, rewrite);
        Assert.Equal(HttpStatusCode.BadGateway, refusedKey.StatusCode);
        Assert.Equal("ai.keyInvalid", await Kit.Code(refusedKey));
        Assert.DoesNotContain(invalid[16..], await refusedKey.Content.ReadAsStringAsync());

        var key = await AiKit.TurnOn(ws);
        // Busy after the SDK's own two retries.
        await AiKit.Fault(server, key, new { status = 429, times = 3 });
        var busy = await AiKit.Complete(ws.Client, rewrite);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, busy.StatusCode);
        Assert.Equal("ai.limit", await Kit.Code(busy));
        Assert.NotNull(busy.Headers.RetryAfter);
        await AiKit.Fault(server, key, new { status = 500, times = 3 });
        var down = await AiKit.Complete(ws.Client, rewrite);
        Assert.Equal(HttpStatusCode.BadGateway, down.StatusCode);
        Assert.Equal("ai.provider", await Kit.Code(down));

        // After the stream began: an error line.
        await AiKit.Script(server, key, new { text = "one two three four five six seven eight nine ten", chunkDelayMs = 20 });
        await AiKit.Fault(server, key, new { drop = "after" });
        var dropped = await AiKit.Lines(await AiKit.Complete(ws.Client, rewrite));
        Assert.Equal("ai.provider", dropped[^1].GetProperty("code").GetString());
        await AiKit.Script(server, key, new { refusal = true });
        var refused = await AiKit.Lines(await AiKit.Complete(ws.Client, rewrite));
        Assert.Equal(("error", "ai.refused"), (refused[^1].GetProperty("type").GetString(), refused[^1].GetProperty("code").GetString()));
        Assert.Equal("", AiKit.Text(refused));
        await AiKit.Script(server, key, new { text = "cut short", stopReason = "max_tokens" });
        var cut = await AiKit.Lines(await AiKit.Complete(ws.Client, rewrite));
        Assert.Equal("length", cut[^1].GetProperty("stopReason").GetString());

        await using var db = server.NewDb(ws.Id);
        Assert.Equal(["ai.keyInvalid", "ai.limit", "ai.provider", "ai.provider", "refused", "length"],
            await db.AiUsage.OrderBy(u => u.CreatedAt).Select(u => u.Outcome).ToListAsync());
    }

    [Fact]
    public async Task A_completion_streams_as_it_comes_and_one_the_person_leaves_is_metered_as_cancelled()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Long")).GetProperty("id").GetGuid();
        var key = await AiKit.TurnOn(ws);
        await AiKit.Script(server, key, new { text = string.Join(' ', Enumerable.Range(1, 60).Select(n => $"word{n}")), chunkDelayMs = 150 });
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/ai/complete")
        {
            Content = JsonContent.Create(AiKit.Body(ws, "summarise", page, new { text = "A long page" })),
        };
        using var response = await ws.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        var stream = await response.Content.ReadAsStreamAsync(TestContext.Current.CancellationToken);
        using var reader = new StreamReader(stream);
        // The first lines arrive while the provider is still answering: the stream is not buffered.
        Assert.Contains("\"type\":\"start\"", await reader.ReadLineAsync(TestContext.Current.CancellationToken));
        Assert.Contains("\"type\":\"text\"", await reader.ReadLineAsync(TestContext.Current.CancellationToken));
        response.Dispose();

        var outcome = await Kit.Eventually(async () =>
        {
            await using var db = server.NewDb(ws.Id);
            return await db.AiUsage.Select(u => u.Outcome).FirstOrDefaultAsync();
        }, o => o is not null, TimeSpan.FromSeconds(30));
        Assert.Equal("cancelled", outcome);
    }

    [Fact]
    public async Task Erp_changes_send_only_the_named_members_of_fields_and_records()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Vendors")).GetProperty("id").GetGuid();
        var key = await AiKit.TurnOn(ws);
        var input = new
        {
            instruction = "Add (AI) to each name",
            connector = new { id = "vendors", schemaVersion = "vendors.1", token = "Session-Token-9981" },
            fields = new object[]
            {
                new { name = "vendorName", label = "Name", type = "text", maxLength = 150, required = true, editable = true, secret = "Field-Secret-4410" },
                new { name = "vendorGroup", label = "Group", type = "lookup", lookup = new[] { new { code = "LOCAL", label = "Local", hidden = "Lookup-Secret-1" } } },
            },
            records = new object[]
            {
                new { id = "1", key = "V-1001", version = "AAAAAAAAB9E=", values = new { vendorName = "Qorvath Lantern Trading", vendorGroup = "LOCAL" }, note = "Record-Secret-7" },
            },
            session = "Session-Token-9981",
        };
        var lines = await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "erpChanges", page, input)));
        var answer = JsonDocument.Parse(AiKit.Text(lines)).RootElement;
        var change = Assert.Single(answer.GetProperty("changes").EnumerateArray());
        Assert.Equal(("1", "vendorName", "Qorvath Lantern Trading (AI)"), (change.GetProperty("id").GetString(), change.GetProperty("field").GetString(), change.GetProperty("to").GetString()));

        var sent = Assert.Single(await AiKit.Sent(server, key));
        var all = sent.GetRawText();
        foreach (var secret in new[] { "Session-Token-9981", "Field-Secret-4410", "Lookup-Secret-1", "Record-Secret-7", "AAAAAAAAB9E=", "editable" })
            Assert.DoesNotContain(secret, all);
        Assert.Contains("Qorvath Lantern Trading", AiKit.UserText(sent));
        Assert.Contains("vendors (vendors.1)", AiKit.UserText(sent));
        Assert.Equal("changes", sent.GetProperty("body").GetProperty("output_config").GetProperty("format").GetProperty("schema").GetProperty("required")[0].GetString());
    }

    [Fact]
    public void The_ai_module_has_no_path_to_the_erp()
    {
        // No type of the Ai module names anything of the ERP links, integrations or workbooks.
        var types = typeof(AiService).Assembly.GetTypes().Where(t => t.Namespace == "Cgw.Core.Ai").ToList();
        Assert.NotEmpty(types);
        const System.Reflection.BindingFlags all = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic
            | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.DeclaredOnly;
        var named = types.SelectMany(t =>
                t.GetFields(all).Select(f => f.FieldType)
                    .Concat(t.GetProperties(all).Select(p => p.PropertyType))
                    .Concat(t.GetMethods(all).SelectMany(m => m.GetParameters().Select(p => p.ParameterType).Append(m.ReturnType)))
                    .Concat(t.GetConstructors(all).SelectMany(c => c.GetParameters().Select(p => p.ParameterType))))
            .SelectMany(t => t.IsGenericType ? t.GetGenericArguments().Append(t) : [t])
            .ToList();
        Assert.DoesNotContain(named, t => t.Namespace == "Cgw.Core.Workbooks");
        // The service's only collaborators: the database, access, search (by words and, Phase 10, by meaning), its key store and settings, the embeddings settings, (Phase 13) Cash Gear's subscription and its allowance, audit and a clock.
        Assert.Equal(
            ["Access", "AiAllowance", "AiKeys", "AiOptions", "AiSubscriptionOptions", "Audit", "CgwDb", "EmbeddingsService", "MeaningSearch", "SearchService", "TenantScope", "TimeProvider"],
            typeof(AiService).GetConstructors().Single().GetParameters().Select(p => p.ParameterType.Name).Order(StringComparer.Ordinal));
        // And no source of the module or its routes names the ERP's address, links or sessions.
        foreach (var file in Directory.EnumerateFiles(Path.Combine(server.Root, "server", "src", "Cgw.Core", "Ai"), "*.cs")
                     .Append(Path.Combine(server.Root, "server", "src", "Cgw.Api", "Modules", "AiEndpoints.cs")))
        {
            var source = File.ReadAllText(file);
            foreach (var word in new[] { "ErpApiBase", "Integrations", "ErpLink", "Erp:", "Erp__", "Connect-Session", "/Commit" })
                Assert.False(source.Contains(word, StringComparison.Ordinal), $"{Path.GetFileName(file)} names {word}");
        }
    }

    [Fact]
    public async Task A_real_completion_streams_when_a_key_is_set_in_the_environment()
    {
        var key = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY");
        Assert.SkipWhen(string.IsNullOrEmpty(key), "Set ANTHROPIC_API_KEY to run one small completion against Anthropic's API");
        var provider = new AnthropicProvider(AiOptions.From(new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), production: true), new HttpClient());
        var read = AiRequestBuilder.Read("rewrite", JsonDocument.Parse("""{"text":"the meeting are on monday","instruction":"fixGrammar"}""").RootElement);
        var call = new AiCall(AiRequestBuilder.Build(read.Value!, "en"), "claude-haiku-5-5", key!);
        var chunks = new List<AiChunk>();
        await foreach (var chunk in provider.CompleteAsync(call, TestContext.Current.CancellationToken)) chunks.Add(chunk);
        Assert.IsType<AiStarted>(chunks[0]);
        Assert.Contains("Monday", string.Concat(chunks.OfType<AiText>().Select(t => t.Text)));
        Assert.Equal(AiFinished.End, Assert.IsType<AiFinished>(chunks[^1]).StopReason);
    }
}
