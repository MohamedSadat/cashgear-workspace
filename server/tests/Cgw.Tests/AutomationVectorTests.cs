using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Automations;
using Cgw.Core.Databases;

namespace Cgw.Tests;

/// <summary>
/// Phase 15: the C# port of packages/workspace/src/db/automations.ts against
/// packages/workspace/vectors/db-automation-vectors.json: every rule kept as the TypeScript keeps
/// it, or refused for the same reason, and every change read as starting a trigger or not.
/// </summary>
public sealed class AutomationVectorTests(ServerFixture server)
{
    private JsonElement Vectors()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "vectors", "db-automation-vectors.json")));
        return doc.RootElement.Clone();
    }

    private static Dictionary<string, object> Map(JsonElement e)
    {
        var map = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var p in e.EnumerateObject())
            if (Raw.From(p.Value) is { } value) map[p.Name] = value;
        return map;
    }

    [Fact]
    public void Every_rule_is_kept_or_refused_as_the_vectors_say()
    {
        var v = Vectors();
        var db = DatabaseVectorTests.Database(v.GetProperty("database"));
        var workspace = v.GetProperty("database").GetProperty("workspaceId").GetString()!;
        var failures = new List<string>();
        var count = 0;
        foreach (var c in v.GetProperty("check").EnumerateArray())
        {
            count++;
            var name = c.GetProperty("name").GetString();
            var rule = JsonNode.Parse(c.GetProperty("rule").GetRawText());
            var expected = c.GetProperty("expected");
            try
            {
                var kept = AutomationRules.Check(rule, db, workspace, _ => null);
                if (!expected.TryGetProperty("rule", out var want)) failures.Add($"{name}: kept, expected {expected}");
                else if (!JsonNode.DeepEquals(kept, JsonNode.Parse(want.GetRawText()))) failures.Add($"{name}: kept {kept.ToJsonString()}, expected {want}");
            }
            catch (AutomationInvalid refused)
            {
                if (!expected.TryGetProperty("reason", out var want) || want.GetString() != refused.Reason)
                    failures.Add($"{name}: refused for {refused.Reason} ({refused.Message}), expected {expected}");
            }
        }
        Assert.True(count > 50, $"only {count} cases");
        Assert.Empty(failures);
    }

    [Fact]
    public void Every_change_starts_a_trigger_or_not_as_the_vectors_say()
    {
        var v = Vectors();
        var db = DatabaseVectorTests.Database(v.GetProperty("database"));
        var ctx = v.GetProperty("ctx");
        var context = new QueryContext(ctx.GetProperty("today").GetString()!, ctx.GetProperty("offsetMinutes").GetDouble(), ctx.GetProperty("me").GetString(), null);
        var failures = new List<string>();
        var count = 0;
        foreach (var c in v.GetProperty("starts").EnumerateArray())
        {
            count++;
            var change = c.GetProperty("change");
            var row = new RowChange(
                change.GetProperty("kind").GetString()!,
                [.. change.GetProperty("changed").EnumerateArray().Select(x => x.GetString()!)],
                Map(change.GetProperty("before")),
                Map(change.GetProperty("after")),
                change.TryGetProperty("propertyId", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null);
            var trigger = (JsonObject)JsonNode.Parse(c.GetProperty("trigger").GetRawText())!;
            var starts = AutomationRules.Starts(trigger, db, row, context);
            if (starts != c.GetProperty("expected").GetBoolean()) failures.Add($"{c.GetProperty("name").GetString()}: {starts}");
        }
        Assert.True(count > 20, $"only {count} cases");
        Assert.Empty(failures);
    }
}
