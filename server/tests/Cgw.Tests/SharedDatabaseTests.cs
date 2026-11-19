using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Sharing;
using Cgw.Worker.Jobs;

namespace Cgw.Tests;

/// <summary>
/// Phase 9: a share link's databases (DECISIONS.md, 2026-11-17): only a database whose page the
/// link holds, through one of its views; of each row only what that view shows, never a person's
/// id, never a hidden property's value (not in a cell, a formula of a person, a rollup out of the
/// scope, a cursor or a time); a filter, sort or group the reader sends is not read; related rows
/// named only in a database the link holds; files only of a shown file cell.
/// </summary>
public sealed class SharedDatabaseTests(ServerFixture server)
{
    private static JsonObject Relation(Guid database) =>
        new() { ["relation"] = new JsonObject { ["databaseId"] = database.ToString(), ["reversePropertyId"] = null } };

    private static async Task<Guid> Row(Ws ws, Guid database, string title, object values, string orderKey)
    {
        var id = Guid.CreateVersion7();
        var payload = DatabaseTests.PageJson(id, ws.Id, ws.Shared, database, orderKey, title, "row");
        payload["row"] = new JsonObject { ["values"] = JsonSerializer.SerializeToNode(values) };
        var result = (await ws.Push(ws.Op("page.create", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return id;
    }

    private static async Task View(Ws ws, Guid id, Guid database, string name, string orderKey, object config)
    {
        var result = (await ws.Push(ws.Op("view.upsert", id, new
        {
            id, workspaceId = ws.Id, databaseId = database, name, type = "table", orderKey, version = 1, createdAt = DateTimeOffset.UtcNow, config, viewTypes = 6,
        })))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
    }

    private static HttpClient Reader(ServerFixture server, string token)
    {
        var client = server.Anonymous();
        client.DefaultRequestHeaders.Add(SharedReader.Header, token);
        return client;
    }

    private static async Task<JsonElement> QueryOk(HttpClient reader, Guid database, object body)
    {
        var response = await reader.PostAsJsonAsync($"/api/v1/shared/databases/{database}/query", body);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    [Fact]
    public async Task A_share_links_database_reads_through_its_view_and_nothing_hidden_leaves()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Handbook")).GetProperty("id").GetGuid();
        var clients = await DatabaseTests.NewDatabase(ws, "Clients", [DatabaseTests.Prop("pNum0001", "number", "Size")], parent: root);
        var outside = await DatabaseTests.NewDatabase(ws, "Outside", [DatabaseTests.Prop("pNum0001", "number", "Budget")]);
        var tasks = await DatabaseTests.NewDatabase(ws, "Tasks", [
            DatabaseTests.Prop("pNum0001", "number", "Hours"),
            DatabaseTests.Prop("pTxt0001", "text", "Secret"),
            DatabaseTests.Prop("pPer0001", "person", "Owner"),
            DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = DatabaseTests.Options(("optA0001", "A"), ("optB0001", "B")) }),
            DatabaseTests.Prop("pRel0001", "relation", "Client", Relation(clients)),
            DatabaseTests.Prop("pRel0002", "relation", "Elsewhere", Relation(outside)),
            DatabaseTests.Prop("pFor0001", "formula", "Double", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pNum0001\") * 2" } }),
            DatabaseTests.Prop("pFor0002", "formula", "Who", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pPer0001\")" } }),
            DatabaseTests.Prop("pRol0001", "rollup", "Budget", new JsonObject { ["rollup"] = new JsonObject { ["relationPropertyId"] = "pRel0002", ["targetPropertyId"] = "pNum0001", ["fn"] = "sum" } }),
            DatabaseTests.Prop("pFil0001", "files", "Attachments"),
            DatabaseTests.Prop("pFil0002", "files", "Hidden files"),
            DatabaseTests.Prop("pCre0001", "createdTime", "Created"),
        ], parent: root);
        var restricted = await DatabaseTests.NewDatabase(ws, "Restricted", [], parent: root);
        await Kit.Share(ws, restricted, true);

        var shownFile = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "shown.png");
        var hiddenFile = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "hidden.png");
        await server.RunJob<AssetCheckJob>();
        var c1 = await Row(ws, clients, "C1", new { pNum0001 = 5 }, "a0");
        var o1 = await Row(ws, outside, "O1", new { pNum0001 = 1000 }, "a0");
        var t1 = await Row(ws, tasks, "T1", new
        {
            pNum0001 = 1, pTxt0001 = "alpha", pPer0001 = new[] { ws.Account.Id }, pSel0001 = "optA0001", pRel0001 = new[] { c1 }, pRel0002 = new[] { o1 },
            pFil0001 = new[] { shownFile }, pFil0002 = new[] { hiddenFile },
        }, "a1");
        await Row(ws, tasks, "T2", new { pNum0001 = 2, pTxt0001 = "beta", pSel0001 = "optB0001" }, "a2");
        await Row(ws, tasks, "T3", new { pNum0001 = 3, pTxt0001 = "gamma", pSel0001 = "optB0001" }, "a3");
        await Row(ws, tasks, "T4", new { pTxt0001 = "delta" }, "a4");

        // The view: Secret and the hidden files hidden, hours at least 0, by Secret descending, by Stage.
        var view = Guid.CreateVersion7();
        await View(ws, view, tasks, "Shown", "a0", new
        {
            filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pNum0001", @operator = "ge", value = 0 } } },
            sorts = new object[] { new { propertyId = "pTxt0001", direction = "desc" } },
            group = new { propertyId = "pSel0001" },
            properties = new { order = Array.Empty<string>(), hidden = new[] { "pTxt0001", "pFil0002", "pCre0001" }, widths = new { } },
        });
        var second = Guid.CreateVersion7();
        await View(ws, second, tasks, "All", "a5", new { filter = (object?)null, sorts = Array.Empty<object>(), group = (object?)null, properties = new { order = Array.Empty<string>(), hidden = Array.Empty<string>(), widths = new { } } });
        var token = (await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{root}/share-links", new { }))).GetProperty("token").GetString()!;
        var reader = Reader(server, token);

        // The tree says which pages are databases (so a database's own page draws its rows).
        var tree = (await reader.GetFromJsonAsync<JsonElement>("/api/v1/shared")).GetProperty("pages").EnumerateArray().ToList();
        Assert.Equal("page", tree.Single(p => p.GetProperty("id").GetGuid() == root).GetProperty("kind").GetString());
        Assert.Equal("database", tree.Single(p => p.GetProperty("id").GetGuid() == tasks).GetProperty("kind").GetString());
        Assert.DoesNotContain(tree, p => p.GetProperty("id").GetGuid() == restricted);

        // The database the link holds, with its views; not one it does not.
        var database = await reader.GetFromJsonAsync<JsonElement>($"/api/v1/shared/databases/{tasks}");
        Assert.Equal("Tasks", database.GetProperty("database").GetProperty("title").GetString());
        Assert.Contains("pTxt0001", database.GetProperty("database").GetProperty("properties").EnumerateArray().Select(p => p.GetProperty("id").GetString()));
        Assert.Equal([view, second], database.GetProperty("views").EnumerateArray().Select(v => v.GetProperty("id").GetGuid()));
        foreach (var notHeld in new[] { outside, restricted, Guid.CreateVersion7() })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/databases/{notHeld}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await reader.PostAsJsonAsync($"/api/v1/shared/databases/{notHeld}/query", new { })).StatusCode);
        }

        var answer = await QueryOk(reader, tasks, new { viewId = view, context = new { today = "2026-03-01", offsetMinutes = 0 } });
        Assert.Equal(3, answer.GetProperty("total").GetInt64());
        var rows = answer.GetProperty("rows").EnumerateArray().ToList();
        Assert.Equal(["T3", "T2", "T1"], rows.Select(r => r.GetProperty("title").GetString()));
        var first = rows[2];
        var values = first.GetProperty("values");
        var keys = values.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(["pFil0001", "pNum0001", "pRel0001", "pSel0001"], keys);
        Assert.Equal([c1], values.GetProperty("pRel0001").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal([shownFile], values.GetProperty("pFil0001").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal(["pFor0001"], first.GetProperty("computed").EnumerateObject().Select(p => p.Name));
        Assert.Equal(2, first.GetProperty("computed").GetProperty("pFor0001").GetDouble());
        Assert.Equal(JsonValueKind.Null, first.GetProperty("createdBy").ValueKind);
        Assert.Equal(JsonValueKind.Null, first.GetProperty("updatedBy").ValueKind);
        Assert.Equal(Guid.Empty, first.GetProperty("workspaceId").GetGuid());
        // The created time is hidden in this view: no row says when it was made.
        Assert.Equal(DateTimeOffset.UnixEpoch, first.GetProperty("createdAt").GetDateTimeOffset());
        Assert.Equal("C1", answer.GetProperty("titles").GetProperty(c1.ToString()).GetString());
        Assert.False(answer.GetProperty("titles").TryGetProperty(o1.ToString(), out _));
        Assert.Equal([("optA0001", 1L), ("optB0001", 2L)],
            answer.GetProperty("groups").EnumerateArray().Select(g => (g.GetProperty("key").GetString()!, g.GetProperty("count").GetInt64())).Where(g => g.Item1.Length > 0));
        // Nothing of the hidden or the people's anywhere in the answer.
        var text = answer.GetRawText();
        foreach (var never in new[] { "alpha", "beta", "gamma", "delta", ws.Account.Id.ToString(), o1.ToString(), hiddenFile.ToString(), ws.Id.ToString(), ws.Shared.ToString() })
            Assert.DoesNotContain(never, text);

        // A filter, sorts or a group the reader sends are not read; the group key and the search are.
        var probing = await QueryOk(reader, tasks, new
        {
            viewId = view,
            filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pTxt0001", @operator = "is", value = "alpha" } } },
            sorts = new object[] { new { propertyId = "pNum0001", direction = "asc" } },
            group = (object?)null,
        });
        Assert.Equal(["T3", "T2", "T1"], probing.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        Assert.Equal(2, (await QueryOk(reader, tasks, new { viewId = view, groupKey = "optB0001" })).GetProperty("total").GetInt64());
        Assert.Equal(["T2"], (await QueryOk(reader, tasks, new { viewId = view, search = "t2" })).GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        // A window may name only a property the view shows.
        var window = await reader.PostAsJsonAsync($"/api/v1/shared/databases/{tasks}/query", new { viewId = view, window = new { propertyId = "pCre0001", from = "2026-01-01", to = "2099-01-01" } });
        Assert.Equal(HttpStatusCode.BadRequest, window.StatusCode);

        // Pages by an offset cursor that holds no sort key.
        var page1 = await QueryOk(reader, tasks, new { viewId = view, limit = 2 });
        var next = page1.GetProperty("next").GetString()!;
        var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(next.Replace('-', '+').Replace('_', '/').PadRight(next.Length + (4 - next.Length % 4) % 4, '=')));
        Assert.DoesNotContain("gamma", decoded);
        Assert.DoesNotContain("beta", decoded);
        var page2 = await QueryOk(reader, tasks, new { viewId = view, limit = 2, after = next });
        Assert.Equal(["T1"], page2.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        Assert.Equal(JsonValueKind.Null, page2.GetProperty("next").ValueKind);
        Assert.Equal(HttpStatusCode.BadRequest, (await reader.PostAsJsonAsync($"/api/v1/shared/databases/{tasks}/query", new { viewId = view, after = "nope" })).StatusCode);

        // No view named: the database's first. Another database's view is not this one's.
        Assert.Equal(3, (await QueryOk(reader, tasks, new { })).GetProperty("total").GetInt64());
        var all = await QueryOk(reader, tasks, new { viewId = second });
        Assert.Equal(4, all.GetProperty("total").GetInt64());
        Assert.Contains("alpha", all.GetRawText());
        Assert.DoesNotContain(ws.Account.Id.ToString(), all.GetRawText());
        Assert.Equal(HttpStatusCode.NotFound, (await reader.PostAsJsonAsync($"/api/v1/shared/databases/{clients}/query", new { viewId = view })).StatusCode);

        // A file in a shown file cell reads by the link; one in a hidden property does not.
        Assert.True((await reader.GetAsync($"/api/v1/shared/assets/{shownFile}/url")).IsSuccessStatusCode);
        await View(ws, second, tasks, "All", "a5", new { filter = (object?)null, sorts = Array.Empty<object>(), group = (object?)null, properties = new { order = Array.Empty<string>(), hidden = new[] { "pFil0002" }, widths = new { } } });
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/assets/{hiddenFile}/url")).StatusCode);

        // Without the token, or once the link is revoked: nothing.
        Assert.Equal(HttpStatusCode.NotFound, (await server.Anonymous().GetAsync($"/api/v1/shared/databases/{tasks}")).StatusCode);
        var link = Assert.Single((await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{root}/share-links")).EnumerateArray()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/pages/{root}/share-links/{link}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.PostAsJsonAsync($"/api/v1/shared/databases/{tasks}/query", new { viewId = view })).StatusCode);
        _ = t1;
    }

    [Fact]
    public async Task A_signed_in_browsers_cookie_does_not_stop_a_share_links_query()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Cookie")).GetProperty("id").GetGuid();
        var database = await DatabaseTests.NewDatabase(ws, "Inline", [], parent: root);
        await Row(ws, database, "Only", new { }, "a0");
        var token = (await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{root}/share-links", new { }))).GetProperty("token").GetString()!;
        // The member's own client: the session cookie, and no antiforgery header on this request.
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/shared/databases/{database}/query") { Content = JsonContent.Create(new { }) };
        request.Headers.Add(SharedReader.Header, token);
        ws.Client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        var response = await ws.Client.SendAsync(request);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        Assert.Equal(1, (await Kit.Json(response)).GetProperty("total").GetInt64());
    }

    [Fact]
    public async Task A_share_links_timeline_reads_its_window_and_its_undated_rows()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Plan")).GetProperty("id").GetGuid();
        var database = await DatabaseTests.NewDatabase(ws, "Work", [
            DatabaseTests.Prop("pDat0001", "date", "When"),
            DatabaseTests.Prop("pTxt0001", "text", "Note"),
        ], parent: root);
        await Row(ws, database, "In", new { pDat0001 = new { start = "2026-12-03" }, pTxt0001 = "a" }, "a0");
        await Row(ws, database, "Later", new { pDat0001 = new { start = "2027-03-01" }, pTxt0001 = "b" }, "a1");
        await Row(ws, database, "Undated", new { pTxt0001 = "c" }, "a2");
        // A timeline as a new one is made: only the title shown, its date property hidden.
        var timeline = Guid.CreateVersion7();
        var made = (await ws.Push(ws.Op("view.upsert", timeline, new
        {
            id = timeline, workspaceId = ws.Id, databaseId = database, name = "Timeline", type = "timeline", orderKey = "a0", version = 1,
            createdAt = DateTimeOffset.UtcNow, viewTypes = 6,
            config = new
            {
                filter = (object?)null, sorts = Array.Empty<object>(), group = (object?)null,
                properties = new { order = Array.Empty<string>(), hidden = new[] { "pDat0001", "pTxt0001" }, widths = new { } },
                timeline = new { start = "pDat0001" },
            },
        })))[0];
        Assert.True(made.GetProperty("status").GetString() == "applied", made.ToString());
        var table = Guid.CreateVersion7();
        await View(ws, table, database, "Table", "a1", new { filter = (object?)null, sorts = Array.Empty<object>(), group = (object?)null, properties = new { order = Array.Empty<string>(), hidden = Array.Empty<string>(), widths = new { } } });
        var token = (await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{root}/share-links", new { }))).GetProperty("token").GetString()!;
        var reader = Reader(server, token);
        static string[] Titles(JsonElement answer) => answer.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()!).ToArray();

        // The window on the timeline's own date property, which it lays its rows out by.
        var inWindow = await QueryOk(reader, database, new { viewId = timeline, window = new { propertyId = "pDat0001", from = "2026-12-01", to = "2026-12-31" } });
        Assert.Equal(["In"], Titles(inWindow));
        var row = inWindow.GetProperty("rows")[0].GetProperty("values");
        Assert.Equal("2026-12-03", row.GetProperty("pDat0001").GetProperty("start").GetString());
        Assert.False(row.TryGetProperty("pTxt0001", out _), row.ToString());
        // Its undated rows, by the flag, not by a filter the reader sends.
        Assert.Equal(["Undated"], Titles(await QueryOk(reader, database, new { viewId = timeline, undated = true })));
        var ignored = await QueryOk(reader, database, new
        {
            viewId = timeline,
            filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pDat0001", @operator = "isEmpty" } } },
        });
        Assert.Equal(3, ignored.GetProperty("total").GetInt64());
        // A view with no date of its own has no undated list.
        var refused = await reader.PostAsJsonAsync($"/api/v1/shared/databases/{database}/query", new { viewId = table, undated = true });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
    }

    /// <summary>A chart view (Phase 12): its group, its measure and the properties its config says it hides (which a chart's reading does not go by).</summary>
    private static async Task UpsertChart(Ws ws, Guid id, Guid database, string orderKey, object? group, object measure, string[] hidden, string type = "chart")
    {
        var result = (await ws.Push(ws.Op("view.upsert", id, new
        {
            id, workspaceId = ws.Id, databaseId = database, name = "Chart", type, orderKey, version = 1, createdAt = DateTimeOffset.UtcNow, viewTypes = 7,
            config = new
            {
                filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pNum0001", @operator = "ge", value = 0 } } },
                sorts = Array.Empty<object>(),
                group,
                properties = new { order = Array.Empty<string>(), hidden, widths = new { } },
                chart = new { kind = "bar", measure, title = (string?)null },
            },
        })))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
    }

    private static List<string> Keys(JsonElement answer) =>
        answer.GetProperty("rows").EnumerateArray().SelectMany(r => r.GetProperty("values").EnumerateObject().Select(p => p.Name)
            .Concat(r.GetProperty("computed").EnumerateObject().Select(p => p.Name))).Distinct().Order(StringComparer.Ordinal).ToList();

    [Fact]
    public async Task A_share_links_chart_view_shows_only_its_group_and_measure_and_one_reading_what_may_not_leave_is_refused()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Report")).GetProperty("id").GetGuid();
        var database = await DatabaseTests.NewDatabase(ws, "Effort", [
            DatabaseTests.Prop("pNum0001", "number", "Hours"),
            DatabaseTests.Prop("pNum0002", "number", "Cost"),
            DatabaseTests.Prop("pTxt0001", "text", "Secret"),
            DatabaseTests.Prop("pPer0001", "person", "Owner"),
            DatabaseTests.Prop("pCby0001", "createdBy", "Made by"),
            DatabaseTests.Prop("pFor0001", "formula", "Owner's", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pPer0001\")" } }),
            DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = DatabaseTests.Options(("optA0001", "A"), ("optB0001", "B"), ("optC0001", "C")) }),
        ], parent: root);
        await Row(ws, database, "T1", new { pNum0001 = 1, pNum0002 = 100, pTxt0001 = "alpha", pSel0001 = "optA0001", pPer0001 = new[] { ws.Account.Id } }, "a1");
        var t2 = await Row(ws, database, "T2", new { pNum0001 = 2, pNum0002 = 200, pTxt0001 = "beta", pSel0001 = "optB0001" }, "a2");
        await Row(ws, database, "T3", new { pNum0001 = 3, pNum0002 = 300, pTxt0001 = "gamma", pSel0001 = "optB0001" }, "a3");
        await Row(ws, database, "T4", new { pNum0001 = -1, pTxt0001 = "delta", pSel0001 = "optA0001" }, "a4");

        var sum = new { kind = "sum", propertyId = "pNum0001" };
        var count = new { kind = "count" };
        var stage = new { propertyId = "pSel0001", hideEmpty = true, hidden = new[] { "" } };
        // Hours by stage. Its config hides nothing: a chart shows the title, its group and its measure all the same.
        var shown = Guid.CreateVersion7();
        await UpsertChart(ws, shown, database, "a0", stage, sum, []);
        // Its config hides its own group and measure: they are the chart's, and read.
        var ownHidden = Guid.CreateVersion7();
        await UpsertChart(ws, ownHidden, database, "a1", stage, new { kind = "average", propertyId = "pNum0002" }, ["pSel0001", "pNum0002"]);
        // Grouped by a person, by who made the rows, or summing a formula of a person: never by link.
        var byPerson = Guid.CreateVersion7();
        await UpsertChart(ws, byPerson, database, "a2", new { propertyId = "pPer0001" }, count, []);
        var byCreator = Guid.CreateVersion7();
        await UpsertChart(ws, byCreator, database, "a3", new { propertyId = "pCby0001" }, count, []);
        var ofPeople = Guid.CreateVersion7();
        await UpsertChart(ws, ofPeople, database, "a4", stage, new { kind = "sum", propertyId = "pFor0001" }, []);
        // No group; a sum of a property that is not a number (it counts, as the app's chart does).
        var noGroup = Guid.CreateVersion7();
        await UpsertChart(ws, noGroup, database, "a5", null, count, []);
        var notANumber = Guid.CreateVersion7();
        await UpsertChart(ws, notANumber, database, "a6", stage, new { kind = "sum", propertyId = "pTxt0001" }, []);
        // A table with the same settings, to show what its properties alone would let out.
        var table = Guid.CreateVersion7();
        await UpsertChart(ws, table, database, "a7", stage, sum, ["pPer0001"], type: "table");
        var token = (await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{root}/share-links", new { }))).GetProperty("token").GetString()!;
        var reader = Reader(server, token);

        // The views and their settings come with the database, the chart's among them.
        var listed = await reader.GetFromJsonAsync<JsonElement>($"/api/v1/shared/databases/{database}");
        var chart = listed.GetProperty("views").EnumerateArray().Single(v => v.GetProperty("id").GetGuid() == shown);
        Assert.Equal("chart", chart.GetProperty("type").GetString());
        Assert.Equal("pNum0001", chart.GetProperty("config").GetProperty("chart").GetProperty("measure").GetProperty("propertyId").GetString());

        // Grouped by its own group, as the view says (the empty group hidden, empty ones left out):
        // the counts at any size, and each group's rows for the sums.
        var answer = await QueryOk(reader, database, new { viewId = shown, limit = 500 });
        Assert.Equal([("optA0001", 1L), ("optB0001", 2L)],
            answer.GetProperty("groups").EnumerateArray().Select(g => (g.GetProperty("key").GetString()!, g.GetProperty("count").GetInt64())));
        Assert.Equal(3, answer.GetProperty("total").GetInt64());
        Assert.Equal(["pNum0001", "pSel0001"], Keys(answer));
        var b = await QueryOk(reader, database, new { viewId = shown, groupKey = "optB0001" });
        Assert.Equal(["T2", "T3"], b.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()).Order(StringComparer.Ordinal));
        var text = answer.GetRawText() + b.GetRawText();
        foreach (var never in new[] { "alpha", "beta", "gamma", "delta", ws.Account.Id.ToString(), "\"pNum0002\"" })
            Assert.DoesNotContain(never, text);
        // What its config hides of its own group and measure, it reads; nothing else.
        var own = await QueryOk(reader, database, new { viewId = ownHidden, groupKey = "optB0001" });
        Assert.Equal(["pNum0002", "pSel0001"], Keys(own));
        Assert.Contains("300", own.GetRawText());

        // A group or a measure whose values may not leave: refused, whatever is asked of it.
        foreach (var refused in new[] { byPerson, byCreator, ofPeople })
            foreach (var body in new object[] { new { viewId = refused }, new { viewId = refused, groupKey = "optA0001" }, new { viewId = refused, search = "t" } })
            {
                var response = await reader.PostAsJsonAsync($"/api/v1/shared/databases/{database}/query", body);
                Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
                Assert.Equal("chart.hidden", await Kit.Code(response));
                Assert.DoesNotContain("gamma", await response.Content.ReadAsStringAsync());
            }
        // No group: the rows come ungrouped with their titles only (the app asks for a group).
        var ungrouped = await QueryOk(reader, database, new { viewId = noGroup });
        Assert.Equal(JsonValueKind.Null, ungrouped.GetProperty("groups").ValueKind);
        Assert.Equal(3, ungrouped.GetProperty("total").GetInt64());
        Assert.Empty(Keys(ungrouped));
        var counted = await QueryOk(reader, database, new { viewId = notANumber });
        Assert.Equal(["pSel0001"], Keys(counted));

        // A property added to the database after the views: in no view's hidden list. The table lets
        // it out; the chart, which does not draw it, does not.
        var added = (await ws.Push(ws.Op("db.update", database, new { properties = new[] { new { id = "pLate001", name = "Added later", type = "text" } } })))[0];
        Assert.True(added.GetProperty("status").GetString() == "applied", added.ToString());
        var updated = (await ws.Push(ws.Op("row.update", t2, new { values = new { pLate001 = "zeta" } })))[0];
        Assert.True(updated.GetProperty("status").GetString() == "applied", updated.ToString());
        Assert.Contains("zeta", (await QueryOk(reader, database, new { viewId = table, groupKey = "optB0001" })).GetRawText());
        foreach (var body in new object[] { new { viewId = shown }, new { viewId = shown, groupKey = "optB0001" }, new { viewId = ownHidden, groupKey = "optB0001" }, new { viewId = noGroup } })
        {
            var later = await QueryOk(reader, database, body);
            Assert.DoesNotContain("zeta", later.GetRawText());
            Assert.DoesNotContain("pLate001", Keys(later));
        }
    }

    [Fact]
    public async Task A_file_property_added_after_a_chart_view_is_not_readable_through_it()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Files")).GetProperty("id").GetGuid();
        var database = await DatabaseTests.NewDatabase(ws, "Papers", [
            DatabaseTests.Prop("pNum0001", "number", "Pages"),
            DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = DatabaseTests.Options(("optA0001", "A")) }),
        ], parent: root);
        var row = await Row(ws, database, "Paper", new { pNum0001 = 1, pSel0001 = "optA0001" }, "a1");
        // The database's only view a chart, whose config hides nothing.
        await UpsertChart(ws, Guid.CreateVersion7(), database, "a0", new { propertyId = "pSel0001" }, new { kind = "count" }, []);
        var file = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "added-later.png");
        await server.RunJob<AssetCheckJob>();
        var added = (await ws.Push(ws.Op("db.update", database, new { properties = new[] { new { id = "pFil0001", name = "Scan", type = "files" } } })))[0];
        Assert.True(added.GetProperty("status").GetString() == "applied", added.ToString());
        var updated = (await ws.Push(ws.Op("row.update", row, new { values = new { pFil0001 = new[] { file } } })))[0];
        Assert.True(updated.GetProperty("status").GetString() == "applied", updated.ToString());
        var token = (await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{root}/share-links", new { }))).GetProperty("token").GetString()!;
        var reader = Reader(server, token);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/assets/{file}/url")).StatusCode);
        // A table that shows it does let it be read (the control).
        await UpsertChart(ws, Guid.CreateVersion7(), database, "a1", null, new { kind = "count" }, [], type: "table");
        Assert.True((await reader.GetAsync($"/api/v1/shared/assets/{file}/url")).IsSuccessStatusCode);
    }

    [Fact]
    public void The_cursor_is_an_offset_only()
    {
        Assert.Equal(250, SharedDatabases.ReadCursor(SharedDatabases.Cursor(250)));
        Assert.Null(SharedDatabases.ReadCursor("eyJrIjpbXX0"));
        Assert.Null(SharedDatabases.ReadCursor("%%%"));
        Assert.Equal(["p1", "p2", "p3"], SharedDatabases.LayoutProperties("timeline", JsonNode.Parse("""{"timeline":{"start":"p1","end":"p2","lane":"p3"}}""")!.AsObject()));
        Assert.Equal(["g", "c"], SharedDatabases.LayoutProperties("calendar", JsonNode.Parse("""{"group":{"propertyId":"g"},"calendarBy":"c"}""")!.AsObject()));
    }
}
