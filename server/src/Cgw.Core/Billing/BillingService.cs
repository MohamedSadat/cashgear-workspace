using System.Collections.Concurrent;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Sites;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Cgw.Core.Billing;

/// <summary>A plan as Settings shows it: its names, its allowance and, when Paddle answered, its price.</summary>
public sealed record BillingPlanDto(string Id, string NameEn, string NameAr, long MonthlyTokens, long EmbeddingsMonthlyTokens, BillingPriceDto? Price);

/// <summary>A price as Paddle's catalogue holds it: the amount in the currency's smallest unit, and how often it bills.</summary>
public sealed record BillingPriceDto(string Amount, string Currency, string? Interval, int Frequency);

/// <summary>
/// <c>GET /workspaces/{id}/billing</c>: the plans offered, the workspace's plan and its subscription's
/// state, and whether the caller (an owner) may subscribe, change the plan or open the portal.
/// </summary>
public sealed record BillingDto
{
    public required IReadOnlyList<BillingPlanDto> Plans { get; init; }
    /// <summary>The plan whose allowance the workspace has (null with none).</summary>
    public string? PlanId { get; init; }
    /// <summary><c>none</c>, <c>active</c>, <c>trialing</c>, <c>past_due</c>, <c>paused</c> or <c>canceled</c>.</summary>
    public required string Status { get; init; }
    public DateTimeOffset? PeriodEndsAt { get; init; }
    /// <summary><c>cancel</c> or <c>pause</c> when Paddle will make that change at <see cref="ScheduledAt"/>.</summary>
    public string? ScheduledAction { get; init; }
    public DateTimeOffset? ScheduledAt { get; init; }
    /// <summary>The caller is an owner: subscribe, change the plan, open the portal.</summary>
    public required bool CanManage { get; init; }
    /// <summary>A checkout started in the last hour that has not yet become a subscription.</summary>
    public bool CheckoutPending { get; init; }
}

/// <summary><c>POST …/billing/checkout</c> and <c>…/billing/plan</c>: the plan chosen, and (a checkout) the language its pay page speaks.</summary>
public sealed record BillingPlanChoice(string? PlanId, string? Language = null);

/// <summary>Where to send the owner: Paddle's checkout on the pay page, or Paddle's portal.</summary>
public sealed record BillingLinkDto(string Url);

/// <summary>
/// Cash Gear's AI subscription paid for through Paddle (Phase 18, M18.2; INTEGRATIONS.md, Billing).
/// Owners subscribe in Paddle's checkout, on the Sites process's pay page, and manage the
/// subscription in Paddle's portal; the server never sees a card or payment detail. A workspace's
/// plan is read from Paddle's API only (a webhook's body is a prompt to read it, never the state),
/// applied in one place (<see cref="ApplyAsync"/>) when Paddle's state is newer than the one held,
/// with its price on the AI settings row in the same transaction, under that row's lock, so an
/// allowance check sees the plan or the plan before it, never half of one.
/// </summary>
public sealed class BillingService(CgwDb db, BillingOptions options, PaddleClient paddle, BillingPrices prices, SitesOptions sites, Audit audit, TimeProvider clock, ILogger<BillingService> logger)
{
    public const string PayPath = "/_pay";

    /// <summary>How long a checkout is "pending" in Settings after it was started.</summary>
    public static readonly TimeSpan PendingFor = TimeSpan.FromHours(1);

    private static Failure Off() => Failure.NotFound("Billing is not offered on this server");

    private static Failure Provider(PaddleException error) =>
        new(Codes.BillingProvider, 502, "Paddle could not be reached or refused the request; try again");

    /// <summary>The workspace's billing as owners and admins see it; members and guests are refused.</summary>
    public async Task<Result<BillingDto>> StateAsync(Member member, CancellationToken ct = default)
    {
        if (!options.Offered) return Off();
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin sees the workspace's plan");
        var row = await db.WorkspaceBilling.AsNoTracking().FirstOrDefaultAsync(ct);
        var since = clock.GetUtcNow() - PendingFor;
        var pending = await db.BillingCheckouts.AsNoTracking().AnyAsync(c => c.CreatedAt >= since && c.SubscriptionId == null, ct);
        var plans = new List<BillingPlanDto>();
        foreach (var plan in options.Plans)
            plans.Add(new BillingPlanDto(plan.Id, plan.NameEn, plan.NameAr, plan.MonthlyTokens, plan.EmbeddingsMonthlyTokens, await prices.GetAsync(plan.PriceId, ct)));
        var entitled = row is not null && BillingStatuses.Entitles(row.Status);
        return new BillingDto
        {
            Plans = plans,
            PlanId = entitled ? options.PlanByPrice(row!.PriceId)?.Id : null,
            Status = row?.Status ?? BillingStatuses.None,
            PeriodEndsAt = row?.PeriodEndsAt,
            ScheduledAction = row?.ScheduledAction,
            ScheduledAt = row?.ScheduledAt,
            CanManage = member.Role == Roles.Owner,
            CheckoutPending = pending && !entitled,
        };
    }

