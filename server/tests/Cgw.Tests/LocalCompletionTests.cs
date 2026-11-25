using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Ai;
using Cgw.LocalModel;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 18, M18.1: completions written on this server by its own model, through the same
/// <c>AiRequestBuilder</c> and stream as Anthropic's, with smaller limits, JSON held to the action's
/// schema while it is written, one answer at a time and the rest in line, and no text leaving the
/// host. The tests run the stand-in (<c>tests/fixtures/completion-model</c>: GenAI's own runtime and
/// guidance over a byte-level vocabulary, its answer fixed by its weights: double quotes until its
/// limit, an empty answer of the schema's shape); the real model's answers are the spike's and the
/// bench's (<c>Phase18LocalModelBench</c>).
/// </summary>
public sealed class LocalCompletionTests(ServerFixture server)
{
    private static readonly string Model = CompletionModelOptions.Model;

    /// <summary>A workspace on the server's own model, with no key.</summary>
    private static async Task<Ws> OnLocal(ServerFixture server)
    {
        var ws = await Ws.Create(server);
        var on = await AiKit.Put(ws.Client, ws.Id, new { enabled = true, model = Model });
        Assert.True(on.IsSuccessStatusCode, await on.Content.ReadAsStringAsync());
        return ws;
    }

    /// <summary>Whether any request the mock provider took (any test's) holds this text.</summary>
    private static async Task<bool> MockSaw(ServerFixture server, string marker)
    {
        using var http = new HttpClient();
        return (await http.GetStringAsync($"{server.AiMockUrl}/__mock/requests")).Contains(marker, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_servers_own_model_is_offered_with_no_key_and_its_answer_streams_in_english_and_arabic()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws);

        // Offered last, beside Anthropic's; chosen with no key at all, and on.
        var before = await AiKit.Settings(ws.Client, ws.Id);
        Assert.Contains(Model, before.GetProperty("models").EnumerateArray().Select(m => m.GetString()));
        var on = await AiKit.Put(ws.Client, ws.Id, new { enabled = true, model = Model });
        Assert.True(on.IsSuccessStatusCode, await on.Content.ReadAsStringAsync());
        var settings = await Kit.Json(on);
        Assert.True(settings.GetProperty("enabled").GetBoolean());
        Assert.Equal("local", settings.GetProperty("provider").GetString());
        Assert.Equal(Model, settings.GetProperty("model").GetString());
        Assert.False(settings.GetProperty("hasKey").GetBoolean());
        Assert.Equal(AiLimits.Local.RewriteText, settings.GetProperty("limits").GetProperty("rewriteText").GetInt32());

        // A member's rewrite, in either language: start, text as it is written, done, metered as the local model's.
        var marker = Guid.NewGuid().ToString("N");
        foreach (var language in new[] { "en", "ar" })
        {
            var text = (language == "ar" ? "اجتمع الفريق يوم الأحد لمناقشة المستودع الجديد. " : "The team met on Sunday about the new warehouse. ") + marker;
            var lines = await AiKit.Lines(await AiKit.Complete(member.Client, AiKit.Body(ws, "rewrite", page, new { text, instruction = "improve" }, language)));
            Assert.Equal("start", lines[0].GetProperty("type").GetString());
            Assert.Equal(Model, lines[0].GetProperty("model").GetString());
            Assert.True(lines.Count(l => l.GetProperty("type").GetString() == "text") > 1);
            var done = lines[^1];
            Assert.Equal("done", done.GetProperty("type").GetString());
            // The stand-in writes until its limit: the local limit of a rewrite's answer.
            Assert.Equal("length", done.GetProperty("stopReason").GetString());
            Assert.Equal(AiLimits.Local.OutputTokens("rewrite", "low"), done.GetProperty("usage").GetProperty("outputTokens").GetInt32());
            Assert.True(done.GetProperty("usage").GetProperty("inputTokens").GetInt32() > 0);
            Assert.DoesNotContain('�', AiKit.Text(lines));
        }
        // No text left the host: the mock provider (Anthropic's and Voyage's stand-in) never saw it.
        Assert.False(await MockSaw(server, marker));
        await using var db = server.NewDb(ws.Id);
        var usage = db.AiUsage.Where(u => u.Action == "rewrite").ToList();
        Assert.Equal(2, usage.Count);
        Assert.All(usage, u => Assert.Equal(Model, u.Model));
        Assert.All(usage, u => Assert.False(u.Subscription));
    }

