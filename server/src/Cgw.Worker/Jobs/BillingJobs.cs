using Cgw.Core;
using Cgw.Core.Billing;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Phase 18 (M18.2): the plans reconciled with Paddle once a day. Each hour, the subscriptions not
/// read from Paddle for a day are read again (200 a call) and applied as a webhook's would be (newer
/// only); the checkouts of the last day that became no subscription yet are read too, so a webhook
/// lost on the way still gives the plan the next day at the latest. Paddle's events applied are kept
/// 90 days, checkouts that came to nothing 30. Nothing runs without billing configured.
/// </summary>
public sealed class BillingReconcileJob(BillingOptions options, PaddleClient paddle, TimeProvider clock, ILogger<BillingReconcileJob> logger) : IJob
{
    public string Name => "billingReconcile";
    public TimeSpan Interval => TimeSpan.FromHours(1);
    public static readonly TimeSpan Every = TimeSpan.FromDays(1);
    public static readonly TimeSpan KeepEvents = TimeSpan.FromDays(90);
    public static readonly TimeSpan KeepCheckouts = TimeSpan.FromDays(30);

    public sealed record Report(int Read, int Applied, int Missing, int Checkouts);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        if (!options.Offered) return false;
        var report = await ReconcileAsync(services, ct);
        if (report.Applied > 0 || report.Missing > 0) logger.LogWarning("Billing reconcile: {Report}", report);
        return false;
    }

    /// <summary>One pass; <paramref name="only"/> keeps it to one workspace, and <paramref name="force"/> reads it whatever its last read (tests).</summary>
    public async Task<Report> ReconcileAsync(IServiceProvider services, CancellationToken ct, Guid? only = null, bool force = false)
    {
        var db = services.GetRequiredService<CgwDb>();
        var billing = services.GetRequiredService<BillingService>();
        var now = clock.GetUtcNow();
        var due = now - Every;
        int read = 0, applied = 0, missing = 0, checkouts = 0;
        for (var round = 0; round < 50; round++)
        {
            var batch = await db.WorkspaceBilling.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .Where(b => b.SubscriptionId != null && (force || b.CheckedAt == null || b.CheckedAt < due) && (only == null || b.WorkspaceId == only))
                .OrderBy(b => b.CheckedAt).Take(200).Select(b => new { b.WorkspaceId, b.SubscriptionId }).ToListAsync(ct);
            if (batch.Count == 0) break;
            List<PaddleSubscription> found;
            try
            {
                found = await paddle.SubscriptionsAsync(batch.Select(b => b.SubscriptionId!).ToList(), ct);
            }
            catch (PaddleException error)
            {
                logger.LogWarning("Billing reconcile could not read Paddle: {Code} ({Status})", error.PaddleCode ?? "none", (int?)error.Status);
                break;
            }
            read += found.Count;
            foreach (var s in found)
                if (await billing.ApplyAsync(s, Actor.System, "reconcile", ct) == BillingService.Outcomes.Applied) applied++;
            var named = found.Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var gone in batch.Where(b => !named.Contains(b.SubscriptionId!)))
            {
                missing++;
                logger.LogError("Workspace {Workspace}'s subscription {Subscription} is not at Paddle", gone.WorkspaceId, gone.SubscriptionId);
            }
            var ids = batch.Select(b => b.WorkspaceId).ToList();
            await db.WorkspaceBilling.IgnoreQueryFilters([CgwDb.Tenant]).Where(b => ids.Contains(b.WorkspaceId))
                .ExecuteUpdateAsync(u => u.SetProperty(b => b.CheckedAt, now), ct);
            if (force) break;
        }

        // Checkouts of the last day that became no subscription yet, for every workspace that has one.
        var since = now - TimeSpan.FromDays(1);
        var open = await db.BillingCheckouts.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(c => c.SubscriptionId == null && c.CreatedAt >= since && c.CreatedAt < now - TimeSpan.FromMinutes(5) && (only == null || c.WorkspaceId == only))
            .Select(c => c.WorkspaceId).Distinct().Take(200).ToListAsync(ct);
        foreach (var workspace in open)
        {
            try
            {
                await billing.ReadAgainAsync(workspace, Actor.System, "reconcile", ct);
                checkouts++;
            }
            catch (PaddleException error)
            {
                logger.LogWarning("Billing reconcile could not read a checkout: {Code} ({Status})", error.PaddleCode ?? "none", (int?)error.Status);
                break;
            }
        }

        await db.BillingEvents.Where(e => e.ReceivedAt < now - KeepEvents).ExecuteDeleteAsync(ct);
        await db.BillingCheckouts.IgnoreQueryFilters([CgwDb.Tenant]).Where(c => c.SubscriptionId == null && c.CreatedAt < now - KeepCheckouts).ExecuteDeleteAsync(ct);
        return new Report(read, applied, missing, checkouts);
    }
}
