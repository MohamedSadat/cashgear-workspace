using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Databases;

namespace Cgw.Tests;

/// <summary>
/// Phase 12, M12.1 on the server: the seventh view type, and what a build that knows fewer types
/// may change of a chart view (DatabaseOps' older-build rule read by <c>viewTypes</c> as a count):
/// 0.9.0 to 0.11.0 (six types) keep a chart they send back as a table and its <c>chart</c>
/// settings; a build before 0.9.0 (none sent) keeps a chart, a timeline and both settings; a build of
/// seven is taken as it sends.
/// </summary>
public sealed class ChartViewTests(ServerFixture server)
{
    private static readonly JsonArray Properties = new(
        DatabaseTests.Prop("pNum0001", "number", "Hours"),
        DatabaseTests.Prop("pText001", "text", "Note"),
        DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = DatabaseTests.Options(("optA0001", "A"), ("optB0001", "B")) }));

    private static JsonObject Config(object? filter = null, JsonObject? extra = null, bool wrap = false)
    {
        var config = new JsonObject
        {
            ["filter"] = JsonSerializer.SerializeToNode(filter),
            ["sorts"] = new JsonArray(),
            ["group"] = new JsonObject { ["propertyId"] = "pSel0001", ["hideEmpty"] = true },
            ["properties"] = new JsonObject { ["order"] = new JsonArray(), ["hidden"] = new JsonArray("pText001"), ["widths"] = new JsonObject() },
        };
        if (wrap) config["wrap"] = true;
        foreach (var (key, value) in extra ?? []) config[key] = value?.DeepClone();
        return config;
    }

    private static JsonObject Chart => new()
    {
        ["kind"] = "pie",
        ["measure"] = new JsonObject { ["kind"] = "sum", ["propertyId"] = "pNum0001" },
        ["title"] = "Hours by stage",
    };

    private static JsonObject Timeline => new() { ["start"] = "pStart01", ["scale"] = "month" };

    private static async Task<JsonElement> Upsert(Ws ws, Guid id, Guid database, string type, JsonObject config, int? viewTypes)
    {
        var payload = new JsonObject
        {
            ["id"] = id.ToString(),
            ["workspaceId"] = ws.Id.ToString(),
            ["databaseId"] = database.ToString(),
            ["name"] = "Hours",
            ["type"] = type,
            ["orderKey"] = "a0",
            ["version"] = 1,
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["config"] = config,
        };
        if (viewTypes is { } n) payload["viewTypes"] = n;
        var result = (await ws.Push(ws.Op("view.upsert", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return result.GetProperty("entity").GetProperty("view");
    }

    private static readonly object NoteFilter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pText001", @operator = "isNotEmpty" } } };

    [Fact]
    public async Task A_six_type_build_keeps_a_chart_it_sends_back_as_a_table_and_its_chart_settings()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Effort", Properties.DeepClone().AsArray());
        var id = Guid.CreateVersion7();
        var made = await Upsert(ws, id, database, "chart", Config(extra: new JsonObject { ["chart"] = Chart }, wrap: true), 7);
        Assert.Equal("chart", made.GetProperty("type").GetString());

        // 0.11.0 drew it as a table, changed its filter, turned wrap off (a key it knows) and sent it
        // back without the chart's settings, which it does not know.
        var kept = await Upsert(ws, id, database, "table", Config(NoteFilter), 6);
        Assert.Equal("chart", kept.GetProperty("type").GetString());
        var config = kept.GetProperty("config");
        Assert.Equal("pie", config.GetProperty("chart").GetProperty("kind").GetString());
        Assert.Equal("pNum0001", config.GetProperty("chart").GetProperty("measure").GetProperty("propertyId").GetString());
        Assert.Equal("Hours by stage", config.GetProperty("chart").GetProperty("title").GetString());
        Assert.Equal("isNotEmpty", config.GetProperty("filter").GetProperty("children")[0].GetProperty("operator").GetString());
        Assert.False(config.TryGetProperty("wrap", out _));
        // What another device reads is the same.
        var listed = (await ws.Tree()).GetProperty("views").EnumerateArray().Single(v => v.GetProperty("id").GetGuid() == id);
        Assert.Equal("chart", listed.GetProperty("type").GetString());
        Assert.Equal("pie", listed.GetProperty("config").GetProperty("chart").GetProperty("kind").GetString());

        // A real change of type by it is taken, the chart's settings kept; once it is a type it knows, its table is a table.
        var board = await Upsert(ws, id, database, "board", Config(NoteFilter), 6);
        Assert.Equal("board", board.GetProperty("type").GetString());
        Assert.Equal("pie", board.GetProperty("config").GetProperty("chart").GetProperty("kind").GetString());
        Assert.Equal("table", (await Upsert(ws, id, database, "table", Config(NoteFilter), 6)).GetProperty("type").GetString());

        // A stored timeline is one a six-type build knows: its table is a table, its timeline settings as it sends them.
        var timeline = Guid.CreateVersion7();
        await Upsert(ws, timeline, database, "timeline", Config(extra: new JsonObject { ["timeline"] = Timeline, ["chart"] = Chart }), 7);
        var asTable = await Upsert(ws, timeline, database, "table", Config(), 6);
        Assert.Equal("table", asTable.GetProperty("type").GetString());
        Assert.False(asTable.GetProperty("config").TryGetProperty("timeline", out _));
        Assert.Equal("pie", asTable.GetProperty("config").GetProperty("chart").GetProperty("kind").GetString());
    }

    [Fact]
    public async Task A_build_without_view_types_keeps_a_chart_a_timeline_and_both_settings()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Effort", Properties.DeepClone().AsArray());
        var both = new JsonObject { ["chart"] = Chart, ["timeline"] = Timeline };
        var chart = Guid.CreateVersion7();
        var timeline = Guid.CreateVersion7();
        await Upsert(ws, chart, database, "chart", Config(extra: both), 7);
        await Upsert(ws, timeline, database, "timeline", Config(extra: both), 7);

        foreach (var (id, type) in new[] { (chart, "chart"), (timeline, "timeline") })
        {
            var kept = await Upsert(ws, id, database, "table", Config(NoteFilter), null);
            Assert.Equal(type, kept.GetProperty("type").GetString());
            var config = kept.GetProperty("config");
            Assert.Equal("pie", config.GetProperty("chart").GetProperty("kind").GetString());
            Assert.Equal("month", config.GetProperty("timeline").GetProperty("scale").GetString());
            Assert.Equal("isNotEmpty", config.GetProperty("filter").GetProperty("children")[0].GetProperty("operator").GetString());
        }
        // Not a positive whole number is as none sent.
        foreach (var odd in new JsonNode?[] { 0, -3, 6.5, "7" })
        {
            var payload = Config(NoteFilter);
            var id = chart;
            var view = new JsonObject
            {
                ["id"] = id.ToString(), ["workspaceId"] = ws.Id.ToString(), ["databaseId"] = database.ToString(), ["name"] = "Hours", ["type"] = "table",
                ["orderKey"] = "a0", ["version"] = 1, ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"), ["config"] = payload, ["viewTypes"] = odd?.DeepClone(),
            };
            var result = (await ws.Push(ws.Op("view.upsert", id, view)))[0];
            Assert.Equal("chart", result.GetProperty("entity").GetProperty("view").GetProperty("type").GetString());
        }
    }

    [Fact]
    public async Task A_seven_type_build_is_taken_as_it_sends()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Effort", Properties.DeepClone().AsArray());
        var id = Guid.CreateVersion7();
        await Upsert(ws, id, database, "chart", Config(extra: new JsonObject { ["chart"] = Chart }), 7);
        var table = await Upsert(ws, id, database, "table", Config(), 7);
        Assert.Equal("table", table.GetProperty("type").GetString());
        Assert.False(table.GetProperty("config").TryGetProperty("chart", out _));
        // And a later build (more types than this server knows) too.
        await Upsert(ws, id, database, "chart", Config(extra: new JsonObject { ["chart"] = Chart }), 7);
        Assert.Equal("table", (await Upsert(ws, id, database, "table", Config(), 9)).GetProperty("type").GetString());
    }

    /// <summary>The rule's vectors: what a build of N types, sending a type and some settings, leaves of a stored view.</summary>
    [Theory]
    // known types, stored type, sent type, expected type
    [InlineData(5, "chart", "table", "chart")]
    [InlineData(5, "timeline", "table", "timeline")]
    [InlineData(5, "gallery", "table", "table")]
    [InlineData(5, "chart", "list", "list")]
    [InlineData(6, "chart", "table", "chart")]
    [InlineData(6, "timeline", "table", "table")]
    [InlineData(6, "chart", "timeline", "timeline")]
    [InlineData(6, "board", "table", "table")]
    [InlineData(3, "timeline", "table", "timeline")]
    public void An_older_builds_table_keeps_only_a_type_it_cannot_know(int known, string stored, string sent, string expected)
    {
        var view = new Cgw.Core.Data.DatabaseView { Type = stored, Config = "{}" };
        Assert.Equal(expected, DatabaseOps.KeepWhatOlderBuildsDrop(view, sent, "{}", known).Type);
    }

    [Fact]
    public void The_settings_a_build_of_n_types_knows_are_kept_only_when_it_cannot_know_them()
    {
        Assert.Equal(7, DatabaseOps.ViewTypeOrder.Length);
        Assert.Equal("chart", DatabaseOps.ViewTypeOrder[^1]);
        Assert.Contains("chart", DatabaseOps.ViewTypes);
        Assert.True(DatabaseOps.ConfigKeysKnownBy(5).SetEquals(["filter", "sorts", "group", "properties", "calendarBy", "cover", "cardSize", "wrap"]));
        Assert.True(DatabaseOps.OlderConfigKeys.SetEquals(DatabaseOps.ConfigKeysKnownBy(5)));
        Assert.True(DatabaseOps.ConfigKeysKnownBy(6).SetEquals([.. DatabaseOps.OlderConfigKeys, "timeline"]));
        Assert.True(DatabaseOps.ConfigKeysKnownBy(7).SetEquals([.. DatabaseOps.OlderConfigKeys, "timeline", "chart"]));
        Assert.True(DatabaseOps.ConfigKeysKnownBy(2).SetEquals(DatabaseOps.OlderConfigKeys));

        var stored = new Cgw.Core.Data.DatabaseView
        {
            Type = "chart",
            Config = """{"filter":null,"sorts":[],"wrap":true,"timeline":{"start":"p1"},"chart":{"kind":"line"},"later":{"x":1}}""",
        };
        // A build of N types, then whether the stored timeline, chart and later settings are kept.
        foreach (var (known, timeline, chart, later) in new[] { (5, true, true, true), (6, false, true, true), (7, false, false, true) })
        {
            var (type, config) = DatabaseOps.KeepWhatOlderBuildsDrop(stored, "table", """{"filter":null,"sorts":[]}""", known);
            var json = JsonNode.Parse(config)!.AsObject();
            Assert.Equal(known < 7 ? "chart" : "table", type);
            Assert.Equal(timeline, json.ContainsKey("timeline"));
            Assert.Equal(chart, json.ContainsKey("chart"));
            Assert.Equal(later, json.ContainsKey("later"));
            // Every build knows wrap: it dropped it.
            Assert.False(json.ContainsKey("wrap"));
        }
        // What it sends of a key it does not know (an import of an export, say) wins.
        var (_, sent) = DatabaseOps.KeepWhatOlderBuildsDrop(stored, "table", """{"chart":{"kind":"bar"}}""", 6);
        Assert.Equal("bar", JsonNode.Parse(sent)!["chart"]!["kind"]!.GetValue<string>());

        static int Known(string json) => DatabaseOps.KnownViewTypes(JsonDocument.Parse(json).RootElement);
        Assert.Equal(5, Known("{}"));
        Assert.Equal(5, Known("""{"viewTypes":null}"""));
        Assert.Equal(5, Known("""{"viewTypes":0}"""));
        Assert.Equal(5, Known("""{"viewTypes":-1}"""));
        Assert.Equal(5, Known("""{"viewTypes":6.5}"""));
        Assert.Equal(5, Known("""{"viewTypes":"7"}"""));
        Assert.Equal(5, Known("""{"viewTypes":3}"""));
        Assert.Equal(6, Known("""{"viewTypes":6}"""));
        Assert.Equal(7, Known("""{"viewTypes":7}"""));
        Assert.Equal(12, Known("""{"viewTypes":12}"""));
    }
}
