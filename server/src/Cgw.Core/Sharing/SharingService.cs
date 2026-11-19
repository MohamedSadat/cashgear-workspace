using System.Data;
using System.Security.Cryptography;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Cgw.Core.Workspaces;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sharing;

public static class Principals
{
    public const string User = "user";
    public const string Workspace = "workspace";
    /// <summary>Phase 11: a group of the workspace's people (<see cref="WorkspaceGroup"/>).</summary>
    public const string Group = "group";
}

public sealed record PermissionEntryDto(string PrincipalType, Guid PrincipalId, string Level, string? DisplayName, string? Email)
{
    /// <summary>Phase 11: a group's number of people; null for a person or the workspace.</summary>
    public int? PeopleCount { get; init; }
}

public sealed record PermissionsDto(bool Restricted, string YourLevel, IReadOnlyList<PermissionEntryDto> Entries);
public sealed record PermissionEntryIn(string PrincipalType, Guid PrincipalId, string Level);

public sealed record PermissionsUpdate(bool Restricted, IReadOnlyList<PermissionEntryIn>? Entries)
{
    /// <summary>
    /// Phase 11: the kinds of principal the client knows besides people and the workspace. With
    /// <c>group</c> in it, the request's group entries replace the stored group rows; without it the
    /// request holds no group entry and every stored group row is kept as it was (0.10.0's clients
    /// know only people and the workspace, and must not delete what they were never shown).
    /// </summary>
    public IReadOnlyList<string>? Principals { get; init; }
}

public sealed record ShareLinkDto(Guid Id, string Level, DateTimeOffset? ExpiresAt, DateTimeOffset CreatedAt, Guid CreatedBy);
public sealed record NewShareLink(int? ExpiresInDays);
public sealed record CreatedShareLink(Guid Id, string Token, DateTimeOffset ExpiresAt);

/// <summary>
/// Page sharing (M2.6; DATA_MODEL.md, Permissions): a page's own access list (people, groups from
/// Phase 11 and the whole workspace, each with a level, and whether the page is restricted to its list), and share
/// links (view only, off unless a person makes one, hashed, expiring, revocable). Access itself is
/// decided by <see cref="Access"/>; this only changes what it reads, under the workspace's lock,
/// with a change in the feed so every member's client fetches the subtree again.
/// </summary>
public sealed class SharingService(CgwDb db, Access access, ChangeLog changes, Audit audit, TimeProvider clock)
{
    public const int MaxEntries = 500;
    public const int DefaultLinkDays = 30;
    public const int MaxLinkDays = 365;

    /// <summary>
    /// The page's list, to those who may change it (full access); everyone else learns only
    /// whether it is restricted and their own level, not who else is on it. Group rows only when
    /// <paramref name="groups"/> (the client asked, and is not a guest: <see cref="KnowsGroups"/>).
    /// </summary>
    public async Task<PermissionsDto> PermissionsAsync(Page page, string yourLevel, bool groups, CancellationToken ct = default)
    {
        if (yourLevel != Levels.Full) return new PermissionsDto(page.Restricted, yourLevel, []);
        var rows = (await db.PagePermissions.AsNoTracking().Where(r => r.PageId == page.Id).ToListAsync(ct))
            .Select(r => new AccessRow(r.PrincipalType, r.PrincipalId, r.Level)).ToList();
        var workspace = await db.Workspaces.AsNoTracking().Where(w => w.Id == page.WorkspaceId).Select(w => w.Name).FirstAsync(ct);
        return new PermissionsDto(page.Restricted, yourLevel, await EntriesAsync(db, rows, workspace, groups, ct));
    }

