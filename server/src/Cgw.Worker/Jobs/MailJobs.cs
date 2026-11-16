using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Mail;
using Cgw.Core.Notifications;
using MailKit;
using MailKit.Net.Smtp;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Mail for mentions and replies (Phase 8, M8.5), step 1: for each person with mentions, comment
/// mentions or replies still unread after the delay, one queued mail (<see cref="MailOutbox"/>) that
/// the notifications name (<see cref="Notification.MailId"/>), at most one a person in each delay
/// (a digest: once a day). Mail off queues nothing; a notification made before mail was turned on
/// again, or older than <see cref="MailSettingsOptions.MaxAge"/>, is never mailed.
/// </summary>
public sealed class NotificationMailJob(MailSettingsOptions options, TimeProvider clock, ILogger<NotificationMailJob> logger) : IJob
{
    public string Name => "notificationMail";
    /// <summary>A quarter of the delay (15 s with a minute's), at most 30 s.</summary>
    public TimeSpan Interval => TimeSpan.FromSeconds(Math.Clamp(options.Delay.TotalSeconds / 4, 1, 30));
    private const int PeopleAPass = 200;
    private static readonly string[] Kinds = [NotificationKinds.Mention, NotificationKinds.CommentMention, NotificationKinds.Reply];

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        var due = now - options.Delay;
        var oldest = now - MailSettingsOptions.MaxAge;
        var kinds = Kinds;
        var (off, on, digest) = (MailModes.Off, MailModes.On, MailModes.Digest);
        var spaced = now - options.Delay;
        var daily = now - MailSettingsOptions.Digest;
        var settingsOf = db.MailSettings;
        // Only what may go now (so people with mail off, or waiting out their delay, never fill the
        // pass): the person's choice allows it, it came after mail was last turned on, and their
        // last mail is a delay ago (a digest: a day from the last one and from choosing it).
        var waiting = await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(n => n.ReadAt == null && n.MailId == null && n.EmailedAt == null && n.CreatedAt <= due && n.CreatedAt >= oldest && kinds.Contains(n.Kind))
            .Where(n => !settingsOf.Any(s => s.UserId == n.UserId && (s.Mode == off
                || (s.OnSince != null && n.CreatedAt <= s.OnSince)
                || (s.Mode == on && s.LastMailAt != null && s.LastMailAt > spaced)
                || (s.Mode == digest && ((s.LastMailAt != null && s.LastMailAt > daily) || s.UpdatedAt > daily)))))
            .OrderBy(n => n.CreatedAt).Take(5000)
            .Select(n => new { n.Id, n.UserId, n.CreatedAt })
            .ToListAsync(ct);
        var people = waiting.GroupBy(n => n.UserId).Take(PeopleAPass).ToList();
        if (people.Count == 0) return false;
        var ids = people.Select(p => p.Key).ToList();
        var alive = (await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id) && u.DeletedAt == null).Select(u => u.Id).ToListAsync(ct)).ToHashSet();
        var queued = 0;
        foreach (var person in people)
        {
            if (!alive.Contains(person.Key)) continue;
            db.ChangeTracker.Clear();
            var settings = await db.MailSettings.FirstOrDefaultAsync(s => s.UserId == person.Key, ct);
            var mode = settings?.Mode ?? MailModes.On;
            if (mode == MailModes.Off) continue;
            // At most one mail in each delay; a digest a day from the last one, or from choosing it.
            var last = mode == MailModes.Digest
                ? Max(settings?.LastMailAt, settings?.UpdatedAt)
                : settings?.LastMailAt;
            if (last is { } at && now - at < (mode == MailModes.Digest ? MailSettingsOptions.Digest : options.Delay)) continue;
            var notes = person.Where(n => settings?.OnSince is not { } since || n.CreatedAt > since).Select(n => n.Id).ToList();
            if (notes.Count == 0) continue;
            try
            {
                await QueueAsync(db, person.Key, settings, mode, notes, now, ct);
                queued++;
            }
            catch (DbUpdateException e)
            {
                // The person changed their settings at that moment: the next pass sees them.
                logger.LogInformation("A notification mail was left for the next pass: {Failure}", e.GetType().Name);
            }
        }
        return queued > 0 && people.Count == PeopleAPass;
    }

    private static DateTimeOffset? Max(DateTimeOffset? a, DateTimeOffset? b) => a is null ? b : b is null ? a : a > b ? a : b;

    private static async Task QueueAsync(CgwDb db, Guid userId, MailSettings? settings, string mode, List<Guid> notes, DateTimeOffset now, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var mail = new MailOutbox { Id = Guid.CreateVersion7(), UserId = userId, Kind = mode, CreatedAt = now, NextAttemptAt = now };
        db.MailOutbox.Add(mail);
        // The first mail makes the person's row: its stamp is in the unsubscribe link.
        if (settings is null) db.MailSettings.Add(new MailSettings { UserId = userId, Mode = MailModes.On, Stamp = Guid.NewGuid(), LastMailAt = now, UpdatedAt = now });
        else settings.LastMailAt = now;
        await db.SaveChangesAsync(ct);
        // Only those still unread and given to no other mail.
        var id = mail.Id;
        await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(n => notes.Contains(n.Id) && n.MailId == null && n.ReadAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(n => n.MailId, id), ct);
        await tx.CommitAsync(ct);
    }
}