    /// <summary>
    /// A checkout of a plan for a workspace with none: a transaction at Paddle carrying the
    /// workspace's id, opened on the pay page by Paddle.js. Owners only; 409 <c>billing.subscribed</c>
    /// for a workspace on a plan already (it changes plan instead).
    /// </summary>
    public async Task<Result<BillingLinkDto>> CheckoutAsync(Member member, Actor actor, BillingPlanChoice body, CancellationToken ct = default)
    {
        if (!options.Offered) return Off();
        if (member.Role != Roles.Owner) return Failure.Denied("Only an owner subscribes the workspace");
        if (options.PlanById(body.PlanId) is not { } plan) return Failure.Invalid("planId is one of " + string.Join(", ", options.Plans.Select(p => p.Id)));
        var row = await db.WorkspaceBilling.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row is not null && BillingStatuses.Entitles(row.Status))
            return Failure.Conflict(Codes.BillingSubscribed, "The workspace is on a plan already: change its plan instead");
        string id, url;
        try
        {
            (id, url) = await paddle.CreateTransactionAsync(plan.PriceId, row?.CustomerId, member.WorkspaceId,
                sites.PublicUrl.TrimEnd('/') + PayPath + (body.Language == "ar" ? "/ar" : "/en"), ct);
        }
        catch (PaddleException error)
        {
            logger.LogWarning("Paddle refused a checkout: {Code} ({Status})", error.PaddleCode ?? "none", (int?)error.Status);
            return Provider(error);
        }
        var now = clock.GetUtcNow();
        db.BillingCheckouts.Add(new BillingCheckout { TransactionId = id, WorkspaceId = member.WorkspaceId, PlanId = plan.Id, PriceId = plan.PriceId, UserId = member.UserId, CreatedAt = now });
        audit.Add(actor, "billing.checkout", member.WorkspaceId, "workspace", member.WorkspaceId, new { plan = plan.Id, transaction = id });
        await db.SaveChangesAsync(ct);
        return new BillingLinkDto(url);
    }

    /// <summary>The workspace's plan changed at once, prorated by Paddle (owners only; 409 <c>billing.none</c> with no plan).</summary>
    public async Task<Result<BillingDto>> ChangePlanAsync(Member member, Actor actor, BillingPlanChoice body, CancellationToken ct = default)
    {
        if (!options.Offered) return Off();
        if (member.Role != Roles.Owner) return Failure.Denied("Only an owner changes the workspace's plan");
        if (options.PlanById(body.PlanId) is not { } plan) return Failure.Invalid("planId is one of " + string.Join(", ", options.Plans.Select(p => p.Id)));
        var row = await db.WorkspaceBilling.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row?.SubscriptionId is not { } subscription || !BillingStatuses.Entitles(row.Status))
            return Failure.Conflict(Codes.BillingNone, "The workspace has no plan to change: subscribe instead");
        if (row.PriceId != plan.PriceId)
        {
            PaddleSubscription? changed;
            try
            {
                changed = await paddle.ChangePriceAsync(subscription, plan.PriceId, ct);
            }
            catch (PaddleException error)
            {
                logger.LogWarning("Paddle refused a plan change: {Code} ({Status})", error.PaddleCode ?? "none", (int?)error.Status);
                return Provider(error);
            }
            audit.Add(actor, "billing.plan", member.WorkspaceId, "workspace", member.WorkspaceId, new { from = options.PlanByPrice(row.PriceId)?.Id, to = plan.Id });
            await db.SaveChangesAsync(ct);
            if (changed is not null) await ApplyAsync(changed, actor, "change", ct);
        }
        return await StateAsync(member, ct);
    }

    /// <summary>A link to Paddle's portal for the workspace's customer (owners only; 409 <c>billing.none</c> before a first checkout).</summary>
    public async Task<Result<BillingLinkDto>> PortalAsync(Member member, Actor actor, CancellationToken ct = default)
    {
        if (!options.Offered) return Off();
        if (member.Role != Roles.Owner) return Failure.Denied("Only an owner manages the workspace's billing");
        var row = await db.WorkspaceBilling.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row?.CustomerId is not { } customer) return Failure.Conflict(Codes.BillingNone, "The workspace has never subscribed");
        string url;
        try
        {
            url = await paddle.PortalAsync(customer, row.SubscriptionId, ct);
        }
        catch (PaddleException error)
        {
            logger.LogWarning("Paddle refused a portal session: {Code} ({Status})", error.PaddleCode ?? "none", (int?)error.Status);
            return Provider(error);
        }
        audit.Add(actor, "billing.portal", member.WorkspaceId, "workspace", member.WorkspaceId);
        await db.SaveChangesAsync(ct);
        return new BillingLinkDto(url);
    }

    /// <summary>
    /// The workspace's subscription read again from Paddle (owners and admins): its own, or the one the
    /// last hour's checkouts became. What a webhook would have done, for an owner back from Paddle.
    /// </summary>
    public async Task<Result<BillingDto>> RefreshAsync(Member member, Actor actor, CancellationToken ct = default)
    {
        if (!options.Offered) return Off();
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin sees the workspace's plan");
        try
        {
            await ReadAgainAsync(member.WorkspaceId, actor, "refresh", ct);
        }
        catch (PaddleException error)
        {
            logger.LogWarning("Paddle could not be read: {Code} ({Status})", error.PaddleCode ?? "none", (int?)error.Status);
            return Provider(error);
        }
        return await StateAsync(member, ct);
    }

    /// <summary>One workspace's subscription read from Paddle and applied: the one held, then any checkout's new one.</summary>
    public async Task ReadAgainAsync(Guid workspaceId, Actor actor, string source, CancellationToken ct)
    {
        var row = await db.WorkspaceBilling.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(b => b.WorkspaceId == workspaceId, ct);
        if (row?.SubscriptionId is { } held && await paddle.SubscriptionAsync(held, ct) is { } current)
            await ApplyAsync(current, actor, source, ct);
        var since = clock.GetUtcNow() - TimeSpan.FromDays(1);
        var checkouts = await db.BillingCheckouts.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(c => c.WorkspaceId == workspaceId && c.CreatedAt >= since && c.SubscriptionId == null)
            .OrderByDescending(c => c.CreatedAt).Take(5).Select(c => c.TransactionId).ToListAsync(ct);
        foreach (var transaction in checkouts)
        {
            if (await paddle.TransactionSubscriptionAsync(transaction, ct) is not { } made) continue;
            await db.BillingCheckouts.IgnoreQueryFilters([CgwDb.Tenant]).Where(c => c.TransactionId == transaction)
                .ExecuteUpdateAsync(u => u.SetProperty(c => c.SubscriptionId, made), ct);
            if (await paddle.SubscriptionAsync(made, ct) is { } subscription) await ApplyAsync(subscription, actor, source, ct);
        }
    }

    /// <summary>The outcomes of <see cref="ApplyAsync"/>.</summary>
    public static class Outcomes
    {
        public const string Applied = "applied";
        public const string Stale = "stale";
        public const string Ignored = "ignored";
        public const string Unknown = "unknown";
        public const string Duplicate = "duplicate";
    }

    /// <summary>
    /// The one place a workspace's plan is written: a subscription as Paddle's API answered it,
    /// applied when its <c>updated_at</c> is newer than the one held, to the workspace its
    /// <c>custom_data</c> names (one of this server's, not deleted), with the plan's price on the AI
    /// settings row, in one transaction under that row's lock (which reservations take). A second
    /// subscription of a workspace already on one is left as it is, recorded <c>duplicate</c>. Audited
    /// <c>billing.changed</c> when the plan or the status changed. <paramref name="recordEvent"/>, when
    /// given, is the webhook's event, recorded in the same transaction so it is applied once.
    /// </summary>
    public async Task<string> ApplyAsync(PaddleSubscription s, Actor actor, string source, CancellationToken ct, BillingEvent? recordEvent = null)
    {
        if (s.WorkspaceId is not { } ws || !await db.Workspaces.AsNoTracking().AnyAsync(w => w.Id == ws && w.DeletedAt == null, ct))
        {
            if (recordEvent is not null) await RecordAsync(recordEvent, Outcomes.Unknown, ct);
            logger.LogWarning("A Paddle subscription {Subscription} names no workspace of this server", s.Id);
            return Outcomes.Unknown;
        }
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct);
            var now = clock.GetUtcNow();
            // The AI settings row is the plan's lock (AiAllowance.ReserveAsync takes it): made if absent.
            var settings = await db.AiSettings.FromSqlRaw(
                "SELECT * FROM [AiSettings] WITH (UPDLOCK, HOLDLOCK) WHERE [WorkspaceId] = @ws",
                new SqlParameter("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(ws) }).IgnoreQueryFilters([CgwDb.Tenant]).FirstOrDefaultAsync(ct);
            if (settings is null)
            {
                settings = new AiSettings { WorkspaceId = ws, UpdatedAt = now };
                db.AiSettings.Add(settings);
            }
            var row = await db.WorkspaceBilling.IgnoreQueryFilters([CgwDb.Tenant]).FirstOrDefaultAsync(b => b.WorkspaceId == ws, ct);
            string outcome;
            if (row is not null && row.ProviderUpdatedAt is { } held && s.UpdatedAt <= held && row.SubscriptionId == s.Id)
                outcome = Outcomes.Stale;
            else if (row is not null && row.SubscriptionId is { } other && other != s.Id && BillingStatuses.Entitles(row.Status))
            {
                outcome = Outcomes.Duplicate;
                logger.LogError("Workspace {Workspace} on subscription {Held} has another, {Other} ({Status}): left as it is", ws, other, s.Id, s.Status);
                audit.Add(actor, "billing.duplicate", ws, "workspace", ws, new { held = other, other = s.Id, status = s.Status, source });
            }
            else
            {
                outcome = Outcomes.Applied;
                var before = row is null ? null : new { plan = BillingStatuses.Entitles(row.Status) ? options.PlanByPrice(row.PriceId)?.Id : null, status = row.Status };
                if (row is null)
                {
                    row = new WorkspaceBilling { WorkspaceId = ws };
                    db.WorkspaceBilling.Add(row);
                }
                row.SubscriptionId = s.Id;
                row.CustomerId = s.CustomerId ?? row.CustomerId;
                row.Status = s.Status;
                row.PriceId = s.PriceId;
                row.PeriodEndsAt = s.PeriodEndsAt;
                row.ScheduledAction = s.ScheduledAction;
                row.ScheduledAt = s.ScheduledAt;
                row.ProviderUpdatedAt = s.UpdatedAt;
                row.UpdatedAt = now;
                var plan = BillingStatuses.Entitles(s.Status) ? options.PlanByPrice(s.PriceId) : null;
                settings.PlanPriceId = plan?.PriceId;
                var after = new { plan = plan?.Id, status = s.Status };
                if (before is null || before.plan != after.plan || before.status != after.status)
                    audit.Add(actor, "billing.changed", ws, "workspace", ws, new
                    {
                        from = before,
                        to = after,
                        subscription = s.Id,
                        price = s.PriceId,
                        priceKnown = s.PriceId is null || options.PlanByPrice(s.PriceId) is not null,
                        source,
                    });
            }
            if (recordEvent is not null) db.BillingEvents.Add(With(recordEvent, outcome, ws, s.Id));
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            db.ChangeTracker.Clear();
            return outcome;
        });
    }

    private static BillingEvent With(BillingEvent e, string outcome, Guid? ws, string? subscription) => new()
    {
        EventId = e.EventId,
        Type = e.Type,
        OccurredAt = e.OccurredAt,
        ReceivedAt = e.ReceivedAt,
        AppliedToWorkspace = ws ?? e.AppliedToWorkspace,
        SubscriptionId = subscription ?? e.SubscriptionId,
        Outcome = outcome,
    };

    private async Task RecordAsync(BillingEvent e, string outcome, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        db.BillingEvents.Add(With(e, outcome, null, null));
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();
    }

    /// <summary>The webhook's answers.</summary>
    public enum WebhookResult
    {
        /// <summary>Applied, or nothing to apply: 200.</summary>
        Done,
        /// <summary>Recorded already (Paddle delivers at least once): 200, nothing changed.</summary>
        Again,
        /// <summary>No valid signature: 401, nothing read.</summary>
        Forged,
        /// <summary>Not an event's shape: 400.</summary>
        Invalid,
        /// <summary>Paddle's API could not be read: 503, so Paddle delivers it again.</summary>
        Retry,
    }

    /// <summary>
    /// A webhook from Paddle: its signature checked against the destination's secret before anything
    /// is read; an event recorded already changes nothing; a subscription's or a transaction's event
    /// reads the subscription from Paddle's API and applies it with the event recorded in the same
    /// transaction. The body itself is never the state.
    /// </summary>
    public async Task<WebhookResult> WebhookAsync(string? signature, byte[] body, CancellationToken ct = default)
    {
        if (options.Paddle is not { } paddleOptions) return WebhookResult.Forged;
        if (!PaddleSignature.Verify(signature, body, paddleOptions.WebhookSecret, clock.GetUtcNow())) return WebhookResult.Forged;
        string? eventId, type, subscription = null;
        DateTimeOffset occurred;
        try
        {
            using var json = JsonDocument.Parse(body);
            var root = json.RootElement;
            eventId = root.TryGetProperty("event_id", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            type = root.TryGetProperty("event_type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            if (!BillingOptions.PaddleId(eventId, "evt_") || type is not { Length: > 0 and <= 64 }
                || !root.TryGetProperty("occurred_at", out var o) || !o.TryGetDateTimeOffset(out occurred)
                || !root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
                return WebhookResult.Invalid;
            var key = type.StartsWith("subscription.", StringComparison.Ordinal) ? "id" : type.StartsWith("transaction.", StringComparison.Ordinal) ? "subscription_id" : null;
            if (key is not null && data.TryGetProperty(key, out var sub) && sub.ValueKind == JsonValueKind.String && BillingOptions.PaddleId(sub.GetString(), "sub_"))
                subscription = sub.GetString();
        }
        catch (JsonException)
        {
            return WebhookResult.Invalid;
        }
        if (await db.BillingEvents.AsNoTracking().AnyAsync(x => x.EventId == eventId, ct)) return WebhookResult.Again;
        var record = new BillingEvent { EventId = eventId!, Type = type, OccurredAt = occurred.ToUniversalTime(), ReceivedAt = clock.GetUtcNow(), SubscriptionId = subscription };
        try
        {
            if (subscription is null)
            {
                await RecordAsync(record, Outcomes.Ignored, ct);
                return WebhookResult.Done;
            }
            PaddleSubscription? current;
            try
            {
                current = await paddle.SubscriptionAsync(subscription, ct);
            }
            catch (PaddleException error)
            {
                logger.LogWarning("A webhook's subscription could not be read from Paddle: {Code} ({Status})", error.PaddleCode ?? "none", (int?)error.Status);
                return WebhookResult.Retry;
            }
            if (current is null) await RecordAsync(record, Outcomes.Ignored, ct);
            else await ApplyAsync(current, Actor.System, "webhook:" + type, ct, record);
            return WebhookResult.Done;
        }
        // The same event delivered twice at once: the second's record is refused by the key.
        catch (DbUpdateException error) when (error.InnerException is SqlException { Number: 2627 or 2601 })
        {
            db.ChangeTracker.Clear();
            return WebhookResult.Again;
        }
    }
}

/// <summary>
/// The plans' prices as Paddle's catalogue holds them, read once an hour at most a price (one set an
/// API process); a price Paddle cannot give is shown as none, and the plan is still offered.
/// </summary>
public sealed class BillingPrices(PaddleClient paddle, TimeProvider clock, ILogger<BillingPrices> logger)
{
    public static readonly TimeSpan Keep = TimeSpan.FromHours(1);

    private readonly ConcurrentDictionary<string, (BillingPriceDto? Price, DateTimeOffset At)> held = new(StringComparer.Ordinal);

    public async Task<BillingPriceDto?> GetAsync(string priceId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (held.TryGetValue(priceId, out var hit) && now - hit.At < Keep) return hit.Price;
        BillingPriceDto? price = null;
        try
        {
            if (await paddle.PriceAsync(priceId, ct) is { } p) price = new BillingPriceDto(p.Amount, p.Currency, p.Interval, p.Frequency);
        }
        catch (PaddleException error)
        {
            logger.LogWarning("Paddle's price {Price} could not be read: {Code}", priceId, error.PaddleCode ?? "none");
            // A failure is kept for a minute only.
            held[priceId] = (hit.Price, now - Keep + TimeSpan.FromMinutes(1));
            return hit.Price;
        }
        held[priceId] = (price, now);
        return price;
    }
}
