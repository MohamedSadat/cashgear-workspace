using Cgw.Core.Data;
using Cgw.Core.Sharing;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workbooks;

/// <summary>
/// A workbook's level for a caller, by the pages' rules (DECISIONS.md, 2026-11-14: Phase 5), on
/// the server for every request: the caller must be a member of the workbook's workspace; owners
/// and admins have <c>full</c>; otherwise the caller's own row, else the workspace's row (not for
/// guests), else nothing when the workbook is restricted, else the role's default (member:
/// <c>edit</c>, guest: <c>none</c>). There are no ancestors and no share links: a workbook is never
/// reachable from outside its workspace.
/// </summary>
public sealed class WorkbookAccess(CgwDb db)
{
    public async Task<string> LevelAsync(Member member, Workbook workbook, CancellationToken ct = default)
    {
        if (member.IsAdmin) return Levels.Full;
        var rows = await db.WorkbookPermissions.AsNoTracking()
            .Where(r => r.WorkbookId == workbook.Id && ((r.PrincipalType == Principals.User && r.PrincipalId == member.UserId) || r.PrincipalType == Principals.Workspace))
            .ToListAsync(ct);
        return Decide(member, workbook.Restricted, rows);
    }

    /// <summary>The caller's level on each of these workbooks, in one query.</summary>
    public async Task<Dictionary<Guid, string>> LevelsAsync(Member member, IReadOnlyCollection<Workbook> workbooks, CancellationToken ct = default)
    {
        if (member.IsAdmin) return workbooks.ToDictionary(w => w.Id, _ => Levels.Full);
        var rows = new List<WorkbookPermission>();
        foreach (var chunk in workbooks.Select(w => w.Id).Chunk(1000).Select(c => c.ToList()))
            rows.AddRange(await db.WorkbookPermissions.AsNoTracking()
                .Where(r => chunk.Contains(r.WorkbookId) && ((r.PrincipalType == Principals.User && r.PrincipalId == member.UserId) || r.PrincipalType == Principals.Workspace))
                .ToListAsync(ct));
        var byWorkbook = rows.ToLookup(r => r.WorkbookId);
        return workbooks.ToDictionary(w => w.Id, w => Decide(member, w.Restricted, byWorkbook[w.Id]));
    }

    /// <summary>The rules on rows already read (the caller's own and the workspace's, or more).</summary>
    public static string Decide(Member member, bool restricted, IEnumerable<WorkbookPermission> rows) =>
        Decide(member, restricted, rows.Select(r => new AccessRow(r.PrincipalType, r.PrincipalId, r.Level)));

    public static string Decide(Member member, bool restricted, IEnumerable<AccessRow> rows)
    {
        if (member.IsAdmin) return Levels.Full;
        string? user = null, workspace = null;
        foreach (var row in rows)
        {
            if (row.PrincipalType == Principals.User && row.PrincipalId == member.UserId) user = row.Level;
            else if (row.PrincipalType == Principals.Workspace && !member.IsGuest) workspace = row.Level;
        }
        if (user is not null) return user;
        if (workspace is not null) return workspace;
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
