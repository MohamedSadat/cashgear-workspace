using Cgw.Core.Data;
using Cgw.Core.Sharing;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workbooks;

/// <summary>
/// A workbook's level for a caller, by the pages' rules (DECISIONS.md, 2026-11-14: Phase 5), on
/// the server for every request: the caller must be a member of the workbook's workspace; owners
/// and admins have <c>full</c>; otherwise the caller's own row, else the highest of the rows of
/// groups they are in (Phase 11), else the workspace's row (not for guests), else nothing when the
/// workbook is restricted, else the role's default (member: <c>edit</c>, guest: <c>none</c>). There
/// are no ancestors and no share links: a workbook is never reachable from outside its workspace.
/// </summary>
public sealed class WorkbookAccess(CgwDb db)
{
    /// <summary>
    /// The workbook rows that may speak for one person: their own, the workspace's and (not for a
    /// guest) those of the groups they are in, the groups read in the same query.
    /// </summary>
    private IQueryable<WorkbookPermission> RowsFor(Member member)
    {
        var user = member.UserId;
        var workspace = member.WorkspaceId;
        var grouped = !member.IsGuest;
        return db.WorkbookPermissions.AsNoTracking().Where(r =>
            (r.PrincipalType == Principals.User && r.PrincipalId == user)
            || r.PrincipalType == Principals.Workspace
            || (grouped && r.PrincipalType == Principals.Group
                && db.WorkspaceGroupMembers.Any(g => g.GroupId == r.PrincipalId && g.UserId == user && g.WorkspaceId == workspace)));
    }

    public async Task<string> LevelAsync(Member member, Workbook workbook, CancellationToken ct = default)
    {
        if (member.IsAdmin) return Levels.Full;
        var rows = await RowsFor(member).Where(r => r.WorkbookId == workbook.Id).ToListAsync(ct);
        return Decide(member, GroupsIn(rows), workbook.Restricted, rows);
    }

    /// <summary>The caller's level on each of these workbooks, in a query a thousand workbooks.</summary>
    public async Task<Dictionary<Guid, string>> LevelsAsync(Member member, IReadOnlyCollection<Workbook> workbooks, CancellationToken ct = default)
    {
        if (member.IsAdmin) return workbooks.ToDictionary(w => w.Id, _ => Levels.Full);
        var rows = new List<WorkbookPermission>();
        foreach (var chunk in workbooks.Select(w => w.Id).Chunk(1000).Select(c => c.ToList()))
            rows.AddRange(await RowsFor(member).Where(r => chunk.Contains(r.WorkbookId)).ToListAsync(ct));
        var groups = GroupsIn(rows);
        var byWorkbook = rows.ToLookup(r => r.WorkbookId);
        return workbooks.ToDictionary(w => w.Id, w => Decide(member, groups, w.Restricted, byWorkbook[w.Id]));
    }

    /// <summary>The groups of rows read by <see cref="RowsFor"/>: each is one the person is in.</summary>
    private static HashSet<Guid> GroupsIn(IEnumerable<WorkbookPermission> rows) =>
        rows.Where(r => r.PrincipalType == Principals.Group).Select(r => r.PrincipalId).ToHashSet();

    /// <summary>The rules on rows already read, for someone in these groups.</summary>
    public static string Decide(Member member, IReadOnlySet<Guid> groups, bool restricted, IEnumerable<WorkbookPermission> rows) =>
        Decide(member, groups, restricted, rows.Select(r => new AccessRow(r.PrincipalType, r.PrincipalId, r.Level)));

    public static string Decide(Member member, IReadOnlySet<Guid> groups, bool restricted, IEnumerable<AccessRow> rows)
    {
        if (member.IsAdmin) return Levels.Full;
        if (Access.Speaks(member, groups, rows) is { } level) return level;
        if (restricted || member.IsGuest) return Levels.None;
        return Levels.Edit;
    }

    /// <summary>What a session may do with a level: <c>full</c> and <c>edit</c> edit; <c>comment</c> and <c>view</c> view; <c>none</c> nothing.</summary>
    public static string? SessionAccess(string level) => level switch
    {
        Levels.Full or Levels.Edit => "edit",
        Levels.Comment or Levels.View => "view",
        _ => null,
    };
}
