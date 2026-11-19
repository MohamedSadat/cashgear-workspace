using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>Steps the group tests share (Phase 11).</summary>
public static class GroupKit
{
    public static string Url(Guid workspace) => $"/api/v1/workspaces/{workspace}/groups";

    public static Task<HttpResponseMessage> Create(HttpClient client, Guid workspace, string name, params Guid[] people) =>
        client.PostAsJsonAsync(Url(workspace), new { name, people });

    public static async Task<JsonElement> CreateOk(HttpClient client, Guid workspace, string name, params Guid[] people)
    {
        var response = await Create(client, workspace, name, people);
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    public static async Task<Guid> New(Ws ws, string name, params Guid[] people) => (await CreateOk(ws.Client, ws.Id, name, people)).GetProperty("id").GetGuid();

    public static Task<HttpResponseMessage> SetPeople(HttpClient client, Guid workspace, Guid group, IEnumerable<Guid> people, string? ifMatch = null) =>
        Send(client, HttpMethod.Put, $"{Url(workspace)}/{group}/people", new { people }, ifMatch);

    public static Task<HttpResponseMessage> Rename(HttpClient client, Guid workspace, Guid group, string? name, string? ifMatch = null) =>
        Send(client, HttpMethod.Patch, $"{Url(workspace)}/{group}", new { name }, ifMatch);

    private static Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string url, object body, string? ifMatch)
    {
        var request = new HttpRequestMessage(method, url) { Content = JsonContent.Create(body) };
        if (ifMatch is not null) request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        return client.SendAsync(request);
    }

    /// <summary>The permissions PUT body of a client that knows groups.</summary>
    public static object Entries(bool restricted, params (string Type, Guid Id, string Level)[] entries) => new
    {
        restricted,
        entries = entries.Select(e => new { principalType = e.Type, principalId = e.Id, level = e.Level }).ToArray(),
        principals = new[] { "group" },
    };

    public static async Task Share(Ws ws, Guid page, bool restricted, params (string Type, Guid Id, string Level)[] entries)
    {
        var response = await ws.Client.PutAsJsonAsync($"/api/v1/pages/{page}/permissions", Entries(restricted, entries));
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    /// <summary>The access changes targeted at the caller (naming the workspace) after a cursor, with their kinds.</summary>
    public static async Task<List<string>> AccessToMe(Ws ws, HttpClient client, long after) =>
        (await ws.Changes(after, client)).GetProperty("changes").EnumerateArray()
            .Where(c => c.GetProperty("entityType").GetString() == "access" && c.GetProperty("entityId").GetGuid() == ws.Id)
            .Select(c => c.GetProperty("kind").GetString()!).ToList();

    public static async Task<long> Cursor(Ws ws) => (await ws.Tree()).GetProperty("cursor").GetInt64();
}

/// <summary>
/// Phase 11, M11.1: a workspace's groups through their routes. Who may read and change them, each
/// refusal, the feed's change for everyone whose groups change, the audit, and a group left when
/// its person leaves the workspace, is made a guest or deletes their account, or the workspace goes.
/// </summary>
public sealed class GroupTests(ServerFixture server)
{
    private static async Task<(HttpStatusCode Status, string? Code)> Answer(Task<HttpResponseMessage> sent)
    {
        var response = await sent;
        return (response.StatusCode, await Kit.Code(response));
    }

    private static List<string> Names(JsonElement group) =>
        group.GetProperty("people").EnumerateArray().Select(p => p.GetProperty("displayName").GetString()!).ToList();

