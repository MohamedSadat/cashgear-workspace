using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cgw.Tests;

/// <summary>
/// Phase 17, M17.3 and M17.4: sub-items and dependencies on the server. The query nests rows under
/// their Parent (a relation of the database to itself), a filter keeping a match's ancestors, each
/// line beside its row, paged by the last row's id; a row blocked, through Blocked by, by a row it
/// blocks is refused, whichever side the change was made from.
/// </summary>
public sealed class SubItemTests(ServerFixture server)
{
    private static JsonObject Relation(string id, string name, Guid database, string reverse, string role) =>
        DatabaseTests.Prop(id, "relation", name, new JsonObject
        {
            ["relation"] = new JsonObject { ["databaseId"] = database.ToString(), ["reversePropertyId"] = reverse, ["role"] = role },
        });

    private static async Task<Guid> Tasks(Ws ws, string a, string b, string roleA, string roleB)
    {
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", new JsonArray(DatabaseTests.Prop("pNum0001", "number", "Points")));
        var update = await DatabaseTests.DbUpdate(ws, database, [Relation("pRelA001", a, database, "pRelB001", roleA), Relation("pRelB001", b, database, "pRelA001", roleB)]);
        Assert.Equal("applied", update.GetProperty("status").GetString());
        return database;
    }

    private static object Context => new { today = "2026-03-01", offsetMinutes = 0, me = (string?)null };

    [Fact]
    public async Task The_query_nests_sub_items_keeps_a_matchs_ancestors_and_pages_by_the_last_rows_id()
    {
        var ws = await Ws.Create(server);
        var database = await Tasks(ws, "Parent", "Sub-items", "parent", "subItems");
        var epic = (await DatabaseTests.NewRow(ws, database, "Epic", new { pNum0001 = 1 }, "a1")).GetProperty("id").GetGuid();
        var story = (await DatabaseTests.NewRow(ws, database, "Story", new { pNum0001 = 5, pRelA001 = new[] { epic } }, "a2")).GetProperty("id").GetGuid();
        await DatabaseTests.NewRow(ws, database, "Task", new { pNum0001 = 3, pRelA001 = new[] { story } }, "a3");
        await DatabaseTests.NewRow(ws, database, "Alone", new { pNum0001 = 9 }, "a4");
        // The reverse was kept: the epic's sub-items name the story.
        var rows = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=100")).GetProperty("rows").EnumerateArray().ToList();
        Assert.Equal(story, rows.Single(r => r.GetProperty("id").GetGuid() == epic).GetProperty("values").GetProperty("pRelB001")[0].GetGuid());

        async Task<JsonElement> Query(object body) =>
            await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/query", body));
        var all = await Query(new { tree = "pRelA001", sorts = Array.Empty<object>(), group = (object?)null, context = Context });
        Assert.Equal(["Epic", "Story", "Task", "Alone"], all.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        Assert.Equal([0, 1, 2, 0], all.GetProperty("tree").EnumerateArray().Select(l => l.GetProperty("depth").GetInt32()));
        Assert.Equal([1, 1, 0, 0], all.GetProperty("tree").EnumerateArray().Select(l => l.GetProperty("children").GetInt32()));
        // A match's ancestors are shown, as no match.
        var filtered = await Query(new
        {
            tree = "pRelA001", sorts = Array.Empty<object>(), group = (object?)null, context = Context,
            filter = new { kind = "group", op = "and", children = new[] { new { kind = "condition", propertyId = "pNum0001", @operator = "eq", value = 3 } } },
        });
        Assert.Equal(["Epic", "Story", "Task"], filtered.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        Assert.Equal([false, false, true], filtered.GetProperty("tree").EnumerateArray().Select(l => l.GetProperty("match").GetBoolean()));
        // Paged: the next page goes on from the last row, in tree order.
        var first = await Query(new { tree = "pRelA001", sorts = Array.Empty<object>(), group = (object?)null, context = Context, limit = 2 });
        Assert.Equal(["Epic", "Story"], first.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        var second = await Query(new { tree = "pRelA001", sorts = Array.Empty<object>(), group = (object?)null, context = Context, limit = 2, after = first.GetProperty("next").GetString() });
        Assert.Equal(["Task", "Alone"], second.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        Assert.Equal([2, 0], second.GetProperty("tree").EnumerateArray().Select(l => l.GetProperty("depth").GetInt32()));
        // A query that is not a tree answers no lines.
        Assert.Equal(JsonValueKind.Null, (await Query(new { sorts = Array.Empty<object>(), group = (object?)null, context = Context })).GetProperty("tree").ValueKind);
    }

    [Fact]
    public async Task A_row_blocked_by_a_row_it_blocks_is_refused_from_either_side()
    {
        var ws = await Ws.Create(server);
        var database = await Tasks(ws, "Blocked by", "Blocking", "blockedBy", "blocking");
        var design = (await DatabaseTests.NewRow(ws, database, "Design")).GetProperty("id").GetGuid();
        var build = (await DatabaseTests.NewRow(ws, database, "Build", new { pRelA001 = new[] { design } })).GetProperty("id").GetGuid();
        var ship = (await DatabaseTests.NewRow(ws, database, "Ship", new { pRelA001 = new[] { build } })).GetProperty("id").GetGuid();
        static string Code(JsonElement result) => result.GetProperty("status").GetString() == "applied" ? "applied" : result.GetProperty("error").GetProperty("code").GetString()!;
        // Design blocked by Ship, which waits on it through Build: a loop.
        Assert.Equal("dependency.loop", Code(await DatabaseTests.RowUpdate(ws, design, new { pRelA001 = new[] { ship } })));
        // The same from the other side: Ship blocking Design.
        Assert.Equal("dependency.loop", Code(await DatabaseTests.RowUpdate(ws, ship, new { pRelB001 = new[] { design } })));
        // A row blocked by itself.
        Assert.Equal("dependency.loop", Code(await DatabaseTests.RowUpdate(ws, build, new { pRelA001 = new[] { design, build } })));
        // A new row may not close one either; one that adds no loop is taken.
        var id = Guid.CreateVersion7();
        var tree = await ws.Tree();
        var section = tree.GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == database).GetProperty("sectionId").GetGuid();
        Assert.Equal("applied", Code(await DatabaseTests.RowUpdate(ws, ship, new { pRelA001 = new[] { build, design } })));
        var payload = DatabaseTests.PageJson(id, ws.Id, section, database, "a5", "Test", "row");
        payload["row"] = new JsonObject { ["values"] = new JsonObject { ["pRelA001"] = new JsonArray(design.ToString()) } };
        Assert.Equal("applied", Code((await ws.Push(ws.Op("page.create", id, payload)))[0]));
        // Nothing of a refused one was kept.
        var rows = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=100")).GetProperty("rows").EnumerateArray().ToList();
        Assert.False(rows.Single(r => r.GetProperty("id").GetGuid() == design).GetProperty("values").TryGetProperty("pRelA001", out _));
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.GetAsync($"/api/v1/databases/{database}/rows?limit=1")).StatusCode);
    }
}
