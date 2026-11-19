using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Sites;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 9, M9.1: the Sites process. The site's scope matrix (restricted, private, hidden, trashed,
/// unpublished, the switch off, a guest's site), as share links' are; a database block through its
/// view; placeholders; files checked on every request; nothing of comments, history or updates;
/// the session test (no cookie set or read, the same answer with the API's session cookie or
/// without); every answer's headers; caching by ETag, and an unpublish that holds within 30 s by a
/// clock; robots.txt.
/// </summary>
/// <summary>A clock standing still until it is moved.</summary>
public sealed class FixedClock(DateTimeOffset start) : TimeProvider
{
    private long ticks = start.UtcTicks;

    public void Advance(TimeSpan by) => Interlocked.Add(ref ticks, by.Ticks);

    public override DateTimeOffset GetUtcNow() => new(Interlocked.Read(ref ticks), TimeSpan.Zero);
}

public sealed partial class SiteTests(ServerFixture server)
{
    private static string Slug(string stem) => $"{stem}-{Guid.NewGuid():N}"[..(stem.Length + 13)];

    private static async Task<string> Publish(Ws ws, Guid page, string stem, bool indexing = false, string language = "en", HttpClient? client = null)
    {
        var slug = Slug(stem);
        var response = await (client ?? ws.Client).PutAsJsonAsync($"/api/v1/pages/{page}/site", new { slug, indexing, language });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return slug;
    }

    /// <summary>The page's derived JSON replaced, as the worker would write it after an edit (its sequence rises).</summary>
    private async Task Derived(Ws ws, Guid page, JsonObject doc)
    {
        await using var db = server.NewDb(ws.Id);
        var row = await db.PageDocDerived.SingleAsync(d => d.PageId == page);
        row.Json = DocService.Gzip(doc.ToJsonString());
        row.UpToSeq++;
        await db.SaveChangesAsync();
    }

    private static JsonObject Doc(params JsonObject[] bodies) => new()
    {
        ["type"] = "doc",
        ["content"] = new JsonArray(bodies.Select((b, i) => (JsonNode?)new JsonObject
        {
            ["type"] = "block",
            ["attrs"] = new JsonObject { ["id"] = "SiteBlock" + i.ToString("D4") },
            ["content"] = new JsonArray(b),
        }).ToArray()),
    };

    private static JsonObject Para(string text) => new()
    {
        ["type"] = "textBody",
        ["attrs"] = new JsonObject { ["kind"] = "paragraph" },
        ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
    };

    private static JsonObject Atom(string type, object attrs) => new() { ["type"] = type, ["attrs"] = JsonSerializer.SerializeToNode(attrs) };

