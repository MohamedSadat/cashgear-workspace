using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Forms;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 16 on the server: the eighth view type and the older-build rule, a member's answer in the
/// app, a form's link (who makes it, its switch, closing time and maximum), a link's answer with no
/// session (the row of nobody, audited with its address), its pages on the Sites process with script
/// off, what a link reads (its questions and nothing else), the limits, and the rules an answer starts.
/// </summary>
public sealed class FormTests(ServerFixture server)
{
    private static readonly JsonArray Properties = new(
        DatabaseTests.Prop("pEml0001", "email", "Email"),
        DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = DatabaseTests.Options(("optNew01", "New"), ("optOld01", "Old"), ("optSec01", "Secret stage")) }),
        DatabaseTests.Prop("pNum0001", "number", "Seats"),
        DatabaseTests.Prop("pText001", "text", "Notes"),
        DatabaseTests.Prop("pPers001", "person", "Owner"),
        DatabaseTests.Prop("pStat001", "status", "Status", new JsonObject
        {
            ["options"] = new JsonArray(
                new JsonObject { ["id"] = "sTodo001", ["name"] = "To do", ["colour"] = "default", ["group"] = "todo" },
                new JsonObject { ["id"] = "sDone001", ["name"] = "Done", ["colour"] = "green", ["group"] = "complete" }),
        }));

    /// <summary>Two pages: the name, an email and a stage (two of its three options); seats only for a new one.</summary>
    private static JsonObject Form(string language = "en") => new()
    {
        ["title"] = "Sign up",
        ["description"] = "Tell us who you are",
        ["language"] = language,
        ["thanks"] = "We have it, thank you",
        ["pages"] = new JsonArray(
            new JsonObject
            {
                ["questions"] = new JsonArray(
                    new JsonObject { ["propertyId"] = "title", ["label"] = "Your name", ["required"] = true },
                    new JsonObject { ["propertyId"] = "pEml0001", ["required"] = true, ["help"] = "We write only about this" },
                    new JsonObject { ["propertyId"] = "pSel0001", ["options"] = new JsonArray("optNew01", "optOld01") },
                    new JsonObject { ["propertyId"] = "pPers001" }),
            },
            new JsonObject
            {
                ["title"] = "Seats",
                ["when"] = new JsonObject
                {
                    ["kind"] = "group", ["op"] = "and",
                    ["children"] = new JsonArray(new JsonObject { ["kind"] = "condition", ["propertyId"] = "pSel0001", ["operator"] = "is", ["value"] = "optNew01" }),
                },
                ["questions"] = new JsonArray(new JsonObject { ["propertyId"] = "pNum0001", ["required"] = true }),
            },
            new JsonObject { ["questions"] = new JsonArray(new JsonObject { ["propertyId"] = "pText001" }) }),
    };

    private static async Task<JsonElement> UpsertView(Ws ws, Guid id, Guid database, string type, JsonObject config, int? viewTypes = 8, HttpClient? client = null)
    {
        var payload = new JsonObject
        {
            ["id"] = id.ToString(), ["workspaceId"] = ws.Id.ToString(), ["databaseId"] = database.ToString(), ["name"] = "Sign-ups", ["type"] = type,
            ["orderKey"] = "a1", ["version"] = 1, ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"), ["config"] = config.DeepClone(),
        };
        if (viewTypes is { } n) payload["viewTypes"] = n;
        var result = (await ws.Push(client ?? ws.Client, ws.Op("view.upsert", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return result.GetProperty("entity").GetProperty("view");
    }

    private static JsonObject Config(JsonObject? form = null, JsonObject? filter = null) => new()
    {
        ["filter"] = filter,
        ["sorts"] = new JsonArray(),
        ["group"] = null,
        ["properties"] = new JsonObject { ["order"] = new JsonArray("title", "pEml0001"), ["hidden"] = new JsonArray("pPers001"), ["widths"] = new JsonObject() },
        ["form"] = form ?? Form(),
    };

    private sealed record Setup(Ws Ws, Guid Database, Guid View);

    private async Task<Setup> FormDatabase(string language = "en", bool personal = false)
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Sign-ups", Properties.DeepClone().AsArray(), section: personal ? ws.Personal : null);
        var view = Guid.CreateVersion7();
        await UpsertView(ws, view, database, "form", Config(Form(language)));
        return new Setup(ws, database, view);
    }

    private static string FormPath(Setup s) => $"/api/v1/databases/{s.Database}/views/{s.View}/form";

    private static async Task<(string Token, JsonElement Link)> MakeLink(Setup s, object? body = null)
    {
        var response = await s.Ws.Client.PostAsJsonAsync(FormPath(s) + "/link", body ?? new { enabled = true });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var link = await Kit.Json(response);
        var url = link.GetProperty("url").GetString()!;
        Assert.StartsWith("http://localhost:5290/_form/", url);
        return (url[(url.LastIndexOf('/') + 1)..], link);
    }

    private static FormUrlEncodedContent Fields(params (string Name, string Value)[] fields) =>
        new(fields.Select(f => KeyValuePair.Create(f.Name, f.Value)));

    /// <summary>A whole answer of the two pages shown for an old stage (the seats' page skipped).</summary>
    private static (string, string)[] Whole(string name = "Sara") =>
        [("q.title", name), ("q.pEml0001", "sara@example.com"), ("q.pSel0001", "optOld01"), ("q.pText001", "See you"), ("at", "2"), ("go", "next")];

    private async Task<List<Page>> Answers(Setup s) =>
        await Kit.InWorker(server, s.Ws.Id, (_, db) => db.Pages.AsNoTracking().Where(p => p.ParentPageId == s.Database && p.Kind == PageKinds.Row && p.DeletedAt == null).ToListAsync());

    private static async Task<HttpResponseMessage> Answer(HttpClient client, string token, params (string, string)[] fields) =>
        await client.PostAsync($"/api/v1/forms/{token}", Fields(fields));

    private static void SeeOther(HttpResponseMessage response, string token, string rest = "")
    {
        Assert.Equal(HttpStatusCode.SeeOther, response.StatusCode);
        Assert.Equal($"http://localhost:5290/_form/{token}{rest}", response.Headers.Location!.ToString());
    }

    [Fact]
    public async Task A_form_is_the_eighth_view_type_and_an_older_build_keeps_it_and_its_settings()
    {
        var s = await FormDatabase();
        Assert.Equal("form", DatabaseOps.ViewTypeOrder[^1]);
        Assert.True(DatabaseOps.ConfigKeysKnownBy(8).SetEquals([.. DatabaseOps.ConfigKeysKnownBy(7), "form"]));

        // 0.15.0 (seven types) drew it as a table, changed its filter and sent it back without `form`.
        var filter = new JsonObject
        {
            ["kind"] = "group", ["op"] = "and",
            ["children"] = new JsonArray(new JsonObject { ["kind"] = "condition", ["propertyId"] = "pText001", ["operator"] = "isNotEmpty" }),
        };
        var older = Config(filter: filter);
        older.Remove("form");
        var kept = await UpsertView(s.Ws, s.View, s.Database, "table", older, 7);
        Assert.Equal("form", kept.GetProperty("type").GetString());
        Assert.Equal("Sign up", kept.GetProperty("config").GetProperty("form").GetProperty("title").GetString());
        Assert.Equal("isNotEmpty", kept.GetProperty("config").GetProperty("filter").GetProperty("children")[0].GetProperty("operator").GetString());
        // A build before 0.9.0 (none sent) too; one of eight types is taken as it sends.
        Assert.Equal("form", (await UpsertView(s.Ws, s.View, s.Database, "table", older, null)).GetProperty("type").GetString());
        Assert.Equal("table", (await UpsertView(s.Ws, s.View, s.Database, "table", older, 8)).GetProperty("type").GetString());
    }

    [Fact]
    public async Task A_members_answer_marks_its_row_by_its_form_and_starts_both_triggers_once()
    {
        var s = await FormDatabase();
        var table = Guid.CreateVersion7();
        await UpsertView(s.Ws, table, s.Database, "table", Config());
        var answered = Guid.CreateVersion7();
        var added = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(s.Ws, AutomationTests.Rule(s.Ws, answered, s.Database,
            new JsonObject { ["kind"] = "formAnswered", ["viewId"] = s.View.ToString() }, AutomationTests.SetNotes("answered")))));
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(s.Ws, AutomationTests.Rule(s.Ws, added, s.Database, AutomationTests.Added,
            [new JsonObject { ["kind"] = "set", ["values"] = new JsonObject { ["pStat001"] = "sDone001" } }]))));
        // A form trigger names a form view of this database, never another view.
        Assert.Equal("invalid", AutomationTests.Status(await AutomationTests.Save(s.Ws, AutomationTests.Rule(s.Ws, Guid.CreateVersion7(), s.Database,
            new JsonObject { ["kind"] = "formAnswered", ["viewId"] = table.ToString() }, AutomationTests.SetNotes("x")))));

        // A member's answer is a row they add, marked by its form (a view that is no form marks nothing).
        var tree = await s.Ws.Tree();
        var section = tree.GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == s.Database).GetProperty("sectionId").GetGuid();
        async Task<JsonElement> Create(string title, Guid? formId)
        {
            var id = Guid.CreateVersion7();
            var payload = DatabaseTests.PageJson(id, s.Ws.Id, section, s.Database, "a" + title.Length, title, "row");
            payload["row"] = new JsonObject { ["values"] = new JsonObject { ["pEml0001"] = "m@example.com" } };
            payload["formId"] = formId?.ToString();
            var result = (await s.Ws.Push(s.Ws.Op("page.create", id, payload)))[0];
            Assert.Equal("applied", result.GetProperty("status").GetString());
            return result.GetProperty("entity").GetProperty("row");
        }
        var mine = await Create("Mine", s.View);
        Assert.Equal(s.View, mine.GetProperty("formId").GetGuid());
        Assert.Equal(s.Ws.Account.Id, mine.GetProperty("createdBy").GetGuid());
        var plain = await Create("Plain", table);
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("formId").ValueKind);

        await server.RunJob<AutomationJob>(200);
        var runs = await Kit.InWorker(server, s.Ws.Id, (_, db) => db.AutomationRuns.AsNoTracking().Where(r => r.DatabaseId == s.Database).ToListAsync());
        Assert.Single(runs, r => r.AutomationId == answered);
        Assert.Equal(mine.GetProperty("id").GetGuid(), runs.Single(r => r.AutomationId == answered).RowId);
        // "A row is added" runs for both rows, the answer's among them.
        Assert.Equal(2, runs.Count(r => r.AutomationId == added));
        // The count of the form's answers.
        var state = await s.Ws.Client.GetFromJsonAsync<JsonElement>(FormPath(s));
        Assert.Equal(1, state.GetProperty("answers").GetInt32());
    }

    [Fact]
    public async Task Full_access_makes_the_link_one_a_form_and_none_in_a_private_section()
    {
        var s = await FormDatabase();
        var editor = await Kit.Join(server, s.Ws, "member");
        await Kit.Share(s.Ws, s.Database, true, ("user", s.Ws.Account.Id, "full"), ("user", editor.Id, "edit"));
        Assert.Equal(HttpStatusCode.Forbidden, (await editor.Client.PostAsJsonAsync(FormPath(s) + "/link", new { enabled = true })).StatusCode);

        var (token, link) = await MakeLink(s, new { enabled = true, maxAnswers = 3 });
        Assert.Equal("open", link.GetProperty("state").GetString());
        Assert.Equal(3, link.GetProperty("maxAnswers").GetInt32());
        var again = await s.Ws.Client.PostAsJsonAsync(FormPath(s) + "/link", new { enabled = true });
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("form.linkExists", await Kit.Code(again));
        // Its readers read it, address and all; only full access changes it.
        var read = await editor.Client.GetFromJsonAsync<JsonElement>(FormPath(s));
        Assert.False(read.GetProperty("canManage").GetBoolean());
        Assert.EndsWith(token, read.GetProperty("link").GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await editor.Client.PutAsJsonAsync(FormPath(s) + "/link", new { enabled = false })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await editor.Client.DeleteAsync(FormPath(s) + "/link")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await s.Ws.Client.PutAsJsonAsync(FormPath(s) + "/link", new { enabled = true, maxAnswers = 0 })).StatusCode);
        // A view that is no form has no link.
        var table = Guid.CreateVersion7();
        await UpsertView(s.Ws, table, s.Database, "table", Config());
        Assert.Equal(HttpStatusCode.NotFound, (await s.Ws.Client.GetAsync($"/api/v1/databases/{s.Database}/views/{table}/form")).StatusCode);

        // A database in a private section takes none.
        var mine = await FormDatabase(personal: true);
        var refused = await mine.Ws.Client.PostAsJsonAsync(FormPath(mine) + "/link", new { enabled = true });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.False((await mine.Ws.Client.GetFromJsonAsync<JsonElement>(FormPath(mine))).GetProperty("linksAllowed").GetBoolean());

        // Each change audited.
        var actions = await Kit.InWorker(server, s.Ws.Id, (_, db) => db.AuditLog.AsNoTracking().Where(a => a.WorkspaceId == s.Ws.Id && a.Action.StartsWith("form.")).Select(a => a.Action).ToListAsync());
        Assert.Contains("form.link.create", actions);
    }

    [Fact]
    public async Task A_links_answer_adds_a_row_of_nobody_audited_with_its_address_and_starts_its_rules_once()
    {
        var s = await FormDatabase();
        var (token, _) = await MakeLink(s);
        var answered = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(s.Ws, AutomationTests.Rule(s.Ws, answered, s.Database,
            new JsonObject { ["kind"] = "formAnswered", ["viewId"] = s.View.ToString() }, AutomationTests.SetNotes("answered")))));

        // Signed in or not, the answer is nobody's: the session sent with it is never read.
        SeeOther(await Answer(s.Ws.Client, token, Whole()), token, "/done");
        var row = Assert.Single(await Answers(s));
        Assert.Equal("Sara", row.Title);
        Assert.Equal(Guid.Empty, row.CreatedBy);
        Assert.Equal(s.View, row.FormId);
        var values = await Kit.InWorker(server, s.Ws.Id, (_, db) => db.DatabaseRows.AsNoTracking().FirstAsync(r => r.PageId == row.Id));
        var map = ValueJson.ReadMap(values.Values);
        Assert.Equal("sara@example.com", map["pEml0001"]);
        Assert.Equal("optOld01", map["pSel0001"]);
        Assert.False(map.ContainsKey("pNum0001"));

        var audit = await Kit.InWorker(server, s.Ws.Id, (_, db) => db.AuditLog.AsNoTracking().SingleAsync(a => a.WorkspaceId == s.Ws.Id && a.Action == "form.answer"));
        Assert.Null(audit.ActorUserId);
        Assert.Contains(row.Id.ToString(), audit.Detail);

        await server.RunJob<AutomationJob>(200);
        await server.RunJob<AutomationJob>(20);
        var run = Assert.Single(await Kit.InWorker(server, s.Ws.Id, (_, db) => db.AutomationRuns.AsNoTracking().Where(r => r.AutomationId == answered).ToListAsync()));
        Assert.Equal(row.Id, run.RowId);
        Assert.Null(run.ActorId);
        // Its readers see the row, created by the form (no person).
        var rows = await s.Ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{s.Database}/rows");
        var read = rows.GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("id").GetGuid() == row.Id);
        Assert.Equal(JsonValueKind.Null, read.GetProperty("createdBy").ValueKind);
        Assert.Equal(s.View, read.GetProperty("formId").GetGuid());
        Assert.Equal("answered", read.GetProperty("values").GetProperty("pText001").GetString());
        Assert.Equal(1, (await s.Ws.Client.GetFromJsonAsync<JsonElement>(FormPath(s))).GetProperty("link").GetProperty("answers").GetInt32());

        // The answer's address is in its audit entry, never with the row.
        await using var api = server.Variant(b => b.ConfigureTestServices(x => x.AddSingleton<IStartupFilter, TestAddresses>()));
        var from = ServerFixture.ClientOf(api);
        from.DefaultRequestHeaders.Add(TestAddresses.Header, "203.0.113.50");
        SeeOther(await Answer(from, token, Whole("Second")), token, "/done");
        var second = (await Answers(s)).Single(p => p.Title == "Second");
        var entry = await Kit.InWorker(server, s.Ws.Id, (_, db) => db.AuditLog.AsNoTracking()
            .SingleAsync(a => a.WorkspaceId == s.Ws.Id && a.Action == "form.answer" && a.Detail!.Contains(second.Id.ToString())));
        Assert.Equal("203.0.113.50", entry.Ip);
        var secondValues = await Kit.InWorker(server, s.Ws.Id, (_, db) => db.DatabaseRows.AsNoTracking().FirstAsync(r => r.PageId == second.Id));
        Assert.DoesNotContain("203.0.113.50", secondValues.Values);
    }

    [Fact]
    public async Task A_links_pages_take_an_answer_page_by_page_with_script_off()
    {
        var s = await FormDatabase();
        var (token, _) = await MakeLink(s);
        var sites = ServerFixture.SiteClient(server.Sites);
        var path = $"/_form/{token}";

        var first = await sites.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var html = await first.Content.ReadAsStringAsync();
        var policy = first.Headers.GetValues("Content-Security-Policy").Single();
        Assert.Contains("form-action 'self' https://localhost", policy);
        Assert.Contains("default-src 'none'", policy);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Your name", html);
        Assert.Contains("We write only about this", html);
        Assert.Contains($"action=\"{path}\"", html);
        // The same page again from the cache, by its entity tag.
        var tag = first.Headers.ETag!;
        using var reload = new HttpRequestMessage(HttpMethod.Get, path);
        reload.Headers.IfNoneMatch.Add(tag);
        Assert.Equal(HttpStatusCode.NotModified, (await sites.SendAsync(reload)).StatusCode);

        // A required question not answered: the same page, with what is wrong and what was typed.
        var missing = await sites.PostAsync(path, Fields(("q.title", "Omar"), ("q.pSel0001", "optNew01"), ("at", "0"), ("go", "next")));
        var missingHtml = await missing.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.OK, missing.StatusCode);
        Assert.Contains("Answer this question.", missingHtml);
        Assert.Contains("value=\"Omar\"", missingHtml);
        Assert.Contains("aria-invalid=\"true\"", missingHtml);

        // A new stage shows the seats' page, the first page's answers carried in hidden fields.
        var seats = await sites.PostAsync(path, Fields(("q.title", "Omar"), ("q.pEml0001", "omar@example.com"), ("q.pSel0001", "optNew01"), ("at", "0"), ("go", "next")));
        var seatsHtml = await seats.Content.ReadAsStringAsync();
        Assert.Contains("<h2>Seats</h2>", seatsHtml);
        Assert.Contains("type=\"hidden\" name=\"q.title\" value=\"Omar\"", seatsHtml);
        Assert.Contains("name=\"at\" value=\"1\"", seatsHtml);
        // Back keeps every answer.
        var back = await sites.PostAsync(path, Fields(("q.title", "Omar"), ("q.pEml0001", "omar@example.com"), ("q.pSel0001", "optNew01"), ("q.pNum0001", "4"), ("at", "1"), ("go", "back")));
        var backHtml = await back.Content.ReadAsStringAsync();
        Assert.Contains("value=\"Omar\"", backHtml);
        Assert.Contains("type=\"hidden\" name=\"q.pNum0001\" value=\"4\"", backHtml);

        // The last page sends the same post on to the API (307), which adds the row and says thanks.
        var all = new[] { ("q.title", "Omar"), ("q.pEml0001", "omar@example.com"), ("q.pSel0001", "optNew01"), ("q.pNum0001", "4"), ("q.pText001", "Hi"), ("at", "2"), ("go", "next") };
        var last = await sites.PostAsync(path, Fields(all));
        Assert.Equal(HttpStatusCode.TemporaryRedirect, last.StatusCode);
        Assert.Equal($"https://localhost/api/v1/forms/{token}", last.Headers.Location!.ToString());
        SeeOther(await Answer(server.Anonymous(), token, all), token, "/done");
        var done = await sites.GetAsync(path + "/done");
        Assert.Contains("We have it, thank you", await done.Content.ReadAsStringAsync());
        var row = Assert.Single(await Answers(s));
        Assert.Equal("Omar", row.Title);
        var values = ValueJson.ReadMap((await Kit.InWorker(server, s.Ws.Id, (_, db) => db.DatabaseRows.AsNoTracking().FirstAsync(r => r.PageId == row.Id))).Values);
        Assert.Equal(4.0, values["pNum0001"]);
    }

    [Fact]
    public async Task A_link_reads_nothing_of_the_database_but_its_questions()
    {
        var s = await FormDatabase();
        await DatabaseTests.NewRow(s.Ws, s.Database, "A row nobody else may read", new { pEml0001 = "private@example.com", pPers001 = new[] { s.Ws.Account.Id } });
        var (token, _) = await MakeLink(s);
        var sites = ServerFixture.SiteClient(server.Sites);
        var path = $"/_form/{token}";
        var pages = new List<string>
        {
            await (await sites.GetAsync(path)).Content.ReadAsStringAsync(),
            await (await sites.PostAsync(path, Fields(("q.title", "x"), ("q.pEml0001", "x@y.z"), ("q.pSel0001", "optNew01"), ("at", "0")))).Content.ReadAsStringAsync(),
            await (await sites.PostAsync(path, Fields(("at", "1"), ("go", "back")))).Content.ReadAsStringAsync(),
            await (await sites.GetAsync(path + "/done")).Content.ReadAsStringAsync(),
        };
        foreach (var html in pages)
        {
            Assert.DoesNotContain("A row nobody else may read", html);
            Assert.DoesNotContain("private@example.com", html);
            // No option the question does not show, no person (the question is the app's only), no script.
            Assert.DoesNotContain("Secret stage", html);
            Assert.DoesNotContain("Owner", html);
            Assert.DoesNotContain(s.Ws.Account.Email, html);
            Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        }
        // A share link of the database reads its other views' rows, never the form's.
        var token2 = (await Kit.Json(await s.Ws.Client.PostAsJsonAsync($"/api/v1/pages/{s.Database}/share-links", new { }))).GetProperty("token").GetString()!;
        var reader = server.Anonymous();
        reader.DefaultRequestHeaders.Add(Cgw.Core.Sharing.SharedReader.Header, token2);
        var refused = await reader.PostAsJsonAsync($"/api/v1/shared/databases/{s.Database}/query", new { viewId = s.View });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("form.rows", await Kit.Code(refused));
        // With no view named, the first that shows rows (none here: a table of every property).
        Assert.True((await reader.PostAsJsonAsync($"/api/v1/shared/databases/{s.Database}/query", new { })).IsSuccessStatusCode);
    }

    [Fact]
    public async Task A_link_off_closed_full_or_deleted_takes_no_answer_and_says_so()
    {
        var s = await FormDatabase();
        var (token, _) = await MakeLink(s, new { enabled = true, maxAnswers = 1 });
        var sites = ServerFixture.SiteClient(server.Sites);
        async Task<string> Page() => await (await sites.GetAsync($"/_form/{token}")).Content.ReadAsStringAsync();

        SeeOther(await Answer(server.Anonymous(), token, Whole("First")), token, "/done");
        // Full: the second is refused, and the page says so.
        SeeOther(await Answer(server.Anonymous(), token, Whole("Second")), token);
        Assert.Contains("This form has all the answers it takes.", await Page());

        // Off.
        Assert.True((await s.Ws.Client.PutAsJsonAsync(FormPath(s) + "/link", new { enabled = false })).IsSuccessStatusCode);
        SeeOther(await Answer(server.Anonymous(), token, Whole("Third")), token);
        Assert.Contains("This form is not taking answers.", await Page());

        // Closed (a closing time passed).
        Assert.True((await s.Ws.Client.PutAsJsonAsync(FormPath(s) + "/link", new { enabled = true, closesAt = DateTimeOffset.UtcNow.AddMinutes(-1) })).IsSuccessStatusCode);
        SeeOther(await Answer(server.Anonymous(), token, Whole("Fourth")), token);
        Assert.Contains("This form is closed.", await Page());

        // Open again, then deleted: the address is gone.
        Assert.True((await s.Ws.Client.PutAsJsonAsync(FormPath(s) + "/link", new { enabled = true })).IsSuccessStatusCode);
        SeeOther(await Answer(server.Anonymous(), token, Whole("Fifth")), token, "/done");
        Assert.Equal(HttpStatusCode.NoContent, (await s.Ws.Client.DeleteAsync(FormPath(s) + "/link")).StatusCode);
        SeeOther(await Answer(server.Anonymous(), token, Whole("Sixth")), token);
        Assert.Equal(HttpStatusCode.NotFound, (await sites.GetAsync($"/_form/{token}")).StatusCode);

        Assert.Equal(["Fifth", "First"], (await Answers(s)).Select(p => p.Title).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task An_address_past_its_limit_is_answered_429_while_others_answer_on_and_a_guessed_token_adds_nothing()
    {
        var s = await FormDatabase();
        var (token, _) = await MakeLink(s);
        await using var api = server.Variant(b => b.ConfigureTestServices(x => x.AddSingleton<Microsoft.AspNetCore.Hosting.IStartupFilter, TestAddresses>()));
        HttpClient From(string address)
        {
            var client = ServerFixture.ClientOf(api);
            client.DefaultRequestHeaders.Add(TestAddresses.Header, address);
            return client;
        }
        var office = From("203.0.113.7");
        for (var i = 0; i < FormRules.AnswersPerMinute; i++) SeeOther(await Answer(office, token, Whole($"Office {i}")), token, "/done");
        var refused = await Answer(office, token, Whole("One more"));
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.NotNull(refused.Headers.RetryAfter);
        var page = await refused.Content.ReadAsStringAsync();
        Assert.Contains("Too many answers", page);
        Assert.DoesNotContain("Sign up", page);
        // Another address answers on; so does one of the same IPv6 /64 not.
        SeeOther(await Answer(From("198.51.100.4"), token, Whole("Home")), token, "/done");
        var v6 = From("2001:db8:1:2::10");
        for (var i = 0; i < FormRules.AnswersPerMinute; i++) SeeOther(await Answer(v6, token, Whole($"Six {i}")), token, "/done");
        Assert.Equal(HttpStatusCode.TooManyRequests, (await Answer(From("2001:db8:1:2::99"), token, Whole("Same net"))).StatusCode);
        Assert.Equal(2 * FormRules.AnswersPerMinute + 1, (await Answers(s)).Count);

        // A guessed token adds nothing: one that names no link, and one no token can be.
        var guessed = FormKeys.NewToken();
        SeeOther(await Answer(From("192.0.2.1"), guessed, Whole("Guess")), guessed);
        Assert.Equal(HttpStatusCode.NotFound, (await Answer(From("192.0.2.1"), "not a token!", Whole("Guess"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ServerFixture.SiteClient(server.Sites).GetAsync($"/_form/{guessed}")).StatusCode);
        Assert.Equal(2 * FormRules.AnswersPerMinute + 1, (await Answers(s)).Count);

        // The day's limit, on a clock of its own.
        var clock = new MovableClock();
        var limits = new FormLimits(clock, perMinute: 10, perDay: 25);
        var taken = 0;
        for (var minute = 0; minute < 4; minute++)
        {
            for (var i = 0; i < 10; i++)
                if (limits.Take(System.Net.IPAddress.Parse("203.0.113.9"), "link").Taken) taken++;
            clock.Advance(TimeSpan.FromMinutes(1));
        }
        Assert.Equal(25, taken);
        Assert.True(limits.Take(System.Net.IPAddress.Parse("203.0.113.9"), "another").Taken);
        clock.Advance(TimeSpan.FromDays(1));
        Assert.True(limits.Take(System.Net.IPAddress.Parse("203.0.113.9"), "link").Taken);
    }

    [Fact]
    public async Task The_trap_drops_an_answer_and_a_value_no_question_takes_is_refused()
    {
        var s = await FormDatabase();
        var (token, _) = await MakeLink(s);
        // The hidden field filled: answered as if taken, nothing written.
        SeeOther(await Answer(server.Anonymous(), token, [.. Whole("Bot"), ("website", "https://spam.example")]), token, "/done");
        // An option the question does not show, by a post no page drew.
        SeeOther(await Answer(server.Anonymous(), token, ("q.title", "Sly"), ("q.pEml0001", "s@x.io"), ("q.pSel0001", "optSec01")), token, "?problem=1");
        // A person (asked in the app only) is left out, never written.
        SeeOther(await Answer(server.Anonymous(), token, [.. Whole("Plain"), ("q.pPers001", s.Ws.Account.Id.ToString())]), token, "/done");
        var row = Assert.Single(await Answers(s));
        Assert.Equal("Plain", row.Title);
        var values = ValueJson.ReadMap((await Kit.InWorker(server, s.Ws.Id, (_, db) => db.DatabaseRows.AsNoTracking().FirstAsync(r => r.PageId == row.Id))).Values);
        Assert.False(values.ContainsKey("pPers001"));
        // The refused answer's page says so.
        var page = await (await ServerFixture.SiteClient(server.Sites).GetAsync($"/_form/{token}?problem=1")).Content.ReadAsStringAsync();
        Assert.Contains("Your answer could not be taken.", page);
        // An answer too large is not read.
        var large = await server.Anonymous().PostAsync($"/api/v1/forms/{token}", Fields([.. Whole("Large"), ("q.pText001", new string('x', FormRules.MaxAnswerBytes))]));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, large.StatusCode);
    }

    [Fact]
    public async Task A_links_pages_are_in_the_forms_language()
    {
        var s = await FormDatabase("ar");
        var (token, _) = await MakeLink(s);
        var sites = ServerFixture.SiteClient(server.Sites);
        var html = await (await sites.GetAsync($"/_form/{token}")).Content.ReadAsStringAsync();
        Assert.Contains("<html lang=\"ar\" dir=\"rtl\">", html);
        Assert.Contains("الأسئلة المعلّمة بـ * مطلوبة.", html);
        Assert.Contains("التالي", html);
        var missing = await (await sites.PostAsync($"/_form/{token}", Fields(("at", "0"), ("go", "next")))).Content.ReadAsStringAsync();
        Assert.Contains("أجب عن هذا السؤال.", missing);
        Assert.Contains("راجع هذه الإجابات:", missing);
    }

    /// <summary>The request's address from <c>X-Test-Address</c>, before anything else reads it.</summary>
    private sealed class TestAddresses : Microsoft.AspNetCore.Hosting.IStartupFilter
    {
        public const string Header = "X-Test-Address";

        public Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> Configure(Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> next) => app =>
        {
            app.Use((context, rest) =>
            {
                if (System.Net.IPAddress.TryParse(context.Request.Headers[Header].ToString(), out var address))
                    context.Connection.RemoteIpAddress = address;
                return rest(context);
            });
            next(app);
        };
    }
}
