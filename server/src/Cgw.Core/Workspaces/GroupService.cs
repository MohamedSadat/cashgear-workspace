using System.Data;
using Cgw.Core.Data;
using Cgw.Core.Sharing;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workspaces;

public sealed record GroupPersonDto(Guid UserId, string DisplayName, string? Email);
public sealed record GroupDto(Guid Id, string Name, long Version, IReadOnlyList<GroupPersonDto> People, DateTimeOffset CreatedAt);
public sealed record GroupListDto(IReadOnlyList<GroupDto> Groups);

/// <summary>A new group: its name and, if any yet, its people.</summary>
public sealed record NewGroup
{
    public string? Name { get; init; }
    public IReadOnlyList<Guid>? People { get; init; }
}

public sealed record GroupRename(string? Name);

/// <summary>A group's people: the whole list.</summary>
public sealed record GroupPeople(IReadOnlyList<Guid>? People);

/// <summary>
/// A workspace's groups (Phase 11, M11.1; DATA_MODEL.md, Permissions). Owners and admins make,
/// rename and delete them and set their people; members, admins and owners read them and who is in
/// them; guests see none and are in none. A group is given access to pages and workbooks as a
/// person is (<see cref="Access"/>). Each change runs under the workspace's lock, as a role change
/// does: whoever gains or loses a membership (the group deleted too) gets an <c>access</c> change
/// targeted at them, so their tabs read their tree again and the hub and the worker check them
/// again; it is audited.
/// </summary>
public sealed class GroupService(CgwDb db, ChangeLog changes, Audit audit, TimeProvider clock)
{
    public const int MaxName = 100;
    public const int MaxGroups = 200;
    public const int MaxPeople = 5000;
    /// <summary>The normalised name's column (a name can grow when it is normalised).</summary>
    public const int MaxSearchName = 400;