    private static void Headers(HttpResponseMessage response)
    {
        var csp = string.Join("", response.Headers.GetValues("Content-Security-Policy"));
        Assert.StartsWith("default-src 'none'; style-src 'sha256-", csp);
        Assert.Contains($"style-src {SiteStyle.Hash};", csp);
        Assert.Contains("img-src 'self' http://127.0.0.1:", csp);
        Assert.Contains("base-uri 'none'; form-action 'none'; frame-ancestors 'none'", csp);
        Assert.DoesNotContain("script", csp);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal("no-referrer", Assert.Single(response.Headers.GetValues("Referrer-Policy")));
        Assert.Equal("same-origin", Assert.Single(response.Headers.GetValues("Cross-Origin-Opener-Policy")));
        Assert.Equal("same-origin", Assert.Single(response.Headers.GetValues("Cross-Origin-Resource-Policy")));
        Assert.Contains("camera=()", Assert.Single(response.Headers.GetValues("Permissions-Policy")));
        Assert.False(response.Headers.Contains("Set-Cookie"));
        Assert.False(response.Headers.Contains("Server"));
        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task A_published_subtree_reads_with_no_account_and_nothing_outside_its_scope()
    {
        var ws = await Ws.Create(server);
        var root = await Kit.PageWithText(server, ws, "Handbook");
        var chapter = await Kit.PageWithText(server, ws, "Chapter", root);
        var restricted = (await ws.NewPage("Restricted secret", root)).GetProperty("id").GetGuid();
        var underRestricted = (await ws.NewPage("Under restricted secret", restricted)).GetProperty("id").GetGuid();
        await Kit.Share(ws, restricted, true);
        var hidden = (await ws.NewPage("Hidden secret", root)).GetProperty("id").GetGuid();
        await Kit.Share(ws, hidden, false, ("workspace", ws.Id, "none"));
        var binned = (await ws.NewPage("Binned secret", root)).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", binned, new { }));
        var outside = await Kit.PageWithText(server, ws, "Outside secret");

        // A database under the page, its view hiding one property; a workbook and an ERP view.
        var database = await DatabaseTests.NewDatabase(ws, "Inline tasks", [
            DatabaseTests.Prop("pNum0001", "number", "Hours"),
            DatabaseTests.Prop("pTxt0001", "text", "Salary note"),
            DatabaseTests.Prop("pPer0001", "person", "Owner"),
        ], parent: root);
        var rowId = Guid.CreateVersion7();
        var row = DatabaseTests.PageJson(rowId, ws.Id, ws.Shared, database, "a0", "Visible task", "row");
        row["row"] = new JsonObject { ["values"] = new JsonObject { ["pNum0001"] = 7, ["pTxt0001"] = "very private", ["pPer0001"] = new JsonArray(ws.Account.Id.ToString()) } };
        await ws.Push(ws.Op("page.create", rowId, row));
        var view = Guid.CreateVersion7();
        await ws.Push(ws.Op("view.upsert", view, new
        {
            id = view, workspaceId = ws.Id, databaseId = database, name = "Public", type = "table", orderKey = "a0", version = 1, createdAt = DateTimeOffset.UtcNow, viewTypes = 6,
            config = new { filter = (object?)null, sorts = Array.Empty<object>(), group = (object?)null, properties = new { order = Array.Empty<string>(), hidden = new[] { "pTxt0001" }, widths = new { } } },
        }));
        var other = await DatabaseTests.NewDatabase(ws, "Unpublished database");
        await Derived(ws, root, Doc(
            Para("Welcome to the handbook"),
            Atom("databaseView", new { databaseId = database, viewId = view }),
            Atom("databaseView", new { databaseId = other }),
            Atom("sheetEmbed", new { workbookId = Guid.CreateVersion7(), sheet = "Q3" }),
            Atom("erpView", new { linkId = Guid.CreateVersion7(), connectorId = "vendors" }),
            Atom("childPage", new { pageId = restricted })));

        var cover = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "cover.png");
        var unrelated = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "unrelated.png");
        await server.RunJob<AssetCheckJob>();
        await ws.Push(ws.Op("page.update", chapter, new { coverAssetId = cover }));
        var slug = await Publish(ws, root, "handbook");
        var site = ServerFixture.SiteClient(server.Sites);

        var home = await site.GetAsync($"/{slug}");
        Assert.Equal(HttpStatusCode.OK, home.StatusCode);
        Assert.Equal("text/html", home.Content.Headers.ContentType?.MediaType);
        Headers(home);
        Assert.Equal("noindex", Assert.Single(home.Headers.GetValues("X-Robots-Tag")));
        Assert.Equal("no-cache", home.Headers.CacheControl?.ToString());
        var html = await home.Content.ReadAsStringAsync();
        Assert.Contains("Welcome to the handbook", html);
        Assert.Contains("Chapter", html);
        Assert.Contains("Visible task", html);
        Assert.Contains("Hours", html);
        Assert.Contains("This database is not published", html);
        Assert.Contains("This workbook is not published", html);
        Assert.Contains("Cash Gear ERP data is not published", html);
        Assert.Contains("<meta name=\"robots\" content=\"noindex\">", html);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        foreach (var never in new[] { "Restricted secret", "Under restricted secret", "Hidden secret", "Binned secret", "Outside secret", "very private", "Salary note", ws.Account.Id.ToString(), "Unpublished database" })
            Assert.DoesNotContain(never, html);

