namespace Cgw.Core.Data;

// Phase 15: automations (DATA_MODEL.md, Automations). Every table is tenant-owned and filtered.

/// <summary>A database's rule: its definition as packages/workspace/src/db/automations.ts holds it.</summary>
public sealed class Automation : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid DatabaseId { get; set; }
    /// <summary>JSON: <c>{ name, trigger, conditions, steps }</c>, as <c>AutomationRules.Check</c> kept it.</summary>
    public string Definition { get; set; } = "{}";
    public string Name { get; set; } = "";
    /// <summary>The trigger's kind (<c>rowAdded</c>, <c>propertyChanged</c>, <c>date</c>, <c>schedule</c>, <c>button</c>), for the runner's reads.</summary>
    public string TriggerKind { get; set; } = "";
    public bool Enabled { get; set; }
    /// <summary>Whom it acts as: whoever last saved it, checked again at every run.</summary>
    public Guid AuthorId { get; set; }
    public long Version { get; set; } = 1;
    /// <summary>A schedule's next run (in UTC), worked out in the workspace's time zone; null for other triggers.</summary>
    public DateTimeOffset? NextAt { get; set; }
    /// <summary>A date trigger: dates reached up to this instant have been run (none from before it was switched on).</summary>
    public DateTimeOffset? ScannedUntil { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    /// <summary>Deleted: kept so the feed can tell the database's readers, removed with its runs after 30 days.</summary>
    public DateTimeOffset? DeletedAt { get; set; }
    /// <summary>Phase 17: a step waits on its row (a date or conditions), so its rows' changes are written while it is on.</summary>
    public bool WatchesRows { get; set; }
}

/// <summary>
/// A change of a row a rule may start on, written in the change's own transaction (DatabaseOps'
/// flush, a button's press) and taken by the worker in order.
/// </summary>
public sealed class AutomationEvent : ITenantOwned
{
    /// <summary>The order changes reached the server in (an identity column).</summary>
    public long Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid DatabaseId { get; set; }
    public Guid RowId { get; set; }
    /// <summary><c>added</c>, <c>changed</c> or <c>button</c>.</summary>
    public string Kind { get; set; } = "";
    /// <summary>JSON: the property ids that changed (the title as <c>title</c>); a press's, its button.</summary>
    public string Changed { get; set; } = "[]";
    /// <summary>JSON: the changed properties' values before and after (absent: empty).</summary>
    public string Before { get; set; } = "{}";
    public string After { get; set; } = "{}";
    /// <summary>Who made the change: a person, or (with <see cref="RunId"/>) a rule's author.</summary>
    public Guid? ActorId { get; set; }
    /// <summary>0 for a person's change; a run's change carries its run's depth.</summary>
    public int Depth { get; set; }
    /// <summary>The run whose step made the change, if a rule made it.</summary>
    public Guid? RunId { get; set; }
    /// <summary>A button's press, once: a press a device sends again is the same event.</summary>
    public Guid? PressId { get; set; }
    /// <summary>Phase 16: a row added by a form's answer, its form view (rules on "a form is answered").</summary>
    public Guid? FormId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>When the worker took it; one taken and not done after a while is taken again.</summary>
    public DateTimeOffset? TakenAt { get; set; }
    public DateTimeOffset? DoneAt { get; set; }
}

public static class EventKinds
{
    public const string Added = "added";
    public const string Changed = "changed";
    public const string Button = "button";
}

public static class RunStatuses
{
    public const string Running = "running";
    public const string Done = "done";
    /// <summary>Stopped part way, or before its first step: its author could not, the depth limit, a step refused.</summary>
    public const string Stopped = "stopped";
    /// <summary>Not run: a rate limit.</summary>
    public const string Skipped = "skipped";
    /// <summary>Phase 17: at a wait or an approval, its place kept, until the worker goes on from it.</summary>
    public const string Waiting = "waiting";
}

/// <summary>Phase 17: what a waiting run waits for.</summary>
public static class WaitKinds
{
    public const string Time = "time";
    public const string Date = "date";
    public const string Match = "match";
    public const string Approval = "approval";
}

