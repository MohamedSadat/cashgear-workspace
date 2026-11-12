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
}

public sealed record PermissionEntryDto(string PrincipalType, Guid PrincipalId, string Level, string? DisplayName, string? Email);
public sealed record PermissionsDto(bool Restricted, string YourLevel, IReadOnlyList<PermissionEntryDto> Entries);
public sealed record PermissionEntryIn(string PrincipalType, Guid PrincipalId, string Level);
public sealed record PermissionsUpdate(bool Restricted, IReadOnlyList<PermissionEntryIn>? Entries);

public sealed record ShareLinkDto(Guid Id, string Level, DateTimeOffset? ExpiresAt, DateTimeOffset CreatedAt, Guid CreatedBy);
public sealed record NewShareLink(int? ExpiresInDays);
public sealed record CreatedShareLink(Guid Id, string Token, DateTimeOffset ExpiresAt);

/// <summary>
/// Page sharing (M2.6; DATA_MODEL.md, Permissions): a page's own access list (people and the
/// whole workspace, each with a level, and whether the page is restricted to its list), and share
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
    /// whether it is restricted and their own level, not who else is on it.
    /// </summary>
    public async Task<PermissionsDto> PermissionsAsync(Page page, string yourLevel, CancellationToken ct = default)
    {
        if (yourLevel != Levels.Full) return new PermissionsDto(page.Restricted, yourLevel, []);
        var rows = await db.PagePermissions.AsNoTracking().Where(r => r.PageId == page.Id).ToListAsync(ct);
        var userIds = rows.Where(r => r.PrincipalType == Principals.User).Select(r => r.PrincipalId).ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.Email, u.DeletedAt }).ToDictionaryAsync(u => u.Id, ct);
        var workspace = await db.Workspaces.AsNoTracking().Where(w => w.Id == page.WorkspaceId).Select(w => w.Name).FirstAsync(ct);
        var entries = rows
            .Select(r =>
            {
                if (r.PrincipalType == Principals.Workspace) return new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, workspace, null);
                var user = users.GetValueOrDefault(r.PrincipalId);
                return user is null || user.DeletedAt is not null
                    ? new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, "Deleted user", null)
                    : new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, user.DisplayName, user.Email);
            })
            // The workspace first, then people by name.
            .OrderBy(e => e.PrincipalType == Principals.Workspace ? 0 : 1)
            .ThenBy(e => e.DisplayName, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(e => e.PrincipalId)
            .ToList();
        return new PermissionsDto(page.Restricted, yourLevel, entries);
    }

    /// <summary>
    /// Replaces the page's explicit rows (the caller has full access). The page's version rises,
    /// the feed gets the page and one <c>access</c> change naming it as the root, for everyone,
    /// and the change is audited. <paramref name="ifVersion"/> is an optional If-Match.
    /// </summary>
    public async Task<Result<PermissionsDto>> SetAsync(Member member, Actor actor, Page page, PermissionsUpdate request, long? ifVersion, CancellationToken ct = default)
    {
        var entries = request.Entries ?? [];
        if (entries.Count > MaxEntries) return Failure.Invalid($"A page has at most {MaxEntries} entries");
        foreach (var entry in entries)
        {
            if (entry is null) return Failure.Invalid("An entry is empty");
            if (entry.PrincipalType is not (Principals.User or Principals.Workspace)) return Failure.Invalid("principalType is user or workspace");
            if (!Levels.All.Contains(entry.Level)) return Failure.Invalid("level is full, edit, comment, view or none");
            if (entry.PrincipalType == Principals.Workspace && entry.PrincipalId != member.WorkspaceId)
                return Failure.Invalid("A workspace entry names this workspace");
        }
        if (entries.GroupBy(e => (e.PrincipalType, e.PrincipalId)).Any(g => g.Count() > 1)) return Failure.Invalid("Each principal appears once");
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
        var before = await db.PagePermissions.AsNoTracking().Where(r => r.PageId == page.Id).ToListAsync(ct);
        var same = current.Restricted == request.Restricted
            && before.Count == entries.Count
            && entries.All(e => before.Any(b => b.PrincipalType == e.PrincipalType && b.PrincipalId == e.PrincipalId && b.Level == e.Level));
        if (same)
        {
            await tx.RollbackAsync(ct);
            return await PermissionsAsync(current, await access.PageLevelAsync(member, page.Id), ct);
        }
        var wasRestricted = current.Restricted;
        // Whether anyone could lose access: the client resyncs the subtree either way.
        var narrows = (request.Restricted && !current.Restricted)
            || before.Any(b => entries.FirstOrDefault(e => e.PrincipalType == b.PrincipalType && e.PrincipalId == b.PrincipalId) is not { } now
                || Levels.Rank(now.Level) < Levels.Rank(b.Level));
        // Deleted in the database, not tracked: a row can come back with the same key and a new level.
        await db.PagePermissions.Where(r => r.PageId == page.Id).ExecuteDeleteAsync(ct);
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
            entries = entries.Select(e => new { e.PrincipalType, e.PrincipalId, e.Level }),
            before = new { restricted = wasRestricted, entries = before.Select(b => new { b.PrincipalType, b.PrincipalId, b.Level }) },
        });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return await PermissionsAsync(current, await access.PageLevelAsync(member, page.Id), ct);
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