        var page = await site.GetAsync($"/{slug}/{chapter}");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.Contains("Hello world", await page.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{slug}/{database}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{slug}/{database}?page=2")).StatusCode);
        foreach (var notHeld in new[] { restricted, underRestricted, hidden, binned, outside, rowId, other, Guid.CreateVersion7() })
        {
            var missing = await site.GetAsync($"/{slug}/{notHeld}");
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
            Headers(missing);
            Assert.Contains("This page is not available", await missing.Content.ReadAsStringAsync());
        }

        // Files by the site's own checked address: a redirect to a short signed URL, never kept.
        var file = await site.GetAsync($"/{slug}/files/{cover}");
        Assert.Equal(HttpStatusCode.Redirect, file.StatusCode);
        Assert.Equal("no-store", file.Headers.CacheControl?.ToString());
        Assert.Contains("sig=", file.Headers.Location!.Query);
        Assert.Equal(AssetTests.Png, await Books.Download(file.Headers.Location.ToString()));
        Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync($"/{slug}/files/{unrelated}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync($"/{slug}/files/{Guid.CreateVersion7()}")).StatusCode);

        // Nothing of comments, history, updates or the API's routes on the site's origin.
        foreach (var path in new[] { $"/api/v1/pages/{root}/doc", $"/api/v1/pages/{root}/comments", $"/api/v1/pages/{root}/versions", $"/api/v1/shared", $"/{slug}/{root}/doc", "/api", "/admin", "/files" })
            Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync(path)).StatusCode);
        // Only reads.
        Assert.Equal(HttpStatusCode.NotFound, (await site.PostAsync($"/{slug}", new StringContent("x"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await site.SendAsync(new HttpRequestMessage(HttpMethod.Head, $"/{slug}"))).StatusCode);
    }

    /// <summary>A chart view (Phase 12): grouped by its stage, its measure a sum of the property named, its config hiding what is named.</summary>
    private static async Task UpsertChart(Ws ws, Guid id, Guid database, string orderKey, string measure, params string[] hidden)
    {
        var result = (await ws.Push(ws.Op("view.upsert", id, new
        {
            id, workspaceId = ws.Id, databaseId = database, name = "Chart " + orderKey, type = "chart", orderKey, version = 1, createdAt = DateTimeOffset.UtcNow, viewTypes = 7,
            config = new
            {
                filter = (object?)null, sorts = Array.Empty<object>(),
                group = new { propertyId = "pSel0001", hideEmpty = true },
                properties = new { order = Array.Empty<string>(), hidden, widths = new { } },
                chart = new { kind = "bar", measure = new { kind = "sum", propertyId = measure }, title = (string?)null },
            },
        })))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
    }

    [Fact]
    public async Task A_published_chart_view_draws_from_its_rows_and_one_reading_what_may_not_leave_its_placeholder()
    {
        var ws = await Ws.Create(server);
        var root = await Kit.PageWithText(server, ws, "Report");
        var database = await DatabaseTests.NewDatabase(ws, "Effort", [
            DatabaseTests.Prop("pNum0001", "number", "Hours"),
            DatabaseTests.Prop("pNum0002", "number", "Salary"),
            DatabaseTests.Prop("pPer0001", "person", "Owner"),
            DatabaseTests.Prop("pFor0001", "formula", "Owner's", new JsonObject { ["formula"] = new JsonObject { ["expression"] = "prop(\"pPer0001\")" } }),
            DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = DatabaseTests.Options(("optA0001", "Doing"), ("optB0001", "Done")) }),
        ], parent: root);
        var first = Guid.Empty;
        foreach (var (title, spent, salary, stage, order) in new[] { ("First task", 2, 7001, "optA0001", "a0"), ("Second task", 3, 7002, "optB0001", "a1"), ("Third task", 4, 7003, "optB0001", "a2") })
        {
            var id = Guid.CreateVersion7();
            if (first == Guid.Empty) first = id;
            var row = DatabaseTests.PageJson(id, ws.Id, ws.Shared, database, order, title, "row");
            row["row"] = new JsonObject { ["values"] = new JsonObject { ["pNum0001"] = spent, ["pNum0002"] = salary, ["pSel0001"] = stage } };
            await ws.Push(ws.Op("page.create", id, row));
        }
        // The database's first view a chart of hours (its config hiding nothing: a chart shows only
        // what it draws); a second summing a formula of a person, which never leaves.
        var hours = Guid.CreateVersion7();
        await UpsertChart(ws, hours, database, "a0", "pNum0001");
        var salaries = Guid.CreateVersion7();
        await UpsertChart(ws, salaries, database, "a1", "pFor0001");
        await Derived(ws, root, Doc(
            Para("This month"),
            Atom("databaseView", new { databaseId = database, viewId = hours }),
            Atom("databaseView", new { databaseId = database, viewId = salaries })));
        var slug = await Publish(ws, root, "report");
        var site = ServerFixture.SiteClient(server.Sites);

