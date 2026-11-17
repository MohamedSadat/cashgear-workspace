using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Workbooks;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 9, M9.3: a workbook's history (its kept versions, one opened read-only, a restore as a new
/// version by an editor and never by a reader), a version uploaded by the app (an import's), and
/// Sheet's desktop launch (Track S6): the link's form, and a ticket redeemed only from the origins
/// of the kind of app it was made for.
/// </summary>
public sealed class WorkbookHistoryTests(ServerFixture server)
{
    private static string Status(HttpResponseMessage response) => ((int)response.StatusCode).ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>A second version saved through Sheet's route on the first: its ETag.</summary>
    private async Task<string> SaveAgain(Ws ws, Guid book, byte[] bytes)
    {
        var token = await Books.Token(server, ws.Client, book);
        var current = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{book}")).GetProperty("etag").GetString()!;
        var response = await server.Anonymous().SendAsync(Books.Save(token, bytes, ifMatch: current));
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return (await Kit.Json(response)).GetProperty("etag").GetString()!;
    }

    private static HttpRequestMessage Restore(Guid book, Guid version, string? ifMatch = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/workbooks/{book}/versions/{version}/restore");
        if (ifMatch is not null) request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        return request;
    }

    private static HttpRequestMessage Upload(Guid book, byte[] bytes, string? ifMatch = null, string? ifNoneMatch = null, string type = Books.XlsxType)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/workbooks/{book}/versions") { Content = new ByteArrayContent(bytes) };
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(type);
        if (ifMatch is not null) request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        if (ifNoneMatch is not null) request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        return request;
    }

    [Fact]
    public async Task A_workbooks_versions_are_listed_newest_first_and_one_opens_by_its_own_signed_url()
    {
        var ws = await Ws.Create(server);
        var first = Books.Simple("first");
        var second = Books.Simple("second");
        var book = await Books.WithVersion(server, ws, "History", first);
        var etag = await SaveAgain(ws, book, second);

        var listed = await ws.Client.GetAsync($"/api/v1/workbooks/{book}/versions");
        Assert.Equal(HttpStatusCode.OK, listed.StatusCode);
        var versions = (await Kit.Json(listed)).GetProperty("versions").EnumerateArray().ToList();
        Assert.Equal(2, versions.Count);
        Assert.Equal(etag, WorkbookService.Etag(versions[0].GetProperty("id").GetGuid()));
        Assert.True(versions[0].GetProperty("current").GetBoolean());
        Assert.False(versions[1].GetProperty("current").GetBoolean());
        Assert.True(versions[0].GetProperty("savedAt").GetDateTimeOffset() >= versions[1].GetProperty("savedAt").GetDateTimeOffset());
        Assert.Equal(WorkbookService.Sha256Hex(first), versions[1].GetProperty("sha256").GetString());
        Assert.Equal(first.Length, versions[1].GetProperty("size").GetInt64());
        Assert.Equal(ws.Account.Id, versions[1].GetProperty("savedBy").GetProperty("id").GetGuid());
        Assert.False(string.IsNullOrEmpty(versions[1].GetProperty("savedBy").GetProperty("name").GetString()));

        // The older version's own bytes, by a signed URL for that one blob.
        var old = versions[1].GetProperty("id").GetGuid();
        var content = await Kit.Json(await ws.Client.GetAsync($"/api/v1/workbooks/{book}/versions/{old}/content"));
        Assert.Equal(old, content.GetProperty("versionId").GetGuid());
        Assert.Equal(WorkbookService.Etag(old), content.GetProperty("etag").GetString());
        Assert.Equal(first, await Books.Download(content.GetProperty("readUrl").GetString()!));
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.GetAsync($"/api/v1/workbooks/{book}/versions/{Guid.CreateVersion7()}/content")).StatusCode);
        // A version of another workbook is not this one's.
        var other = await Books.WithVersion(server, ws, "Other");
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.GetAsync($"/api/v1/workbooks/{other}/versions/{old}/content")).StatusCode);
    }

    [Fact]
    public async Task A_restore_copies_the_old_bytes_as_a_new_newest_version_saved_by_the_restorer()
    {
        var ws = await Ws.Create(server);
        var editor = await Kit.Join(server, ws, "member");
        var first = Books.Simple("first");
        var book = await Books.WithVersion(server, ws, "Restore", first);
        var etag = await SaveAgain(ws, book, Books.Simple("second"));
        var old = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{book}/versions")).GetProperty("versions")[1].GetProperty("id").GetGuid();

        // A stale If-Match is the save's 412 with the current version.
        var stale = await editor.Client.SendAsync(Restore(book, old, WorkbookService.Etag(old)));
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
        Assert.Equal("version.conflict", await Kit.Code(stale));
        Assert.Equal(etag, (await Kit.Json(stale)).GetProperty("current").GetProperty("etag").GetString());

        var restored = await editor.Client.SendAsync(Restore(book, old, etag));
        Assert.Equal(HttpStatusCode.Created, restored.StatusCode);
        var made = await Kit.Json(restored);
        var newId = made.GetProperty("versionId").GetGuid();
        Assert.Equal(WorkbookService.Etag(newId), made.GetProperty("etag").GetString());
        Assert.Equal(WorkbookService.Etag(newId), restored.Headers.ETag?.ToString());

        var versions = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{book}/versions")).GetProperty("versions").EnumerateArray().ToList();
        Assert.Equal(3, versions.Count);
        Assert.Equal(newId, versions[0].GetProperty("id").GetGuid());
        Assert.True(versions[0].GetProperty("current").GetBoolean());
        Assert.Equal(editor.Id, versions[0].GetProperty("savedBy").GetProperty("id").GetGuid());
        Assert.Equal(WorkbookService.Sha256Hex(first), versions[0].GetProperty("sha256").GetString());
        // No version was removed; the current content is the old bytes.
        Assert.Contains(versions, v => v.GetProperty("id").GetGuid() == old);
        var content = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{book}/content");
        Assert.Equal(first, await Books.Download(content.GetProperty("readUrl").GetString()!));
        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.AuditLog.SingleAsync(a => a.Action == "workbook.restore" && a.TargetId == book);
            Assert.Equal(editor.Id, row.ActorUserId);
            Assert.Contains(old.ToString(), row.Detail);
        }
        // Without If-Match it restores onto whatever is current.
        Assert.Equal(HttpStatusCode.Created, (await ws.Client.SendAsync(Restore(book, old))).StatusCode);
    }

    [Fact]
    public async Task The_history_routes_answer_by_the_callers_level_and_a_trashed_workbook_is_gone()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var reader = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var book = await Books.WithVersion(server, ws, "Matrix");
        await SaveAgain(ws, book, Books.Simple("again"));
        var shared = await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", Kit.Entries(false, ("user", reader.Id, "view")));
        Assert.True(shared.IsSuccessStatusCode, await shared.Content.ReadAsStringAsync());
        var old = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{book}/versions")).GetProperty("versions")[1].GetProperty("id").GetGuid();

        var expected = new Dictionary<string, (string List, string Content, string Restore, string Upload)>
        {
            ["owner"] = ("200", "200", "201", "201"),
            ["member"] = ("200", "200", "201", "201"),
            ["reader"] = ("200", "200", "403", "403"),
            ["guest"] = ("404", "404", "404", "404"),
        };
        var people = new Dictionary<string, Account> { ["owner"] = ws.Account, ["member"] = member, ["reader"] = reader, ["guest"] = guest };
        var failures = new List<string>();
        foreach (var (role, want) in expected)
        {
            var client = people[role].Client;
            var got = (
                Status(await client.GetAsync($"/api/v1/workbooks/{book}/versions")),
                Status(await client.GetAsync($"/api/v1/workbooks/{book}/versions/{old}/content")),
                Status(await client.SendAsync(Restore(book, old))),
                Status(await client.SendAsync(Upload(book, Books.Simple(role), ifMatch: "*"))));
            if (got != want) failures.Add($"{role}: expected {want}, got {got}");
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
        var refused = await reader.Client.SendAsync(Restore(book, old));
        Assert.Equal("access.denied", await Kit.Code(refused));

        // Trashed: the history is gone with it, to everyone who could see it.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workbooks/{book}")).StatusCode);
        foreach (var client in new[] { ws.Client, reader.Client })
        {
            Assert.Equal(HttpStatusCode.Gone, (await client.GetAsync($"/api/v1/workbooks/{book}/versions")).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await client.GetAsync($"/api/v1/workbooks/{book}/versions/{old}/content")).StatusCode);
        }
        var gone = await ws.Client.SendAsync(Restore(book, old));
        Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
        Assert.Equal("workbook.gone", await Kit.Code(gone));
        // And none of it by a share link or without a session.
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.Anonymous().GetAsync($"/api/v1/workbooks/{book}/versions")).StatusCode);
    }

    [Fact]
    public async Task The_app_uploads_a_version_with_the_saves_rules()
    {
        var ws = await Ws.Create(server);
        var book = (await Books.Create(ws, "Imported")).GetProperty("id").GetGuid();
        var bytes = Books.Simple("imported");

        // Neither condition: 428; not an xlsx: 400; If-Match with no version yet: 412.
        var none = await ws.Client.SendAsync(Upload(book, bytes));
        Assert.Equal((HttpStatusCode)428, none.StatusCode);
        Assert.Equal("version.required", await Kit.Code(none));
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.SendAsync(Upload(book, bytes, ifNoneMatch: "*", type: "application/octet-stream"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.SendAsync(Upload(book, "not a zip"u8.ToArray(), ifNoneMatch: "*"))).StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionFailed, (await ws.Client.SendAsync(Upload(book, bytes, ifMatch: "*"))).StatusCode);

        var created = await ws.Client.SendAsync(Upload(book, bytes, ifNoneMatch: "*"));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var first = await Kit.Json(created);
        var etag = first.GetProperty("etag").GetString()!;
        var dto = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{book}");
        Assert.Equal(etag, dto.GetProperty("etag").GetString());
        Assert.Equal(bytes.Length, dto.GetProperty("size").GetInt64());

        // The first-version condition holds once only; If-Match takes the current ETag.
        Assert.Equal(HttpStatusCode.PreconditionFailed, (await ws.Client.SendAsync(Upload(book, bytes, ifNoneMatch: "*"))).StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionFailed, (await ws.Client.SendAsync(Upload(book, bytes, ifMatch: "\"" + Guid.CreateVersion7() + "\""))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await ws.Client.SendAsync(Upload(book, Books.Simple("next"), ifMatch: etag))).StatusCode);
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(2, await db.AuditLog.CountAsync(a => a.Action == "workbook.save" && a.TargetId == book));
    }

    // Sheet's desktop app (Track S6) ------------------------------------------------------------------

    private static async Task<(string Url, string Ticket)> Launch(HttpClient client, Guid book, object body)
    {
        var response = await client.PostAsJsonAsync($"/api/v1/workbooks/{book}/launch", body);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var url = (await Kit.Json(response)).GetProperty("url").GetString()!;
        var at = url.IndexOf('#', StringComparison.Ordinal);
        var fragment = url[(at + 1)..];
        return (url, fragment[(fragment.IndexOf('=', StringComparison.Ordinal) + 1)..]);
    }

    [Fact]
    public async Task A_desktop_launch_is_a_deep_link_whose_ticket_redeems_only_from_the_desktop_origins()
    {
        var ws = await Ws.Create(server);
        var book = await Books.WithVersion(server, ws, "On the desktop");

        // The web link is as before, with {} and with target web.
        foreach (var body in new object[] { new { }, new { target = "web" } })
        {
            var (url, _) = await Launch(ws.Client, book, body);
            Assert.StartsWith($"{Integrations.DevSheetOrigin}/cloud#launch=", url);
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PostAsJsonAsync($"/api/v1/workbooks/{book}/launch", new { target = "mobile" })).StatusCode);

        var (desktopUrl, ticket) = await Launch(ws.Client, book, new { target = "desktop" });
        Assert.Equal($"cashgear-sheet://workspace/launch#ticket={ticket}", desktopUrl);
        Assert.Equal(43, ticket.Length);
        await using (var db = server.NewDb(ws.Id))
            Assert.Equal("desktop", (await db.WorkbookTickets.SingleAsync(t => t.TokenHash == Cgw.Core.Workspaces.WorkspaceService.Hash(ticket))).Target);

        // A site on neither list is refused before the ticket is looked at: it stays good.
        var denied = await Books.Redeem(Books.Sheet(server, "https://evil.example"), ticket);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal("origin.denied", await Kit.Code(denied));
        foreach (var origin in Integrations.DefaultDesktopOrigins)
        {
            var (_, fresh) = await Launch(ws.Client, book, new { target = "desktop" });
            var redeemed = await Books.Redeem(Books.Sheet(server, origin), fresh);
            Assert.True(redeemed.StatusCode == HttpStatusCode.OK, await redeemed.Content.ReadAsStringAsync());
            Assert.Equal("edit", (await Kit.Json(redeemed)).GetProperty("access").GetString());
        }
        var first = await Books.Redeem(Books.Sheet(server, "http://tauri.localhost"), ticket);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        // A desktop ticket offered at Sheet's web origin is used up and refused as an unknown one.
        var (_, wrongPlace) = await Launch(ws.Client, book, new { target = "desktop" });
        var atWeb = await Books.Redeem(Books.Sheet(server), wrongPlace);
        Assert.Equal(HttpStatusCode.Unauthorized, atWeb.StatusCode);
        Assert.Equal("ticket.invalid", await Kit.Code(atWeb));
        Assert.Equal(HttpStatusCode.Unauthorized, (await Books.Redeem(Books.Sheet(server, "http://tauri.localhost"), wrongPlace)).StatusCode);

        // And a web ticket offered at the desktop's origin.
        var (_, web) = await Launch(ws.Client, book, new { });
        var atDesktop = await Books.Redeem(Books.Sheet(server, "tauri://localhost"), web);
        Assert.Equal(HttpStatusCode.Unauthorized, atDesktop.StatusCode);
        Assert.Equal("ticket.invalid", await Kit.Code(atDesktop));
        Assert.Equal(HttpStatusCode.Unauthorized, (await Books.Redeem(Books.Sheet(server), web)).StatusCode);
    }

    [Fact]
    public async Task The_sheet_session_routes_allow_the_desktops_origins_by_cors()
    {
        foreach (var origin in Integrations.DefaultDesktopOrigins.Append(Books.SheetOrigin))
        {
            var preflight = new HttpRequestMessage(HttpMethod.Options, "/api/v1/sheet-sessions/redeem");
            preflight.Headers.Add("Origin", origin);
            preflight.Headers.Add("Access-Control-Request-Method", "POST");
            preflight.Headers.Add("Access-Control-Request-Headers", "content-type");
            var response = await server.Anonymous().SendAsync(preflight);
            Assert.True(response.Headers.TryGetValues("Access-Control-Allow-Origin", out var allowed), $"{origin}: {response.StatusCode}");
            Assert.Equal(origin, Assert.Single(allowed!));
            Assert.False(response.Headers.Contains("Access-Control-Allow-Credentials"));
        }
        var other = new HttpRequestMessage(HttpMethod.Options, "/api/v1/sheet-sessions/redeem");
        other.Headers.Add("Origin", "https://evil.example");
        other.Headers.Add("Access-Control-Request-Method", "POST");
        Assert.False((await server.Anonymous().SendAsync(other)).Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task The_app_may_send_a_versions_conditions_across_origins()
    {
        // The web app is on another origin than the API: an import's first version is sent with
        // If-None-Match, a later one with If-Match, and the browser asks first.
        foreach (var header in new[] { "if-none-match", "if-match" })
        {
            var preflight = new HttpRequestMessage(HttpMethod.Options, $"/api/v1/workbooks/{Guid.CreateVersion7()}/versions");
            preflight.Headers.Add("Origin", "http://localhost:5273");
            preflight.Headers.Add("Access-Control-Request-Method", "POST");
            preflight.Headers.Add("Access-Control-Request-Headers", $"content-type,x-csrf-token,{header}");
            var response = await server.Anonymous().SendAsync(preflight);
            Assert.True(response.Headers.TryGetValues("Access-Control-Allow-Headers", out var allowed), $"{header}: {response.StatusCode}");
            Assert.Contains(header, string.Join(',', allowed!).ToLowerInvariant().Split(',').Select(h => h.Trim()));
        }
    }

    [Fact]
    public void Desktop_origins_read_only_as_origins()
    {
        Assert.Equal("tauri://localhost", Integrations.DesktopOrigin("tauri://localhost"));
        Assert.Equal("http://tauri.localhost", Integrations.DesktopOrigin(" http://tauri.localhost/ "));
        Assert.Null(Integrations.DesktopOrigin("file:///c:/x"));
        Assert.Null(Integrations.DesktopOrigin("tauri://localhost/path"));
        Assert.Null(Integrations.DesktopOrigin("http://user@tauri.localhost"));
        Assert.Null(Integrations.DesktopOrigin("not an origin"));
    }
}
