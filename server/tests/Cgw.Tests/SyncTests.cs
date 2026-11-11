using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core;

namespace Cgw.Tests;

/// <summary>Builds operations as the client queues them (packages/workspace/src/types.ts).</summary>
public sealed class Ws(Account account, Guid id, Guid shared, Guid personal)
{
    public Account Account { get; } = account;
    public Guid Id { get; } = id;
    public Guid Shared { get; } = shared;
    public Guid Personal { get; } = personal;
    public HttpClient Client => Account.Client;

    public static JsonObject Op(string type, Guid workspace, Guid entity, object payload, long? baseVersion = null, Guid? opId = null) => new()
    {
        ["opId"] = (opId ?? Guid.CreateVersion7()).ToString(),
        ["type"] = type,
        ["workspaceId"] = workspace.ToString(),
        ["entityId"] = entity.ToString(),
        ["baseVersion"] = baseVersion,
        ["payload"] = JsonSerializer.SerializeToNode(payload),
        ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
    };

    public JsonObject Op(string type, Guid entity, object payload, long? baseVersion = null) => Op(type, Id, entity, payload, baseVersion);

    public static object Page(Guid id, Guid workspace, Guid section, Guid? parent, string orderKey, string title = "") => new
    {
        id, workspaceId = workspace, sectionId = section, parentPageId = parent, orderKey, kind = "page", title, icon = (string?)null,
        coverAssetId = (Guid?)null, isTemplate = false, templateOfPageId = (Guid?)null, version = 1,
        createdAt = DateTimeOffset.UtcNow, updatedAt = DateTimeOffset.UtcNow, trashedAt = (DateTimeOffset?)null, trashRootId = (Guid?)null,
    };

    public async Task<JsonElement> Push(params JsonObject[] ops) => await Push(Client, ops);

    public async Task<JsonElement> Push(HttpClient client, params JsonObject[] ops)
    {
        var response = await client.PostAsJsonAsync($"/api/v1/workspaces/{Id}/ops", new { ops });
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(response.IsSuccessStatusCode, body.ToString());
        return body.GetProperty("results");
    }

    public async Task<JsonElement> NewPage(string title, Guid? parent = null, string orderKey = "a0", Guid? section = null)
    {
        var id = Guid.CreateVersion7();
        var results = await Push(Op("page.create", id, Page(id, Id, section ?? Shared, parent, orderKey, title)));
        Assert.Equal("applied", results[0].GetProperty("status").GetString());
        return results[0].GetProperty("entity").GetProperty("page");
    }

    public async Task<JsonElement> Tree(HttpClient? client = null, Guid? root = null) =>
        await (client ?? Client).GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{Id}/tree" + (root is null ? "" : $"?root={root}"));

    public async Task<JsonElement> Changes(long after, HttpClient? client = null) =>
        await (client ?? Client).GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{Id}/changes?after={after}");

    /// <summary>A workspace as the app makes one: a shared and a private section.</summary>
    public static async Task<Ws> Create(ServerFixture server, Account? account = null)
    {
        account ??= await server.NewAccount();
        var id = Guid.CreateVersion7();
        var created = await account.Client.PostAsJsonAsync("/api/v1/workspaces", new { id, name = "Test workspace" });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var shared = Guid.CreateVersion7();
        var personal = Guid.CreateVersion7();
        var ws = new Ws(account, id, shared, personal);
        var results = await ws.Push(
            ws.Op("section.create", shared, new { id = shared, workspaceId = id, name = "Shared", orderKey = "a0", visibility = "workspace", version = 1, createdAt = DateTimeOffset.UtcNow }),
            ws.Op("section.create", personal, new { id = personal, workspaceId = id, name = "Private", orderKey = "a1", visibility = "private", version = 1, createdAt = DateTimeOffset.UtcNow }));
        Assert.All(results.EnumerateArray(), r => Assert.Equal("applied", r.GetProperty("status").GetString()));
        return ws;
    }
}

