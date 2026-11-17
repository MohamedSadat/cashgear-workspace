using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Databases;

namespace Cgw.Tests;

/// <summary>
/// Phase 9, M9.2 on the server: the query's date window over the route (the rule itself is held to
/// the shared vectors by <see cref="DatabaseVectorTests"/>), the sixth view type, and what an older
/// build that meets a timeline view may and may not change.
/// </summary>
public sealed class TimelineTests(ServerFixture server)
{
    private static readonly JsonArray Properties = new(
        DatabaseTests.Prop("pStart01", "date", "Start"),
        DatabaseTests.Prop("pEnd0001", "date", "End"),
        DatabaseTests.Prop("pText001", "text", "Note"),
        DatabaseTests.Prop("pSel0001", "select", "Lane", new JsonObject { ["options"] = DatabaseTests.Options(("optA0001", "A"), ("optB0001", "B")) }));

    private static async Task<Guid> Row(Ws ws, Guid database, string title, object values)
    {
        var id = Guid.CreateVersion7();
        var payload = DatabaseTests.PageJson(id, ws.Id, ws.Shared, database, "a" + title, title, "row");
        payload["row"] = new JsonObject { ["values"] = JsonSerializer.SerializeToNode(values) };
        var result = (await ws.Push(ws.Op("page.create", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return id;
    }

    private static async Task<HttpResponseMessage> Query(Ws ws, Guid database, object body) =>
        await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/query", body);

    private static async Task<List<string>> Titles(Ws ws, Guid database, object body)
    {
        var response = await Query(ws, database, body);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return (await Kit.Json(response)).GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()!).Order(StringComparer.Ordinal).ToList();
    }

    private static object Window(string from, string to, string property = "pStart01", string? end = null) =>
        new { propertyId = property, endPropertyId = end, from, to };

    private static object Context(int offset = 0) => new { today = "2026-03-01", offsetMinutes = offset };

    [Fact]
    public async Task A_query_window_keeps_the_rows_whose_span_meets_it()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Plan", Properties.DeepClone().AsArray());
        await Row(ws, database, "A", new { pStart01 = new { start = "2026-03-01" }, pSel0001 = "optA0001" });
        await Row(ws, database, "B", new { pStart01 = new { start = "2026-02-20", end = "2026-03-02" }, pSel0001 = "optB0001" });
        await Row(ws, database, "C", new { pStart01 = new { start = "2026-03-10" }, pEnd0001 = new { start = "2026-03-20" } });
        await Row(ws, database, "D", new { pText001 = "no date" });
        await Row(ws, database, "E", new { pStart01 = new { start = "2026-04-01" } });
        // 23:30 UTC on the 5th: the 6th an hour east of UTC.
        await Row(ws, database, "F", new { pStart01 = new { start = "2026-03-05T23:30:00Z" } });
        // An end before its start is the start.
        await Row(ws, database, "G", new { pStart01 = new { start = "2026-03-08", end = "2026-01-01" } });

        Assert.Equal(["A", "B", "F"], await Titles(ws, database, new { window = Window("2026-03-01", "2026-03-05"), context = Context() }));
        Assert.Equal(["A", "B"], await Titles(ws, database, new { window = Window("2026-03-01", "2026-03-05"), context = Context(60) }));
        Assert.Equal(["G"], await Titles(ws, database, new { window = Window("2026-03-07", "2026-03-09"), context = Context() }));
        // The span reaches the end property's value when the row has one, else its own end.
        Assert.Equal(["C"], await Titles(ws, database, new { window = Window("2026-03-15", "2026-03-31", end: "pEnd0001"), context = Context() }));
        Assert.Empty(await Titles(ws, database, new { window = Window("2026-03-15", "2026-03-31"), context = Context() }));
        Assert.Equal(["B"], await Titles(ws, database, new { window = Window("2026-02-25", "2026-02-28", end: "pEnd0001"), context = Context() }));
        // A window on a property that is not a date, or not there, matches nothing; none matches all.
        Assert.Empty(await Titles(ws, database, new { window = Window("2000-01-01", "2099-12-31", "pText001"), context = Context() }));
        Assert.Empty(await Titles(ws, database, new { window = Window("2000-01-01", "2099-12-31", "nothere1"), context = Context() }));
        Assert.Equal(7, (await Titles(ws, database, new { window = (object?)null, context = Context() })).Count);
        // The undated rows are a query of their own: no window, the start empty.
        var undated = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pStart01", @operator = "isEmpty" } } };
        Assert.Equal(["D"], await Titles(ws, database, new { filter = undated, context = Context() }));

        // After the filter, before the groups: the counts count rows in the window.
        var grouped = await Kit.Json(await Query(ws, database, new { window = Window("2026-03-01", "2026-03-05"), group = new { propertyId = "pSel0001" }, context = Context() }));
        Assert.Equal([("", 1L), ("optA0001", 1L), ("optB0001", 1L)],
            grouped.GetProperty("groups").EnumerateArray().Select(g => (g.GetProperty("key").GetString()!, g.GetProperty("count").GetInt64())));
        Assert.Equal(3, grouped.GetProperty("total").GetInt64());

        // A window that does not read is refused.
        foreach (var bad in new object[] { "march", new { propertyId = "pStart01", from = "2026-3-1", to = "2026-03-05" }, new { from = "2026-03-01", to = "2026-03-05" }, new { propertyId = "pStart01", from = "2026-03-01", to = "2026-02-30" } })
        {
            var response = await Query(ws, database, new { window = bad, context = Context() });
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(response));
        }
    }

    // Views -------------------------------------------------------------------------------------------

