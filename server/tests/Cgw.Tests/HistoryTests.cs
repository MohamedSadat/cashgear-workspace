using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>M2.7: version history: named versions, auto snapshots and their retention, the hard restore.</summary>
public sealed class HistoryTests(ServerFixture server)
{
    private static readonly HttpClient Blob = new();

    private static async Task<JsonElement> Version(HttpClient client, Guid page, object body)
    {
        var response = await client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", body);
        var json = await Kit.Json(response);
        Assert.True(response.IsSuccessStatusCode, json.ToString());
        return json;
    }

    /// <summary>A state's text, one block per line.</summary>
    private static string Text(byte[] state) => Yjs.ToText(state).TrimEnd();

    private static async Task<string> TextAt(HttpClient client, Guid page, Guid version)
    {
        var detail = await client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/versions/{version}");
        Assert.Equal("ready", detail.GetProperty("status").GetString());
        return Text(await Blob.GetByteArrayAsync(detail.GetProperty("url").GetString()));
    }

    [Fact]
    public async Task A_version_is_the_page_as_it_was_when_it_was_named()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Minutes")).GetProperty("id").GetGuid();
        await Kit.Register(ws.Client, ws.Id);
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        // Named, then edited before the worker writes it: the version is still "Hello".
        var before = (await Version(ws.Client, page, new { name = "Before" })).GetProperty("id").GetGuid();
        await Kit.PushOk(ws.Client, page, Kit.Update("edit"));
        await server.RunJob<ValidateJob>();
        await server.RunJob<SnapshotJob>();
        Assert.Equal("Hello", await TextAt(ws.Client, page, before));

