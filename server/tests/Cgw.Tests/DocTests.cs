using System.Collections.Concurrent;
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

public sealed record Fixture(string Name, long Client, string Data, string Expect, string Why)
{
    public byte[] Bytes => Convert.FromBase64String(Data);
}

/// <summary>M2.4: documents pushed, validated before fan-out (Q20), pulled, compacted and derived.</summary>
public sealed class DocTests(ServerFixture server)
{
    private static readonly Lazy<Dictionary<string, Fixture>> Fixtures = new(() =>
        JsonSerializer.Deserialize<List<Fixture>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "updates.json")),
                new JsonSerializerOptions(JsonSerializerDefaults.Web))!
            .ToDictionary(f => f.Name));

    private static Fixture F(string name) => Fixtures.Value[name];

    private sealed record Page(Ws Ws, Guid Id);

    private async Task<Page> NewPage(Ws? ws = null, params long[] clients)
    {
        ws ??= await Ws.Create(server);
        var page = await ws.NewPage("Doc");
        var register = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/yjs-clients", new { register = clients.Length > 0 ? clients : [1001, 1002] });
        Assert.Equal(HttpStatusCode.OK, register.StatusCode);
        return new Page(ws, page.GetProperty("id").GetGuid());
    }

    private static async Task<HttpResponseMessage> Push(HttpClient client, Guid page, params (Guid Id, byte[] Data)[] updates) =>
        await client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch = 0,
            clientSchemaVersion = 1,
            updates = updates.Select(u => new { updateId = u.Id, data = u.Data }).ToArray(),
        });

    private static async Task<JsonElement> PushOk(HttpClient client, Guid page, params (Guid Id, byte[] Data)[] updates)
    {
        var response = await Push(client, page, updates);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(response.IsSuccessStatusCode, body.ToString());
        return body;
    }

    private static async Task<JsonElement> Pull(HttpClient client, Guid page, long after = 0) =>
        await client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after={after}");

    private Task Validate() => server.RunJob<ValidateJob>();

    [Fact]
    public async Task Pushed_updates_are_served_only_once_the_worker_validates_them()
    {
        var page = await NewPage();
        var second = server.Anonymous();
        await ServerFixture.SignIn(second, page.Ws.Account.Email, page.Ws.Account.Password);

        var pushed = await PushOk(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("page").Bytes));
        Assert.Equal(1, pushed.GetProperty("acks")[0].GetProperty("seq").GetInt64());
        // Pending: not yet served to anyone (Q20).
        var early = await Pull(second, page.Id);
        Assert.Empty(early.GetProperty("updates").EnumerateArray());
        Assert.Equal(0, early.GetProperty("headSeq").GetInt64());

        await Validate();
        var pulled = await Pull(second, page.Id);
        Assert.Equal(1, pulled.GetProperty("headSeq").GetInt64());
        Assert.Equal(1, pulled.GetProperty("cursor").GetInt64());
        Assert.Equal(F("page").Data, pulled.GetProperty("updates")[0].GetProperty("data").GetString());

        await PushOk(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("edit").Bytes));
        await Validate();
        var after = await Pull(second, page.Id, 1);
        var update = Assert.Single(after.GetProperty("updates").EnumerateArray());
        Assert.Equal(2, update.GetProperty("seq").GetInt64());
        var state = Yjs.Merge([F("page").Bytes, Convert.FromBase64String(update.GetProperty("data").GetString()!)]);
        Assert.Contains("Hello world", Yjs.ToText(state));
    }

    [Fact]
    public async Task A_repeated_update_keeps_its_first_sequence()
    {
        var page = await NewPage();
        var id = Guid.CreateVersion7();
        var first = await PushOk(page.Ws.Client, page.Id, (id, F("page").Bytes));
        var again = await PushOk(page.Ws.Client, page.Id, (id, F("page").Bytes), (Guid.CreateVersion7(), F("edit").Bytes));
        Assert.Equal(first.GetProperty("acks")[0].GetProperty("seq").GetInt64(), again.GetProperty("acks")[0].GetProperty("seq").GetInt64());
        Assert.Equal(2, again.GetProperty("acks")[1].GetProperty("seq").GetInt64());
    }

    [Fact]
    public async Task Epoch_version_and_size_are_checked_on_the_push_path()
    {
        var page = await NewPage();
        var client = page.Ws.Client;
        var epoch = await client.PostAsJsonAsync($"/api/v1/pages/{page.Id}/doc/updates", new { epoch = 3, clientSchemaVersion = 1, updates = new[] { new { updateId = Guid.CreateVersion7(), data = F("page").Bytes } } });
        Assert.Equal(HttpStatusCode.Conflict, epoch.StatusCode);
        Assert.Equal("doc.epochMismatch", (await epoch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        await using (var db = server.NewDb(page.Ws.Id))
            await db.Pages.Where(p => p.Id == page.Id).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSchemaVersion, 2));
        var old = await Push(client, page.Id, (Guid.CreateVersion7(), F("page").Bytes));
        Assert.Equal((HttpStatusCode)426, old.StatusCode);
        Assert.Equal("client.tooOld", (await old.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        var page2 = await NewPage(page.Ws);
        var big = await Push(client, page2.Id, (Guid.CreateVersion7(), new byte[1024 * 1024 + 1]));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
        Assert.Equal("limit.size", (await big.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    /// <summary>S7's corpus through the real push path and worker: no hostile update reaches another client.</summary>
    [Fact]
    public async Task Hostile_updates_are_refused_before_any_other_client_receives_them()
    {
        var ws = await Ws.Create(server);
        var peer = await server.NewAccount();
        await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members", new { email = peer.Email, role = "member" });
        foreach (var fixture in Fixtures.Value.Values.Where(f => f.Name != "page"))
        {
            var page = await NewPage(ws, 1001, 1002);
            await PushOk(ws.Client, page.Id, (Guid.CreateVersion7(), F("page").Bytes));
            var id = Guid.CreateVersion7();
            await PushOk(ws.Client, page.Id, (id, fixture.Bytes));
            await Validate();
            var seen = await Pull(peer.Client, page.Id);
            var served = seen.GetProperty("updates").EnumerateArray().Select(u => u.GetProperty("updateId").GetGuid()).ToList();
            Assert.Equal(2, seen.GetProperty("headSeq").GetInt64());
            if (fixture.Expect == "valid")
                Assert.True(served.Contains(id), $"{fixture.Name} should pass: {fixture.Why}");
            else
            {
                Assert.False(served.Contains(id), $"{fixture.Name} reached a peer: {fixture.Why}");
                // The pusher is told; the peer is not.
                Assert.Contains(id, (await Pull(ws.Client, page.Id)).GetProperty("rejected").EnumerateArray().Select(r => r.GetGuid()));
                Assert.Empty(seen.GetProperty("rejected").EnumerateArray());
            }
        }
        await using var db = server.NewDb(ws.Id);
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "doc.forgedClient"));
    }

    /// <summary>S8 again, through the API: 50 writers, readers pulling "after N" never miss one.</summary>
    [Fact]
    public async Task Fifty_concurrent_writers_and_no_reader_misses_an_update()
    {
        var page = await NewPage();
        await PushOk(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("page").Bytes));
        var writers = new List<HttpClient>();
        for (var i = 0; i < 50; i++)
        {
            var client = server.Anonymous();
            await ServerFixture.SignIn(client, page.Ws.Account.Email, page.Ws.Account.Password);
            writers.Add(client);
        }
        const int each = 10;
        var done = false;
        var readers = Enumerable.Range(0, 4).Select(async _ =>
        {
            var seen = new SortedSet<long>();
            long cursor = 0;
            while (true)
            {
                var finished = Volatile.Read(ref done);
                var pull = await Pull(page.Ws.Client, page.Id, cursor);
                foreach (var u in pull.GetProperty("updates").EnumerateArray()) seen.Add(u.GetProperty("seq").GetInt64());
                cursor = pull.GetProperty("cursor").GetInt64();
                if (finished && !pull.GetProperty("more").GetBoolean() && cursor == 1 + 50 * each) return seen;
                await Task.Delay(10);
            }
        }).ToList();
        var validator = Task.Run(async () =>
        {
            while (!Volatile.Read(ref done)) await Validate();
            await Validate();
        });
        var acks = new ConcurrentBag<long>();
        await Task.WhenAll(writers.Select(async client =>
        {
            for (var i = 0; i < each; i++)
            {
                var body = await PushOk(client, page.Id, (Guid.CreateVersion7(), F("edit").Bytes));
                acks.Add(body.GetProperty("acks")[0].GetProperty("seq").GetInt64());
            }
        }));
        Volatile.Write(ref done, true);
        await validator;
        Assert.Equal(Enumerable.Range(2, 50 * each).Select(i => (long)i), acks.Order());
        foreach (var seen in await Task.WhenAll(readers))
            Assert.Equal(Enumerable.Range(1, 1 + 50 * each).Select(i => (long)i), seen);
    }

    private sealed class Faults(string at) : ICompactionFaults
    {
        public void AfterBlobWritten(Guid pageId)
        {
            if (at == "blob") throw new IOException("killed after the blob was written");
        }

        public void AfterCommit(Guid pageId)
        {
            if (at == "commit") throw new IOException("killed after the commit");
        }
    }

    private async Task Compact(Guid workspace, Guid page, string? killAt = null)
    {
        await using var scope = server.Worker.CreateAsyncScope();
        var job = new CompactJob(scope.ServiceProvider.GetRequiredService<DocStates>(), scope.ServiceProvider.GetRequiredService<BlobStore>(), killAt is null ? new NoFaults() : new Faults(killAt), TimeProvider.System);
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        db.Scope.Switch(workspace);
        await job.CompactAsync(db, page, CancellationToken.None);
    }

    /// <summary>What a client rebuilds from after=0: the snapshot by its signed URL, then the updates.</summary>
    private async Task<string> Rebuild(HttpClient client, Guid page)
    {
        var pull = await Pull(client, page);
        var parts = new List<byte[]>();
        if (pull.GetProperty("snapshot").ValueKind == JsonValueKind.Object)
            parts.Add(await new HttpClient().GetByteArrayAsync(pull.GetProperty("snapshot").GetProperty("url").GetString()));
        parts.AddRange(pull.GetProperty("updates").EnumerateArray().Select(u => Convert.FromBase64String(u.GetProperty("data").GetString()!)));
        return Yjs.ToText(parts.Count == 1 ? parts[0] : Yjs.Merge(parts));
    }

    [Fact]
    public async Task Compaction_replaces_the_rows_with_a_snapshot_and_a_crash_at_each_step_loses_nothing()
    {
        var page = await NewPage();
        await PushOk(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("page").Bytes));
        for (var i = 0; i < 5; i++) await PushOk(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("edit").Bytes));
        await Validate();
        var expected = await Rebuild(page.Ws.Client, page.Id);
        Assert.Contains("Hello world", expected);

        // Killed after the blob: the rows stay, the page loads as before.
        await Assert.ThrowsAsync<IOException>(() => Compact(page.Ws.Id, page.Id, "blob"));
        Assert.Equal(expected, await Rebuild(page.Ws.Client, page.Id));
        await using (var db = server.NewDb(page.Ws.Id))
            Assert.Equal(6, await db.PageDocUpdates.CountAsync(u => u.PageId == page.Id));

        // Compacted, then a later one killed after its commit: the newest snapshot serves the page.
        await Compact(page.Ws.Id, page.Id);
        await PushOk(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("edit").Bytes));
        await Validate();
        await Assert.ThrowsAsync<IOException>(() => Compact(page.Ws.Id, page.Id, "commit"));
        Assert.Equal(expected, await Rebuild(page.Ws.Client, page.Id));
        await using (var db = server.NewDb(page.Ws.Id))
        {
            Assert.Equal(0, await db.PageDocUpdates.CountAsync(u => u.PageId == page.Id));
            var snapshot = await db.PageDocSnapshots.SingleAsync(s => s.PageId == page.Id && s.Kind == "compaction");
            Assert.Equal(7, snapshot.UpToSeq);
        }
        // A client that held up to 3 gets the snapshot, as rows up to 7 are gone.
        var stale = await Pull(page.Ws.Client, page.Id, 3);
        Assert.Equal(7, stale.GetProperty("snapshot").GetProperty("upToSeq").GetInt64());
        // The snapshot URL is signed for one blob, for minutes: the container itself is closed.
        var url = new Uri(stale.GetProperty("snapshot").GetProperty("url").GetString()!);
        var bare = new UriBuilder(url) { Query = "" }.Uri;
        Assert.Equal(HttpStatusCode.NotFound, (await new HttpClient().GetAsync(bare)).StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden ? HttpStatusCode.NotFound : HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_worker_derives_json_text_and_links()
    {
        var page = await NewPage();
        await PushOk(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("page").Bytes), (Guid.CreateVersion7(), F("edit").Bytes));
        await Validate();
        await using (var scope = server.Worker.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
            db.Scope.Switch(page.Ws.Id);
            await scope.ServiceProvider.GetServices<IJob>().OfType<DeriveJob>().Single().DeriveAsync(db, page.Id, CancellationToken.None);
        }
        var json = await page.Ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page.Id}/doc/json");
        Assert.Contains("Hello world", json.GetProperty("json").GetString());
        await using var check = server.NewDb(page.Ws.Id);
        var derived = await check.PageDocDerived.SingleAsync(d => d.PageId == page.Id);
        Assert.Equal("hello world", derived.SearchText);
        Assert.Equal(2, derived.UpToSeq);
    }

    [Fact]
    public async Task The_server_issues_unique_client_ids_and_refuses_ones_another_user_holds()
    {
        var page = await NewPage(clients: [5_000_001]);
        var issued = await page.Ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{page.Ws.Id}/yjs-clients", new { issue = 8 });
        var ids = (await issued.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("issued").EnumerateArray().Select(i => i.GetInt64()).ToList();
        Assert.Equal(8, ids.Distinct().Count());
        Assert.All(ids, id => Assert.InRange(id, 1, uint.MaxValue));
        var other = await server.NewAccount();
        await page.Ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{page.Ws.Id}/members", new { email = other.Email, role = "member" });
        var taken = await other.Client.PostAsJsonAsync($"/api/v1/workspaces/{page.Ws.Id}/yjs-clients", new { register = new[] { 5_000_001L, 5_000_002L } });
        var body = await taken.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([5_000_001L], body.GetProperty("refused").EnumerateArray().Select(i => i.GetInt64()));
        Assert.Equal([5_000_002L], body.GetProperty("registered").EnumerateArray().Select(i => i.GetInt64()));
    }

    [Fact]
    public void The_worker_knows_the_same_elements_as_the_editor()
    {
        var shared = JsonSerializer.Deserialize<Dictionary<string, string[]>>(
            File.ReadAllText(Path.Combine(server.Root, "packages", "doc", "vectors", "schema-elements.json")))!;
        foreach (var (version, elements) in shared)
            Assert.Equal(elements, Schema.Elements[int.Parse(version)]);
    }

    [Fact]
    public async Task A_page_deleted_for_good_answers_410_and_another_workspaces_page_404()
    {
        var page = await NewPage();
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/pages/{page.Id}/doc")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Push(outsider.Client, page.Id, (Guid.CreateVersion7(), F("page").Bytes))).StatusCode);
        await page.Ws.Push(page.Ws.Op("page.trash", page.Id, new { }, 1));
        await page.Ws.Push(page.Ws.Op("page.delete", page.Id, new { }));
        var gone = await Push(page.Ws.Client, page.Id, (Guid.CreateVersion7(), F("page").Bytes));
        Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
        Assert.Equal("page.gone", (await gone.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }
}
