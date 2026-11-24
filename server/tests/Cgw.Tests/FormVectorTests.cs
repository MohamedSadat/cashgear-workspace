using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Databases;
using Cgw.Core.Forms;

namespace Cgw.Tests;

/// <summary>
/// Phase 16: the C# port of packages/workspace/src/db/forms.ts against
/// packages/workspace/vectors/db-form-vectors.json: every form read as the TypeScript reads it, every
/// answer kept or refused for the same problems, and the same pages shown.
/// </summary>
public sealed class FormVectorTests(ServerFixture server)
{
    private JsonElement Vectors()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "vectors", "db-form-vectors.json")));
        return doc.RootElement.Clone();
    }

    private static Dictionary<string, object?> Raw(JsonElement e) =>
        e.EnumerateObject().ToDictionary(p => p.Name, p => Cgw.Core.Databases.Raw.From(p.Value), StringComparer.Ordinal);

    private static QueryContext Context(JsonElement ctx) =>
        new(ctx.GetProperty("today").GetString()!, ctx.GetProperty("offsetMinutes").GetDouble(), null, null);

    private static FormConfig Named(JsonElement v, Schema db, string name, bool link) =>
        FormRules.Read(new JsonObject { ["form"] = JsonNode.Parse(v.GetProperty("forms").GetProperty(name).GetRawText()) }, db, link);

    [Fact]
    public void Every_form_is_read_as_the_vectors_say()
    {
        var v = Vectors();
        var db = DatabaseVectorTests.Database(v.GetProperty("database"));
        var failures = new List<string>();
        var count = 0;
        foreach (var c in v.GetProperty("read").EnumerateArray())
        {
            count++;
            var read = FormRules.Read(JsonNode.Parse(c.GetProperty("config").GetRawText()), db, c.GetProperty("mode").GetString() == "link");
            var want = JsonNode.Parse(c.GetProperty("expected").GetRawText());
            var got = FormRules.ToJson(read);
            if (!JsonNode.DeepEquals(got, want)) failures.Add($"{c.GetProperty("name").GetString()}: {got.ToJsonString()}");
        }
        Assert.True(count > 15, $"only {count} cases");
        Assert.Empty(failures);
    }

    [Fact]
    public void Every_answer_is_kept_or_refused_as_the_vectors_say()
    {
        var v = Vectors();
        var db = DatabaseVectorTests.Database(v.GetProperty("database"));
        var ctx = Context(v.GetProperty("ctx"));
        var failures = new List<string>();
        var count = 0;
        foreach (var c in v.GetProperty("answers").EnumerateArray())
        {
            count++;
            var name = c.GetProperty("name").GetString();
            var form = Named(v, db, c.GetProperty("form").GetString()!, c.GetProperty("mode").GetString() == "link");
            var upTo = c.TryGetProperty("upTo", out var u) ? u.GetInt32() : int.MaxValue;
            var (answer, problems) = FormRules.Check(form, db, Raw(c.GetProperty("raw")), ctx, upTo);
            var expected = c.GetProperty("expected");
            JsonNode got = answer is null
                ? new JsonObject { ["problems"] = new JsonArray(problems.Select(p => (JsonNode)new JsonObject { ["propertyId"] = p.PropertyId, ["reason"] = p.Reason }).ToArray()) }
                : new JsonObject
                {
                    ["answer"] = new JsonObject
                    {
                        ["title"] = answer.Title,
                        ["values"] = JsonNode.Parse(ValueJson.WriteMap(answer.Values)),
                        ["pages"] = new JsonArray(answer.Pages.Select(p => (JsonNode)JsonValue.Create(p)).ToArray()),
                    },
                };
            if (!JsonNode.DeepEquals(got, JsonNode.Parse(expected.GetRawText()))) failures.Add($"{name}: {got.ToJsonString()}");
        }
        Assert.True(count > 20, $"only {count} cases");
        Assert.Empty(failures);
    }

    [Fact]
    public void Every_page_shown_next_and_before_is_as_the_vectors_say()
    {
        var v = Vectors();
        var db = DatabaseVectorTests.Database(v.GetProperty("database"));
        var ctx = Context(v.GetProperty("ctx"));
        var failures = new List<string>();
        foreach (var c in v.GetProperty("pages").EnumerateArray())
        {
            var form = Named(v, db, c.GetProperty("form").GetString()!, true);
            var raw = Raw(c.GetProperty("raw"));
            var at = c.GetProperty("at").GetInt32();
            var got = c.GetProperty("kind").GetString() == "next" ? FormRules.Next(form, db, raw, ctx, at) : FormRules.Previous(form, db, raw, ctx, at);
            var expected = c.GetProperty("expected");
            int? want = expected.ValueKind == JsonValueKind.Null ? null : expected.GetInt32();
            if (got != want) failures.Add($"{c.GetProperty("name").GetString()}: {got}");
        }
        Assert.Empty(failures);
    }
}
