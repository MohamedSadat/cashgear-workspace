using Cgw.Core;
using Cgw.Core.Automations;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Notifications;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Phase 17, M17.2: people's own reminders of rows' dates (<see cref="ReminderService"/>), sent to
/// the inbox (kind <c>reminder</c>; the mail job mails it by the person's setting) once their moment
/// has come: a thousand at a time in the order they are due, each once for its moment, and only while
/// the person can read the row and it is not in the trash. One whose moment passed more than a day ago
/// (the worker was stopped) is passed over. Every 10 minutes every reminder's moment is worked out
/// again, for what changed without a write of its row (the workspace's zone, the property's type).
/// </summary>
public sealed class ReminderJob(TimeProvider clock, ILogger<ReminderJob> logger) : IJob
{
    public string Name => "reminders";
    /// <summary>A reminder reaches the inbox within a minute of its time (the acceptance criterion): looked at every second.</summary>
    public TimeSpan Interval => TimeSpan.FromSeconds(1);
    public bool OwnLoop => true;

    public const int Batch = 1000;
    public static readonly TimeSpan Late = TimeSpan.FromDays(1);
    public static TimeSpan FullEvery { get; set; } = TimeSpan.FromMinutes(10);

    private DateTimeOffset nextFull = DateTimeOffset.MinValue;

    /// <summary>The reminders sent by the last pass, for the bench and the tests.</summary>
    public int LastSent { get; private set; }

    /// <summary>Works every reminder's moment out again at the next call (tests).</summary>
    public void FullNow() => nextFull = DateTimeOffset.MinValue;

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        if (now >= nextFull)
        {
            await PlaceAllAsync(db, now, ct);
            nextFull = now + FullEvery;
        }
        var due = await db.RowReminders.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(r => r.DueAt != null && r.DueAt <= now && (r.SentFor == null || r.SentFor != r.DueAt))
            .OrderBy(r => r.DueAt).Take(Batch).ToListAsync(ct);
        LastSent = 0;
        if (due.Count == 0) return false;
        foreach (var group in due.GroupBy(r => r.WorkspaceId))
        {
            try
            {
                LastSent += await SendAsync(services, db, group.Key, group.ToList(), now, ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogError(e, "Reminders of workspace {Workspace} failed", group.Key);
            }
        }
        return due.Count == Batch;
    }

    /// <summary>A workspace's reminders due: those the person may still have, sent with their feed changes; every one taken marked.</summary>
    private static async Task<int> SendAsync(IServiceProvider services, CgwDb db, Guid workspaceId, List<RowReminder> reminders, DateTimeOffset now, CancellationToken ct)
    {
        db.Scope.Switch(workspaceId);
        var rows = (await RowStore.ByIdsAsync(db, reminders.Select(r => r.RowId), ct)).ToDictionary(r => r.Id);
        var users = reminders.Select(r => r.UserId).Distinct().ToList();
        var members = (await db.WorkspaceMembers.AsNoTracking().Where(m => users.Contains(m.UserId))
            .Select(m => new Member(m.WorkspaceId, m.UserId, m.Role)).ToListAsync(ct)).ToDictionary(m => m.UserId);
        var access = new Access(db);
        var readable = new Dictionary<(Guid User, Guid Database), bool>();
        var notices = new List<Notification>();
        foreach (var reminder in reminders)
        {
            var at = reminder.DueAt!.Value;
            if (now - at > Late) continue;
            if (!rows.TryGetValue(reminder.RowId, out var row) || row.Trashed || row.IsTemplate) continue;
            if (!members.TryGetValue(reminder.UserId, out var member)) continue;
            if (!readable.TryGetValue((reminder.UserId, reminder.DatabaseId), out var can))
                readable[(reminder.UserId, reminder.DatabaseId)] = can = await access.PageLevelAsync(member, reminder.DatabaseId) != Levels.None;
            if (!can) continue;
            notices.Add(new Notification
            {
                Id = Guid.CreateVersion7(),
                WorkspaceId = workspaceId,
                UserId = reminder.UserId,
                Kind = NotificationKinds.Reminder,
                PageId = reminder.RowId,
                ActorUserId = reminder.UserId,
                Excerpt = "",
                DedupeKey = $"reminder:{reminder.Id:N}:{at.UtcTicks}",
                PropertyId = reminder.PropertyId,
                DateStart = Raw.Field(row.Values.GetValueOrDefault(reminder.PropertyId), "start") as string,
                CreatedAt = now,
            });
        }
        var changes = services.GetRequiredService<ChangeLog>();
        var ids = reminders.Select(r => r.Id).ToList();
        var sent = 0;
        var strategy = db.Database.CreateExecutionStrategy();
        await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(workspaceId, ct);
            sent = notices.Count == 0 ? 0 : (await NotificationService.AddAsync(db, changes, notices, ct)).Count;
            // Sent or passed over: each for the moment it had, unless its date moved on meanwhile.
            await db.RowReminders.Where(r => ids.Contains(r.Id) && r.DueAt <= now)
                .ExecuteUpdateAsync(s => s.SetProperty(r => r.SentFor, r => r.DueAt), ct);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        });
        db.ChangeTracker.Clear();
        return sent;
    }

    /// <summary>Every reminder's moment worked out again, a workspace at a time.</summary>
    private static async Task PlaceAllAsync(CgwDb db, DateTimeOffset now, CancellationToken ct)
    {
        var workspaces = await db.RowReminders.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Select(r => r.WorkspaceId).Distinct().ToListAsync(ct);
        foreach (var workspace in workspaces)
        {
            db.Scope.Switch(workspace);
            var rowIds = await db.RowReminders.AsNoTracking().Select(r => r.RowId).Distinct().ToListAsync(ct);
            foreach (var chunk in rowIds.Chunk(5000))
            {
                await ReminderService.PlaceAsync(db, chunk, now, ct);
                db.ChangeTracker.Clear();
            }
        }
    }
}
