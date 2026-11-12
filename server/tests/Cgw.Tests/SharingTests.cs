using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>M2.6: a page's access list, its share links, and reading by link.</summary>
public sealed class SharingTests(ServerFixture server)
{
    private static string Url(Guid page) => $"/api/v1/pages/{page}/permissions";

    [Fact]
    public async Task Permissions_are_read_and_replaced_with_a_feed_change_and_an_audit_row()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var page = (await ws.NewPage("Budget")).GetProperty("id").GetGuid();

        var first = await ws.Client.GetAsync(Url(page));
        var empty = await Kit.Json(first);
        Assert.False(empty.GetProperty("restricted").GetBoolean());
        Assert.Equal("full", empty.GetProperty("yourLevel").GetString());
        Assert.Empty(empty.GetProperty("entries").EnumerateArray());
        Assert.Equal("\"1\"", first.Headers.ETag?.Tag);
        Assert.Equal("edit", (await member.Client.GetFromJsonAsync<JsonElement>(Url(page))).GetProperty("yourLevel").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Client.GetAsync(Url(page))).StatusCode);

        var cursor = (await ws.Tree()).GetProperty("cursor").GetInt64();
        var set = await ws.Client.PutAsJsonAsync(Url(page), Kit.Entries(true, ("user", member.Id, "view"), ("user", guest.Id, "edit")));
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        var after = await Kit.Json(set);
        Assert.True(after.GetProperty("restricted").GetBoolean());
        var entries = after.GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal(2, entries.Count);
        var memberEntry = entries.Single(e => e.GetProperty("principalId").GetGuid() == member.Id);
        Assert.Equal("view", memberEntry.GetProperty("level").GetString());
        Assert.Equal(member.Email, memberEntry.GetProperty("email").GetString());

        // The feed: the page, and one access change naming it, for everyone.
        var changes = (await ws.Changes(cursor, member.Client)).GetProperty("changes").EnumerateArray().ToList();
        Assert.Contains(changes, c => c.GetProperty("entityType").GetString() == "page" && c.GetProperty("entityId").GetGuid() == page
            && c.GetProperty("entity").GetProperty("page").GetProperty("access").GetString() == "view");
        var access = Assert.Single(changes, c => c.GetProperty("entityType").GetString() == "access");
        Assert.Equal(page, access.GetProperty("entityId").GetGuid());
        Assert.Equal("revoke", access.GetProperty("kind").GetString());
        Assert.Contains(page, (await ws.Changes(cursor, guest.Client)).GetProperty("changes").EnumerateArray()
            .Where(c => c.GetProperty("entityType").GetString() == "access").Select(c => c.GetProperty("entityId").GetGuid()));

        // What it changed: the member reads only, the guest edits.
        Assert.Equal("view", (await member.Client.GetFromJsonAsync<JsonElement>(Url(page))).GetProperty("yourLevel").GetString());
        Assert.Equal("edit", (await guest.Client.GetFromJsonAsync<JsonElement>(Url(page))).GetProperty("yourLevel").GetString());
        await using (var db = server.NewDb(ws.Id))
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "sharing.change" && a.TargetId == page));

        // Only full access changes it.
        var refused = await guest.Client.PutAsJsonAsync(Url(page), Kit.Entries(false));
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(refused));
    }

    [Fact]
    public async Task Permissions_refuse_strangers_bad_levels_repeats_and_a_stale_version()
    {
        var ws = await Ws.Create(server);
        var stranger = await server.NewAccount();
        var member = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Plan")).GetProperty("id").GetGuid();
        var bodies = new[]
        {
            Kit.Entries(false, ("user", stranger.Id, "view")),
            Kit.Entries(false, ("user", member.Id, "owner")),
            Kit.Entries(false, ("workspace", Guid.CreateVersion7(), "view")),
            Kit.Entries(false, ("group", member.Id, "view")),
            Kit.Entries(false, ("user", member.Id, "view"), ("user", member.Id, "edit")),
        };
        foreach (var body in bodies)
        {
            var response = await ws.Client.PutAsJsonAsync(Url(page), body);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(response));
        }
        // A private section's pages are its owner's alone.
        var mine = (await ws.NewPage("Mine", section: ws.Personal)).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PutAsJsonAsync(Url(mine), Kit.Entries(false, ("user", member.Id, "view")))).StatusCode);

        // If-Match with an old version is a conflict; with the current one it applies.
        var stale = new HttpRequestMessage(HttpMethod.Put, Url(page)) { Content = JsonContent.Create(Kit.Entries(false, ("workspace", ws.Id, "view"))) };
        stale.Headers.TryAddWithoutValidation("If-Match", "\"7\"");
        var conflict = await ws.Client.SendAsync(stale);
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal("version.conflict", await Kit.Code(conflict));
        var current = new HttpRequestMessage(HttpMethod.Put, Url(page)) { Content = JsonContent.Create(Kit.Entries(false, ("workspace", ws.Id, "view"))) };
        current.Headers.TryAddWithoutValidation("If-Match", "\"1\"");
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.SendAsync(current)).StatusCode);
        // A workspace row counts for members.
        Assert.Equal("view", (await member.Client.GetFromJsonAsync<JsonElement>(Url(page))).GetProperty("yourLevel").GetString());

        // The same principal at another level replaces its row; widening is a grant.
        var cursor = (await ws.Tree()).GetProperty("cursor").GetInt64();
        await Kit.Share(ws, page, false, ("workspace", ws.Id, "edit"));
        Assert.Equal("edit", (await member.Client.GetFromJsonAsync<JsonElement>(Url(page))).GetProperty("yourLevel").GetString());
        var access = Assert.Single((await ws.Changes(cursor)).GetProperty("changes").EnumerateArray(), c => c.GetProperty("entityType").GetString() == "access");
        Assert.Equal("grant", access.GetProperty("kind").GetString());
    }

    [Fact]
    public async Task A_guest_sees_only_pages_shared_with_them_by_name()
    {
        var ws = await Ws.Create(server);
        var guest = await Kit.Join(server, ws, "guest");
        var parent = (await ws.NewPage("Parent")).GetProperty("id").GetGuid();
        var child = (await ws.NewPage("Child", parent)).GetProperty("id").GetGuid();
        var other = (await ws.NewPage("Other")).GetProperty("id").GetGuid();
        // The whole workspace's row does not reach a guest.
        await Kit.Share(ws, other, false, ("workspace", ws.Id, "view"));
        Assert.Empty((await ws.Tree(guest.Client)).GetProperty("pages").EnumerateArray());
        await Kit.Share(ws, parent, false, ("user", guest.Id, "view"));
        var seen = (await ws.Tree(guest.Client)).GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("id").GetGuid()).ToHashSet();
        Assert.True(seen.SetEquals([parent, child]));
        // The scoped resync the access change asks for returns the same subtree.
        var scoped = (await ws.Tree(guest.Client, parent)).GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("id").GetGuid()).ToHashSet();
        Assert.True(scoped.SetEquals([parent, child]));
    }

    private static HttpClient Reader(ServerFixture server, string? token)
    {
        var client = server.Anonymous();
        if (token is not null) client.DefaultRequestHeaders.Add("X-Share-Token", token);
        return client;
    }

    [Fact]
    public async Task A_share_link_opens_its_page_and_subtree_for_reading_and_nothing_else()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var root = (await ws.NewPage("Handbook")).GetProperty("id").GetGuid();
        var chapter = await Kit.PageWithText(server, ws, "Chapter", root);
        var section = (await ws.NewPage("Section", chapter)).GetProperty("id").GetGuid();
        var secret = (await ws.NewPage("Restricted", root)).GetProperty("id").GetGuid();
        var underSecret = (await ws.NewPage("Under restricted", secret)).GetProperty("id").GetGuid();
        await Kit.Share(ws, secret, true);
        var binned = (await ws.NewPage("Binned", root)).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", binned, new { }));
        var outside = await Kit.PageWithText(server, ws, "Outside");
        var picture = await AssetTests.Upload(ws, AssetTests.Png, "image/png");
        var unrelated = await AssetTests.Upload(ws, AssetTests.Png, "image/png");
        await server.RunJob<AssetCheckJob>();
        await ws.Push(ws.Op("page.update", chapter, new { coverAssetId = picture }));

        // Only full access makes links; an edit-level member cannot.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.PostAsJsonAsync($"/api/v1/pages/{root}/share-links", new { })).StatusCode);
        foreach (var days in new[] { 0, 366 })
            Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{root}/share-links", new { expiresInDays = days })).StatusCode);
        var created = await ws.Client.PostAsync($"/api/v1/pages/{root}/share-links", null);
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var link = await Kit.Json(created);
        var token = link.GetProperty("token").GetString()!;
        Assert.Equal(43, token.Length);
        Assert.InRange(link.GetProperty("expiresAt").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddDays(29), DateTimeOffset.UtcNow.AddDays(31));
        var listed = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{root}/share-links");
        var entry = Assert.Single(listed.EnumerateArray());
        Assert.Equal("view", entry.GetProperty("level").GetString());
        Assert.False(entry.TryGetProperty("token", out _));
        await using (var db = server.NewDb(ws.Id))
        {
            var stored = await db.ShareLinks.SingleAsync(l => l.PageId == root);
            Assert.Equal(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token)), stored.TokenHash);
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "share.create" && a.TargetId == root));
        }

        var reader = Reader(server, token);
        var tree = await reader.GetFromJsonAsync<JsonElement>("/api/v1/shared");
        Assert.Equal(root, tree.GetProperty("page").GetProperty("id").GetGuid());
        Assert.Equal("Handbook", tree.GetProperty("page").GetProperty("title").GetString());
        var pages = tree.GetProperty("pages").EnumerateArray().ToList();
        Assert.Equal([root, chapter, section], pages.Select(p => p.GetProperty("id").GetGuid()));
        Assert.Equal(JsonValueKind.Null, pages[0].GetProperty("parentPageId").ValueKind);
        Assert.Equal(chapter, pages[2].GetProperty("parentPageId").GetGuid());

        var doc = await reader.GetFromJsonAsync<JsonElement>($"/api/v1/shared/pages/{chapter}/json");
        Assert.Contains("Hello world", doc.GetProperty("json").GetString());
        foreach (var hidden in new[] { secret, underSecret, binned, outside, Guid.CreateVersion7() })
            Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/pages/{hidden}/json")).StatusCode);
        var url = await reader.GetFromJsonAsync<JsonElement>($"/api/v1/shared/assets/{picture}/url");
        Assert.True(url.GetProperty("inline").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/assets/{unrelated}/url")).StatusCode);

        // The token opens nothing else.
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.GetAsync($"/api/v1/pages/{chapter}/doc")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.GetAsync($"/api/v1/workspaces/{ws.Id}/tree")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.GetAsync($"/api/v1/assets/{picture}/url")).StatusCode);
        foreach (var wrong in new string?[] { null, "", "not-a-token", token[..^1] + (token[^1] == 'A' ? 'B' : 'A') })
        {
            var response = await Reader(server, wrong).GetAsync("/api/v1/shared");
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("not.found", await Kit.Code(response));
        }

        // Revoked: every read is 404.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/pages/{root}/share-links/{link.GetProperty("id").GetGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync("/api/v1/shared")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/pages/{chapter}/json")).StatusCode);
        Assert.Empty((await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{root}/share-links")).EnumerateArray());
        await using (var db = server.NewDb(ws.Id))
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "share.revoke" && a.TargetId == root));
    }

    [Fact]
    public async Task An_expired_link_or_a_trashed_page_opens_nothing()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Notice")).GetProperty("id").GetGuid();
        var token = (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { expiresInDays = 1 })
            .ContinueWith(t => Kit.Json(t.Result)).Unwrap()).GetProperty("token").GetString();
        var reader = Reader(server, token);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync("/api/v1/shared")).StatusCode);
        await using (var db = server.NewDb(ws.Id))
            await db.ShareLinks.Where(l => l.PageId == page).ExecuteUpdateAsync(s => s.SetProperty(l => l.ExpiresAt, DateTimeOffset.UtcNow.AddMinutes(-1)));
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync("/api/v1/shared")).StatusCode);
        Assert.Empty((await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/share-links")).EnumerateArray());

        var second = (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { })
            .ContinueWith(t => Kit.Json(t.Result)).Unwrap()).GetProperty("token").GetString();
        await ws.Push(ws.Op("page.trash", page, new { }));
        Assert.Equal(HttpStatusCode.NotFound, (await Reader(server, second).GetAsync("/api/v1/shared")).StatusCode);
        // Nor are links made on a page in the trash, or in a private section.
        Assert.Equal(HttpStatusCode.Conflict, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { })).StatusCode);
        var mine = (await ws.NewPage("Mine", section: ws.Personal)).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{mine}/share-links", new { })).StatusCode);
    }
}
