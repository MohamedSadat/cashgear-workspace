using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Unicode;
using Cgw.Core.Data;
using Cgw.Core.Mail;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Notifications;

/// <summary>A person's mail choice: <c>on</c> (the default), <c>digest</c> or <c>off</c>.</summary>
public sealed record NotificationSettingsDto(string Email);

public sealed record UnsubscribeRequest(string? Token);

/// <summary>
/// Mail for mentions and replies (Phase 8, M8.5), its settings and timing. A notification is mailed
/// once it has been unread for the delay (<c>Mail__NotificationDelaySeconds</c>, 15 minutes), at
/// most one mail a person in each delay (a digest: one a day), in pieces of the inbox's
/// (<see cref="NotificationKinds"/>); never one older than <see cref="MaxAge"/> or made before mail
/// was turned on again. Sent from the database queue (<see cref="MailOutbox"/>) with retries under a
/// daily cap below the SMTP account's (<c>Mail__DailyCap</c>, 1,500: Google Workspace allows 2,000
/// a day, and the account mails go through it too).
/// </summary>
public sealed class MailSettingsOptions(IConfiguration configuration)
{
    public TimeSpan Delay { get; } = TimeSpan.FromSeconds(Read(configuration, "Mail:NotificationDelaySeconds", 15 * 60));
    public int DailyCap { get; } = Read(configuration, "Mail:DailyCap", 1500);
    public static readonly TimeSpan Digest = TimeSpan.FromDays(1);
    /// <summary>A notification older than this when its turn comes is no news: it is not mailed.</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(3);

    /// <summary>The web app's origin, where a mail's links open the page (<c>Web__AppUrl</c>).</summary>
    public string AppUrl { get; } = (configuration["Web:AppUrl"] ?? "http://127.0.0.1:5273").TrimEnd('/');

    /// <summary>The API's public origin, where the unsubscribe link goes (<c>Api__PublicUrl</c>).</summary>
    public string PublicUrl { get; } = (configuration["Api:PublicUrl"] ?? "http://127.0.0.1:5280").TrimEnd('/');

    private static int Read(IConfiguration configuration, string key, int fallback) =>
        int.TryParse(configuration[key], NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) && value >= 0 ? value : fallback;
}

/// <summary>
/// The unsubscribe token in every notification mail (Data Protection, purpose
/// <c>Cgw.Mail.Unsubscribe.v1</c>): the account's id and its <see cref="MailSettings.Stamp"/>. It has
/// no expiry; a new stamp voids every token made before it. Anything else (forged, cut, another
/// purpose's) reads as nothing.
/// </summary>
public sealed class MailTokens(IDataProtectionProvider protection)
{
    private readonly IDataProtector protector = protection.CreateProtector("Cgw.Mail.Unsubscribe.v1");

    public string For(Guid userId, Guid stamp)
    {
        var payload = new byte[32];
        GuidBytes.ToBytes(userId).CopyTo(payload, 0);
        GuidBytes.ToBytes(stamp).CopyTo(payload, 16);
        return WebEncoders.Base64UrlEncode(protector.Protect(payload));
    }

    public (Guid UserId, Guid Stamp)? Read(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 1000) return null;
        try
        {
            var payload = protector.Unprotect(WebEncoders.Base64UrlDecode(token));
            if (payload.Length != 32) return null;
            return (GuidBytes.FromBytes(payload[..16]), GuidBytes.FromBytes(payload[16..]));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null;
        }
    }
}

/// <summary>The account's mail choice (the settings routes) and turning it off from a mail.</summary>
public sealed class MailSettingsService(CgwDb db, MailTokens tokens, TimeProvider clock)
{
    public async Task<NotificationSettingsDto> GetAsync(Guid userId, CancellationToken ct = default) =>
        new(await db.MailSettings.AsNoTracking().Where(s => s.UserId == userId).Select(s => s.Mode).FirstOrDefaultAsync(ct) ?? MailModes.On);