    /// <summary>
    /// A page's or a workbook's rows as their list shows them: the workspace first, then groups
    /// (with their number of people; only when <paramref name="groups"/>), then people, each by name.
    /// </summary>
    public static async Task<List<PermissionEntryDto>> EntriesAsync(CgwDb db, IReadOnlyList<AccessRow> rows, string workspace, bool groups, CancellationToken ct)
    {
        if (!groups) rows = rows.Where(r => r.PrincipalType != Principals.Group).ToList();
        var userIds = rows.Where(r => r.PrincipalType == Principals.User).Select(r => r.PrincipalId).ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.Email, u.DeletedAt }).ToDictionaryAsync(u => u.Id, ct);
        var groupIds = rows.Where(r => r.PrincipalType == Principals.Group).Select(r => r.PrincipalId).ToList();
        var named = groupIds.Count == 0
            ? []
            : await db.WorkspaceGroups.AsNoTracking().Where(g => groupIds.Contains(g.Id))
                .Select(g => new GroupName(g.Id, g.Name, db.WorkspaceGroupMembers.Count(m => m.GroupId == g.Id))).ToDictionaryAsync(g => g.Id, ct);
        return rows
            .Select(r =>
            {
                if (r.PrincipalType == Principals.Workspace) return new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, workspace, null);
                if (r.PrincipalType == Principals.Group)
                    return named.GetValueOrDefault(r.PrincipalId) is { } group
                        ? new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, group.Name, null) { PeopleCount = group.People }
                        : new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, "Deleted group", null) { PeopleCount = 0 };
                var user = users.GetValueOrDefault(r.PrincipalId);
                return user is null || user.DeletedAt is not null
                    ? new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, "Deleted user", null)
                    : new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, user.DisplayName, user.Email);
            })
            // The workspace first, then groups, then people, by name.
            .OrderBy(e => e.PrincipalType switch { Principals.Workspace => 0, Principals.Group => 1, _ => 2 })
            .ThenBy(e => e.DisplayName, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(e => e.PrincipalId)
            .ToList();
    }

    private sealed record GroupName(Guid Id, string Name, int People);

    /// <summary>
    /// Whether a list's caller is shown, and may change, its group rows: they said they know groups
    /// (<c>principals</c> holding <c>group</c>, as a list or comma-separated), and are not a guest
    /// (a guest is never told a group's name).
    /// </summary>
    public static bool KnowsGroups(Member member, IEnumerable<string?>? principals) =>
        !member.IsGuest && principals is not null
        && principals.SelectMany(p => (p ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)).Contains(Principals.Group);

    /// <summary>A PUT's <c>principals</c>: absent, or kinds this server knows.</summary>
    public static Failure? CheckPrincipals(IReadOnlyList<string>? principals) =>
        principals is null || principals.All(p => p is Principals.User or Principals.Workspace or Principals.Group)
            ? null
            : Failure.Invalid("principals names user, workspace or group");

    /// <summary>The checks a list's entries pass before anything is read (a page's, a workbook's).</summary>
    public static Failure? CheckEntries(Member member, IReadOnlyList<PermissionEntryIn> entries, bool groups, int max, string what)
    {
        if (entries.Count > max) return Failure.Invalid($"A {what} has at most {max} entries");
        foreach (var entry in entries)
        {
            if (entry is null) return Failure.Invalid("An entry is empty");
            if (entry.PrincipalType is not (Principals.User or Principals.Workspace or Principals.Group)) return Failure.Invalid("principalType is user, group or workspace");
            if (entry.PrincipalType == Principals.Group && !groups)
                return Failure.Invalid(member.IsGuest ? "A guest does not name groups" : "A group entry needs principals to hold group");
            if (!Levels.All.Contains(entry.Level)) return Failure.Invalid("level is full, edit, comment, view or none");
            if (entry.PrincipalType == Principals.Workspace && entry.PrincipalId != member.WorkspaceId)
                return Failure.Invalid("A workspace entry names this workspace");
        }
        if (entries.GroupBy(e => (e.PrincipalType, e.PrincipalId)).Any(g => g.Count() > 1)) return Failure.Invalid("Each principal appears once");
        return null;
    }

    /// <summary>Under the workspace's lock: a group entry that names no group of this workspace (one deleted meanwhile, say).</summary>
    public static async Task<Failure?> CheckGroupsAsync(CgwDb db, IReadOnlyList<PermissionEntryIn> entries, CancellationToken ct)
    {
        var named = entries.Where(e => e.PrincipalType == Principals.Group).Select(e => e.PrincipalId).Distinct().ToList();
        if (named.Count == 0) return null;
        var live = await db.WorkspaceGroups.AsNoTracking().Where(g => named.Contains(g.Id)).Select(g => g.Id).ToListAsync(ct);
        var missing = named.Except(live).FirstOrDefault();
        return missing == Guid.Empty ? null : Failure.Invalid($"{missing} is not a group of the workspace");
    }

    /// <summary>
    /// What a list holds after a PUT: the request's entries, and the stored group rows when the
    /// request does not speak for groups (they are kept as they were).
    /// </summary>
    public static List<AccessRow> After(IReadOnlyList<PermissionEntryIn> entries, IEnumerable<AccessRow> before, bool groups) =>
    [
        .. entries.Select(e => new AccessRow(e.PrincipalType, e.PrincipalId, e.Level)),
        .. groups ? [] : before.Where(b => b.PrincipalType == Principals.Group),
    ];

    /// <summary>
    /// Replaces the page's explicit rows (the caller has full access). The page's version rises,
    /// the feed gets the page and one <c>access</c> change naming it as the root, for everyone,
    /// and the change is audited. <paramref name="ifVersion"/> is an optional If-Match.
    /// </summary>
    public async Task<Result<PermissionsDto>> SetAsync(Member member, Actor actor, Page page, PermissionsUpdate request, long? ifVersion, CancellationToken ct = default)
    {
        // A row's access is its database's: it is never restricted nor given a list of its own.
        if (page.Kind == PageKinds.Row) return Failure.Invalid("A row has its database's access; share the database");
        var entries = request.Entries ?? [];
        if (CheckPrincipals(request.Principals) is { } principals) return principals;
        var groups = KnowsGroups(member, request.Principals);
        if (CheckEntries(member, entries, groups, MaxEntries, "page") is { } invalid) return invalid;
        var named = entries.Where(e => e.PrincipalType == Principals.User).Select(e => e.PrincipalId).Distinct().ToList();
        var members = await db.WorkspaceMembers.AsNoTracking().Where(m => named.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        var stranger = named.Except(members).FirstOrDefault();
        if (stranger != Guid.Empty) return Failure.Invalid($"{stranger} is not a member of the workspace");
        var section = await db.Sections.AsNoTracking().FirstAsync(s => s.Id == page.SectionId, ct);
        // A private section is its owner's only (DATA_MODEL.md, rule 3): a list there would do nothing.
        if (section.Visibility == "private" && entries.Count > 0) return Failure.Invalid("Pages in a private section are not shared; move the page to a shared section first");

        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var current = await db.Pages.FirstOrDefaultAsync(p => p.Id == page.Id && p.DeletedAt == null, ct);
        if (current is null) return Failure.NotFound("No such page");
        if (ifVersion is { } expected && expected != current.Version)
            return Failure.Conflict(Codes.VersionConflict, $"The page is at version {current.Version}");
        // Under the lock: a group deleted meanwhile is not named.
        if (await CheckGroupsAsync(db, entries, ct) is { } unknown) return unknown;
        var before = (await db.PagePermissions.AsNoTracking().Where(r => r.PageId == page.Id).ToListAsync(ct))
            .Select(r => new AccessRow(r.PrincipalType, r.PrincipalId, r.Level)).ToList();
        var after = After(entries, before, groups);
        if (after.Count > MaxEntries) return Failure.Invalid($"A page has at most {MaxEntries} entries");
        var same = current.Restricted == request.Restricted
            && before.Count == after.Count
            && after.All(e => before.Any(b => b.PrincipalType == e.PrincipalType && b.PrincipalId == e.PrincipalId && b.Level == e.Level));
        if (same)
        {
            await tx.RollbackAsync(ct);
            return await PermissionsAsync(current, await access.PageLevelAsync(member, page.Id), groups, ct);
        }
        var wasRestricted = current.Restricted;
        // Whether anyone could lose access (a group's row counts as a person's): the client resyncs
        // the subtree either way.
        var narrows = (request.Restricted && !current.Restricted)
            || before.Any(b => after.FirstOrDefault(e => e.PrincipalType == b.PrincipalType && e.PrincipalId == b.PrincipalId) is not { } now
                || Levels.Rank(now.Level) < Levels.Rank(b.Level));
        // Deleted in the database, not tracked: a row can come back with the same key and a new level.
        // Group rows the request does not speak for stay as they were.
        if (groups) await db.PagePermissions.Where(r => r.PageId == page.Id).ExecuteDeleteAsync(ct);
        else await db.PagePermissions.Where(r => r.PageId == page.Id && r.PrincipalType != Principals.Group).ExecuteDeleteAsync(ct);
        var at = clock.GetUtcNow();
        foreach (var entry in entries)
            db.PagePermissions.Add(new PagePermission
            {
                PageId = page.Id,
                PrincipalType = entry.PrincipalType,
                PrincipalId = entry.PrincipalId,
                Level = entry.Level,
                WorkspaceId = member.WorkspaceId,
                CreatedBy = member.UserId,
                CreatedAt = at,
            });
        current.Restricted = request.Restricted;
        current.Version++;
        current.UpdatedAt = at;
        current.UpdatedBy = member.UserId;
        changes.Add("page", page.Id, "upsert", current.Version, member.UserId);
        changes.Add("access", page.Id, narrows ? "revoke" : "grant", current.Version, member.UserId);
        audit.Add(actor, "sharing.change", member.WorkspaceId, "page", page.Id, new
        {
            restricted = request.Restricted,
            entries = after.Select(e => new { e.PrincipalType, e.PrincipalId, e.Level }),
            before = new { restricted = wasRestricted, entries = before.Select(b => new { b.PrincipalType, b.PrincipalId, b.Level }) },
        });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return await PermissionsAsync(current, await access.PageLevelAsync(member, page.Id), groups, ct);
    }

    // Share links ---------------------------------------------------------------------------------

    public async Task<List<ShareLinkDto>> LinksAsync(Page page, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        return await db.ShareLinks.AsNoTracking()
            .Where(l => l.PageId == page.Id && l.RevokedAt == null && (l.ExpiresAt == null || l.ExpiresAt > now))
            .OrderByDescending(l => l.CreatedAt)
            .Select(l => new ShareLinkDto(l.Id, l.Level, l.ExpiresAt, l.CreatedAt, l.CreatedBy))
            .ToListAsync(ct);
    }

    /// <summary>A view-only link to the page and its subtree; the token is shown once and kept only as its SHA-256.</summary>
    public async Task<Result<CreatedShareLink>> CreateLinkAsync(Member member, Actor actor, Page page, NewShareLink request, CancellationToken ct = default)
    {
        var days = request.ExpiresInDays ?? DefaultLinkDays;
        if (days is < 1 or > MaxLinkDays) return Failure.Invalid($"expiresInDays is 1 to {MaxLinkDays}");
        if (page.Kind == PageKinds.Row) return Failure.Invalid("A row has its database's access; share the database");
        if (page.TrashedAt is not null) return Failure.Conflict(Codes.Conflict, "The page is in the trash");
        var section = await db.Sections.AsNoTracking().FirstAsync(s => s.Id == page.SectionId, ct);
        if (section.Visibility == "private") return Failure.Invalid("Pages in a private section are not shared; move the page to a shared section first");
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var now = clock.GetUtcNow();
        var link = new ShareLink
        {
            Id = Guid.CreateVersion7(),
            PageId = page.Id,
            WorkspaceId = member.WorkspaceId,
            TokenHash = WorkspaceService.Hash(token),
            Level = Levels.View,
            ExpiresAt = now.AddDays(days),
            CreatedBy = member.UserId,
            CreatedAt = now,
        };
        db.ShareLinks.Add(link);
        audit.Add(actor, "share.create", member.WorkspaceId, "page", page.Id, new { linkId = link.Id, link.ExpiresAt, link.Level });
        await db.SaveChangesAsync(ct);
        return new CreatedShareLink(link.Id, token, link.ExpiresAt.Value);
    }

    public async Task<Result<bool>> RevokeLinkAsync(Member member, Actor actor, Page page, Guid linkId, CancellationToken ct = default)
    {
        var link = await db.ShareLinks.FirstOrDefaultAsync(l => l.Id == linkId && l.PageId == page.Id, ct);
        if (link is null) return Failure.NotFound("No such link");
        if (link.RevokedAt is not null) return true;
        link.RevokedAt = clock.GetUtcNow();
        audit.Add(actor, "share.revoke", member.WorkspaceId, "page", page.Id, new { linkId });
        await db.SaveChangesAsync(ct);
        return true;
    }
}