/// <summary>One run of a rule: what started it, each step's outcome, and how it ended.</summary>
public sealed class AutomationRun : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid AutomationId { get; set; }
    public Guid DatabaseId { get; set; }
    /// <summary>The row it ran for; null for a schedule.</summary>
    public Guid? RowId { get; set; }
    /// <summary>The change that started it (a row's or a press), once per rule.</summary>
    public long? EventId { get; set; }
    /// <summary>A date's or a schedule's moment that started it (<c>date:&lt;row&gt;:&lt;instant&gt;</c>, <c>schedule:&lt;instant&gt;</c>), once per rule.</summary>
    public string? DueKey { get; set; }
    public string Trigger { get; set; } = "";
    public int Depth { get; set; }
    /// <summary>Who started it (a person's change or press); null for a date or a schedule.</summary>
    public Guid? ActorId { get; set; }
    public Guid AuthorId { get; set; }
    public string Status { get; set; } = RunStatuses.Running;
    /// <summary>Why it stopped or was skipped: <c>depth</c>, <c>limit.rule</c>, <c>author.access</c>, a step's refusal code.</summary>
    public string? Reason { get; set; }
    /// <summary>JSON: each step's <c>{ index, path, kind, status, code?, detail? }</c> (Phase 17: <c>path</c>, its place inside branches and approvals; <c>index</c>, its place among every step).</summary>
    public string Steps { get; set; } = "[]";
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    /// <summary>Phase 17: the rule's definition when the run first waited; it goes on by it whatever the rule became.</summary>
    public string? Definition { get; set; }
    /// <summary>Phase 17: the path of the step it waits at (<c>2</c>, <c>2/0/1</c>).</summary>
    public string? Place { get; set; }
    /// <summary>Phase 17: <see cref="WaitKinds"/>.</summary>
    public string? WaitKind { get; set; }
    /// <summary>Phase 17: when the worker next looks at it (its time, its date, its limit, its deadline, or an hour on).</summary>
    public DateTimeOffset? WaitUntil { get; set; }
    /// <summary>Phase 17: when its current wait began (its limit counts from it).</summary>
    public DateTimeOffset? WaitedAt { get; set; }
    /// <summary>Phase 17: when the worker took it to go on; one taken and not put down after a while is taken again.</summary>
    public DateTimeOffset? TakenAt { get; set; }
    /// <summary>Phase 17: JSON, what later steps read: the last approval's <c>approver</c> (ids) and <c>comment</c>.</summary>
    public string? Context { get; set; }
}

public static class ApprovalAnswers
{
    public const string Approve = "approve";
    public const string Reject = "reject";
}

public static class ApprovalOutcomes
{
    public const string Approved = "approved";
    public const string Rejected = "rejected";
    public const string NoAnswer = "noAnswer";
    /// <summary>Its run stopped before it was decided (the rule switched off or deleted, its author's access lost, its row gone).</summary>
    public const string Stopped = "stopped";
}

/// <summary>Phase 17: one person asked by a run's approval step, and their answer.</summary>
public sealed class AutomationApproval : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid RunId { get; set; }
    public Guid AutomationId { get; set; }
    public Guid DatabaseId { get; set; }
    /// <summary>The row asked about; null for a schedule's run (the database's).</summary>
    public Guid? RowId { get; set; }
    /// <summary>The approval step's path in the run's definition.</summary>
    public string StepPath { get; set; } = "";
    public Guid UserId { get; set; }
    /// <summary><c>any</c> or <c>all</c>, as the step said.</summary>
    public string Mode { get; set; } = "any";
    /// <summary><see cref="ApprovalAnswers"/>, once answered.</summary>
    public string? Answer { get; set; }
    public string? Comment { get; set; }
    public DateTimeOffset? AnsweredAt { get; set; }
    public DateTimeOffset DeadlineAt { get; set; }
    /// <summary><see cref="ApprovalOutcomes"/>, once the run decided it (the same on every person's).</summary>
    public string? Outcome { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>An address a workspace's rules may call (owners and admins only).</summary>
public sealed class Webhook : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    /// <summary>The signing secret, as Data Protection's output (<c>Cgw.Automations.Webhook.v1</c>); shown once when made.</summary>
    public string SecretCipher { get; set; } = "";
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public static class DeliveryStatuses
{
    public const string Pending = "pending";
    public const string Delivered = "delivered";
    public const string Failed = "failed";
}

/// <summary>A webhook step's call: its body, its attempts and their outcome.</summary>
public sealed class WebhookDelivery : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid WebhookId { get; set; }
    public Guid RunId { get; set; }
    public int StepIndex { get; set; }
    public string Body { get; set; } = "{}";
    public int Attempts { get; set; }
    public DateTimeOffset NextAt { get; set; }
    public string Status { get; set; } = DeliveryStatuses.Pending;
    public int? LastStatus { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeliveredAt { get; set; }
}
