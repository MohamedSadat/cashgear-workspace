using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Notifications;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// M6.5: mentions and the inbox (Phase 6 contracts, section 5). The worker's mention pass over the
/// derived document; comment mentions and replies; once per key; none for someone who cannot read
/// the page; read across workspaces, each against the page's access now.
/// </summary>
public sealed class NotificationTests(ServerFixture server)
{
    private sealed record MentionFixtures(Dictionary<string, string> People, List<Fixture> Updates);

    private static readonly Lazy<MentionFixtures> Fixtures = new(() =>
        JsonSerializer.Deserialize<MentionFixtures>(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "mentions.json")),
            new JsonSerializerOptions(JsonSerializerDefaults.Web))!);

    /// <summary>A fixture's update with its placeholder people swapped for real ones (a UUID's length each, so the update stays whole).</summary>
    private static byte[] Mentioning(string name, Guid a, Guid b, Guid o)
    {
        var bytes = Fixtures.Value.Updates.Single(f => f.Name == name).Bytes;
        var text = Encoding.Latin1.GetString(bytes);
        var swapped = 0;
        foreach (var (key, real) in new[] { ("a", a), ("b", b), ("o", o) })
        {
            var placeholder = Fixtures.Value.People[key];
            if (!text.Contains(placeholder, StringComparison.Ordinal)) continue;
            text = text.Replace(placeholder, real.ToString());
            swapped++;
        }
        Assert.True(swapped > 0, $"{name} names none of the placeholders");
        return Encoding.Latin1.GetBytes(text);
    }

    /// <summary>
    /// Pushed by its writer (from an app that knows version 5, so the worker passes it too if
    /// another test's validation pass reaches it first), then taken as valid without waiting for the
    /// worker: the pass under test reads the derived document.
    /// </summary>
    private async Task Valid(Ws ws, HttpClient writer, Guid page, byte[] data)
    {
        var id = Guid.CreateVersion7();
        var pushed = await writer.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch = 0,
            clientSchemaVersion = 5,
            updates = new[] { new { updateId = id, data } },
        });
        Assert.True(pushed.IsSuccessStatusCode, await pushed.Content.ReadAsStringAsync());
        await using var db = server.NewDb(ws.Id);
        await db.PageDocUpdates.Where(u => u.PageId == page && u.Status == UpdateStatus.Pending).ExecuteUpdateAsync(s => s.SetProperty(u => u.Status, UpdateStatus.Valid));
        await db.Pages.Where(p => p.Id == page).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocHeadSeq, p => p.DocSeq));
        Assert.Equal(UpdateStatus.Valid, (await db.PageDocUpdates.AsNoTracking().SingleAsync(u => u.UpdateId == id)).Status);
    }

    private static async Task<JsonElement> Inbox(HttpClient client, string query = "") =>
        await client.GetFromJsonAsync<JsonElement>("/api/v1/account/notifications" + query);

    [Fact]
    public void Mentions_are_found_in_their_blocks_with_the_blocks_text()
    {
        var a = Guid.CreateVersion7();
        var b = Guid.CreateVersion7();
        var json = $$$"""
            {"type":"doc","content":[
              {"type":"block","attrs":{"id":"Aa11Bb22Cc33"},"content":[
                {"type":"textBody","attrs":{"kind":"paragraph"},"content":[
                  {"type":"text","text":"Hi "},{"type":"userMention","attrs":{"userId":"{{{a}}}"}},{"type":"text","text":" and "},
                  {"type":"userMention","attrs":{"userId":"{{{a}}}"}},{"type":"hardBreak"},{"type":"userMention","attrs":{"userId":null}}]},
                {"type":"block","attrs":{"id":"Dd44Ee55Ff66"},"content":[
                  {"type":"textBody","content":[{"type":"text","text":"Nested "},{"type":"userMention","attrs":{"userId":"{{{b}}}"}}]}]}]},
              {"type":"block","attrs":{"id":"bad"},"content":[{"type":"textBody","content":[{"type":"userMention","attrs":{"userId":"{{{b}}}"}}]}]}
            ]}
            """;
        var found = Mentions.InDocument(json);
        Assert.Equal([("Aa11Bb22Cc33", a), ("Dd44Ee55Ff66", b)], found.Select(m => (m.BlockId, m.UserId)));
        Assert.Equal("Hi @ and @ @", found[0].Excerpt);
        Assert.Equal("Nested @", found[1].Excerpt);
        var kept = Mentions.Serialize(found);
        Assert.True(Mentions.Parse(kept).SetEquals([("Aa11Bb22Cc33", a), ("Dd44Ee55Ff66", b)]));
        Assert.Empty(Mentions.Parse(null));
        Assert.Empty(Mentions.Parse("not json"));
    }

    [Fact]
    public async Task A_mention_in_a_page_notifies_a_reader_once_and_never_the_writer_or_someone_who_cannot_read_it()
    {
        var ws = await Ws.Create(server, await server.NewAccount("Wren Writer"));
        var a = await Kit.Join(server, ws, "member");
        var b = await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws, "Mentioned");
        await Kit.Share(ws, page, true, ("user", a.Id, "view"));
        var aCursor = (await ws.Changes(0, a.Client)).GetProperty("cursor").GetInt64();
        var bCursor = (await ws.Changes(0, b.Client)).GetProperty("cursor").GetInt64();

        await Valid(ws, ws.Client, page, Mentioning("mentions", a.Id, b.Id, ws.Account.Id));
        await Kit.Derive(server, ws.Id, page);
        var inbox = await Inbox(a.Client);
        var entry = Assert.Single(inbox.GetProperty("notifications").EnumerateArray());
        Assert.Equal(1, inbox.GetProperty("unread").GetInt32());
        Assert.Equal("mention", entry.GetProperty("kind").GetString());
        Assert.Equal(ws.Id, entry.GetProperty("workspaceId").GetGuid());
        Assert.Equal(page, entry.GetProperty("pageId").GetGuid());
        Assert.Equal("Mentioned", entry.GetProperty("pageTitle").GetString());
        Assert.Equal("Mn1Mn2Mn3Mn4", entry.GetProperty("blockId").GetString());
        Assert.Equal(JsonValueKind.Null, entry.GetProperty("threadId").ValueKind);
        Assert.Equal(ws.Account.Id, entry.GetProperty("actor").GetProperty("id").GetGuid());
        Assert.Equal("Wren Writer", entry.GetProperty("actor").GetProperty("name").GetString());
        Assert.Equal("Look at this, @ and @, from @", entry.GetProperty("excerpt").GetString());
        Assert.Equal(JsonValueKind.Null, entry.GetProperty("readAt").ValueKind);
        // Not the writer, not someone the page is closed to.
        Assert.Empty((await Inbox(ws.Client)).GetProperty("notifications").EnumerateArray());
        Assert.Empty((await Inbox(b.Client)).GetProperty("notifications").EnumerateArray());
        // The reader's devices are told by their own feed change; nobody else's.
        var change = Assert.Single((await ws.Changes(aCursor, a.Client)).GetProperty("changes").EnumerateArray(), c => c.GetProperty("entityType").GetString() == "notification");
        Assert.Equal(entry.GetProperty("id").GetGuid(), change.GetProperty("entityId").GetGuid());
        Assert.DoesNotContain((await ws.Changes(bCursor, b.Client)).GetProperty("changes").EnumerateArray(), c => c.GetProperty("entityType").GetString() == "notification");

        // Derived again with nothing new: nothing new.
        await Kit.Derive(server, ws.Id, page);
        Assert.Single((await Inbox(a.Client)).GetProperty("notifications").EnumerateArray());
        // A second block mentioning them: a second entry.
        await Valid(ws, ws.Client, page, Mentioning("mentionAgain", a.Id, b.Id, ws.Account.Id));
        await Kit.Derive(server, ws.Id, page);
        Assert.Equal(["Mn5Mn6Mn7Mn8", "Mn1Mn2Mn3Mn4"], (await Inbox(a.Client)).GetProperty("notifications").EnumerateArray().Select(n => n.GetProperty("blockId").GetString()));
        // The pairs the last derive saw forgotten: every pair is new again, and still each is written once.
        await using (var db = server.NewDb(ws.Id))
            await db.PageDocDerived.Where(d => d.PageId == page).ExecuteUpdateAsync(s => s.SetProperty(d => d.Mentions, (string?)null));
        await Kit.Derive(server, ws.Id, page);
        Assert.Equal(2, (await Inbox(a.Client)).GetProperty("notifications").GetArrayLength());

        // Once the page is closed to them, its entries are not shown and count for nothing.
        await Kit.Share(ws, page, true);
        var closed = await Inbox(a.Client);
        Assert.Empty(closed.GetProperty("notifications").EnumerateArray());
        Assert.Equal(0, closed.GetProperty("unread").GetInt32());
    }

    [Fact]
    public async Task Comments_notify_who_they_mention_and_the_threads_people_once_each()
    {
        var ws = await Ws.Create(server, await server.NewAccount("Oona Owner"));
        var a = await Kit.Join(server, ws, "member", await server.NewAccount("Ada"));
        var c = await Kit.Join(server, ws, "member", await server.NewAccount("Cy"));
        var shut = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Thread")).GetProperty("id").GetGuid();
        await Kit.Share(ws, page, true, ("user", a.Id, "comment"), ("user", c.Id, "comment"));

        // The owner starts a thread mentioning a, and someone the page is closed to.
        var thread = await CommentTests.CreateOk(ws.Client, page, CommentTests.NewThread(body: [CommentTests.Text("Ping "), CommentTests.Mention(a.Id), CommentTests.Mention(shut.Id)]));
        var threadId = thread.GetProperty("id").GetGuid();
        var mention = Assert.Single((await Inbox(a.Client)).GetProperty("notifications").EnumerateArray());
        Assert.Equal("commentMention", mention.GetProperty("kind").GetString());
        Assert.Equal(threadId, mention.GetProperty("threadId").GetGuid());
        Assert.Equal(thread.GetProperty("comments")[0].GetProperty("id").GetGuid(), mention.GetProperty("commentId").GetGuid());
        Assert.Equal(CommentTests.Block, mention.GetProperty("blockId").GetString());
        Assert.Equal("Ping @@", mention.GetProperty("excerpt").GetString());
        Assert.Equal("Oona Owner", mention.GetProperty("actor").GetProperty("name").GetString());
        Assert.Empty((await Inbox(shut.Client)).GetProperty("notifications").EnumerateArray());
        Assert.Empty((await Inbox(ws.Client)).GetProperty("notifications").EnumerateArray());

        // c replies: the thread's maker hears of it (a was only mentioned, not in the thread).
        var replyId = Guid.CreateVersion7();
        Assert.Equal(HttpStatusCode.Created, (await CommentTests.Reply(c.Client, threadId, [CommentTests.Text("On it")], replyId)).StatusCode);
        // A lost answer sent again writes nothing twice.
        Assert.Equal(HttpStatusCode.Created, (await CommentTests.Reply(c.Client, threadId, [CommentTests.Text("On it")], replyId)).StatusCode);
        var reply = Assert.Single((await Inbox(ws.Client)).GetProperty("notifications").EnumerateArray());
        Assert.Equal("reply", reply.GetProperty("kind").GetString());
        Assert.Equal(replyId, reply.GetProperty("commentId").GetGuid());
        Assert.Equal("Cy", reply.GetProperty("actor").GetProperty("name").GetString());
        Assert.Single((await Inbox(a.Client)).GetProperty("notifications").EnumerateArray());

        // a answers mentioning c: c is told once (a mention, not also a reply), the owner a reply.
        Assert.Equal(HttpStatusCode.Created, (await CommentTests.Reply(a.Client, threadId, [CommentTests.Text("Thanks "), CommentTests.Mention(c.Id)])).StatusCode);
        var forC = Assert.Single((await Inbox(c.Client)).GetProperty("notifications").EnumerateArray());
        Assert.Equal("commentMention", forC.GetProperty("kind").GetString());
        Assert.Equal(["reply", "reply"], (await Inbox(ws.Client)).GetProperty("notifications").EnumerateArray().Select(n => n.GetProperty("kind").GetString()));

        // An edit that mentions someone new tells them; one already told is not told again.
        var editable = thread.GetProperty("comments")[0].GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.PatchAsJsonAsync($"/api/v1/comments/{editable}", new
        {
            body = new[] { CommentTests.Text("Ping "), CommentTests.Mention(a.Id), CommentTests.Mention(c.Id) },
        })).StatusCode);
        Assert.Single((await Inbox(a.Client)).GetProperty("notifications").EnumerateArray());
        Assert.Equal(2, (await Inbox(c.Client)).GetProperty("notifications").GetArrayLength());
    }

    [Fact]
    public async Task The_inbox_spans_workspaces_pages_through_and_marks_read()
    {
        var one = await Ws.Create(server);
        var two = await Ws.Create(server);
        var reader = await Kit.Join(server, one, "member");
        await Kit.Join(server, two, "member", reader);
        var pageOne = (await one.NewPage("In one")).GetProperty("id").GetGuid();
        var pageTwo = (await two.NewPage("In two")).GetProperty("id").GetGuid();
        for (var i = 0; i < 3; i++)
        {
            await CommentTests.CreateOk(one.Client, pageOne, CommentTests.NewThread(body: [CommentTests.Text($"one {i} "), CommentTests.Mention(reader.Id)]));
            await CommentTests.CreateOk(two.Client, pageTwo, CommentTests.NewThread(body: [CommentTests.Text($"two {i} "), CommentTests.Mention(reader.Id)]));
        }
        var all = await Inbox(reader.Client);
        Assert.Equal(6, all.GetProperty("notifications").GetArrayLength());
        Assert.Equal(6, all.GetProperty("unread").GetInt32());
        Assert.Equal(JsonValueKind.Null, all.GetProperty("next").ValueKind);
        Assert.Equal(["two 2 @", "one 2 @"], all.GetProperty("notifications").EnumerateArray().Take(2).Select(n => n.GetProperty("excerpt").GetString()));
        Assert.Equal([pageTwo, pageOne], all.GetProperty("notifications").EnumerateArray().Take(2).Select(n => n.GetProperty("pageId").GetGuid()));

        // Page by page, newest first, with nothing seen twice or skipped.
        var seen = new List<Guid>();
        string? after = null;
        do
        {
            var page = await Inbox(reader.Client, "?limit=4" + (after is null ? "" : $"&after={after}"));
            seen.AddRange(page.GetProperty("notifications").EnumerateArray().Select(n => n.GetProperty("id").GetGuid()));
            after = page.GetProperty("next").ValueKind == JsonValueKind.String ? page.GetProperty("next").GetString() : null;
        } while (after is not null);
        Assert.Equal(all.GetProperty("notifications").EnumerateArray().Select(n => n.GetProperty("id").GetGuid()), seen);
        Assert.Equal(HttpStatusCode.BadRequest, (await reader.Client.GetAsync("/api/v1/account/notifications?after=nonsense")).StatusCode);

        var first = seen[0];
        var read = await reader.Client.PostAsJsonAsync("/api/v1/account/notifications/read", new { ids = new[] { first } });
        Assert.Equal(5, (await Kit.Json(read)).GetProperty("unread").GetInt32());
        var unread = await Inbox(reader.Client, "?unread=true");
        Assert.Equal(5, unread.GetProperty("notifications").GetArrayLength());
        Assert.DoesNotContain(first, unread.GetProperty("notifications").EnumerateArray().Select(n => n.GetProperty("id").GetGuid()));
        Assert.Equal(JsonValueKind.String, (await Inbox(reader.Client)).GetProperty("notifications")[0].GetProperty("readAt").ValueKind);
        // Each read is a feed change for the person, in the notification's workspace.
        var changes = (await two.Changes(0, reader.Client)).GetProperty("changes").EnumerateArray();
        Assert.Contains(changes, c => c.GetProperty("entityType").GetString() == "notification" && c.GetProperty("entityId").GetGuid() == first);

        Assert.Equal(0, (await Kit.Json(await reader.Client.PostAsJsonAsync("/api/v1/account/notifications/read", new { all = true }))).GetProperty("unread").GetInt32());
        Assert.Empty((await Inbox(reader.Client, "?unread=true")).GetProperty("notifications").EnumerateArray());
        Assert.Equal(HttpStatusCode.BadRequest, (await reader.Client.PostAsJsonAsync("/api/v1/account/notifications/read", new { })).StatusCode);
        // Someone else's ids are not theirs to mark.
        var other = await server.NewAccount();
        Assert.Equal(0, (await Kit.Json(await other.Client.PostAsJsonAsync("/api/v1/account/notifications/read", new { ids = new[] { seen[1] } }))).GetProperty("unread").GetInt32());

        // Out of a workspace, out of its entries.
        Assert.Equal(HttpStatusCode.NoContent, (await two.Client.DeleteAsync($"/api/v1/workspaces/{two.Id}/members/{reader.Id}")).StatusCode);
        Assert.All((await Inbox(reader.Client)).GetProperty("notifications").EnumerateArray(), n => Assert.Equal(one.Id, n.GetProperty("workspaceId").GetGuid()));
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.Anonymous().GetAsync("/api/v1/account/notifications")).StatusCode);
    }
}
