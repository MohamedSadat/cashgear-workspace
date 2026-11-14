using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Sheet's routes (contract <c>sheet-session.1</c>, as Sheet's mock behaves): launch tickets,
/// redemption from an allowed origin, file sessions and their lifetimes, access checked again on
/// every request, saves with <c>If-Match</c> / <c>If-None-Match: *</c>, copies that move the
/// session, the headers and the CORS policy of their own.
/// </summary>
public sealed class SheetSessionTests(ServerFixture server)
{
    private const string Sessions = "/api/v1/sheet-sessions";

    private HttpClient Sheet => Books.Sheet(server);

    private static HttpRequestMessage Get(string token, string path = Sessions + "/workbook") => Books.Request(HttpMethod.Get, path, token);

    private static HttpRequestMessage Post(string? token, string path) => Books.Request(HttpMethod.Post, path, token);

    private async Task<HttpResponseMessage> Send(HttpRequestMessage request) => await server.Anonymous().SendAsync(request);

    [Fact]
    public async Task A_launch_makes_a_one_time_ticket_bound_to_the_person_the_workbook_and_the_access()
    {
        var ws = await Ws.Create(server);
        var viewer = await Kit.Join(server, ws, "member");
        var book = (await Books.Create(ws, "Budget")).GetProperty("id").GetGuid();
        await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", Kit.Entries(false, ("user", viewer.Id, "view")));

        var launch = await Kit.Json(await Books.Launch(ws.Client, book));
        var url = launch.GetProperty("url").GetString()!;
        Assert.Matches("^http://127\\.0\\.0\\.1:4283/cloud#launch=[A-Za-z0-9_-]{43}$", url);
        Assert.InRange(launch.GetProperty("expiresAt").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddSeconds(100), DateTimeOffset.UtcNow.AddSeconds(125));
        var ticket = url[^43..];
        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.WorkbookTickets.SingleAsync(t => t.WorkbookId == book);
            Assert.Equal(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(ticket)), row.TokenHash);
            Assert.Equal("edit", row.Access);
            Assert.Equal(ws.Account.Id, row.UserId);
        }

        // The Origin is checked first, so a refused site cannot use the ticket up.
        foreach (var origin in new[] { "https://evil.example", "http://localhost:5273" })
        {
            var refused = await Books.Redeem(Books.Sheet(server, origin), ticket);
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("origin.denied", await Kit.Code(refused));
        }
        var noOrigin = await server.Anonymous().PostAsJsonAsync($"{Sessions}/redeem", new { ticket });
        Assert.Equal("origin.denied", await Kit.Code(noOrigin));

        var redeemed = await Books.Redeem(Sheet, ticket);
        Assert.Equal(HttpStatusCode.OK, redeemed.StatusCode);
        Assert.Equal("no-store", redeemed.Headers.CacheControl?.ToString());
        Assert.True(redeemed.Headers.Contains("X-Correlation-Id"));
        var session = await Kit.Json(redeemed);
        Assert.Matches("^[A-Za-z0-9_-]{43}$", session.GetProperty("token").GetString()!);
        Assert.InRange(session.GetProperty("expiresAt").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddMinutes(29), DateTimeOffset.UtcNow.AddMinutes(31));
        Assert.InRange(session.GetProperty("maxExpiresAt").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddHours(9.9), DateTimeOffset.UtcNow.AddHours(10.1));
        Assert.Equal(book, session.GetProperty("workbook").GetProperty("id").GetGuid());
        Assert.Equal("Budget", session.GetProperty("workbook").GetProperty("name").GetString());
        Assert.Equal("edit", session.GetProperty("access").GetString());
        Assert.Equal(ws.Account.Id, session.GetProperty("user").GetProperty("id").GetGuid());
        Assert.False(string.IsNullOrEmpty(session.GetProperty("user").GetProperty("name").GetString()));
        Assert.Equal("en", session.GetProperty("language").GetString());

        // One use; unknown, used and expired tickets look the same.
        var used = await Books.Redeem(Sheet, ticket);
        Assert.Equal(HttpStatusCode.Unauthorized, used.StatusCode);
        Assert.Equal("ticket.invalid", await Kit.Code(used));
        var unknown = await Books.Redeem(Sheet, Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_'));
        Assert.Equal("ticket.invalid", await Kit.Code(unknown));
        Assert.Equal((await Kit.Json(used)).GetProperty("title").GetString(), (await Kit.Json(unknown)).GetProperty("title").GetString());
        var late = await Books.Ticket(ws.Client, book);
        await using (var db = server.NewDb(ws.Id))
            await db.WorkbookTickets.Where(t => t.TokenHash == SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(late)))
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.ExpiresAt, DateTimeOffset.UtcNow.AddSeconds(-1)));
        Assert.Equal("ticket.invalid", await Kit.Code(await Books.Redeem(Sheet, late)));
        var missing = await Books.Redeem(Sheet, null);
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal("request.invalid", await Kit.Code(missing));
        var notJson = await Sheet.PostAsync($"{Sessions}/redeem", new StringContent("ticket=x"));
        Assert.Equal(HttpStatusCode.BadRequest, notJson.StatusCode);

        // A viewer's ticket opens a view session, which reads and does not save.
        var view = await Books.Open(server, viewer.Client, book);
        Assert.Equal("view", view.GetProperty("access").GetString());
        var refusedSave = await Send(Books.Save(view.GetProperty("token").GetString()!, Books.Simple(), ifNoneMatch: "*"));
        Assert.Equal(HttpStatusCode.Forbidden, refusedSave.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(refusedSave));
        // A session has at most the access its ticket carried...
        var viewTicket = await Books.Ticket(viewer.Client, book);
        await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", Kit.Entries(false));
        Assert.Equal("view", (await Kit.Json(await Books.Redeem(Sheet, viewTicket))).GetProperty("access").GetString());
        // ...and at most the level its person has when it is redeemed.
        var editTicket = await Books.Ticket(viewer.Client, book);
        await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", Kit.Entries(false, ("user", viewer.Id, "comment")));
        Assert.Equal("view", (await Kit.Json(await Books.Redeem(Sheet, editTicket))).GetProperty("access").GetString());
        Assert.Equal("edit", (await Books.Open(server, ws.Client, book)).GetProperty("access").GetString());

        // The person's language: their Workspace locale.
        await using (var db = server.NewDb())
            await db.Users.Where(u => u.Id == viewer.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.Locale, "ar"));
        Assert.Equal("ar", (await Books.Open(server, viewer.Client, book)).GetProperty("language").GetString());
        // A trashed workbook is gone, and its ticket is used up.
        var beforeTrash = await Books.Ticket(ws.Client, book);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workbooks/{book}")).StatusCode);
        var gone = await Books.Redeem(Sheet, beforeTrash);
        Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
        Assert.Equal("workbook.gone", await Kit.Code(gone));
        Assert.Equal("ticket.invalid", await Kit.Code(await Books.Redeem(Sheet, beforeTrash)));
        Assert.Equal(HttpStatusCode.Gone, (await Books.Launch(ws.Client, book)).StatusCode);
    }

    [Fact]
    public async Task A_session_lives_30_minutes_idle_and_10_hours_at_most_and_ends_when_asked()
    {
        var ws = await Ws.Create(server);
        var book = (await Books.Create(ws, "Lifetimes")).GetProperty("id").GetGuid();
        var token = await Books.Token(server, ws.Client, book);
        async Task Shift(Func<FileSession, (DateTimeOffset Idle, DateTimeOffset Max)> to)
        {
            await using var db = server.NewDb(ws.Id);
            var hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token));
            var session = await db.FileSessions.SingleAsync(s => s.TokenHash == hash);
            (session.IdleExpiresAt, session.MaxExpiresAt) = to(session);
            await db.SaveChangesAsync();
        }

        // Renew slides the idle expiry by 30 minutes...
        await Shift(s => (DateTimeOffset.UtcNow.AddMinutes(1), s.MaxExpiresAt));
        var renewed = await Send(Post(token, $"{Sessions}/renew"));
        Assert.Equal(HttpStatusCode.OK, renewed.StatusCode);
        Assert.InRange((await Kit.Json(renewed)).GetProperty("expiresAt").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddMinutes(29), DateTimeOffset.UtcNow.AddMinutes(31));
        // ...never past the maximum.
        var max = DateTimeOffset.UtcNow.AddMinutes(5);
        await Shift(_ => (DateTimeOffset.UtcNow.AddMinutes(1), max));
        var capped = (await Kit.Json(await Send(Post(token, $"{Sessions}/renew")))).GetProperty("expiresAt").GetDateTimeOffset();
        Assert.InRange(capped, max.AddMilliseconds(-2), max.AddMilliseconds(2));

        // Idle past its expiry, or past its maximum: ended.
        await Shift(s => (DateTimeOffset.UtcNow.AddSeconds(-1), s.MaxExpiresAt));
        var idle = await Send(Get(token));
        Assert.Equal(HttpStatusCode.Unauthorized, idle.StatusCode);
        Assert.Equal("session.expired", await Kit.Code(idle));
        Assert.Equal("session.expired", await Kit.Code(await Send(Post(token, $"{Sessions}/renew"))));
        await Shift(_ => (DateTimeOffset.UtcNow.AddMinutes(10), DateTimeOffset.UtcNow.AddSeconds(-1)));
        Assert.Equal("session.expired", await Kit.Code(await Send(Get(token))));

        // End: 204, then nothing more; an unknown or missing token is the same 401.
        var other = await Books.Token(server, ws.Client, book);
        Assert.Equal(HttpStatusCode.OK, (await Send(Get(other))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await Send(Post(other, $"{Sessions}/end"))).StatusCode);
        Assert.Equal("session.expired", await Kit.Code(await Send(Get(other))));
        Assert.Equal("session.expired", await Kit.Code(await Send(Post(other, $"{Sessions}/end"))));
        Assert.Equal("session.expired", await Kit.Code(await Send(Get("not-a-session"))));
        Assert.Equal("session.expired", await Kit.Code(await Send(Books.Request(HttpMethod.Get, $"{Sessions}/workbook", null))));
        // A Workspace cookie is not a file session.
        Assert.Equal(HttpStatusCode.Unauthorized, (await ws.Client.GetAsync($"{Sessions}/workbook")).StatusCode);
    }

    [Fact]
    public async Task Access_is_checked_again_on_every_request_of_a_session()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var book = await Books.WithVersion(server, ws, "Watched");
        var token = await Books.Token(server, member.Client, book);
        Assert.Equal(HttpStatusCode.OK, (await Send(Get(token))).StatusCode);

        // Taken away: the next request is refused; given back, it works again.
        await Kit.Json(await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", Kit.Entries(true)));
        var revoked = await Send(Get(token));
        Assert.Equal(HttpStatusCode.Forbidden, revoked.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(revoked));
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(Post(token, $"{Sessions}/renew"))).StatusCode);
        await Kit.Json(await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", Kit.Entries(true, ("user", member.Id, "view"))));
        Assert.Equal(HttpStatusCode.OK, (await Send(Get(token))).StatusCode);
        // An edit session whose person can only read now does not save.
        var etag = (await Kit.Json(await Send(Get(token)))).GetProperty("etag").GetString();
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(Books.Save(token, Books.Simple(), ifMatch: etag))).StatusCode);

        // Trashed: gone; restored: there again.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workbooks/{book}")).StatusCode);
        Assert.Equal("workbook.gone", await Kit.Code(await Send(Get(token))));
        var restore = new HttpRequestMessage(HttpMethod.Patch, $"/api/v1/workbooks/{book}") { Content = JsonContent.Create(new { trashed = false }) };
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.SendAsync(restore)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Send(Get(token))).StatusCode);

        // Removed from the workspace: refused, and their sessions end.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{member.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send(Get(token))).StatusCode);
    }

    [Fact]
    public async Task Saves_need_a_condition_and_a_stale_one_names_the_current_version()
    {
        var ws = await Ws.Create(server);
        var other = await Kit.Join(server, ws, "member", await server.NewAccount("Omar Other"));
        var book = (await Books.Create(ws, "Saved")).GetProperty("id").GetGuid();
        var token = await Books.Token(server, ws.Client, book);

        // No version yet: nulls, and no ETag.
        var blank = await Send(Get(token));
        Assert.False(blank.Headers.Contains("ETag"));
        var empty = await Kit.Json(blank);
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("readUrl").ValueKind);
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("etag").ValueKind);
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("size").ValueKind);
        Assert.Equal("Saved", empty.GetProperty("name").GetString());

        var bytes = Books.Simple("first");
        var none = await Send(Books.Save(token, bytes));
        Assert.Equal(HttpStatusCode.PreconditionRequired, none.StatusCode);
        Assert.Equal("version.required", await Kit.Code(none));
        var wrongType = await Send(Books.Save(token, bytes, ifNoneMatch: "*", type: "application/octet-stream"));
        Assert.Equal(HttpStatusCode.BadRequest, wrongType.StatusCode);
        var notZip = await Send(Books.Save(token, "not a workbook"u8.ToArray(), ifNoneMatch: "*"));
        Assert.Equal(HttpStatusCode.BadRequest, notZip.StatusCode);
        Assert.Equal("request.invalid", await Kit.Code(notZip));

        var first = await Send(Books.Save(token, bytes, ifNoneMatch: "*"));
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var saved = await Kit.Json(first);
        var versionId = saved.GetProperty("versionId").GetGuid();
        var etag = saved.GetProperty("etag").GetString()!;
        Assert.Equal($"\"{versionId}\"", etag);
        Assert.Equal(etag, first.Headers.ETag?.Tag);
        Assert.Equal($"/api/v1/sheet-sessions/workbook/versions/{versionId}", first.Headers.Location?.ToString());
        await using (var db = server.NewDb(ws.Id))
        {
            var version = await db.WorkbookVersions.SingleAsync(v => v.Id == versionId);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), version.Sha256);
            Assert.Equal(bytes.Length, version.SizeBytes);
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "workbook.save" && a.TargetId == book && a.ActorUserId == ws.Account.Id));
        }
        var read = await Send(Get(token));
        Assert.Equal(etag, read.Headers.ETag?.Tag);
        var current = await Kit.Json(read);
        Assert.Equal(etag, current.GetProperty("etag").GetString());
        Assert.Equal(bytes.Length, current.GetProperty("size").GetInt64());
        Assert.Equal(bytes, await Books.Download(current.GetProperty("readUrl").GetString()!));

        // A first save when there is one already, and a stale If-Match: 412 with the current version.
        var again = await Send(Books.Save(token, Books.Simple("second"), ifNoneMatch: "*"));
        Assert.Equal(HttpStatusCode.PreconditionFailed, again.StatusCode);
        var otherToken = await Books.Token(server, other.Client, book);
        var theirs = Books.Simple("theirs");
        var theirSave = await Kit.Json(await Send(Books.Save(otherToken, theirs, ifMatch: etag)));
        var stale = await Send(Books.Save(token, Books.Simple("mine"), ifMatch: etag));
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
        var problem = await Kit.Json(stale);
        Assert.Equal("version.conflict", problem.GetProperty("code").GetString());
        var named = problem.GetProperty("current");
        Assert.Equal(theirSave.GetProperty("versionId").GetGuid(), named.GetProperty("versionId").GetGuid());
        Assert.Equal(theirSave.GetProperty("etag").GetString(), named.GetProperty("etag").GetString());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(theirs)), named.GetProperty("sha256").GetString());
        Assert.Equal(other.Id, named.GetProperty("savedBy").GetProperty("id").GetGuid());
        Assert.Equal("Omar Other", named.GetProperty("savedBy").GetProperty("name").GetString());
        Assert.InRange(named.GetProperty("savedAt").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));
        // The ETag it names is the one to send; If-Match on it lands.
        Assert.Equal(HttpStatusCode.Created, (await Send(Books.Save(token, Books.Simple("mine"), ifMatch: named.GetProperty("etag").GetString()))).StatusCode);
        // A save that lost its answer is sent again: the 412's sha256 says it landed.
        var mine = Books.Simple("resent");
        var landed = await Kit.Json(await Send(Books.Save(token, mine, ifMatch: (await Kit.Json(await Send(Get(token)))).GetProperty("etag").GetString())));
        var resent = await Kit.Json(await Send(Books.Save(token, mine, ifMatch: etag)));
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(mine)), resent.GetProperty("current").GetProperty("sha256").GetString());
        Assert.Equal(landed.GetProperty("versionId").GetGuid(), resent.GetProperty("current").GetProperty("versionId").GetGuid());
    }

    [Fact]
    public async Task A_save_over_the_cap_is_413_with_the_limit()
    {
        await using var api = server.Variant(b => b.UseSetting("Workbooks:MaxSaveBytes", "2000"));
        var ws = await Ws.Create(server);
        var book = (await Books.Create(ws, "Capped")).GetProperty("id").GetGuid();
        var token = await Books.Token(server, ws.Client, book);
        var client = ServerFixture.ClientOf(api);
        var big = new byte[2001];
        big[0] = 0x50;
        big[1] = 0x4B;
        big[2] = 3;
        big[3] = 4;
        var response = await client.SendAsync(Books.Save(token, big, ifNoneMatch: "*"));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        var problem = await Kit.Json(response);
        Assert.Equal("limit.size", problem.GetProperty("code").GetString());
        Assert.Equal(2000, problem.GetProperty("limit").GetInt64());
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await client.SendAsync(Books.Save(token, big, path: $"{Sessions}/workbook/copies"))).StatusCode);
    }

    [Fact]
    public async Task A_copy_is_a_new_workbook_beside_the_original_and_the_session_moves_to_it()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var bystander = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var book = await Books.WithVersion(server, ws, "Budget 2027");
        await Kit.Json(await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions",
            Kit.Entries(true, ("user", member.Id, "view"), ("user", guest.Id, "edit"))));

        // A view session may copy: the copy is the maker's to edit, and the session moves to it.
        var token = await Books.Token(server, member.Client, book);
        var bytes = Books.Simple("copied");
        var response = await Send(Books.Save(token, bytes, path: $"{Sessions}/workbook/copies"));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var copy = await Kit.Json(response);
        var copyId = copy.GetProperty("workbook").GetProperty("id").GetGuid();
        Assert.NotEqual(book, copyId);
        Assert.Equal("Budget 2027 (copy)", copy.GetProperty("workbook").GetProperty("name").GetString());
        Assert.Equal("edit", copy.GetProperty("access").GetString());
        Assert.Equal(copy.GetProperty("etag").GetString(), response.Headers.ETag?.Tag);
        var moved = await Kit.Json(await Send(Get(token)));
        Assert.Equal("Budget 2027 (copy)", moved.GetProperty("name").GetString());
        Assert.Equal(copy.GetProperty("etag").GetString(), moved.GetProperty("etag").GetString());
        Assert.Equal(HttpStatusCode.Created, (await Send(Books.Save(token, Books.Simple("edited copy"), ifMatch: moved.GetProperty("etag").GetString()))).StatusCode);
        // The original is as it was.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.PatchAsJsonAsync($"/api/v1/workbooks/{book}", new { name = "x" })).StatusCode);
        // The copy keeps the original's list: no one sees it who could not see the original.
        Assert.Equal("edit", (await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{copyId}")).GetProperty("access").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await bystander.Client.GetAsync($"/api/v1/workbooks/{copyId}")).StatusCode);
        await using (var db = server.NewDb(ws.Id))
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "workbook.copy" && a.TargetId == copyId && a.ActorUserId == member.Id));

        // In Arabic the copy is named so.
        await using (var db = server.NewDb())
            await db.Users.Where(u => u.Id == ws.Account.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.Locale, "ar"));
        var arabic = await Kit.Json(await Send(Books.Save(await Books.Token(server, ws.Client, book), bytes, path: $"{Sessions}/workbook/copies")));
        Assert.Equal("Budget 2027 (نسخة)", arabic.GetProperty("workbook").GetProperty("name").GetString());

        // Guests make no workbooks, copies included; the body is checked as a save's.
        var refused = await Send(Books.Save(await Books.Token(server, guest.Client, book), bytes, path: $"{Sessions}/workbook/copies"));
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(refused));
        Assert.Equal(HttpStatusCode.BadRequest, (await Send(Books.Save(token, "nope"u8.ToArray(), path: $"{Sessions}/workbook/copies"))).StatusCode);
    }

    [Fact]
    public async Task The_routes_answer_sheets_origins_with_cors_of_their_own_and_no_credentials()
    {
        async Task<HttpResponseMessage> Preflight(string origin, string path, string method = "POST")
        {
            var request = new HttpRequestMessage(HttpMethod.Options, path);
            request.Headers.Add("Origin", origin);
            request.Headers.Add("Access-Control-Request-Method", method);
            request.Headers.Add("Access-Control-Request-Headers", "content-type,x-workspace-file-session,if-match");
            return await server.Anonymous().SendAsync(request);
        }
        var ok = await Preflight(Books.SheetOrigin, $"{Sessions}/workbook/versions");
        Assert.Equal(Books.SheetOrigin, ok.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.False(ok.Headers.Contains("Access-Control-Allow-Credentials"));
        var headers = string.Join(",", ok.Headers.GetValues("Access-Control-Allow-Headers")).ToLowerInvariant();
        Assert.Contains("x-workspace-file-session", headers);
        Assert.Contains("if-match", headers);
        Assert.Contains("POST", string.Join(",", ok.Headers.GetValues("Access-Control-Allow-Methods")));
        // The mock Sheet's origin too; the web app's origin is not Sheet's.
        Assert.True((await Preflight("http://127.0.0.1:4283", $"{Sessions}/redeem")).Headers.Contains("Access-Control-Allow-Origin"));
        Assert.False((await Preflight("http://localhost:5273", $"{Sessions}/redeem")).Headers.Contains("Access-Control-Allow-Origin"));
        Assert.False((await Preflight("https://evil.example", $"{Sessions}/workbook", "GET")).Headers.Contains("Access-Control-Allow-Origin"));
        // And Sheet's origin gains nothing on the web app's routes.
        Assert.False((await Preflight(Books.SheetOrigin, "/api/v1/workspaces", "GET")).Headers.Contains("Access-Control-Allow-Origin"));

        // An answer exposes what the sheet reads.
        var ws = await Ws.Create(server);
        var book = (await Books.Create(ws, "Cors")).GetProperty("id").GetGuid();
        var answer = await Send(Get(await Books.Token(server, ws.Client, book)));
        Assert.Equal(Books.SheetOrigin, answer.Headers.GetValues("Access-Control-Allow-Origin").Single());
        var exposed = string.Join(",", answer.Headers.GetValues("Access-Control-Expose-Headers"));
        foreach (var name in new[] { "X-Correlation-Id", "ETag", "Retry-After", "Location" }) Assert.Contains(name, exposed, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("no-store", answer.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task Redemption_is_rate_limited_per_address_with_retry_after()
    {
        await using var api = server.Variant(b => b.UseSetting("RateLimits:ticket", "2"));
        var client = ServerFixture.ClientOf(api);
        client.DefaultRequestHeaders.Add("Origin", Books.SheetOrigin);
        HttpResponseMessage? refused = null;
        for (var i = 0; i < 5 && refused is null; i++)
        {
            var response = await Books.Redeem(client, "x");
            if (response.StatusCode == HttpStatusCode.TooManyRequests) refused = response;
        }
        Assert.NotNull(refused);
        Assert.Equal("limit.rate", await Kit.Code(refused));
        Assert.True(refused.Headers.RetryAfter is not null);
        Assert.Equal(Books.SheetOrigin, refused.Headers.GetValues("Access-Control-Allow-Origin").Single());
    }
}
