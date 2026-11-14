using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Documents;

/// <summary>A page's caller: their membership, the page, and their level on it.</summary>
public sealed record PageAccess(Member Member, Page Page, string Level);

/// <summary>
/// The check every page route makes, and every hub call that names a page (Phase 6 contracts,
/// section 1: "as a pull"): the page's workspace is found, the caller's membership in it checked and
/// the tenant scope entered. A page the caller may not see is 404, as if it did not exist; a page
/// deleted for good is 410, to those who could see it. Read fresh each time it is asked.
/// </summary>
public sealed class PageGate(Access access, TenantScope scope, CgwDb db)
{
    public async Task<Result<PageAccess>> OpenAsync(Guid userId, Guid pageId, CancellationToken ct = default)
    {
        var page = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(p => p.Id == pageId, ct);
        if (page is null || await access.MemberAsync(page.WorkspaceId, userId) is not { } member) return Failure.NotFound("No such page");
        scope.Enter(page.WorkspaceId);
        // The level first: that a page was deleted is said only to those who could see it.
        var level = page.DeletedAt is null ? await access.PageLevelAsync(member, page.Id) : await access.DeletedLevelAsync(member, page);
        if (level == Levels.None) return Failure.NotFound("No such page");
        if (page.DeletedAt is not null) return new Failure(Codes.PageGone, 410, "The page was deleted for good");
        return new PageAccess(member, page, level);
    }
}
