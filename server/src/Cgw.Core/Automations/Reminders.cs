using Cgw.Core.Data;
using Cgw.Core.Databases;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Automations;

/// <summary>A person's own reminder of a row's date: its property, how long before, and when it is next sent (null: the row has no date there).</summary>
public sealed record ReminderDto(string PropertyId, int BeforeMinutes, DateTimeOffset? DueAt);

public sealed record RowRemindersDto(IReadOnlyList<ReminderDto> Reminders);

public sealed record ReminderRequest(int BeforeMinutes);

/// <summary>
/// Phase 17, M17.2: people's own reminders of rows' dates (DATA_MODEL.md, Automations;
/// DECISIONS.md, 2026-11-25). Anyone who can read a row may set one for themselves on its date
/// properties: at the date's moment, or 15 minutes, an hour, a day or a week before; a day with no
/// time is reached at 09:00 in the workspace's zone. Its moment is kept with it (<see cref="RowReminder.DueAt"/>),
/// worked out again when the row's date changes (<see cref="PlaceAsync"/>, from the row's write) and
/// by the worker every 10 minutes; the worker sends it (<c>ReminderJob</c>).
/// </summary>
public sealed class ReminderService(CgwDb db, TimeProvider clock)
{
    /// <summary>How long before the date's moment a reminder may be sent, in minutes.</summary>
    public static readonly int[] Befores = [0, 15, 60, 1440, 10080];

    /// <summary>A person's reminders in a workspace at most.</summary>
    public const int MaxPerPerson = 10_000;