/// <summary>
/// Mail for mentions and replies, step 2: each queued mail made and sent when its turn comes. Made
/// then, from what is true then: the person's settings (off sends nothing), each notification still
/// unread and on a page the person can still read (the inbox's rules); nothing left means nothing
/// sent. Under a daily cap (<see cref="MailSettingsOptions.DailyCap"/> in any 24 hours: what is over
/// waits); a failure is tried again after 1, 5 and 15 minutes, 1 and 4 hours, then given up. Logged
/// by kind and outcome only: never an address, a subject or a body. On a loop of its own, so a slow
/// mail server holds nothing else back. Ended mails are deleted after a week.
/// </summary>
public sealed class MailSendJob(Mailer mailer, MailTokens tokens, MailSettingsOptions options, TimeProvider clock, ILogger<MailSendJob> logger) : IJob
{
    public string Name => "mailSend";
    public TimeSpan Interval => TimeSpan.FromSeconds(Math.Clamp(options.Delay.TotalSeconds / 8, 1, 10));
    public bool OwnLoop => true;
    private const int Batch = 20;
    public const int MaxAttempts = 6;
    private static readonly TimeSpan[] Backoff = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(15), TimeSpan.FromHours(1), TimeSpan.FromHours(4)];
    private static readonly TimeSpan Kept = TimeSpan.FromDays(7);
    private long lastCleanup;
    private long lastCapWarning;

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        if (Environment.TickCount64 - Interlocked.Read(ref lastCleanup) > 3_600_000)
        {
            Interlocked.Exchange(ref lastCleanup, Environment.TickCount64);
            var before = now - Kept;
            await db.MailOutbox.Where(m => m.Outcome != null && m.EndedAt < before).ExecuteDeleteAsync(ct);
        }
        var day = now - TimeSpan.FromDays(1);
        var sent = await db.MailOutbox.CountAsync(m => m.SentAt != null && m.SentAt > day, ct);
        var room = options.DailyCap - sent;
        if (room <= 0)
        {
            if (Environment.TickCount64 - Interlocked.Read(ref lastCapWarning) > 3_600_000)
            {
                Interlocked.Exchange(ref lastCapWarning, Environment.TickCount64);
                logger.LogWarning("The daily mail cap ({Cap}) is reached: notification mail waits", options.DailyCap);
            }
            return false;
        }
        var due = await db.MailOutbox.Where(m => m.Outcome == null && m.NextAttemptAt <= now)
            .OrderBy(m => m.NextAttemptAt).Take(Math.Min(Batch, room)).ToListAsync(ct);
        foreach (var mail in due)
        {
            db.ChangeTracker.Clear();
            db.MailOutbox.Attach(mail);
            await SendAsync(db, mail, ct);
        }
        return due.Count == Batch && room > Batch;
    }

    public async Task SendAsync(CgwDb db, MailOutbox mail, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var user = await db.Users.AsNoTracking().Where(u => u.Id == mail.UserId)
            .Select(u => new { u.Id, u.Email, u.Locale, u.DeletedAt }).FirstOrDefaultAsync(ct);
        var settings = user is null ? null : await db.MailSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == user.Id, ct);
        if (user?.Email is not { Length: > 0 } address || user.DeletedAt is not null || settings is null || settings.Mode == MailModes.Off)
        {
            await EndAsync(db, mail, MailOutcomes.Off, now, ct);
            return;
        }
        var language = NotificationMails.Language(user.Locale);
        // What is still true now: unread, and on a page the person can read (the inbox's rules).
        var notes = await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(n => n.MailId == mail.Id && n.ReadAt == null).OrderBy(n => n.Seq).ToListAsync(ct);
        var memberships = await NotificationService.MembershipsAsync(db, user.Id, ct);
        var readable = await NotificationService.ReadableAsync(db, memberships, notes.Select(n => (n.WorkspaceId, n.PageId)), ct);
        notes = notes.Where(n => readable.Contains((n.WorkspaceId, n.PageId))).ToList();
        if (notes.Count == 0)
        {
            await EndAsync(db, mail, MailOutcomes.Skipped, now, ct);
            return;
        }
        var pageIds = notes.Select(n => n.PageId).Distinct().ToList();
        var titles = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(p => pageIds.Contains(p.Id))
            .ToDictionaryAsync(p => p.Id, p => p.Title, ct);
        var actorIds = notes.Select(n => n.ActorUserId).Distinct().ToList();
        var actors = await db.Users.AsNoTracking().Where(u => actorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => NotificationMails.ActorName(language, u.DisplayName, u.DeletedAt is not null), ct);
        var items = notes.Select(n => new MailItem(n.Kind, n.PageId, titles.GetValueOrDefault(n.PageId, ""), n.BlockId,
            actors.GetValueOrDefault(n.ActorUserId) ?? NotificationMails.ActorName(language, null, false), n.Excerpt)).ToList();
        var message = NotificationMails.Compose(address, user.Locale, mail.Kind, items, options.AppUrl,
            NotificationMails.UnsubscribeUrl(options.PublicUrl, tokens.For(user.Id, settings.Stamp)));
        mail.Attempts++;
        try
        {
            await mailer.SendAsync(message, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            mail.LastError = Describe(e);
            var spent = mail.Attempts >= MaxAttempts;
            if (spent)
            {
                mail.Outcome = MailOutcomes.Failed;
                mail.EndedAt = now;
            }
            else mail.NextAttemptAt = now + Backoff[Math.Min(mail.Attempts, Backoff.Length) - 1];
            await db.SaveChangesAsync(ct);
            logger.LogWarning("A notification mail was not sent (attempt {Attempt} of {Max}{Then}): {Failure}",
                mail.Attempts, MaxAttempts, spent ? ", given up" : "", mail.LastError);
            return;
        }
        mail.SentAt = now;
        mail.Outcome = MailOutcomes.Sent;
        mail.EndedAt = now;
        mail.LastError = null;
        await db.SaveChangesAsync(ct);
        var told = notes.Select(n => n.Id).ToList();
        await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).Where(n => told.Contains(n.Id))
            .ExecuteUpdateAsync(s => s.SetProperty(n => n.EmailedAt, now), ct);
        logger.LogInformation("A {Kind} notification mail was sent", mail.Kind == MailModes.Digest ? "digest" : "notification");
    }

    private static async Task EndAsync(CgwDb db, MailOutbox mail, string outcome, DateTimeOffset now, CancellationToken ct)
    {
        mail.Outcome = outcome;
        mail.EndedAt = now;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>What went wrong, without anything of the mail: the exception's type, and an SMTP status when there is one.</summary>
    public static string Describe(Exception e)
    {
        var kind = e.GetType().Name;
        var detail = e switch
        {
            SmtpCommandException command => $" {(int)command.StatusCode} {command.ErrorCode}",
            SmtpProtocolException => "",
            ServiceNotAuthenticatedException => "",
            _ => "",
        };
        var text = kind + detail;
        return text.Length > 200 ? text[..200] : text;
    }
}
