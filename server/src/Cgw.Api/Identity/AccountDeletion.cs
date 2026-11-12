using System.Data;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;
using OpenIddict.Abstractions;

namespace Cgw.Api.Identity;

/// <summary>
/// Deleting an account (M2.8; DATA_MODEL.md, Data export and deletion). Refused while the caller
/// is the only owner of a workspace that has other members (they hand it over first). Otherwise:
/// workspaces nobody else is in are deleted (purged after 30 days); the caller leaves the rest,
/// and their private sections there go with them; their personal data is scrubbed, while their
/// edits in shared pages stay, shown as "Deleted user"; every device and token is revoked. The
/// owner check and the leaving happen in one transaction under every one of those workspaces'
/// locks, as role changes take them.
/// </summary>
public sealed class AccountDeletion(
    CgwDb db,
    Devices devices,
    ChangeLog changes,
    Audit audit,
    IOpenIddictAuthorizationManager authorizations,
    IOpenIddictTokenManager tokens,
    TimeProvider clock)
{
    private sealed record Membership(Guid WorkspaceId, string Role, int Others, int OtherOwners);

    public async Task<Result<bool>> DeleteAsync(Guid userId, Actor actor, CancellationToken ct = default)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId && u.DeletedAt == null, ct);
        if (user is null) return Failure.NotFound("No such account");
        // A quick answer for the page; the answer that counts is the one under the locks below.
        if (SoleOwner(await MembershipsAsync(userId, ct)) is { } held) return held;

        var now = clock.GetUtcNow();
        List<Membership> memberships;
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            // Every workspace's lock, taken in one order and held to the end, then the check again:
            // a role change or another deletion in any of them waits for this one, or this for it,
            // so two owners leaving at once cannot both pass and leave a workspace with no owner.
            var locked = new HashSet<Guid>();
            while (true)
            {
                memberships = await MembershipsAsync(userId, ct);
                var unlocked = memberships.Select(m => m.WorkspaceId).Where(id => !locked.Contains(id)).Order().ToList();
                if (unlocked.Count == 0) break;
                foreach (var id in unlocked)
                {
                    await changes.LockAsync(id, ct);
                    locked.Add(id);
                }
            }
            if (SoleOwner(memberships) is { } raced)
            {
                await tx.RollbackAsync(ct);
                return raced;
            }
            foreach (var membership in memberships)
            {
                db.ChangeTracker.Clear();
                db.Scope.Switch(membership.WorkspaceId);
                // Held already: this points the change log at the workspace.
                await changes.LockAsync(membership.WorkspaceId, ct);
                if (membership.Others == 0) await DeleteWorkspaceAsync(membership.WorkspaceId, userId, actor, now, ct);
                else await LeaveAsync(membership.WorkspaceId, userId, actor, now, ct);
            }
            await tx.CommitAsync(ct);
        }
        db.ChangeTracker.Clear();
        db.Scope.Switch(null);

        // Invitations still waiting for the address are void.
        var email = user.NormalizedEmail;
        await db.WorkspaceInvites.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(i => i.Email.ToUpper() == email && i.AcceptedAt == null && i.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.RevokedAt, now).SetProperty(i => i.Email, ""), ct);

        // Every session ends: devices (and their desktop authorisations), then any token left.
        await devices.RevokeAllAsync(userId, actor);
        await foreach (var authorization in authorizations.FindBySubjectAsync(userId.ToString(), ct))
            await authorizations.TryRevokeAsync(authorization, ct);
        await foreach (var token in tokens.FindBySubjectAsync(userId.ToString(), ct))
            await tokens.TryRevokeAsync(token, ct);

        // Personal data goes; the row stays so edits and the audit log still name someone.
        db.ChangeTracker.Clear();
        user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        var placeholder = $"deleted-{userId:N}@deleted.invalid";
        user.Email = user.UserName = placeholder;
        user.NormalizedEmail = user.NormalizedUserName = placeholder.ToUpperInvariant();
        user.EmailConfirmed = false;
        user.DisplayName = "";
        user.Locale = "en";
        user.AvatarAssetId = null;
        user.PasswordHash = null;
        user.PhoneNumber = null;
        user.PhoneNumberConfirmed = false;
        user.TwoFactorEnabled = false;
        user.LockoutEnabled = true;
        user.LockoutEnd = DateTimeOffset.MaxValue;
        user.SecurityStamp = Guid.NewGuid().ToString("N");
        user.ConcurrencyStamp = Guid.NewGuid().ToString();
        user.DeletedAt = now;
        await db.UserClaims.Where(c => c.UserId == userId).ExecuteDeleteAsync(ct);
        await db.UserLogins.Where(l => l.UserId == userId).ExecuteDeleteAsync(ct);
        await db.UserTokens.Where(t => t.UserId == userId).ExecuteDeleteAsync(ct);
        await db.UserRoles.Where(r => r.UserId == userId).ExecuteDeleteAsync(ct);
        audit.Add(actor, "account.delete", targetType: "user", targetId: userId,
            detail: new { workspacesDeleted = memberships.Count(m => m.Others == 0), workspacesLeft = memberships.Count(m => m.Others > 0) });
        await db.SaveChangesAsync(ct);
        return true;
    }

    private async Task<List<Membership>> MembershipsAsync(Guid userId, CancellationToken ct)
    {
        var members = db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]);
        return await members.AsNoTracking()
            .Where(m => m.UserId == userId)
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), m => m.WorkspaceId, w => w.Id, (m, _) => m)
            .Select(m => new Membership(
                m.WorkspaceId,
                m.Role,
                members.Count(o => o.WorkspaceId == m.WorkspaceId && o.UserId != userId),
                members.Count(o => o.WorkspaceId == m.WorkspaceId && o.UserId != userId && o.Role == Roles.Owner)))
            .ToListAsync(ct);
    }

    /// <summary>A workspace the caller is the only owner of while others are in it: they hand it over first.</summary>
    private static Failure? SoleOwner(List<Membership> memberships) =>
        memberships.FirstOrDefault(m => m.Role == Roles.Owner && m.Others > 0 && m.OtherOwners == 0) is { } held
            ? Failure.Conflict(Codes.Conflict, $"You are the only owner of workspace {held.WorkspaceId}, which has other members: make someone else an owner first")
            : null;

    /// <summary>Inside the deletion's transaction, under the workspace's lock.</summary>
    private async Task DeleteWorkspaceAsync(Guid workspaceId, Guid userId, Actor actor, DateTimeOffset now, CancellationToken ct)
    {
        var workspace = await db.Workspaces.FirstAsync(w => w.Id == workspaceId, ct);
        workspace.DeletedAt = now;
        workspace.DeletedBy = userId;
        workspace.Version++;
        changes.Add("workspace", workspaceId, "delete", workspace.Version, userId);
        audit.Add(actor, "workspace.delete", workspaceId, "workspace", workspaceId, new { reason = "account.delete" });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
    }

    /// <summary>Inside the deletion's transaction, under the workspace's lock.</summary>
    private async Task LeaveAsync(Guid workspaceId, Guid userId, Actor actor, DateTimeOffset now, CancellationToken ct)
    {
        // Their private sections were theirs alone: the pages are deleted for good (the purge
        // job removes their documents), and the sections go.
        var sections = await db.Sections.Where(s => s.Visibility == "private" && s.OwnerUserId == userId).ToListAsync(ct);
        var sectionIds = sections.Select(s => s.Id).ToList();
        var pages = await db.Pages.Where(p => sectionIds.Contains(p.SectionId) && p.DeletedAt == null).ToListAsync(ct);
        foreach (var page in pages)
        {
            page.DeletedAt = now;
            page.Title = "";
            page.SearchTitle = "";
            page.Version++;
            changes.Add("page", page.Id, "delete", page.Version, userId);
        }
        var pageIds = pages.Select(p => p.Id).ToList();
        foreach (var chunk in pageIds.Chunk(1000).Select(c => c.ToList()))
        {
            await db.Favourites.Where(f => chunk.Contains(f.PageId)).ExecuteDeleteAsync(ct);
            await db.PageVisits.Where(v => chunk.Contains(v.PageId)).ExecuteDeleteAsync(ct);
            await db.PageAncestors.Where(a => chunk.Contains(a.PageId)).ExecuteDeleteAsync(ct);
        }
        foreach (var section in sections) changes.Add("section", section.Id, "delete", section.Version + 1, userId);
        db.Sections.RemoveRange(sections);
        await db.WorkspaceMembers.Where(m => m.UserId == userId).ExecuteDeleteAsync(ct);
        await db.YjsClients.Where(c => c.UserId == userId).ExecuteDeleteAsync(ct);
        await db.Favourites.Where(f => f.UserId == userId).ExecuteDeleteAsync(ct);
        await db.PageVisits.Where(v => v.UserId == userId).ExecuteDeleteAsync(ct);
        await db.PagePermissions.Where(r => r.PrincipalType == "user" && r.PrincipalId == userId).ExecuteDeleteAsync(ct);
        changes.Add("member", userId, "delete", 1, userId);
        changes.Add("access", workspaceId, "revoke", 1, userId, userId);
        audit.Add(actor, "member.remove", workspaceId, "user", userId, new { reason = "account.delete" });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
    }
}
