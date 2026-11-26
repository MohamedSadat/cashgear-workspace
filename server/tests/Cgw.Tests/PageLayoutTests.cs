using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Sync;

namespace Cgw.Tests;

/// <summary>
/// Phase 19, M19.1: a page's layout (DATA_MODEL.md, "A page's layout"). The check is held to the
/// shared vectors; the layout goes through <c>page.create</c> and <c>page.update</c> as the device
/// set it, is in the tree, the feed and a row's record, is kept by every edit that does not name it
/// (an older build's), and is taken off by null.
/// </summary>
public sealed class PageLayoutTests(ServerFixture server)
{
    private static readonly JsonObject Landscape = new()
    {
        ["size"] = "letter",
        ["orientation"] = "landscape",
        ["margins"] = "wide",
        ["header"] = new JsonObject { ["start"] = "{title}", ["center"] = "", ["end"] = "{date}" },
        ["footer"] = new JsonObject { ["start"] = "", ["center"] = "صفحة {page} من {pages}", ["end"] = "" },
        // A key a later build adds is kept as it was given.
        ["columns"] = new JsonObject { ["count"] = 2 },
    };

    [Fact]
    public void The_check_matches_the_shared_vectors()
    {
        using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "vectors", "page-layout-vectors.json")));
        var count = 0;
        var failures = new List<string>();
        foreach (var c in vectors.RootElement.GetProperty("check").EnumerateArray())
        {
            count++;
            var valid = PageLayouts.Check(c.GetProperty("layout")) is null;
            if (valid != c.GetProperty("valid").GetBoolean()) failures.Add(c.GetProperty("name").GetString()!);
        }
        Assert.Empty(failures);
        Assert.True(count >= 20);
    }

    private static JsonElement? LayoutOf(JsonElement record) =>
        record.TryGetProperty("layout", out var layout) && layout.ValueKind == JsonValueKind.Object ? layout : null;

    [Fact]
    public async Task A_pages_layout_is_kept_as_set_through_edits_that_do_not_name_it_and_taken_off_by_null()
    {
        var ws = await Ws.Create(server);
        var page = await ws.NewPage("Report");
        var id = page.GetProperty("id").GetGuid();
        Assert.Null(LayoutOf(page));
        var cursor = (await ws.Changes(0)).GetProperty("cursor").GetInt64();

        var set = await ws.Push(ws.Op("page.update", id, new JsonObject { ["layout"] = Landscape.DeepClone() }));
        Assert.Equal("applied", set[0].GetProperty("status").GetString());
        Assert.True(JsonNode.DeepEquals(Landscape, JsonNode.Parse(LayoutOf(set[0].GetProperty("entity").GetProperty("page"))!.Value.GetRawText())));

        // An older build's edit names only its own fields: the layout stays.
        await ws.Push(ws.Op("page.update", id, new { title = "Report, renamed", icon = "📄" }));
        var tree = await ws.Tree();
        var inTree = tree.GetProperty("pages").EnumerateArray().Single(p => p.GetProperty("id").GetGuid() == id);
        Assert.Equal("Report, renamed", inTree.GetProperty("title").GetString());
        Assert.True(JsonNode.DeepEquals(Landscape, JsonNode.Parse(LayoutOf(inTree)!.Value.GetRawText())));
        Assert.Equal("صفحة {page} من {pages}", LayoutOf(inTree)!.Value.GetProperty("footer").GetProperty("center").GetString());

        // The feed carries it to other devices.
        var changes = (await ws.Changes(cursor)).GetProperty("changes").EnumerateArray()
            .Where(c => c.GetProperty("entityId").GetGuid() == id).ToList();
        Assert.True(JsonNode.DeepEquals(Landscape, JsonNode.Parse(LayoutOf(changes[^1].GetProperty("entity").GetProperty("page"))!.Value.GetRawText())));

        // Null takes it off: the page prints by the default again.
        await ws.Push(ws.Op("page.update", id, new JsonObject { ["layout"] = null }));
        inTree = (await ws.Tree()).GetProperty("pages").EnumerateArray().Single(p => p.GetProperty("id").GetGuid() == id);
        Assert.Null(LayoutOf(inTree));
    }

    [Fact]
    public async Task A_layout_that_fails_its_check_is_refused_and_changes_nothing()
    {
        var ws = await Ws.Create(server);
        var id = (await ws.NewPage("Report")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.update", id, new { layout = new { size = "a4" } }));
        foreach (var wrong in new JsonNode?[]
                 {
                     new JsonArray(), JsonValue.Create("a4"), new JsonObject { ["size"] = "a3" },
                     new JsonObject { ["footer"] = new JsonObject { ["end"] = "a\nb" } },
                     new JsonObject { ["header"] = new JsonObject { ["start"] = new string('x', 201) } },
                     new JsonObject { ["note"] = new string('x', 4000) },
                 })
        {
            var refused = await ws.Push(ws.Op("page.update", id, new JsonObject { ["layout"] = wrong, ["title"] = "Changed" }));
            Assert.Equal("rejected", refused[0].GetProperty("status").GetString());
            Assert.Equal("invalid", refused[0].GetProperty("error").GetProperty("code").GetString());
        }
        var inTree = (await ws.Tree()).GetProperty("pages").EnumerateArray().Single(p => p.GetProperty("id").GetGuid() == id);
        Assert.Equal("Report", inTree.GetProperty("title").GetString());
        Assert.Equal("a4", LayoutOf(inTree)!.Value.GetProperty("size").GetString());
    }

    [Fact]
    public async Task A_page_made_with_a_layout_keeps_it_and_a_rows_page_has_one_of_its_own()
    {
        var ws = await Ws.Create(server);
        // A page made with one (a copy of a template, an upload of a workspace made offline).
        var id = Guid.CreateVersion7();
        var payload = JsonSerializer.SerializeToNode(Ws.Page(id, ws.Id, ws.Shared, null, "a0", "Made"))!.AsObject();
        payload["layout"] = Landscape.DeepClone();
        var made = await ws.Push(ws.Op("page.create", id, payload));
        Assert.Equal("applied", made[0].GetProperty("status").GetString());
        Assert.True(JsonNode.DeepEquals(Landscape, JsonNode.Parse(LayoutOf(made[0].GetProperty("entity").GetProperty("page"))!.Value.GetRawText())));

        // A row's page is printed from the row's menu: its layout is its own.
        var database = await DatabaseTests.NewDatabase(ws, "Tasks");
        var row = await DatabaseTests.NewRow(ws, database, "First");
        var rowId = row.GetProperty("id").GetGuid();
        Assert.Null(LayoutOf(row));
        var set = await ws.Push(ws.Op("page.update", rowId, new { layout = new { size = "letter", margins = "narrow" } }));
        Assert.Equal("applied", set[0].GetProperty("status").GetString());
        var rows = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=100");
        var read = rows.GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("id").GetGuid() == rowId);
        Assert.Equal("letter", LayoutOf(read)!.Value.GetProperty("size").GetString());
        Assert.Equal("narrow", LayoutOf(read)!.Value.GetProperty("margins").GetString());
        // A value edit keeps it.
        await DatabaseTests.RowUpdate(ws, rowId, new { });
        await ws.Push(ws.Op("page.update", rowId, new { title = "First, renamed" }));
        rows = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=100");
        read = rows.GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("id").GetGuid() == rowId);
        Assert.Equal("First, renamed", read.GetProperty("title").GetString());
        Assert.Equal("letter", LayoutOf(read)!.Value.GetProperty("size").GetString());
    }
}
