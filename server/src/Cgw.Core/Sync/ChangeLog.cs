using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sync;

/// <summary>
/// Appends to a workspace's change feed (SYNC_DESIGN.md, Channel 2). The sequence is given out
/// under a lock on the workspace row held to the end of the transaction, so changes commit in
/// sequence order and a reader can never pass one that is still being written. The same lock
/// serialises a workspace's tree operations, which keeps the tree rules free of races.
/// </summary>
public sealed class ChangeLog(CgwDb db, TimeProvider clock)
{
    private Guid workspace;
    private long head;
    private long next;

    /// <summary>Takes the workspace row's lock; call inside a transaction, before reading what an operation checks.</summary>
    public async Task LockAsync(Guid workspaceId, CancellationToken ct = default)
    {
        workspace = workspaceId;
        await db.Workspaces.Where(w => w.Id == workspaceId)
            .ExecuteUpdateAsync(s => s.SetProperty(w => w.ChangeSeq, w => w.ChangeSeq), ct);
        head = next = await db.Workspaces.Where(w => w.Id == workspaceId).Select(w => w.ChangeSeq).SingleAsync(ct);
    }

    public long Head => next;

    /// <summary>
    /// Whether anything that can change who may do what in the workspace (an access list, a move
    /// that changes a page's access, a member joining, leaving or changing role, the workspace
    /// going) committed after change <paramref name="seq"/>: each writes an <c>access</c>,
    /// <c>member</c> or <c>workspace</c> change under this lock. Call after <see cref="LockAsync"/>,
    /// so nothing of the kind can still be on its way.
    /// </summary>
    public Task<bool> AccessChangedSinceAsync(long seq, CancellationToken ct = default)
    {
        if (workspace == Guid.Empty) throw new InvalidOperationException("Lock the workspace first.");
        var id = workspace;
        return db.WorkspaceChanges.IgnoreQueryFilters([CgwDb.Tenant]).AnyAsync(c => c.WorkspaceId == id && c.Seq > seq
            && (c.EntityType == "access" || c.EntityType == "member" || c.EntityType == "workspace"), ct);
    }

    public void Add(string entityType, Guid entityId, string kind, long version, Guid? actor, Guid? userId = null)
    {
        if (workspace == Guid.Empty) throw new InvalidOperationException("Lock the workspace first.");
        db.WorkspaceChanges.Add(new WorkspaceChange
        {
            WorkspaceId = workspace,
            Seq = ++next,
            EntityType = entityType,
            EntityId = entityId,
            Kind = kind,
            Version = version,
            ActorUserId = actor,
            UserId = userId,
            CreatedAt = clock.GetUtcNow(),
        });
    }

    /// <summary>Moves the workspace's head to the last change added; call before committing.</summary>
    public async Task FlushAsync(CancellationToken ct = default)
    {
        if (next == head) return;
        var value = next;
        await db.Workspaces.Where(w => w.Id == workspace).ExecuteUpdateAsync(s => s.SetProperty(w => w.ChangeSeq, value), ct);
        head = next;
    }
}

internal static class Chunked
{
    /// <summary>Lists of ids in pieces small enough for one SQL statement's parameters.</summary>
    public static IEnumerable<List<Guid>> Of(IEnumerable<Guid> ids, int size = 1000) => ids.Chunk(size).Select(c => c.ToList());
}
