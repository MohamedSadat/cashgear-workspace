namespace Cgw.Core.Data;

// Phase 18: billing for Cash Gear's AI subscription through Paddle (DATA_MODEL.md, Billing). Nothing
// here is a card, an address or an amount: Paddle's ids, a subscription's status, its price and its
// period, as Paddle's own API answers them.

/// <summary>
/// A workspace's subscription at Paddle, as last read from Paddle's API (never from a webhook's body):
/// written only by <see cref="Billing.BillingService.ApplyAsync"/>, and only when Paddle's
/// <c>updated_at</c> is newer than the one held. Its plan is the server's plan whose price it holds,
/// while its status gives one (<c>active</c>, <c>trialing</c>, <c>past_due</c>).
/// </summary>
public sealed class WorkspaceBilling : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    /// <summary>Paddle's customer (<c>ctm_…</c>), for the portal and the next checkout.</summary>
    public string? CustomerId { get; set; }
    /// <summary>Paddle's subscription (<c>sub_…</c>).</summary>
    public string? SubscriptionId { get; set; }
    /// <summary><c>none</c>, <c>active</c>, <c>trialing</c>, <c>past_due</c>, <c>paused</c> or <c>canceled</c>.</summary>
    public string Status { get; set; } = Billing.BillingStatuses.None;
    /// <summary>The subscription's price (<c>pri_…</c>): the plan is the server's plan of that price.</summary>
    public string? PriceId { get; set; }
    /// <summary>The end of the period paid (<c>current_billing_period.ends_at</c>).</summary>
    public DateTimeOffset? PeriodEndsAt { get; set; }
    /// <summary>A change Paddle will make (<c>cancel</c> or <c>pause</c>), and when.</summary>
    public string? ScheduledAction { get; set; }
    public DateTimeOffset? ScheduledAt { get; set; }
    /// <summary>Paddle's <c>updated_at</c> of the state held: an older read changes nothing.</summary>
    public DateTimeOffset? ProviderUpdatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    /// <summary>When the daily reconcile last read it from Paddle.</summary>
    public DateTimeOffset? CheckedAt { get; set; }
}

/// <summary>
/// A checkout this server started: the transaction it made at Paddle for a workspace's plan, so the
/// owner's return (or the reconcile) finds the subscription it became without waiting for a webhook.
/// </summary>
public sealed class BillingCheckout : ITenantOwned
{
    /// <summary>Paddle's transaction (<c>txn_…</c>).</summary>
    public string TransactionId { get; set; } = "";
    public Guid WorkspaceId { get; set; }
    public string PlanId { get; set; } = "";
    public string PriceId { get; set; } = "";
    public Guid UserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>The subscription it became, once read.</summary>
    public string? SubscriptionId { get; set; }
}

/// <summary>
/// A webhook Paddle signed, recorded once by its <c>event_id</c> in the transaction that applied it,
/// so a delivery again (Paddle delivers at least once) or a replay changes nothing. Not tenant-owned:
/// an event names its workspace only through the subscription Paddle's API returns. Kept 90 days.
/// </summary>
public sealed class BillingEvent
{
    /// <summary>Paddle's event (<c>evt_…</c>).</summary>
    public string EventId { get; set; } = "";
    public string Type { get; set; } = "";
    public DateTimeOffset OccurredAt { get; set; }
    public DateTimeOffset ReceivedAt { get; set; }
    /// <summary>The workspace its subscription named, when there was one: a note, not an owner (the row is no workspace's).</summary>
    public Guid? AppliedToWorkspace { get; set; }
    public string? SubscriptionId { get; set; }
    /// <summary><c>applied</c>, <c>stale</c> (Paddle's state was no newer), <c>ignored</c> (no subscription), <c>unknown</c> (no workspace of this server's).</summary>
    public string Outcome { get; set; } = "";
}