    private static JsonObject Config(object? filter = null, JsonObject? extra = null)
    {
        var config = new JsonObject
        {
            ["filter"] = JsonSerializer.SerializeToNode(filter),
            ["sorts"] = new JsonArray(),
            ["group"] = null,
            ["properties"] = new JsonObject { ["order"] = new JsonArray(), ["hidden"] = new JsonArray(), ["widths"] = new JsonObject() },
        };
        foreach (var (key, value) in extra ?? []) config[key] = value?.DeepClone();
        return config;
    }

    private static JsonObject View(Ws ws, Guid id, Guid database, string type, JsonObject config, int? viewTypes)
    {
        var payload = new JsonObject
        {
            ["id"] = id.ToString(),
            ["workspaceId"] = ws.Id.ToString(),
            ["databaseId"] = database.ToString(),
            ["name"] = "Roadmap",
            ["type"] = type,
            ["orderKey"] = "a0",
            ["version"] = 1,
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["config"] = config,
        };
        if (viewTypes is { } n) payload["viewTypes"] = n;
        return payload;
    }

    private static async Task<JsonElement> Upsert(Ws ws, Guid id, Guid database, string type, JsonObject config, int? viewTypes)
    {
        var result = (await ws.Push(ws.Op("view.upsert", id, View(ws, id, database, type, config, viewTypes))))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return result.GetProperty("entity").GetProperty("view");
    }

    private static JsonObject Timeline => new() { ["start"] = "pStart01", ["end"] = "pEnd0001", ["lane"] = "pSel0001", ["scale"] = "month", ["undated"] = false };

    [Fact]
    public async Task A_timeline_view_keeps_its_type_and_settings_when_an_older_build_sends_it_back_as_a_table()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Roadmap", Properties.DeepClone().AsArray());
        var id = Guid.CreateVersion7();
        var made = await Upsert(ws, id, database, "timeline", Config(extra: new JsonObject { ["timeline"] = Timeline, ["wrap"] = true }), 6);
        Assert.Equal("timeline", made.GetProperty("type").GetString());

        // An older build drew it as a table, changed its filter there and sent it back without the
        // settings it does not know, and without the wrap it turned off.
        var filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pText001", @operator = "isNotEmpty" } } };
        var kept = await Upsert(ws, id, database, "table", Config(filter), null);
        Assert.Equal("timeline", kept.GetProperty("type").GetString());
        var config = kept.GetProperty("config");
        Assert.Equal("month", config.GetProperty("timeline").GetProperty("scale").GetString());
        Assert.Equal("pSel0001", config.GetProperty("timeline").GetProperty("lane").GetString());
        Assert.Equal("isNotEmpty", config.GetProperty("filter").GetProperty("children")[0].GetProperty("operator").GetString());
        Assert.False(config.TryGetProperty("wrap", out _));
        // What another device reads is the same.
        var listed = (await ws.Tree()).GetProperty("views").EnumerateArray().Single(v => v.GetProperty("id").GetGuid() == id);
        Assert.Equal("timeline", listed.GetProperty("type").GetString());
        Assert.Equal("month", listed.GetProperty("config").GetProperty("timeline").GetProperty("scale").GetString());

        // A real change of type by an older build is taken; the settings it does not know stay.
        var board = await Upsert(ws, id, database, "board", Config(filter), null);
        Assert.Equal("board", board.GetProperty("type").GetString());
        Assert.Equal("month", board.GetProperty("config").GetProperty("timeline").GetProperty("scale").GetString());
        // Once it is a type the older build knows, its table is a table.
        Assert.Equal("table", (await Upsert(ws, id, database, "table", Config(filter), null)).GetProperty("type").GetString());

        // A new build is taken as it sends.
        await Upsert(ws, id, database, "timeline", Config(extra: new JsonObject { ["timeline"] = Timeline }), 6);
        var asSent = await Upsert(ws, id, database, "table", Config(), 6);
        Assert.Equal("table", asSent.GetProperty("type").GetString());
        Assert.False(asSent.GetProperty("config").TryGetProperty("timeline", out _));
    }

    [Fact]
    public void An_older_builds_upsert_keeps_only_what_it_cannot_know()
    {
        var stored = new Cgw.Core.Data.DatabaseView
        {
            Type = "timeline",
            Config = """{"filter":null,"sorts":[],"timeline":{"start":"p1"},"later":{"x":1},"wrap":true}""",
        };
        var (type, config) = DatabaseOps.KeepWhatOlderBuildsDrop(stored, "table", """{"filter":null,"sorts":[]}""");
        Assert.Equal("timeline", type);
        var json = JsonNode.Parse(config)!.AsObject();
        Assert.Equal("p1", json["timeline"]!["start"]!.GetValue<string>());
        Assert.Equal(1, json["later"]!["x"]!.GetValue<int>());
        Assert.False(json.ContainsKey("wrap"));
        // What it sends of a key it does not know (from an import of an export, say) wins.
        var (_, sent) = DatabaseOps.KeepWhatOlderBuildsDrop(stored, "list", """{"timeline":{"start":"p2"}}""");
        Assert.Equal("p2", JsonNode.Parse(sent)!["timeline"]!["start"]!.GetValue<string>());
        Assert.Equal("list", DatabaseOps.KeepWhatOlderBuildsDrop(stored, "list", "{}").Type);
        Assert.Equal("table", DatabaseOps.KeepWhatOlderBuildsDrop(new Cgw.Core.Data.DatabaseView { Type = "board", Config = "{}" }, "table", "{}").Type);
        Assert.Contains("timeline", DatabaseOps.ViewTypes);
    }
}
