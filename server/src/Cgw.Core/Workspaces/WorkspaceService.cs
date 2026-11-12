using System.Data;
using System.Security.Cryptography;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workspaces;

public sealed record NewWorkspace(Guid Id, string Name, string? Icon);
public sealed record InviteDto(Guid Id, string Email, string Role, DateTimeOffset ExpiresAt, DateTimeOffset CreatedAt);
public sealed record CreatedInvite(InviteDto Invite, string Token);

/// <summary>Workspaces, members, roles and invites (M2.3).</summary>
public sealed class WorkspaceService(CgwDb db, ChangeLog changes, Audit audit, TimeProvider clock)
{
    public static readonly TimeSpan InviteLifetime = TimeSpan.FromDays(7);

    /// <summary>The caller's workspaces, with their role in each.</summary>
    public async Task<List<WorkspaceDto>> ListAsync(Guid userId, CancellationToken ct = default) =>
        (await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(m => m.UserId == userId)
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), m => m.WorkspaceId, w => w.Id, (m, w) => new { w, m.Role })
            .ToListAsync(ct))
        .OrderBy(x => x.w.Name, StringComparer.CurrentCulture)
        .Select(x => WorkspaceDto.From(x.w, x.Role))
        .ToList();

    /// <summary>
    /// Makes a workspace with the client's id (a local workspace keeps its id when it uploads).
    /// Repeating the same request is answered with the workspace; someone else's id is a conflict.
    /// </summary>
    public async Task<Result<WorkspaceDto>> CreateAsync(Guid userId, Actor actor, NewWorkspace request, CancellationToken ct = default)
    {
        var name = request.Name?.Trim() ?? "";
        if (request.Id == Guid.Empty || name.Length is 0 or > 200) return Failure.Invalid("An id and a name of 1 to 200 characters are needed");
        if (request.Icon is { Length: > 64 }) return Failure.Invalid("The icon is too long");
        var existing = await db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Id == request.Id, ct);
        if (existing is not null)
        {
            if (existing.OwnerUserId == userId && existing.DeletedAt is null) return WorkspaceDto.From(existing, Roles.Owner);
            return Failure.Conflict(Codes.Conflict, "That id is taken");
        }
        var now = clock.GetUtcNow();
        db.Workspaces.Add(new Workspace { Id = request.Id, Name = name, Icon = request.Icon, OwnerUserId = userId, CreatedAt = now, Version = 1 });
        db.Scope.Switch(request.Id);
        db.WorkspaceMembers.Add(new WorkspaceMember { WorkspaceId = request.Id, UserId = userId, Role = Roles.Owner, CreatedAt = now });
        audit.Add(actor, "workspace.create", request.Id, "workspace", request.Id);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // A concurrent create of the same id: answer as above.
            db.ChangeTracker.Clear();
            var raced = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == request.Id, ct);
            return raced.OwnerUserId == userId ? WorkspaceDto.From(raced, Roles.Owner) : Failure.Conflict(Codes.Conflict, "That id is taken");
        }
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            await changes.LockAsync(request.Id, ct);
            changes.Add("workspace", request.Id, "upsert", 1, userId);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        }
        var created = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == request.Id, ct);
        return WorkspaceDto.From(created, Roles.Owner);
    }

    public async Task<Result<bool>> DeleteAsync(Member member, Actor actor, CancellationToken ct = default)
    {
        if (member.Role != Roles.Owner) return Failure.Denied("Only an owner deletes the workspace");
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var workspace = await db.Workspaces.FirstAsync(w => w.Id == member.WorkspaceId, ct);
        workspace.DeletedAt = clock.GetUtcNow();
        workspace.DeletedBy = member.UserId;
        workspace.Version++;
        changes.Add("workspace", workspace.Id, "delete", workspace.Version, member.UserId);
        audit.Add(actor, "workspace.delete", workspace.Id, "workspace", workspace.Id);
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }

    public async Task<List<MemberDto>> MembersAsync(CancellationToken ct = default) =>
        // Ordered after reading: EF cannot order by a member of a projected record.
        (await db.WorkspaceMembers.AsNoTracking()
            .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { m.UserId, m.Role, u.DisplayName, u.Email, u.DeletedAt })
            .ToListAsync(ct))
        .Select(x => new MemberDto(x.UserId, x.DeletedAt == null ? x.DisplayName : "Deleted user", x.DeletedAt == null ? x.Email ?? "" : "", x.Role))
        .OrderBy(m => m.DisplayName, StringComparer.CurrentCultureIgnoreCase)
        .ThenBy(m => m.UserId)
        .ToList();

    // There is no direct add: someone joins by accepting an invitation sent to their address, so
    // nothing an admin does tells them whether an address has an account.

    private async Task JoinAsync(Guid workspaceId, Guid userId, string role, Actor actor, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(workspaceId, ct);
        db.WorkspaceMembers.Add(new WorkspaceMember { WorkspaceId = workspaceId, UserId = userId, Role = role, CreatedAt = clock.GetUtcNow() });
        changes.Add("member", userId, "upsert", 1, actor.UserId);
        changes.Add("access", workspaceId, "grant", 1, actor.UserId, userId);
        audit.Add(actor, "member.add", workspaceId, "user", userId, new { role });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
    }

    public async Task<Result<MemberDto>> SetRoleAsync(Member admin, Actor actor, Guid userId, string role, CancellationToken ct = default)
    {
        if (!admin.IsAdmin) return Failure.Denied("Only an owner or admin changes roles");
        if (!Roles.All.Contains(role)) return Failure.Invalid("Not a role");
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(admin.WorkspaceId, ct);
        var row = await db.WorkspaceMembers.FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (row is null) return Failure.NotFound("Not a member");
        if ((row.Role == Roles.Owner || role == Roles.Owner) && admin.Role != Roles.Owner) return Failure.Denied("Only an owner changes who is an owner");
        if (row.Role == Roles.Owner && role != Roles.Owner && await db.WorkspaceMembers.CountAsync(m => m.Role == Roles.Owner, ct) == 1)
            return Failure.Conflict(Codes.Conflict, "A workspace keeps at least one owner");
        var before = row.Role;
        row.Role = role;
        changes.Add("member", userId, "upsert", 1, admin.UserId);
        // A role change can widen or narrow what the member sees: their client refetches the tree.
        changes.Add("access", admin.WorkspaceId, Roles.IsAdmin(role) || before == Roles.Guest ? "grant" : "revoke", 1, admin.UserId, userId);
        audit.Add(actor, "member.role", admin.WorkspaceId, "user", userId, new { from = before, to = role });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == userId, ct);
        return new MemberDto(userId, user.DisplayName, user.Email!, role);
    }

    /// <summary>An admin removes someone, or a member leaves.</summary>
    public async Task<Result<bool>> RemoveMemberAsync(Member caller, Actor actor, Guid userId, CancellationToken ct = default)
    {
        if (!caller.IsAdmin && caller.UserId != userId) return Failure.Denied("Only an owner or admin removes members");
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(caller.WorkspaceId, ct);
        var row = await db.WorkspaceMembers.FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (row is null) return Failure.NotFound("Not a member");
        if (row.Role == Roles.Owner && caller.Role != Roles.Owner) return Failure.Denied("Only an owner removes an owner");
        if (row.Role == Roles.Owner && await db.WorkspaceMembers.CountAsync(m => m.Role == Roles.Owner, ct) == 1)
            return Failure.Conflict(Codes.Conflict, "A workspace keeps at least one owner");
        db.WorkspaceMembers.Remove(row);
        await db.YjsClients.Where(c => c.UserId == userId).ExecuteDeleteAsync(ct);
        changes.Add("member", userId, "delete", 1, caller.UserId);
        changes.Add("access", caller.WorkspaceId, "revoke", 1, caller.UserId, userId);
        audit.Add(actor, "member.remove", caller.WorkspaceId, "user", userId);
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }

    public async Task<Result<CreatedInvite>> InviteAsync(Member admin, Actor actor, string email, string role, CancellationToken ct = default)
    {
        if (!admin.IsAdmin) return Failure.Denied("Only an owner or admin invites");
        email = email.Trim();
        if (!email.Contains('@') || email.Length > 256) return Failure.Invalid("The email address is not valid");
        if (role is not (Roles.Admin or Roles.Member or Roles.Guest)) return Failure.Invalid("The role is admin, member or guest");
        // 256 random bits; only its hash is kept (DATA_MODEL.md, WorkspaceInvites).
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var now = clock.GetUtcNow();
        var invite = new WorkspaceInvite
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = admin.WorkspaceId,
            Email = email,
            Role = role,
            TokenHash = Hash(token),
            ExpiresAt = now + InviteLifetime,
            CreatedBy = admin.UserId,
            CreatedAt = now,
        };
        db.WorkspaceInvites.Add(invite);
        audit.Add(actor, "invite.create", admin.WorkspaceId, "invite", invite.Id, new { role });
        await db.SaveChangesAsync(ct);
        return new CreatedInvite(new InviteDto(invite.Id, invite.Email, invite.Role, invite.ExpiresAt, invite.CreatedAt), token);
    }

    public async Task<List<InviteDto>> InvitesAsync(CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        return await db.WorkspaceInvites.AsNoTracking()
            .Where(i => i.AcceptedAt == null && i.RevokedAt == null && i.ExpiresAt > now)
            .OrderByDescending(i => i.CreatedAt)
            .Select(i => new InviteDto(i.Id, i.Email, i.Role, i.ExpiresAt, i.CreatedAt))
            .ToListAsync(ct);
    }

    public async Task<Result<bool>> RevokeInviteAsync(Member admin, Actor actor, Guid inviteId, CancellationToken ct = default)
    {
        if (!admin.IsAdmin) return Failure.Denied("Only an owner or admin revokes invites");
        var invite = await db.WorkspaceInvites.FirstOrDefaultAsync(i => i.Id == inviteId, ct);
        if (invite is null) return Failure.NotFound("No such invite");
        invite.RevokedAt = clock.GetUtcNow();
        audit.Add(actor, "invite.revoke", admin.WorkspaceId, "invite", inviteId);
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>The invited person accepts, signed in with the address the invite was sent to.</summary>
    public async Task<Result<WorkspaceDto>> AcceptAsync(Guid userId, Actor actor, string token, CancellationToken ct = default)
    {
        var hash = Hash(token);
        var invite = await db.WorkspaceInvites.IgnoreQueryFilters([CgwDb.Tenant]).FirstOrDefaultAsync(i => i.TokenHash == hash, ct);
        var now = clock.GetUtcNow();
        if (invite is null || invite.RevokedAt is not null || invite.ExpiresAt <= now) return Failure.NotFound("The invitation is not valid or has expired");
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == userId, ct);
        if (!string.Equals(user.Email, invite.Email, StringComparison.OrdinalIgnoreCase))
            return Failure.Denied("The invitation was sent to another address");
        var workspace = await db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Id == invite.WorkspaceId && w.DeletedAt == null, ct);
        if (workspace is null) return Failure.NotFound("The workspace is gone");
        db.Scope.Switch(invite.WorkspaceId);
        var already = await db.WorkspaceMembers.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (invite.AcceptedAt is not null && invite.AcceptedBy != userId) return Failure.NotFound("The invitation is not valid or has expired");
        if (already is null) await JoinAsync(invite.WorkspaceId, userId, invite.Role, actor, ct);
        db.ChangeTracker.Clear();
        await db.WorkspaceInvites.Where(i => i.Id == invite.Id).ExecuteUpdateAsync(s => s.SetProperty(i => i.AcceptedAt, now).SetProperty(i => i.AcceptedBy, userId), ct);
        return WorkspaceDto.From(workspace, already?.Role ?? invite.Role);
    }

    public static byte[] Hash(string token) => SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token));
}
