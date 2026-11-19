using Cgw.Core.Data;
using Cgw.Core.Sharing;
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
///    the caller decides: a row for the caller is their own, one of a group they are in (Phase 11),
///    or the whole workspace's (not for a guest). There their own row gives their level; else the
///    highest of their groups' rows; else the workspace's; else (restricted) none. Failing that, the
///    role's default (member: edit, guest: none);
/// 5. so a guest sees only what was shared with them by name (guests are never in a group).
/// A row of a database takes its database's level. Every copy below decides through
/// <see cref="Speaks"/>; the caller's groups are read with their rows, or once a call for many people.
/// </summary>
public sealed class Access(CgwDb db)
{
    private static readonly IReadOnlySet<Guid> NoGroups = new HashSet<Guid>();

    public async Task<Member?> MemberAsync(Guid workspaceId, Guid userId)
    {
        var row = await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(m => m.WorkspaceId == workspaceId && m.UserId == userId)
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), m => m.WorkspaceId, w => w.Id, (m, _) => m)
            .FirstOrDefaultAsync();
        return row is null ? null : new Member(row.WorkspaceId, row.UserId, row.Role);
    }

    /// <summary>The groups this person is in, in their workspace; none for a guest (guests are never in a group).</summary>
    public async Task<HashSet<Guid>> GroupsAsync(Member member, CancellationToken ct = default)
    {
        if (member.IsGuest) return [];
        var groups = await db.WorkspaceGroupMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(g => g.WorkspaceId == member.WorkspaceId && g.UserId == member.UserId)
            .Select(g => g.GroupId).ToListAsync(ct);
        return [.. groups];
    }

    /// <summary>Each of these people's groups (none for a guest), in a query a thousand people.</summary>
    private async Task<Dictionary<Guid, HashSet<Guid>>> GroupsOfAsync(IReadOnlyList<Member> members, CancellationToken ct)
    {
        var result = new Dictionary<Guid, HashSet<Guid>>();
        foreach (var member in members) result.TryAdd(member.UserId, []);
        foreach (var workspace in members.Where(m => !m.IsGuest).GroupBy(m => m.WorkspaceId))
        {
            var id = workspace.Key;
            foreach (var chunk in Chunked.Of(workspace.Select(m => m.UserId).Distinct()))
                foreach (var row in await db.WorkspaceGroupMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                             .Where(g => g.WorkspaceId == id && chunk.Contains(g.UserId))
                             .Select(g => new { g.UserId, g.GroupId }).ToListAsync(ct))
                    result[row.UserId].Add(row.GroupId);
        }
        return result;
    }

    /// <summary>
    /// The page rows that may speak for one person: their own, the workspace's and (not for a
    /// guest) those of the groups they are in, the groups read in the same query.
    /// </summary>
    private IQueryable<PagePermission> RowsFor(Member member)
    {
        var user = member.UserId;
        var workspace = member.WorkspaceId;
        var grouped = !member.IsGuest;
        return db.PagePermissions.AsNoTracking().Where(r =>
            (r.PrincipalType == Principals.User && r.PrincipalId == user)
            || r.PrincipalType == Principals.Workspace
            || (grouped && r.PrincipalType == Principals.Group
                && db.WorkspaceGroupMembers.Any(g => g.GroupId == r.PrincipalId && g.UserId == user && g.WorkspaceId == workspace)));
    }

    /// <summary>The groups of rows read by <see cref="RowsFor"/>: each is one the person is in.</summary>
    private static HashSet<Guid> GroupsIn(IEnumerable<PagePermission> rows) =>
        rows.Where(r => r.PrincipalType == Principals.Group).Select(r => r.PrincipalId).ToHashSet();

    private static AccessRow Row(PagePermission row) => new(row.PrincipalType, row.PrincipalId, row.Level);

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
        return await LevelInSectionAsync(member, pageId, section.Visibility, section.OwnerUserId);
    }

    /// <summary>
    /// <see cref="PageLevelAsync(Member, Guid)"/> of a live page read already with its section (the
    /// page gate reads them with the membership in one round trip, Phase 8).
    /// </summary>
    public async Task<string> PageLevelAsync(Member member, Page page, string? sectionVisibility, Guid? sectionOwner, bool sectionFound)
    {
        if (page.DeletedAt is not null) return Levels.None;
        if (page.Kind == PageKinds.Row) return page.ParentPageId is { } database ? await PageLevelAsync(member, database) : Levels.None;
        if (!sectionFound) return Levels.None;
        return await LevelInSectionAsync(member, page.Id, sectionVisibility!, sectionOwner);
    }

    private async Task<string> LevelInSectionAsync(Member member, Guid pageId, string visibility, Guid? owner)
    {
        if (visibility == "private") return owner == member.UserId ? Levels.Full : Levels.None;
        if (member.IsAdmin) return Levels.Full;

        // The page and its ancestors, nearest first, with their flags and the caller's rows.
        var chain = await db.PageAncestors.AsNoTracking().Where(a => a.PageId == pageId)
            .Join(db.Pages, a => a.AncestorPageId, p => p.Id, (a, p) => new { p.Id, p.Restricted, a.Depth })
            .OrderBy(x => x.Depth).ToListAsync();
        var ids = chain.Select(c => c.Id).ToList();
        var rows = await RowsFor(member).Where(r => ids.Contains(r.PageId)).ToListAsync();
        var groups = GroupsIn(rows);
        var byPage = rows.ToLookup(r => r.PageId, Row);
        foreach (var link in chain)
        {
            var decided = Decide(member, groups, link.Restricted, byPage[link.Id]);
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

    /// <summary>One person's level on each of these pages, in five queries: the feed's pages.</summary>
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
        // Everyone's groups at once, then the rows of the chains for any of them.
        var groupsOf = pages.Count > 0 ? await GroupsOfAsync(members, ct) : [];
        var people = members.Select(m => m.UserId).ToList();
        var groupIds = groupsOf.Values.SelectMany(g => g).Distinct().ToList();
        var rows = new List<PagePermission>();
        foreach (var chunk in Chunked.Of(chains.Select(c => c.Ancestor).Distinct()))
            rows.AddRange(await db.PagePermissions.AsNoTracking()
                .Where(r => chunk.Contains(r.PageId)
                    && ((r.PrincipalType == Principals.User && people.Contains(r.PrincipalId))
                        || r.PrincipalType == Principals.Workspace
                        || (r.PrincipalType == Principals.Group && groupIds.Contains(r.PrincipalId))))
                .ToListAsync(ct));
        var byPage = rows.ToLookup(r => r.PageId, Row);
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
                    IReadOnlySet<Guid> groups = groupsOf.GetValueOrDefault(member.UserId) ?? NoGroups;
                    foreach (var link in chain)
                        if ((level = Decide(member, groups, link.Restricted, byPage[link.Ancestor])) is not null)
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

    /// <summary>
    /// What one page's or one workbook's rows give someone, by the rule's order: their own row;
    /// else the highest of the rows of groups they are in; else the workspace's (not for a guest);
    /// null when no row speaks for them. Every copy of the rule decides through this.
    /// </summary>
    public static string? Speaks(Member member, IReadOnlySet<Guid> groups, IEnumerable<AccessRow> rows)
    {
        string? group = null, workspace = null;
        foreach (var row in rows)
        {
            switch (row.PrincipalType)
            {
                case Principals.User when row.PrincipalId == member.UserId:
                    return row.Level;
                case Principals.Group when !member.IsGuest && groups.Contains(row.PrincipalId):
                    if (group is null || Levels.Rank(row.Level) > Levels.Rank(group)) group = row.Level;
                    break;
                case Principals.Workspace when !member.IsGuest:
                    workspace = row.Level;
                    break;
            }
        }
        return group ?? workspace;
    }

    /// <summary>The level one page gives, or null when it does not decide.</summary>
    private static string? Decide(Member member, IReadOnlySet<Guid> groups, bool restricted, IEnumerable<AccessRow> rows) =>
        Speaks(member, groups, rows) ?? (restricted ? Levels.None : null);

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
        var all = await RowsFor(member).ToListAsync();
        var groups = GroupsIn(all);
        var rows = all.ToLookup(r => r.PageId, Row);
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
                else found = Decide(member, groups, page.Restricted, rows[id]);
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
            var rows = await RowsFor(member).Where(r => r.PageId == id).ToListAsync();
            if (Decide(member, GroupsIn(rows), node.Restricted, rows.Select(Row)) is { } decided) return decided;
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
    /// (that page and its ancestors) gives a page under it now: the workspace's level; each group's
    /// nearest row (a group's row is copied as a group row, as a person's is as theirs); each person
    /// whose own row decides theirs; and a row for each other person those copies would not give
    /// exactly what they have (someone in two groups whose nearer row is the lower, say). Nothing
    /// (only admins) when there is no chain.
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
        var rows = (await db.PagePermissions.AsNoTracking().Where(r => ids.Contains(r.PageId)).ToListAsync()).ToLookup(r => r.PageId, Row);

        // A member with no row of their own or of their groups: the first workspace row, else what the chain ends in.
        var workspace = cut[^1].Restricted ? Levels.None : Levels.Edit;
        foreach (var link in cut)
            if (rows[link.Id].FirstOrDefault(r => r.PrincipalType == Principals.Workspace) is { } row)
            {
                workspace = row.Level;
                break;
            }
        var result = new List<AccessRow>();
        if (workspace != Levels.None) result.Add(new AccessRow(Principals.Workspace, workspaceId, workspace));

        // Each group's nearest row, unless the workspace's row or a restriction decides for all its
        // people first (no one is decided by a group's row above them).
        var groupIds = rows.SelectMany(g => g).Where(r => r.PrincipalType == Principals.Group).Select(r => r.PrincipalId).Distinct().Order().ToList();
        foreach (var group in groupIds)
            foreach (var link in cut)
            {
                if (rows[link.Id].FirstOrDefault(r => r.PrincipalType == Principals.Group && r.PrincipalId == group) is { } row)
                {
                    result.Add(row);
                    break;
                }
                if (link.Restricted || rows[link.Id].Any(r => r.PrincipalType == Principals.Workspace)) break;
            }
        var shared = result.ToList();

        // Everyone the chain's rows may decide for: people with a row of their own, and the people of
        // those groups.
        var groupsOf = new Dictionary<Guid, HashSet<Guid>>();
        foreach (var chunk in Chunked.Of(groupIds))
            foreach (var m in await db.WorkspaceGroupMembers.AsNoTracking().Where(g => chunk.Contains(g.GroupId)).Select(g => new { g.UserId, g.GroupId }).ToListAsync())
            {
                if (!groupsOf.TryGetValue(m.UserId, out var set)) groupsOf[m.UserId] = set = [];
                set.Add(m.GroupId);
            }
        var people = rows.SelectMany(g => g).Where(r => r.PrincipalType == Principals.User).Select(r => r.PrincipalId)
            .Concat(groupsOf.Keys).Distinct().Order().ToList();
        var roles = new Dictionary<Guid, string>();
        foreach (var chunk in Chunked.Of(people))
            foreach (var m in await db.WorkspaceMembers.AsNoTracking().Where(m => chunk.Contains(m.UserId)).Select(m => new { m.UserId, m.Role }).ToListAsync())
                roles[m.UserId] = m.Role;
        foreach (var person in people)
        {
            // Someone no longer in the workspace has nothing to keep.
            if (!roles.TryGetValue(person, out var role)) continue;
            var member = new Member(workspaceId, person, role);
            IReadOnlySet<Guid> groups = member.IsGuest ? NoGroups : groupsOf.GetValueOrDefault(person) ?? NoGroups;
            string? level = null;
            var own = false;
            foreach (var link in cut)
            {
                if (rows[link.Id].FirstOrDefault(r => r.PrincipalType == Principals.User && r.PrincipalId == person) is { } mine)
                {
                    level = mine.Level;
                    own = true;
                    break;
                }
                if ((level = Decide(member, groups, link.Restricted, rows[link.Id])) is not null) break;
            }
            level ??= Default(member);
            if (own) result.Add(new AccessRow(Principals.User, person, level));
            // Decided by their groups' rows or the workspace's: kept by the copies above, unless
            // those give them something else here.
            else if (!member.IsAdmin && LevelUnder(member, groups, shared) != level) result.Add(new AccessRow(Principals.User, person, level));
        }
        return result;
    }

    /// <summary>What a restricted page holding <paramref name="rows"/> gives someone in these groups.</summary>
    public static string LevelUnder(Member member, IReadOnlySet<Guid> groups, IEnumerable<AccessRow> rows) =>
        member.IsAdmin ? Levels.Full : Speaks(member, groups, rows) ?? Levels.None;
}

/// <summary>A row of a page's access list: who, and at which level.</summary>
public sealed record AccessRow(string PrincipalType, Guid PrincipalId, string Level);
