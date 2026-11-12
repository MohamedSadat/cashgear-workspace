using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Cgw.Api.Identity;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// The M2.6 review's other findings: invitations, share links, the search cursor, the directory a
/// guest sees, exports, the worker's last word on a push, covers, repeated creates and account
/// deletion's owner check.
/// </summary>
public sealed class AccessReviewTests(ServerFixture server)
{
    private async Task<string> Invite(Ws ws, string email, string role)
    {
        var before = server.MailFiles();
        var invited = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/invites", new { email, role });
        Assert.Equal(HttpStatusCode.OK, invited.StatusCode);
        return await Kit.InviteToken(server, email, before);
    }

    private static HttpClient Reader(ServerFixture server, string token)
    {
        var client = server.Anonymous();
        client.DefaultRequestHeaders.Add("X-Share-Token", token);
        return client;
    }

    private static async Task<string> Link(Ws ws, Guid page) =>
        (await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { }))).GetProperty("token").GetString()!;

    private static Task<HttpResponseMessage> Search(HttpClient client, Guid workspace, string q, int limit, string? cursor = null) =>
        client.GetAsync($"/api/v1/workspaces/{workspace}/search?q={Uri.EscapeDataString(q)}&limit={limit}"
            + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}"));

    [Fact]
    public async Task A_used_invitation_answers_only_while_its_person_is_still_a_member()
    {
        var ws = await Ws.Create(server);
        var bob = await server.NewAccount();
        var token = await Invite(ws, bob.Email, "admin");
        // The token travels in the body, never in a path a request log keeps.
        Assert.Equal(HttpStatusCode.NotFound, (await bob.Client.PostAsync($"/api/v1/invites/{token}/accept", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Kit.Accept(bob.Client, token)).StatusCode);
        // Again while a member: the same answer, and nothing changes.
        var again = await Kit.Accept(bob.Client, token);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal("admin", (await Kit.Json(again)).GetProperty("role").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{bob.Id}")).StatusCode);
        var back = await Kit.Accept(bob.Client, token);
        Assert.Equal(HttpStatusCode.NotFound, back.StatusCode);
        Assert.Equal("not.found", await Kit.Code(back));
        Assert.Equal(HttpStatusCode.NotFound, (await bob.Client.GetAsync($"/api/v1/workspaces/{ws.Id}")).StatusCode);
    }

    [Fact]
    public async Task Removing_a_member_voids_their_waiting_invitations_and_their_rows()
    {
        var ws = await Ws.Create(server);
        var bob = await Kit.Join(server, ws, "member");
        var plans = (await ws.NewPage("Plans")).GetProperty("id").GetGuid();
        await Kit.Share(ws, plans, true, ("user", bob.Id, "full"));
        var waiting = await Invite(ws, bob.Email, "admin");

        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{bob.Id}")).StatusCode);
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.False(await db.PagePermissions.AnyAsync(r => r.PrincipalId == bob.Id));
            Assert.NotNull((await db.WorkspaceInvites.SingleAsync(i => i.TokenHash == Cgw.Core.Workspaces.WorkspaceService.Hash(waiting))).RevokedAt);
        }
        Assert.Equal(HttpStatusCode.NotFound, (await Kit.Accept(bob.Client, waiting)).StatusCode);
        // Invited back as a guest, they start with nothing.
        await Kit.Join(server, ws, "guest", bob);
        Assert.Equal(HttpStatusCode.NotFound, (await bob.Client.GetAsync($"/api/v1/pages/{plans}/permissions")).StatusCode);
    }

    [Fact]
    public async Task A_share_link_skips_a_page_hidden_from_the_workspace_and_what_is_under_it()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Handbook")).GetProperty("id").GetGuid();
        var chapter = (await ws.NewPage("Chapter", root)).GetProperty("id").GetGuid();
        var board = (await ws.NewPage("Board notes", root, "a5")).GetProperty("id").GetGuid();
        var minutes = (await ws.NewPage("Minutes", board)).GetProperty("id").GetGuid();
        // Everyone: none, without ticking Restricted, as the share dialog allows.
        await Kit.Share(ws, board, false, ("workspace", ws.Id, "none"));

        var reader = Reader(server, await Link(ws, root));
        var tree = await reader.GetFromJsonAsync<JsonElement>("/api/v1/shared");
        Assert.Equal([root, chapter], tree.GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("id").GetGuid()));
        foreach (var hidden in new[] { board, minutes })
            Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/pages/{hidden}/json")).StatusCode);
    }

    [Fact]
    public async Task A_share_link_reads_its_pages_as_the_workers_json()
    {
        var ws = await Ws.Create(server);
        var root = await Kit.PageWithText(server, ws, "Handbook");
        var empty = (await ws.NewPage("Empty", root)).GetProperty("id").GetGuid();
        var fresh = (await ws.NewPage("Fresh", root, "a5")).GetProperty("id").GetGuid();
        await Kit.PushOk(ws.Client, fresh, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        var reader = Reader(server, await Link(ws, root));

        var json = await reader.GetFromJsonAsync<JsonElement>($"/api/v1/shared/pages/{root}/json");
        using (var doc = JsonDocument.Parse(json.GetProperty("json").GetString()!))
        {
            Assert.Equal("doc", doc.RootElement.GetProperty("type").GetString());
            Assert.Contains("Hello world", doc.RootElement.GetRawText());
        }
        // A page never written is an empty document.
        var nothing = await reader.GetFromJsonAsync<JsonElement>($"/api/v1/shared/pages/{empty}/json");
        Assert.Equal("""{"type":"doc","content":[]}""", nothing.GetProperty("json").GetString());
        // Written but not derived yet: 404 until the worker has read it.
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/pages/{fresh}/json")).StatusCode);
        await Kit.Derive(server, ws.Id, fresh);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync($"/api/v1/shared/pages/{fresh}/json")).StatusCode);
        // No Yjs updates by link any more.
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/api/v1/shared/pages/{root}/doc?after=0")).StatusCode);
    }

    [Fact]
    public async Task A_search_cursor_is_sealed_to_its_user_and_workspace()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var pages = new List<Guid>();
        for (var i = 0; i < 4; i++) pages.Add((await ws.NewPage($"Invoice {i}", orderKey: $"a{i}")).GetProperty("id").GetGuid());

        var first = await Kit.Json(await Search(member.Client, ws.Id, "invoice", 2));
        var cursor = first.GetProperty("cursor").GetString()!;
        // Nothing of any page can be read from it.
        var raw = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(cursor));
        Assert.All(pages, p => Assert.DoesNotContain(p.ToString("N"), raw, StringComparison.OrdinalIgnoreCase));

        Assert.Equal(HttpStatusCode.OK, (await Search(member.Client, ws.Id, "invoice", 2, cursor)).StatusCode);
        foreach (var refused in new[]
                 {
                     await Search(ws.Client, ws.Id, "invoice", 2, cursor),
                     await Search(member.Client, (await Ws.Create(server, member)).Id, "invoice", 2, cursor),
                     await Search(member.Client, ws.Id, "invoice", 2, cursor[..^4] + "AAAA"),
                 })
        {
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }
    }

    [Fact]
    public async Task A_guest_sees_only_themselves_and_the_people_named_on_pages_they_see()
    {
        var ws = await Ws.Create(server);
        var named = await Kit.Join(server, ws, "member");
        var unnamed = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var brief = (await ws.NewPage("Brief")).GetProperty("id").GetGuid();
        await Kit.Share(ws, brief, false, ("user", guest.Id, "view"), ("user", named.Id, "edit"));
        var other = (await ws.NewPage("Other", orderKey: "a5")).GetProperty("id").GetGuid();
        await Kit.Share(ws, other, false, ("user", unnamed.Id, "view"));

        var seen = (await guest.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/members"))
            .EnumerateArray().ToDictionary(m => m.GetProperty("userId").GetGuid());
        Assert.Equal(new[] { guest.Id, named.Id }.Order(), seen.Keys.Order());
        Assert.Equal(guest.Email, seen[guest.Id].GetProperty("email").GetString());
        Assert.Equal("", seen[named.Id].GetProperty("email").GetString());
        Assert.Equal("member", seen[named.Id].GetProperty("role").GetString());
        Assert.False(string.IsNullOrEmpty(seen[named.Id].GetProperty("displayName").GetString()));
        // A member sees everyone, with their addresses.
        var all = (await named.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/members")).EnumerateArray().ToList();
        Assert.Equal(4, all.Count);
        Assert.Contains(all, m => m.GetProperty("email").GetString() == unnamed.Email);
    }

    [Fact]
    public async Task A_page_access_list_is_shown_only_to_full_access()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var page = (await ws.NewPage("Budget")).GetProperty("id").GetGuid();
        await Kit.Share(ws, page, false, ("user", guest.Id, "view"), ("workspace", ws.Id, "edit"));

        Assert.Equal(2, (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/permissions")).GetProperty("entries").GetArrayLength());
        foreach (var (client, level) in new[] { (member.Client, "edit"), (guest.Client, "view") })
        {
            var answer = await client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/permissions");
            Assert.Equal(level, answer.GetProperty("yourLevel").GetString());
            Assert.False(answer.GetProperty("restricted").GetBoolean());
            Assert.Empty(answer.GetProperty("entries").EnumerateArray());
        }
    }

    [Fact]
    public async Task A_guest_gets_no_section_without_a_page_they_see_and_no_other_members_id()
    {
        var ws = await Ws.Create(server);
        var guest = await Kit.Join(server, ws, "guest");
        var elsewhere = await TreeAccessTests.Section(ws, ws.Client, "workspace", "Elsewhere");
        await TreeAccessTests.Page(ws, ws.Client, "Not for guests", elsewhere);
        var brief = (await ws.NewPage("Brief")).GetProperty("id").GetGuid();
        await Kit.Share(ws, brief, false, ("user", guest.Id, "view"));

        var tree = await ws.Tree(guest.Client);
        Assert.Equal([ws.Shared], tree.GetProperty("sections").EnumerateArray().Select(s => s.GetProperty("id").GetGuid()));
        var cursor = tree.GetProperty("cursor").GetInt64();
        Assert.Equal("applied", (await TreeAccessTests.Op(ws, ws.Client, ws.Op("section.update", elsewhere, new { name = "Renamed" }))).Status);
        var joiner = await Kit.Join(server, ws, "member");

        var feed = await ws.Changes(cursor, guest.Client);
        var changes = feed.GetProperty("changes").EnumerateArray().ToList();
        Assert.DoesNotContain(changes, c => c.GetProperty("entityType").GetString() == "section" && c.GetProperty("kind").GetString() == "upsert");
        Assert.DoesNotContain(changes, c => c.GetProperty("entityType").GetString() == "member");
        Assert.DoesNotContain(joiner.Id.ToString(), feed.GetRawText(), StringComparison.OrdinalIgnoreCase);
        // The member who joined is told of themselves.
        Assert.Contains((await ws.Changes(cursor, joiner.Client)).GetProperty("changes").EnumerateArray(),
            c => c.GetProperty("entityType").GetString() == "member" && c.GetProperty("entityId").GetGuid() == joiner.Id);
    }

    [Fact]
    public async Task An_export_is_read_only_while_its_requester_is_an_owner_or_admin()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        await ws.NewPage("Everything");
        // Read whatever its state: the job is not run here, as another test runs it for every
        // workspace and two runs of one export collide on its file.
        var id = (await Kit.Json(await admin.Client.PostAsync($"/api/v1/workspaces/{ws.Id}/exports", null))).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await admin.Client.GetAsync($"/api/v1/exports/{id}")).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members/{admin.Id}", new { role = "member" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Client.GetAsync($"/api/v1/exports/{id}")).StatusCode);
    }

    [Fact]
    public async Task The_worker_refuses_an_update_whose_pusher_may_no_longer_edit_the_page()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Draft")).GetProperty("id").GetGuid();
        await Kit.Register(member.Client, ws.Id);
        var update = Guid.CreateVersion7();
        var pushed = await member.Client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch = 0,
            clientSchemaVersion = 1,
            updates = new[] { new { updateId = update, data = Kit.Update("page") } },
        });
        Assert.Equal(HttpStatusCode.OK, pushed.StatusCode);
        // Before the worker decides, the member is cut down to reading.
        await Kit.Share(ws, page, false, ("user", member.Id, "view"));
        await server.RunJob<ValidateJob>();

        var pulled = await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after=0");
        Assert.Empty(pulled.GetProperty("updates").EnumerateArray());
        Assert.Contains(update, pulled.GetProperty("rejected").EnumerateArray().Select(r => r.GetGuid()));
        await using var db = server.NewDb(ws.Id);
        var row = await db.PageDocUpdates.SingleAsync(u => u.UpdateId == update);
        Assert.Equal(UpdateStatus.Rejected, row.Status);
        Assert.StartsWith("access.denied", row.Problem);
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "doc.accessDenied" && a.TargetId == page && a.ActorUserId == member.Id));
    }

    [Fact]
    public async Task A_cover_is_taken_only_from_a_file_its_setter_may_read()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var secret = (await ws.NewPage("Secret")).GetProperty("id").GetGuid();
        await Kit.Share(ws, secret, true);
        var picture = await AssetTests.Upload(ws, AssetTests.Png, "image/png");
        await server.RunJob<AssetCheckJob>();
        Assert.Equal("applied", (await TreeAccessTests.Op(ws, ws.Client, ws.Op("page.update", secret, new { coverAssetId = picture }))).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/assets/{picture}/url")).StatusCode);

        // Knowing the id is not enough: a cover the member cannot read is refused.
        var mine = await TreeAccessTests.Page(ws, member.Client, "Mine", ws.Shared, orderKey: "a5");
        Assert.Equal("access.denied", (await TreeAccessTests.Op(ws, member.Client, ws.Op("page.update", mine, new { coverAssetId = picture }))).Code);
        var id = Guid.CreateVersion7();
        var page = new
        {
            id, workspaceId = ws.Id, sectionId = ws.Shared, parentPageId = (Guid?)null, orderKey = "a7", kind = "page", title = "With a cover",
            coverAssetId = picture,
        };
        Assert.Equal("access.denied", (await TreeAccessTests.Op(ws, member.Client, ws.Op("page.create", id, page))).Code);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/assets/{picture}/url")).StatusCode);

        // Their own upload is theirs to use, and a cover already on a page they edit stays.
        var own = await AssetTests.Upload(ws, AssetTests.Png, "image/png", client: member.Client);
        Assert.Equal("applied", (await TreeAccessTests.Op(ws, member.Client, ws.Op("page.update", mine, new { coverAssetId = own }))).Status);
        Assert.Equal("applied", (await TreeAccessTests.Op(ws, ws.Client, ws.Op("page.update", mine, new { title = "Mine, renamed", coverAssetId = own }))).Status);
    }

    [Fact]
    public async Task Creating_a_workspace_again_answers_only_its_current_members()
    {
        var creator = await server.NewAccount();
        var ws = await Ws.Create(server, creator);
        var heir = await Kit.Join(server, ws, "admin");
        Assert.Equal(HttpStatusCode.OK, (await creator.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members/{heir.Id}", new { role = "owner" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await creator.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{creator.Id}")).StatusCode);

        var again = await creator.Client.PostAsJsonAsync("/api/v1/workspaces", new { id = ws.Id, name = "Test workspace" });
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("conflict", await Kit.Code(again));
        var theirs = await heir.Client.PostAsJsonAsync("/api/v1/workspaces", new { id = ws.Id, name = "Test workspace" });
        Assert.Equal(HttpStatusCode.OK, theirs.StatusCode);
        Assert.Equal("owner", (await Kit.Json(theirs)).GetProperty("role").GetString());
    }

    /// <summary>
    /// Another session holds the workspace's lock (as a role change does) while the deletion runs,
    /// and inside it the other owner steps down. A check made before the lock would pass, and the
    /// workspace would be left with members and no owner.
    /// </summary>
    [Fact]
    public async Task Deleting_an_account_checks_for_the_only_owner_under_the_workspace_lock()
    {
        var leaving = await server.NewAccount();
        var ws = await Ws.Create(server, leaving);
        var other = await Kit.Join(server, ws, "admin");
        await Kit.Join(server, ws, "member");
        Assert.Equal(HttpStatusCode.OK, (await leaving.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members/{other.Id}", new { role = "owner" })).StatusCode);

        await using var connection = new SqlConnection(server.SqlConnection);
        await connection.OpenAsync();
        await using var tx = (SqlTransaction)await connection.BeginTransactionAsync();
        SqlCommand Command(string sql)
        {
            var command = new SqlCommand(sql, connection, tx);
            command.Parameters.Add(new SqlParameter("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(ws.Id) });
            command.Parameters.Add(new SqlParameter("@user", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(other.Id) });
            return command;
        }
        // The workspace row's lock, as every writer takes it: readers pass, writers wait.
        await Command("SELECT ChangeSeq FROM Workspaces WITH (UPDLOCK, ROWLOCK) WHERE Id = @ws").ExecuteScalarAsync();
        var spid = Convert.ToInt32(await Command("SELECT @@SPID").ExecuteScalarAsync());

        var deleting = Task.Run(async () =>
        {
            await using var scope = server.Api.Services.CreateAsyncScope();
            return await scope.ServiceProvider.GetRequiredService<AccountDeletion>().DeleteAsync(leaving.Id, new Actor(leaving.Id, null, null));
        });
        var blocked = await Kit.Eventually(async () =>
        {
            if (deleting.IsCompleted) return -1;
            var count = Command("SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id = @spid");
            count.Parameters.AddWithValue("@spid", spid);
            return Convert.ToInt32(await count.ExecuteScalarAsync());
        }, n => n != 0, TimeSpan.FromSeconds(30));
        Assert.True(blocked > 0, "The deletion did not wait for the workspace's lock");
        await Command("UPDATE WorkspaceMembers SET Role = 'member' WHERE WorkspaceId = @ws AND UserId = @user").ExecuteNonQueryAsync();
        await tx.CommitAsync();

        var result = await deleting;
        Assert.False(result.Ok);
        Assert.Equal("conflict", result.Failure!.Code);
        await using var db = server.NewDb(ws.Id);
        Assert.True(await db.WorkspaceMembers.AnyAsync(m => m.UserId == leaving.Id && m.Role == Roles.Owner));
        Assert.Null((await db.Users.AsNoTracking().SingleAsync(u => u.Id == leaving.Id)).DeletedAt);
    }
}
