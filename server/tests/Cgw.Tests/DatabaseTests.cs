using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 4's server (contract sections 1, 2 and 4): databases, views and rows through the
/// operations, the tree rules for them, access by the database, the feed and the tree, the rows,
/// query, import and export routes, computed values, and document schema 3.
/// </summary>
public sealed class DatabaseTests(ServerFixture server)
{
    // Builders --------------------------------------------------------------------------------------

    public static JsonObject PageJson(Guid id, Guid workspace, Guid section, Guid? parent, string orderKey, string title, string kind) => new()
    {
        ["id"] = id.ToString(),
        ["workspaceId"] = workspace.ToString(),
        ["sectionId"] = section.ToString(),
        ["parentPageId"] = parent?.ToString(),
        ["orderKey"] = orderKey,
        ["kind"] = kind,
        ["title"] = title,
        ["icon"] = null,
        ["coverAssetId"] = null,
        ["isTemplate"] = false,
        ["templateOfPageId"] = null,
        ["version"] = 1,
        ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
        ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        ["trashedAt"] = null,
        ["trashRootId"] = null,
    };

    public static JsonObject Prop(string id, string type, string? name = null, JsonObject? extra = null)
    {
        var def = new JsonObject { ["id"] = id, ["name"] = name ?? id, ["type"] = type };
        if (extra is not null)
            foreach (var (k, v) in extra) def[k] = v?.DeepClone();
        return def;
    }

    public static JsonArray Options(params (string Id, string Name)[] options) =>
        new(options.Select(o => (JsonNode?)new JsonObject { ["id"] = o.Id, ["name"] = o.Name, ["colour"] = "default" }).ToArray());

