using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Api.Infrastructure;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Cgw.Ydoc;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 12, M12.4: the batch pull of documents (<c>POST /workspaces/{id}/docs/pull</c>). Each page
/// checked and answered exactly as <c>GET /pages/{id}/doc?after=</c> checks and answers it (a
/// restricted page, another workspace's, a trashed one, one deleted for good, a row of a database the
/// caller cannot read, a guest's), one refusal in its own item; <c>after</c> honoured; the 8 MiB cap
/// with <c>deferred</c>; a snapshot as the single route gives it; its own rate limit, sized for a pin
/// of 5,000 row documents; and what is refused as a whole.
/// </summary>
public sealed class DocsPullTests(ServerFixture server)
{
    private static Task<HttpResponseMessage> Batch(HttpClient client, Guid workspace, params (Guid Page, long After)[] pages) =>
        client.PostAsJsonAsync($"/api/v1/workspaces/{workspace}/docs/pull", new { pages = pages.Select(p => new { pageId = p.Page, after = p.After }).ToArray() });

    private static async Task<List<JsonElement>> BatchOk(HttpClient client, Guid workspace, params (Guid Page, long After)[] pages)
    {
        var response = await Batch(client, workspace, pages);
        Assert.True(response.StatusCode == HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        var docs = (await Kit.Json(response)).GetProperty("docs").EnumerateArray().ToList();
        Assert.Equal(pages.Select(p => p.Page), docs.Select(d => d.GetProperty("pageId").GetGuid()));
        return docs;
    }

    /// <summary>A pull's JSON with its snapshot's signed URL cut to its blob (each signature is made afresh, with its own expiry).</summary>
    private static string Comparable(JsonElement pull)
    {
        var node = JsonNode.Parse(pull.GetRawText())!.AsObject();
        if (node["snapshot"] is JsonObject snapshot && snapshot["url"]?.GetValue<string>() is { } url)
            snapshot["url"] = new Uri(url).GetLeftPart(UriPartial.Path);
        return node.ToJsonString();
    }

    /// <summary>The single route's answer for a page, as a status, a code and the comparable pull.</summary>
    private static async Task<(int Status, string? Code, string? Pull)> Single(HttpClient client, Guid page, long after)
    {
        var response = await client.GetAsync($"/api/v1/pages/{page}/doc?after={after}");
        var body = await Kit.Json(response);
        return response.IsSuccessStatusCode ? ((int)response.StatusCode, null, Comparable(body)) : ((int)response.StatusCode, body.GetProperty("code").GetString(), null);
    }

    private static (int Status, string? Code, string? Pull) Item(JsonElement item) =>
        (item.GetProperty("status").GetInt32(),
            item.TryGetProperty("code", out var code) ? code.GetString() : null,
            item.TryGetProperty("pull", out var pull) ? Comparable(pull) : null);

    /// <summary>Each page's item equals the single route's answer to the same caller.</summary>
    private static async Task SameAsSingle(HttpClient client, Guid workspace, params (Guid Page, long After)[] pages)
    {
        var docs = await BatchOk(client, workspace, pages);
        for (var i = 0; i < pages.Length; i++)
            Assert.Equal(await Single(client, pages[i].Page, pages[i].After), Item(docs[i]));
    }

    /// <summary>"Hello", then " world": two updates pushed for the page, validated once a pass.</summary>
    private static async Task Typed(Ws ws, Guid page)
    {
        await Kit.PushOk(ws.Client, page, Kit.Update("page"));
        await Kit.PushOk(ws.Client, page, Kit.Update("edit"));
    }

    private static async Task<Guid> Row(Ws ws, Guid database, string title)
    {
        var id = Guid.CreateVersion7();
        var payload = DatabaseTests.PageJson(id, ws.Id, ws.Shared, database, "a0", title, "row");
        payload["row"] = new JsonObject { ["values"] = new JsonObject() };
        var result = (await ws.Push(ws.Op("page.create", id, payload)))[0];
        Assert.True(result.GetProperty("status").GetString() == "applied", result.ToString());
        return id;
    }

    private static Guid Id(JsonElement page) => page.GetProperty("id").GetGuid();

    [Fact]
    public async Task Each_page_is_checked_and_answered_as_its_own_pull_and_one_refusal_never_fails_the_batch()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        await Kit.Register(ws.Client, ws.Id);

        var open = Id(await ws.NewPage("Open"));
        var restricted = Id(await ws.NewPage("Restricted"));
        var trashed = Id(await ws.NewPage("Trashed"));
        var deleted = Id(await ws.NewPage("Deleted for good"));
        var mine = Id(await ws.NewPage("The owner's own", section: ws.Personal));
        var empty = Id(await ws.NewPage("No document yet"));
        var readable = await DatabaseTests.NewDatabase(ws, "Readable");
        var closed = await DatabaseTests.NewDatabase(ws, "Closed");
        var readableRow = await Row(ws, readable, "A row anyone reads");
        var closedRow = await Row(ws, closed, "A row of a closed database");
        foreach (var page in new[] { open, restricted, trashed, deleted, mine, readableRow, closedRow }) await Typed(ws, page);
        await server.RunJob<ValidateJob>();
        await Kit.Share(ws, restricted, true);
        await Kit.Share(ws, closed, true);
        await Kit.Share(ws, open, false, ("user", guest.Id, "view"));
        await ws.Push(ws.Op("page.trash", trashed, new { }));
        await ws.Push(ws.Op("page.trash", deleted, new { }));
        await ws.Push(ws.Op("page.delete", deleted, new { }));
        // Another workspace the member belongs to: its page is not one of this workspace's.
        var theirs = await Ws.Create(server, member);
        var elsewhere = Id(await theirs.NewPage("Elsewhere"));
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync($"/api/v1/pages/{elsewhere}/doc")).StatusCode);

        var all = new[] { open, restricted, trashed, deleted, mine, empty, readableRow, closedRow, elsewhere, Guid.CreateVersion7() }.Select(p => (p, 0L)).ToArray();
        var docs = await BatchOk(member.Client, ws.Id, all);
        Assert.Equal([200, 404, 200, 410, 404, 200, 200, 404, 404, 404], docs.Select(d => d.GetProperty("status").GetInt32()));
        Assert.Equal("page.gone", docs[3].GetProperty("code").GetString());
        Assert.Equal("not.found", docs[1].GetProperty("code").GetString());
        Assert.Equal("not.found", docs[8].GetProperty("code").GetString());
        Assert.False(docs[0].TryGetProperty("code", out _));
        Assert.False(docs[1].TryGetProperty("pull", out _));
        Assert.Equal(2, docs[0].GetProperty("pull").GetProperty("updates").GetArrayLength());
        Assert.Equal(Kit.Update("page"), Convert.FromBase64String(docs[0].GetProperty("pull").GetProperty("updates")[0].GetProperty("data").GetString()!));
        Assert.Equal(2, docs[6].GetProperty("pull").GetProperty("cursor").GetInt64());
        Assert.Equal(0, docs[5].GetProperty("pull").GetProperty("headSeq").GetInt64());
        // Each one the single route's answer to the same person, refusals and all: but the page of
        // the other workspace, which that route answers (it acts in the page's own workspace).
        var here = all.Where(p => p.p != elsewhere).ToArray();
        await SameAsSingle(member.Client, ws.Id, here);
        // The owner reads what the member cannot (not the other workspace's page).
        var owners = await BatchOk(ws.Client, ws.Id, all);
        Assert.Equal([200, 200, 200, 410, 200, 200, 200, 200, 404, 404], owners.Select(d => d.GetProperty("status").GetInt32()));
        await SameAsSingle(ws.Client, ws.Id, all);
        // A guest: only what was shared with them by name.
        var guests = await BatchOk(guest.Client, ws.Id, (open, 0), (trashed, 0), (readableRow, 0));
        Assert.Equal([200, 404, 404], guests.Select(d => d.GetProperty("status").GetInt32()));
        await SameAsSingle(guest.Client, ws.Id, (open, 0), (trashed, 0), (readableRow, 0));

        // Someone not in the workspace: nothing, as every workspace route.
        var stranger = await server.NewAccount();
        var refused = await Batch(stranger.Client, ws.Id, (open, 0));
        Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
        Assert.Equal("not.found", await Kit.Code(refused));
        Assert.Equal(HttpStatusCode.Unauthorized, (await Batch(server.Anonymous(), ws.Id, (open, 0))).StatusCode);
    }

    [Fact]
    public async Task After_is_honoured_and_a_snapshot_comes_by_the_same_signed_url_the_single_route_gives()
    {
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);
        var page = Id(await ws.NewPage("Paged"));
        var other = Id(await ws.NewPage("Other"));
        await Typed(ws, page);
        await Typed(ws, other);
        await server.RunJob<ValidateJob>();

        var docs = await BatchOk(ws.Client, ws.Id, (page, 1), (other, 2));
        var after = docs[0].GetProperty("pull");
        Assert.Equal([2L], after.GetProperty("updates").EnumerateArray().Select(u => u.GetProperty("seq").GetInt64()));
        Assert.Equal(2, after.GetProperty("cursor").GetInt64());
        Assert.False(after.GetProperty("more").GetBoolean());
        Assert.Empty(docs[1].GetProperty("pull").GetProperty("updates").EnumerateArray());
        await SameAsSingle(ws.Client, ws.Id, (page, 1), (other, 2));
        // A cursor below 0 is 0, as the single route reads it.
        await SameAsSingle(ws.Client, ws.Id, (other, -5));
        Assert.Equal(2, (await BatchOk(ws.Client, ws.Id, (other, -5)))[0].GetProperty("pull").GetProperty("updates").GetArrayLength());

        // Compacted: a client from 0 gets the snapshot, by a URL signed for its one blob.
        await using (var scope = server.Worker.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
            db.Scope.Switch(ws.Id);
            await new CompactJob(scope.ServiceProvider.GetRequiredService<DocStates>(), scope.ServiceProvider.GetRequiredService<BlobStore>(), new NoFaults(), TimeProvider.System)
                .CompactAsync(db, page, CancellationToken.None);
        }
        var compacted = (await BatchOk(ws.Client, ws.Id, (page, 0)))[0].GetProperty("pull");
        var snapshot = compacted.GetProperty("snapshot");
        Assert.Equal(2, snapshot.GetProperty("upToSeq").GetInt64());
        Assert.Empty(compacted.GetProperty("updates").EnumerateArray());
        var single = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc?after=0");
        using var http = new HttpClient();
        var bytes = await http.GetByteArrayAsync(snapshot.GetProperty("url").GetString());
        Assert.Equal(await http.GetByteArrayAsync(single.GetProperty("snapshot").GetProperty("url").GetString()), bytes);
        Assert.Contains("Hello world", Yjs.ToText(bytes));
        Assert.Contains("sig=", snapshot.GetProperty("url").GetString());
        await SameAsSingle(ws.Client, ws.Id, (page, 0), (other, 0));
    }

    /// <summary>
    /// A Yjs update (version 1) of one string into a root of its own: a real update every Yjs reader
    /// decodes, of any size, written straight in as validated (the worker's checks are not under test
    /// here, and its passes for other tests load it like any page's).
    /// </summary>
    private static byte[] Padding(ulong client, int chars)
    {
        var bytes = new List<byte>(chars + 32);
        void Var(ulong n)
        {
            for (; n >= 0x80; n >>= 7) bytes.Add((byte)(n | 0x80));
            bytes.Add((byte)n);
        }
        void Text(string s)
        {
            var utf8 = Encoding.UTF8.GetBytes(s);
            Var((ulong)utf8.Length);
            bytes.AddRange(utf8);
        }
        Var(1); // one client
        Var(1); // one struct
        Var(client);
        Var(0); // its clock
        bytes.Add(4); // an item of a string, no origin, no parent key
        Var(1); // its parent a root, by name
        Text("padding");
        Text(new string('x', chars));
        Var(0); // no deletions
        return [.. bytes];
    }

    private static int nextClient = 900_000;

    /// <summary>A page whose document is <paramref name="updates"/> validated updates of <paramref name="each"/> bytes or so.</summary>
    private async Task<Guid> Large(Ws ws, int updates, int each)
    {
        var page = Id(await ws.NewPage("Large"));
        await using var db = server.NewDb(ws.Id);
        for (var seq = 1; seq <= updates; seq++)
            db.PageDocUpdates.Add(new PageDocUpdate
            {
                PageId = page,
                Seq = seq,
                UpdateId = Guid.CreateVersion7(),
                WorkspaceId = ws.Id,
                Epoch = 0,
                UserId = ws.Account.Id,
                Data = Padding((ulong)Interlocked.Increment(ref nextClient), each),
                ClientSchemaVersion = 1,
                Status = UpdateStatus.Valid,
                CreatedAt = DateTimeOffset.UtcNow,
            });
        await db.SaveChangesAsync();
        await db.Pages.Where(p => p.Id == page).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSeq, updates).SetProperty(p => p.DocHeadSeq, updates));
        return page;
    }

    private static long Bytes(JsonElement item) =>
        item.GetProperty("pull").GetProperty("updates").EnumerateArray().Sum(u => (long)Convert.FromBase64String(u.GetProperty("data").GetString()!).Length);

    [Fact]
    public async Task An_answer_holds_at_most_eight_mebibytes_and_defers_the_pages_past_it()
    {
        // The padding is a real update: Yjs reads it and merges it with a page's own (the worker's passes load such pages).
        Assert.Contains("Hello", Yjs.ToText(Yjs.Merge([Padding(43, 16), Kit.Update("page"), Padding(44, 16)])));
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);
        var small = Id(await ws.NewPage("Small"));
        var last = Id(await ws.NewPage("Last"));
        await Typed(ws, small);
        await Typed(ws, last);
        await server.RunJob<ValidateJob>();
        const int Mb = 1_000_000;
        var first = await Large(ws, 3, Mb);
        var second = await Large(ws, 3, Mb);
        var third = await Large(ws, 3, Mb);

        // 3 MB, then 6 MB: the third would pass 8 MiB, so it and every page after it wait.
        var docs = await BatchOk(ws.Client, ws.Id, (small, 0), (first, 0), (second, 0), (third, 0), (last, 0));
        Assert.Equal([200, 200, 200, 0, 0], docs.Select(d => d.GetProperty("status").GetInt32()));
        Assert.All(docs.Skip(3), d => Assert.Equal("deferred", d.GetProperty("code").GetString()));
        Assert.All(docs.Skip(3), d => Assert.False(d.TryGetProperty("pull", out _)));
        Assert.True(docs.Take(3).Sum(Bytes) <= DocPulls.MaxBytes);
        Assert.Equal(6, docs.Skip(1).Take(2).Sum(d => d.GetProperty("pull").GetProperty("updates").GetArrayLength()));
        // Asked again, they come.
        var again = await BatchOk(ws.Client, ws.Id, (third, 0), (last, 0));
        Assert.Equal([200, 200], again.Select(d => d.GetProperty("status").GetInt32()));
        Assert.Equal(3, again[0].GetProperty("pull").GetProperty("updates").GetArrayLength());

        // A page bigger than the cap alone is answered whole when it is the first; after another page's updates, it waits.
        var huge = await Large(ws, 9, Mb);
        var alone = await BatchOk(ws.Client, ws.Id, (huge, 0), (small, 0));
        Assert.Equal([200, 0], alone.Select(d => d.GetProperty("status").GetInt32()));
        Assert.Equal(9, alone[0].GetProperty("pull").GetProperty("updates").GetArrayLength());
        Assert.True(Bytes(alone[0]) > DocPulls.MaxBytes);
        Assert.Equal(Comparable(alone[0].GetProperty("pull")), (await Single(ws.Client, huge, 0)).Pull);
        var behind = await BatchOk(ws.Client, ws.Id, (small, 0), (huge, 0));
        Assert.Equal([200, 0], behind.Select(d => d.GetProperty("status").GetInt32()));
        // A refusal or a page with nothing new before it carries no updates: the large page is still first.
        var refusedFirst = await BatchOk(ws.Client, ws.Id, (Guid.CreateVersion7(), 0), (small, 2), (huge, 0));
        Assert.Equal([404, 200, 200], refusedFirst.Select(d => d.GetProperty("status").GetInt32()));
    }

    [Fact]
    public async Task Fifty_batches_inside_a_minute_never_meet_the_limit_and_the_single_pulls_limit_is_unchanged()
    {
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);
        var page = Id(await ws.NewPage("Pinned"));
        await Typed(ws, page);
        await server.RunJob<ValidateJob>();
        // The limit as shipped (the fixture raises it for every other test), on an API of its own:
        // its windows are this test's alone.
        var api = server.Variant(b => b.UseSetting("RateLimits:pull", RateLimits.PullPerMinute.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, ws.Account.Email, ws.Account.Password);
        // A pin of 5,000 row documents is 50 batches of 100; the limit counts requests, not pages.
        for (var i = 0; i < 50; i++)
            Assert.Equal(HttpStatusCode.OK, (await Batch(client, ws.Id, (page, 0))).StatusCode);
        // The window is RateLimits.PullPerMinute requests a minute: the next past it is refused, with when to ask again.
        HttpResponseMessage? limited = null;
        var sent = 50;
        while (limited is null && sent < RateLimits.PullPerMinute + 5)
        {
            var response = await Batch(client, ws.Id, (page, 0));
            sent++;
            if (response.StatusCode == HttpStatusCode.TooManyRequests) limited = response;
        }
        Assert.NotNull(limited);
        Assert.Equal(RateLimits.PullPerMinute + 1, sent);
        Assert.Equal("limit.rate", await Kit.Code(limited));
        Assert.NotNull(limited.Headers.RetryAfter);
        // The single route still answers: its limit is the account's, as before.
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/v1/pages/{page}/doc")).StatusCode);
        var endpoints = server.Api.Services.GetServices<EndpointDataSource>().SelectMany(s => s.Endpoints).ToList();
        string? Policy(string name) => endpoints.Single(e => e.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName == name).Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName;
        Assert.Equal(RateLimits.User, Policy("pullDoc"));
        Assert.Equal(RateLimits.Pull, Policy("pullDocs"));
    }

    [Fact]
    public async Task No_pages_more_than_a_hundred_or_a_page_twice_are_refused_as_a_whole()
    {
        var ws = await Ws.Create(server);
        var page = Id(await ws.NewPage("Once"));
        async Task Invalid(object body)
        {
            var response = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/docs/pull", body);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(response));
        }
        await Invalid(new { pages = Array.Empty<object>() });
        await Invalid(new { });
        await Invalid(new { pages = (object?)null });
        await Invalid(new { pages = Enumerable.Range(0, DocPulls.MaxPages + 1).Select(_ => new { pageId = Guid.CreateVersion7(), after = 0 }).ToArray() });
        await Invalid(new { pages = new[] { new { pageId = page, after = 0 }, new { pageId = page, after = 1 } } });
        // A hundred distinct pages are one batch, unknown ones each their own 404.
        var hundred = Enumerable.Range(0, DocPulls.MaxPages).Select(i => (i == 0 ? page : Guid.CreateVersion7(), 0L)).ToArray();
        var docs = await BatchOk(ws.Client, ws.Id, hundred);
        Assert.Equal(200, docs[0].GetProperty("status").GetInt32());
        Assert.All(docs.Skip(1), d => Assert.Equal(404, d.GetProperty("status").GetInt32()));
    }
}
