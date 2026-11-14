using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// M6.1, M6.3: the hub (Phase 6 contracts, section 1, realtime.1). Tickets; every method's
/// checks against the roles and levels; the push through the HTTP route's own path; the relay only
/// after the worker has validated; presence stamped and limited; access re-checked and revoked.
/// </summary>
public sealed class RealtimeTests(ServerFixture server)
{
    private static readonly TimeSpan Quiet = TimeSpan.FromMilliseconds(600);

    private static async Task<Guid> NewPage(Ws ws, string title, Guid? section = null) =>
        (await ws.NewPage(title, section: section)).GetProperty("id").GetGuid();

    [Fact]
    public async Task A_ticket_opens_the_hub_once_within_a_minute_and_only_from_an_allowed_origin()
    {
        var account = await server.NewAccount();
        var api = server.Api;
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.Anonymous().PostAsync("/api/v1/realtime/tickets", null)).StatusCode);
        Assert.Equal(401, await RealtimeKit.Upgrade(api, "/api/v1/realtime"));
        Assert.Equal(401, await RealtimeKit.Upgrade(api, "/api/v1/realtime?ticket=made-up"));

        var response = await account.Client.PostAsync("/api/v1/realtime/tickets", null);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var ticket = body.GetProperty("ticket").GetString()!;
        Assert.Equal(43, ticket.Length);
        var lifetime = body.GetProperty("expiresAt").GetDateTimeOffset() - DateTimeOffset.UtcNow;
        Assert.InRange(lifetime.TotalSeconds, 50, 61);
        // Kept only as its SHA-256.
        await using (var db = server.NewDb())
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(ticket));
            Assert.True(await db.RealtimeTickets.AnyAsync(t => t.TokenHash == hash && t.UserId == account.Id));
        }

        // A site not on the list, a request that is not a WebSocket, a negotiation: refused before
        // the ticket is read, so none of them uses it up.
        Assert.Equal(403, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={ticket}", "https://evil.example"));
        Assert.Equal(HttpStatusCode.BadRequest, (await account.Client.GetAsync($"/api/v1/realtime?ticket={ticket}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await account.Client.PostAsync($"/api/v1/realtime/negotiate?negotiateVersion=1&ticket={ticket}", null)).StatusCode);
        // Once, then never again.
        Assert.Equal(101, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={ticket}"));
        Assert.Equal(401, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={ticket}"));
        // A non-browser client sends no Origin: let in outside Production.
        Assert.Equal(101, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={await HubClient.Ticket(account.Client)}", origin: null));
        // The desktop's WebView is one of Web__Origins (Windows' http://tauri.localhost here, the Mac's
        // tauri://localhost below); anything else is refused.
        Assert.Equal(101, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={await HubClient.Ticket(account.Client)}", "http://tauri.localhost"));
        Assert.Equal(403, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={await HubClient.Ticket(account.Client)}", "tauri://localhost"));
        Assert.Equal(403, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={await HubClient.Ticket(account.Client)}", "http://localhost:5273.evil.example"));
        await using (var desktop = server.Variant(b => b.UseSetting("Web:Origins:2", "tauri://localhost")))
        {
            var client = await RealtimeKit.SignedIn(desktop, account);
            Assert.Equal(101, await RealtimeKit.Upgrade(desktop, $"/api/v1/realtime?ticket={await HubClient.Ticket(client)}", "tauri://localhost"));
            Assert.Equal(101, await RealtimeKit.Upgrade(desktop, $"/api/v1/realtime?ticket={await HubClient.Ticket(client)}", "http://tauri.localhost"));
            Assert.Equal(403, await RealtimeKit.Upgrade(desktop, $"/api/v1/realtime?ticket={await HubClient.Ticket(client)}", "tauri://elsewhere"));
        }

        // Past its 60 seconds.
        var old = await HubClient.Ticket(account.Client);
        var oldHash = SHA256.HashData(Encoding.UTF8.GetBytes(old));
        await using (var db = server.NewDb())
            await db.RealtimeTickets.Where(t => t.TokenHash == oldHash).ExecuteUpdateAsync(s => s.SetProperty(t => t.ExpiresAt, DateTimeOffset.UtcNow.AddSeconds(-1)));
        Assert.Equal(401, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={old}"));

        // A device signed out since the ticket was made: refused at connect.
        var late = await HubClient.Ticket(account.Client);
        var device = (await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("deviceId").GetString();
        var other = server.Anonymous();
        await ServerFixture.SignIn(other, account.Email, account.Password);
        Assert.Equal(HttpStatusCode.NoContent, (await other.DeleteAsync($"/api/v1/account/devices/{device}")).StatusCode);
        Assert.Equal(401, await RealtimeKit.Upgrade(api, $"/api/v1/realtime?ticket={late}"));
    }

    private sealed record Expect(string Name, Guid Page, Dictionary<string, string> Levels, bool Deleted = false);

    [Fact]
    public async Task Every_method_checks_the_person_and_the_page_as_the_HTTP_routes_do()
    {
        var ws = await Ws.Create(server);
        var people = new Dictionary<string, Account> { ["owner"] = ws.Account };
        foreach (var role in new[] { "admin", "member", "guest" }) people[role] = await Kit.Join(server, ws, role);
        var other = await Ws.Create(server);

        var open = await NewPage(ws, "Open");
        var viewed = await NewPage(ws, "Viewed");
        await Kit.Share(ws, viewed, false, ("user", people["member"].Id, "view"), ("user", people["guest"].Id, "view"));
        var commented = await NewPage(ws, "Commented");
        await Kit.Share(ws, commented, false, ("user", people["member"].Id, "comment"), ("user", people["guest"].Id, "comment"));
        var restricted = await NewPage(ws, "Restricted");
        await Kit.Share(ws, restricted, true);
        var mine = await NewPage(ws, "Private", ws.Personal);
        var trashed = await NewPage(ws, "Trashed");
        await ws.Push(ws.Op("page.trash", trashed, new { }));
        var deleted = await NewPage(ws, "Deleted");
        await ws.Push(ws.Op("page.trash", deleted, new { }));
        await ws.Push(ws.Op("page.delete", deleted, new { }));

        Dictionary<string, string> L(string owner, string admin, string member, string guest) =>
            new() { ["owner"] = owner, ["admin"] = admin, ["member"] = member, ["guest"] = guest };
        var cases = new[]
        {
            new Expect("open", open, L("full", "full", "edit", "none")),
            new Expect("viewed", viewed, L("full", "full", "view", "view")),
            new Expect("commented", commented, L("full", "full", "comment", "comment")),
            new Expect("restricted", restricted, L("full", "full", "none", "none")),
            new Expect("private", mine, L("full", "none", "none", "none")),
            new Expect("trashed", trashed, L("full", "full", "edit", "none")),
            new Expect("deleted", deleted, L("full", "full", "edit", "none"), Deleted: true),
        };
        var failures = new List<string>();
        foreach (var (role, account) in people)
        {
            await using var hub = await HubClient.Connect(server.Api, account.Client);
            var followed = await hub.Ok("JoinWorkspaces", new[] { ws.Id, other.Id, Guid.NewGuid() });
            var list = followed.EnumerateArray().ToList();
            if (list.Count != 1 || list[0].GetProperty("workspaceId").GetGuid() != ws.Id || list[0].GetProperty("seq").GetInt64() < 1)
                failures.Add($"{role}: JoinWorkspaces answered {followed}");
            foreach (var c in cases)
            {
                var level = c.Levels[role];
                var page = c.Page.ToString();
                void Check(string what, string expected, string actual)
                {
                    if (expected != actual) failures.Add($"{role} on {c.Name} ({level}) {what}: expected {expected}, got {actual}");
                }
                static async Task<string> Outcome(HubClient hub, string method, params object?[] args)
                {
                    var answer = await hub.Call(method, args);
                    return answer.GetProperty("ok").GetBoolean() ? "ok" : $"{answer.GetProperty("status").GetInt32()} {answer.GetProperty("code").GetString()}";
                }
                var gone = level == "none" ? "404 not.found" : c.Deleted ? "410 page.gone" : null;
                var join = await hub.Call("JoinPage", page);
                var joined = join.GetProperty("ok").GetBoolean();
                Check("JoinPage", gone ?? "ok", joined ? "ok" : $"{join.GetProperty("status").GetInt32()} {join.GetProperty("code").GetString()}");
                if (joined) Check("JoinPage level", level, join.GetProperty("value").GetProperty("level").GetString()!);
                Check("PushUpdates", gone ?? (Levels.AtLeast(level, Levels.Edit) ? "ok" : "403 access.denied"),
                    await Outcome(hub, "PushUpdates", page, RealtimeKit.Push((Guid.CreateVersion7(), Kit.Update("page")))));
                Check("Awareness", joined ? "ok" : "404 not.found", await Outcome(hub, "Awareness", page, new { clientId = 1001, cursor = (object?)null }));
                Check("LeavePage", "ok", await Outcome(hub, "LeavePage", page));
                // Left: presence is refused again.
                Check("Awareness after leaving", "404 not.found", await Outcome(hub, "Awareness", page, new { clientId = 1001, cursor = (object?)null }));
            }
            Check2(failures, role, "JoinPage of nothing", "404 not.found", await Answer(hub, "JoinPage", Guid.NewGuid().ToString()));
            Check2(failures, role, "JoinPage of no id", "404 not.found", await Answer(hub, "JoinPage", "not an id"));
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    private static void Check2(List<string> failures, string who, string what, string expected, string actual)
    {
        if (expected != actual) failures.Add($"{who} {what}: expected {expected}, got {actual}");
    }

    private static async Task<string> Answer(HubClient hub, string method, params object?[] args)
    {
        var answer = await hub.Call(method, args);
        return answer.GetProperty("ok").GetBoolean() ? "ok" : $"{answer.GetProperty("status").GetInt32()} {answer.GetProperty("code").GetString()}";
    }

    [Fact]
    public async Task PushUpdates_refuses_exactly_as_the_HTTP_push_does()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var stranger = await server.NewAccount();
        var page = await NewPage(ws, "Pushed");
        var viewed = await NewPage(ws, "Viewed");
        await Kit.Share(ws, viewed, false, ("user", member.Id, "view"));
        var deleted = await NewPage(ws, "Deleted");
        await ws.Push(ws.Op("page.trash", deleted, new { }));
        await ws.Push(ws.Op("page.delete", deleted, new { }));
        var newer = await NewPage(ws, "Newer");
        await using (var db = server.NewDb(ws.Id))
            await db.Pages.Where(p => p.Id == newer).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSchemaVersion, 2));

        var hubs = new Dictionary<HttpClient, HubClient>();
        async Task<HubClient> HubOf(HttpClient client) => hubs.TryGetValue(client, out var hub) ? hub : hubs[client] = await HubClient.Connect(server.Api, client);
        var update = Kit.Update("page");
        var cases = new (string Name, HttpClient Client, Guid Page, object Body)[]
        {
            ("no such page", ws.Client, Guid.NewGuid(), RealtimeKit.Push((Guid.CreateVersion7(), update))),
            ("another workspace's", stranger.Client, page, RealtimeKit.Push((Guid.CreateVersion7(), update))),
            ("read-only", member.Client, viewed, RealtimeKit.Push((Guid.CreateVersion7(), update))),
            ("deleted for good", ws.Client, deleted, RealtimeKit.Push((Guid.CreateVersion7(), update))),
            ("another epoch", ws.Client, page, RealtimeKit.Push(3, 1, (Guid.CreateVersion7(), update))),
            ("an older app", ws.Client, newer, RealtimeKit.Push(0, 1, (Guid.CreateVersion7(), update))),
            ("no updates", ws.Client, page, RealtimeKit.Push()),
            ("an empty update", ws.Client, page, RealtimeKit.Push((Guid.CreateVersion7(), Array.Empty<byte>()))),
            ("an update over 1 MB", ws.Client, page, RealtimeKit.Push((Guid.CreateVersion7(), new byte[1024 * 1024 + 1]))),
        };
        var failures = new List<string>();
        try
        {
            foreach (var (name, client, target, body) in cases)
            {
                var http = await client.PostAsJsonAsync($"/api/v1/pages/{target}/doc/updates", body);
                var problem = await Kit.Json(http);
                var (status, code, title) = await (await HubOf(client)).Refused("PushUpdates", target.ToString(), body);
                var expected = $"{(int)http.StatusCode} {problem.GetProperty("code").GetString()} {problem.GetProperty("title").GetString()}";
                if (expected != $"{status} {code} {title}") failures.Add($"{name}: HTTP {expected}, hub {status} {code} {title}");
            }
            // The hub carries 1 MB a call; the client sends anything larger over HTTP.
            var big = RealtimeKit.Push((Guid.CreateVersion7(), new byte[700 * 1024]), (Guid.CreateVersion7(), new byte[700 * 1024]));
            var hubRefusal = await (await HubOf(ws.Client)).Refused("PushUpdates", page.ToString(), big);
            Assert.Equal((413, "limit.size"), (hubRefusal.Status, hubRefusal.Code));
            var malformed = await (await HubOf(ws.Client)).Refused("PushUpdates", page.ToString(), new { epoch = "zero" });
            Assert.Equal((400, "request.invalid"), (malformed.Status, malformed.Code));
            // And what passes is stored as an HTTP push is: the next sequence, the validated head.
            var ok = await (await HubOf(ws.Client)).Ok("PushUpdates", page.ToString(), RealtimeKit.Push((Guid.CreateVersion7(), update)));
            Assert.Equal(1, ok.GetProperty("acks")[0].GetProperty("seq").GetInt64());
            Assert.Equal(0, ok.GetProperty("headSeq").GetInt64());
            var again = await Kit.Json(await Kit.Push(ws.Client, page, update));
            Assert.Equal(2, again.GetProperty("acks")[0].GetProperty("seq").GetInt64());
        }
        finally
        {
            foreach (var hub in hubs.Values) await hub.DisposeAsync();
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public async Task The_hubs_push_budget_is_the_push_buckets_size_and_refuses_as_the_bucket_does()
    {
        await using var api = server.Variant(b => b.UseSetting("RateLimits:push", "2"));
        var ws = await Ws.Create(server);
        var page = await NewPage(ws, "Budget");
        var client = await RealtimeKit.SignedIn(api, ws.Account);
        await using var hub = await HubClient.Connect(api, client);
        for (var i = 0; i < 2; i++) await hub.Ok("PushUpdates", page.ToString(), RealtimeKit.Push((Guid.CreateVersion7(), Kit.Update("page"))));
        var answer = await hub.Call("PushUpdates", page.ToString(), RealtimeKit.Push((Guid.CreateVersion7(), Kit.Update("page"))));
        Assert.False(answer.GetProperty("ok").GetBoolean());
        Assert.Equal(429, answer.GetProperty("status").GetInt32());
        Assert.Equal("limit.rate", answer.GetProperty("code").GetString());
        Assert.True(answer.GetProperty("retryAfterMs").GetInt64() > 0);
        // Over HTTP the bucket of the same size is counted apart, and refuses the same way.
        for (var i = 0; i < 2; i++) await Kit.PushOk(client, page, Kit.Update("page"));
        var refused = await Kit.Push(client, page, Kit.Update("page"));
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        var problem = await Kit.Json(refused);
        Assert.Equal(answer.GetProperty("code").GetString(), problem.GetProperty("code").GetString());
        Assert.Equal(answer.GetProperty("title").GetString(), problem.GetProperty("title").GetString());
        Assert.NotNull(refused.Headers.RetryAfter);
    }

    [Fact]
    public async Task Updates_are_relayed_only_once_the_worker_has_validated_them_in_contiguous_frames()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await NewPage(ws, "Live");
        await Kit.Register(ws.Client, ws.Id);
        await using var mine = await HubClient.Connect(server.Api, ws.Client);
        await using var theirs = await HubClient.Connect(server.Api, member.Client);
        var joined = await theirs.Ok("JoinPage", page.ToString());
        Assert.Equal(0, joined.GetProperty("headSeq").GetInt64());
        Assert.Equal(0, joined.GetProperty("epoch").GetInt32());
        Assert.Equal(ws.Id, joined.GetProperty("workspaceId").GetGuid());
        await mine.Ok("JoinPage", page.ToString());

        var first = Guid.CreateVersion7();
        var pushed = await mine.Ok("PushUpdates", page.ToString(), RealtimeKit.Push((first, Kit.Update("page"))));
        Assert.Equal(1, pushed.GetProperty("acks")[0].GetProperty("seq").GetInt64());
        // Pending: nobody is given it before the worker has passed it (Q20).
        await NothingWhilePending(theirs, ws, page);
        var clock = Stopwatch.StartNew();
        await server.RunJob<ValidateJob>();
        var frame = await HubClient.Next(theirs.Updates);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3), $"The frame took {clock.Elapsed}");
        Assert.Equal(page, frame.GetProperty("pageId").GetGuid());
        Assert.Equal(0, frame.GetProperty("epoch").GetInt32());
        Assert.Equal(0, frame.GetProperty("after").GetInt64());
        Assert.Equal(1, frame.GetProperty("cursor").GetInt64());
        Assert.Equal(1, frame.GetProperty("headSeq").GetInt64());
        Assert.True(frame.GetProperty("complete").GetBoolean());
        Assert.Empty(frame.GetProperty("rejected").EnumerateArray());
        var relayed = Assert.Single(frame.GetProperty("updates").EnumerateArray());
        Assert.Equal(1, relayed.GetProperty("seq").GetInt64());
        Assert.Equal(first, relayed.GetProperty("updateId").GetGuid());
        Assert.Equal(Convert.ToBase64String(Kit.Update("page")), relayed.GetProperty("data").GetString());
        // The pusher's own connection has it too (it knows its update by its id).
        Assert.Equal(1, (await HubClient.Next(mine.Updates)).GetProperty("cursor").GetInt64());

        // An edit through the hub, a forgery through HTTP: one frame on from the last, the forgery
        // listed as refused and never served.
        var edit = Guid.CreateVersion7();
        var forged = Guid.CreateVersion7();
        await mine.Ok("PushUpdates", page.ToString(), RealtimeKit.Push((edit, Kit.Update("edit"))));
        await Kit.PushOk(ws.Client, page, Kit.Update("forged"));
        var forgedRow = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates",
            RealtimeKit.Push((forged, Kit.Update("forged")))));
        Assert.Equal(4, forgedRow.GetProperty("acks")[0].GetProperty("seq").GetInt64());
        await NothingWhilePending(theirs, ws, page);
        await server.RunJob<ValidateJob>();
        // One frame here; more only if another test's validation pass took some of them first.
        var frames = new List<JsonElement>();
        while (frames.Count == 0 || frames[^1].GetProperty("cursor").GetInt64() < 4) frames.Add(await HubClient.Next(theirs.Updates));
        var at = frame.GetProperty("cursor").GetInt64();
        foreach (var next in frames)
        {
            Assert.Equal(at, next.GetProperty("after").GetInt64());
            Assert.True(next.GetProperty("complete").GetBoolean());
            at = next.GetProperty("cursor").GetInt64();
        }
        Assert.Equal(4, at);
        var served = frames.SelectMany(f => f.GetProperty("updates").EnumerateArray()).ToList();
        Assert.Equal([2L], served.Select(u => u.GetProperty("seq").GetInt64()));
        Assert.Equal(edit, served[0].GetProperty("updateId").GetGuid());
        var refused = frames.SelectMany(f => f.GetProperty("rejected").EnumerateArray()).Select(r => r.GetGuid()).ToList();
        Assert.Equal(2, refused.Count);
        Assert.Contains(forged, refused);

        // Left: no more frames.
        await theirs.Ok("LeavePage", page.ToString());
        await Kit.PushOk(ws.Client, page, Kit.Update("editAgain"));
        await server.RunJob<ValidateJob>();
        await HubClient.Next(mine.Updates, f => f.GetProperty("cursor").GetInt64() == 5);
        await HubClient.None(theirs.Updates, Quiet);
    }

    /// <summary>
    /// Nothing is relayed before this test runs the worker, unless another test's validation pass
    /// (tests run side by side) passed it first: whatever came early carries only rows the worker
    /// marked valid, and is left for the test to read.
    /// </summary>
    private async Task NothingWhilePending(HubClient hub, Ws ws, Guid page)
    {
        await Task.Delay(Quiet);
        if (!hub.Updates.Reader.TryPeek(out var frame)) return;
        var seqs = frame.GetProperty("updates").EnumerateArray().Select(u => u.GetProperty("seq").GetInt64()).ToList();
        await using var db = server.NewDb(ws.Id);
        var valid = await db.PageDocUpdates.AsNoTracking().CountAsync(u => u.PageId == page && seqs.Contains(u.Seq) && u.Status == UpdateStatus.Valid);
        Assert.True(valid == seqs.Count, $"Relayed before the worker passed it: {frame}");
    }

    [Fact]
    public async Task A_frame_whose_rows_a_compaction_removed_says_pull_instead()
    {
        await using var api = RealtimeKit.Manual(server);
        var relay = RealtimeKit.Relay(api);
        var ws = await Ws.Create(server);
        var page = await NewPage(ws, "Compacted");
        await Kit.Register(ws.Client, ws.Id);
        await using var hub = await HubClient.Connect(api, await RealtimeKit.SignedIn(api, ws.Account));
        await hub.Ok("JoinPage", page.ToString());

        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        await relay.PassAsync();
        var whole = await HubClient.Next(hub.Updates);
        Assert.True(whole.GetProperty("complete").GetBoolean());
        Assert.Equal(1, whole.GetProperty("cursor").GetInt64());

        await Kit.PushOk(ws.Client, page, Kit.Update("edit"));
        await Kit.PushOk(ws.Client, page, Kit.Update("forged"));
        await server.RunJob<ValidateJob>();
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            await Kit.Job<CompactJob>(server).CompactAsync(db, page, CancellationToken.None);
            return true;
        });
        await relay.PassAsync();
        var gap = await HubClient.Next(hub.Updates);
        Assert.False(gap.GetProperty("complete").GetBoolean());
        Assert.Equal(1, gap.GetProperty("after").GetInt64());
        Assert.Equal(3, gap.GetProperty("cursor").GetInt64());
        Assert.Empty(gap.GetProperty("updates").EnumerateArray());
        // The pull it sends the client to has it all, from the snapshot.
        var pulled = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after=1");
        Assert.Equal(3, pulled.GetProperty("cursor").GetInt64());
        Assert.Equal(JsonValueKind.Object, pulled.GetProperty("snapshot").ValueKind);
        // Nothing moved: nothing more.
        await relay.PassAsync();
        await HubClient.None(hub.Updates, Quiet);
    }

    [Fact]
    public async Task A_hard_restore_sends_a_frame_of_the_new_epoch_that_says_pull()
    {
        await using var api = RealtimeKit.Manual(server);
        var relay = RealtimeKit.Relay(api);
        var ws = await Ws.Create(server);
        var page = await NewPage(ws, "Restored");
        await Kit.Register(ws.Client, ws.Id);
        await using var hub = await HubClient.Connect(api, await RealtimeKit.SignedIn(api, ws.Account));
        await hub.Ok("JoinPage", page.ToString());
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        var version = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { name = "Hello" }));
        await server.RunJob<SnapshotJob>();
        await relay.PassAsync();
        Assert.Equal(0, (await HubClient.Next(hub.Updates)).GetProperty("epoch").GetInt32());

        var restore = await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions/{version.GetProperty("id").GetGuid()}/restore", new { mode = "hard" });
        Assert.Equal(HttpStatusCode.Accepted, restore.StatusCode);
        await server.RunJob<HardRestoreJob>();
        await relay.PassAsync();
        var frame = await HubClient.Next(hub.Updates);
        Assert.Equal(1, frame.GetProperty("epoch").GetInt32());
        Assert.Equal(0, frame.GetProperty("after").GetInt64());
        Assert.False(frame.GetProperty("complete").GetBoolean());
        Assert.Empty(frame.GetProperty("updates").EnumerateArray());
    }

    [Fact]
    public async Task One_connection_works_in_pages_of_several_workspaces()
    {
        var one = await Ws.Create(server);
        var two = await Ws.Create(server);
        var person = await Kit.Join(server, one, "member");
        await Kit.Join(server, two, "member", person);
        var first = await NewPage(one, "In one");
        var second = await NewPage(two, "In two");
        await using var hub = await HubClient.Connect(server.Api, person.Client);
        Assert.Equal(2, (await hub.Ok("JoinWorkspaces", new[] { one.Id, two.Id })).GetArrayLength());
        foreach (var page in new[] { first, second, first })
        {
            await hub.Ok("JoinPage", page.ToString());
            await hub.Ok("PushUpdates", page.ToString(), RealtimeKit.Push((Guid.CreateVersion7(), Kit.Update("page"))));
            await hub.Ok("Awareness", page.ToString(), new { clientId = 7, cursor = (object?)null });
        }
        Assert.Equal(two.Id, (await hub.Ok("JoinPage", second.ToString())).GetProperty("workspaceId").GetGuid());
    }

    [Fact]
    public async Task Presence_is_stamped_by_the_server_validated_exactly_limited_and_never_kept_past_a_leave()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await NewPage(ws, "Cursors");
        var elsewhere = await NewPage(ws, "Elsewhere");
        await using var mine = await HubClient.Connect(server.Api, ws.Client);
        await using var theirs = await HubClient.Connect(server.Api, member.Client);
        await mine.Ok("JoinPage", page.ToString());
        var joined = await theirs.Ok("JoinPage", page.ToString());
        var present = Assert.Single(joined.GetProperty("presence").EnumerateArray());
        Assert.Equal(ws.Account.Id, present.GetProperty("userId").GetGuid());
        Assert.Equal(JsonValueKind.Null, present.GetProperty("state").ValueKind);

        var state = new { clientId = 1001, cursor = new { anchor = "AQIDBA==", head = "AQIDBQ==" } };
        await mine.Ok("Awareness", page.ToString(), state);
        var seen = await HubClient.Next(theirs.Awareness, m => m.GetProperty("state").ValueKind == JsonValueKind.Object);
        Assert.Equal(ws.Account.Id, seen.GetProperty("userId").GetGuid());
        Assert.Equal(page, seen.GetProperty("pageId").GetGuid());
        var presenceId = seen.GetProperty("presenceId").GetString()!;
        Assert.False(string.IsNullOrEmpty(presenceId));
        Assert.NotEqual(mine.Connection.ConnectionId, presenceId);
        Assert.Equal(present.GetProperty("presenceId").GetString(), presenceId);
        Assert.Equal(1001, seen.GetProperty("state").GetProperty("clientId").GetInt64());
        Assert.Equal("AQIDBA==", seen.GetProperty("state").GetProperty("cursor").GetProperty("anchor").GetString());
        // Never back to its sender.
        await HubClient.None(mine.Awareness, Quiet, m => m.GetProperty("userId").GetGuid() == ws.Account.Id);
        // Someone who joins later is given it at once, never stored anywhere else.
        await using (var later = await HubClient.Connect(server.Api, member.Client))
        {
            var told = (await later.Ok("JoinPage", page.ToString())).GetProperty("presence").EnumerateArray()
                .Single(p => p.GetProperty("userId").GetGuid() == ws.Account.Id);
            Assert.Equal(1001, told.GetProperty("state").GetProperty("clientId").GetInt64());
        }

        // These keys only, and no one names themselves.
        Assert.Equal((400, "request.invalid"), Short(await mine.Refused("Awareness", page.ToString(), new { clientId = 1, cursor = (object?)null, userId = member.Id })));
        Assert.Equal((400, "request.invalid"), Short(await mine.Refused("Awareness", page.ToString(), new { clientId = -1, cursor = (object?)null })));
        Assert.Equal((400, "request.invalid"), Short(await mine.Refused("Awareness", page.ToString(), new { clientId = 1.5, cursor = (object?)null })));
        Assert.Equal((400, "request.invalid"), Short(await mine.Refused("Awareness", page.ToString(), new { cursor = (object?)null })));
        Assert.Equal((400, "request.invalid"), Short(await mine.Refused("Awareness", page.ToString(), new { clientId = 1, cursor = new { anchor = "not base64!", head = "AQID" } })));
        Assert.Equal((400, "request.invalid"), Short(await mine.Refused("Awareness", page.ToString(), new { clientId = 1, cursor = new { anchor = new string('A', 260), head = "AQID" } })));
        Assert.Equal((400, "request.invalid"), Short(await mine.Refused("Awareness", page.ToString(), new { clientId = 1, cursor = new { anchor = "AQID", head = "AQID", name = "x" } })));
        Assert.Equal((413, "limit.size"), Short(await mine.Refused("Awareness", page.ToString(), new { clientId = 1, cursor = (object?)null, pad = new string('x', 1100) })));
        // A page not joined.
        Assert.Equal((404, "not.found"), Short(await mine.Refused("Awareness", elsewhere.ToString(), state)));

        // 20 a second a connection: past that, dropped.
        await Task.Delay(1100);
        var answers = await Task.WhenAll(Enumerable.Range(0, 40).Select(_ => mine.Call("Awareness", page.ToString(), state)));
        var limited = answers.Where(a => !a.GetProperty("ok").GetBoolean()).ToList();
        Assert.NotEmpty(limited);
        Assert.All(limited, a =>
        {
            Assert.Equal(429, a.GetProperty("status").GetInt32());
            Assert.Equal("limit.rate", a.GetProperty("code").GetString());
            Assert.True(a.GetProperty("retryAfterMs").GetInt64() > 0);
        });
        Assert.True(answers.Count(a => a.GetProperty("ok").GetBoolean()) <= 20);

        // Leaving tells the others, with the same presence id.
        HubClient.Drain(theirs.Awareness);
        await mine.Ok("LeavePage", page.ToString());
        var left = await HubClient.Next(theirs.Awareness, m => m.GetProperty("state").ValueKind == JsonValueKind.Null);
        Assert.Equal(presenceId, left.GetProperty("presenceId").GetString());
        Assert.Equal(ws.Account.Id, left.GetProperty("userId").GetGuid());
        // And so does going away.
        await mine.Ok("JoinPage", page.ToString());
        HubClient.Drain(theirs.Awareness);
        await mine.Connection.StopAsync();
        var gone = await HubClient.Next(theirs.Awareness, m => m.GetProperty("state").ValueKind == JsonValueKind.Null);
        Assert.Equal(ws.Account.Id, gone.GetProperty("userId").GetGuid());
    }

    private static (int, string) Short((int Status, string Code, string Title) refusal) => (refusal.Status, refusal.Code);

    [Fact]
    public async Task An_access_change_in_the_feed_takes_a_page_away_at_once()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await NewPage(ws, "Soon restricted");
        await Kit.Register(ws.Client, ws.Id);
        await using var theirs = await HubClient.Connect(server.Api, member.Client);
        await using var mine = await HubClient.Connect(server.Api, ws.Client);
        await theirs.Ok("JoinWorkspaces", new[] { ws.Id });
        await theirs.Ok("JoinPage", page.ToString());
        await mine.Ok("JoinPage", page.ToString());

        // The re-check is every 60 seconds; the feed's access change makes it now.
        var clock = Stopwatch.StartNew();
        await Kit.Share(ws, page, true);
        var revoked = await HubClient.Next(theirs.Revoked);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(20), $"Revoked after {clock.Elapsed}");
        Assert.Equal(ws.Id, revoked.GetProperty("workspaceId").GetGuid());
        Assert.Equal(page, revoked.GetProperty("pageId").GetGuid());
        Assert.Equal("access.denied", revoked.GetProperty("reason").GetString());
        // The owner's connection is told the presence went.
        await HubClient.Next(mine.Awareness, m => m.GetProperty("userId").GetGuid() == member.Id && m.GetProperty("state").ValueKind == JsonValueKind.Null);

        // A revoked reader stops receiving updates and presence.
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        await HubClient.Next(mine.Updates);
        await mine.Ok("Awareness", page.ToString(), new { clientId = 1001, cursor = (object?)null });
        await HubClient.None(theirs.Updates, Quiet);
        await HubClient.None(theirs.Awareness, Quiet, m => m.GetProperty("state").ValueKind == JsonValueKind.Object);
        // And cannot join it again.
        Assert.Equal((404, "not.found"), Short(await theirs.Refused("JoinPage", page.ToString())));

        // Removed from the workspace: the whole workspace goes.
        var other = await NewPage(ws, "Still open");
        await theirs.Ok("JoinPage", other.ToString());
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{member.Id}")).StatusCode);
        var removed = await HubClient.Next(theirs.Revoked, r => r.GetProperty("reason").GetString() == "member.removed");
        Assert.Equal(ws.Id, removed.GetProperty("workspaceId").GetGuid());
        Assert.Equal(JsonValueKind.Null, removed.GetProperty("pageId").ValueKind);
        // A relay pass that began before the removal may still tell them of it; nothing after.
        await Task.Delay(300);
        HubClient.Drain(theirs.Changes);
        await ws.NewPage("After they left");
        await HubClient.None(theirs.Changes, Quiet);
    }

    [Fact]
    public async Task Access_lost_without_a_feed_change_is_found_within_the_re_check()
    {
        await using var api = server.Variant(b => b.UseSetting("Realtime:RecheckSeconds", "1").UseSetting("Realtime:SweepSeconds", "1"));
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await NewPage(ws, "Theirs alone");
        await Kit.Share(ws, page, true, ("user", member.Id, "edit"));
        await using var hub = await HubClient.Connect(api, await RealtimeKit.SignedIn(api, member));
        await hub.Ok("JoinPage", page.ToString());
        // Taken away behind the feed's back: only the re-check can see it.
        await using (var db = server.NewDb(ws.Id))
            await db.PagePermissions.Where(r => r.PageId == page && r.PrincipalId == member.Id).ExecuteDeleteAsync();
        var revoked = await HubClient.Next(hub.Revoked, TimeSpan.FromSeconds(15));
        Assert.Equal(page, revoked.GetProperty("pageId").GetGuid());
        Assert.Equal("access.denied", revoked.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task A_signed_out_device_has_its_connection_closed()
    {
        var ws = await Ws.Create(server);
        var page = await NewPage(ws, "Open");
        await using var hub = await HubClient.Connect(server.Api, ws.Client);
        await hub.Ok("JoinWorkspaces", new[] { ws.Id });
        await hub.Ok("JoinPage", page.ToString());
        var device = (await ws.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("deviceId").GetString();
        var other = server.Anonymous();
        await ServerFixture.SignIn(other, ws.Account.Email, ws.Account.Password);
        Assert.Equal(HttpStatusCode.NoContent, (await other.DeleteAsync($"/api/v1/account/devices/{device}")).StatusCode);
        var revoked = await HubClient.Next(hub.Revoked);
        Assert.Equal("session.ended", revoked.GetProperty("reason").GetString());
        Assert.Equal(ws.Id, revoked.GetProperty("workspaceId").GetGuid());
        await hub.Closed.Task.WaitAsync(HubClient.Wait);
    }

    [Fact]
    public async Task Followers_are_told_the_feed_moved_and_who_has_a_page_open_if_they_may_read_it()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var page = await NewPage(ws, "Busy");
        await using var theirs = await HubClient.Connect(server.Api, member.Client);
        await using var guests = await HubClient.Connect(server.Api, guest.Client);
        var followed = (await theirs.Ok("JoinWorkspaces", new[] { ws.Id }))[0];
        await guests.Ok("JoinWorkspaces", new[] { ws.Id });
        await using var mine = await HubClient.Connect(server.Api, ws.Client);
        await mine.Ok("JoinPage", page.ToString());

        var presence = await HubClient.Next(theirs.Presence, p => p.GetProperty("pageId").GetGuid() == page);
        Assert.Equal(ws.Id, presence.GetProperty("workspaceId").GetGuid());
        Assert.Equal([ws.Account.Id], presence.GetProperty("userIds").EnumerateArray().Select(u => u.GetGuid()));
        // A guest cannot read the page: told nothing of it.
        await HubClient.None(guests.Presence, Quiet);
        // Who joins the workspace later is given it in the answer, if they may read the page.
        await using (var later = await HubClient.Connect(server.Api, member.Client))
        {
            var open = (await later.Ok("JoinWorkspaces", new[] { ws.Id }))[0].GetProperty("presence").EnumerateArray()
                .Single(p => p.GetProperty("pageId").GetGuid() == page);
            Assert.Equal([ws.Account.Id], open.GetProperty("userIds").EnumerateArray().Select(u => u.GetGuid()));
        }
        Assert.Empty((await guests.Ok("JoinWorkspaces", new[] { ws.Id }))[0].GetProperty("presence").EnumerateArray());
        // Leaving: the page is empty again.
        await mine.Ok("LeavePage", page.ToString());
        var empty = await HubClient.Next(theirs.Presence, p => p.GetProperty("pageId").GetGuid() == page && p.GetProperty("userIds").GetArrayLength() == 0);
        Assert.Equal(page, empty.GetProperty("pageId").GetGuid());

        // The feed moved: followers are told, with the new head.
        var seq = followed.GetProperty("seq").GetInt64();
        await ws.NewPage("Another");
        var moved = await HubClient.Next(theirs.Changes, c => c.GetProperty("seq").GetInt64() > seq);
        Assert.Equal(ws.Id, moved.GetProperty("workspaceId").GetGuid());
        await HubClient.Next(guests.Changes, c => c.GetProperty("seq").GetInt64() > seq);
    }

    [Fact]
    public async Task A_device_keeps_at_most_20_connections_and_the_oldest_goes()
    {
        var account = await server.NewAccount();
        var hubs = new List<HubClient>();
        try
        {
            for (var i = 0; i < 21; i++) hubs.Add(await HubClient.Connect(server.Api, account.Client));
            await hubs[0].Closed.Task.WaitAsync(HubClient.Wait);
            await Task.Delay(300);
            Assert.All(hubs.Skip(1), h => Assert.False(h.Closed.Task.IsCompleted));
            Assert.Equal(Microsoft.AspNetCore.SignalR.Client.HubConnectionState.Connected, hubs[20].Connection.State);
        }
        finally
        {
            foreach (var hub in hubs) await hub.DisposeAsync();
        }
    }

    [Fact]
    public async Task The_benchs_metrics_are_there_only_when_asked_for_and_time_the_relay()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await server.Anonymous().GetAsync("/api/v1/realtime/metrics")).StatusCode);
        await using var api = RealtimeKit.Manual(server, ("Realtime:Metrics", "true"));
        var relay = RealtimeKit.Relay(api);
        var ws = await Ws.Create(server);
        var page = await NewPage(ws, "Timed");
        await Kit.Register(ws.Client, ws.Id);
        var client = await RealtimeKit.SignedIn(api, ws.Account);
        await using var hub = await HubClient.Connect(api, client);
        await hub.Ok("JoinPage", page.ToString());
        var reader = ServerFixture.ClientOf(api);
        Assert.Equal(HttpStatusCode.NoContent, (await reader.DeleteAsync("/api/v1/realtime/metrics")).StatusCode);
        await hub.Ok("PushUpdates", page.ToString(), RealtimeKit.Push((Guid.CreateVersion7(), Kit.Update("page"))));
        await server.RunJob<ValidateJob>();
        await relay.PassAsync();
        await HubClient.Next(hub.Updates);
        var metrics = await reader.GetFromJsonAsync<JsonElement>("/api/v1/realtime/metrics");
        Assert.True(metrics.GetProperty("connections").GetInt32() >= 1);
        Assert.True(metrics.GetProperty("pages").GetInt32() >= 1);
        var relayed = metrics.GetProperty("relayed");
        Assert.Equal(1, relayed.GetProperty("count").GetInt64());
        Assert.True(relayed.GetProperty("maxMs").GetDouble() > 0);
        Assert.Equal(HttpStatusCode.NoContent, (await reader.DeleteAsync("/api/v1/realtime/metrics")).StatusCode);
        Assert.Equal(0, (await reader.GetFromJsonAsync<JsonElement>("/api/v1/realtime/metrics")).GetProperty("relayed").GetProperty("count").GetInt64());
    }
}
