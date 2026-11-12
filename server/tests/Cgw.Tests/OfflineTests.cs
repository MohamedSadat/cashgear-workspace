using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Cgw.Ydoc;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace Cgw.Tests;

/// <summary>
/// Phase 3's server half (Phase 3 contracts, sections 2 and 4): the state hash and the repair path,
/// Retry-After, the change feed's and the trash's retention, the 30-day session, document schema
/// version 2, and edits to a page in the trash.
/// </summary>
public sealed class OfflineTests(ServerFixture server)
{
    private static readonly Lazy<Dictionary<string, Fixture>> Schema2 = new(() =>
        JsonSerializer.Deserialize<List<Fixture>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "schema2.json")),
                new JsonSerializerOptions(JsonSerializerDefaults.Web))!
            .ToDictionary(f => f.Name));

    private static byte[] V2(string name) => Schema2.Value[name].Bytes;

    private static Task<HttpResponseMessage> Push(HttpClient client, Guid page, byte[] data, int clientSchemaVersion, Guid? id = null, int epoch = 0) =>
        client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch,
            clientSchemaVersion,
            updates = new[] { new { updateId = id ?? Guid.CreateVersion7(), data } },
        });

    private static Task<HttpResponseMessage> Repair(HttpClient client, Guid page, byte[]? state, int epoch = 0, int clientSchemaVersion = 1) =>
        client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/repair", new
        {
            epoch,
            clientSchemaVersion,
            update = state is null ? null : new { updateId = Guid.CreateVersion7(), data = state },
        });

    private static async Task<JsonElement> StateHash(HttpClient client, Guid page) =>
        await client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc/state-hash");

    /// <summary>The updates of a pull answer, merged, as a device holds them (no snapshot in these tests).</summary>
    private static byte[] Merged(JsonElement pull) =>
        Yjs.Merge(pull.GetProperty("updates").EnumerateArray().Select(u => Convert.FromBase64String(u.GetProperty("data").GetString()!)).ToList());

    private async Task<Page> PageRow(Guid workspace, Guid page)
    {
        await using var db = server.NewDb(workspace);
        return await db.Pages.AsNoTracking().SingleAsync(p => p.Id == page);
    }

    // ------------------------------------------------------------------ state hash and repair

    [Fact]
    public async Task The_worker_publishes_the_state_hash_of_each_head_it_moves()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Hashed")).GetProperty("id").GetGuid();
        await Kit.Register(ws.Client, ws.Id);
        var empty = await StateHash(ws.Client, page);
        Assert.Equal(0, empty.GetProperty("upToSeq").GetInt64());
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("hash").ValueKind);

        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        // Pushed, not yet decided: the head has not moved, so neither has the hash.
        Assert.Equal(0, (await StateHash(ws.Client, page)).GetProperty("upToSeq").GetInt64());
        await server.RunJob<ValidateJob>();
        var first = await StateHash(ws.Client, page);
        Assert.Equal(1, first.GetProperty("upToSeq").GetInt64());
        Assert.Equal(0, first.GetProperty("epoch").GetInt32());
        Assert.Equal(Yjs.StateHash(Kit.Update("page")), first.GetProperty("hash").GetString());

        await Kit.PushOk(ws.Client, page, Kit.Update("edit"));
        // A refused update moves the head and leaves the state, so the hash, as it was.
        await Kit.PushOk(ws.Client, page, Kit.Update("forged"));
        await server.RunJob<ValidateJob>();
        var second = await StateHash(ws.Client, page);
        Assert.Equal(3, second.GetProperty("upToSeq").GetInt64());
        Assert.Equal(Yjs.StateHash(Yjs.Merge([Kit.Update("page"), Kit.Update("edit")])), second.GetProperty("hash").GetString());
        Assert.NotEqual(first.GetProperty("hash").GetString(), second.GetProperty("hash").GetString());
        // Not a member: as for a pull, no such page.
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/pages/{page}/doc/state-hash")).StatusCode);
    }

    [Fact]
    public async Task A_page_whose_head_has_no_hash_gets_one_from_the_hash_job()
    {
        var ws = await Ws.Create(server);
        var page = await Kit.PageWithText(server, ws);
        // As a page last edited before the worker wrote hashes.
        await using (var db = server.NewDb(ws.Id))
            await db.Pages.Where(p => p.Id == page).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocStateHash, (string?)null).SetProperty(p => p.DocStateHashSeq, 0L));
        Assert.Equal(JsonValueKind.Null, (await StateHash(ws.Client, page)).GetProperty("hash").ValueKind);
        await Kit.InWorker(server, ws.Id, async (services, db) =>
        {
            await Kit.Job<StateHashJob>(server).HashAsync(db, page, CancellationToken.None);
            return true;
        });
        Assert.Equal(Yjs.StateHash(Yjs.Merge([Kit.Update("page"), Kit.Update("edit")])), (await StateHash(ws.Client, page)).GetProperty("hash").GetString());
    }

    [Fact]
    public async Task A_device_missing_an_update_repairs_and_gets_everything_back()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws);
        var server_ = await StateHash(member.Client, page);
        // The member's device holds only the first update: its hash differs at the same head.
        var mine = Kit.Update("page");
        Assert.NotEqual(server_.GetProperty("hash").GetString(), Yjs.StateHash(mine));

        var repaired = await Repair(member.Client, page, mine);
        Assert.True(repaired.IsSuccessStatusCode, await repaired.Content.ReadAsStringAsync());
        var body = await Kit.Json(repaired);
        // Its full state stored as one pending update, numbered like any push...
        Assert.Equal(3, body.GetProperty("ack").GetProperty("seq").GetInt64());
        // ...and the page from the start, which gives it what it lacked.
        var pull = body.GetProperty("pull");
        Assert.Equal(2, pull.GetProperty("headSeq").GetInt64());
        Assert.Equal(server_.GetProperty("hash").GetString(), Yjs.StateHash(Yjs.Merge([mine, Merged(pull)])));

        // The worker passes it (it holds nothing new), and the hash at the new head is unchanged.
        await server.RunJob<ValidateJob>();
        var after = await StateHash(member.Client, page);
        Assert.Equal(3, after.GetProperty("upToSeq").GetInt64());
        Assert.Equal(server_.GetProperty("hash").GetString(), after.GetProperty("hash").GetString());
    }

    [Fact]
    public async Task A_repair_holding_another_authors_structs_passes_and_one_adding_to_them_does_not()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Two authors")).GetProperty("id").GetGuid();
        // Each writes as their own Yjs client: the owner 1001, the member 1002.
        await Kit.Register(ws.Client, ws.Id, 1001);
        await Kit.Register(member.Client, ws.Id, 1002);
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await Kit.PushOk(member.Client, page, Kit.Update("edit"));
        await server.RunJob<ValidateJob>();
        await using (var check = server.NewDb(ws.Id))
            Assert.All(await check.PageDocUpdates.AsNoTracking().Where(u => u.PageId == page).ToListAsync(),
                u => Assert.True(u.Status == UpdateStatus.Valid, u.Problem));
        var before = await StateHash(ws.Client, page);

        // The owner's other device repairs with its whole state, the member's struct in it.
        var whole = Yjs.Merge([Kit.Update("page"), Kit.Update("edit")]);
        var repaired = await Repair(ws.Client, page, whole);
        Assert.True(repaired.IsSuccessStatusCode, await repaired.Content.ReadAsStringAsync());
        var id = (await Kit.Json(repaired)).GetProperty("ack").GetProperty("updateId").GetGuid();
        await server.RunJob<ValidateJob>();
        var pulled = await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after=2");
        Assert.Contains(id, pulled.GetProperty("updates").EnumerateArray().Select(u => u.GetProperty("updateId").GetGuid()));
        var after = await StateHash(ws.Client, page);
        Assert.Equal(3, after.GetProperty("upToSeq").GetInt64());
        Assert.Equal(before.GetProperty("hash").GetString(), after.GetProperty("hash").GetString());

        // A repair that adds a struct written as the member's client is refused, and audited.
        var forged = await Repair(ws.Client, page, Yjs.Merge([whole, Kit.Update("editAgain")]));
        var forgedId = (await Kit.Json(forged)).GetProperty("ack").GetProperty("updateId").GetGuid();
        await server.RunJob<ValidateJob>();
        Assert.Contains(forgedId, (await Kit.Json(await ws.Client.GetAsync($"/api/v1/pages/{page}/doc?after=3")))
            .GetProperty("rejected").EnumerateArray().Select(r => r.GetGuid()));
        Assert.Equal(before.GetProperty("hash").GetString(), (await StateHash(ws.Client, page)).GetProperty("hash").GetString());
        await using var db = server.NewDb(ws.Id);
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "doc.forgedClient" && a.TargetId == page && a.ActorUserId == ws.Account.Id));
        Assert.False(await db.AuditLog.AnyAsync(a => a.Action == "doc.forgedClient" && a.TargetId == page && a.Detail!.Contains(id.ToString())));
    }

    [Fact]
    public async Task A_reader_repairs_without_pushing_and_an_update_from_them_is_refused()
    {
        var ws = await Ws.Create(server);
        var viewer = await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws);
        await Kit.Share(ws, page, true, ("user", viewer.Id, "view"));

        var read = await Repair(viewer.Client, page, null);
        Assert.True(read.IsSuccessStatusCode, await read.Content.ReadAsStringAsync());
        var body = await Kit.Json(read);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("ack").ValueKind);
        Assert.Contains("Hello world", Yjs.ToText(Merged(body.GetProperty("pull"))));

        var refused = await Repair(viewer.Client, page, Kit.Update("page"));
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(refused));
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(2, await db.PageDocUpdates.CountAsync(u => u.PageId == page));
    }

    [Fact]
    public async Task A_repair_is_checked_as_a_push()
    {
        var ws = await Ws.Create(server);
        var page = await Kit.PageWithText(server, ws);
        var epoch = await Repair(ws.Client, page, Kit.Update("page"), epoch: 4);
        Assert.Equal(HttpStatusCode.Conflict, epoch.StatusCode);
        Assert.Equal("doc.epochMismatch", await Kit.Code(epoch));
        await using (var db = server.NewDb(ws.Id))
            await db.Pages.Where(p => p.Id == page).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSchemaVersion, 2));
        var old = await Repair(ws.Client, page, Kit.Update("page"), clientSchemaVersion: 1);
        Assert.Equal((HttpStatusCode)426, old.StatusCode);
        Assert.Equal("client.tooOld", await Kit.Code(old));
        var big = await Repair(ws.Client, page, new byte[1024 * 1024 + 1], clientSchemaVersion: 2);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
        Assert.Equal("limit.size", await Kit.Code(big));
    }

    // ------------------------------------------------------------------ Retry-After

    [Fact]
    public async Task Too_many_updates_to_one_page_answer_429_with_retry_after()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Busy")).GetProperty("id").GetGuid();
        // The API does not decode updates: a byte each is enough to count.
        var response = await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch = 0,
            clientSchemaVersion = 1,
            updates = Enumerable.Range(0, Cgw.Core.Documents.DocService.PerPagePerMinute + 1)
                .Select(_ => new { updateId = Guid.CreateVersion7(), data = new byte[] { 1 } }).ToArray(),
        });
        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        Assert.Equal("limit.rate", await Kit.Code(response));
        var wait = response.Headers.RetryAfter?.Delta;
        Assert.NotNull(wait);
        Assert.InRange(wait.Value.TotalSeconds, 1, 60);
    }

    [Fact]
    public async Task A_503_says_when_to_try_again()
    {
        // A readiness check that fails, as an unreachable SQL Server or Blob storage would.
        await using var api = server.Variant(b => b.ConfigureTestServices(services =>
            services.AddHealthChecks().AddCheck("down", () => HealthCheckResult.Unhealthy("down for the test"), ["ready"])));
        var response = await ServerFixture.ClientOf(api).GetAsync("/health/ready");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(30), response.Headers.RetryAfter?.Delta);
    }

    // ------------------------------------------------------------------ retention

    [Fact]
    public async Task A_cursor_older_than_the_feed_keeps_answers_410_feed_expired()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        await ws.NewPage("One");
        await ws.NewPage("Two", orderKey: "a1");
        var head = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();

        // 89 days on, nothing goes; 91 days on, everything so far does.
        async Task<int> Prune(int days) => await Kit.InWorker(server, ws.Id, (services, db) =>
            new FeedRetentionJob(new ShiftedClock(TimeSpan.FromDays(days))).PruneAsync(services, db, ws.Id, CancellationToken.None));
        Assert.Equal(0, await Prune(89));
        Assert.Equal((int)head, await Prune(91));
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.Equal(head, (await db.Workspaces.AsNoTracking().SingleAsync(w => w.Id == ws.Id)).ChangesPrunedSeq);
            Assert.Equal(0, await db.WorkspaceChanges.CountAsync());
        }

        var expired = await member.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/changes?after=1");
        Assert.Equal(HttpStatusCode.Gone, expired.StatusCode);
        Assert.Equal("feed.expired", await Kit.Code(expired));
        // A cursor at the mark or past it is fine, and so is one from the tree, which is never older.
        var tree = await ws.Tree(member.Client);
        Assert.Equal(head, tree.GetProperty("cursor").GetInt64());
        Assert.Empty((await ws.Changes(head, member.Client)).GetProperty("changes").EnumerateArray());
        await ws.NewPage("Three", orderKey: "a2");
        var next = await ws.Changes(head, member.Client);
        Assert.Equal(head + 1, Assert.Single(next.GetProperty("changes").EnumerateArray()).GetProperty("seq").GetInt64());
    }

    [Fact]
    public async Task Pages_in_the_trash_for_60_days_are_deleted_for_good_as_a_person_would()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Old")).GetProperty("id").GetGuid();
        var child = (await ws.NewPage("Under it", root)).GetProperty("id").GetGuid();
        var kept = (await ws.NewPage("Restored in time", orderKey: "a1")).GetProperty("id").GetGuid();
        await Kit.Register(ws.Client, ws.Id);
        await Kit.PushOk(ws.Client, child, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        await ws.Push(ws.Op("page.trash", root, new { }, 1));
        await ws.Push(ws.Op("page.trash", kept, new { }, 1));
        await ws.Push(ws.Op("page.restore", kept, new { }));
        var cursor = (await ws.Tree()).GetProperty("cursor").GetInt64();

        async Task<int> Run(int days) => await Kit.InWorker(server, ws.Id, (services, db) =>
            new TrashRetentionJob(new ShiftedClock(TimeSpan.FromDays(days))).DeleteDueAsync(services, db, ws.Id, CancellationToken.None));
        Assert.Equal(0, await Run(59));
        Assert.Equal(1, await Run(61));

        // Tombstones, a feed delete for each, the audit entry; then the purge removes the document.
        var changes = (await ws.Changes(cursor)).GetProperty("changes").EnumerateArray().ToList();
        foreach (var id in new[] { root, child })
            Assert.Contains(changes, c => c.GetProperty("entityId").GetGuid() == id && c.GetProperty("kind").GetString() == "delete");
        Assert.DoesNotContain(changes, c => c.GetProperty("entityId").GetGuid() == kept);
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.Equal(2, await db.Pages.CountAsync(p => (p.Id == root || p.Id == child) && p.DeletedAt != null && p.Title == ""));
            Assert.Null((await db.Pages.SingleAsync(p => p.Id == kept)).DeletedAt);
            var entry = await db.AuditLog.SingleAsync(a => a.Action == "page.purgedByRetention");
            Assert.Equal(root, entry.TargetId);
            Assert.Null(entry.ActorUserId);
        }
        var gone = await Kit.Push(ws.Client, child, Kit.Update("edit"));
        Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
        Assert.Equal("page.gone", await Kit.Code(gone));
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            await Kit.Job<PagePurgeJob>(server).PurgeAsync(db, ws.Id, child, CancellationToken.None);
            return true;
        });
        await using (var db = server.NewDb(ws.Id))
            Assert.Equal(0, await db.PageDocUpdates.CountAsync(u => u.PageId == child));
    }

    // ------------------------------------------------------------------ the session

    [Fact]
    public void The_web_session_lasts_30_days_and_slides()
    {
        var options = server.Api.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>().Get(IdentityConstants.ApplicationScheme);
        Assert.Equal(TimeSpan.FromDays(30), options.ExpireTimeSpan);
        Assert.True(options.SlidingExpiration);
    }

    // ------------------------------------------------------------------ document schema version 2

    [Fact]
    public async Task A_version_2_document_from_a_version_2_app_raises_the_page_and_older_apps_get_426()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Migrated")).GetProperty("id").GetGuid();
        await Kit.Register(ws.Client, ws.Id);
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();

        // The migration from an app that knows version 2.
        var migration = Guid.CreateVersion7();
        Assert.True((await Push(ws.Client, page, V2("migrate"), 2, migration)).IsSuccessStatusCode);
        await server.RunJob<ValidateJob>();
        Assert.Contains(migration, (await Kit.Json(await member.Client.GetAsync($"/api/v1/pages/{page}/doc?after=1")))
            .GetProperty("updates").EnumerateArray().Select(u => u.GetProperty("updateId").GetGuid()));
        var row = await PageRow(ws.Id, page);
        Assert.Equal(2, row.DocSchemaVersion);
        // The feed says so, so older apps open the page read-only.
        Assert.Contains((await ws.Changes(cursor, member.Client)).GetProperty("changes").EnumerateArray(), c =>
            c.GetProperty("entityId").GetGuid() == page && c.GetProperty("entity").GetProperty("page").GetProperty("docSchemaVersion").GetInt32() == 2);

        var old = await Push(member.Client, page, Kit.Update("edit"), 1);
        Assert.Equal((HttpStatusCode)426, old.StatusCode);
        Assert.Equal("client.tooOld", await Kit.Code(old));
        // A version 2 app goes on editing.
        await Kit.Register(member.Client, ws.Id, 7_002);
        await Kit.Register(ws.Client, ws.Id, 1002);
        var typed = Guid.CreateVersion7();
        Assert.True((await Push(ws.Client, page, V2("afterMigration"), 2, typed)).IsSuccessStatusCode);
        await server.RunJob<ValidateJob>();
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(UpdateStatus.Valid, (await db.PageDocUpdates.SingleAsync(u => u.UpdateId == typed)).Status);
    }

    [Fact]
    public async Task A_document_may_rise_only_as_far_as_its_app_and_the_worker_know()
    {
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);

        async Task<(PageDocUpdate Row, Page Page)> Decide(string fixture, int clientSchemaVersion)
        {
            var page = (await ws.NewPage(fixture)).GetProperty("id").GetGuid();
            await Kit.PushOk(ws.Client, page, Kit.Update("page"));
            var id = Guid.CreateVersion7();
            Assert.True((await Push(ws.Client, page, V2(fixture), clientSchemaVersion, id)).IsSuccessStatusCode);
            await server.RunJob<ValidateJob>();
            await using var db = server.NewDb(ws.Id);
            return (await db.PageDocUpdates.AsNoTracking().SingleAsync(u => u.UpdateId == id), await db.Pages.AsNoTracking().SingleAsync(p => p.Id == page));
        }

        // The migration from an app that knows only version 1.
        var (fromOld, oldPage) = await Decide("migrate", 1);
        Assert.Equal(UpdateStatus.Rejected, fromOld.Status);
        Assert.Contains("newer than the app that pushed it", fromOld.Problem);
        Assert.Equal(1, oldPage.DocSchemaVersion);
        // Version 3 from an app that knows only version 2.
        var (three, threePage) = await Decide("claimsV3", 2);
        Assert.Equal(UpdateStatus.Rejected, three.Status);
        Assert.Contains("newer than the app that pushed it", three.Problem);
        Assert.Equal(1, threePage.DocSchemaVersion);
        // A version 2 element in a document still at version 1.
        var (toc, tocPage) = await Decide("tocOnly", 2);
        Assert.Equal(UpdateStatus.Rejected, toc.Status);
        Assert.Contains("tableOfContents", toc.Problem);
        Assert.Equal(1, tocPage.DocSchemaVersion);
        // (Version 4, which this worker does not know: DatabaseTests.)
    }

    // ------------------------------------------------------------------ the trash

    [Fact]
    public async Task Edits_to_a_page_in_the_trash_are_kept_and_there_on_restore()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Binned")).GetProperty("id").GetGuid();
        await Kit.Register(ws.Client, ws.Id);
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        await ws.Push(ws.Op("page.trash", page, new { }, 1));

        // An offline device's edit, pushed after the page went to the trash.
        var late = Guid.CreateVersion7();
        Assert.True((await Push(ws.Client, page, Kit.Update("edit"), 1, late)).IsSuccessStatusCode);
        await server.RunJob<ValidateJob>();
        await ws.Push(ws.Op("page.restore", page, new { }));
        var pull = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after=0");
        Assert.Contains(late, pull.GetProperty("updates").EnumerateArray().Select(u => u.GetProperty("updateId").GetGuid()));
        Assert.Contains("Hello world", Yjs.ToText(Merged(pull)));
    }
}
