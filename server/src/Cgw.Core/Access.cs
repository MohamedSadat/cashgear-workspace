using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core;

/// <summary>A caller in a workspace: who and with which role.</summary>
public sealed record Member(Guid WorkspaceId, Guid UserId, string Role)
{
    public bool IsAdmin => Roles.IsAdmin(Role);
    public bool IsGuest => Role == Roles.Guest;
}

/// <summary>
/// How access is decided, on the server, for every request (DATA_MODEL.md, Permissions):
/// 1. the caller must be a member of the workspace;
/// 2. owners and admins have full on everything in shared sections;
/// 3. a private section is its owner's only;
/// 4. otherwise the nearest page, walking up from the page, that is restricted or has a row for
///    the caller decides; failing that, the role's default (member: edit, guest: none);
/// 5. so a guest sees only what was shared with them by name.
/// A row for the whole workspace counts for members (not guests).
/// </summary>
public sealed class Access(CgwDb db)
{
    public async Task<Member?> MemberAsync(Guid workspaceId, Guid userId)
    {
        var row = await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(m => m.WorkspaceId == workspaceId && m.UserId == userId)
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), m => m.WorkspaceId, w => w.Id, (m, _) => m)
            .FirstOrDefaultAsync();
        return row is null ? null : new Member(row.WorkspaceId, row.UserId, row.Role);
    }

    /// <summary>The caller's level on one page; <c>none</c> when it is not visible.</summary>
    public async Task<string> PageLevelAsync(Member member, Guid pageId)
    {
        var page = await db.Pages.AsNoTracking().Where(p => p.Id == pageId && p.DeletedAt == null)
            .Select(p => new { p.Id, p.SectionId }).FirstOrDefaultAsync();
        if (page is null) return Levels.None;
        var section = await db.Sections.AsNoTracking().Where(s => s.Id == page.SectionId)
            .Select(s => new { s.Visibility, s.OwnerUserId }).FirstOrDefaultAsync();
        if (section is null) return Levels.None;
        if (section.Visibility == "private") return section.OwnerUserId == member.UserId ? Levels.Full : Levels.None;
        if (member.IsAdmin) return Levels.Full;

        // The page and its ancestors, nearest first, with their flags and the caller's rows.
        var chain = await db.PageAncestors.AsNoTracking().Where(a => a.PageId == pageId)
            .Join(db.Pages, a => a.AncestorPageId, p => p.Id, (a, p) => new { p.Id, p.Restricted, a.Depth })
            .OrderBy(x => x.Depth).ToListAsync();
        var ids = chain.Select(c => c.Id).ToList();
        var rows = await db.PagePermissions.AsNoTracking()
            .Where(r => ids.Contains(r.PageId)
                && ((r.PrincipalType == "user" && r.PrincipalId == member.UserId) || r.PrincipalType == "workspace"))
            .ToListAsync();
        foreach (var link in chain)
        {
            var decided = Decide(member, link.Restricted, rows.Where(r => r.PageId == link.Id));
            if (decided is not null) return decided;
        }
        return Default(member);
    }

    private static string Default(Member member) => member.IsGuest ? Levels.None : Levels.Edit;

    /// <summary>The level one page gives, or null when it does not decide.</summary>
    private static string? Decide(Member member, bool restricted, IEnumerable<PagePermission> rows)
    {
        string? user = null, workspace = null;
        foreach (var row in rows)
        {
            if (row.PrincipalType == "user" && row.PrincipalId == member.UserId) user = row.Level;
            else if (row.PrincipalType == "workspace" && !member.IsGuest) workspace = row.Level;
        }
        if (user is not null) return user;
        if (workspace is not null) return workspace;
        return restricted ? Levels.None : null;
    }

    /// <summary>
    /// Every page of the workspace with the caller's level: for the change feed, the tree and
    /// search, where one page at a time would be one query per row.
    /// </summary>
    public async Task<Dictionary<Guid, string>> AllLevelsAsync(Member member)
    {
        var pages = await db.Pages.AsNoTracking().Where(p => p.DeletedAt == null)
            .Select(p => new { p.Id, p.ParentPageId, p.SectionId, p.Restricted }).ToListAsync();
        var sections = await db.Sections.AsNoTracking().ToDictionaryAsync(s => s.Id, s => (s.Visibility, s.OwnerUserId));
        var rows = (await db.PagePermissions.AsNoTracking()
                .Where(r => (r.PrincipalType == "user" && r.PrincipalId == member.UserId) || r.PrincipalType == "workspace")
                .ToListAsync())
            .ToLookup(r => r.PageId);
        var byId = pages.ToDictionary(p => p.Id);
        var levels = new Dictionary<Guid, string>(pages.Count);

        // Iterative, so a deep tree cannot overflow the stack: walk up to the first page whose level
        // is known or decided, then hand it down the path.
        foreach (var start in pages)
        {
            var path = new List<Guid>();
            string? found = null;
            for (Guid? cursor = start.Id; cursor is { } id && found is null;)
            {
                if (levels.TryGetValue(id, out var known))
                {
                    found = known;
                    break;
                }
                var page = byId[id];
                path.Add(id);
                if (!sections.TryGetValue(page.SectionId, out var section)) found = Levels.None;
                else if (section.Visibility == "private") found = section.OwnerUserId == member.UserId ? Levels.Full : Levels.None;
                else if (member.IsAdmin) found = Levels.Full;
                else found = Decide(member, page.Restricted, rows[id]);
                if (found is null)
                    cursor = page.ParentPageId is { } parent && byId.ContainsKey(parent) && path.Count < 100_000 ? parent : null;
            }
            found ??= Default(member);
            foreach (var id in path) levels[id] = found;
        }
        return levels;
    }

    /// <summary>Whether the caller sees a section at all.</summary>
    public static bool SeesSection(Member member, Section section) =>
        section.Visibility != "private" || section.OwnerUserId == member.UserId;
}
