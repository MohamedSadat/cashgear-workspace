using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Sites;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 9, M9.1's routes: publishing a page by someone with full on it (the slug's rules, a slug
/// taken across workspaces and freed by an unpublish, If-Match on the site's version), what would
/// be published listed first, the workspace's switch taking every site down at once, and an audit
/// row for each publish, change and unpublish.
/// </summary>
public sealed class PublishingTests(ServerFixture server)
{
    private static string Url(Guid page) => $"/api/v1/pages/{page}/site";

    private static string Slug(string stem) => $"{stem}-{Guid.NewGuid():N}"[..Math.Min(63, stem.Length + 13)];

    private static async Task<HttpResponseMessage> Publish(HttpClient client, Guid page, string slug, bool indexing = false, string language = "en", string? ifMatch = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, Url(page)) { Content = JsonContent.Create(new { slug, indexing, language }) };
        if (ifMatch is not null) request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> PublishOk(HttpClient client, Guid page, string slug, bool indexing = false, string language = "en")
    {
        var response = await Publish(client, page, slug, indexing, language);
        Assert.True(response.StatusCode == HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    [Fact]
    public void A_slug_is_three_to_sixty_three_of_the_letters_digits_and_dashes_and_not_reserved()
    {
        foreach (var good in new[] { "abc", "team-handbook", "page-0a1b2c3d", "a1b", new string('a', 63) })
            Assert.Null(SiteRules.SlugProblem(good));
        foreach (var bad in new[] { "", "ab", new string('a', 64), "Abc", "has space", "-start", "end-", "double--dash", "dot.ted", "_hidden", "api", "files",
                     "assets", "static", "health", "robots-txt", "favicon-ico", "admin", "www", "cashgear", "صفحة", "café" })
            Assert.NotNull(SiteRules.SlugProblem(bad));
        Assert.True(SiteRules.IsLanguage("ar"));
        Assert.False(SiteRules.IsLanguage("fr"));
    }

    [Fact]
    public async Task A_page_is_published_changed_and_unpublished_by_someone_with_full_on_it()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var root = (await ws.NewPage("Handbook")).GetProperty("id").GetGuid();
        var chapter = (await ws.NewPage("Chapter", root)).GetProperty("id").GetGuid();
        var restricted = (await ws.NewPage("Restricted", root)).GetProperty("id").GetGuid();
        await ws.NewPage("Under restricted", restricted);
        await Kit.Share(ws, restricted, true);
        var hidden = (await ws.NewPage("Hidden", root)).GetProperty("id").GetGuid();
        await Kit.Share(ws, hidden, false, ("workspace", ws.Id, "none"));

        // What would be published, before anything is: the scope, parents first, and a count of the rest.
        var before = await ws.Client.GetFromJsonAsync<JsonElement>(Url(root));
        Assert.Equal(JsonValueKind.Null, before.GetProperty("site").ValueKind);
        Assert.True(before.GetProperty("publishable").GetBoolean());
        Assert.Equal(JsonValueKind.Null, before.GetProperty("reason").ValueKind);
        Assert.Equal([root, chapter], before.GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("id").GetGuid()));
        Assert.Equal(JsonValueKind.Null, before.GetProperty("pages")[0].GetProperty("parentPageId").ValueKind);
        Assert.Equal(3, before.GetProperty("leftOut").GetInt32());
        Assert.DoesNotContain("Restricted", before.GetRawText());

        // An editor is not enough.
        foreach (var refused in new[]
                 {
                     await member.Client.GetAsync(Url(root)),
                     await Publish(member.Client, root, Slug("editor")),
                     await member.Client.DeleteAsync(Url(root)),
                 })
        {
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("access.denied", await Kit.Code(refused));
        }

        // The slug's shape and the language are checked.
        foreach (var (wrong, language) in new[] { ("ab", "en"), ("Upper", "en"), ("api", "en"), ("fine-slug", "fr") })
        {
            var invalid = await Publish(ws.Client, root, wrong, language: language);
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(invalid));
        }

        var slug = Slug("handbook");
        var response = await Publish(ws.Client, root, slug, language: "ar");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("\"1\"", response.Headers.ETag?.Tag);
        var site = await Kit.Json(response);
        Assert.Equal(slug, site.GetProperty("slug").GetString());
        Assert.Equal($"{SitesOptions.DevPublicUrl}/{slug}", site.GetProperty("url").GetString());
        Assert.Equal(root, site.GetProperty("pageId").GetGuid());
        Assert.Equal("ar", site.GetProperty("language").GetString());
        Assert.False(site.GetProperty("indexing").GetBoolean());
        Assert.Equal(1, site.GetProperty("version").GetInt64());
        Assert.Equal(ws.Account.Id, site.GetProperty("publishedBy").GetProperty("id").GetGuid());
        Assert.False(string.IsNullOrEmpty(site.GetProperty("publishedBy").GetProperty("name").GetString()));
        var listed = await ws.Client.GetFromJsonAsync<JsonElement>(Url(root));
        Assert.Equal(site.GetProperty("id").GetGuid(), listed.GetProperty("site").GetProperty("id").GetGuid());