        var html = await (await site.GetAsync($"/{slug}")).Content.ReadAsStringAsync();
        Assert.Contains("<figcaption>Sum of Hours by Stage</figcaption>", html);
        Assert.Contains("<th scope=\"row\" dir=\"auto\">Doing</th><td>2</td>", html);
        Assert.Contains("<th scope=\"row\" dir=\"auto\">Done</th><td>7</td>", html);
        Assert.Contains("<svg viewBox=\"0 0 600 300\" role=\"img\"", html);
        Assert.Contains("This chart is not published", html);
        foreach (var never in new[] { "First task", "Salary", "7001", "14005", "Owner", ws.Account.Id.ToString() })
            Assert.DoesNotContain(never, html);

        // The database's own page draws its first view, the chart, with no pages of rows.
        var page = await (await site.GetAsync($"/{slug}/{database}")).Content.ReadAsStringAsync();
        Assert.Contains("<figcaption>Sum of Hours by Stage</figcaption>", page);
        Assert.DoesNotContain("Third task", page);
        Assert.DoesNotContain("7003", page);
        Assert.DoesNotContain("<nav class=\"pager\"", page);

        // A files property added after the charts is in neither's hidden list, and still no file of it reads.
        var scan = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "scan.png");
        await server.RunJob<AssetCheckJob>();
        var added = (await ws.Push(ws.Op("db.update", database, new { properties = new[] { new { id = "pFil0001", name = "Scan", type = "files" } } })))[0];
        Assert.True(added.GetProperty("status").GetString() == "applied", added.ToString());
        var updated = (await ws.Push(ws.Op("row.update", first, new { values = new { pFil0001 = new[] { scan } } })))[0];
        Assert.True(updated.GetProperty("status").GetString() == "applied", updated.ToString());
        Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync($"/{slug}/files/{scan}")).StatusCode);
    }

    [Fact]
    public async Task An_answer_is_kept_by_what_it_is_drawn_from_and_revalidated_by_its_etag()
    {
        var ws = await Ws.Create(server);
        var root = await Kit.PageWithText(server, ws, "Cached");
        var slug = await Publish(ws, root, "cached");
        var site = ServerFixture.SiteClient(server.Sites);
        var first = await site.GetAsync($"/{slug}");
        var etag = first.Headers.ETag;
        Assert.NotNull(etag);
        Assert.False(etag.IsWeak);
        var again = await site.GetAsync($"/{slug}");
        Assert.Equal(etag, again.Headers.ETag);
        var conditional = new HttpRequestMessage(HttpMethod.Get, $"/{slug}");
        conditional.Headers.IfNoneMatch.Add(etag);
        var notModified = await site.SendAsync(conditional);
        Assert.Equal(HttpStatusCode.NotModified, notModified.StatusCode);
        Assert.Equal(etag, notModified.Headers.ETag);

        // An edit the worker derived shows at once: the key holds the derived sequence.
        await Derived(ws, root, Doc(Para("Edited after publishing")));
        var edited = await site.GetAsync($"/{slug}");
        Assert.NotEqual(etag, edited.Headers.ETag);
        Assert.Contains("Edited after publishing", await edited.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task An_unpublish_the_switch_a_move_or_the_trash_takes_the_site_down_within_thirty_seconds()
    {
        // A clock that moves only when the test moves it, so the real seconds the steps take do not count.
        var clock = new FixedClock(DateTimeOffset.UtcNow);
        var factory = server.NewSites(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var site = ServerFixture.SiteClient(factory);
        var ws = await Ws.Create(server);
        var a = await Kit.PageWithText(server, ws, "Site A");
        var b = await Kit.PageWithText(server, ws, "Site B");
        var c = await Kit.PageWithText(server, ws, "Site C");
        var d = await Kit.PageWithText(server, ws, "Site D");
        var slugA = await Publish(ws, a, "site-a");
        var slugB = await Publish(ws, b, "site-b");
        var slugC = await Publish(ws, c, "site-c");
        var slugD = await Publish(ws, d, "site-d");
        foreach (var slug in new[] { slugA, slugB, slugC, slugD })
            Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{slug}")).StatusCode);

        // Unpublished, moved into the private section, trashed: still served from memory for now...
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/pages/{a}/site")).StatusCode);
        var moved = (await ws.Push(ws.Op("page.move", b, new { sectionId = ws.Personal, parentPageId = (Guid?)null, orderKey = "a5" })))[0];
        Assert.Equal("applied", moved.GetProperty("status").GetString());
        await ws.Push(ws.Op("page.trash", c, new { }));
        clock.Advance(TimeSpan.FromSeconds(29));
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{slugA}")).StatusCode);
        // ...and gone once the 30 s are up: every address.
        clock.Advance(TimeSpan.FromSeconds(2));
        foreach (var slug in new[] { slugA, slugB, slugC })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync($"/{slug}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync($"/{slug}/files/{Guid.CreateVersion7()}")).StatusCode);
        }
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{slugD}")).StatusCode);

        // Back from the private section and the trash: back (a moved page keeps its site).
        var back = (await ws.Push(ws.Op("page.move", b, new { sectionId = ws.Shared, parentPageId = (Guid?)null, orderKey = "a6" })))[0];
        Assert.Equal("applied", back.GetProperty("status").GetString());
        await ws.Push(ws.Op("page.restore", c, new { }));
        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{slugB}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{slugC}")).StatusCode);

        // The switch off: every site of the workspace down within the 30 s, and none back after.
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/publishing", new { enabled = false })).StatusCode);
        clock.Advance(TimeSpan.FromSeconds(31));
        foreach (var slug in new[] { slugB, slugC, slugD })
            Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync($"/{slug}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/publishing", new { enabled = true })).StatusCode);
        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync($"/{slugD}")).StatusCode);
    }

    [GeneratedRegex("name=\"__RequestVerificationToken\" value=\"([^\"]+)\"")]
    private static partial Regex Token();

    /// <summary>A real session cookie of the API, from a sign-in made by hand (the test client's own jar is out of reach).</summary>
    private async Task<string> SessionCookie(Account account)
    {
        var client = server.Api.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = false,
            AllowAutoRedirect = false,
        });
        var form = await client.GetAsync("/account/signin");
        var jar = form.Headers.GetValues("Set-Cookie").Select(c => c.Split(';')[0]).ToList();
        var token = WebUtility.HtmlDecode(Token().Match(await form.Content.ReadAsStringAsync()).Groups[1].Value);
        var post = new HttpRequestMessage(HttpMethod.Post, "/account/signin")
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["__RequestVerificationToken"] = token,
                ["Email"] = account.Email,
                ["Password"] = account.Password,
                ["ReturnUrl"] = "",
            }),
        };
        post.Headers.Add("Cookie", string.Join("; ", jar));
        var signedIn = await client.SendAsync(post);
        var session = signedIn.Headers.GetValues("Set-Cookie").Select(c => c.Split(';')[0]).Single(c => c.StartsWith("cgw_session=", StringComparison.Ordinal));
        var me = new HttpRequestMessage(HttpMethod.Get, "/api/v1/account/me");
        me.Headers.Add("Cookie", session);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(me)).StatusCode);
        return session;
    }

    [Fact]
    public async Task The_site_sets_no_cookie_and_answers_the_same_with_the_apis_session_or_without()
    {
        var ws = await Ws.Create(server);
        var root = await Kit.PageWithText(server, ws, "Session test");
        var slug = await Publish(ws, root, "session", language: "ar");
        var session = await SessionCookie(ws.Account);
        var site = ServerFixture.SiteClient(server.Sites);

        foreach (var path in new[] { $"/{slug}", $"/{slug}/{Guid.CreateVersion7()}", "/robots.txt", "/no-such-site", $"/{slug}/files/{Guid.CreateVersion7()}" })
        {
            var without = await site.GetAsync(path);
            var with = new HttpRequestMessage(HttpMethod.Get, path);
            with.Headers.Add("Cookie", session + "; cgw_xsrf=anything");
            var withCookie = await site.SendAsync(with);
            Assert.Equal(without.StatusCode, withCookie.StatusCode);
            Assert.Equal(await without.Content.ReadAsByteArrayAsync(), await withCookie.Content.ReadAsByteArrayAsync());
            Assert.Equal(without.Headers.ETag, withCookie.Headers.ETag);
            Headers(without);
            Headers(withCookie);
        }
        var html = await (await site.GetAsync($"/{slug}")).Content.ReadAsStringAsync();
        Assert.Contains("<html lang=\"ar\" dir=\"rtl\">", html);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<form", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<iframe", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(session.Split('=')[1], html);
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync("/health/live")).StatusCode);
    }

    [Fact]
    public async Task Robots_txt_allows_only_the_sites_their_publishers_let_be_indexed()
    {
        var ws = await Ws.Create(server);
        var open = await Kit.PageWithText(server, ws, "Indexed");
        var closed = await Kit.PageWithText(server, ws, "Not indexed");
        var guest = await Kit.Join(server, ws, "guest");
        var theirs = await Kit.PageWithText(server, ws, "The guest's");
        await Kit.Share(ws, theirs, false, ("user", guest.Id, "full"));
        var indexed = await Publish(ws, open, "indexed", indexing: true);
        var hidden = await Publish(ws, closed, "hidden");
        var byGuest = await Publish(ws, theirs, "guest", client: guest.Client);
        // robots.txt is held 30 s: a Sites process of its own reads it fresh.
        var site = ServerFixture.SiteClient(server.NewSites(_ => { }));
        var robots = await site.GetAsync("/robots.txt");
        Assert.Equal("text/plain", robots.Content.Headers.ContentType?.MediaType);
        var text = await robots.Content.ReadAsStringAsync();
        Assert.StartsWith("User-agent: *\n", text);
        Assert.Contains($"Allow: /{indexed}$\nAllow: /{indexed}/\n", text);
        Assert.DoesNotContain(hidden, text);
        Assert.EndsWith("Disallow: /\n", text);
        Headers(robots);

        var page = await site.GetAsync($"/{indexed}");
        Assert.False(page.Headers.Contains("X-Robots-Tag"));
        Assert.DoesNotContain("noindex", await page.Content.ReadAsStringAsync());
        Assert.Equal("noindex", Assert.Single((await site.GetAsync($"/{hidden}")).Headers.GetValues("X-Robots-Tag")));
        // A guest's site reads like any other.
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync($"/{byGuest}")).StatusCode);
        // Reserved and malformed slugs are never looked up.
        foreach (var path in new[] { "/api", "/favicon.ico", "/_next", "/UPPER", "/a" })
            Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync(path)).StatusCode);
    }
}
