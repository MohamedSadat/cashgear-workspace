using System.Security.Cryptography;
using Cgw.Core.Data;
using Cgw.Core.Workspaces;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Realtime;

public sealed record RealtimeTicketDto(string Ticket, DateTimeOffset ExpiresAt);

/// <summary>Who a used ticket names: the hub connection's person and device, and nothing else.</summary>
public sealed record TicketHolder(Guid UserId, Guid? DeviceId);

/// <summary>
/// Tickets to the real-time hub (Phase 6 contracts, section 1, Connecting). A signed-in caller asks
/// for one (cookie or bearer); the WebSocket's upgrade carries it in its query string, where a
/// credential that still works must never be: so it is 32 random bytes kept only as SHA-256, good for
/// 60 seconds and one use, and every reconnect takes a new one.
/// </summary>
public sealed class RealtimeTickets(CgwDb db, TimeProvider clock)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(60);

    public async Task<RealtimeTicketDto> IssueAsync(Guid userId, Guid? deviceId, CancellationToken ct = default)
    {
        var ticket = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var now = clock.GetUtcNow();
        db.RealtimeTickets.Add(new RealtimeTicket
        {
            Id = Guid.CreateVersion7(),
            UserId = userId,
            DeviceId = deviceId,
            TokenHash = WorkspaceService.Hash(ticket),
            ExpiresAt = now + Lifetime,
            CreatedAt = now,
        });
        await db.SaveChangesAsync(ct);
        return new RealtimeTicketDto(ticket, now + Lifetime);
    }

    /// <summary>
    /// The ticket's holder, using it up; null for one unknown, used or expired (all three alike). The
    /// first request that marks it wins, race or not.
    /// </summary>
    public async Task<TicketHolder?> ConsumeAsync(string? ticket, CancellationToken ct = default)
    {
        if (ticket is not { Length: > 0 and <= 200 }) return null;
        var hash = WorkspaceService.Hash(ticket);
        var now = clock.GetUtcNow();
        var row = await db.RealtimeTickets.AsNoTracking().FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
        if (row is null || row.UsedAt is not null || row.ExpiresAt <= now) return null;
        var marked = await db.RealtimeTickets.Where(t => t.Id == row.Id && t.UsedAt == null && t.ExpiresAt > now)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), ct);
        return marked == 1 ? new TicketHolder(row.UserId, row.DeviceId) : null;
    }
}
