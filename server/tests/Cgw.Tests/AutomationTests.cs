using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 15, M15.1: a database's rules as records (<c>automation.upsert</c> and
/// <c>automation.delete</c>: who may save them, the checks only the server makes, the limit, the
/// author, the feed's <c>automation</c> change to the database's readers), the button property
/// kept from a build that does not know it, and the row events every path that writes rows makes,
/// or does not.
/// </summary>
public sealed class AutomationTests(ServerFixture server)
{
    internal static readonly JsonArray Properties = new(
        DatabaseTests.Prop("pStat001", "status", "Status", new JsonObject
        {
            ["options"] = new JsonArray(
                new JsonObject { ["id"] = "sTodo001", ["name"] = "To do", ["colour"] = "default", ["group"] = "todo" },
                new JsonObject { ["id"] = "sDone001", ["name"] = "Done", ["colour"] = "green", ["group"] = "complete" }),
        }),
        DatabaseTests.Prop("pNum0001", "number", "Points"),
        DatabaseTests.Prop("pText001", "text", "Notes"),
        DatabaseTests.Prop("pDate001", "date", "Due"),
        DatabaseTests.Prop("pPers001", "person", "Owner"),
        DatabaseTests.Prop("pForm001", "formula", "Double", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pNum0001\") * 2" } }),
        DatabaseTests.Prop("pBtn0001", "button", "Approve", new JsonObject { ["button"] = new JsonObject { ["label"] = "Approve" } }));

    internal static JsonObject Rule(Ws ws, Guid id, Guid database, JsonObject trigger, JsonArray steps, bool enabled = true, string name = "Rule", JsonObject? conditions = null) => new()
    {
        ["id"] = id.ToString(),
        ["workspaceId"] = ws.Id.ToString(),
        ["databaseId"] = database.ToString(),
        ["name"] = name,
        ["enabled"] = enabled,
        ["trigger"] = trigger,
        ["conditions"] = conditions,
        ["steps"] = steps,
        ["authorId"] = null,
        ["version"] = 0,
        ["createdAt"] = "",
        ["updatedAt"] = "",
    };

    internal static JsonObject Added => new() { ["kind"] = "rowAdded" };

    internal static JsonObject Changed(string? property = null, JsonObject? to = null) => new()
    {
        ["kind"] = "propertyChanged",
        ["propertyId"] = property,
        ["to"] = to,
    };

    internal static JsonArray SetNotes(string text) => [new JsonObject { ["kind"] = "set", ["values"] = new JsonObject { ["pText001"] = text } }];

    internal static async Task<JsonElement> Save(Ws ws, JsonObject rule, HttpClient? client = null) =>
        (await ws.Push(client ?? ws.Client, ws.Op("automation.upsert", Guid.Parse((string)rule["id"]!), rule)))[0];

    internal static string Status(JsonElement result) =>
        result.GetProperty("status").GetString() == "applied" ? "applied" : result.GetProperty("error").GetProperty("code").GetString()!;

    private static async Task<List<AutomationEvent>> Events(ServerFixture server, Ws ws, Guid database) =>
        await Kit.InWorker(server, ws.Id, (_, db) => db.AutomationEvents.AsNoTracking().Where(e => e.DatabaseId == database).OrderBy(e => e.Id).ToListAsync());

    private async Task<(Ws Ws, Guid Database)> DatabaseWithRule(JsonObject? trigger = null)
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", Properties.DeepClone().AsArray());
        Assert.Equal("applied", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, trigger ?? Changed("pStat001"), SetNotes("seen")))));
        return (ws, database);
    }

    [Fact]
    public async Task Full_access_saves_a_rule_its_author_the_last_to_save_it_and_its_readers_are_told()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", Properties.DeepClone().AsArray());
        var editor = await Kit.Join(server, ws, "member");
        var reader = await Kit.Join(server, ws, "member");
        var outsider = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", editor.Id, "edit"), ("user", reader.Id, "view"));
        var cursor = (await ws.Changes(0, reader.Client)).GetProperty("cursor").GetInt64();

        var id = Guid.CreateVersion7();
        var saved = await Save(ws, Rule(ws, id, database, Changed("pStat001"), SetNotes("seen")));
        Assert.Equal("applied", Status(saved));
        var rule = saved.GetProperty("entity").GetProperty("automation");
        Assert.Equal(ws.Account.Id, rule.GetProperty("authorId").GetGuid());
        Assert.Equal(1, rule.GetProperty("version").GetInt64());
        Assert.Equal("automation", saved.GetProperty("entityType").GetString());

        // Edit access is not enough to change a rule; nor to delete it.
        Assert.Equal("access.denied", Status(await Save(ws, Rule(ws, id, database, Changed("pStat001"), SetNotes("mine")), editor.Client)));
        Assert.Equal("access.denied", Status((await ws.Push(editor.Client, ws.Op("automation.delete", id, new { })))[0]));
        // Someone who cannot see the database is told there is none.
        Assert.Equal("not.found", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added, SetNotes("x")), outsider.Client)));

        // The reader is told of the rule; the outsider never.
        var changes = (await ws.Changes(cursor, reader.Client)).GetProperty("changes").EnumerateArray().ToList();
        Assert.Contains(changes, c => c.GetProperty("entityType").GetString() == "automation" && c.GetProperty("entityId").GetGuid() == id);
        Assert.DoesNotContain((await ws.Changes(cursor, outsider.Client)).GetProperty("changes").EnumerateArray(),
            c => c.GetProperty("entityType").GetString() == "automation");

        // Readers list the rules; whoever saves it last is its author.
        var listed = await reader.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/automations");
        Assert.False(listed.GetProperty("canManage").GetBoolean());
        Assert.Single(listed.GetProperty("automations").EnumerateArray());
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", editor.Id, "full"), ("user", reader.Id, "view"));
        var again = await Save(ws, Rule(ws, id, database, Changed("pStat001"), SetNotes("theirs")), editor.Client);
        Assert.Equal("applied", Status(again));
        Assert.Equal(editor.Id, again.GetProperty("entity").GetProperty("automation").GetProperty("authorId").GetGuid());
        Assert.Equal(2, again.GetProperty("entity").GetProperty("automation").GetProperty("version").GetInt64());
        Assert.Equal(404, (int)(await outsider.Client.GetAsync($"/api/v1/databases/{database}/automations")).StatusCode);

        // Deleted: gone from the list, its readers told.
        var before = (await ws.Changes(0, reader.Client)).GetProperty("cursor").GetInt64();
        Assert.Equal("applied", Status((await ws.Push(ws.Op("automation.delete", id, new { })))[0]));
        Assert.Contains((await ws.Changes(before, reader.Client)).GetProperty("changes").EnumerateArray(),
            c => c.GetProperty("entityType").GetString() == "automation" && c.GetProperty("kind").GetString() == "delete");
        Assert.Empty((await reader.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/automations")).GetProperty("automations").EnumerateArray());
        // A deleted rule is not made again by its id.
        Assert.Equal("not.found", Status(await Save(ws, Rule(ws, id, database, Added, SetNotes("again")))));
    }

    [Fact]
    public async Task A_rule_is_checked_as_the_client_checks_it_and_then_for_what_only_the_server_knows()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", Properties.DeepClone().AsArray());
        var other = await DatabaseTests.NewDatabase(ws, "Notes", []);
        // The shared rules (the vectors): a formula is not a property a step writes.
        var formula = await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added, [new JsonObject { ["kind"] = "set", ["values"] = new JsonObject { ["pForm001"] = 1 } }]));
        Assert.Equal("invalid", Status(formula));
        // A notice to someone outside the workspace, a group that is not there, a new row in a database that is not.
        var stranger = await server.NewAccount();
        Assert.Equal("not.found", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added,
            [new JsonObject { ["kind"] = "notify", ["people"] = new JsonArray(stranger.Id.ToString()), ["message"] = "hi" }]))));
        Assert.Equal("not.found", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added,
            [new JsonObject { ["kind"] = "notify", ["groups"] = new JsonArray(Guid.CreateVersion7().ToString()), ["message"] = "hi" }]))));
        Assert.Equal("not.found", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added,
            [new JsonObject { ["kind"] = "addRow", ["databaseId"] = Guid.CreateVersion7().ToString(), ["templateId"] = null, ["values"] = new JsonObject() }]))));
        // A template that is not one of the target's.
        var row = await DatabaseTests.NewRow(ws, other, "Not a template");
        Assert.Equal("not.found", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added,
            [new JsonObject { ["kind"] = "addRow", ["databaseId"] = other.ToString(), ["templateId"] = row.GetProperty("id").GetString(), ["values"] = new JsonObject() }]))));
        // A new row in a database the author can only read.
        var member = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", member.Id, "full"));
        await Kit.Share(ws, other, true, ("user", ws.Account.Id, "full"), ("user", member.Id, "view"));
        Assert.Equal("access.denied", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added,
            [new JsonObject { ["kind"] = "addRow", ["databaseId"] = other.ToString(), ["templateId"] = null, ["values"] = new JsonObject() }]), member.Client)));
        // The fiftieth rule is the last.
        for (var i = 0; i < 50; i++)
            Assert.Equal("applied", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added, SetNotes($"n{i}"), enabled: i % 2 == 0))));
        Assert.Equal("automation.limit", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added, SetNotes("one more")))));
    }

    [Fact]
    public async Task Only_owners_and_admins_save_a_rule_that_calls_a_webhook()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", Properties.DeepClone().AsArray());
        var made = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/webhooks", new { name = "Receiver", url = "https://hooks.example.com/in" });
        Assert.True(made.IsSuccessStatusCode, await made.Content.ReadAsStringAsync());
        var hook = (await Kit.Json(made)).GetProperty("webhook").GetProperty("id").GetString();
        JsonArray Call() => [new JsonObject { ["kind"] = "webhook", ["webhookId"] = hook, ["properties"] = new JsonArray("title", "pStat001") }];

        var member = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", member.Id, "full"));
        Assert.Equal("access.denied", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added, Call()), member.Client)));
        // A member cannot make one, nor read them.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/webhooks", new { name = "Mine", url = "https://hooks.example.com/mine" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/webhooks")).StatusCode);
        var id = Guid.CreateVersion7();
        Assert.Equal("applied", Status(await Save(ws, Rule(ws, id, database, Added, Call()))));
        // A member with full access cannot take over an owner's rule that calls one.
        Assert.Equal("access.denied", Status(await Save(ws, Rule(ws, id, database, Added, Call(), name: "Renamed"), member.Client)));
        // Nor is it called on an address that is not https to a public host.
        foreach (var url in new[] { "http://hooks.example.com/in", "https://10.0.0.5/in", "https://169.254.169.254/latest", "https://localhost/in", "https://hooks.example.com:8443/in", "https://user:pw@hooks.example.com/" })
        {
            var refused = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/webhooks", new { name = "Bad", url });
            Assert.Equal("webhook.address", await Kit.Code(refused));
        }
        // A webhook named in a rule must be there.
        Assert.Equal("not.found", Status(await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Added,
            [new JsonObject { ["kind"] = "webhook", ["webhookId"] = Guid.CreateVersion7().ToString(), ["properties"] = new JsonArray() }]))));
        // The secret is never read back.
        var listed = await ws.Client.GetStringAsync($"/api/v1/workspaces/{ws.Id}/webhooks");
        Assert.DoesNotContain("cgwh_", listed, StringComparison.Ordinal);
        Assert.StartsWith("cgwh_", (await Kit.Json(made)).GetProperty("secret").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_button_property_is_kept_by_a_build_that_does_not_know_it()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", Properties.DeepClone().AsArray());
        // 0.14.0 sends no propertyTypes: a def of the button's id as text keeps the button and its label, its name taken.
        var renamed = DatabaseTests.Prop("pBtn0001", "text", "Sign off");
        var result = await DatabaseTests.DbUpdate(ws, database, [renamed]);
        Assert.Equal("applied", result.GetProperty("status").GetString());
        var def = result.GetProperty("entity").GetProperty("database").GetProperty("properties").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "pBtn0001");
        Assert.Equal("button", def.GetProperty("type").GetString());
        Assert.Equal("Sign off", def.GetProperty("name").GetString());
        Assert.Equal("Approve", def.GetProperty("button").GetProperty("label").GetString());
        // A build of 21 types changes it as it says.
        var payload = new JsonObject { ["properties"] = new JsonArray(DatabaseTests.Prop("pBtn0001", "text", "Now text")), ["propertyTypes"] = 21 };
        var changed = (await ws.Push(ws.Op("db.update", database, payload)))[0];
        var now = changed.GetProperty("entity").GetProperty("database").GetProperty("properties").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "pBtn0001");
        Assert.Equal("text", now.GetProperty("type").GetString());
        // A button holds no value.
        var row = await DatabaseTests.NewRow(ws, database, "Row");
        Assert.Equal("applied", (await DatabaseTests.RowUpdate(ws, row.GetProperty("id").GetGuid(), new { pText001 = "x" })).GetProperty("status").GetString());
        // Pressed with no rule switched on for it: nothing to run, said so.
        var other = await DatabaseTests.NewDatabase(ws, "Approvals", Properties.DeepClone().AsArray());
        var target = (await DatabaseTests.NewRow(ws, other, "Row")).GetProperty("id").GetGuid();
        var press = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{other}/rows/{target}/press", new { propertyId = "pBtn0001", pressId = Guid.CreateVersion7() });
        Assert.Equal(HttpStatusCode.Conflict, press.StatusCode);
        Assert.Equal("automation.none", await Kit.Code(press));
    }

    [Fact]
    public async Task Row_events_are_written_only_while_a_rule_a_change_starts_is_on()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", Properties.DeepClone().AsArray());
        var row = (await DatabaseTests.NewRow(ws, database, "First")).GetProperty("id").GetGuid();
        await DatabaseTests.RowUpdate(ws, row, new { pText001 = "no rule yet" });
        // A date rule, a schedule, a button: none of them is started by a change.
        await Save(ws, Rule(ws, Guid.CreateVersion7(), database, new JsonObject { ["kind"] = "date", ["propertyId"] = "pDate001", ["offsetMinutes"] = 0 }, SetNotes("due")));
        await Save(ws, Rule(ws, Guid.CreateVersion7(), database, new JsonObject { ["kind"] = "button", ["propertyId"] = "pBtn0001" }, SetNotes("pressed")));
        // One a change starts, switched off.
        var off = Guid.CreateVersion7();
        await Save(ws, Rule(ws, off, database, Changed("pStat001"), SetNotes("off"), enabled: false));
        await DatabaseTests.RowUpdate(ws, row, new { pText001 = "rules but none on" });
        Assert.Empty(await Events(server, ws, database));

        // On: the row's change and its values, before and after.
        await Save(ws, Rule(ws, off, database, Changed("pStat001"), SetNotes("on")));
        await DatabaseTests.RowUpdate(ws, row, new { pStat001 = "sDone001", pText001 = "on" });
        var changed = Assert.Single(await Events(server, ws, database));
        Assert.Equal("changed", changed.Kind);
        Assert.Equal(row, changed.RowId);
        Assert.Equal(0, changed.Depth);
        Assert.Equal(ws.Account.Id, changed.ActorId);
        Assert.Equal(["pStat001", "pText001"], JsonSerializer.Deserialize<string[]>(changed.Changed)!);
        Assert.Equal("rules but none on", JsonNode.Parse(changed.Before)!["pText001"]!.GetValue<string>());
        Assert.Equal("sDone001", JsonNode.Parse(changed.After)!["pStat001"]!.GetValue<string>());
        Assert.Null(JsonNode.Parse(changed.Before)!["pStat001"]);

        // Every path that writes rows, and what each makes.
        var count = (await Events(server, ws, database)).Count;
        async Task<List<AutomationEvent>> Since() => [.. (await Events(server, ws, database)).Skip(count)];
        async Task Expect(int n, Func<Task> write)
        {
            await write();
            var made = await Since();
            Assert.Equal(n, made.Count);
            count += made.Count;
        }
        // A row added: one event, its kind added.
        Guid added = Guid.Empty;
        await Expect(1, async () => added = (await DatabaseTests.NewRow(ws, database, "Second", new { pStat001 = "sTodo001" })).GetProperty("id").GetGuid());
        // The title changed through the page: a change of `title`.
        await Expect(1, async () => await ws.Push(ws.Op("page.update", added, new { title = "Second, renamed" })));
        var title = (await Events(server, ws, database)).Last();
        Assert.Equal(["title"], JsonSerializer.Deserialize<string[]>(title.Changed)!);
        Assert.Equal("Second", JsonNode.Parse(title.Before)!["title"]!.GetValue<string>());
        // An icon, the order among the rows, the trash and back, a value written as it was: none.
        await Expect(0, async () => await ws.Push(ws.Op("page.update", added, new { icon = "🔥" })));
        var section = (await ws.Tree()).GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == database).GetProperty("sectionId").GetGuid();
        await Expect(0, async () => await ws.Push(ws.Op("page.move", added, new { sectionId = section, parentPageId = database, orderKey = "a5" })));
        await Expect(0, async () => await ws.Push(ws.Op("page.trash", added, new { })));
        await Expect(0, async () => await ws.Push(ws.Op("page.restore", added, new { })));
        await Expect(0, async () => await DatabaseTests.RowUpdate(ws, added, new { pStat001 = "sTodo001" }));
        // A template row: none, made or changed.
        await Expect(0, async () =>
        {
            var templateId = Guid.CreateVersion7();
            var payload = DatabaseTests.PageJson(templateId, ws.Id, section, database, "a9", "Template", "row");
            payload["isTemplate"] = true;
            payload["row"] = new JsonObject { ["values"] = new JsonObject { ["pText001"] = "t" } };
            await ws.Push(ws.Op("page.create", templateId, payload));
            await DatabaseTests.RowUpdate(ws, templateId, new { pText001 = "t2" });
        });
        // A formula recomputed by a change of its expression, and a type change converting every row: none.
        await Expect(0, async () => await DatabaseTests.DbUpdate(ws, database, [DatabaseTests.Prop("pForm001", "formula", "Double", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pNum0001\") * 3" } })]));
        await Expect(0, async () => await DatabaseTests.DbUpdate(ws, database, [DatabaseTests.Prop("pNum0001", "text", "Points")]));
        // A CSV import: none (DECISIONS.md, 2026-11-24).
        await Expect(0, async () =>
        {
            var import = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv = "Name\nImported", columns = new[] { "title" }, header = true });
            Assert.True(import.IsSuccessStatusCode, await import.Content.ReadAsStringAsync());
        });
        // The database's trash takes its rows with it: none.
        await Expect(0, async () => await ws.Push(ws.Op("page.trash", database, new { })));
    }

    [Fact]
    public async Task A_relation_kept_two_way_is_a_change_of_both_rows()
    {
        var ws = await Ws.Create(server);
        var props = Properties.DeepClone().AsArray();
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", props);
        await DatabaseTests.DbUpdate(ws, database, [DatabaseTests.Prop("pRel0001", "relation", "Blocks", new JsonObject
        {
            ["relation"] = new JsonObject { ["databaseId"] = database.ToString(), ["reversePropertyId"] = "pRev0001" },
        })]);
        await Save(ws, Rule(ws, Guid.CreateVersion7(), database, Changed(), SetNotes("seen")));
        var a = (await DatabaseTests.NewRow(ws, database, "A")).GetProperty("id").GetGuid();
        var b = (await DatabaseTests.NewRow(ws, database, "B")).GetProperty("id").GetGuid();
        var before = (await Events(server, ws, database)).Count;
        await DatabaseTests.RowUpdate(ws, a, new { pRel0001 = new[] { b.ToString() } });
        var made = (await Events(server, ws, database)).Skip(before).ToList();
        Assert.Equal(2, made.Count);
        Assert.Contains(made, e => e.RowId == a && e.Changed.Contains("pRel0001"));
        Assert.Contains(made, e => e.RowId == b && e.Changed.Contains("pRev0001"));
    }

    [Fact]
    public async Task The_workspace_switch_stops_and_starts_the_events_of_every_database()
    {
        var (ws, database) = await DatabaseWithRule();
        var row = (await DatabaseTests.NewRow(ws, database, "Row")).GetProperty("id").GetGuid();
        var before = (await Events(server, ws, database)).Count;
        var off = await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/settings", new { allOff = true });
        Assert.True(off.IsSuccessStatusCode, await off.Content.ReadAsStringAsync());
        Assert.True((await Kit.Json(off)).GetProperty("allOff").GetBoolean());
        await DatabaseTests.RowUpdate(ws, row, new { pStat001 = "sDone001" });
        Assert.Equal(before, (await Events(server, ws, database)).Count);
        await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/settings", new { allOff = false });
        await DatabaseTests.RowUpdate(ws, row, new { pStat001 = "sTodo001" });
        Assert.Equal(before + 1, (await Events(server, ws, database)).Count);
        // A member reads none of it, and a time zone this server does not know is refused.
        var member = await Kit.Join(server, ws, "member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/automations")).StatusCode);
        Assert.Equal("timeZone.unknown", await Kit.Code(await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/settings", new { timeZone = "Mars/Olympus" })));
        var zoned = await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/settings", new { timeZone = "Asia/Riyadh" });
        Assert.Equal("Asia/Riyadh", (await Kit.Json(zoned)).GetProperty("timeZone").GetString());
    }
}
