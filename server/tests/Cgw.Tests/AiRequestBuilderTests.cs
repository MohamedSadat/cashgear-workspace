using System.Text.Json;
using Cgw.Core.Ai;
using Microsoft.Extensions.Configuration;

namespace Cgw.Tests;

/// <summary>
/// The one place a model's request is built (INTEGRATIONS.md, AI): each action's request holds its
/// fixed instructions and the input fields its table names, and nothing else the client sent.
/// </summary>
public sealed class AiRequestBuilderTests
{
    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static AiRequest Build(string action, object input, string language = "en", IReadOnlyList<AiSource>? sources = null)
    {
        var read = AiRequestBuilder.Read(action, Json(input));
        Assert.True(read.Ok, read.Failure?.Title);
        return AiRequestBuilder.Build(read.Value!, language, sources);
    }

    private const string Extra = "Smuggled-Field-5521";

    [Fact]
    public void Every_action_holds_its_marker_its_fields_and_nothing_else()
    {
        var cases = new (string Action, object Input, string User, string Effort, bool Json)[]
        {
            ("rewrite", new { text = "Fix me", instruction = "fixGrammar", extra = Extra, target = "ar", prompt = "no" }, "<text>\nFix me\n</text>", "low", false),
            ("rewrite", new { text = "Fix me", instruction = "custom", prompt = "As a poem", extra = Extra }, "<text>\nFix me\n</text>\n<request>\nAs a poem\n</request>", "low", false),
            ("summarise", new { text = "A long page", extra = Extra }, "<text>\nA long page\n</text>", "low", false),
            ("actionItems", new { text = "TODO: call", extra = Extra }, "<text>\nTODO: call\n</text>", "low", true),
            ("generatePage", new { prompt = "A plan", extra = Extra }, "<request>\nA plan\n</request>", "medium", false),
            ("generateDatabase", new { prompt = "Tasks", extra = Extra }, "<request>\nTasks\n</request>", "medium", true),
            ("ask", new { question = "Where?", extra = Extra }, "<question>\nWhere?\n</question>", "medium", false),
        };
        foreach (var (action, input, user, effort, json) in cases)
        {
            var request = Build(action, input);
            Assert.Equal(action, request.Action);
            Assert.StartsWith($"Cash Gear Workspace AI task: {action}.\n", request.System);
            Assert.Equal(user, request.User);
            Assert.Equal(effort, request.Effort);
            Assert.Equal(json, request.Schema is not null);
            Assert.Equal(effort == "low" ? 16_000 : 32_000, request.MaxTokens);
            Assert.DoesNotContain(Extra, request.System + request.User);
        }
    }

    [Fact]
    public void Rewrite_instructions_say_what_was_asked_and_translation_names_its_language()
    {
        Assert.Contains("Translate the text into Arabic.", Build("rewrite", new { text = "Hi", instruction = "translate", target = "ar" }).System);
        Assert.Contains("Translate the text into English.", Build("rewrite", new { text = "مرحبا", instruction = "translate", target = "en" }).System);
        Assert.Contains("Make the text shorter", Build("rewrite", new { text = "Hi", instruction = "shorter" }).System);
        Assert.Contains("Expand the text", Build("rewrite", new { text = "Hi", instruction = "longer" }).System);
        Assert.Contains("Improve the clarity", Build("rewrite", new { text = "Hi", instruction = "improve" }).System);
        Assert.Contains("spelling, grammar and punctuation only", Build("rewrite", new { text = "Hi", instruction = "fixGrammar" }).System);
        Assert.Contains("Write in Arabic", Build("generatePage", new { prompt = "x" }, "ar").System);
        Assert.Contains("Write in English", Build("generatePage", new { prompt = "x" }, "en").System);
    }

