using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// ERP links (INTEGRATIONS.md, Linking a workspace to a company): members read them, owners and
/// admins make and end them, only for the ERP of <c>Erp__ApiBase</c>, one per company, audited,
/// and nothing secret kept.
/// </summary>
public sealed class ErpLinkTests(ServerFixture server)
{
    /// <summary>The development default of <c>Erp__ApiBase</c>: the mock ERP.</summary>
    private const string Erp = "http://127.0.0.1:4282";

    private static object Link(string company = "Kit", string erpBaseUrl = Erp, string erpLinkId = "erp-link-1") =>
        new { erpLinkId, erpBaseUrl, company, companyName = "Kit Trading" };

    [Fact]
    public async Task Owners_and_admins_link_the_workspace_to_a_company_of_the_configured_erp()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var url = $"/api/v1/workspaces/{ws.Id}/erp-links";

        var byMember = await member.Client.PostAsJsonAsync(url, Link());
        Assert.Equal(HttpStatusCode.Forbidden, byMember.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(byMember));
        foreach (var other in new[] { "https://api.cashgearerp.com", "http://127.0.0.1:4282/evil", "http://127.0.0.1:4283", "not a url", "" })
        {
            var refused = await admin.Client.PostAsJsonAsync(url, Link(erpBaseUrl: other));
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.Client.PostAsJsonAsync(url, new { erpLinkId = "x", erpBaseUrl = Erp, company = "", companyName = "x" })).StatusCode);

        var created = await admin.Client.PostAsJsonAsync(url, Link(erpBaseUrl: Erp + "/"));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var link = await Kit.Json(created);
        Assert.Equal("erp-link-1", link.GetProperty("erpLinkId").GetString());
        Assert.Equal(Erp, link.GetProperty("erpBaseUrl").GetString());
        Assert.Equal("Kit", link.GetProperty("company").GetString());
        Assert.Equal("Kit Trading", link.GetProperty("companyName").GetString());
        Assert.Equal(admin.Id, link.GetProperty("linkedBy").GetProperty("id").GetGuid());
        var id = link.GetProperty("id").GetGuid();

        // Every member reads them; the same company twice is a conflict.
        foreach (var reader in new[] { member, guest })
            Assert.Equal(id, Assert.Single((await reader.Client.GetFromJsonAsync<JsonElement>(url)).GetProperty("links").EnumerateArray()).GetProperty("id").GetGuid());
        var twice = await ws.Client.PostAsJsonAsync(url, Link(company: "KIT", erpLinkId: "erp-link-2"));
        Assert.Equal(HttpStatusCode.Conflict, twice.StatusCode);
        Assert.Equal("conflict", await Kit.Code(twice));
        Assert.Equal(HttpStatusCode.Created, (await ws.Client.PostAsJsonAsync(url, Link(company: "Other", erpLinkId: "erp-link-3"))).StatusCode);

        // Unlinking: owners and admins; the link is no longer offered; the company can be linked again.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.DeleteAsync($"{url}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Client.DeleteAsync($"{url}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Client.DeleteAsync($"{url}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Client.DeleteAsync($"{url}/{Guid.CreateVersion7()}")).StatusCode);
        Assert.DoesNotContain(id, (await member.Client.GetFromJsonAsync<JsonElement>(url)).GetProperty("links").EnumerateArray().Select(l => l.GetProperty("id").GetGuid()));
        Assert.Equal(HttpStatusCode.Created, (await ws.Client.PostAsJsonAsync(url, Link(erpLinkId: "erp-link-4"))).StatusCode);

        // Another workspace sees none of it.
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync(url)).StatusCode);

        await using var db = server.NewDb(ws.Id);
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "erp.link" && a.TargetId == id && a.ActorUserId == admin.Id));
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "erp.unlink" && a.TargetId == id));
        var row = await db.ErpLinks.SingleAsync(l => l.Id == id);
        Assert.NotNull(row.RevokedAt);
        Assert.Equal(admin.Id, row.RevokedBy);
        // What a link holds: where, which company, who and when. No key, token or session.
        Assert.Equal(
            ["Company", "CompanyName", "ErpBaseUrl", "ErpLinkId", "Id", "LinkedAt", "LinkedBy", "RevokedAt", "RevokedBy", "WorkspaceId"],
            db.Model.FindEntityType(typeof(Cgw.Core.Data.ErpLink))!.GetProperties().Select(p => p.Name).Order(StringComparer.Ordinal));
    }
}