    /// <summary>A name with no control characters, trimmed: 1 to 100 characters, else null.</summary>
    public static string? CleanName(string? name)
    {
        var clean = new string((name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        return clean.Length is 0 or > MaxName ? null : clean;
    }

    /// <summary>The name as search normalises it, what two groups may not share; a name of no letters or digits is itself, lower case.</summary>
    public static string SearchName(string name)
    {
        var normal = TextNormaliser.Normalise(name);
        if (normal.Length == 0) normal = name.ToLowerInvariant();
        return normal.Length > MaxSearchName ? normal[..MaxSearchName] : normal;
    }

    public async Task<Result<GroupListDto>> ListAsync(Member caller, CancellationToken ct = default)
    {
        if (caller.IsGuest) return Failure.Denied("Guests do not see the workspace's groups");
        var groups = await db.WorkspaceGroups.AsNoTracking().ToListAsync(ct);
        var dtos = await DtosAsync(groups, ct);
        return new GroupListDto(dtos.OrderBy(g => g.Name, StringComparer.CurrentCultureIgnoreCase).ThenBy(g => g.Id).ToList());
    }

    public async Task<Result<GroupDto>> CreateAsync(Member admin, Actor actor, NewGroup request, CancellationToken ct = default)
    {
        if (!admin.IsAdmin) return Failure.Denied("Only an owner or admin makes groups");
        if (CleanName(request.Name) is not { } name) return Failure.Invalid($"A group's name is 1 to {MaxName} characters");
        var people = request.People ?? [];
        if (people.Count > MaxPeople) return Failure.Invalid($"A group holds at most {MaxPeople} people");
        var wanted = people.Distinct().Order().ToList();

        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(admin.WorkspaceId, ct);
        if (await PeopleProblemAsync(wanted, ct) is { } problem) return problem;
        if (await db.WorkspaceGroups.CountAsync(ct) >= MaxGroups) return Failure.Invalid($"A workspace has at most {MaxGroups} groups");
        var search = SearchName(name);
        if (await db.WorkspaceGroups.AnyAsync(g => g.SearchName == search, ct)) return Failure.Conflict(Codes.Conflict, "Another group has that name");
        var now = clock.GetUtcNow();
        var group = new WorkspaceGroup
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = admin.WorkspaceId,
            Name = name,
            SearchName = search,
            Version = 1,
            CreatedBy = admin.UserId,
            CreatedAt = now,
            UpdatedBy = admin.UserId,
            UpdatedAt = now,
        };
        db.WorkspaceGroups.Add(group);
        foreach (var person in wanted) db.WorkspaceGroupMembers.Add(Membership(group, person, admin.UserId, now));
        // A new group holds no row yet: nothing changes for its people, but they are told as for any
        // change of their groups.
        foreach (var person in wanted) changes.Add("access", admin.WorkspaceId, "grant", 1, admin.UserId, person);
        audit.Add(actor, "group.create", admin.WorkspaceId, "group", group.Id, new { name, people = wanted });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return (await DtosAsync([group], ct))[0];
    }

    /// <summary>A new name; <paramref name="ifVersion"/> is an optional If-Match.</summary>
    public async Task<Result<GroupDto>> RenameAsync(Member admin, Actor actor, Guid groupId, GroupRename request, long? ifVersion, CancellationToken ct = default)
    {
        if (!admin.IsAdmin) return Failure.Denied("Only an owner or admin renames groups");
        if (CleanName(request.Name) is not { } name) return Failure.Invalid($"A group's name is 1 to {MaxName} characters");

        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(admin.WorkspaceId, ct);
        var group = await db.WorkspaceGroups.FirstOrDefaultAsync(g => g.Id == groupId, ct);
        if (group is null) return Failure.NotFound("No such group");
        if (ifVersion is { } expected && expected != group.Version) return Failure.Conflict(Codes.VersionConflict, $"The group is at version {group.Version}");
        if (group.Name == name)
        {
            await tx.RollbackAsync(ct);
            return (await DtosAsync([group], ct))[0];
        }
        var search = SearchName(name);
        if (await db.WorkspaceGroups.AnyAsync(g => g.SearchName == search && g.Id != groupId, ct)) return Failure.Conflict(Codes.Conflict, "Another group has that name");
        var from = group.Name;
        group.Name = name;
        group.SearchName = search;
        group.Version++;
        group.UpdatedBy = admin.UserId;
        group.UpdatedAt = clock.GetUtcNow();
        audit.Add(actor, "group.rename", admin.WorkspaceId, "group", group.Id, new { from, to = name });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return (await DtosAsync([group], ct))[0];
    }

    /// <summary>The group's people, the whole list; <paramref name="ifVersion"/> is an optional If-Match.</summary>
    public async Task<Result<GroupDto>> SetPeopleAsync(Member admin, Actor actor, Guid groupId, GroupPeople request, long? ifVersion, CancellationToken ct = default)
    {
        if (!admin.IsAdmin) return Failure.Denied("Only an owner or admin changes a group's people");
        if (request.People is not { } people) return Failure.Invalid("people is the group's whole list of people");
        if (people.Count > MaxPeople) return Failure.Invalid($"A group holds at most {MaxPeople} people");
        var wanted = people.ToHashSet();

        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(admin.WorkspaceId, ct);
        var group = await db.WorkspaceGroups.FirstOrDefaultAsync(g => g.Id == groupId, ct);
        if (group is null) return Failure.NotFound("No such group");
        if (ifVersion is { } expected && expected != group.Version) return Failure.Conflict(Codes.VersionConflict, $"The group is at version {group.Version}");
        var current = (await db.WorkspaceGroupMembers.AsNoTracking().Where(m => m.GroupId == groupId).Select(m => m.UserId).ToListAsync(ct)).ToHashSet();
        var added = wanted.Except(current).Order().ToList();
        var removed = current.Except(wanted).Order().ToList();
        // Only those joining are checked: someone in the group is a member (leaving the workspace, or
        // made a guest, takes them out).
        if (await PeopleProblemAsync(added, ct) is { } problem) return problem;
        if (added.Count == 0 && removed.Count == 0)
        {
            await tx.RollbackAsync(ct);
            return (await DtosAsync([group], ct))[0];
        }
        var kind = await HoldsRowsAsync(groupId, ct) ? "revoke" : "grant";
        foreach (var chunk in Chunked.Of(removed))
            await db.WorkspaceGroupMembers.Where(m => m.GroupId == groupId && chunk.Contains(m.UserId)).ExecuteDeleteAsync(ct);
        var now = clock.GetUtcNow();
        foreach (var person in added) db.WorkspaceGroupMembers.Add(Membership(group, person, admin.UserId, now));
        group.Version++;
        group.UpdatedBy = admin.UserId;
        group.UpdatedAt = now;
        foreach (var person in added.Concat(removed)) changes.Add("access", admin.WorkspaceId, kind, 1, admin.UserId, person);
        audit.Add(actor, "group.people", admin.WorkspaceId, "group", group.Id, new { added, removed });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return (await DtosAsync([group], ct))[0];
    }

    /// <summary>The group, its people and its rows on every page and workbook.</summary>
    public async Task<Result<bool>> DeleteAsync(Member admin, Actor actor, Guid groupId, CancellationToken ct = default)
    {
        if (!admin.IsAdmin) return Failure.Denied("Only an owner or admin deletes groups");
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(admin.WorkspaceId, ct);
        var group = await db.WorkspaceGroups.FirstOrDefaultAsync(g => g.Id == groupId, ct);
        if (group is null) return Failure.NotFound("No such group");
        var people = await db.WorkspaceGroupMembers.AsNoTracking().Where(m => m.GroupId == groupId).Select(m => m.UserId).OrderBy(u => u).ToListAsync(ct);
        var kind = await HoldsRowsAsync(groupId, ct) ? "revoke" : "grant";
        // A row naming no group means nothing: they go with it.
        var pages = await db.PagePermissions.Where(r => r.PrincipalType == Principals.Group && r.PrincipalId == groupId).ExecuteDeleteAsync(ct);
        var workbooks = await db.WorkbookPermissions.Where(r => r.PrincipalType == Principals.Group && r.PrincipalId == groupId).ExecuteDeleteAsync(ct);
        await db.WorkspaceGroupMembers.Where(m => m.GroupId == groupId).ExecuteDeleteAsync(ct);
        db.WorkspaceGroups.Remove(group);
        foreach (var person in people) changes.Add("access", admin.WorkspaceId, kind, 1, admin.UserId, person);
        audit.Add(actor, "group.delete", admin.WorkspaceId, "group", group.Id, new { name = group.Name, people, pages, workbooks });
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }

    /// <summary>
    /// Inside a transaction under the workspace's lock (its scope entered): someone removed from the
    /// workspace, made a guest, or deleting their account leaves every group they are in, and those
    /// groups' versions rise. Their <c>access</c> change is the caller's own. The groups they left.
    /// </summary>
    public static async Task<List<Guid>> LeaveAllAsync(CgwDb db, Guid userId, Guid actor, DateTimeOffset now, CancellationToken ct = default)
    {
        var groups = await db.WorkspaceGroupMembers.Where(m => m.UserId == userId).Select(m => m.GroupId).OrderBy(g => g).ToListAsync(ct);
        if (groups.Count == 0) return groups;
        await db.WorkspaceGroupMembers.Where(m => m.UserId == userId).ExecuteDeleteAsync(ct);
        await db.WorkspaceGroups.Where(g => groups.Contains(g.Id))
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.Version, g => g.Version + 1).SetProperty(g => g.UpdatedAt, now).SetProperty(g => g.UpdatedBy, actor), ct);
        return groups;
    }

    private static WorkspaceGroupMember Membership(WorkspaceGroup group, Guid person, Guid by, DateTimeOffset at) => new()
    {
        GroupId = group.Id,
        UserId = person,
        WorkspaceId = group.WorkspaceId,
        AddedBy = by,
        AddedAt = at,
    };

    /// <summary>Whether the group has a row on any page or workbook: then a change of its people can take access away.</summary>
    private async Task<bool> HoldsRowsAsync(Guid groupId, CancellationToken ct) =>
        await db.PagePermissions.AnyAsync(r => r.PrincipalType == Principals.Group && r.PrincipalId == groupId, ct)
        || await db.WorkbookPermissions.AnyAsync(r => r.PrincipalType == Principals.Group && r.PrincipalId == groupId, ct);

    /// <summary>Someone who may not join a group: not a member of the workspace, or a guest.</summary>
    private async Task<Failure?> PeopleProblemAsync(IReadOnlyCollection<Guid> people, CancellationToken ct)
    {
        var roles = new Dictionary<Guid, string>();
        foreach (var chunk in Chunked.Of(people))
            foreach (var m in await db.WorkspaceMembers.AsNoTracking().Where(m => chunk.Contains(m.UserId)).Select(m => new { m.UserId, m.Role }).ToListAsync(ct))
                roles[m.UserId] = m.Role;
        foreach (var person in people)
        {
            if (!roles.TryGetValue(person, out var role)) return Failure.Invalid($"{person} is not a member of the workspace");
            if (role == Roles.Guest) return Failure.Invalid($"{person} is a guest: guests are not in groups");
        }
        return null;
    }

    /// <summary>The groups with their people (by name), as members are shown them.</summary>
    private async Task<List<GroupDto>> DtosAsync(IReadOnlyList<WorkspaceGroup> groups, CancellationToken ct)
    {
        var ids = groups.Select(g => g.Id).ToList();
        var members = new List<(Guid GroupId, Guid UserId)>();
        foreach (var chunk in Chunked.Of(ids))
            members.AddRange((await db.WorkspaceGroupMembers.AsNoTracking().Where(m => chunk.Contains(m.GroupId)).Select(m => new { m.GroupId, m.UserId }).ToListAsync(ct))
                .Select(m => (m.GroupId, m.UserId)));
        var people = new Dictionary<Guid, GroupPersonDto>();
        foreach (var chunk in Chunked.Of(members.Select(m => m.UserId).Distinct()))
            foreach (var u in await db.Users.AsNoTracking().Where(u => chunk.Contains(u.Id)).Select(u => new { u.Id, u.DisplayName, u.Email, u.DeletedAt }).ToListAsync(ct))
                people[u.Id] = u.DeletedAt is null ? new GroupPersonDto(u.Id, u.DisplayName, u.Email) : new GroupPersonDto(u.Id, "Deleted user", null);
        var byGroup = members.ToLookup(m => m.GroupId, m => people.GetValueOrDefault(m.UserId) ?? new GroupPersonDto(m.UserId, "Deleted user", null));
        return groups.Select(g => new GroupDto(g.Id, g.Name, g.Version,
                byGroup[g.Id].OrderBy(p => p.DisplayName, StringComparer.CurrentCultureIgnoreCase).ThenBy(p => p.UserId).ToList(), g.CreatedAt))
            .ToList();
    }
}
