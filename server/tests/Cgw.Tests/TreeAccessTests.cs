using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cgw.Tests;

/// <summary>
/// The M2.6 review's tree findings: moving, restoring, creating and deleting never change who may
/// see a page behind anyone's back, and a page the caller may not see is not found before anything
/// else is said about it.
/// </summary>
public sealed class TreeAccessTests(ServerFixture server)
{
    public sealed record OpAnswer(string Status, string? Code, JsonElement Result);

    public static async Task<OpAnswer> Op(Ws ws, HttpClient client, JsonObject op)
    {
        var result = (await ws.Push(client, op))[0];
        var status = result.GetProperty("status").GetString()!;
        return new OpAnswer(status, status == "applied" ? null : result.GetProperty("error").GetProperty("code").GetString(), result);
    }

    /// <summary>The caller's level on a page, "none" when it is not found.</summary>
    public static async Task<string> Level(HttpClient client, Guid page)
    {
        var response = await client.GetAsync($"/api/v1/pages/{page}/permissions");
        if (response.StatusCode == HttpStatusCode.NotFound) return "none";
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await Kit.Json(response)).GetProperty("yourLevel").GetString()!;
    }

    public static async Task<Guid> Section(Ws ws, HttpClient client, string visibility, string name)
    {
        var id = Guid.CreateVersion7();
        var answer = await Op(ws, client, ws.Op("section.create", id,
            new { id, workspaceId = ws.Id, name, orderKey = "a5", visibility, version = 1, createdAt = DateTimeOffset.UtcNow }));
        Assert.Equal("applied", answer.Status);
        return id;
    }

    public static async Task<Guid> Page(Ws ws, HttpClient client, string title, Guid section, Guid? parent = null, string orderKey = "a0")
    {
        var id = Guid.CreateVersion7();
        var answer = await Op(ws, client, ws.Op("page.create", id, Ws.Page(id, ws.Id, section, parent, orderKey, title)));
        Assert.True(answer.Status == "applied", answer.Result.ToString());
        return id;
    }

    public static object Move(Guid section, Guid? parent, string orderKey = "a0") => new { sectionId = section, parentPageId = parent, orderKey };

    public static List<Guid> AccessRoots(JsonElement feed) =>
        feed.GetProperty("changes").EnumerateArray()
            .Where(c => c.GetProperty("entityType").GetString() == "access")
            .Select(c => c.GetProperty("entityId").GetGuid()).ToList();

    [Fact]
    public async Task A_move_between_a_shared_and_a_private_section_needs_full_access_to_the_whole_subtree()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var mine = await Section(ws, member.Client, "private", "Mine");
        var hr = await Page(ws, ws.Client, "HR", ws.Shared);
        var salaries = await Page(ws, ws.Client, "Salaries", ws.Shared, hr);
        await Kit.Share(ws, salaries, true);
        Assert.Equal("edit", await Level(member.Client, hr));
        Assert.Equal("none", await Level(member.Client, salaries));

        // Taken into the member's private section, the restricted page would be theirs alone.
        var taken = await Op(ws, member.Client, ws.Op("page.move", hr, Move(mine, null)));
        Assert.Equal("access.denied", taken.Code);
        Assert.Equal("full", await Level(ws.Client, salaries));
        Assert.Equal("edit", await Level(member.Client, hr));
        // A page they edit in a shared section is not theirs to take private either.
        var notes = await Page(ws, member.Client, "Notes", ws.Shared, orderKey: "a5");
        Assert.Equal("access.denied", (await Op(ws, member.Client, ws.Op("page.move", notes, Move(mine, null)))).Code);

        // A private page is its owner's: into a shared section it goes, with what is under it.
        var draft = await Page(ws, member.Client, "Draft", mine);
        var under = await Page(ws, member.Client, "Under the draft", mine, draft);
        Assert.Equal("applied", (await Op(ws, member.Client, ws.Op("page.move", draft, Move(ws.Shared, null, "a7")))).Status);
        Assert.Equal("full", await Level(ws.Client, under));
        // And an owner, who holds every shared page, may take a subtree private.
        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.move", hr, Move(ws.Personal, null)))).Status);
        Assert.Equal("none", await Level(member.Client, hr));
        Assert.Contains(hr, AccessRoots(await ws.Changes(cursor, member.Client)));
    }

    [Fact]
    public async Task A_page_moved_out_from_under_a_restricted_page_keeps_who_may_see_it()
    {
        var ws = await Ws.Create(server);
        var editor = await Kit.Join(server, ws, "member");
        var other = await Kit.Join(server, ws, "member");
        var hr = await Page(ws, ws.Client, "HR", ws.Shared);
        await Kit.Share(ws, hr, true, ("user", editor.Id, "edit"));
        var salaries = await Page(ws, ws.Client, "Salaries", ws.Shared, hr);
        var payslips = await Page(ws, ws.Client, "Payslips", ws.Shared, salaries);
        var open = await Page(ws, ws.Client, "Open", ws.Shared, orderKey: "a5");
        Assert.Equal("edit", await Level(editor.Client, salaries));
        Assert.Equal("none", await Level(other.Client, salaries));

        // An editor may not take it from under the page that decides who sees it: not to the top,
        // not under an open page.
        Assert.Equal("access.denied", (await Op(ws, editor.Client, ws.Op("page.move", salaries, Move(ws.Shared, null, "a9")))).Code);
        Assert.Equal("access.denied", (await Op(ws, editor.Client, ws.Op("page.move", salaries, Move(ws.Shared, open)))).Code);
        Assert.Equal("none", await Level(other.Client, salaries));

        // Full access may, and the page keeps its access: restricted, with the rows it had.
        var cursor = (await ws.Tree(other.Client)).GetProperty("cursor").GetInt64();
        var moved = await Op(ws, ws.Client, ws.Op("page.move", salaries, Move(ws.Shared, open)));
        Assert.Equal("applied", moved.Status);
        Assert.True(moved.Result.GetProperty("entity").GetProperty("page").GetProperty("restricted").GetBoolean());
        Assert.Equal("edit", await Level(editor.Client, salaries));
        Assert.Equal("none", await Level(other.Client, salaries));
        Assert.Equal("none", await Level(other.Client, payslips));
        Assert.Equal("edit", await Level(other.Client, open));
        var listed = (await Kit.Json(await ws.Client.GetAsync($"/api/v1/pages/{salaries}/permissions"))).GetProperty("entries").EnumerateArray()
            .Select(e => (e.GetProperty("principalType").GetString(), e.GetProperty("principalId").GetGuid(), e.GetProperty("level").GetString())).ToList();
        Assert.Equal([("user", editor.Id, "edit")], listed);
        // The feed names the subtree, so clients fetch it again.
        Assert.Contains(salaries, AccessRoots(await ws.Changes(cursor, other.Client)));

        // A page open to the workspace keeps that too when it moves under a restricted page.
        var memo = await Page(ws, ws.Client, "Memo", ws.Shared, orderKey: "a8");
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.move", memo, Move(ws.Shared, hr)))).Status);
        Assert.Equal("edit", await Level(other.Client, memo));
    }

    [Fact]
    public async Task A_page_restored_after_its_restricted_parent_was_binned_stays_restricted()
    {
        var ws = await Ws.Create(server);
        var editor = await Kit.Join(server, ws, "member");
        var other = await Kit.Join(server, ws, "member");
        var hr = await Page(ws, ws.Client, "HR", ws.Shared);
        await Kit.Share(ws, hr, true, ("user", editor.Id, "edit"));
        var salaries = await Page(ws, ws.Client, "Salaries", ws.Shared, hr);
        Assert.Equal("applied", (await Op(ws, editor.Client, ws.Op("page.trash", salaries, new { }))).Status);
        Assert.Equal("applied", (await Op(ws, editor.Client, ws.Op("page.trash", hr, new { }))).Status);

        var cursor = (await ws.Tree(other.Client)).GetProperty("cursor").GetInt64();
        var restored = await Op(ws, editor.Client, ws.Op("page.restore", salaries, new { }));
        Assert.Equal("applied", restored.Status);
        var page = restored.Result.GetProperty("entity").GetProperty("page");
        Assert.Equal(JsonValueKind.Null, page.GetProperty("parentPageId").ValueKind);
        Assert.True(page.GetProperty("restricted").GetBoolean());
        Assert.Equal("edit", await Level(editor.Client, salaries));
        Assert.Equal("none", await Level(other.Client, salaries));
        Assert.Contains(salaries, AccessRoots(await ws.Changes(cursor, other.Client)));
    }

    [Fact]
    public async Task A_page_made_under_a_binned_restricted_parent_stays_restricted()
    {
        var ws = await Ws.Create(server);
        var editor = await Kit.Join(server, ws, "member");
        var other = await Kit.Join(server, ws, "member");
        var hr = await Page(ws, ws.Client, "HR", ws.Shared);
        await Kit.Share(ws, hr, true, ("user", editor.Id, "edit"));
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.trash", hr, new { }))).Status);

        // Made offline under HR, which was binned meanwhile.
        var id = Guid.CreateVersion7();
        var made = await Op(ws, editor.Client, ws.Op("page.create", id, Ws.Page(id, ws.Id, ws.Shared, hr, "a0", "Offline salaries")));
        Assert.Equal("applied", made.Status);
        Assert.Equal("tree.parentMissing", made.Result.GetProperty("notice").GetString());
        Assert.True(made.Result.GetProperty("entity").GetProperty("page").GetProperty("restricted").GetBoolean());
        Assert.Equal("edit", await Level(editor.Client, id));
        Assert.Equal("full", await Level(ws.Client, id));
        Assert.Equal("none", await Level(other.Client, id));

        // A parent there is no trace of leaves the page to its maker alone.
        var stray = Guid.CreateVersion7();
        var lost = await Op(ws, editor.Client, ws.Op("page.create", stray, Ws.Page(stray, ws.Id, ws.Shared, Guid.CreateVersion7(), "a0", "Under nothing")));
        Assert.Equal("applied", lost.Status);
        Assert.Equal("tree.parentMissing", lost.Result.GetProperty("notice").GetString());
        Assert.Equal("full", await Level(editor.Client, stray));
        Assert.Equal("none", await Level(other.Client, stray));
    }

    [Fact]
    public async Task Moving_a_page_with_pages_under_it_tells_clients_to_fetch_the_subtree_again()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var folder = await Page(ws, ws.Client, "Folder", ws.Shared);
        await Page(ws, ws.Client, "In the folder", ws.Shared, folder);
        var shelf = await Page(ws, ws.Client, "Shelf", ws.Shared, orderKey: "a5");
        var leaf = await Page(ws, ws.Client, "Leaf", ws.Shared, orderKey: "a7");

        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.move", folder, Move(ws.Shared, shelf)))).Status);
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.move", leaf, Move(ws.Shared, shelf, "a5")))).Status);
        var roots = AccessRoots(await ws.Changes(cursor, member.Client));
        Assert.Contains(folder, roots);
        // A page with nothing under it is all in its own change.
        Assert.DoesNotContain(leaf, roots);
    }

    [Fact]
    public async Task Deleting_for_good_needs_full_access_to_every_page_of_the_subtree()
    {
        var ws = await Ws.Create(server);
        var holder = await Kit.Join(server, ws, "member");
        var folder = await Page(ws, ws.Client, "Folder", ws.Shared);
        await Kit.Share(ws, folder, false, ("user", holder.Id, "full"));
        var secret = await Page(ws, ws.Client, "Secret", ws.Shared, folder);
        await Kit.Share(ws, secret, true);
        Assert.Equal("full", await Level(holder.Client, folder));
        Assert.Equal("none", await Level(holder.Client, secret));

        // The bin can be undone, so editing is enough for it; deleting for good is not.
        Assert.Equal("applied", (await Op(ws, holder.Client, ws.Op("page.trash", folder, new { }))).Status);
        Assert.Equal("access.denied", (await Op(ws, holder.Client, ws.Op("page.delete", folder, new { }))).Code);
        Assert.Equal("full", await Level(ws.Client, secret));
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.delete", folder, new { }))).Status);
        Assert.Equal(HttpStatusCode.Gone, (await ws.Client.GetAsync($"/api/v1/pages/{secret}/permissions")).StatusCode);
    }

    [Fact]
    public async Task A_page_the_caller_may_not_see_is_not_found_before_anything_else()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var mine = await Section(ws, member.Client, "private", "Mine");

        // Deleted for good: 410 to who could read it, 404 to who never could.
        var gone = await Page(ws, ws.Client, "Gone", ws.Shared);
        await Kit.Share(ws, gone, true);
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.trash", gone, new { }))).Status);
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.delete", gone, new { }))).Status);
        Assert.Equal(HttpStatusCode.Gone, (await ws.Client.GetAsync($"/api/v1/pages/{gone}/doc")).StatusCode);
        var unseen = await member.Client.GetAsync($"/api/v1/pages/{gone}/doc");
        Assert.Equal(HttpStatusCode.NotFound, unseen.StatusCode);
        Assert.Equal("not.found", await Kit.Code(unseen));

        // A parent the caller cannot see: not found, whatever its section, its bin or its place.
        var hidden = await Page(ws, ws.Client, "Hidden", ws.Shared, orderKey: "a3");
        await Kit.Share(ws, hidden, true);
        var binned = await Page(ws, ws.Client, "Binned", ws.Shared, orderKey: "a4");
        await Kit.Share(ws, binned, true);
        Assert.Equal("applied", (await Op(ws, ws.Client, ws.Op("page.trash", binned, new { }))).Status);
        var elsewhere = Guid.CreateVersion7();
        Assert.Equal("not.found", (await Op(ws, member.Client, ws.Op("page.create", elsewhere, Ws.Page(elsewhere, ws.Id, mine, hidden, "a0")))).Code);
        var underBin = Guid.CreateVersion7();
        Assert.Equal("not.found", (await Op(ws, member.Client, ws.Op("page.create", underBin, Ws.Page(underBin, ws.Id, ws.Shared, binned, "a0")))).Code);

        var own = await Page(ws, member.Client, "Own", ws.Shared, orderKey: "a6");
        var inner = await Page(ws, ws.Client, "Inner", ws.Shared, own);
        await Kit.Share(ws, inner, true);
        Assert.Equal("not.found", (await Op(ws, member.Client, ws.Op("page.move", own, Move(ws.Shared, inner)))).Code);
        Assert.Equal("not.found", (await Op(ws, member.Client, ws.Op("page.move", own, Move(ws.Shared, binned)))).Code);
        Assert.Equal("not.found", (await Op(ws, member.Client, ws.Op("page.move", own, Move(mine, hidden)))).Code);
    }
}
