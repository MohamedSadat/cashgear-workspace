using System.Net.Http.Json;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>Tests that count what a whole pass of the worker does: no other test's pass may take their pages.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class AloneCollection
{
    public const string Name = "Alone";
}

/// <summary>
/// M8.1: a validation pass loads each document it checks once (0.7.0 loaded a document three times
/// for one update: its meta, the check and the state hash), and decides what it decided before:
/// the same statuses and problems, the same state hash. The fixtures are Yjs's (updates.json): each
/// refused one is another continuation of "page" by client 1001, so each goes on a page of its own.
/// </summary>
[Collection(AloneCollection.Name)]
public sealed class ValidationLoadTests(ServerFixture server)
{
    /// <summary>One pass over the page's pending updates; the documents it loaded.</summary>
    private async Task<int> PassLoads(Ws ws, Guid page)
    {
        using var count = Yjs.CountLoads();
        await Kit.Job<ValidateJob>(server).ValidatePagesAsync(server.Worker, ws.Id, [page], CancellationToken.None);
        return count.Loads;
    }

    /// <summary>Updates pushed together, so one pass decides them together.</summary>
    private static async Task Push(Ws ws, Guid page, params string[] names)
    {
        var response = await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch = 0,
            clientSchemaVersion = 1,
            updates = names.Select(n => new { updateId = Guid.CreateVersion7(), data = Kit.Update(n) }).ToArray(),
        });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private async Task<Guid> NewPage(Ws ws, string title)
    {
        var page = (await ws.NewPage(title)).GetProperty("id").GetGuid();
        return page;
    }

    private async Task<(List<PageDocUpdate> Rows, Page Page)> Decided(Ws ws, Guid page)
    {
        await using var db = server.NewDb(ws.Id);
        var rows = await db.PageDocUpdates.AsNoTracking().Where(u => u.PageId == page).OrderBy(u => u.Seq).ToListAsync();
        return (rows, await db.Pages.AsNoTracking().SingleAsync(p => p.Id == page));
    }

    private static string HashOf(params string[] names) => Yjs.StateHash(Yjs.Merge(names.Select(Kit.Update).ToList()));

    [Fact]
    public async Task A_pass_loads_each_document_it_checks_once_and_decides_as_before()
    {
        // Whatever other tests left pending is decided first: these passes see only their pages.
        await server.RunJob<ValidateJob>();
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);

        // One update a pass, as a live page pushes a key at a time: one load each, for its meta, its
        // tree and the state hash. A forgery is refused before anything is loaded.
        var typed = await NewPage(ws, "Typed");
        await Push(ws, typed, "page");
        Assert.Equal(1, await PassLoads(ws, typed));
        await Push(ws, typed, "edit");
        Assert.Equal(1, await PassLoads(ws, typed));
        await Push(ws, typed, "forged");
        Assert.Equal(0, await PassLoads(ws, typed));
        // Nothing pending: nothing loaded.
        Assert.Equal(0, await PassLoads(ws, typed));

        // Refused by its tree: the one document it would make, loaded once.
        var refused = await NewPage(ws, "Refused");
        await Push(ws, refused, "page");
        Assert.Equal(1, await PassLoads(ws, refused));
        await Push(ws, refused, "unknownElement");
        Assert.Equal(1, await PassLoads(ws, refused));

        // A batch that passes as a whole: one load.
        var batch = await NewPage(ws, "Batch");
        await Push(ws, batch, "page", "edit");
        Assert.Equal(1, await PassLoads(ws, batch));

        // A batch with a refusal in it: the batch, then each update alone, one load each (0.7.0:
        // seven), and the state hash from the last one that passed.
        var mixed = await NewPage(ws, "Mixed");
        await Push(ws, mixed, "page");
        Assert.Equal(1, await PassLoads(ws, mixed));
        await Push(ws, mixed, "unknownElement", "edit");
        Assert.Equal(3, await PassLoads(ws, mixed));

        // What was decided, with 0.7.0's problems and state hashes.
        var (rows, page) = await Decided(ws, typed);
        Assert.Equal([UpdateStatus.Valid, UpdateStatus.Valid, UpdateStatus.Rejected], rows.Select(r => r.Status));
        Assert.Equal("writes as Yjs client 999, which is not registered to the pusher", rows[2].Problem);
        Assert.Equal((3L, 3L, (string?)HashOf("page", "edit")), (page.DocHeadSeq, page.DocStateHashSeq, page.DocStateHash));

        (rows, page) = await Decided(ws, refused);
        Assert.Equal([UpdateStatus.Valid, UpdateStatus.Rejected], rows.Select(r => r.Status));
        Assert.Equal("unknown element <script>", rows[1].Problem);
        Assert.Equal((2L, 2L, (string?)HashOf("page")), (page.DocHeadSeq, page.DocStateHashSeq, page.DocStateHash));

        (rows, page) = await Decided(ws, batch);
        Assert.Equal([UpdateStatus.Valid, UpdateStatus.Valid], rows.Select(r => r.Status));
        Assert.Equal((2L, 2L, (string?)HashOf("page", "edit")), (page.DocHeadSeq, page.DocStateHashSeq, page.DocStateHash));

        (rows, page) = await Decided(ws, mixed);
        Assert.Equal([UpdateStatus.Valid, UpdateStatus.Rejected, UpdateStatus.Valid], rows.Select(r => r.Status));
        Assert.Equal("unknown element <script>", rows[1].Problem);
        Assert.Equal((3L, 3L, (string?)HashOf("page", "edit")), (page.DocHeadSeq, page.DocStateHashSeq, page.DocStateHash));
    }

    [Fact]
    public async Task Deriving_a_page_loads_it_once()
    {
        await server.RunJob<ValidateJob>();
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id);
        var page = await NewPage(ws, "Derived");
        await Push(ws, page, "page", "edit");
        await Kit.Job<ValidateJob>(server).ValidatePagesAsync(server.Worker, ws.Id, [page], CancellationToken.None);
        using (var count = Yjs.CountLoads())
        {
            await Kit.Derive(server, ws.Id, page);
            Assert.Equal(1, count.Loads);
        }
        await using var db = server.NewDb(ws.Id);
        var derived = await db.PageDocDerived.AsNoTracking().SingleAsync(d => d.PageId == page);
        Assert.Equal("Hello world\n", derived.PlainText);
    }
}