    [Fact]
    public void Ask_numbers_its_sources_cuts_each_to_its_limit_and_takes_at_most_eight()
    {
        var sources = Enumerable.Range(1, 10).Select(n => new AiSource(n, Guid.CreateVersion7(), $"Page {n}\nwith a break", new string('x', 9_000))).ToList();
        var request = Build("ask", new { question = "Which?" }, sources: sources);
        Assert.Contains("<page number=\"1\">\nTitle: Page 1 with a break\n\n", request.User);
        Assert.Contains("<page number=\"8\">", request.User);
        Assert.DoesNotContain("<page number=\"9\">", request.User);
        Assert.DoesNotContain(new string('x', 8_001), request.User);
        Assert.Contains(new string('x', 8_000) + "\n</page>", request.User);
    }

    [Fact]
    public void Erp_changes_keep_only_the_named_members_of_fields_lookups_and_records()
    {
        var request = Build("erpChanges", new
        {
            instruction = "Raise it",
            connector = new { id = "vendors", schemaVersion = "vendors.1", token = Extra },
            fields = new object[]
            {
                new { name = "debit", label = "Limit", type = "decimal", scale = 2, min = "0", max = 99, required = false, editable = true, editReason = Extra },
                new { name = "group", label = "Group", type = "lookup", lookup = new[] { new { code = "A", label = "Alpha", active = false, x = Extra } } },
            },
            records = new object[] { new { id = "7", key = "V-7", version = Extra, values = new { debit = "1.00", group = "A", flag = true, none = (string?)null } } },
            session = Extra,
        });
        Assert.DoesNotContain(Extra, request.System + request.User);
        Assert.Contains("""[{"name":"debit","label":"Limit","type":"decimal","required":false,"scale":2,"min":"0","max":99},{"name":"group","label":"Group","type":"lookup","lookup":[{"code":"A","label":"Alpha"}]}]""", request.User);
        Assert.Contains("""[{"id":"7","key":"V-7","values":{"debit":"1.00","group":"A","flag":true,"none":null}}]""", request.User);
        Assert.Contains("<connector>\nvendors (vendors.1)\n</connector>", request.User);
        Assert.Equal("changes", request.Schema!.Value.GetProperty("required")[0].GetString());
    }

    [Fact]
    public void Inputs_that_break_the_rules_are_refused_and_long_ones_are_too_large()
    {
        void Refused(string action, object input, int status)
        {
            var read = AiRequestBuilder.Read(action, Json(input));
            Assert.False(read.Ok);
            Assert.Equal(status, read.Failure!.Status);
            Assert.Equal(status == 413 ? "limit.size" : "request.invalid", read.Failure.Code);
        }
        Refused("rewrite", new { text = "x" }, 400);
        Refused("rewrite", new { text = "x", instruction = "custom" }, 400);
        Refused("rewrite", new { text = "x", instruction = "custom", prompt = new string('p', 1_001) }, 413);
        Refused("rewrite", new { text = 5, instruction = "improve" }, 400);
        Refused("summarise", new { }, 400);
        Refused("actionItems", new { text = new string('t', 100_001) }, 413);
        Refused("generateDatabase", new { prompt = "" }, 400);
        Refused("ask", new { question = new string('q', 1_001) }, 413);
        Refused("erpChanges", new { instruction = "x" }, 400);
        var field = new { name = "a", label = "A", type = "text" };
        var record = new { id = "1", key = "K", values = new { a = "v" } };
        Refused("erpChanges", new { instruction = "x", connector = new { id = "v", schemaVersion = "v.1" }, fields = new[] { new { name = "a", label = "A", type = "money" } }, records = new[] { record } }, 400);
        Refused("erpChanges", new { instruction = "x", connector = new { id = "v", schemaVersion = "v.1" }, fields = new[] { field, field }, records = new[] { record } }, 400);
        Refused("erpChanges", new { instruction = "x", connector = new { id = "v w", schemaVersion = "v.1" }, fields = new[] { field }, records = new[] { record } }, 400);
        Refused("erpChanges", new { instruction = "x", connector = new { id = "v", schemaVersion = "v.1" }, fields = new[] { field }, records = new[] { new { id = "1", key = "K", values = new { a = new { nested = 1 } } } } }, 400);
        Refused("erpChanges", new { instruction = "x", connector = new { id = "v", schemaVersion = "v.1" }, fields = new[] { field }, records = Enumerable.Repeat(record, 501).ToArray() }, 400);
        Refused("erpChanges", new { instruction = "x", connector = new { id = "v", schemaVersion = "v.1" }, fields = new[] { field }, records = new[] { new { id = "1", key = "K", values = new { a = new string('v', 410_000) } } } }, 413);
        Refused("nonsense", new { }, 400);
    }