    /// <summary>
    /// Sets the choice. Turning mail on again after it was off gives the account a new stamp (the
    /// links in mails sent before no longer turn it off) and mails nothing made before now.
    /// </summary>
    public async Task<Result<NotificationSettingsDto>> SetAsync(Guid userId, string? mode, CancellationToken ct = default)
    {
        if (!MailModes.Known(mode)) return Failure.Invalid("email is on, digest or off");
        for (var attempt = 1; ; attempt++)
        {
            var row = await db.MailSettings.FirstOrDefaultAsync(s => s.UserId == userId, ct);
            var now = clock.GetUtcNow();
            if (row is null) db.MailSettings.Add(row = new MailSettings { UserId = userId, Mode = MailModes.On, Stamp = Guid.NewGuid(), UpdatedAt = now });
            if (row.Mode == MailModes.Off && mode != MailModes.Off)
            {
                row.Stamp = Guid.NewGuid();
                row.OnSince = now;
            }
            row.Mode = mode!;
            row.UpdatedAt = now;
            try
            {
                await db.SaveChangesAsync(ct);
                return new NotificationSettingsDto(row.Mode);
            }
            catch (DbUpdateException) when (attempt < 3)
            {
                // The worker made the row meanwhile (its first mail): read it again.
                db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>
    /// A mail's one click: mail off for the account the token names, if its stamp is the account's
    /// now. Whatever the token, the caller is answered the same.
    /// </summary>
    public async Task UnsubscribeAsync(string? token, CancellationToken ct = default)
    {
        if (tokens.Read(token) is not { } named) return;
        var (userId, stamp) = named;
        var now = clock.GetUtcNow();
        await db.MailSettings.Where(s => s.UserId == userId && s.Stamp == stamp && s.Mode != MailModes.Off)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.Mode, MailModes.Off).SetProperty(x => x.UpdatedAt, now), ct);
    }
}

/// <summary>One notification as a mail tells it.</summary>
/// <summary>Phase 15: <paramref name="Reason"/> is a stopped run's (kind <c>automation</c>); null for a rule's notice.</summary>
public sealed record MailItem(string Kind, Guid PageId, string PageTitle, string? BlockId, string Actor, string Excerpt, string? Reason = null);

/// <summary>
/// A notification mail's words, in English or Arabic (the person's <see cref="User.Locale"/>), as a
/// plain-text part and an HTML part whose <c>dir</c> follows the language. Names and titles are the
/// person's to read (each notification was checked again just before); excerpts are the inbox's
/// (plain text, mentions as <c>@</c>, at most 200 units).
/// </summary>
public static class NotificationMails
{
    /// <summary>HTML-encodes markup only: Arabic stays as it is.</summary>
    private static readonly HtmlEncoder Encoder = HtmlEncoder.Create(UnicodeRanges.All);

    private static string E(string text) => Encoder.Encode(text);

    private sealed record Words(
        string Untitled, string Deleted, string Someone,
        Func<string, string, string> Mention, Func<string, string, string> CommentMention, Func<string, string, string> Reply,
        Func<string, string, string> Automation, Func<string, string> AutomationStopped,
        Func<string, string, string> Approval, Func<string, string> Reminder,
        Func<int, string> Several, Func<int, string> Digest, string Intro, string DigestIntro, string Open,
        string Why, string Off, string Settings);

    private static readonly Words En = new(
        "Untitled", "Deleted user", "Someone",
        (actor, page) => $"{actor} mentioned you in “{page}”",
        (actor, page) => $"{actor} mentioned you in a comment on “{page}”",
        (actor, page) => $"{actor} replied in a thread on “{page}”",
        (actor, page) => $"{actor}'s automation on “{page}”",
        page => $"Your automation on “{page}” stopped",
        (actor, page) => $"{actor}'s automation asks for your approval on “{page}”",
        page => $"A reminder of “{page}”",
        n => string.Create(CultureInfo.InvariantCulture, $"{n} new mentions and replies in Cash Gear Workspace"),
        n => string.Create(CultureInfo.InvariantCulture, $"Your daily summary: {n} mentions and replies"),
        "While you were away:",
        "Since your last summary:",
        "Open",
        "You get these mails for mentions and replies you have not read in Cash Gear Workspace.",
        "Turn off these mails",
        "or choose a daily summary in the app's Settings.");

