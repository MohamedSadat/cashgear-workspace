using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// <c>POST /pages/{id}/erp-commits</c> (INTEGRATIONS.md, <c>Commit</c> and <c>CommitStatus</c>): each
/// real ERP commit attempt from a page is in Workspace's audit, with no value, through one of the
/// workspace's live links, by anyone who can read the page.
/// </summary>
public sealed class ErpCommitTests(ServerFixture server)
{
    private static object Report(Guid linkId, string? commitId = null, string outcome = "committed", string? blockId = "AbCdEfGhIjKl", int records = 2, int fields = 3, string connectorId = "vendors") =>
        new { linkId, connectorId, commitId = commitId ?? Guid.NewGuid().ToString("D"), blockId, outcome, records, fields };

    private static async Task<Guid> Link(Ws ws, string company)
    {
        var created = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/erp-links",
            new { erpLinkId = "erp-" + company, erpBaseUrl = "http://127.0.0.1:4282", company, companyName = company + " Trading" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        return (await Kit.Json(created)).GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task A_commit_attempt_is_audited_on_its_page_without_values()
    {
        var ws = await Ws.Create(server);
        var reader = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Vendors")).GetProperty("id").GetGuid();
        await Kit.Share(ws, page, true, ("user", reader.Id, "view"));
        var link = await Link(ws, "Kit");
        var url = $"/api/v1/pages/{page}/erp-commits";
        var commitId = Guid.NewGuid().ToString("D");

        // A reader may report one: the ERP decides who may write.
        var recorded = await reader.Client.PostAsJsonAsync(url, Report(link, commitId, "conflict", records: 4, fields: 7));
        Assert.Equal(HttpStatusCode.NoContent, recorded.StatusCode);
        foreach (var outcome in new[] { "committed", "refused", "unknown", "failed" })
            Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.PostAsJsonAsync(url, Report(link, outcome: outcome, blockId: null))).StatusCode);

        await using (var db = server.NewDb(ws.Id))
        {
            var rows = await db.AuditLog.Where(a => a.Action == "erp.commit").ToListAsync();
            Assert.Equal(5, rows.Count);
            var row = rows.Single(a => a.ActorUserId == reader.Id);
            Assert.Equal(("page", page), (row.TargetType, row.TargetId));
            var detail = JsonDocument.Parse(row.Detail!).RootElement;
            Assert.Equal(link, detail.GetProperty("linkId").GetGuid());
            Assert.Equal("erp-Kit", detail.GetProperty("erpLinkId").GetString());
            Assert.Equal("Kit", detail.GetProperty("company").GetString());
            Assert.Equal(commitId, detail.GetProperty("commitId").GetString());
            Assert.Equal("AbCdEfGhIjKl", detail.GetProperty("blockId").GetString());
            Assert.Equal("conflict", detail.GetProperty("outcome").GetString());
            Assert.Equal((4, 7), (detail.GetProperty("records").GetInt32(), detail.GetProperty("fields").GetInt32()));
            Assert.Equal(
                ["blockId", "commitId", "company", "connectorId", "erpLinkId", "fields", "linkId", "outcome", "records"],
                detail.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal));
        }
    }

    [Fact]
    public async Task Only_a_live_link_of_the_pages_workspace_and_a_well_formed_report_are_taken()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Vendors")).GetProperty("id").GetGuid();
        var hidden = (await ws.NewPage("Mine", section: ws.Personal)).GetProperty("id").GetGuid();
        var member = await Kit.Join(server, ws, "member");
        var link = await Link(ws, "Kit");
        var revoked = await Link(ws, "Dot");
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/erp-links/{revoked}")).StatusCode);
        var other = await Ws.Create(server);
        var foreign = await Link(other, "Kit");
        var url = $"/api/v1/pages/{page}/erp-commits";

        foreach (var bad in new[]
                 {
                     Report(revoked), Report(foreign), Report(Guid.CreateVersion7()), Report(link, commitId: "not-a-uuid"),
                     Report(link, outcome: "won"), Report(link, blockId: "short"), Report(link, records: 501), Report(link, records: -1),
                     Report(link, connectorId: "has space"),
                 })
        {
            var refused = await ws.Client.PostAsJsonAsync(url, bad);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }
        var noLink = await ws.Client.PostAsJsonAsync(url, new { connectorId = "vendors", commitId = Guid.NewGuid().ToString(), outcome = "committed", records = 1, fields = 1 });
        Assert.Equal(HttpStatusCode.BadRequest, noLink.StatusCode);

        // A page the caller cannot see, or a workspace they are not in: 404, as every page route.
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.PostAsJsonAsync($"/api/v1/pages/{hidden}/erp-commits", Report(link))).StatusCode);
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.PostAsJsonAsync(url, Report(link))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.Anonymous().PostAsJsonAsync(url, Report(link))).StatusCode);

        await using var db = server.NewDb(ws.Id);
        Assert.Equal(0, await db.AuditLog.CountAsync(a => a.Action == "erp.commit"));
    }
}