        // Named while an update given out before it is still being checked: written once it is.
        var other = (await ws.NewPage("Agenda")).GetProperty("id").GetGuid();
        await Kit.PushOk(ws.Client, other, Kit.Update("page"));
        await Kit.PushOk(ws.Client, other, Kit.Update("edit"));
        var named = (await Version(ws.Client, other, new { name = "With the edit" })).GetProperty("id").GetGuid();
        await server.RunJob<SnapshotJob>(); // Too early: it waits (unless another test's worker ran).
        await server.RunJob<ValidateJob>();
        await server.RunJob<SnapshotJob>();
        Assert.Equal("Hello world", await TextAt(ws.Client, other, named));
    }

    [Fact]
    public async Task A_named_version_is_written_by_the_worker_and_read_by_a_signed_url()
    {
        var ws = await Ws.Create(server);
        var viewer = await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws);
        await Kit.Share(ws, page, false, ("user", viewer.Id, "view"));

        var created = await Version(ws.Client, page, new { name = "  Before the review  " });
        Assert.Equal("named", created.GetProperty("kind").GetString());
        Assert.Equal("Before the review", created.GetProperty("name").GetString());
        Assert.Equal("pending", created.GetProperty("status").GetString());
        var id = created.GetProperty("id").GetGuid();
        var pending = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/versions/{id}");
        Assert.Equal(JsonValueKind.Null, pending.GetProperty("url").ValueKind);

        await server.RunJob<SnapshotJob>();
        Assert.Equal("Hello world", await TextAt(viewer.Client, page, id));
        var listed = (await viewer.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/versions")).EnumerateArray().ToList();
        var row = Assert.Single(listed, v => v.GetProperty("id").GetGuid() == id);
        Assert.Equal(2, row.GetProperty("upToSeq").GetInt64());
        Assert.Equal(ws.Account.Id, row.GetProperty("createdBy").GetGuid());
        // Compaction snapshots are not history.
        Assert.DoesNotContain(listed, v => v.GetProperty("kind").GetString() == "compaction");

        // Saving one needs edit access; the kinds are named and preRestore.
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { kind = "auto" })).StatusCode);
        Assert.Equal("preRestore", (await Version(ws.Client, page, new { kind = "preRestore" })).GetProperty("kind").GetString());
        // Another page's version is not this page's.
        var other = (await ws.NewPage("Other")).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.GetAsync($"/api/v1/pages/{other}/versions/{id}")).StatusCode);
    }

    [Fact]
    public async Task A_hard_restore_moves_the_epoch_and_can_itself_be_undone()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Doc")).GetProperty("id").GetGuid();
        await Kit.Register(ws.Client, ws.Id);
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await server.RunJob<ValidateJob>();
        var hello = (await Version(ws.Client, page, new { name = "Hello" })).GetProperty("id").GetGuid();
        await server.RunJob<SnapshotJob>();
        await Kit.PushOk(ws.Client, page, Kit.Update("edit"));
        await server.RunJob<ValidateJob>();

        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions/{hello}/restore", new { mode = "soft" })).StatusCode);
        var denied = await member.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions/{hello}/restore", new { mode = "hard" });
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        var accepted = await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions/{hello}/restore", new { mode = "hard" });
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        Assert.Equal("pending", (await Kit.Json(accepted)).GetProperty("status").GetString());
        // One waiting restore per page.
        Assert.Equal(HttpStatusCode.Conflict, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions/{hello}/restore", new { mode = "hard" })).StatusCode);
        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();
        await server.RunJob<HardRestoreJob>();

        // The new epoch: a snapshot of the version and nothing after it.
        var pull = await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after=0");
        Assert.Equal(1, pull.GetProperty("epoch").GetInt32());
        Assert.Empty(pull.GetProperty("updates").EnumerateArray());
        var snapshot = await Blob.GetByteArrayAsync(pull.GetProperty("snapshot").GetProperty("url").GetString());
        Assert.Equal("Hello", Text(snapshot));
        // The repair check's hash is the new epoch's, at the new head.
        var hash = await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc/state-hash");
        Assert.Equal(1, hash.GetProperty("epoch").GetInt32());
        Assert.Equal(pull.GetProperty("headSeq").GetInt64(), hash.GetProperty("upToSeq").GetInt64());
        Assert.Equal(Yjs.StateHash(snapshot), hash.GetProperty("hash").GetString());
        Assert.Contains((await ws.Changes(cursor, member.Client)).GetProperty("changes").EnumerateArray(),
            c => c.GetProperty("entityType").GetString() == "page" && c.GetProperty("entity").GetProperty("page").GetProperty("docEpoch").GetInt32() == 1);

        // A device still on the old epoch is told to start again.
        var stale = await Kit.Push(ws.Client, page, Kit.Update("edit"), epoch: 0);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal("doc.epochMismatch", await Kit.Code(stale));

        // What was there before is a preRestore version, so the restore can be undone the same way.
        var versions = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/versions")).EnumerateArray().ToList();
        var before = versions.Single(v => v.GetProperty("kind").GetString() == "preRestore").GetProperty("id").GetGuid();
        Assert.Equal("Hello world", await TextAt(ws.Client, page, before));
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "version.hardRestore" && a.TargetId == page));
            Assert.Equal(0, await db.PageDocUpdates.CountAsync(u => u.PageId == page));
            Assert.Equal(1, await db.PageDocSnapshots.CountAsync(s => s.PageId == page && s.Kind == "compaction"));
        }
        Assert.Equal(HttpStatusCode.Accepted, (await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions/{before}/restore", new { mode = "hard" })).StatusCode);
        await server.RunJob<HardRestoreJob>();
        var again = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after=0");
        Assert.Equal(2, again.GetProperty("epoch").GetInt32());
        Assert.Equal("Hello world", Text(await Blob.GetByteArrayAsync(again.GetProperty("snapshot").GetProperty("url").GetString())));

        // Editing goes on at the new epoch; sequences keep rising and the worker validates as before.
        var push = await Kit.Push(ws.Client, page, Kit.Update("edit"), epoch: 2);
        Assert.True(push.IsSuccessStatusCode, await push.Content.ReadAsStringAsync());
        var seq = (await Kit.Json(push)).GetProperty("acks")[0].GetProperty("seq").GetInt64();
        Assert.True(seq > again.GetProperty("snapshot").GetProperty("upToSeq").GetInt64());
        await server.RunJob<ValidateJob>();
        var after = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after={again.GetProperty("cursor").GetInt64()}");
        Assert.Equal(seq, Assert.Single(after.GetProperty("updates").EnumerateArray()).GetProperty("seq").GetInt64());
    }

    [Fact]
    public async Task Auto_snapshots_follow_activity_and_age_out_to_one_a_day()
    {
        var ws = await Ws.Create(server);
        var page = await Kit.PageWithText(server, ws);
        var job = Kit.Job<HistoryJob>(server);
        var now = DateTimeOffset.UtcNow;
        async Task<int> Auto(DateTimeOffset at) => await Kit.InWorker(server, ws.Id, (_, db) => job.AutoAsync(db, at, CancellationToken.None, ws.Id));
        async Task<List<PageDocSnapshot>> Autos()
        {
            await using var db = server.NewDb(ws.Id);
            return await db.PageDocSnapshots.AsNoTracking().Where(s => s.PageId == page && s.Kind == "auto").OrderBy(s => s.CreatedAt).ToListAsync();
        }

        Assert.Equal(1, await Auto(now));
        Assert.Equal(0, await Auto(now));
        await Kit.PushOk(ws.Client, page, Kit.Update("edit"));
        await server.RunJob<ValidateJob>();
        // Within the hour, the next one waits; after it, the activity gets its own.
        Assert.Equal(0, await Auto(now.AddMinutes(30)));
        Assert.Equal(1, await Auto(now.AddMinutes(61)));
        // No activity since: none.
        Assert.Equal(0, await Auto(now.AddHours(3)));
        var autos = await Autos();
        Assert.Equal(2, autos.Count);
        Assert.Equal([2L, 3L], autos.Select(a => a.UpToSeq));

        // Older than 30 days: one per day stays (the day's last), named ones stay for ever.
        var store = server.Worker.GetRequiredService<BlobStore>();
        var day = new DateTimeOffset(now.UtcDateTime.Date.AddDays(-40), TimeSpan.Zero);
        var old = new List<PageDocSnapshot>();
        foreach (var (hour, kind) in new[] { (9, "auto"), (12, "auto"), (18, "auto"), (10, "named") })
        {
            var s = new PageDocSnapshot
            {
                Id = Guid.CreateVersion7(), PageId = page, WorkspaceId = ws.Id, Kind = kind, Status = "ready",
                UpToSeq = 1, CreatedAt = day.AddHours(hour), SizeBytes = 2,
            };
            s.BlobKey = BlobStore.SnapshotKey(ws.Id, page, s.Id);
            await store.PutAsync(s.BlobKey, DocStates.Empty, "application/octet-stream");
            old.Add(s);
        }
        await using (var db = server.NewDb(ws.Id))
        {
            db.PageDocSnapshots.AddRange(old);
            await db.SaveChangesAsync();
        }
        Assert.Equal(2, await Kit.InWorker(server, ws.Id, (_, db) => job.RetainAsync(db, now, CancellationToken.None, ws.Id)));
        await using (var db = server.NewDb(ws.Id))
        {
            var left = await db.PageDocSnapshots.AsNoTracking().Where(s => s.PageId == page && s.CreatedAt < now.AddDays(-30)).ToListAsync();
            Assert.Equal(new[] { old[2].Id, old[3].Id }.Order(), left.Select(s => s.Id).Order());
        }
        Assert.False(await store.ExistsAsync(old[0].BlobKey));
        Assert.False(await store.ExistsAsync(old[1].BlobKey));
        Assert.True(await store.ExistsAsync(old[2].BlobKey));
        Assert.Equal(2, (await Autos()).Count(a => a.CreatedAt > now.AddDays(-1)));
    }
}