    [Fact]
    public async Task Owners_and_admins_manage_groups_members_read_them_and_guests_see_none()
    {
        var owner = await server.NewAccount("Olive Owner");
        var ws = await Ws.Create(server, owner);
        var admin = await Kit.Join(server, ws, "admin", await server.NewAccount("Ada Admin"));
        var member = await Kit.Join(server, ws, "member", await server.NewAccount("Mo Member"));
        var guest = await Kit.Join(server, ws, "guest");
        var stranger = await server.NewAccount();

        // Only owners and admins make one.
        Assert.Equal((HttpStatusCode.Forbidden, "access.denied"), await Answer(GroupKit.Create(member.Client, ws.Id, "Mine")));
        Assert.Equal((HttpStatusCode.Forbidden, "access.denied"), await Answer(GroupKit.Create(guest.Client, ws.Id, "Mine")));
        var made = await GroupKit.Create(ws.Client, ws.Id, "Sales", member.Id, admin.Id);
        Assert.Equal(HttpStatusCode.Created, made.StatusCode);
        Assert.Equal("\"1\"", made.Headers.ETag?.Tag);
        var sales = await Kit.Json(made);
        var salesId = sales.GetProperty("id").GetGuid();
        Assert.Equal("Sales", sales.GetProperty("name").GetString());
        Assert.Equal(1, sales.GetProperty("version").GetInt64());
        Assert.Equal(["Ada Admin", "Mo Member"], Names(sales));
        Assert.Equal(member.Email, sales.GetProperty("people").EnumerateArray().Single(p => p.GetProperty("userId").GetGuid() == member.Id).GetProperty("email").GetString());
        var support = (await GroupKit.CreateOk(admin.Client, ws.Id, "  Support  ")).GetProperty("id").GetGuid();

        // Members read them, by name, with who is in them; guests see none.
        var listed = await member.Client.GetFromJsonAsync<JsonElement>(GroupKit.Url(ws.Id));
        var groups = listed.GetProperty("groups").EnumerateArray().ToList();
        Assert.Equal(["Sales", "Support"], groups.Select(g => g.GetProperty("name").GetString()));
        Assert.Empty(groups[1].GetProperty("people").EnumerateArray());
        Assert.Equal((HttpStatusCode.Forbidden, "access.denied"), await Answer(guest.Client.GetAsync(GroupKit.Url(ws.Id))));
        // Not in the workspace: the workspace is not there.
        Assert.Equal((HttpStatusCode.NotFound, "not.found"), await Answer(stranger.Client.GetAsync(GroupKit.Url(ws.Id))));

        // Renamed with the version it was read at; a stale or malformed one is refused.
        var renamed = await GroupKit.Rename(ws.Client, ws.Id, salesId, "Sales team", "\"1\"");
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal("\"2\"", renamed.Headers.ETag?.Tag);
        Assert.Equal("Sales team", (await Kit.Json(renamed)).GetProperty("name").GetString());
        Assert.Equal((HttpStatusCode.Conflict, "version.conflict"), await Answer(GroupKit.Rename(ws.Client, ws.Id, salesId, "Sellers", "\"1\"")));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.Rename(ws.Client, ws.Id, salesId, "Sellers", "\"two\"")));
        Assert.Equal((HttpStatusCode.Forbidden, "access.denied"), await Answer(GroupKit.Rename(member.Client, ws.Id, salesId, "Mine")));
        // A name another group has, as search reads names, is taken; so is a name of nothing or of 101 characters.
        Assert.Equal((HttpStatusCode.Conflict, "conflict"), await Answer(GroupKit.Rename(ws.Client, ws.Id, support, " SALES-team! ")));
        Assert.Equal((HttpStatusCode.Conflict, "conflict"), await Answer(GroupKit.Create(ws.Client, ws.Id, "sales TEAM")));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.Create(ws.Client, ws.Id, "   ")));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.Create(ws.Client, ws.Id, new string('x', 101))));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.Rename(ws.Client, ws.Id, salesId, "")));
        Assert.Equal(HttpStatusCode.Created, (await GroupKit.Create(ws.Client, ws.Id, new string('x', 100))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await GroupKit.Create(ws.Client, ws.Id, "مبيعات")).StatusCode);
        Assert.Equal((HttpStatusCode.Conflict, "conflict"), await Answer(GroupKit.Create(ws.Client, ws.Id, "مَبيعات")));

        // Its people: members, admins and owners of the workspace, never a guest; the whole list at once.
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.SetPeople(ws.Client, ws.Id, salesId, [member.Id, guest.Id])));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.SetPeople(ws.Client, ws.Id, salesId, [stranger.Id])));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.SetPeople(ws.Client, ws.Id, salesId, Enumerable.Range(0, 5001).Select(_ => Guid.NewGuid()))));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.Create(ws.Client, ws.Id, "Big", [.. Enumerable.Range(0, 5001).Select(_ => Guid.NewGuid())])));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.Create(ws.Client, ws.Id, "With a guest", guest.Id)));
        Assert.Equal((HttpStatusCode.Forbidden, "access.denied"), await Answer(GroupKit.SetPeople(member.Client, ws.Id, salesId, [member.Id])));
        Assert.Equal((HttpStatusCode.Conflict, "version.conflict"), await Answer(GroupKit.SetPeople(ws.Client, ws.Id, salesId, [member.Id], "\"1\"")));
        var set = await GroupKit.SetPeople(ws.Client, ws.Id, salesId, [member.Id, owner.Id, member.Id], "\"2\"");
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        var after = await Kit.Json(set);
        Assert.Equal(3, after.GetProperty("version").GetInt64());
        Assert.Equal(["Mo Member", "Olive Owner"], Names(after));
        // The same list again changes nothing.
        Assert.Equal(3, (await Kit.Json(await GroupKit.SetPeople(ws.Client, ws.Id, salesId, [owner.Id, member.Id]))).GetProperty("version").GetInt64());

        // A group that is not there, or another workspace's.
        var unknown = Guid.CreateVersion7();
        var elsewhere = await Ws.Create(server, owner);
        var theirs = await GroupKit.New(elsewhere, "Elsewhere");
        foreach (var id in new[] { unknown, theirs })
        {
            Assert.Equal((HttpStatusCode.NotFound, "not.found"), await Answer(GroupKit.Rename(ws.Client, ws.Id, id, "Lost")));
            Assert.Equal((HttpStatusCode.NotFound, "not.found"), await Answer(GroupKit.SetPeople(ws.Client, ws.Id, id, [])));
            Assert.Equal((HttpStatusCode.NotFound, "not.found"), await Answer(ws.Client.DeleteAsync($"{GroupKit.Url(ws.Id)}/{id}")));
        }

        // Deleted by an owner or admin, for good.
        Assert.Equal((HttpStatusCode.Forbidden, "access.denied"), await Answer(member.Client.DeleteAsync($"{GroupKit.Url(ws.Id)}/{support}")));
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Client.DeleteAsync($"{GroupKit.Url(ws.Id)}/{support}")).StatusCode);
        Assert.Equal((HttpStatusCode.NotFound, "not.found"), await Answer(admin.Client.DeleteAsync($"{GroupKit.Url(ws.Id)}/{support}")));
        Assert.DoesNotContain((await ws.Client.GetFromJsonAsync<JsonElement>(GroupKit.Url(ws.Id))).GetProperty("groups").EnumerateArray(),
            g => g.GetProperty("id").GetGuid() == support);
        // A name freed by a deletion can be used again.
        Assert.Equal(HttpStatusCode.Created, (await GroupKit.Create(ws.Client, ws.Id, "Support")).StatusCode);
    }

    [Fact]
    public async Task A_workspace_has_at_most_200_groups()
    {
        var ws = await Ws.Create(server);
        await using (var db = server.NewDb(ws.Id))
        {
            var now = DateTimeOffset.UtcNow;
            for (var i = 0; i < 199; i++)
                db.WorkspaceGroups.Add(new WorkspaceGroup
                {
                    Id = Guid.CreateVersion7(), WorkspaceId = ws.Id, Name = $"Group {i}", SearchName = $"group {i}",
                    CreatedBy = ws.Account.Id, CreatedAt = now, UpdatedBy = ws.Account.Id, UpdatedAt = now,
                });
            await db.SaveChangesAsync();
        }
        var last = await GroupKit.New(ws, "The 200th");
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.Create(ws.Client, ws.Id, "One too many")));
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"{GroupKit.Url(ws.Id)}/{last}")).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await GroupKit.Create(ws.Client, ws.Id, "One too many")).StatusCode);
    }

    [Fact]
    public async Task Everyone_whose_groups_change_is_told_in_the_feed_and_every_change_is_audited()
    {
        var ws = await Ws.Create(server);
        var a = await Kit.Join(server, ws, "member");
        var b = await Kit.Join(server, ws, "member");
        var c = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Pipeline")).GetProperty("id").GetGuid();

        // Made with a in it: a is told (nothing to lose yet: a grant), the others are not.
        var cursor = await GroupKit.Cursor(ws);
        var group = await GroupKit.New(ws, "Sales", a.Id);
        Assert.Equal(["grant"], await GroupKit.AccessToMe(ws, a.Client, cursor));
        Assert.Empty(await GroupKit.AccessToMe(ws, b.Client, cursor));

        // Its people changed: who left and who joined are told; who stayed out is not.
        cursor = await GroupKit.Cursor(ws);
        Assert.Equal(HttpStatusCode.OK, (await GroupKit.SetPeople(ws.Client, ws.Id, group, [b.Id])).StatusCode);
        Assert.Equal(["grant"], await GroupKit.AccessToMe(ws, a.Client, cursor));
        Assert.Equal(["grant"], await GroupKit.AccessToMe(ws, b.Client, cursor));
        Assert.Empty(await GroupKit.AccessToMe(ws, c.Client, cursor));
        // Once the group holds a row, a change of its people can take access away: a revoke.
        await GroupKit.Share(ws, page, true, ("group", group, "edit"));
        cursor = await GroupKit.Cursor(ws);
        Assert.Equal(HttpStatusCode.OK, (await GroupKit.SetPeople(ws.Client, ws.Id, group, [b.Id, c.Id])).StatusCode);
        Assert.Equal(["revoke"], await GroupKit.AccessToMe(ws, c.Client, cursor));
        Assert.Empty(await GroupKit.AccessToMe(ws, b.Client, cursor));
        // A rename changes no one's access.
        cursor = await GroupKit.Cursor(ws);
        Assert.Equal(HttpStatusCode.OK, (await GroupKit.Rename(ws.Client, ws.Id, group, "Sales team")).StatusCode);
        Assert.Equal(cursor, await GroupKit.Cursor(ws));

        // Deleted: its people are told, and its rows go.
        Assert.Equal("edit", await TreeAccessTests.Level(c.Client, page));
        Assert.Equal("none", await TreeAccessTests.Level(a.Client, page));
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"{GroupKit.Url(ws.Id)}/{group}")).StatusCode);
        Assert.Equal(["revoke"], await GroupKit.AccessToMe(ws, b.Client, cursor));
        Assert.Equal(["revoke"], await GroupKit.AccessToMe(ws, c.Client, cursor));
        Assert.Equal("none", await TreeAccessTests.Level(c.Client, page));
        await using var db = server.NewDb(ws.Id);
        Assert.False(await db.PagePermissions.AnyAsync(r => r.PrincipalId == group));
        Assert.False(await db.WorkspaceGroupMembers.AnyAsync(m => m.GroupId == group));

        var audit = await db.AuditLog.Where(e => e.TargetId == group).OrderBy(e => e.CreatedAt).ToListAsync();
        Assert.Equal(["group.create", "group.people", "group.people", "group.rename", "group.delete"], audit.Select(e => e.Action));
        Assert.Contains(a.Id.ToString(), audit[0].Detail, StringComparison.Ordinal);
        var people = JsonDocument.Parse(audit[1].Detail!).RootElement;
        Assert.Equal([b.Id], people.GetProperty("added").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Equal([a.Id], people.GetProperty("removed").EnumerateArray().Select(x => x.GetGuid()));
        Assert.Contains("Sales team", audit[3].Detail, StringComparison.Ordinal);
        Assert.Equal(1, JsonDocument.Parse(audit[4].Detail!).RootElement.GetProperty("pages").GetInt32());
        Assert.All(audit, e => Assert.Equal(ws.Account.Id, e.ActorUserId));
    }

    [Fact]
    public async Task Someone_removed_from_the_workspace_or_made_a_guest_leaves_every_group()
    {
        var ws = await Ws.Create(server);
        var a = await Kit.Join(server, ws, "member");
        var b = await Kit.Join(server, ws, "member");
        var sales = await GroupKit.New(ws, "Sales", a.Id, b.Id);
        var support = await GroupKit.New(ws, "Support", a.Id);
        var page = (await ws.NewPage("Sales only")).GetProperty("id").GetGuid();
        await GroupKit.Share(ws, page, true, ("group", sales, "edit"));
        Assert.Equal("edit", await TreeAccessTests.Level(a.Client, page));

        // Made a guest: out of both groups (their versions rise), and the page goes with them.
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members/{a.Id}", new { role = "guest" })).StatusCode);
        var groups = (await ws.Client.GetFromJsonAsync<JsonElement>(GroupKit.Url(ws.Id))).GetProperty("groups").EnumerateArray()
            .ToDictionary(g => g.GetProperty("id").GetGuid());
        Assert.DoesNotContain(a.Id, groups[sales].GetProperty("people").EnumerateArray().Select(p => p.GetProperty("userId").GetGuid()));
        Assert.Empty(groups[support].GetProperty("people").EnumerateArray());
        Assert.Equal(2, groups[sales].GetProperty("version").GetInt64());
        Assert.Equal("none", await TreeAccessTests.Level(a.Client, page));
        // A guest joins none; made a member again, they are in none until added.
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Answer(GroupKit.SetPeople(ws.Client, ws.Id, support, [a.Id])));
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members/{a.Id}", new { role = "member" })).StatusCode);
        Assert.Equal("none", await TreeAccessTests.Level(a.Client, page));

        // Removed from the workspace: out of every group too.
        Assert.Equal("edit", await TreeAccessTests.Level(b.Client, page));
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{b.Id}")).StatusCode);
        await using var db = server.NewDb(ws.Id);
        Assert.False(await db.WorkspaceGroupMembers.AnyAsync(m => m.UserId == b.Id || m.UserId == a.Id));
        var made = await db.AuditLog.Where(e => e.Action == "member.role" && e.TargetId == a.Id).OrderBy(e => e.CreatedAt).FirstAsync();
        Assert.Contains(sales.ToString(), made.Detail, StringComparison.Ordinal);
        Assert.Contains(support.ToString(), made.Detail, StringComparison.Ordinal);
        Assert.Contains(sales.ToString(), (await db.AuditLog.SingleAsync(e => e.Action == "member.remove" && e.TargetId == b.Id)).Detail, StringComparison.Ordinal);
        // Invited again, nothing waits for them.
        var back = await Kit.Join(server, ws, "member", b);
        Assert.Equal("none", await TreeAccessTests.Level(back.Client, page));
    }

    [Fact]
    public async Task Account_deletion_and_the_workspace_purge_take_groups_with_them()
    {
        var leaving = await server.NewAccount("Leaving");
        var colleague = await server.NewAccount("Colleague");
        var theirs = await Ws.Create(server, colleague);
        await Kit.Join(server, theirs, "member", leaving);
        var group = await GroupKit.New(theirs, "Team", leaving.Id, colleague.Id);
        var deleted = await ServerFixture.OpenAndSubmit(leaving.Client, "/account/delete", "/account/delete", ("Password", leaving.Password));
        Assert.Contains("Your account is deleted", await deleted.Content.ReadAsStringAsync());
        var team = (await colleague.Client.GetFromJsonAsync<JsonElement>(GroupKit.Url(theirs.Id))).GetProperty("groups").EnumerateArray().Single(g => g.GetProperty("id").GetGuid() == group);
        Assert.Equal([colleague.Id], team.GetProperty("people").EnumerateArray().Select(p => p.GetProperty("userId").GetGuid()));
        Assert.Equal(2, team.GetProperty("version").GetInt64());

        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var gone = await GroupKit.New(ws, "Gone", member.Id);
        var page = (await ws.NewPage("Theirs")).GetProperty("id").GetGuid();
        await GroupKit.Share(ws, page, true, ("group", gone, "view"));
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}")).StatusCode);
        await using (var db = server.NewDb())
            await db.Workspaces.Where(w => w.Id == ws.Id).ExecuteUpdateAsync(s => s.SetProperty(w => w.DeletedAt, DateTimeOffset.UtcNow.AddDays(-31)));
        await server.RunJob<WorkspacePurgeJob>();
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.False(await db.Workspaces.AnyAsync(w => w.Id == ws.Id));
            Assert.Equal(0, await db.WorkspaceGroups.CountAsync());
            Assert.Equal(0, await db.WorkspaceGroupMembers.CountAsync());
            Assert.Equal(0, await db.PagePermissions.CountAsync());
        }
    }

    [Fact]
    public async Task A_page_restricted_to_a_group_is_its_peoples_at_the_groups_level_until_they_leave_it()
    {
        var ws = await Ws.Create(server);
        var a = await Kit.Join(server, ws, "member");
        var b = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var sales = await GroupKit.New(ws, "Sales", a.Id);
        var leads = await GroupKit.New(ws, "Leads", a.Id);
        var page = await Kit.PageWithText(server, ws, "Forecast");
        await Kit.Register(a.Client, ws.Id, 7_100_001);
        await Kit.Register(b.Client, ws.Id, 7_100_002);
        await GroupKit.Share(ws, page, true, ("group", sales, "view"));

        // At the group's level, through every route: the list, a pull, a push, the tree.
        Assert.Equal("view", await TreeAccessTests.Level(a.Client, page));
        Assert.Equal(HttpStatusCode.OK, (await a.Client.GetAsync($"/api/v1/pages/{page}/doc?after=0")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Kit.Push(a.Client, page, Kit.Update("page"))).StatusCode);
        Assert.Contains((await ws.Tree(a.Client)).GetProperty("pages").EnumerateArray(), p => p.GetProperty("id").GetGuid() == page && p.GetProperty("access").GetString() == "view");
        foreach (var other in new[] { b, guest })
        {
            Assert.Equal("none", await TreeAccessTests.Level(other.Client, page));
            Assert.Equal(HttpStatusCode.NotFound, (await Kit.Push(other.Client, page, Kit.Update("page"))).StatusCode);
            Assert.DoesNotContain((await ws.Tree(other.Client)).GetProperty("pages").EnumerateArray(), p => p.GetProperty("id").GetGuid() == page);
        }
        // The highest of their groups' rows; their own row over both.
        await GroupKit.Share(ws, page, true, ("group", sales, "view"), ("group", leads, "edit"));
        Assert.Equal("edit", await TreeAccessTests.Level(a.Client, page));
        await Kit.PushOk(a.Client, page, Kit.Update("page"));
        await GroupKit.Share(ws, page, true, ("group", sales, "view"), ("group", leads, "edit"), ("user", a.Id, "comment"));
        Assert.Equal("comment", await TreeAccessTests.Level(a.Client, page));
        await GroupKit.Share(ws, page, true, ("group", sales, "view"), ("group", leads, "edit"));

        // Out of one group: the other's row decides; out of both, the page is gone.
        Assert.Equal(HttpStatusCode.OK, (await GroupKit.SetPeople(ws.Client, ws.Id, leads, [])).StatusCode);
        Assert.Equal("view", await TreeAccessTests.Level(a.Client, page));
        var cursor = await GroupKit.Cursor(ws);
        Assert.Equal(HttpStatusCode.OK, (await GroupKit.SetPeople(ws.Client, ws.Id, sales, [b.Id])).StatusCode);
        Assert.Equal("none", await TreeAccessTests.Level(a.Client, page));
        Assert.Equal(["revoke"], await GroupKit.AccessToMe(ws, a.Client, cursor));
        Assert.Equal("view", await TreeAccessTests.Level(b.Client, page));
        // The group deleted: so is its row, and what it gave.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"{GroupKit.Url(ws.Id)}/{sales}")).StatusCode);
        Assert.Equal("none", await TreeAccessTests.Level(b.Client, page));
        Assert.Equal([leads], (await Kit.Json(await ws.Client.GetAsync($"/api/v1/pages/{page}/permissions?principals=group"))).GetProperty("entries")
            .EnumerateArray().Select(e => e.GetProperty("principalId").GetGuid()));
    }
}
