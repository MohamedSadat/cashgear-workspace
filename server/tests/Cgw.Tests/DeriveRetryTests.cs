using Cgw.Core.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// The derive's transaction chosen as a deadlock's victim (seen once in the whole suite, as tests
/// run side by side: SQL Server's error 1205 in its references' delete) is done again, and the
/// page is derived. Provoked here: another session holds the page's link and then asks for the
/// derived row the derive has just written, at a higher deadlock priority, so the derive loses.
/// </summary>
[Collection(AloneCollection.Name)]
public sealed class DeriveRetryTests(ServerFixture server)
{
    private static async Task<object?> Scalar(SqlConnection connection, SqlTransaction? tx, string sql, Guid? page = null)
    {
        await using var command = new SqlCommand(sql, connection, tx);
        if (page is { } id) command.Parameters.Add(new SqlParameter("@p", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(id) });
        return await command.ExecuteScalarAsync();
    }

    [Fact]
    public async Task A_derive_chosen_as_a_deadlock_victim_is_done_again()
    {
        var ws = await Ws.Create(server);
        var page = await Kit.PageWithText(server, ws, "Contended");
        var linked = (await ws.NewPage("Linked")).GetProperty("id").GetGuid();
        await using (var db = server.NewDb(ws.Id))
        {
            await db.PageDocDerived.Where(d => d.PageId == page).ExecuteUpdateAsync(s => s.SetProperty(d => d.UpToSeq, 0));
            // A link the derive will take away (its text links nothing).
            db.PageLinks.Add(new PageLink { FromPageId = page, ToPageId = linked, WorkspaceId = ws.Id });
            await db.SaveChangesAsync();
        }

        await using var other = new SqlConnection(server.SqlConnection);
        await other.OpenAsync();
        await Scalar(other, null, "SET DEADLOCK_PRIORITY HIGH");
        var spid = Convert.ToInt32(await Scalar(other, null, "SELECT @@SPID"));
        await using var tx = (SqlTransaction)await other.BeginTransactionAsync();
        // Another writer of the page's links, holding them to its commit.
        await Scalar(other, tx, "UPDATE [PageLinks] SET [ToPageId] = [ToPageId] WHERE [FromPageId] = @p", page);

        // The derive writes the page's derived row, then waits for the links.
        var retried = Cgw.Worker.Jobs.DeriveJob.Retried;
        var derive = Kit.Derive(server, ws.Id, page);
        await using (var watcher = new SqlConnection(server.SqlConnection))
        {
            await watcher.OpenAsync();
            for (var i = 0; ; i++)
            {
                var blocked = Convert.ToInt32(await Scalar(watcher, null, $"SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id = {spid}"));
                if (blocked > 0) break;
                Assert.True(i < 200, "The derive never waited for the links");
                Assert.False(derive.IsCompleted, "The derive did not wait for the links");
                await Task.Delay(50);
            }
        }
        // The other writer now wants the derived row: a cycle, which SQL Server breaks by rolling the
        // derive back. This statement then goes through, and the commit lets the derive's retry in.
        await Scalar(other, tx, "UPDATE [PageDocDerived] SET [UpdatedAt] = [UpdatedAt] WHERE [PageId] = @p", page);
        await tx.CommitAsync();
        await derive;
        // It was the deadlock's victim, and was done again.
        Assert.Equal(retried + 1, Cgw.Worker.Jobs.DeriveJob.Retried);

        await using var check = server.NewDb(ws.Id);
        var derived = await check.PageDocDerived.AsNoTracking().SingleAsync(d => d.PageId == page);
        var head = await check.Pages.AsNoTracking().Where(p => p.Id == page).Select(p => p.DocHeadSeq).SingleAsync();
        Assert.Equal(head, derived.UpToSeq);
        Assert.Equal("Hello world\n", derived.PlainText);
    }
}