    private static readonly Words Ar = new(
        "بدون عنوان", "مستخدم محذوف", "شخص ما",
        (actor, page) => $"أشار إليك {actor} في «{page}»",
        (actor, page) => $"أشار إليك {actor} في تعليق على «{page}»",
        (actor, page) => $"ردّ {actor} في نقاش على «{page}»",
        (actor, page) => $"أتمتة {actor} على «{page}»",
        page => $"توقفت أتمتتك على «{page}»",
        (actor, page) => $"تطلب أتمتة {actor} موافقتك على «{page}»",
        page => $"تذكير بـ«{page}»",
        n => string.Create(CultureInfo.InvariantCulture, $"إشارات وردود جديدة في مساحة عمل كاش جير: {n}"),
        n => string.Create(CultureInfo.InvariantCulture, $"ملخصك اليومي من مساحة عمل كاش جير: {n}"),
        "أثناء غيابك:",
        "منذ ملخصك الأخير:",
        "فتح",
        "تصلك هذه الرسائل عن الإشارات والردود التي لم تقرأها في مساحة عمل كاش جير.",
        "إيقاف هذه الرسائل",
        "أو اختر ملخصًا يوميًا من إعدادات التطبيق.");

    public static string Language(string? locale) => locale is { } l && l.StartsWith("ar", StringComparison.OrdinalIgnoreCase) ? "ar" : "en";

    /// <summary>An actor's name in the mail's language: "Deleted user" and "Someone" are words, not names.</summary>
    public static string ActorName(string language, string? displayName, bool deleted)
    {
        var words = language == "ar" ? Ar : En;
        return deleted ? words.Deleted : displayName is { Length: > 0 } name ? name : words.Someone;
    }

    /// <summary>The page and block a notification opens in the web app (its routes: <c>#/p/{page}/{block}</c>).</summary>
    public static string Link(string appUrl, Guid pageId, string? blockId) =>
        $"{appUrl}/#/p/{pageId}" + (blockId is { Length: 12 } block && block.All(char.IsAsciiLetterOrDigit) ? $"/{block}" : "");

    /// <summary>The page the unsubscribe link opens (a button, then off); One-Click posts to it.</summary>
    public static string UnsubscribeUrl(string publicUrl, string token) => $"{publicUrl}/mail/unsubscribe?token={Uri.EscapeDataString(token)}";

    /// <summary>
    /// A name or a title on one line: each run of control characters (line breaks among them) and
    /// line or paragraph separators made one space, so nothing a person wrote can end the Subject
    /// header and start another, whatever the mail library does with it.
    /// </summary>
    public static string OneLine(string text) =>
        System.Text.RegularExpressions.Regex.Replace(text, @"[\p{Cc}\p{Zl}\p{Zp}]+", " ").Trim();

