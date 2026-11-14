using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Comments;

namespace Cgw.Tests;

/// <summary>
/// M6.4: comments (Phase 6 contracts, section 3). Threads anchored on a block, their access by
/// level, strict bodies and anchors, idempotent creates by the client's ids, and the feed's
/// <c>comments</c> change only for those who can read the page.
/// </summary>
public sealed class CommentTests(ServerFixture server)
{
    public const string Block = "Ab12Cd34Ef56";

    public static object Text(string text) => new { type = "text", text };
    public static object Mention(Guid userId) => new { type = "userMention", attrs = new { userId } };

    public static object NewThread(Guid? id = null, Guid? commentId = null, object[]? body = null, object? anchor = null, string block = Block, string quote = "world") => new
    {
        id = id ?? Guid.CreateVersion7(),
        blockId = block,
        anchor = anchor ?? new { start = "AQID", end = "AQIE" },
        quote,
        comment = new { id = commentId ?? Guid.CreateVersion7(), body = body ?? [Text("Nice")] },
    };

    public static Task<HttpResponseMessage> Create(HttpClient client, Guid page, object thread) =>
        client.PostAsJsonAsync($"/api/v1/pages/{page}/comments/threads", thread);

    public static async Task<JsonElement> CreateOk(HttpClient client, Guid page, object thread)
    {
        var response = await Create(client, page, thread);
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    public static Task<HttpResponseMessage> Reply(HttpClient client, Guid thread, object[] body, Guid? id = null) =>
        client.PostAsJsonAsync($"/api/v1/comments/threads/{thread}/comments", new { id = id ?? Guid.CreateVersion7(), body });

    public static async Task<JsonElement> Threads(HttpClient client, Guid page, string? state = null) =>
        (await client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/comments/threads" + (state is null ? "" : $"?state={state}"))).GetProperty("threads");

    [Fact]
    public async Task A_thread_is_made_listed_answered_edited_resolved_and_deleted()
    {
        var ws = await Ws.Create(server, await server.NewAccount("Olive Owner"));
        var member = await Kit.Join(server, ws, "member", await server.NewAccount("Mo Member"));
        var page = (await ws.NewPage("Discussed")).GetProperty("id").GetGuid();

        var threadId = Guid.CreateVersion7();
        var firstId = Guid.CreateVersion7();
        var request = NewThread(threadId, firstId, [Text("Is this "), new { type = "hardBreak" }, Text("right? "), Mention(member.Id)]);
        var created = await CreateOk(ws.Client, page, request);
        Assert.Equal(threadId, created.GetProperty("id").GetGuid());
        Assert.Equal(page, created.GetProperty("pageId").GetGuid());
        Assert.Equal(Block, created.GetProperty("blockId").GetString());
        Assert.Equal("AQID", created.GetProperty("anchor").GetProperty("start").GetString());
        Assert.Equal("AQIE", created.GetProperty("anchor").GetProperty("end").GetString());
        Assert.Equal("world", created.GetProperty("quote").GetString());
        Assert.Equal("Olive Owner", created.GetProperty("createdBy").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, created.GetProperty("resolvedAt").ValueKind);
        var first = Assert.Single(created.GetProperty("comments").EnumerateArray());
        Assert.Equal(firstId, first.GetProperty("id").GetGuid());
        Assert.Equal(ws.Account.Id, first.GetProperty("author").GetProperty("id").GetGuid());
        // The body as the server wrote it back: these nodes, these keys.
        Assert.Equal(
            $$$"""[{"type":"text","text":"Is this "},{"type":"hardBreak"},{"type":"text","text":"right? "},{"type":"userMention","attrs":{"userId":"{{{member.Id}}}"}}]""",
            first.GetProperty("body").GetRawText());

        // A lost answer: the same create again answers with what is stored, and makes nothing new.
        var again = await CreateOk(ws.Client, page, request);
        Assert.Equal(created.GetRawText(), again.GetRawText());
        Assert.Equal(HttpStatusCode.Conflict, (await Create(member.Client, page, request)).StatusCode);
        Assert.Single((await Threads(member.Client, page)).EnumerateArray());

        var replyId = Guid.CreateVersion7();
        var reply = await Reply(member.Client, threadId, [Text("Yes")], replyId);
        Assert.Equal(HttpStatusCode.Created, reply.StatusCode);
        var replied = await Kit.Json(reply);
        Assert.Equal("Mo Member", replied.GetProperty("author").GetProperty("name").GetString());
        Assert.Equal(HttpStatusCode.Created, (await Reply(member.Client, threadId, [Text("Yes")], replyId)).StatusCode);
        var listed = Assert.Single((await Threads(ws.Client, page)).EnumerateArray());
        Assert.Equal([firstId, replyId], listed.GetProperty("comments").EnumerateArray().Select(c => c.GetProperty("id").GetGuid()));

        // Its author edits a comment, nobody else.
        Assert.Equal(HttpStatusCode.Forbidden, (await ws.Client.PatchAsJsonAsync($"/api/v1/comments/{replyId}", new { body = new[] { Text("No") } })).StatusCode);
        var edited = await member.Client.PatchAsJsonAsync($"/api/v1/comments/{replyId}", new { body = new[] { Text("Yes, it is") } });
        Assert.Equal(HttpStatusCode.OK, edited.StatusCode);
        var editedBody = await Kit.Json(edited);
        Assert.Equal(JsonValueKind.String, editedBody.GetProperty("editedAt").ValueKind);
        Assert.Equal("Yes, it is", editedBody.GetProperty("body")[0].GetProperty("text").GetString());

        // Resolved: out of the open list, in the resolved one; reopened: back.
        var resolved = await member.Client.PatchAsJsonAsync($"/api/v1/comments/threads/{threadId}", new { resolved = true });
        Assert.Equal(HttpStatusCode.OK, resolved.StatusCode);
        var resolvedBody = await Kit.Json(resolved);
        Assert.Equal(member.Id, resolvedBody.GetProperty("resolvedBy").GetProperty("id").GetGuid());
        Assert.True(resolvedBody.GetProperty("version").GetInt64() > created.GetProperty("version").GetInt64());
        Assert.Empty((await Threads(ws.Client, page)).EnumerateArray());
        Assert.Single((await Threads(ws.Client, page, "resolved")).EnumerateArray());
        Assert.Single((await Threads(ws.Client, page, "all")).EnumerateArray());
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.GetAsync($"/api/v1/pages/{page}/comments/threads?state=closed")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PatchAsJsonAsync($"/api/v1/comments/threads/{threadId}", new { resolved = false })).StatusCode);
        Assert.Single((await Threads(ws.Client, page)).EnumerateArray());

        // A reply goes alone; the first comment takes its thread with it.
        Assert.Equal(HttpStatusCode.NoContent, (await member.Client.DeleteAsync($"/api/v1/comments/{replyId}")).StatusCode);
        Assert.Equal([firstId], (await Threads(ws.Client, page))[0].GetProperty("comments").EnumerateArray().Select(c => c.GetProperty("id").GetGuid()));
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.PatchAsJsonAsync($"/api/v1/comments/{replyId}", new { body = new[] { Text("Back") } })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.DeleteAsync($"/api/v1/comments/{firstId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/comments/{firstId}")).StatusCode);
        Assert.Empty((await Threads(ws.Client, page, "all")).EnumerateArray());
        Assert.Equal(HttpStatusCode.NotFound, (await Reply(ws.Client, threadId, [Text("Anyone?")])).StatusCode);

        // A whole block: no anchor, no quote.
        var whole = await CreateOk(member.Client, page, NewThread(anchor: new { start = (string?)null, end = (string?)null }, quote: ""));
        Assert.Equal(JsonValueKind.Null, whole.GetProperty("anchor").GetProperty("start").ValueKind);
        Assert.Equal("", whole.GetProperty("quote").GetString());
    }

    [Fact]
    public async Task Who_may_read_write_edit_and_delete_follows_the_page_level()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var viewer = await Kit.Join(server, ws, "member");
        var commenter = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var stranger = await server.NewAccount();
        var page = (await ws.NewPage("Levels")).GetProperty("id").GetGuid();
        await Kit.Share(ws, page, true, ("user", viewer.Id, "view"), ("user", commenter.Id, "comment"));
        var mine = (await ws.NewPage("Private", section: ws.Personal)).GetProperty("id").GetGuid();
        var thread = await CreateOk(commenter.Client, page, NewThread());
        var threadId = thread.GetProperty("id").GetGuid();
        var commentId = thread.GetProperty("comments")[0].GetProperty("id").GetGuid();

        // view: reads, never writes.
        Assert.Single((await Threads(viewer.Client, page)).EnumerateArray());
        Assert.Equal(HttpStatusCode.Forbidden, (await Create(viewer.Client, page, NewThread())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Reply(viewer.Client, threadId, [Text("Me too")])).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Client.PatchAsJsonAsync($"/api/v1/comments/threads/{threadId}", new { resolved = true })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Client.DeleteAsync($"/api/v1/comments/{commentId}")).StatusCode);
        // comment: writes and resolves.
        Assert.Equal(HttpStatusCode.Created, (await Reply(commenter.Client, threadId, [Text("Me")])).StatusCode);
        // full (an admin): deletes anyone's comment.
        var other = await CreateOk(commenter.Client, page, NewThread());
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Client.DeleteAsync($"/api/v1/comments/{other.GetProperty("comments")[0].GetProperty("id").GetGuid()}")).StatusCode);
        // Nothing of the page for those who cannot see it: as if it were not there.
        foreach (var outsider in new[] { guest, stranger })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/pages/{page}/comments/threads")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await Create(outsider.Client, page, NewThread())).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await Reply(outsider.Client, threadId, [Text("Hi")])).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.PatchAsJsonAsync($"/api/v1/comments/threads/{threadId}", new { resolved = true })).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.PatchAsJsonAsync($"/api/v1/comments/{commentId}", new { body = new[] { Text("x") } })).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.DeleteAsync($"/api/v1/comments/{commentId}")).StatusCode);
        }
        // A private section is its owner's alone, admins too are outside it.
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Client.GetAsync($"/api/v1/pages/{mine}/comments/threads")).StatusCode);
        await CreateOk(ws.Client, mine, NewThread());
        // A share link reaches none of it.
        var shared = (await ws.NewPage("Shared")).GetProperty("id").GetGuid();
        await CreateOk(ws.Client, shared, NewThread());
        var link = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{shared}/share-links", new { }));
        var reader = server.Anonymous();
        reader.DefaultRequestHeaders.Add("X-Share-Token", link.GetProperty("token").GetString());
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync("/api/v1/shared")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.GetAsync($"/api/v1/pages/{shared}/comments/threads")).StatusCode);
        // A page deleted for good.
        var doomed = (await ws.NewPage("Doomed")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", doomed, new { }));
        await ws.Push(ws.Op("page.delete", doomed, new { }));
        Assert.Equal(HttpStatusCode.Gone, (await ws.Client.GetAsync($"/api/v1/pages/{doomed}/comments/threads")).StatusCode);
    }

    [Fact]
    public async Task Bodies_and_anchors_that_break_the_rules_are_comment_invalid()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Strict")).GetProperty("id").GetGuid();
        var thread = await CreateOk(ws.Client, page, NewThread());
        var threadId = thread.GetProperty("id").GetGuid();
        var bodies = new Dictionary<string, object>
        {
            ["no nodes"] = Array.Empty<object>(),
            ["not a list"] = new { type = "text", text = "x" },
            ["marks"] = new object[] { new { type = "text", text = "bold", marks = new[] { new { type = "bold" } } } },
            ["a line break in text"] = new object[] { Text("one\ntwo") },
            ["a control character"] = new object[] { Text("bell\u0007") },
            ["empty text"] = new object[] { Text("") },
            ["only a hard break"] = new object[] { new { type = "hardBreak" } },
            ["a paragraph"] = new object[] { new { type = "paragraph", content = new[] { Text("x") } } },
            ["an image"] = new object[] { new { type = "image", attrs = new { assetId = Guid.NewGuid() } } },
            ["a mention with no id"] = new object[] { new { type = "userMention", attrs = new { userId = "someone" } } },
            ["a mention naming itself"] = new object[] { new { type = "userMention", attrs = new { userId = Guid.NewGuid(), name = "Eve" } } },
            ["a hard break with attrs"] = new object[] { new { type = "hardBreak", attrs = new { } } },
            ["too long"] = new object[] { Text(new string('x', 4001)) },
            ["too many mentions"] = Enumerable.Range(0, 51).Select(_ => Mention(Guid.NewGuid())).ToArray(),
        };
        foreach (var (name, body) in bodies)
        {
            var response = await ws.Client.PostAsJsonAsync($"/api/v1/comments/threads/{threadId}/comments", new { id = Guid.CreateVersion7(), body });
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest && await Kit.Code(response) == "comment.invalid", $"{name}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        }
        // Not empty is enough: one mention alone, or a space, is a comment.
        Assert.Equal(HttpStatusCode.Created, (await Reply(ws.Client, threadId, [Mention(Guid.NewGuid())])).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await Reply(ws.Client, threadId, [Text(" "), new { type = "hardBreak" }])).StatusCode);
        // At the edges: 4,000 characters and 50 mentions are fine.
        Assert.Equal(HttpStatusCode.Created, (await Reply(ws.Client, threadId, [Text(new string('x', 4000))])).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await Reply(ws.Client, threadId, [.. Enumerable.Range(0, 50).Select(_ => Mention(Guid.NewGuid()))])).StatusCode);

        var threads = new Dictionary<string, object>
        {
            ["an anchor with one end"] = NewThread(anchor: new { start = "AQID", end = (string?)null }),
            ["an anchor that is not base64"] = NewThread(anchor: new { start = "!!", end = "AQID" }),
            ["an anchor over 256 bytes"] = NewThread(anchor: new { start = Convert.ToBase64String(new byte[257]), end = "AQID" }),
            ["an anchor with more keys"] = NewThread(anchor: new { start = "AQID", end = "AQID", pos = 3 }),
            ["no anchor"] = new { id = Guid.CreateVersion7(), blockId = Block, quote = "", comment = new { id = Guid.CreateVersion7(), body = new[] { Text("x") } } },
            ["a block id that is not one"] = NewThread(block: "short"),
            ["a quote too long"] = NewThread(quote: new string('q', 1001)),
            ["an id that is not a UUIDv7"] = NewThread(id: Guid.NewGuid()),
            ["a comment id that is not a UUIDv7"] = NewThread(commentId: Guid.NewGuid()),
            ["a bad first comment"] = NewThread(body: [Text("a\rb")]),
        };
        foreach (var (name, body) in threads)
        {
            var response = await Create(ws.Client, page, body);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest && await Kit.Code(response) == "comment.invalid", $"{name}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        }
        // 256 bytes is the most an end holds.
        Assert.Equal(HttpStatusCode.Created, (await Create(ws.Client, page, NewThread(anchor: new { start = Convert.ToBase64String(new byte[256]), end = "AQID" }))).StatusCode);
        Assert.Single((await Threads(ws.Client, page)).EnumerateArray(), t => t.GetProperty("anchor").GetProperty("start").GetString()!.Length > 300);
    }

    [Fact]
    public async Task The_feed_says_a_pages_comments_changed_only_to_those_who_can_read_it()
    {
        var ws = await Ws.Create(server);
        var reader = await Kit.Join(server, ws, "member");
        var outsider = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Talked about")).GetProperty("id").GetGuid();
        await Kit.Share(ws, page, true, ("user", reader.Id, "view"));
        var before = (await ws.Changes(0, reader.Client)).GetProperty("cursor").GetInt64();
        var outsiderBefore = (await ws.Changes(0, outsider.Client)).GetProperty("cursor").GetInt64();
        var thread = await CreateOk(ws.Client, page, NewThread());
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PatchAsJsonAsync($"/api/v1/comments/threads/{thread.GetProperty("id").GetGuid()}", new { resolved = true })).StatusCode);

        var seen = (await ws.Changes(before, reader.Client)).GetProperty("changes").EnumerateArray().Where(c => c.GetProperty("entityType").GetString() == "comments").ToList();
        var change = Assert.Single(seen);
        Assert.Equal(page, change.GetProperty("entityId").GetGuid());
        Assert.Equal("upsert", change.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, change.GetProperty("entity").ValueKind);
        Assert.DoesNotContain((await ws.Changes(outsiderBefore, outsider.Client)).GetProperty("changes").EnumerateArray(),
            c => c.GetProperty("entityType").GetString() == "comments");
    }

    [Fact]
    public void The_body_rules_write_back_only_what_they_checked()
    {
        var parsed = CommentRules.Body(JsonDocument.Parse("""[{"text":"a","type":"text"},{"type":"pageMention","attrs":{"pageId":"0195F4A0-0000-7000-8000-0000000000E1"}}]""").RootElement);
        Assert.True(parsed.Ok);
        Assert.Equal("""[{"type":"text","text":"a"},{"type":"pageMention","attrs":{"pageId":"0195f4a0-0000-7000-8000-0000000000e1"}}]""", parsed.Value!.Json);
        Assert.Equal("a@", parsed.Value.Text);
        Assert.Equal(new string('x', 200), CommentRules.Excerpt(new string('x', 200) + "more"));
        // A cut never splits a surrogate pair.
        Assert.Equal(new string('x', 199), CommentRules.Excerpt(new string('x', 199) + "\U0001F600" + "tail"));
    }
}