    public static async Task<Guid> NewDatabase(Ws ws, string title, JsonArray? properties = null, Guid? parent = null, Guid? section = null, HttpClient? client = null)
    {
        var id = Guid.CreateVersion7();
        var payload = PageJson(id, ws.Id, section ?? ws.Shared, parent, "a" + Random.Shared.Next(1, 9), title, "database");
        payload["database"] = new JsonObject { ["properties"] = properties ?? [] };
        var result = (await ws.Push(client ?? ws.Client, ws.Op("page.create", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return id;
    }

    private static async Task<JsonElement> NewRow(Ws ws, Guid database, string title, object? values = null, string orderKey = "a0", HttpClient? client = null)
    {
        var id = Guid.CreateVersion7();
        var page = await ws.Tree();
        var section = page.GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == database).GetProperty("sectionId").GetGuid();
        var payload = PageJson(id, ws.Id, section, database, orderKey, title, "row");
        payload["row"] = new JsonObject { ["values"] = JsonSerializer.SerializeToNode(values ?? new { }) };
        var result = (await ws.Push(client ?? ws.Client, ws.Op("page.create", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        Assert.Equal("row", result.GetProperty("entityType").GetString());
        return result.GetProperty("entity").GetProperty("row");
    }

    private static async Task<JsonElement> RowUpdate(Ws ws, Guid row, object values, HttpClient? client = null) =>
        (await ws.Push(client ?? ws.Client, ws.Op("row.update", row, new { values })))[0];

    private static async Task<JsonElement> DbUpdate(Ws ws, Guid database, JsonArray properties, string[]? order = null, HttpClient? client = null)
    {
        var payload = new JsonObject { ["properties"] = properties };
        if (order is not null) payload["order"] = new JsonArray(order.Select(o => (JsonNode?)JsonValue.Create(o)).ToArray());
        return (await ws.Push(client ?? ws.Client, ws.Op("db.update", database, payload)))[0];
    }

    private static async Task<JsonElement> Rows(Ws ws, Guid database, string query = "", HttpClient? client = null)
    {
        var response = await (client ?? ws.Client).GetAsync($"/api/v1/databases/{database}/rows{query}");
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    private static async Task<JsonElement> Row(Ws ws, Guid database, Guid row) =>
        (await Rows(ws, database, "?limit=1000")).GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("id").GetGuid() == row);

    private static async Task<HttpResponseMessage> Query(Ws ws, Guid database, object body, HttpClient? client = null) =>
        await (client ?? ws.Client).PostAsJsonAsync($"/api/v1/databases/{database}/query", body);

    private static async Task<JsonElement> QueryOk(Ws ws, Guid database, object body)
    {
        var response = await Query(ws, database, body);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    private static readonly object Context = new { today = "2026-03-01", offsetMinutes = 0, me = (string?)null };

    private static string Status(JsonElement result) => result.GetProperty("status").GetString() == "applied" ? "applied" : result.GetProperty("error").GetProperty("code").GetString()!;

    // The model and the operations ------------------------------------------------------------------

    [Fact]
    public async Task A_database_is_a_page_with_its_properties_and_rows_are_pages_under_it()
    {
        var ws = await Ws.Create(server);
        var id = Guid.CreateVersion7();
        var payload = PageJson(id, ws.Id, ws.Shared, null, "a0", "Tasks", "database");
        payload["database"] = new JsonObject { ["properties"] = new JsonArray(Prop("pNum0001", "number", "Hours")) };
        var created = (await ws.Push(ws.Op("page.create", id, payload)))[0];
        Assert.Equal("page", created.GetProperty("entityType").GetString());
        Assert.Equal("database", created.GetProperty("entity").GetProperty("page").GetProperty("kind").GetString());
        // The title property is added first; the properties are JSON in the answer, not a string.
        var properties = created.GetProperty("entity").GetProperty("database").GetProperty("properties");
        Assert.Equal(JsonValueKind.Array, properties.ValueKind);
        Assert.Equal(["title", "pNum0001"], properties.EnumerateArray().Select(p => p.GetProperty("id").GetString()));

        var row = await NewRow(ws, id, "First", new { pNum0001 = "12.5" });
        Assert.Equal("row", row.GetProperty("kind").GetString());
        Assert.Equal(id, row.GetProperty("databaseId").GetGuid());
        Assert.Equal(12.5, row.GetProperty("values").GetProperty("pNum0001").GetDouble());
        Assert.Equal(1, row.GetProperty("versions").GetProperty("pNum0001").GetInt64());
        Assert.Equal(ws.Account.Id, row.GetProperty("createdBy").GetGuid());

        // The tree has the database and leaves the row out; the rows route has it.
        var tree = await ws.Tree();
        Assert.DoesNotContain(tree.GetProperty("pages").EnumerateArray(), p => p.GetProperty("kind").GetString() == "row");
        var database = Assert.Single(tree.GetProperty("databases").EnumerateArray());
        Assert.Equal(1, database.GetProperty("rowCount").GetInt64());
        var rows = await Rows(ws, id);
        Assert.Equal(1, rows.GetProperty("total").GetInt64());
        Assert.Equal(row.GetProperty("id").GetGuid(), rows.GetProperty("rows")[0].GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Rows_and_databases_keep_the_tree_rules()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Rules");
        var row = (await NewRow(ws, database, "R")).GetProperty("id").GetGuid();
        var page = (await ws.NewPage("Plain")).GetProperty("id").GetGuid();

        async Task<string> Create(Guid? parent, string kind)
        {
            var id = Guid.CreateVersion7();
            return Status((await ws.Push(ws.Op("page.create", id, PageJson(id, ws.Id, ws.Shared, parent, "a3", "x", kind))))[0]);
        }
        Assert.Equal("invalid", await Create(database, "page"));
        Assert.Equal("invalid", await Create(row, "page"));
        Assert.Equal("invalid", await Create(row, "database"));
        Assert.Equal("invalid", await Create(page, "row"));
        Assert.Equal("invalid", await Create(null, "row"));
        Assert.Equal("applied", await Create(page, "database"));

        // A row moves only among its database's rows.
        Assert.Equal("invalid", Status((await ws.Push(ws.Op("page.move", row, new { sectionId = ws.Shared, parentPageId = page, orderKey = "a1" })))[0]));
        Assert.Equal("invalid", Status((await ws.Push(ws.Op("page.move", row, new { sectionId = ws.Personal, parentPageId = database, orderKey = "a1" })))[0]));
        var moved = (await ws.Push(ws.Op("page.move", row, new { sectionId = ws.Shared, parentPageId = database, orderKey = "a5" })))[0];
        Assert.Equal("row", moved.GetProperty("entityType").GetString());
        Assert.Equal("a5", moved.GetProperty("entity").GetProperty("row").GetProperty("orderKey").GetString());
        // Nothing moves under a database or a row.
        Assert.Equal("invalid", Status((await ws.Push(ws.Op("page.move", page, new { sectionId = ws.Shared, parentPageId = database, orderKey = "a1" })))[0]));

        // A database's rows follow it to another section.
        var owner = (await ws.Tree()).GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == database).GetProperty("version").GetInt64();
        Assert.Equal("applied", Status((await ws.Push(ws.Op("page.move", database, new { sectionId = ws.Personal, parentPageId = (Guid?)null, orderKey = "a0" }, owner)))[0]));
        Assert.Equal(ws.Personal, (await Row(ws, database, row)).GetProperty("sectionId").GetGuid());
    }

    [Fact]
    public async Task Trash_restore_and_delete_reach_a_databases_rows()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Bin");
        var own = (await NewRow(ws, database, "Own")).GetProperty("id").GetGuid();
        var other = (await NewRow(ws, database, "Other", orderKey: "a1")).GetProperty("id").GetGuid();
        var cursor = (await ws.Tree()).GetProperty("cursor").GetInt64();

        // A row is its own trash root.
        var trashed = (await ws.Push(ws.Op("page.trash", own, new { })))[0];
        Assert.Equal(own, trashed.GetProperty("entity").GetProperty("row").GetProperty("trashRootId").GetGuid());
        Assert.Equal(1, (await ws.Tree()).GetProperty("databases")[0].GetProperty("rowCount").GetInt64());
        // The database with its rows: those already in the trash keep their root.
        await ws.Push(ws.Op("page.trash", database, new { }));
        var rows = (await Rows(ws, database)).GetProperty("rows").EnumerateArray().ToDictionary(r => r.GetProperty("id").GetGuid());
        Assert.Equal(own, rows[own].GetProperty("trashRootId").GetGuid());
        Assert.Equal(database, rows[other].GetProperty("trashRootId").GetGuid());
        Assert.Equal(0, (await ws.Tree()).GetProperty("databases")[0].GetProperty("rowCount").GetInt64());
        // A row edit in a trashed database is refused.
        Assert.Equal("page.trashed", Status(await RowUpdate(ws, other, new { })));
        await ws.Push(ws.Op("page.restore", database, new { }));
        rows = (await Rows(ws, database)).GetProperty("rows").EnumerateArray().ToDictionary(r => r.GetProperty("id").GetGuid());
        Assert.Equal(JsonValueKind.Null, rows[other].GetProperty("trashedAt").ValueKind);
        Assert.Equal(own, rows[own].GetProperty("trashRootId").GetGuid());

        // Every change to a row reaches the feed as a row, never as a page.
        var changes = (await ws.Changes(cursor)).GetProperty("changes").EnumerateArray().ToList();
        Assert.Contains(changes, c => c.GetProperty("entityType").GetString() == "row" && c.GetProperty("entityId").GetGuid() == other);
        Assert.DoesNotContain(changes, c => c.GetProperty("entityType").GetString() == "page" && c.GetProperty("entityId").GetGuid() == other);
        Assert.Contains(changes, c => c.GetProperty("entityType").GetString() == "database");

        // Deleting the database for good: its rows become tombstones, its records go.
        await ws.Push(ws.Op("page.trash", database, new { }));
        var cursor2 = (await ws.Tree()).GetProperty("cursor").GetInt64();
        Assert.Equal("applied", Status((await ws.Push(ws.Op("page.delete", database, new { })))[0]));
        var gone = (await ws.Changes(cursor2)).GetProperty("changes").EnumerateArray().ToList();
        Assert.Contains(gone, c => c.GetProperty("entityType").GetString() == "row" && c.GetProperty("entityId").GetGuid() == other && c.GetProperty("kind").GetString() == "delete");
        Assert.Contains(gone, c => c.GetProperty("entityType").GetString() == "database" && c.GetProperty("kind").GetString() == "delete");
        await using var db = server.NewDb(ws.Id);
        Assert.False(await db.Databases.AnyAsync(d => d.PageId == database));
        Assert.False(await db.DatabaseRows.AnyAsync(r => r.DatabaseId == database));
        Assert.True(await db.Pages.Where(p => p.Id == other || p.Id == own).AllAsync(p => p.DeletedAt != null));
        Assert.Equal(HttpStatusCode.Gone, (await ws.Client.GetAsync($"/api/v1/databases/{database}/rows")).StatusCode);
    }

    [Fact]
    public async Task Edits_merge_per_property_and_the_last_to_arrive_wins()
    {
        var ws = await Ws.Create(server);
        var second = server.Anonymous();
        await ServerFixture.SignIn(second, ws.Account.Email, ws.Account.Password);
        var database = await NewDatabase(ws, "Merge", [Prop("pText001", "text"), Prop("pNum0001", "number")]);
        var row = (await NewRow(ws, database, "Row")).GetProperty("id").GetGuid();
        // Two devices, offline, each change a different property: both stand.
        Assert.Equal("applied", Status(await RowUpdate(ws, row, new { pText001 = "from one" })));
        var after = await RowUpdate(ws, row, new { pNum0001 = 7 }, second);
        var values = after.GetProperty("entity").GetProperty("row").GetProperty("values");
        Assert.Equal("from one", values.GetProperty("pText001").GetString());
        Assert.Equal(7, values.GetProperty("pNum0001").GetDouble());
        // The same property: the last to reach the server wins, its version rises.
        await RowUpdate(ws, row, new { pText001 = "first" });
        var last = (await RowUpdate(ws, row, new { pText001 = "second" }, second)).GetProperty("entity").GetProperty("row");
        Assert.Equal("second", last.GetProperty("values").GetProperty("pText001").GetString());
        Assert.Equal(3, last.GetProperty("versions").GetProperty("pText001").GetInt64());
        Assert.Equal(1, last.GetProperty("versions").GetProperty("pNum0001").GetInt64());
        // null clears; a value is coerced; a property the database lacks, or not stored, is refused.
        var cleared = (await RowUpdate(ws, row, new { pText001 = (string?)null, pNum0001 = "1,234.5" })).GetProperty("entity").GetProperty("row");
        Assert.False(cleared.GetProperty("values").TryGetProperty("pText001", out _));
        Assert.Equal(1234.5, cleared.GetProperty("values").GetProperty("pNum0001").GetDouble());
        Assert.Equal("invalid", Status(await RowUpdate(ws, row, new { pNope001 = 1 })));
        Assert.Equal("invalid", Status(await RowUpdate(ws, row, new { title = "x" })));
        // No baseVersion: an old one changes nothing.
        Assert.Equal("applied", Status((await ws.Push(ws.Op("row.update", row, new { values = new { pNum0001 = 2 } }, 1)))[0]));
    }

    [Fact]
    public async Task A_type_change_converts_every_row_and_deletes_never_rewrite_one()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Convert", [Prop("pText001", "text", "Stage"), Prop("pSel0001", "select", "Kind", new JsonObject { ["options"] = Options(("optA0001", "A"), ("optB0001", "B")) })]);
        var a = (await NewRow(ws, database, "a", new { pText001 = "Done", pSel0001 = "optA0001" })).GetProperty("id").GetGuid();
        var b = (await NewRow(ws, database, "b", new { pText001 = "To do", pSel0001 = "optB0001" }, "a1")).GetProperty("id").GetGuid();
        var c = (await NewRow(ws, database, "c", new { pText001 = "Done" }, "a2")).GetProperty("id").GetGuid();

        // Text to select: the options the values need are made (derived ids, first-seen order in id order).
        var changed = await DbUpdate(ws, database, [Prop("pText001", "select", "Stage")]);
        Assert.Equal("database", changed.GetProperty("entityType").GetString());
        var def = changed.GetProperty("entity").GetProperty("database").GetProperty("properties").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "pText001");
        var options = def.GetProperty("options").EnumerateArray().ToDictionary(o => o.GetProperty("name").GetString()!, o => o.GetProperty("id").GetString()!);
        Assert.Equal(["Done", "To do"], def.GetProperty("options").EnumerateArray().Select(o => o.GetProperty("name").GetString()));
        Assert.Equal(DbIds.Derived(database.ToString(), "pText001", "Done").Id, options["Done"]);
        var rows = (await Rows(ws, database)).GetProperty("rows").EnumerateArray().ToDictionary(r => r.GetProperty("id").GetGuid());
        Assert.Equal(options["Done"], rows[a].GetProperty("values").GetProperty("pText001").GetString());
        Assert.Equal(options["To do"], rows[b].GetProperty("values").GetProperty("pText001").GetString());
        Assert.Equal(options["Done"], rows[c].GetProperty("values").GetProperty("pText001").GetString());
        // An edit made offline before the change lands as the converted value (coercion by name).
        var late = (await RowUpdate(ws, c, new { pText001 = "To do" })).GetProperty("entity").GetProperty("row");
        Assert.Equal(options["To do"], late.GetProperty("values").GetProperty("pText001").GetString());

        // Deleting a property or an option rewrites no row: the versions stay.
        var versions = (await Rows(ws, database)).GetProperty("rows").EnumerateArray().ToDictionary(r => r.GetProperty("id").GetGuid(), r => r.GetProperty("version").GetInt64());
        var trashedDef = Prop("pSel0001", "select", "Kind", new JsonObject { ["options"] = Options(("optA0001", "A")), ["trashedAt"] = DateTimeOffset.UtcNow.ToString("O") });
        Assert.Equal("applied", Status(await DbUpdate(ws, database, [trashedDef])));
        var after = (await Rows(ws, database)).GetProperty("rows").EnumerateArray().ToDictionary(r => r.GetProperty("id").GetGuid());
        Assert.All(after, r => Assert.Equal(versions[r.Key], r.Value.GetProperty("version").GetInt64()));
        Assert.Equal("optB0001", after[b].GetProperty("values").GetProperty("pSel0001").GetString());
        // The title property stays a title and is never deleted.
        Assert.Equal("invalid", Status(await DbUpdate(ws, database, [Prop("title", "text", "Name")])));
        Assert.Equal("invalid", Status(await DbUpdate(ws, database, [Prop("pAbc0001", "title")])));
        // Order: the ids named first, the rest after them.
        var ordered = await DbUpdate(ws, database, [], ["pText001"]);
        Assert.Equal("pText001", ordered.GetProperty("entity").GetProperty("database").GetProperty("properties")[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task Relations_are_kept_in_step_both_ways_and_keep_their_first_thousand()
    {
        var ws = await Ws.Create(server);
        var projects = await NewDatabase(ws, "Projects", [Prop("pNum0001", "number", "Hours")]);
        var tasks = await NewDatabase(ws, "Tasks", [
            Prop("pRel0001", "relation", "Project", new JsonObject { ["relation"] = new JsonObject { ["databaseId"] = projects.ToString(), ["reversePropertyId"] = "pRev0001" } }),
            Prop("pRol0001", "rollup", "Hours", new JsonObject { ["rollup"] = new JsonObject { ["relationPropertyId"] = "pRel0001", ["targetPropertyId"] = "pNum0001", ["fn"] = "sum" } }),
            Prop("pFor0001", "formula", "Double", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pRol0001\") * 2" } }),
        ]);
        // The reverse property was added to Projects, named after Tasks, pointing back.
        var reverse = (await ws.Tree()).GetProperty("databases").EnumerateArray().Single(d => d.GetProperty("id").GetGuid() == projects)
            .GetProperty("properties").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "pRev0001");
        Assert.Equal("Tasks", reverse.GetProperty("name").GetString());
        Assert.Equal("pRel0001", reverse.GetProperty("relation").GetProperty("reversePropertyId").GetString());

        var p1 = (await NewRow(ws, projects, "P1", new { pNum0001 = 3 })).GetProperty("id").GetGuid();
        var p2 = (await NewRow(ws, projects, "P2", new { pNum0001 = 4 }, "a1")).GetProperty("id").GetGuid();
        var task = await NewRow(ws, tasks, "T", new { pRel0001 = new[] { p1, p2 } });
        var taskId = task.GetProperty("id").GetGuid();
        // Computed in the operation's transaction: the rollup and the formula reading it.
        Assert.Equal(7, task.GetProperty("computed").GetProperty("pRol0001").GetDouble());
        Assert.Equal(14, task.GetProperty("computed").GetProperty("pFor0001").GetDouble());
        Assert.Equal([taskId], (await Row(ws, projects, p1)).GetProperty("values").GetProperty("pRev0001").EnumerateArray().Select(x => x.GetGuid()));
        // A related row's change reaches the rollup through the reverse property.
        await RowUpdate(ws, p1, new { pNum0001 = 10 });
        Assert.Equal(14, (await Row(ws, tasks, taskId)).GetProperty("computed").GetProperty("pRol0001").GetDouble());
        // Removing one removes the task from that project's reverse value.
        await RowUpdate(ws, taskId, new { pRel0001 = new[] { p2 } });
        Assert.False((await Row(ws, projects, p1)).GetProperty("values").TryGetProperty("pRev0001", out _));
        Assert.Equal(4, (await Row(ws, tasks, taskId)).GetProperty("computed").GetProperty("pRol0001").GetDouble());

        // A reverse value over 1,000 keeps its first 1,000 (the coordinator's rule; applyRelationEdit).
        var csv = "Name\n" + string.Join("\n", Enumerable.Range(0, 1001).Select(i => $"T{i}"));
        var import = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{tasks}/import", new { csv, columns = new[] { "title" }, header = true });
        Assert.True(import.IsSuccessStatusCode, await import.Content.ReadAsStringAsync());
        var many = (await Rows(ws, tasks, "?limit=1000")).GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("id").GetGuid()).Where(id => id != taskId).ToList();
        many.AddRange((await Rows(ws, tasks, $"?limit=1000&after={many[^1]}")).GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("id").GetGuid()));
        Assert.Equal(1001, many.Count);
        // Set from the reverse side with 1,001 ids: the value keeps its first 1,000.
        var set = (await RowUpdate(ws, p1, new { pRev0001 = many })).GetProperty("entity").GetProperty("row");
        Assert.Equal(1000, set.GetProperty("values").GetProperty("pRev0001").GetArrayLength());
        Assert.Equal(many[0], set.GetProperty("values").GetProperty("pRev0001")[0].GetGuid());
        // The 1,001st task naming the full project: the task names it, the project keeps its first 1,000.
        var extra = many[1000];
        await RowUpdate(ws, extra, new { pRel0001 = new[] { p1 } });
        var full = (await Row(ws, projects, p1)).GetProperty("values").GetProperty("pRev0001");
        Assert.Equal(1000, full.GetArrayLength());
        Assert.DoesNotContain(extra, full.EnumerateArray().Select(x => x.GetGuid()));

        // A relation converted away leaves the reverse property one-way, keeping its values.
        Assert.Equal("applied", Status(await DbUpdate(ws, tasks, [Prop("pRel0001", "text", "Project")])));
        var oneWay = (await ws.Tree()).GetProperty("databases").EnumerateArray().Single(d => d.GetProperty("id").GetGuid() == projects)
            .GetProperty("properties").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "pRev0001");
        Assert.Equal(JsonValueKind.Null, oneWay.GetProperty("relation").GetProperty("reversePropertyId").ValueKind);
        Assert.Equal(1000, (await Row(ws, projects, p1)).GetProperty("values").GetProperty("pRev0001").GetArrayLength());
    }