    public static MailMessage Compose(string to, string? locale, string kind, IReadOnlyList<MailItem> items, string appUrl, string unsubscribeUrl)
    {
        var language = Language(locale);
        var words = language == "ar" ? Ar : En;
        var dir = language == "ar" ? "rtl" : "ltr";
        string Title(MailItem item) => OneLine(item.PageTitle) is { Length: > 0 } title ? title : words.Untitled;
        string Line(MailItem item) => item.Kind switch
        {
            NotificationKinds.CommentMention => words.CommentMention(OneLine(item.Actor), Title(item)),
            NotificationKinds.Reply => words.Reply(OneLine(item.Actor), Title(item)),
            NotificationKinds.Automation when item.Reason is not null => words.AutomationStopped(Title(item)),
            NotificationKinds.Automation => words.Automation(OneLine(item.Actor), Title(item)),
            NotificationKinds.Approval => words.Approval(OneLine(item.Actor), Title(item)),
            NotificationKinds.Reminder => words.Reminder(Title(item)),
            _ => words.Mention(OneLine(item.Actor), Title(item)),
        };
        string HtmlLine(MailItem item)
        {
            // The name and the title isolated, so each reads in its own direction inside the sentence.
            var actor = $"<bdi>{E(OneLine(item.Actor))}</bdi>";
            var title = $"<bdi>{E(Title(item))}</bdi>";
            const string A = "CgwActorSlot", T = "CgwTitleSlot";
            var sentence = item.Kind switch
            {
                NotificationKinds.CommentMention => words.CommentMention(A, T),
                NotificationKinds.Reply => words.Reply(A, T),
                NotificationKinds.Automation when item.Reason is not null => words.AutomationStopped(T),
                NotificationKinds.Automation => words.Automation(A, T),
                NotificationKinds.Approval => words.Approval(A, T),
                NotificationKinds.Reminder => words.Reminder(T),
                _ => words.Mention(A, T),
            };
            // One pass, so nothing in a name or a title is read as a slot.
            return System.Text.RegularExpressions.Regex.Replace(E(sentence), $"{A}|{T}", m => m.Value == A ? actor : title);
        }

        var subject = kind == MailModes.Digest ? words.Digest(items.Count) : items.Count == 1 ? Line(items[0]) : words.Several(items.Count);
        var personal = $"{unsubscribeUrl}&lang={language}";
        var text = new StringBuilder();
        text.Append(kind == MailModes.Digest ? words.DigestIntro : words.Intro).Append("\n\n");
        foreach (var item in items)
        {
            text.Append(Line(item)).Append('\n');
            if (item.Excerpt.Length > 0) text.Append("> ").Append(item.Excerpt).Append('\n');
            text.Append(Link(appUrl, item.PageId, item.BlockId)).Append("\n\n");
        }
        text.Append(words.Why).Append('\n').Append(words.Off).Append(": ").Append(personal).Append('\n').Append(words.Settings).Append('\n');

        var html = new StringBuilder();
        html.Append($"""<!doctype html><html lang="{language}" dir="{dir}"><head><meta charset="utf-8"></head><body style="font-family:system-ui,'Segoe UI',Tahoma,sans-serif;color:#1b1d21">""");
        html.Append($"<p>{E(kind == MailModes.Digest ? words.DigestIntro : words.Intro)}</p>");
        foreach (var item in items)
        {
            html.Append($"""<div style="margin:0 0 1.25em"><p style="margin:0 0 .25em;font-weight:600">{HtmlLine(item)}</p>""");
            if (item.Excerpt.Length > 0)
                html.Append($"""<p dir="auto" style="margin:0 0 .25em;color:#4a4f57;border-inline-start:3px solid #d5d9e0;padding-inline-start:.75em">{E(item.Excerpt)}</p>""");
            html.Append($"""<p style="margin:0"><a href="{E(Link(appUrl, item.PageId, item.BlockId))}">{E(words.Open)}</a></p></div>""");
        }
        html.Append($"""<p style="color:#5b616b;font-size:.9em">{E(words.Why)} <a href="{E(personal)}">{E(words.Off)}</a> {E(words.Settings)}</p></body></html>""");

        return new MailMessage(to, subject, text.ToString(), html.ToString())
        {
            // RFC 2369 and RFC 8058: one click in the mail client turns the mail off, without signing in.
            Headers =
            [
                new("List-Unsubscribe", $"<{unsubscribeUrl}>"),
                new("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
                new("Auto-Submitted", "auto-generated"),
            ],
        };
    }
}
