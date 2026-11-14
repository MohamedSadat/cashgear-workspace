using System.Globalization;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Core.Notifications;

public sealed record NotificationDto(
    Guid Id,
    /// <summary><c>mention</c>, <c>commentMention</c> or <c>reply</c>.</summary>
    string Kind,
    Guid WorkspaceId,
    Guid PageId,
    string PageTitle,
    string? BlockId,
    Guid? ThreadId,
    Guid? CommentId,
    PersonRef Actor,
    string Excerpt,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReadAt);

public sealed record NotificationsDto(IReadOnlyList<NotificationDto> Notifications, int Unread, string? Next);

public sealed record ReadNotificationsRequest(IReadOnlyList<Guid>? Ids, bool? All);

public sealed record UnreadDto(int Unread);

/// <summary>
/// A person's inbox (Phase 6 contracts, section 5): mentions in pages (the worker's mention pass),
/// mentions in comments and replies (the comment routes). Written once per recipient and
/// <see cref="Notification.DedupeKey"/>; each new or read entry appends a per-person
/// <c>notification</c> change to its workspace's feed, so the person's devices refresh their inbox.
/// Read across every workspace the person is in, each entry checked against the page's access now:
/// one for a page they can no longer read is left out, and counts for nothing.
/// </summary>
public sealed class NotificationService(CgwDb db, ChangeLog changes, TimeProvider clock)
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 100;
    public const int MaxIds = 500;

    public static string MentionKey(Guid pageId, string blockId) => $"mention:{pageId:N}:{blockId}";
    public static string CommentMentionKey(Guid commentId) => $"commentMention:{commentId:N}";
    public static string ReplyKey(Guid commentId) => $"reply:{commentId:N}";

    /// <summary>
    /// Adds those not written before (by recipient and key), each with its feed change. Call inside a
    /// transaction holding the workspace's lock (<see cref="ChangeLog.LockAsync"/>): a key names its
    /// page, so every writer of it waits on the same lock and the check is exact.
    /// </summary>
    public static async Task<List<Notification>> AddAsync(CgwDb db, ChangeLog changes, IReadOnlyCollection<Notification> candidates, CancellationToken ct = default)
    {
        if (candidates.Count == 0) return [];
        var users = candidates.Select(c => c.UserId).Distinct().ToList();
        var keys = candidates.Select(c => c.DedupeKey).Distinct().ToList();
        var existing = (await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .Where(n => users.Contains(n.UserId) && keys.Contains(n.DedupeKey)).Select(n => new { n.UserId, n.DedupeKey }).ToListAsync(ct))
            .Select(n => (n.UserId, n.DedupeKey)).ToHashSet();
        var added = new List<Notification>();
        foreach (var candidate in candidates)
        {
            if (!existing.Add((candidate.UserId, candidate.DedupeKey))) continue;
            db.Notifications.Add(candidate);
            changes.Add("notification", candidate.Id, "upsert", 1, candidate.ActorUserId, candidate.UserId);
            added.Add(candidate);
        }
        return added;
    }

    private sealed record Row(Guid Id, long Seq, Guid WorkspaceId, Guid PageId);

    /// <summary>The person's memberships now: workspace and role.</summary>
    private async Task<Dictionary<Guid, Member>> MembershipsAsync(Guid userId, CancellationToken ct) =>
        (await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(m => m.UserId == userId)
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), m => m.WorkspaceId, w => w.Id, (m, _) => m)
            .ToListAsync(ct))
        .ToDictionary(m => m.WorkspaceId, m => new Member(m.WorkspaceId, m.UserId, m.Role));

    /// <summary>Which of these (workspace, page) pairs the person can read now, a few queries a workspace.</summary>
    private async Task<HashSet<(Guid Workspace, Guid Page)>> ReadableAsync(Dictionary<Guid, Member> memberships, IEnumerable<(Guid Workspace, Guid Page)> pages, CancellationToken ct)
    {
        var readable = new HashSet<(Guid, Guid)>();
        var previous = db.Scope.WorkspaceId;
        try
        {
            foreach (var group in pages.Distinct().GroupBy(p => p.Workspace))
            {
                if (!memberships.TryGetValue(group.Key, out var member)) continue;
                db.Scope.Switch(group.Key);
                var levels = await new Access(db).LevelsAsync(member, group.Select(p => p.Page).ToList(), ct);
                foreach (var (page, level) in levels)
                    if (Levels.AtLeast(level, Levels.View)) readable.Add((group.Key, page));
            }
        }
        finally
        {
            db.Scope.Switch(previous);
        }
        return readable;
    }

    public async Task<Result<NotificationsDto>> ListAsync(Guid userId, bool unreadOnly, string? after, int limit, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, MaxLimit);
        long? cursor = null;
        if (!string.IsNullOrEmpty(after))
        {
            if (!long.TryParse(after, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)) return Failure.Invalid("after is a cursor from an earlier answer");
            cursor = parsed;
        }
        var memberships = await MembershipsAsync(userId, ct);
        var workspaces = memberships.Keys.ToList();
        var mine = db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(n => n.UserId == userId && workspaces.Contains(n.WorkspaceId));
        if (unreadOnly) mine = mine.Where(n => n.ReadAt == null);

        // Pages of the newest first, those the person can no longer read left out, until one more
        // than asked for is found (then there is a next page) or nothing is left.
        var kept = new List<Row>();
        var more = false;
        long? last = null;
        for (var round = 0; round < 10 && kept.Count <= limit; round++)
        {
            var from = cursor;
            var batch = await (from is { } c ? mine.Where(n => n.Seq < c) : mine)
                .OrderByDescending(n => n.Seq).Take(limit * 2 + 1)
                .Select(n => new Row(n.Id, n.Seq, n.WorkspaceId, n.PageId)).ToListAsync(ct);
            if (batch.Count == 0)
            {
                more = false;
                break;
            }
            var readable = await ReadableAsync(memberships, batch.Select(r => (r.WorkspaceId, r.PageId)), ct);
            foreach (var row in batch)
            {
                last = row.Seq;
                if (!readable.Contains((row.WorkspaceId, row.PageId))) continue;
                kept.Add(row);
                if (kept.Count > limit) break;
            }
            cursor = last;
            more = batch.Count == limit * 2 + 1 || kept.Count > limit;
            if (batch.Count < limit * 2 + 1) break;
        }
        string? next = null;
        if (kept.Count > limit)
        {
            kept.RemoveRange(limit, kept.Count - limit);
            next = kept[^1].Seq.ToString(CultureInfo.InvariantCulture);
        }
        else if (more && last is { } seen) next = seen.ToString(CultureInfo.InvariantCulture);

        var ids = kept.Select(k => k.Id).ToList();
        var rows = (await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(n => ids.Contains(n.Id)).ToListAsync(ct))
            .ToDictionary(n => n.Id);
        var pageIds = kept.Select(k => k.PageId).Distinct().ToList();
        var titles = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(p => pageIds.Contains(p.Id))
            .ToDictionaryAsync(p => p.Id, p => p.Title, ct);
        var people = await People.RefsAsync(db, rows.Values.Select(r => r.ActorUserId), ct);
        var list = kept.Select(k => rows[k.Id]).Select(n => new NotificationDto(n.Id, n.Kind, n.WorkspaceId, n.PageId, titles.GetValueOrDefault(n.PageId, ""),
            n.BlockId, n.ThreadId, n.CommentId, People.Of(people, n.ActorUserId), n.Excerpt, n.CreatedAt, n.ReadAt)).ToList();
        return new NotificationsDto(list, await UnreadAsync(userId, memberships, ct), next);
    }

    /// <summary>Unread entries for pages the person can read now.</summary>
    private async Task<int> UnreadAsync(Guid userId, Dictionary<Guid, Member> memberships, CancellationToken ct)
    {
        var workspaces = memberships.Keys.ToList();
        var counts = await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(n => n.UserId == userId && n.ReadAt == null && workspaces.Contains(n.WorkspaceId))
            .GroupBy(n => new { n.WorkspaceId, n.PageId })
            .Select(g => new { g.Key.WorkspaceId, g.Key.PageId, Count = g.Count() })
            .ToListAsync(ct);
        var readable = await ReadableAsync(memberships, counts.Select(c => (c.WorkspaceId, c.PageId)), ct);
        return counts.Where(c => readable.Contains((c.WorkspaceId, c.PageId))).Sum(c => c.Count);
    }

    /// <summary>Marks the person's entries read (these, or all), each with its feed change; the unread count after.</summary>
    public async Task<Result<UnreadDto>> ReadAsync(Guid userId, ReadNotificationsRequest request, CancellationToken ct = default)
    {
        var all = request.All == true;
        var ids = request.Ids?.Distinct().ToList() ?? [];
        if (!all && ids.Count == 0) return Failure.Invalid("Name the notifications to mark read, or all");
        if (ids.Count > MaxIds) return Failure.Invalid($"At most {MaxIds} ids at once");
        var memberships = await MembershipsAsync(userId, ct);
        var unread = db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(n => n.UserId == userId && n.ReadAt == null);
        if (!all) unread = unread.Where(n => ids.Contains(n.Id));
        var due = await unread.Select(n => new { n.Id, n.WorkspaceId }).ToListAsync(ct);
        var now = clock.GetUtcNow();
        foreach (var workspace in due.GroupBy(d => d.WorkspaceId))
        {
            foreach (var chunk in workspace.Select(d => d.Id).Chunk(MaxIds).Select(c => c.ToList()))
            {
                await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
                await changes.LockAsync(workspace.Key, ct);
                // Only those still unread now: a read that raced this one wrote their changes already.
                var marked = await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                    .Where(n => chunk.Contains(n.Id) && n.UserId == userId && n.ReadAt == null).Select(n => n.Id).ToListAsync(ct);
                if (marked.Count > 0)
                {
                    await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).Where(n => marked.Contains(n.Id))
                        .ExecuteUpdateAsync(s => s.SetProperty(n => n.ReadAt, now), ct);
                    foreach (var id in marked) changes.Add("notification", id, "upsert", 2, userId, userId);
                    await db.SaveChangesAsync(ct);
                    await changes.FlushAsync(ct);
                }
                await tx.CommitAsync(ct);
                db.ChangeTracker.Clear();
            }
        }
        return new UnreadDto(await UnreadAsync(userId, memberships, ct));
    }
}