        // The same again changes nothing; a change raises the version; If-Match holds it.
        Assert.Equal(1, (await PublishOk(ws.Client, root, slug, language: "ar")).GetProperty("version").GetInt64());
        var stale = await Publish(ws.Client, root, slug, indexing: true, language: "ar", ifMatch: "\"7\"");
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal("version.conflict", await Kit.Code(stale));
        var renamed = Slug("renamed");
        var changed = await Publish(ws.Client, root, renamed, indexing: true, language: "en", ifMatch: "\"1\"");
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);
        Assert.Equal(2, (await Kit.Json(changed)).GetProperty("version").GetInt64());
        // Its old slug is free for another page at once.
        Assert.Equal(slug, (await PublishOk(ws.Client, chapter, slug)).GetProperty("slug").GetString());

        // Another workspace cannot take a live slug.
        var other = await Ws.Create(server);
        var theirs = (await other.NewPage("Theirs")).GetProperty("id").GetGuid();
        var taken = await Publish(other.Client, theirs, renamed);
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
        Assert.Equal("slug.taken", await Kit.Code(taken));

        // Unpublished at once; once more is 404; the slug is free again.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync(Url(root))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.DeleteAsync(Url(root))).StatusCode);
        Assert.Equal(JsonValueKind.Null, (await ws.Client.GetFromJsonAsync<JsonElement>(Url(root))).GetProperty("site").ValueKind);
        Assert.Equal(renamed, (await PublishOk(other.Client, theirs, renamed)).GetProperty("slug").GetString());
        // If-Match on a page with no live site is a conflict.
        Assert.Equal(HttpStatusCode.Conflict, (await Publish(ws.Client, root, Slug("again"), ifMatch: "\"3\"")).StatusCode);

        await using var db = server.NewDb(ws.Id);
        var actions = await db.AuditLog.Where(a => a.TargetId == root).Select(a => a.Action).ToListAsync();
        Assert.Equal(1, actions.Count(a => a == "site.publish"));
        Assert.Equal(1, actions.Count(a => a == "site.update"));
        var unpublish = await db.AuditLog.SingleAsync(a => a.TargetId == root && a.Action == "site.unpublish");
        Assert.Contains("\"person\"", unpublish.Detail);
        var row = await db.PublishedSites.SingleAsync(s => s.RootPageId == root);
        Assert.Equal(SiteRules.ReasonPerson, row.UnpublishReason);
        Assert.Equal(ws.Account.Id, row.UnpublishedBy);
        Assert.Equal(3, row.Version);
    }

    [Fact]
    public async Task Private_trashed_rows_and_guests_follow_a_share_links_rules()
    {
        var ws = await Ws.Create(server);
        var guest = await Kit.Join(server, ws, "guest");
        var mine = (await ws.NewPage("Mine", section: ws.Personal)).GetProperty("id").GetGuid();
        var privateSite = await ws.Client.GetFromJsonAsync<JsonElement>(Url(mine));
        Assert.False(privateSite.GetProperty("publishable").GetBoolean());
        Assert.Equal("private", privateSite.GetProperty("reason").GetString());
        Assert.Empty(privateSite.GetProperty("pages").EnumerateArray());
        Assert.Equal(HttpStatusCode.BadRequest, (await Publish(ws.Client, mine, Slug("mine"))).StatusCode);

        var binned = (await ws.NewPage("Binned")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", binned, new { }));
        Assert.Equal("trashed", (await ws.Client.GetFromJsonAsync<JsonElement>(Url(binned))).GetProperty("reason").GetString());
        var trashed = await Publish(ws.Client, binned, Slug("binned"));
        Assert.Equal(HttpStatusCode.Conflict, trashed.StatusCode);
        Assert.Equal("conflict", await Kit.Code(trashed));

        var database = await DatabaseTests.NewDatabase(ws, "Rows");
        var rowId = Guid.CreateVersion7();
        var payload = DatabaseTests.PageJson(rowId, ws.Id, ws.Shared, database, "a0", "A row", "row");
        payload["row"] = new System.Text.Json.Nodes.JsonObject { ["values"] = new System.Text.Json.Nodes.JsonObject() };
        await ws.Push(ws.Op("page.create", rowId, payload));
        Assert.Equal(HttpStatusCode.BadRequest, (await Publish(ws.Client, rowId, Slug("row"))).StatusCode);
        // A database page itself may be a site's root.
        await PublishOk(ws.Client, database, Slug("rows"));

        // A guest with full on a page publishes it, as they may make its link.
        var shared = (await ws.NewPage("For the guest")).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Client.GetAsync(Url(shared))).StatusCode);
        await Kit.Share(ws, shared, false, ("user", guest.Id, "full"));
        await PublishOk(guest.Client, shared, Slug("guest"));
    }

    [Fact]
    public async Task The_switch_turned_off_takes_every_site_down_and_turned_on_brings_none_back()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var admin = await Kit.Join(server, ws, "admin");
        var a = (await ws.NewPage("Site A")).GetProperty("id").GetGuid();
        var b = (await ws.NewPage("Site B")).GetProperty("id").GetGuid();
        await PublishOk(ws.Client, a, Slug("site-a"));
        await PublishOk(admin.Client, b, Slug("site-b"));
        var publishing = $"/api/v1/workspaces/{ws.Id}/publishing";

        // Owners and admins see every live site; others only the switch.
        var seen = await admin.Client.GetFromJsonAsync<JsonElement>(publishing);
        Assert.True(seen.GetProperty("enabled").GetBoolean());
        var listed = seen.GetProperty("sites").EnumerateArray().ToList();
        Assert.Contains(listed, s => s.GetProperty("pageId").GetGuid() == a && s.GetProperty("pageTitle").GetString() == "Site A");
        var memberSees = await member.Client.GetFromJsonAsync<JsonElement>(publishing);
        Assert.True(memberSees.GetProperty("enabled").GetBoolean());
        Assert.Empty(memberSees.GetProperty("sites").EnumerateArray());
        var refused = await member.Client.PutAsJsonAsync(publishing, new { enabled = false });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);

        var off = await admin.Client.PutAsJsonAsync(publishing, new { enabled = false });
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        var after = await Kit.Json(off);
        Assert.False(after.GetProperty("enabled").GetBoolean());
        Assert.Empty(after.GetProperty("sites").EnumerateArray());
        var site = await ws.Client.GetFromJsonAsync<JsonElement>(Url(a));
        Assert.Equal(JsonValueKind.Null, site.GetProperty("site").ValueKind);
        Assert.Equal("off", site.GetProperty("reason").GetString());
        Assert.False(site.GetProperty("publishable").GetBoolean());
        var whileOff = await Publish(ws.Client, a, Slug("while-off"));
        Assert.Equal(HttpStatusCode.Forbidden, whileOff.StatusCode);
        Assert.Equal("publishing.off", await Kit.Code(whileOff));

        // On again: nothing comes back by itself.
        var on = await Kit.Json(await ws.Client.PutAsJsonAsync(publishing, new { enabled = true }));
        Assert.True(on.GetProperty("enabled").GetBoolean());
        Assert.Empty(on.GetProperty("sites").EnumerateArray());

        await using var db = server.NewDb(ws.Id);
        var downs = await db.AuditLog.Where(x => x.WorkspaceId == ws.Id && x.Action == "site.unpublish").ToListAsync();
        Assert.Equal(2, downs.Count);
        Assert.All(downs, x => Assert.Contains("publishing.off", x.Detail));
        Assert.Equal(2, await db.AuditLog.CountAsync(x => x.WorkspaceId == ws.Id && x.Action == "workspace.publishing"));
        Assert.All(await db.PublishedSites.ToListAsync(), s => Assert.Equal(SiteRules.ReasonPublishingOff, s.UnpublishReason));
    }

    [Fact]
    public async Task A_page_deleted_for_good_frees_its_sites_slug()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Going")).GetProperty("id").GetGuid();
        var slug = Slug("going");
        await PublishOk(ws.Client, page, slug);
        await ws.Push(ws.Op("page.trash", page, new { }));
        await ws.Push(ws.Op("page.delete", page, new { }));
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            await Kit.Job<PagePurgeJob>(server).PurgeAsync(db, ws.Id, page, CancellationToken.None);
            return 0;
        });
        await using (var db = server.NewDb(ws.Id))
            Assert.Equal(SiteRules.ReasonPageDeleted, (await db.PublishedSites.SingleAsync(s => s.RootPageId == page)).UnpublishReason);
        var other = (await ws.NewPage("Taking it")).GetProperty("id").GetGuid();
        Assert.Equal(slug, (await PublishOk(ws.Client, other, slug)).GetProperty("slug").GetString());
    }
}
