using Cgw.Core.Data;
using Cgw.Core.Notifications;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Core.Automations;

/// <summary>
/// Phase 17: an approval as its inbox item shows it. <c>State</c> is <c>open</c> while its run waits
/// for it, else its outcome (<c>approved</c>, <c>rejected</c>, <c>noAnswer</c>, <c>stopped</c>);
/// <c>Answer</c> the person's own, if they gave one.
/// </summary>
public sealed record ApprovalDto(Guid Id, string State, string? Answer, string? Comment, string Mode, DateTimeOffset DeadlineAt, int Asked, int Answered);

public sealed record ApprovalAnswerRequest(string Answer, string? Comment);

/// <summary>
/// Phase 17: a person's answer to an approval a rule asked of them (DATA_MODEL.md, Automations):
/// once, while its run waits for it, by the person it was asked of while they can still read its
/// row. A decisive answer (the first for <c>any</c>; a rejection, or the last approval, for
/// <c>all</c>) wakes the run, which the worker takes on within a second.
/// </summary>
public sealed class ApprovalService(CgwDb db, ChangeLog changes, TimeProvider clock)
{
    public const string Open = "open";

    /// <summary>The approvals these inbox items name, as their recipients see them.</summary>
    public static async Task<Dictionary<Guid, ApprovalDto>> ForAsync(CgwDb db, IReadOnlyCollection<Guid> ids, CancellationToken ct)
    {
        if (ids.Count == 0) return [];
        var mine = await db.AutomationApprovals.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(a => ids.Contains(a.Id)).ToListAsync(ct);
        var runs = mine.Select(a => a.RunId).Distinct().ToList();
        var all = await db.AutomationApprovals.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(a => runs.Contains(a.RunId))
            .Select(a => new { a.RunId, a.StepPath, a.Answer }).ToListAsync(ct);
        var counts = all.GroupBy(a => (a.RunId, a.StepPath)).ToDictionary(g => g.Key, g => (Asked: g.Count(), Answered: g.Count(a => a.Answer != null)));
        return mine.ToDictionary(a => a.Id, a =>
        {
            var (asked, answered) = counts.GetValueOrDefault((a.RunId, a.StepPath));
            return new ApprovalDto(a.Id, a.Outcome ?? Open, a.Answer, a.Comment, a.Mode, a.DeadlineAt, asked, answered);
        });
    }

    public async Task<Result<ApprovalDto>> AnswerAsync(Guid userId, Guid approvalId, ApprovalAnswerRequest request, CancellationToken ct)
    {
        // Another's approval, or one the person cannot read, is not there for them, whatever they send.
        var approval = await db.AutomationApprovals.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(a => a.Id == approvalId && a.UserId == userId, ct);
        if (approval is null) return Failure.NotFound("No such approval");
        var memberships = await NotificationService.MembershipsAsync(db, userId, ct);
        if (!memberships.TryGetValue(approval.WorkspaceId, out var member)) return Failure.NotFound("No such approval");
        db.Scope.Switch(approval.WorkspaceId);
        // Never for a row the person can no longer read.
        if (await new Access(db).PageLevelAsync(member, approval.RowId ?? approval.DatabaseId) == Levels.None) return Failure.NotFound("No such approval");
        if (request.Answer is not (ApprovalAnswers.Approve or ApprovalAnswers.Reject)) return Failure.Invalid("An answer is approve or reject");
        var comment = string.IsNullOrWhiteSpace(request.Comment) ? null : request.Comment.Trim();
        if (comment is { Length: > AutomationRules.MaxComment }) return Failure.Invalid("A comment is at most 1,000 characters");
        var now = clock.GetUtcNow();
        var strategy = db.Database.CreateExecutionStrategy();
        var refused = await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(approval.WorkspaceId, ct);
            var tracked = await db.AutomationApprovals.FirstAsync(a => a.Id == approvalId, ct);
            var run = await db.AutomationRuns.FirstOrDefaultAsync(r => r.Id == tracked.RunId, ct);
            if (tracked.Outcome is not null || run is null || run.Status != RunStatuses.Waiting || run.Place != tracked.StepPath)
                return (Failure?)Failure.Conflict(Codes.ApprovalClosed, "This approval is no longer asked");
            if (tracked.Answer is not null) return Failure.Conflict(Codes.ApprovalAnswered, "You have answered this approval");
            tracked.Answer = request.Answer;
            tracked.Comment = comment;
            tracked.AnsweredAt = now;
            var others = await db.AutomationApprovals.AsNoTracking().Where(a => a.RunId == tracked.RunId && a.StepPath == tracked.StepPath && a.Id != tracked.Id)
                .Select(a => a.Answer).ToListAsync(ct);
            var decisive = tracked.Mode != "all" || tracked.Answer == ApprovalAnswers.Reject
                || others.All(a => a == ApprovalAnswers.Approve) || others.Any(a => a == ApprovalAnswers.Reject);
            // The worker goes on from it at its next look.
            if (decisive) run.WaitUntil = now;
            foreach (var n in await db.Notifications.Where(n => n.UserId == userId && n.ApprovalId == approvalId && n.ReadAt == null).ToListAsync(ct))
            {
                n.ReadAt = now;
                changes.Add("notification", n.Id, "upsert", 2, userId, userId);
            }
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
            return null;
        });
        db.ChangeTracker.Clear();
        if (refused is not null) return refused;
        return (await ForAsync(db, [approvalId], ct))[approvalId];
    }
}
