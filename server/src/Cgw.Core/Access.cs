using Cgw.Core.Data;
using Cgw.Core.Sync;
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
            .Select(p => new { p.Id, p.SectionId, p.Kind, p.ParentPageId }).FirstOrDefaultAsync();
        if (page is null) return Levels.None;
        // A row's level is its database's: rows are never restricted, never walked (Phase 4).
        if (page.Kind == PageKinds.Row) return page.ParentPageId is { } database ? await PageLevelAsync(member, database) : Levels.None;
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

    /// <summary>
    /// Which of each page's pushers may edit it now (the worker, for every page it validates), in a
    /// few queries however many pages and people there are. The same rules as <see cref="PageLevelAsync"/>.
    /// </summary>
    public async Task<Dictionary<Guid, HashSet<Guid>>> EditorsAsync(Guid workspaceId, IReadOnlyDictionary<Guid, HashSet<Guid>> pushers, CancellationToken ct = default)
    {
        var users = pushers.Values.SelectMany(u => u).ToHashSet();
        var members = new List<Member>();
        foreach (var chunk in Chunked.Of(users))
            members.AddRange((await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                    .Where(m => m.WorkspaceId == workspaceId && chunk.Contains(m.UserId))
                    .Join(db.Workspaces.Where(w => w.DeletedAt == null), m => m.WorkspaceId, w => w.Id, (m, _) => m)
                    .ToListAsync(ct))
                .Select(m => new Member(m.WorkspaceId, m.UserId, m.Role)));
        var levels = await LevelsAsync(members, pushers.Keys.ToList(), ct);
        return pushers.ToDictionary(p => p.Key, p => members
            .Where(m => p.Value.Contains(m.UserId) && Levels.AtLeast(levels.GetValueOrDefault((p.Key, m.UserId), Levels.None), Levels.Edit))
            .Select(m => m.UserId).ToHashSet());
    }

    /// <summary>
    /// Which of these people are members of the page's workspace who can read the page now (at
    /// least <c>view</c>), in a few queries however many there are: who a mention or a reply may
    /// notify, who may be told who has a page open. The same rules as <see cref="PageLevelAsync"/>.
    /// </summary>
    public async Task<HashSet<Guid>> ReadersAsync(Guid workspaceId, Guid pageId, IEnumerable<Guid> userIds, CancellationToken ct = default)
    {
        var levels = await LevelsOfAsync(workspaceId, pageId, userIds, ct);
        return levels.Where(l => Levels.AtLeast(l.Value, Levels.View)).Select(l => l.Key).ToHashSet();
    }

    /// <summary>Each of these people's level on the page; <c>none</c> for someone not a member.</summary>
    public async Task<Dictionary<Guid, string>> LevelsOfAsync(Guid workspaceId, Guid pageId, IEnumerable<Guid> userIds, CancellationToken ct = default)
    {
        var users = userIds.ToHashSet();
        var members = new List<Member>();
        foreach (var chunk in Chunked.Of(users))
            members.AddRange((await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                    .Where(m => m.WorkspaceId == workspaceId && chunk.Contains(m.UserId))
                    .Join(db.Workspaces.Where(w => w.DeletedAt == null), m => m.WorkspaceId, w => w.Id, (m, _) => m)
                    .ToListAsync(ct))
                .Select(m => new Member(m.WorkspaceId, m.UserId, m.Role)));
        var levels = await LevelsAsync(members, [pageId], ct);
        return users.ToDictionary(u => u, u => levels.GetValueOrDefault((pageId, u), Levels.None));
    }

    /// <summary>One person's level on each of these pages, in four queries: the feed's pages.</summary>
    public async Task<Dictionary<Guid, string>> LevelsAsync(Member member, IReadOnlyCollection<Guid> pageIds, CancellationToken ct = default) =>
        (await LevelsAsync([member], pageIds, ct)).ToDictionary(l => l.Key.Page, l => l.Value);

    /// <summary>Each person's level on each page (<c>none</c> when it is not visible), as <see cref="PageLevelAsync"/> decides it.</summary>
    private async Task<Dictionary<(Guid Page, Guid User), string>> LevelsAsync(IReadOnlyList<Member> members, IReadOnlyCollection<Guid> pageIds, CancellationToken ct)
    {
        var result = new Dictionary<(Guid, Guid), string>();
        if (members.Count == 0 || pageIds.Count == 0) return result;
        var pages = new List<(Guid Id, string Visibility, Guid? Owner)>();
        var chains = new List<(Guid Page, Guid Ancestor, bool Restricted, int Depth)>();
        var rowPages = new List<(Guid Row, Guid Database)>();
        async Task ReadAsync(IEnumerable<Guid> ids)
        {
            foreach (var chunk in Chunked.Of(ids))
            {
                foreach (var p in await db.Pages.AsNoTracking().Where(p => chunk.Contains(p.Id) && p.DeletedAt == null)
                             .Join(db.Sections, p => p.SectionId, s => s.Id, (p, s) => new { p.Id, p.Kind, p.ParentPageId, s.Visibility, s.OwnerUserId })
                             .ToListAsync(ct))
                {
                    if (p.Kind == PageKinds.Row)
                    {
                        if (p.ParentPageId is { } database) rowPages.Add((p.Id, database));
                    }
                    else pages.Add((p.Id, p.Visibility, p.OwnerUserId));
                }
                chains.AddRange((await db.PageAncestors.AsNoTracking().Where(a => chunk.Contains(a.PageId))
                        .Join(db.Pages, a => a.AncestorPageId, p => p.Id, (a, p) => new { a.PageId, p.Id, p.Restricted, a.Depth })
                        .ToListAsync(ct))
                    .Select(c => (c.PageId, c.Id, c.Restricted, c.Depth)));
            }
        }
        await ReadAsync(pageIds);
        // Rows take their database's level: their databases are read too, only when rows were asked about.
        if (rowPages.Count > 0)
        {
            var known = pages.Select(p => p.Id).ToHashSet();
            await ReadAsync(rowPages.Select(r => r.Database).Where(id => !known.Contains(id)).Distinct().ToList());
        }
        var people = members.Select(m => m.UserId).ToList();
        var rows = new List<PagePermission>();
        foreach (var chunk in Chunked.Of(chains.Select(c => c.Ancestor).Distinct()))
            rows.AddRange(await db.PagePermissions.AsNoTracking()
                .Where(r => chunk.Contains(r.PageId)
                    && ((r.PrincipalType == "user" && people.Contains(r.PrincipalId)) || r.PrincipalType == "workspace"))
                .ToListAsync(ct));
        var byPage = rows.ToLookup(r => r.PageId);
        var chainOf = chains.ToLookup(c => c.Page);
        foreach (var page in pages)
        {
            var chain = chainOf[page.Id].OrderBy(c => c.Depth).ToList();
            foreach (var member in members)
            {
                string? level;
                if (page.Visibility == "private") level = page.Owner == member.UserId ? Levels.Full : Levels.None;
                else if (member.IsAdmin) level = Levels.Full;
                else
                {
                    level = null;
                    foreach (var link in chain)
                        if ((level = Decide(member, link.Restricted, byPage[link.Ancestor])) is not null)
                            break;
                }
                result[(page.Id, member.UserId)] = level ?? Default(member);
            }
        }
        foreach (var (row, database) in rowPages)
            foreach (var member in members)
                result[(row, member.UserId)] = result.GetValueOrDefault((database, member.UserId), Levels.None);
        return result;
    }

    /// <summary>
    /// A page's level from <see cref="AllLevelsAsync"/>'s answer, which holds pages and databases:
    /// a row's is its database's.
    /// </summary>
    public static string LevelIn(IReadOnlyDictionary<Guid, string> levels, Page page) =>
        levels.GetValueOrDefault(page.Kind == PageKinds.Row && page.ParentPageId is { } database ? database : page.Id, Levels.None);

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
    /// Every page and database of the workspace with the caller's level: for the change feed, the
    /// tree and search, where one page at a time would be one query per row. Rows are not in it
    /// (their level is their database's, <see cref="LevelIn"/>), so a database's rows cost nothing
    /// here (the filtered index <c>IX_Pages_Tree</c>).
    /// </summary>
    public async Task<Dictionary<Guid, string>> AllLevelsAsync(Member member)
    {
        var pages = await db.Pages.AsNoTracking().Where(p => p.Kind != PageKinds.Row && p.DeletedAt == null)
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

    /// <summary>
    /// The level a page deleted for good gave the caller, as far as what is left of it says: its
    /// tombstone and those above it, then the live ancestor where the chain is whole again. Once the
    /// purge has removed a tombstone's rows, a restricted one gives no one anything.
    /// </summary>
    public async Task<string> DeletedLevelAsync(Member member, Page page)
    {
        var section = await db.Sections.AsNoTracking().Where(s => s.Id == page.SectionId)
            .Select(s => new { s.Visibility, s.OwnerUserId }).FirstOrDefaultAsync();
        if (section is null) return Levels.None;
        if (section.Visibility == "private") return section.OwnerUserId == member.UserId ? Levels.Full : Levels.None;
        if (member.IsAdmin) return Levels.Full;
        Guid? cursor = page.Id;
        for (var steps = 0; cursor is { } id && steps < 1000; steps++)
        {
            var node = await db.Pages.AsNoTracking().Where(p => p.Id == id)
                .Select(p => new { p.ParentPageId, p.Restricted, p.DeletedAt }).FirstOrDefaultAsync();
            if (node is null) break;
            if (node.DeletedAt is null) return await PageLevelAsync(member, id);
            var rows = await db.PagePermissions.AsNoTracking()
                .Where(r => r.PageId == id && ((r.PrincipalType == "user" && r.PrincipalId == member.UserId) || r.PrincipalType == "workspace"))
                .ToListAsync();
            if (Decide(member, node.Restricted, rows) is { } decided) return decided;
            cursor = node.ParentPageId;
        }
        return Default(member);
    }

    /// <summary>
    /// The nearest page, from <paramref name="from"/> up, that decides access for some principal
    /// (restricted, or holding any row); null when only the role defaults apply.
    /// </summary>
    public async Task<Guid?> DecidingPageAsync(Guid? from)
    {
        if (from is not { } start) return null;
        var chain = await db.PageAncestors.AsNoTracking().Where(a => a.PageId == start)
            .Join(db.Pages, a => a.AncestorPageId, p => p.Id, (a, p) => new
            {
                p.Id,
                a.Depth,
                Decides = p.Restricted || db.PagePermissions.Any(r => r.PageId == p.Id),
            })
            .OrderBy(x => x.Depth).ToListAsync();
        return chain.FirstOrDefault(c => c.Decides)?.Id;
    }

    /// <summary>
    /// The rows a restricted page needs to give everyone what the chain from <paramref name="from"/>
    /// (that page and its ancestors) gives a page under it now: the workspace's level, and each
    /// person whose own row decides theirs. Nothing (only admins) when there is no chain.
    /// </summary>
    public async Task<List<AccessRow>> EffectiveRowsAsync(Guid workspaceId, Guid? from)
    {
        if (from is not { } start) return [];
        var chain = await db.PageAncestors.AsNoTracking().Where(a => a.PageId == start)
            .Join(db.Pages, a => a.AncestorPageId, p => p.Id, (a, p) => new { p.Id, p.Restricted, a.Depth })
            .OrderBy(x => x.Depth).ToListAsync();
        if (chain.Count == 0) return [];
        // Nothing above the first restricted page reaches below it.
        var cut = chain.TakeWhile(c => !c.Restricted).ToList();
        if (cut.Count < chain.Count) cut.Add(chain[cut.Count]);
        var ids = cut.Select(c => c.Id).ToList();
        var rows = (await db.PagePermissions.AsNoTracking().Where(r => ids.Contains(r.PageId)).ToListAsync()).ToLookup(r => r.PageId);

        // A member with no row of their own: the first workspace row, else what the chain ends in.
        var workspace = cut[^1].Restricted ? Levels.None : Levels.Edit;
        foreach (var link in cut)
            if (rows[link.Id].FirstOrDefault(r => r.PrincipalType == "workspace") is { } row)
            {
                workspace = row.Level;
                break;
            }
        var result = new List<AccessRow>();
        if (workspace != Levels.None) result.Add(new AccessRow("workspace", workspaceId, workspace));

        var people = rows.SelectMany(g => g).Where(r => r.PrincipalType == "user").Select(r => r.PrincipalId).Distinct().ToList();
        var roles = await db.WorkspaceMembers.AsNoTracking().Where(m => people.Contains(m.UserId)).ToDictionaryAsync(m => m.UserId, m => m.Role);
        foreach (var person in people)
        {
            // Someone no longer in the workspace has nothing to keep.
            if (!roles.TryGetValue(person, out var role)) continue;
            var member = new Member(workspaceId, person, role);
            foreach (var link in cut)
            {
                if (rows[link.Id].FirstOrDefault(r => r.PrincipalType == "user" && r.PrincipalId == person) is { } own)
                {
                    result.Add(new AccessRow("user", person, own.Level));
                    break;
                }
                // Decided by the workspace's row or a restriction: the rows above say the same.
                if (Decide(member, link.Restricted, rows[link.Id]) is not null) break;
            }
        }
        return result;
    }

    /// <summary>What a restricted page holding <paramref name="rows"/> gives someone.</summary>
    public static string LevelUnder(Member member, IEnumerable<AccessRow> rows)
    {
        if (member.IsAdmin) return Levels.Full;
        string? workspace = null;
        foreach (var row in rows)
        {
            if (row.PrincipalType == "user" && row.PrincipalId == member.UserId) return row.Level;
            if (row.PrincipalType == "workspace" && !member.IsGuest) workspace = row.Level;
        }
        return workspace ?? Levels.None;
    }
}

/// <summary>A row of a page's access list: who, and at which level.</summary>
public sealed record AccessRow(string PrincipalType, Guid PrincipalId, string Level);