    [Fact]
    public async Task A_json_actions_answer_holds_to_its_schema_while_it_is_written()
    {
        var ws = await OnLocal(server);
        var page = await Kit.PageWithText(server, ws);

        var items = AiKit.Text(await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "actionItems", page, new { text = "Khalid calls the supplier. Sara collects the scanners." }))));
        Assert.Equal(JsonValueKind.Array, JsonDocument.Parse(items).RootElement.GetProperty("items").ValueKind);

        var database = AiKit.Text(await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "generateDatabase", null, new { prompt = "Barcode scanners and who holds them" }, "ar"))));
        var shape = JsonDocument.Parse(database).RootElement;
        Assert.Equal(JsonValueKind.String, shape.GetProperty("name").ValueKind);
        Assert.Equal(JsonValueKind.Array, shape.GetProperty("properties").ValueKind);
        Assert.Equal(JsonValueKind.Array, shape.GetProperty("rows").ValueKind);

        var erp = AiKit.Text(await AiKit.Lines(await AiKit.Complete(ws.Client, AiKit.Body(ws, "erpChanges", page, new
        {
            instruction = "Set the payment terms to 60 days",
            connector = new { id = "vendors", schemaVersion = "1" },
            fields = new[] { new { name = "paymentTerms", type = "text" } },
            records = new[] { new { id = "V-1", key = "V-1", values = new { paymentTerms = "NET30" } } },
        }))));
        Assert.Equal(JsonValueKind.Array, JsonDocument.Parse(erp).RootElement.GetProperty("changes").ValueKind);
    }

    [Fact]
    public async Task The_local_models_smaller_limits_hold_and_anthropics_are_as_they_were()
    {
        var ws = await OnLocal(server);
        var page = await Kit.PageWithText(server, ws);
        var tooLong = await AiKit.Complete(ws.Client, AiKit.Body(ws, "rewrite", page, new { text = new string('a', AiLimits.Local.RewriteText + 1), instruction = "improve" }));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLong.StatusCode);
        var problem = await Kit.Json(tooLong);
        Assert.Equal("limit.size", problem.GetProperty("code").GetString());
        Assert.Equal(AiLimits.Local.RewriteText, problem.GetProperty("limit").GetInt32());
        var summary = await AiKit.Complete(ws.Client, AiKit.Body(ws, "summarise", page, new { text = new string('b', AiLimits.Local.PageText + 1) }));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, summary.StatusCode);

        // The builder: each action's answer's tokens are the local model's own; Anthropic's unchanged.
        var rewrite = AiRequestBuilder.Read("rewrite", JsonSerializer.SerializeToElement(new { text = "x", instruction = "improve" })).Value!;
        Assert.Equal(16_000, AiRequestBuilder.Build(rewrite, "en").MaxTokens);
        Assert.Equal(2_048, AiRequestBuilder.Build(rewrite, "en", null, AiLimits.Local).MaxTokens);
        var ask = new AskInput("When?");
        var sources = Enumerable.Range(1, 8).Select(n => new AiSource(n, Guid.NewGuid(), "Page " + n, new string('c', 5_000))).ToList();
        var local = AiRequestBuilder.Build(ask, "en", sources, AiLimits.Local);
        Assert.Equal(AiLimits.Local.Sources, local.User.Split("<page number=").Length - 1);
        Assert.DoesNotContain(new string('c', AiLimits.Local.SourceText + 1), local.User, StringComparison.Ordinal);
        Assert.Equal(8, AiRequestBuilder.Build(ask, "en", sources).User.Split("<page number=").Length - 1);
        // A database: fewer properties and example rows asked of the local model; Anthropic's as in 0.7.0.
        var database = new PromptInput(AiActions.GenerateDatabase, "Scanners");
        Assert.Contains("at most 12 properties and at most 10 example rows", AiRequestBuilder.Build(database, "en", null, AiLimits.Local).System, StringComparison.Ordinal);
        Assert.Contains("at most 20 properties and at most 100 example rows", AiRequestBuilder.Build(database, "en").System, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Answers_wait_their_turn_in_order_and_past_the_line_are_refused()
    {
        var api = server.Variant(b => b.UseSetting("Ai:CompletionModel:Queue", "1"));
        var ws = await OnLocal(server);
        var page = await Kit.PageWithText(server, ws);
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, ws.Account.Email, ws.Account.Password);
        var provider = api.Services.GetRequiredService<LocalCompletionProvider>();
        object Rewrite(bool queued) => new
        {
            workspaceId = ws.Id, action = "rewrite", pageId = page, language = "en",
            input = new { text = "The racking arrived on time.", instruction = "improve" },
            events = queued ? new[] { "queued" } : null,
        };

        // The first is written; the second waits, told it is next; the third finds the line full.
        var first = client.PostAsJsonAsync("/api/v1/ai/complete", Rewrite(false));
        for (var i = 0; i < 200 && !provider.IsLoaded; i++) await Task.Delay(50);
        var second = client.PostAsJsonAsync("/api/v1/ai/complete", Rewrite(true));
        for (var i = 0; i < 200 && provider.Waiting == 0; i++) await Task.Delay(10);
        var full = await client.PostAsJsonAsync("/api/v1/ai/complete", Rewrite(true));
        if (provider.Waiting == 1)
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, full.StatusCode);
            Assert.Equal("ai.limit", (await Kit.Json(full)).GetProperty("code").GetString());
        }
        var firstLines = await AiKit.Lines(await first);
        var secondLines = await AiKit.Lines(await second);
        Assert.Equal("done", firstLines[^1].GetProperty("type").GetString());
        Assert.Equal("done", secondLines[^1].GetProperty("type").GetString());
        // Only the client that asked for it is told where it waits; the one before 0.18.0 never is.
        Assert.DoesNotContain(firstLines, l => l.GetProperty("type").GetString() == "queued");
        var queued = secondLines.Where(l => l.GetProperty("type").GetString() == "queued").ToList();
        Assert.NotEmpty(queued);
        Assert.Equal(1, queued[0].GetProperty("ahead").GetInt32());
        Assert.True(secondLines.IndexOf(queued[0]) < secondLines.FindIndex(l => l.GetProperty("type").GetString() == "text"));
        Assert.Equal(0, provider.Waiting);
    }

    [Fact]
    public void A_package_is_loaded_only_as_pinned_and_never_a_test_package_in_production()
    {
        var folder = Path.Combine(server.Root, "tests", "fixtures", "completion-model");
        Assert.Null(LocalCompletionProvider.Check(folder, production: false).Problem);
        Assert.Equal("a test package is refused in Production", LocalCompletionProvider.Check(folder, production: true).Problem);
        var copy = Path.Combine(Path.GetTempPath(), "cgw-completion-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(copy);
        try
        {
            foreach (var file in Directory.GetFiles(folder)) File.Copy(file, Path.Combine(copy, Path.GetFileName(file)));
            File.AppendAllText(Path.Combine(copy, "genai_config.json"), " ");
            Assert.Equal("genai_config.json is not the file pinned for it", LocalCompletionProvider.Check(copy, production: false).Problem);
        }
        finally
        {
            Directory.Delete(copy, recursive: true);
        }
        Assert.Equal("qwen35", LocalCompletionProvider.Check(folder, false).Manifest!.Family);
        var request = new AiRequest("rewrite", "Rules.", "<text>\nHi\n</text>", "low", 10, null);
        Assert.Equal("<|im_start|>system\nRules.<|im_end|>\n<|im_start|>user\n<text>\nHi\n</text><|im_end|>\n<|im_start|>assistant\n", LocalCompletionProvider.Prompt("qwen", request));
        // Qwen3.5's turn opens with an empty think block: it answers without thinking first.
        Assert.EndsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n", LocalCompletionProvider.Prompt("qwen35", request), StringComparison.Ordinal);
    }
}
