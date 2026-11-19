using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Documents;

/// <summary>A page's caller: their membership, the page, and their level on it.</summary>
public sealed record PageAccess(Member Member, Page Page, string Level);

/// <summary>
/// The check every page route makes, and every hub call that names a page (Phase 6 contracts,
/// section 1: "as a pull"): the page's workspace is found, the caller's membership in it checked and
/// the tenant scope entered. A page the caller may not see is 404, as if it did not exist; a page
/// deleted for good is 410, to those who could see it. Read fresh each time it is asked: the page,
/// the caller's membership and the page's section in one round trip (Phase 8: a live page pushes
/// about once a key), then the ancestors' access rows for a caller the section does not decide. The
/// hub's push reads the same row in its own batch (<see cref="DocService.PushThroughGateAsync"/>).
/// </summary>
public sealed class PageGate(Access access, TenantScope scope, CgwDb db)
{
    /// <summary>
    /// What the gate reads: the page, the caller's role in its workspace, and the page's section's
    /// visibility and owner (a visibility is never null, so null is no section).
    /// </summary>
    public sealed record GateRow(Page Page, string? Role, string? Visibility, Guid? Owner);

    /// <summary>
    /// The page, the caller's role in its workspace (as <see cref="Access.MemberAsync"/>: a member of
    /// a workspace not deleted) and the page's section (as <see cref="Access.PageLevelAsync(Member, Guid)"/>
    /// reads it, in the page's workspace). Compiled once: it runs for every push.
    /// </summary>
    private static readonly Func<CgwDb, Guid, Guid, CancellationToken, Task<GateRow?>> Read = EF.CompileAsyncQuery(
        (CgwDb db, Guid pageId, Guid userId, CancellationToken ct) => db.Pages.IgnoreQueryFilters(new[] { CgwDb.Tenant }).AsNoTracking()
            .Where(p => p.Id == pageId)
            .Select(p => new GateRow(
                p,
                db.WorkspaceMembers.IgnoreQueryFilters(new[] { CgwDb.Tenant })
                    .Where(m => m.WorkspaceId == p.WorkspaceId && m.UserId == userId && db.Workspaces.Any(w => w.Id == m.WorkspaceId && w.DeletedAt == null))
                    .Select(m => m.Role).FirstOrDefault(),
                db.Sections.IgnoreQueryFilters(new[] { CgwDb.Tenant }).Where(x => x.Id == p.SectionId && x.WorkspaceId == p.WorkspaceId)
                    .Select(x => x.Visibility).FirstOrDefault(),
                db.Sections.IgnoreQueryFilters(new[] { CgwDb.Tenant }).Where(x => x.Id == p.SectionId && x.WorkspaceId == p.WorkspaceId)
                    .Select(x => x.OwnerUserId).FirstOrDefault()))
            .FirstOrDefault());

    public async Task<Result<PageAccess>> OpenAsync(Guid userId, Guid pageId, CancellationToken ct = default) =>
        await DecideAsync(userId, await Read(db, pageId, userId, ct));

    /// <summary>
    /// <see cref="OpenAsync"/> for a request that acts in one workspace (Phase 12: the batch pull):
    /// a page of another workspace is 404, as if it did not exist, whatever the caller may see there.
    /// The same read and the same decision otherwise. <paramref name="rowLevels"/>, kept by the
    /// caller for one request, holds the level of each database whose rows it has opened: a row's
    /// level is its database's (<see cref="Access"/>), so the rows of one database are decided once.
    /// </summary>
    public async Task<Result<PageAccess>> OpenInAsync(Guid userId, Guid workspaceId, Guid pageId, Dictionary<Guid, string>? rowLevels = null, CancellationToken ct = default)
    {
        var found = await Read(db, pageId, userId, ct);
        if (found is not null && found.Page.WorkspaceId != workspaceId) return Failure.NotFound("No such page");
        return await DecideAsync(userId, found, rowLevels);
    }

    /// <summary>The gate's decision on what it read (null: no such page).</summary>
    public Task<Result<PageAccess>> DecideAsync(Guid userId, GateRow? found) => DecideAsync(userId, found, null);

    private async Task<Result<PageAccess>> DecideAsync(Guid userId, GateRow? found, Dictionary<Guid, string>? rowLevels)
    {
        if (found is null || found.Role is not { } role) return Failure.NotFound("No such page");
        var page = found.Page;
        var member = new Member(page.WorkspaceId, userId, role);
        Enter(page.WorkspaceId);
        // The level first: that a page was deleted is said only to those who could see it.
        string level;
        if (page.DeletedAt is not null) level = await access.DeletedLevelAsync(member, page);
        else if (rowLevels is not null && page.Kind == PageKinds.Row && page.ParentPageId is { } database)
        {
            if (!rowLevels.TryGetValue(database, out var known))
                rowLevels[database] = known = await access.PageLevelAsync(member, page, found.Visibility, found.Owner, found.Visibility is not null);
            level = known;
        }
        else level = await access.PageLevelAsync(member, page, found.Visibility, found.Owner, found.Visibility is not null);
        if (level == Levels.None) return Failure.NotFound("No such page");
        if (page.DeletedAt is not null) return new Failure(Codes.PageGone, 410, "The page was deleted for good");
        return new PageAccess(member, page, level);
    }

    /// <summary>Enters the page's workspace, as the gate does for a page it lets through.</summary>
    public void Enter(Guid workspaceId) => scope.Enter(workspaceId);
}