    [Fact]
    public void The_answers_shapes_are_strict_json_schemas()
    {
        foreach (var schema in new[] { AiRequestBuilder.ActionItemsSchema, AiRequestBuilder.DatabaseSchema, AiRequestBuilder.ErpChangesSchema })
        {
            Assert.Equal("object", schema.GetProperty("type").GetString());
            Assert.False(schema.GetProperty("additionalProperties").GetBoolean());
        }
        Assert.Equal(AiRequestBuilder.DatabaseTypes,
            AiRequestBuilder.DatabaseSchema.GetProperty("properties").GetProperty("properties").GetProperty("items").GetProperty("properties").GetProperty("type").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
    }

    /// <summary>Answers every request as a refused key, keeping where it went and how the key came.</summary>
    private sealed class Refusing : HttpMessageHandler
    {
        public readonly List<(Uri Uri, string? Auth)> Seen = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Seen.Add((request.RequestUri!, request.Headers.Authorization?.Scheme));
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized)
            {
                Content = new StringContent("""{"type":"error","error":{"type":"authentication_error","message":"invalid"}}""", System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    [Fact]
    public async Task In_production_the_key_goes_only_to_anthropic_whatever_the_settings_or_the_environment_say()
    {
        var settings = new Microsoft.Extensions.Configuration.ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Ai:AnthropicBaseUrl"] = "http://127.0.0.1:9/elsewhere",
            ["Ai:Enabled"] = "false",
            ["Ai:Models:0"] = "claude-sonnet-5-5",
            ["Ai:Models:1"] = "not a model!",
        }).Build();
        var production = AiOptions.From(settings, production: true);
        Assert.Null(production.AnthropicBaseUrl);
        Assert.False(production.Enabled);
        Assert.Equal(["claude-sonnet-5-5"], production.Models);
        Assert.Equal("http://127.0.0.1:9/elsewhere", AiOptions.From(settings, production: false).AnthropicBaseUrl);
        Assert.Equal(AiOptions.DefaultModels, AiOptions.From(new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), production: true).Models);

        // Whatever ANTHROPIC_BASE_URL this host has (Claude Code sets one), the call goes to Anthropic.
        var handler = new Refusing();
        var provider = new AnthropicProvider(production, new HttpClient(handler));
        var call = new AiCall(Build("summarise", new { text = "x" }), "claude-opus-5-5", "sk-test-" + new string('k', 30));
        var failed = await Assert.ThrowsAsync<AiProviderException>(async () =>
        {
            await foreach (var _ in provider.CompleteAsync(call, TestContext.Current.CancellationToken)) { }
        });
        Assert.Equal("ai.keyInvalid", failed.Code);
        var (uri, auth) = Assert.Single(handler.Seen);
        Assert.Equal("https://api.anthropic.com/v1/messages", uri.GetLeftPart(UriPartial.Path));
        Assert.Equal("Bearer", auth);
    }

    [Fact]
    public void A_call_never_shows_its_key()
    {
        var call = new AiCall(Build("summarise", new { text = "x" }), "claude-opus-5-5", "sk-test-Visible-Key-0001");
        Assert.DoesNotContain("Visible-Key", call.ToString());
        Assert.False(AiKeys.Plausible("short"));
        Assert.False(AiKeys.Plausible("sk-ant-with a space in the middle"));
        Assert.True(AiKeys.Plausible("sk-ant-api03-" + new string('a', 40)));
    }
}
