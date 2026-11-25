using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Automations;

namespace Cgw.Tests;

/// <summary>
/// Phase 17, M17.2: the C# port of packages/workspace/src/db/recurrence.ts against
/// packages/workspace/vectors/db-recurrence-vectors.json: every day a rule falls on, the next one
/// after a day, and every rule the TypeScript refuses.
/// </summary>
public sealed class RecurrenceVectorTests(ServerFixture server)
{
    private JsonElement Vectors()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "vectors", "db-recurrence-vectors.json")));
        return doc.RootElement.Clone();
    }

    [Fact]
    public void Every_rule_falls_on_the_days_the_vectors_say()
    {
        var failures = new List<string>();
        var count = 0;
        foreach (var c in Vectors().GetProperty("cases").EnumerateArray())
        {
            count++;
            var name = c.GetProperty("name").GetString();
            var rule = Recurrence.Read(JsonNode.Parse(c.GetProperty("rule").GetRawText()));
            if (rule is null)
            {
                failures.Add($"{name}: refused");
                continue;
            }
            var first = c.GetProperty("first").GetString()!;
            if (c.TryGetProperty("next", out var next))
            {
                var expected = next.GetProperty("expected");
                var got = Recurrence.Next(rule, first, next.GetProperty("after").GetString()!);
                var want = expected.ValueKind == JsonValueKind.Null ? null : expected.GetString();
                if (got != want) failures.Add($"{name}: next {got ?? "null"}, expected {want ?? "null"}");
            }
            if (c.TryGetProperty("between", out var between))
            {
                var want = between.GetProperty("expected").EnumerateArray().Select(d => d.GetString()!).ToList();
                var got = Recurrence.Between(rule, first, between.GetProperty("from").GetString()!, between.GetProperty("to").GetString()!);
                if (!got.SequenceEqual(want)) failures.Add($"{name}: {string.Join(",", got)}, expected {string.Join(",", want)}");
            }
        }
        Assert.True(count >= 19, $"only {count} cases");
        Assert.Empty(failures);
    }

    [Fact]
    public void Every_rule_the_vectors_refuse_is_refused()
    {
        var failures = new List<string>();
        foreach (var c in Vectors().GetProperty("refused").EnumerateArray())
            if (Recurrence.Read(JsonNode.Parse(c.GetProperty("rule").GetRawText())) is not null)
                failures.Add($"{c.GetProperty("name").GetString()}: kept");
        Assert.Empty(failures);
    }
}
