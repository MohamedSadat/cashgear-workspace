using System.Text.Json;
using Cgw.Core.Data;

namespace Cgw.Core;

/// <summary>Who did what, for the append-only audit log (ARCHITECTURE.md, Audit).</summary>
public sealed record Actor(Guid? UserId, string? Ip, string? CorrelationId)
{
    public static readonly Actor System = new(null, null, null);
}

/// <summary>Adds audit rows to the context; they are written with the change they describe.</summary>
public sealed class Audit(CgwDb db)
{
    public void Add(Actor actor, string action, Guid? workspaceId = null, string? targetType = null, Guid? targetId = null, object? detail = null)
    {
        db.AuditLog.Add(new AuditEntry
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = workspaceId,
            ActorUserId = actor.UserId,
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Detail = detail is null ? null : JsonSerializer.Serialize(detail),
            Ip = actor.Ip,
            CorrelationId = actor.CorrelationId,
            CreatedAt = DateTimeOffset.UtcNow,
        });
    }

    /// <summary>For events with no other change to ride with (a failed sign-in).</summary>
    public async Task WriteAsync(Actor actor, string action, Guid? workspaceId = null, string? targetType = null, Guid? targetId = null, object? detail = null)
    {
        Add(actor, action, workspaceId, targetType, targetId, detail);
        await db.SaveChangesAsync();
    }
}
