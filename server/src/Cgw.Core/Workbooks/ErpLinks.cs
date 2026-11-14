using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workbooks;

/// <summary><c>ErpLink</c> (INTEGRATIONS.md, Linking a workspace to a company).</summary>
public sealed record ErpLinkDto(Guid Id, string ErpLinkId, string ErpBaseUrl, string Company, string CompanyName, UserRefDto LinkedBy, DateTimeOffset LinkedAt);

public sealed record ErpLinksDto(IReadOnlyList<ErpLinkDto> Links);

/// <summary>What the ERP answered the browser's redemption of its link ticket with, and where it is.</summary>
public sealed record NewErpLink(string? ErpLinkId, string? ErpBaseUrl, string? Company, string? CompanyName);

/// <summary>
/// A workspace's links to ERP companies: members read them, owners and admins make and end them.
/// A link says where to ask (always <c>Erp__ApiBase</c>) and the ERP's own link id; no key, token
/// or session is stored, and the ERP checks its own link on every session. Ending one here stops
/// Workspace offering it; the ERP's revoke is in the ERP client.
/// </summary>
public sealed class ErpLinkService(CgwDb db, WorkbookService workbooks, Audit audit, TimeProvider clock, Integrations settings)
{
    public const int MaxLinks = 50;

    public async Task<ErpLinksDto> ListAsync(CancellationToken ct = default)
    {
        var links = await db.ErpLinks.AsNoTracking().Where(l => l.RevokedAt == null).OrderBy(l => l.LinkedAt).ThenBy(l => l.Id).ToListAsync(ct);
        var names = await workbooks.NamesAsync(links.Select(l => l.LinkedBy), ct);
        return new ErpLinksDto(links.Select(l => Dto(l, names)).ToList());
    }

    private static ErpLinkDto Dto(ErpLink l, IReadOnlyDictionary<Guid, string> names) =>
        new(l.Id, l.ErpLinkId, l.ErpBaseUrl, l.Company, l.CompanyName, new UserRefDto(l.LinkedBy, names.GetValueOrDefault(l.LinkedBy) ?? "Someone"), l.LinkedAt);

    /// <summary>Printable text of 1 to <paramref name="max"/> characters, trimmed; null otherwise.</summary>
    private static string? Field(string? value, int max)
    {
        var text = value?.Trim();
        return text is { Length: > 0 } && text.Length <= max && !text.Any(char.IsControl) ? text : null;
    }

    public async Task<Result<ErpLinkDto>> CreateAsync(Member member, Actor actor, NewErpLink request, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin links the workspace to the ERP");
        if (Field(request.ErpLinkId, 100) is not { } erpLinkId) return Failure.Invalid("erpLinkId is the ERP's link id, 1 to 100 characters");
        if (Field(request.Company, 100) is not { } company) return Failure.Invalid("company is the ERP company's code, 1 to 100 characters");
        if (Field(request.CompanyName, 200) is not { } companyName) return Failure.Invalid("companyName is 1 to 200 characters");
        // Only the ERP this API is configured for: no ERP address is ever taken from a link or a page.
        if (Integrations.Base(request.ErpBaseUrl) is not { } baseUrl || settings.ErpApiBase.Length == 0
            || !string.Equals(baseUrl, settings.ErpApiBase, StringComparison.OrdinalIgnoreCase))
            return Failure.Invalid("erpBaseUrl is not the ERP this workspace may link to");
        var live = await db.ErpLinks.AsNoTracking().Where(l => l.RevokedAt == null).ToListAsync(ct);
        if (live.Any(l => string.Equals(l.Company, company, StringComparison.OrdinalIgnoreCase) && string.Equals(l.ErpBaseUrl, settings.ErpApiBase, StringComparison.OrdinalIgnoreCase)))
            return Failure.Conflict(Codes.Conflict, "The workspace is linked to that company already");
        if (live.Count >= MaxLinks) return Failure.Conflict(Codes.Conflict, $"A workspace has at most {MaxLinks} ERP links");
        var link = new ErpLink
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            ErpLinkId = erpLinkId,
            ErpBaseUrl = settings.ErpApiBase,
            Company = company,
            CompanyName = companyName,
            LinkedBy = member.UserId,
            LinkedAt = clock.GetUtcNow(),
        };
        db.ErpLinks.Add(link);
        audit.Add(actor, "erp.link", member.WorkspaceId, "erpLink", link.Id, new { erpLinkId, erpBaseUrl = link.ErpBaseUrl, company, companyName });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            return Failure.Conflict(Codes.Conflict, "The workspace is linked to that company already");
        }
        return Dto(link, await workbooks.NamesAsync([member.UserId], ct));
    }

    public async Task<Result<bool>> RevokeAsync(Member member, Actor actor, Guid linkId, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin unlinks the workspace from the ERP");
        var link = await db.ErpLinks.FirstOrDefaultAsync(l => l.Id == linkId, ct);
        if (link is null) return Failure.NotFound("No such ERP link");
        if (link.RevokedAt is not null) return true;
        link.RevokedAt = clock.GetUtcNow();
        link.RevokedBy = member.UserId;
        audit.Add(actor, "erp.unlink", member.WorkspaceId, "erpLink", link.Id, new { link.ErpLinkId, link.Company });
        await db.SaveChangesAsync(ct);
        return true;
    }
}
