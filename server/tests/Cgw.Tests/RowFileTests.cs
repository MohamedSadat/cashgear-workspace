using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 14, M14.1: a file in a row's file cell. Until 0.14.0 it was in <c>AssetRefs</c> only once the
/// row's own document had been derived, so no other member could read it and the clean-up counted it
/// as held by nothing (deleting it 30 days after). <c>DatabaseRowFiles</c> holds it from the write that
/// puts it there.
/// </summary>
public sealed class RowFileTests(ServerFixture server)
{
    private static async Task<DateTimeOffset?> UnreferencedSince(ServerFixture server, Guid workspace, Guid asset)
    {
        await using var db = server.NewDb(workspace);
        return await db.Assets.AsNoTracking().Where(a => a.Id == asset).Select(a => a.UnreferencedSince).SingleAsync();
    }

    [Fact]
    public async Task A_file_in_a_rows_file_cell_is_read_by_whoever_reads_the_row_and_held_while_a_row_holds_it()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Contracts", [DatabaseTests.Prop("pFil0001", "files", "Scans")]);
        var file = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "scan.png");
        await server.RunJob<AssetCheckJob>();
        var row = (await DatabaseTests.NewRow(ws, database, "Lease", new { pFil0001 = new[] { file } })).GetProperty("id").GetGuid();
        var member = await server.NewAccount();
        await Kit.Join(server, ws, "member", member);

        // The row has no document: nothing was ever derived for it.
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync($"/api/v1/assets/{file}/url")).StatusCode);
        await server.RunJob<AssetCleanupJob>();
        Assert.Null(await UnreferencedSince(server, ws.Id, file));

        // Out of the cell, and nothing else shows it: the member reads it no more, the clean-up starts its days.
        Assert.Equal("applied", (await DatabaseTests.RowUpdate(ws, row, new { pFil0001 = Array.Empty<Guid>() })).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/assets/{file}/url")).StatusCode);
        await server.RunJob<AssetCleanupJob>();
        Assert.NotNull(await UnreferencedSince(server, ws.Id, file));

        // Back in the cell: held again.
        Assert.Equal("applied", (await DatabaseTests.RowUpdate(ws, row, new { pFil0001 = new[] { file } })).GetProperty("status").GetString());
        await server.RunJob<AssetCleanupJob>();
        Assert.Null(await UnreferencedSince(server, ws.Id, file));
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync($"/api/v1/assets/{file}/url")).StatusCode);
    }

    [Fact]
    public async Task A_rows_file_is_read_only_by_those_who_can_read_its_database()
    {
        var ws = await Ws.Create(server);
        var member = await server.NewAccount();
        await Kit.Join(server, ws, "member", member);
        var restricted = await DatabaseTests.NewDatabase(ws, "Payroll", [DatabaseTests.Prop("pFil0001", "files", "Slips")]);
        await Kit.Share(ws, restricted, true);
        var file = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "slip.png");
        await server.RunJob<AssetCheckJob>();
        await DatabaseTests.NewRow(ws, restricted, "March", new { pFil0001 = new[] { file } });
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/assets/{file}/url")).StatusCode);
        // Given the database, the member reads its rows' files.
        await Kit.Share(ws, restricted, true, ("user", member.Id, "view"));
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync($"/api/v1/assets/{file}/url")).StatusCode);
    }

    [Fact]
    public async Task The_index_follows_every_write_of_a_rows_values()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Media", [
            DatabaseTests.Prop("pFil0001", "files", "Photos"),
            DatabaseTests.Prop("pFil0002", "files", "Plans"),
            DatabaseTests.Prop("pTxt0001", "text", "Note"),
        ]);
        var a = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "a.png");
        var b = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "b.png");
        var c = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "c.png");
        await server.RunJob<AssetCheckJob>();
        var row = (await DatabaseTests.NewRow(ws, database, "One", new { pFil0001 = new[] { a, b }, pFil0002 = new[] { c }, pTxt0001 = c.ToString() })).GetProperty("id").GetGuid();

        async Task<List<(string Property, Guid Asset)>> Held()
        {
            await using var db = server.NewDb(ws.Id);
            return (await db.DatabaseRowFiles.AsNoTracking().Where(f => f.RowId == row).ToListAsync())
                .Select(f => (f.PropertyId, f.AssetId)).OrderBy(f => f.PropertyId, StringComparer.Ordinal).ThenBy(f => f.AssetId).ToList();
        }

        // Only files cells count: a text value that holds an id is not a file.
        Assert.Equal(new[] { ("pFil0001", a), ("pFil0001", b), ("pFil0002", c) }.OrderBy(f => f.Item1, StringComparer.Ordinal).ThenBy(f => f.Item2), await Held());
        Assert.Equal("applied", (await DatabaseTests.RowUpdate(ws, row, new { pFil0001 = new[] { b } })).GetProperty("status").GetString());
        Assert.Equal(new[] { ("pFil0001", b), ("pFil0002", c) }, await Held());

        // A property changed to another type keeps no file values; the index follows.
        var changed = await DatabaseTests.DbUpdate(ws, database, [
            DatabaseTests.Prop("pFil0001", "files", "Photos"),
            DatabaseTests.Prop("pFil0002", "text", "Plans"),
            DatabaseTests.Prop("pTxt0001", "text", "Note"),
        ]);
        Assert.Equal("applied", changed.GetProperty("status").GetString());
        Assert.Equal(new[] { ("pFil0001", b) }, await Held());

        // Trashed, the row still holds its files (it can be restored); deleted for good, nothing.
        await ws.Push(ws.Op("page.trash", row, new { }));
        Assert.Equal(new[] { ("pFil0001", b) }, await Held());
        Assert.Equal("applied", (await ws.Push(ws.Op("page.delete", row, new { })))[0].GetProperty("status").GetString());
        Assert.Empty(await Held());
    }

    [Fact]
    public async Task Rows_written_before_the_index_are_filled_in_by_the_worker_once()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Old rows", [DatabaseTests.Prop("pFil0001", "files", "Files")]);
        var file = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "old.png");
        await server.RunJob<AssetCheckJob>();
        var row = (await DatabaseTests.NewRow(ws, database, "Old", new { pFil0001 = new[] { file } })).GetProperty("id").GetGuid();
        // As a row written by 0.13.0 would be: its values, and nothing in the index.
        await using (var db = server.NewDb(ws.Id))
        {
            await db.DatabaseRowFiles.Where(f => f.RowId == row).ExecuteDeleteAsync();
            await db.JobStates.Where(j => j.Name == RowFilesFillJob.Done).ExecuteDeleteAsync();
        }
        await server.RunJob<RowFilesFillJob>();
        await using (var db = server.NewDb(ws.Id))
            Assert.Equal([file], await db.DatabaseRowFiles.Where(f => f.RowId == row).Select(f => f.AssetId).ToListAsync());
        var member = await server.NewAccount();
        await Kit.Join(server, ws, "member", member);
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync($"/api/v1/assets/{file}/url")).StatusCode);
    }
}