    private async Task<Page?> RowAsync(Guid databaseId, Guid rowId, CancellationToken ct) =>
        await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == rowId && p.ParentPageId == databaseId && p.Kind == PageKinds.Row
            && !p.IsTemplate && p.DeletedAt == null, ct);

    public async Task<Result<RowRemindersDto>> ForRowAsync(Member member, Guid databaseId, Guid rowId, CancellationToken ct)
    {
        if (await RowAsync(databaseId, rowId, ct) is null) return Failure.NotFound("No such row");
        return await ListAsync(member, rowId, ct);
    }

    private async Task<RowRemindersDto> ListAsync(Member member, Guid rowId, CancellationToken ct) =>
        new(await db.RowReminders.AsNoTracking().Where(r => r.UserId == member.UserId && r.RowId == rowId).OrderBy(r => r.PropertyId)
            .Select(r => new ReminderDto(r.PropertyId, r.BeforeMinutes, r.DueAt)).ToListAsync(ct));

    /// <summary>The person's reminder on a row's date property, made or changed.</summary>
    public async Task<Result<RowRemindersDto>> SetAsync(Member member, Guid databaseId, Guid rowId, string propertyId, ReminderRequest request, CancellationToken ct)
    {
        if (!Befores.Contains(request.BeforeMinutes)) return Failure.Invalid("A reminder is at the time, or 15 minutes, an hour, a day or a week before");
        if (await RowAsync(databaseId, rowId, ct) is not { } page) return Failure.NotFound("No such row");
        var record = await db.Databases.FirstOrDefaultAsync(d => d.PageId == databaseId, ct);
        if (record is null) return Failure.NotFound("No such row");
        var def = Schema.Parse(record.PageId, record.Version, record.Properties).Live(propertyId);
        if (def is not { Type: PropertyTypes.Date }) return Failure.Invalid("A reminder is of a date property");
        var reminder = await db.RowReminders.FirstOrDefaultAsync(r => r.UserId == member.UserId && r.RowId == rowId && r.PropertyId == def.Id, ct);
        var now = clock.GetUtcNow();
        if (reminder is null)
        {
            if (await db.RowReminders.CountAsync(r => r.UserId == member.UserId, ct) >= MaxPerPerson)
                return Failure.Invalid($"A person keeps at most {MaxPerPerson} reminders in a workspace");
            reminder = new RowReminder
            {
                Id = Guid.CreateVersion7(),
                WorkspaceId = member.WorkspaceId,
                DatabaseId = databaseId,
                RowId = page.Id,
                PropertyId = def.Id,
                UserId = member.UserId,
                CreatedAt = now,
            };
            db.RowReminders.Add(reminder);
        }
        else if (reminder.BeforeMinutes != request.BeforeMinutes) reminder.DueAt = null;
        reminder.BeforeMinutes = request.BeforeMinutes;
        var row = (await RowStore.ByIdsAsync(db, [rowId], ct)).FirstOrDefault();
        var zone = AutomationTimes.Zone(await db.Workspaces.AsNoTracking().Where(w => w.Id == member.WorkspaceId).Select(w => w.TimeZone).FirstOrDefaultAsync(ct));
        Place(reminder, row?.Values.GetValueOrDefault(def.Id), zone, now);
        await db.SaveChangesAsync(ct);
        await CountAsync(db, record, ct);
        await db.SaveChangesAsync(ct);
        return await ListAsync(member, rowId, ct);
    }

    public async Task<Result<RowRemindersDto>> DeleteAsync(Member member, Guid databaseId, Guid rowId, string propertyId, CancellationToken ct)
    {
        if (await RowAsync(databaseId, rowId, ct) is null) return Failure.NotFound("No such row");
        await db.RowReminders.Where(r => r.UserId == member.UserId && r.RowId == rowId && r.PropertyId == propertyId).ExecuteDeleteAsync(ct);
        if (await db.Databases.FirstOrDefaultAsync(d => d.PageId == databaseId, ct) is { } record)
        {
            await CountAsync(db, record, ct);
            await db.SaveChangesAsync(ct);
        }
        return await ListAsync(member, rowId, ct);
    }

    /// <summary>The database's count of reminders, so a write of its rows works their moments out only while it has any.</summary>
    private static async Task CountAsync(CgwDb db, WorkspaceDatabase record, CancellationToken ct) =>
        record.Reminders = await db.RowReminders.CountAsync(r => r.DatabaseId == record.PageId, ct);

    /// <summary>
    /// A reminder's moment from its row's value now: the date's moment (a day at 09:00 in the zone)
    /// less how long before. A moment that changed is sent anew; one already past when it is worked
    /// out is passed over, never sent late.
    /// </summary>
    public static void Place(RowReminder reminder, object? value, TimeZoneInfo zone, DateTimeOffset now)
    {
        var due = AutomationTimes.Due(Raw.Field(value, "start") as string, -reminder.BeforeMinutes, null, zone);
        if (due == reminder.DueAt) return;
        reminder.DueAt = due;
        reminder.SentFor = due is { } at && at <= now ? at : null;
    }

    /// <summary>
    /// The reminders of these rows worked out again (their date changed, their row went to the trash or
    /// came back, the property or the zone changed): a row gone or in the trash, or a property that is
    /// no longer a date, has none. In the rows' workspace's scope (the rows are read through it).
    /// </summary>
    public static async Task PlaceAsync(CgwDb db, IReadOnlyCollection<Guid> rowIds, DateTimeOffset now, CancellationToken ct)
    {
        if (rowIds.Count == 0) return;
        var reminders = new List<RowReminder>();
        foreach (var chunk in rowIds.Chunk(1000))
            reminders.AddRange(await db.RowReminders.Where(r => chunk.Contains(r.RowId)).ToListAsync(ct));
        if (reminders.Count == 0) return;
        var rows = (await RowStore.ByIdsAsync(db, reminders.Select(r => r.RowId).Distinct(), ct)).ToDictionary(r => r.Id);
        var databaseIds = reminders.Select(r => r.DatabaseId).Distinct().ToList();
        var schemas = (await db.Databases.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(d => databaseIds.Contains(d.PageId)).ToListAsync(ct))
            .ToDictionary(d => d.PageId, d => Schema.Parse(d.PageId, d.Version, d.Properties));
        var workspaceIds = reminders.Select(r => r.WorkspaceId).Distinct().ToList();
        var zones = (await db.Workspaces.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(w => workspaceIds.Contains(w.Id))
            .Select(w => new { w.Id, w.TimeZone }).ToListAsync(ct)).ToDictionary(w => w.Id, w => AutomationTimes.Zone(w.TimeZone));
        foreach (var reminder in reminders)
        {
            var row = rows.GetValueOrDefault(reminder.RowId);
            var def = schemas.GetValueOrDefault(reminder.DatabaseId)?.Live(reminder.PropertyId);
            var value = row is { Trashed: false } && def is { Type: PropertyTypes.Date } ? row.Values.GetValueOrDefault(reminder.PropertyId) : null;
            Place(reminder, value, zones.GetValueOrDefault(reminder.WorkspaceId, TimeZoneInfo.Utc), now);
        }
        await db.SaveChangesAsync(ct);
    }
}