    [Fact]
    public async Task A_formula_change_recomputes_inline_or_waits_for_the_worker()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Compute", [Prop("pNum0001", "number"), Prop("pFor0001", "formula", "F", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pNum0001\") + 1" } })]);
        var row = await NewRow(ws, database, "r", new { pNum0001 = 1 });
        var id = row.GetProperty("id").GetGuid();
        Assert.Equal(2, row.GetProperty("computed").GetProperty("pFor0001").GetDouble());
        Assert.Equal(1, row.GetProperty("computedVersion").GetInt64());
        // Inline: a few rows.
        await DbUpdate(ws, database, [Prop("pFor0001", "formula", "F", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pNum0001\") * 10" } })]);
        var now = await Row(ws, database, id);
        Assert.Equal(10, now.GetProperty("computed").GetProperty("pFor0001").GetDouble());
        Assert.Equal(2, now.GetProperty("computedVersion").GetInt64());
        // A syntax error is a value, not a refusal.
        await DbUpdate(ws, database, [Prop("pFor0001", "formula", "F", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "1 +" } })]);
        Assert.Equal("formula.syntax", (await Row(ws, database, id)).GetProperty("computed").GetProperty("pFor0001").GetProperty("error").GetString());

        // Past the inline limit: the database waits for the worker's recompute job.
        var limit = DatabaseOps.InlineRecompute;
        DatabaseOps.InlineRecompute = 0;
        try
        {
            await DbUpdate(ws, database, [Prop("pFor0001", "formula", "F", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pNum0001\") - 1" } })]);
            await using (var db = server.NewDb(ws.Id))
                Assert.True((await db.Databases.SingleAsync(d => d.PageId == database)).ComputePending);
            Assert.Equal("formula.syntax", (await Row(ws, database, id)).GetProperty("computed").GetProperty("pFor0001").GetProperty("error").GetString());
            await server.RunJob<RecomputeJob>();
            await using (var db = server.NewDb(ws.Id))
                Assert.False((await db.Databases.SingleAsync(d => d.PageId == database)).ComputePending);
            Assert.Equal(0, (await Row(ws, database, id)).GetProperty("computed").GetProperty("pFor0001").GetDouble());
        }
        finally
        {
            DatabaseOps.InlineRecompute = limit;
        }
    }

    [Fact]
    public async Task Views_are_made_changed_and_deleted_with_their_database()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Views");
        var view = Guid.CreateVersion7();
        object View(string name, Guid? db = null) => new
        {
            id = view, workspaceId = ws.Id, databaseId = db ?? database, name, type = "table", orderKey = "a0", version = 1, createdAt = DateTimeOffset.UtcNow,
            config = new { filter = (object?)null, sorts = Array.Empty<object>(), group = (object?)null, properties = new { order = Array.Empty<string>(), hidden = Array.Empty<string>(), widths = new { } } },
        };
        var made = (await ws.Push(ws.Op("view.upsert", view, View("Table"))))[0];
        Assert.Equal("view", made.GetProperty("entityType").GetString());
        Assert.Equal(JsonValueKind.Object, made.GetProperty("entity").GetProperty("view").GetProperty("config").ValueKind);
        var renamed = (await ws.Push(ws.Op("view.upsert", view, View("Renamed"))))[0];
        Assert.Equal(2, renamed.GetProperty("entity").GetProperty("view").GetProperty("version").GetInt64());
        var other = await NewDatabase(ws, "Other");
        Assert.Equal("invalid", Status((await ws.Push(ws.Op("view.upsert", view, View("Moved", other))))[0]));
        Assert.Equal("Renamed", Assert.Single((await ws.Tree()).GetProperty("views").EnumerateArray()).GetProperty("name").GetString());
        var cursor = (await ws.Tree()).GetProperty("cursor").GetInt64();
        Assert.Equal("applied", Status((await ws.Push(ws.Op("view.delete", view, new { })))[0]));
        Assert.Contains((await ws.Changes(cursor)).GetProperty("changes").EnumerateArray(), c => c.GetProperty("entityType").GetString() == "view" && c.GetProperty("kind").GetString() == "delete");
        Assert.Empty((await ws.Tree()).GetProperty("views").EnumerateArray());
    }

    // Access ----------------------------------------------------------------------------------------

    [Fact]
    public async Task A_rows_access_is_its_databases_and_it_has_no_list_of_its_own()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var database = await NewDatabase(ws, "Private table", [Prop("pText001", "text")]);
        var row = (await NewRow(ws, database, "Secret row", new { pText001 = "x" })).GetProperty("id").GetGuid();
        // A row cannot be shared on its own.
        var put = await ws.Client.PutAsJsonAsync($"/api/v1/pages/{row}/permissions", Kit.Entries(true));
        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        Assert.Equal("request.invalid", await Kit.Code(put));
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{row}/share-links", new { })).StatusCode);

        // The database shared with the member to view: rows read, not written.
        await Kit.Share(ws, database, true, ("user", member.Id, "view"));
        Assert.Equal("view", (await Rows(ws, database, client: member.Client)).GetProperty("rows")[0].GetProperty("access").GetString());
        Assert.Equal("access.denied", Status(await RowUpdate(ws, row, new { pText001 = "y" }, member.Client)));
        Assert.Equal(HttpStatusCode.OK, (await Query(ws, database, new { context = Context }, member.Client)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync($"/api/v1/pages/{row}/doc?after=0")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv = "a", columns = new[] { "title" }, header = false })).StatusCode);

        // Restricted to nobody else: the member's feed loses the rows, and the routes say 404.
        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();
        await Kit.Share(ws, database, true);
        await RowUpdate(ws, row, new { pText001 = "z" });
        var feed = (await ws.Changes(cursor, member.Client)).GetProperty("changes").EnumerateArray().ToList();
        Assert.Contains(feed, c => c.GetProperty("entityType").GetString() == "row" && c.GetProperty("kind").GetString() == "delete");
        Assert.Contains(feed, c => c.GetProperty("entityType").GetString() == "access");
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/databases/{database}/rows")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/pages/{row}/doc?after=0")).StatusCode);
        Assert.Empty((await ws.Tree(member.Client)).GetProperty("databases").EnumerateArray());
        Assert.Equal("not.found", Status(await RowUpdate(ws, row, new { pText001 = "w" }, member.Client)));
    }

    // Routes ----------------------------------------------------------------------------------------

    [Fact]
    public async Task The_rows_route_pages_by_id_with_trashed_rows_and_templates()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Paged");
        var ids = new List<Guid>();
        for (var i = 0; i < 5; i++) ids.Add((await NewRow(ws, database, $"r{i}", orderKey: "a" + (char)('1' + i))).GetProperty("id").GetGuid());
        // By id in the database's byte order (UUIDv7: time order).
        ids = ids.OrderBy(id => Convert.ToHexString(GuidBytes.ToBytes(id)), StringComparer.Ordinal).ToList();
        await ws.Push(ws.Op("page.trash", ids[1], new { }));
        await ws.Push(ws.Op("page.update", ids[2], new { isTemplate = true }));
        var first = await Rows(ws, database, "?limit=3");
        Assert.Equal(5, first.GetProperty("total").GetInt64());
        Assert.Equal(ids.Take(3), first.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("id").GetGuid()));
        var next = first.GetProperty("next").GetString();
        var rest = await Rows(ws, database, $"?limit=3&after={next}");
        Assert.Equal(ids.Skip(3), rest.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("id").GetGuid()));
        Assert.Equal(JsonValueKind.Null, rest.GetProperty("next").ValueKind);
        // rowCount leaves the trashed row and the template out.
        Assert.Equal(3, (await ws.Tree()).GetProperty("databases")[0].GetProperty("rowCount").GetInt64());
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.GetAsync($"/api/v1/databases/{database}/rows?after=nope")).StatusCode);
    }

    [Fact]
    public async Task The_query_filters_sorts_groups_and_pages_with_a_keyset_cursor()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Query", [Prop("pNum0001", "number"), Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = Options(("optA0001", "A"), ("optB0001", "B")) })]);
        for (var i = 0; i < 12; i++)
            await NewRow(ws, database, $"Item {i}", new { pNum0001 = i, pSel0001 = i % 3 == 0 ? "optA0001" : "optB0001" }, "a" + (char)('A' + i));
        var filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pNum0001", @operator = "ge", value = 2 } } };
        var sorts = new[] { new { propertyId = "pNum0001", direction = "desc" } };
        var all = new List<string>();
        string? after = null;
        do
        {
            var page = await QueryOk(ws, database, new { filter, sorts, context = Context, after, limit = 4 });
            Assert.Equal(10, page.GetProperty("total").GetInt64());
            all.AddRange(page.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()!));
            after = page.GetProperty("next").GetString();
        }
        while (after is not null);
        Assert.Equal(Enumerable.Range(2, 10).Reverse().Select(i => $"Item {i}"), all);

        // Groups count the filtered rows; groupKey pages one group; search reads the title.
        var grouped = await QueryOk(ws, database, new { filter, group = new { propertyId = "pSel0001" }, groupKey = "optA0001", context = Context });
        Assert.Equal([("", 0L), ("optA0001", 3L), ("optB0001", 7L)], grouped.GetProperty("groups").EnumerateArray().Select(g => (g.GetProperty("key").GetString()!, g.GetProperty("count").GetInt64())));
        Assert.Equal(3, grouped.GetProperty("total").GetInt64());
        var searched = await QueryOk(ws, database, new { search = "item 1", context = Context });
        Assert.Equal(3, searched.GetProperty("total").GetInt64());

        // A view's spec, and explicit parts over it.
        var view = Guid.CreateVersion7();
        await ws.Push(ws.Op("view.upsert", view, new
        {
            id = view, workspaceId = ws.Id, databaseId = database, name = "B only", type = "table", orderKey = "a0", version = 1, createdAt = DateTimeOffset.UtcNow,
            config = new { filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pSel0001", @operator = "is", value = "optB0001" } } }, sorts = Array.Empty<object>(), group = (object?)null, properties = new { order = Array.Empty<string>(), hidden = Array.Empty<string>(), widths = new { } } },
        }));
        Assert.Equal(8, (await QueryOk(ws, database, new { viewId = view, context = Context })).GetProperty("total").GetInt64());
        Assert.Equal(12, (await QueryOk(ws, database, new { viewId = view, filter = (object?)null, context = Context })).GetProperty("total").GetInt64());
        Assert.Equal(HttpStatusCode.NotFound, (await Query(ws, database, new { viewId = Guid.CreateVersion7(), context = Context })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Query(ws, database, new { after = "not a cursor", context = Context })).StatusCode);
        // An edit is seen by the next query (the cache reads what changed since its version).
        var first = (await QueryOk(ws, database, new { sorts, context = Context, limit = 1 })).GetProperty("rows")[0];
        await RowUpdate(ws, first.GetProperty("id").GetGuid(), new { pNum0001 = -1 });
        Assert.Equal("Item 10", (await QueryOk(ws, database, new { sorts, context = Context, limit = 1 })).GetProperty("rows")[0].GetProperty("title").GetString());
    }

    [Fact]
    public async Task Import_and_export_go_through_csv_as_the_app_writes_it()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Imported", [Prop("pNum0001", "number", "Amount"), Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = Options(("optA0001", "Open")) })]);
        var csv = "\ufeffName;Amount;Stage\r\n'=Formula;12.5;Open\r\nSecond;abc;Closed\r\n\"Third; quoted\";3;Closed\r\n";
        var response = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv, columns = new[] { "title", "pNum0001", "pSel0001" }, header = true });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var result = await Kit.Json(response);
        Assert.Equal(3, result.GetProperty("created").GetInt64());
        var problem = Assert.Single(result.GetProperty("problems").EnumerateArray());
        Assert.Equal(3, problem.GetProperty("line").GetInt32());
        // The option the select column needed was added to the property.
        var stage = (await ws.Tree()).GetProperty("databases")[0].GetProperty("properties").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "pSel0001");
        Assert.Equal(["Open", "Closed"], stage.GetProperty("options").EnumerateArray().Select(o => o.GetProperty("name").GetString()));
        // In the file's order by their order keys (ids made in one millisecond have no order).
        var rows = (await Rows(ws, database)).GetProperty("rows").EnumerateArray().OrderBy(r => r.GetProperty("orderKey").GetString(), StringComparer.Ordinal).ToList();
        Assert.Equal(["=Formula", "Second", "Third; quoted"], rows.Select(r => r.GetProperty("title").GetString()));
        Assert.Equal(3, (await ws.Tree()).GetProperty("databases")[0].GetProperty("rowCount").GetInt64());

        var export = await ws.Client.GetAsync($"/api/v1/databases/{database}/export");
        Assert.Equal(HttpStatusCode.OK, export.StatusCode);
        Assert.Equal("text/csv", export.Content.Headers.ContentType?.MediaType);
        var bytes = await export.Content.ReadAsByteArrayAsync();
        Assert.Equal([0xEF, 0xBB, 0xBF], bytes[..3]);
        var text = Encoding.UTF8.GetString(bytes[3..]);
        // The guard against spreadsheet formulas comes back on export; numbers are never guarded.
        Assert.Equal("Name,Amount,Stage\r\n'=Formula,12.5,Open\r\nSecond,,Closed\r\nThird; quoted,3,Closed\r\n", text);
    }

    [Fact]
    public async Task An_import_over_the_limits_answers_db_too_large()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Too big");
        var rows = string.Join("\n", Enumerable.Range(0, Csv.MaxRows + 1).Select(i => "r"));
        var response = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv = rows, columns = new[] { "title" }, header = false });
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal("db.tooLarge", await Kit.Code(response));
        var bytes = new string('x', Csv.MaxBytes + 1);
        var big = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv = bytes, columns = new[] { "title" }, header = false });
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
        Assert.Equal("db.tooLarge", await Kit.Code(big));
        await using var db = server.NewDb(ws.Id);
        Assert.False(await db.DatabaseRows.AnyAsync(r => r.DatabaseId == database));
    }

    // The worker ------------------------------------------------------------------------------------

    private static readonly Lazy<Dictionary<string, Fixture>> Schema3 = new(() =>
        JsonSerializer.Deserialize<List<Fixture>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "schema3.json")),
                new JsonSerializerOptions(JsonSerializerDefaults.Web))!
            .ToDictionary(f => f.Name));

    [Fact]
    public async Task A_rows_document_head_reaches_the_feed_as_a_row_and_schema_3_is_known()
    {
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);
        var database = await NewDatabase(ws, "Docs");
        var row = (await NewRow(ws, database, "With a body")).GetProperty("id").GetGuid();
        var cursor = (await ws.Tree()).GetProperty("cursor").GetInt64();
        await Kit.PushOk(ws.Client, row, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        var change = Assert.Single((await ws.Changes(cursor)).GetProperty("changes").EnumerateArray());
        Assert.Equal("row", change.GetProperty("entityType").GetString());
        Assert.True(change.GetProperty("entity").GetProperty("row").GetProperty("docHeadSeq").GetInt64() > 0);

        async Task<(PageDocUpdate Row, Page Page)> Decide(string fixture, int clientSchemaVersion)
        {
            var page = (await ws.NewPage(fixture)).GetProperty("id").GetGuid();
            await Kit.PushOk(ws.Client, page, Kit.Update("page"));
            var id = Guid.CreateVersion7();
            var pushed = await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
            {
                epoch = 0,
                clientSchemaVersion,
                updates = new[] { new { updateId = id, data = Schema3.Value[fixture].Bytes } },
            });
            Assert.True(pushed.IsSuccessStatusCode, await pushed.Content.ReadAsStringAsync());
            await server.RunJob<ValidateJob>();
            await using var db = server.NewDb(ws.Id);
            return (await db.PageDocUpdates.AsNoTracking().SingleAsync(u => u.UpdateId == id), await db.Pages.AsNoTracking().SingleAsync(p => p.Id == page));
        }
        // Version 3 from an app that knows it: a database view and a date mention, the page raised.
        var (migrated, page3) = await Decide("migrate3", 3);
        Assert.Equal(UpdateStatus.Valid, migrated.Status);
        Assert.Equal(3, page3.DocSchemaVersion);
        // Their elements in a document still at version 1 are refused.
        var (view, viewPage) = await Decide("viewOnly", 3);
        Assert.Equal(UpdateStatus.Rejected, view.Status);
        Assert.Contains("databaseView", view.Problem);
        Assert.Equal(1, viewPage.DocSchemaVersion);
        var (date, _) = await Decide("dateOnly", 3);
        Assert.Equal(UpdateStatus.Rejected, date.Status);
        Assert.Contains("dateMention", date.Problem);
        // Version 4, which this worker does not know, even from an app that says it does.
        var (four, fourPage) = await Decide("claimsV4", 4);
        Assert.Equal(UpdateStatus.Rejected, four.Status);
        Assert.Contains("newer than this worker knows", four.Problem);
        Assert.Equal(1, fourPage.DocSchemaVersion);
        Assert.Equal(3, Cgw.Worker.Schema.Latest);
    }

    [Fact]
    public async Task A_page_showing_a_database_view_links_to_the_database()
    {
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);
        var page = (await ws.NewPage("Holds a view")).GetProperty("id").GetGuid();
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        var pushed = await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch = 0,
            clientSchemaVersion = 3,
            updates = new[] { new { updateId = Guid.CreateVersion7(), data = Schema3.Value["migrate3"].Bytes } },
        });
        Assert.True(pushed.IsSuccessStatusCode, await pushed.Content.ReadAsStringAsync());
        await server.RunJob<ValidateJob>();
        await Kit.Derive(server, ws.Id, page);
        // The fixture's view shows this database (make-schema3.mjs).
        var database = Guid.Parse("0195f4a0-0000-7000-8000-000000000001");
        await using var db = server.NewDb(ws.Id);
        Assert.True(await db.PageLinks.AnyAsync(l => l.FromPageId == page && l.ToPageId == database));
        Assert.Contains(database.ToString(), (await db.PageDocDerived.SingleAsync(d => d.PageId == page)).Outgoing);
        // The date mention is in the text search reads (cgw-ydoc's plain text); the view writes nothing.
        Assert.Contains("2026-11-13", (await db.PageDocDerived.SingleAsync(d => d.PageId == page)).PlainText);
        var (pages, _) = DeriveJob.Outgoing("""
            {"type":"doc","content":[{"type":"block","attrs":{"id":"aaaaaaaaaaaa"},"content":[{"type":"databaseView","attrs":{"databaseId":"0195f4a0-0000-7000-8000-000000000002","viewId":null}}]},
              {"type":"block","attrs":{"id":"bbbbbbbbbbbb"},"content":[{"type":"databaseView","attrs":{"databaseId":null,"viewId":null}}]}]}
            """);
        Assert.Equal([Guid.Parse("0195f4a0-0000-7000-8000-000000000002")], pages);
    }

    [Fact]
    public async Task The_workspace_export_holds_databases_their_rows_and_a_csv_each()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var database = await NewDatabase(ws, "Tasks", [
            Prop("pNum0001", "number", "Hours"),
            Prop("pOld0001", "text", "Old", new JsonObject { ["trashedAt"] = "2026-01-01T00:00:00.000Z" }),
            Prop("pPer0001", "person", "Owner"),
        ]);
        var view = Guid.CreateVersion7();
        await ws.Push(ws.Op("view.upsert", view, new
        {
            id = view, workspaceId = ws.Id, databaseId = database, name = "All", type = "table", orderKey = "a0", version = 1, createdAt = DateTimeOffset.UtcNow,
            config = new { filter = (object?)null, sorts = Array.Empty<object>(), group = (object?)null, properties = new { order = Array.Empty<string>(), hidden = Array.Empty<string>(), widths = new { } } },
        }));
        var first = (await NewRow(ws, database, "=Plan", new { pNum0001 = 3, pOld0001 = "kept", pPer0001 = new[] { ws.Account.Id } })).GetProperty("id").GetGuid();
        var binned = (await NewRow(ws, database, "Binned", orderKey: "a1")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", binned, new { }));
        // A database in the member's private section is not the owner's to export.
        var personal = Guid.CreateVersion7();
        await ws.Push(member.Client, ws.Op("section.create", personal, new { id = personal, workspaceId = ws.Id, name = "Mine", orderKey = "a5", visibility = "private", version = 1, createdAt = DateTimeOffset.UtcNow }));
        var hidden = await NewDatabase(ws, "Their table", section: personal, client: member.Client);

        var requested = await Kit.Json(await ws.Client.PostAsync($"/api/v1/workspaces/{ws.Id}/exports", null));
        await server.RunJob<ExportJob>();
        var ready = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/exports/{requested.GetProperty("id").GetGuid()}");
        using var http = new HttpClient();
        using var zip = new System.IO.Compression.ZipArchive(new MemoryStream(await http.GetByteArrayAsync(ready.GetProperty("url").GetString())));
        string Read(string name)
        {
            var entry = zip.GetEntry(name) ?? throw new Xunit.Sdk.XunitException($"No {name} in {string.Join(", ", zip.Entries.Select(e => e.FullName))}");
            using var reader = new StreamReader(entry.Open(), Encoding.UTF8, detectEncodingFromByteOrderMarks: false);
            return reader.ReadToEnd();
        }
        using var manifest = JsonDocument.Parse(Read("cgw-export.json"));
        var root = manifest.RootElement;
        Assert.Equal(2, root.GetProperty("version").GetInt32());
        var pages = root.GetProperty("pages").EnumerateArray().ToDictionary(p => p.GetProperty("id").GetGuid());
        Assert.Equal("database", pages[database].GetProperty("kind").GetString());
        var row = pages[first];
        Assert.Equal("row", row.GetProperty("kind").GetString());
        Assert.Equal(database, row.GetProperty("databaseId").GetGuid());
        Assert.Equal(database, row.GetProperty("parentPageId").GetGuid());
        Assert.Equal(3, row.GetProperty("values").GetProperty("pNum0001").GetDouble());
        Assert.Equal("Shared/Tasks/=Plan/=Plan.md", row.GetProperty("markdown").GetString());
        Assert.False(pages.ContainsKey(binned));
        Assert.False(pages.ContainsKey(hidden));
        var exported = Assert.Single(root.GetProperty("databases").EnumerateArray());
        Assert.Equal(database, exported.GetProperty("id").GetGuid());
        Assert.Equal(JsonValueKind.Array, exported.GetProperty("properties").ValueKind);
        var viewEntry = Assert.Single(exported.GetProperty("views").EnumerateArray());
        Assert.Equal(view, viewEntry.GetProperty("id").GetGuid());
        Assert.Equal(JsonValueKind.Object, viewEntry.GetProperty("config").ValueKind);
        // The CSV beside the database's files: every property not deleted, title first; the
        // trashed row left out; people by name; the formula guard on risky text.
        var owner = (await ws.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("displayName").GetString();
        var csv = new MemoryStream();
        using (var entry = zip.GetEntry("Shared/Tasks/Tasks.csv")!.Open()) entry.CopyTo(csv);
        var bytes = csv.ToArray();
        Assert.Equal([0xEF, 0xBB, 0xBF], bytes[..3]);
        Assert.Equal($"Name,Hours,Owner\r\n'=Plan,3,{owner}\r\n", Encoding.UTF8.GetString(bytes[3..]));
    }

    [Fact]
    public async Task Trash_retention_and_the_purge_take_rows_with_them()
    {
        var ws = await Ws.Create(server);
        var database = await NewDatabase(ws, "Retained", [Prop("pText001", "text")]);
        var row = (await NewRow(ws, database, "Old", new { pText001 = "x" })).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", row, new { }));
        var job = new TrashRetentionJob(new ShiftedClock(TimeSpan.FromDays(61)));
        Assert.Equal(1, await Kit.InWorker(server, ws.Id, (services, db) => job.DeleteDueAsync(services, db, ws.Id, CancellationToken.None)));
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.NotNull((await db.Pages.SingleAsync(p => p.Id == row)).DeletedAt);
            Assert.Equal("{}", (await db.DatabaseRows.SingleAsync(r => r.PageId == row)).Values);
        }
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            await Kit.Job<PagePurgeJob>(server).PurgeAsync(db, ws.Id, row, CancellationToken.None);
            return 0;
        });
        await using (var db = server.NewDb(ws.Id))
            Assert.False(await db.DatabaseRows.AnyAsync(r => r.PageId == row));
    }
}