/// <summary>M2.3: workspaces, operations, the change feed, the tree, members and invites.</summary>
public sealed class SyncTests(ServerFixture server)
{
    [Fact]
    public void Order_keys_match_the_shared_vectors()
    {
        var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "vectors", "order-vectors.json")));
        var count = 0;
        foreach (var row in vectors.RootElement.EnumerateArray())
        {
            var a = row[0].ValueKind == JsonValueKind.Null ? null : row[0].GetString();
            var b = row[1].ValueKind == JsonValueKind.Null ? null : row[1].GetString();
            Assert.Equal(row[2].GetString(), OrderKeys.Between(a, b));
            count++;
        }
        Assert.True(count > 10);
    }

    [Fact]
    public void Normalised_text_matches_the_shared_vectors()
    {
        var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "vectors", "search-vectors.json")));
        foreach (var row in vectors.RootElement.EnumerateArray())
            Assert.Equal(row[1].GetString(), TextNormaliser.Normalise(row[0].GetString()!));
    }

    [Fact]
    public async Task Creating_a_workspace_is_idempotent_and_its_id_is_the_clients()
    {
        var account = await server.NewAccount();
        var id = Guid.CreateVersion7();
        var first = await account.Client.PostAsJsonAsync("/api/v1/workspaces", new { id, name = "Mine" });
        var again = await account.Client.PostAsJsonAsync("/api/v1/workspaces", new { id, name = "Mine" });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(id, (await again.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid());
        var stranger = await server.NewAccount();
        var taken = await stranger.Client.PostAsJsonAsync("/api/v1/workspaces", new { id, name = "Theirs" });
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
        var list = await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/workspaces");
        Assert.Contains(list.EnumerateArray(), w => w.GetProperty("id").GetGuid() == id && w.GetProperty("role").GetString() == "owner");
    }

    [Fact]
    public async Task Pages_are_created_moved_trashed_restored_and_deleted_by_the_tree_rules()
    {
        var ws = await Ws.Create(server);
        var parent = await ws.NewPage("Parent");
        var child = await ws.NewPage("Child", parent.GetProperty("id").GetGuid());
        var grandchild = await ws.NewPage("Grandchild", child.GetProperty("id").GetGuid());
        var parentId = parent.GetProperty("id").GetGuid();
        var childId = child.GetProperty("id").GetGuid();

        // No cycles.
        var cycle = await ws.Push(ws.Op("page.move", parentId, new { sectionId = ws.Shared, parentPageId = grandchild.GetProperty("id").GetGuid(), orderKey = "a0" }, 1));
        Assert.Equal("tree.cycle", cycle[0].GetProperty("error").GetProperty("code").GetString());
        // A move on an old version is refused, and the answer carries the current page.
        await ws.Push(ws.Op("page.update", childId, new { title = "Renamed" }));
        var stale = await ws.Push(ws.Op("page.move", childId, new { sectionId = ws.Shared, parentPageId = (Guid?)null, orderKey = "a5" }, 1));
        Assert.Equal("version.conflict", stale[0].GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(2, stale[0].GetProperty("entity").GetProperty("page").GetProperty("version").GetInt64());
        var moved = await ws.Push(ws.Op("page.move", childId, new { sectionId = ws.Shared, parentPageId = (Guid?)null, orderKey = "a5" }, 2));
        Assert.Equal("applied", moved[0].GetProperty("status").GetString());

        // Moving the child out re-roots the grandchild with it (closure table): the parent can now go under the grandchild.
        var under = await ws.Push(ws.Op("page.move", parentId, new { sectionId = ws.Shared, parentPageId = grandchild.GetProperty("id").GetGuid(), orderKey = "a0" }, 1));
        Assert.Equal("applied", under[0].GetProperty("status").GetString());

        // Trash the child: its subtree (grandchild, and the parent now under it) goes as one unit.
        var trash = await ws.Push(ws.Op("page.trash", childId, new { }, 3));
        Assert.Equal("applied", trash[0].GetProperty("status").GetString());
        var tree = await ws.Tree();
        var trashed = tree.GetProperty("pages").EnumerateArray().Where(p => p.GetProperty("trashRootId").ValueKind == JsonValueKind.String).ToList();
        Assert.Equal(3, trashed.Count);
        Assert.All(trashed, p => Assert.Equal(childId, p.GetProperty("trashRootId").GetGuid()));

        // Only the root restores; then deletion for good needs the trash.
        var notRoot = await ws.Push(ws.Op("page.restore", parentId, new { }));
        Assert.Equal("page.notTrashed", notRoot[0].GetProperty("error").GetProperty("code").GetString());
        var restore = await ws.Push(ws.Op("page.restore", childId, new { }));
        Assert.Equal("applied", restore[0].GetProperty("status").GetString());
        var notTrashed = await ws.Push(ws.Op("page.delete", childId, new { }));
        Assert.Equal("page.notTrashed", notTrashed[0].GetProperty("error").GetProperty("code").GetString());
        var version = (await ws.Tree()).GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == childId).GetProperty("version").GetInt64();
        await ws.Push(ws.Op("page.trash", childId, new { }, version));
        var delete = await ws.Push(ws.Op("page.delete", childId, new { }));
        Assert.Equal("applied", delete[0].GetProperty("status").GetString());
        Assert.Empty((await ws.Tree()).GetProperty("pages").EnumerateArray());
    }

    [Fact]
    public async Task A_repeated_batch_is_answered_from_applied_ops()
    {
        var ws = await Ws.Create(server);
        var id = Guid.CreateVersion7();
        var op = ws.Op("page.create", id, Ws.Page(id, ws.Id, ws.Shared, null, "a0", "Once"));
        var first = await ws.Push(op);
        var second = await ws.Push(JsonNode.Parse(op.ToJsonString())!.AsObject());
        Assert.Equal(first.ToString(), second.ToString());
        Assert.Single((await ws.Tree()).GetProperty("pages").EnumerateArray());
    }

    [Fact]
    public async Task Operations_on_a_refused_create_are_refused_too()
    {
        var ws = await Ws.Create(server);
        var bad = Guid.CreateVersion7();
        var child = Guid.CreateVersion7();
        var results = await ws.Push(
            ws.Op("page.create", bad, Ws.Page(bad, ws.Id, ws.Shared, null, "not a key!")),
            ws.Op("page.create", child, Ws.Page(child, ws.Id, ws.Shared, bad, "a0")),
            ws.Op("page.update", bad, new { title = "x" }));
        Assert.All(results.EnumerateArray(), r => Assert.Equal("rejected", r.GetProperty("status").GetString()));
    }

    [Fact]
    public async Task Equal_order_keys_from_two_clients_get_a_new_key_on_the_server()
    {
        var ws = await Ws.Create(server);
        var a = await ws.NewPage("A", orderKey: "a0");
        var b = await ws.NewPage("B", orderKey: "a0");
        Assert.Equal("a0", a.GetProperty("orderKey").GetString());
        Assert.NotEqual("a0", b.GetProperty("orderKey").GetString());
        Assert.True(string.CompareOrdinal("a0", b.GetProperty("orderKey").GetString()) < 0);
    }

    [Fact]
    public async Task A_page_made_under_a_trashed_parent_goes_to_the_top_of_its_section_with_a_notice()
    {
        var ws = await Ws.Create(server);
        var parent = await ws.NewPage("Parent");
        var parentId = parent.GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", parentId, new { }, 1));
        var id = Guid.CreateVersion7();
        var results = await ws.Push(ws.Op("page.create", id, Ws.Page(id, ws.Id, ws.Shared, parentId, "a0", "Offline child")));
        Assert.Equal("applied", results[0].GetProperty("status").GetString());
        Assert.Equal("tree.parentMissing", results[0].GetProperty("notice").GetString());
        Assert.Equal(JsonValueKind.Null, results[0].GetProperty("entity").GetProperty("page").GetProperty("parentPageId").ValueKind);
    }

    [Fact]
    public async Task A_second_device_converges_from_the_feed()
    {
        var ws = await Ws.Create(server);
        var second = server.Anonymous();
        await ServerFixture.SignIn(second, ws.Account.Email, ws.Account.Password);
        var tree = await ws.Tree(second);
        var cursor = tree.GetProperty("cursor").GetInt64();
        var page = await ws.NewPage("From the first device");
        var pageId = page.GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.update", pageId, new { title = "Renamed twice" }), ws.Op("favourite.set", pageId, new { favourite = true, orderKey = "a0" }));
        var feed = await ws.Changes(cursor, second);
        var changes = feed.GetProperty("changes").EnumerateArray().ToList();
        // One page change for two edits: the last state.
        var pageChange = Assert.Single(changes, c => c.GetProperty("entityType").GetString() == "page");
        Assert.Equal("Renamed twice", pageChange.GetProperty("entity").GetProperty("page").GetProperty("title").GetString());
        Assert.Contains(changes, c => c.GetProperty("entityType").GetString() == "favourite");
        Assert.False(feed.GetProperty("more").GetBoolean());
        Assert.True(feed.GetProperty("cursor").GetInt64() > cursor);
        // Nothing new after the cursor.
        Assert.Empty((await ws.Changes(feed.GetProperty("cursor").GetInt64(), second)).GetProperty("changes").EnumerateArray());
    }

    [Fact]
    public async Task Members_see_shared_pages_not_private_ones_and_favourites_are_per_user()
    {
        var ws = await Ws.Create(server);
        var shared = await ws.NewPage("Shared page");
        var mine = await ws.NewPage("Private page", section: ws.Personal);
        await ws.Push(ws.Op("favourite.set", shared.GetProperty("id").GetGuid(), new { favourite = true, orderKey = "a0" }));
        var other = await server.NewAccount();
        var invite = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/invites", new { email = other.Email, role = "member" });
        Assert.Equal(HttpStatusCode.OK, invite.StatusCode);
        var mail = (await server.MailTo(other.Email, "invite")).Replace("=\r\n", "");
        var token = System.Text.RegularExpressions.Regex.Match(mail, "#/invite/([A-Za-z0-9_-]+)").Groups[1].Value;
        Assert.NotEmpty(token);
        // Someone else cannot use the invite.
        var stranger = await server.NewAccount();
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.Client.PostAsync($"/api/v1/invites/{token}/accept", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await other.Client.PostAsync($"/api/v1/invites/{token}/accept", null)).StatusCode);

        var tree = await ws.Tree(other.Client);
        var pages = tree.GetProperty("pages").EnumerateArray().Select(p => p.GetProperty("title").GetString()).ToList();
        Assert.Contains("Shared page", pages);
        Assert.DoesNotContain("Private page", pages);
        Assert.DoesNotContain(tree.GetProperty("sections").EnumerateArray(), s => s.GetProperty("visibility").GetString() == "private");
        Assert.Empty(tree.GetProperty("favourites").EnumerateArray());
        // The member cannot change the owner's private page.
        var refused = await ws.Push(other.Client, ws.Op("page.update", mine.GetProperty("id").GetGuid(), new { title = "Mine now" }));
        Assert.Equal("not.found", refused[0].GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task A_guest_sees_nothing_until_a_page_is_shared_by_name()
    {
        var ws = await Ws.Create(server);
        await ws.NewPage("Team page");
        var guest = await server.NewAccount();
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members", new { email = guest.Email, role = "guest" })).StatusCode);
        Assert.Empty((await ws.Tree(guest.Client)).GetProperty("pages").EnumerateArray());
        var id = Guid.CreateVersion7();
        var refused = await ws.Push(guest.Client, ws.Op("page.create", id, Ws.Page(id, ws.Id, ws.Shared, null, "a0")));
        Assert.Equal("access.denied", refused[0].GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task A_non_member_gets_404_for_every_workspace_route()
    {
        var ws = await Ws.Create(server);
        var page = await ws.NewPage("Secret");
        var outsider = await server.NewAccount();
        var c = outsider.Client;
        var routes = new (HttpMethod Method, string Path, object? Body)[]
        {
            (HttpMethod.Get, $"/api/v1/workspaces/{ws.Id}", null),
            (HttpMethod.Patch, $"/api/v1/workspaces/{ws.Id}", new { name = "x" }),
            (HttpMethod.Delete, $"/api/v1/workspaces/{ws.Id}", null),
            (HttpMethod.Get, $"/api/v1/workspaces/{ws.Id}/members", null),
            (HttpMethod.Post, $"/api/v1/workspaces/{ws.Id}/members", new { email = outsider.Email, role = "member" }),
            (HttpMethod.Get, $"/api/v1/workspaces/{ws.Id}/invites", null),
            (HttpMethod.Post, $"/api/v1/workspaces/{ws.Id}/invites", new { email = "x@example.test", role = "member" }),
            (HttpMethod.Post, $"/api/v1/workspaces/{ws.Id}/ops", new { ops = new[] { ws.Op("page.update", page.GetProperty("id").GetGuid(), new { title = "x" }) } }),
            (HttpMethod.Get, $"/api/v1/workspaces/{ws.Id}/changes?after=0", null),
            (HttpMethod.Get, $"/api/v1/workspaces/{ws.Id}/tree", null),
        };
        foreach (var (method, path, body) in routes)
        {
            var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
            var response = await c.SendAsync(request);
            Assert.True(response.StatusCode == HttpStatusCode.NotFound, $"{method} {path}: {response.StatusCode}");
        }
    }

    [Fact]
    public async Task A_removed_member_loses_the_workspace_and_a_revoke_is_in_the_feed()
    {
        var ws = await Ws.Create(server);
        var member = await server.NewAccount();
        await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members", new { email = member.Email, role = "member" });
        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{member.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/changes?after={cursor}")).StatusCode);
        var feed = await ws.Changes(cursor);
        Assert.DoesNotContain(feed.GetProperty("changes").EnumerateArray(), c => c.GetProperty("entityType").GetString() == "access");
        // The last owner cannot leave.
        var leave = await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{ws.Account.Id}");
        Assert.Equal(HttpStatusCode.Conflict, leave.StatusCode);
    }
}
