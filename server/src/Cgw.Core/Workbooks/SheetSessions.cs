using System.Security.Cryptography;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Workspaces;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workbooks;

public sealed record WorkbookLaunchDto(string Url, DateTimeOffset ExpiresAt);
public sealed record RedeemRequest(string? Ticket);
public sealed record WorkbookRefDto(Guid Id, string Name);

/// <summary>Redeem's answer (sheet-session.1 <c>FileSession</c>).</summary>
public sealed record FileSessionDto(
    string Token,
    DateTimeOffset ExpiresAt,
    DateTimeOffset MaxExpiresAt,
    WorkbookRefDto Workbook,
    string Access,
    UserRefDto User,
    string Language);

public sealed record SessionRenewDto(DateTimeOffset ExpiresAt);

/// <summary><c>GET …/workbook</c>: <c>readUrl</c>, <c>etag</c> and <c>size</c> all null with no version yet.</summary>
public sealed record SessionWorkbookDto(string? ReadUrl, string? Etag, string Name, long? Size);

public sealed record SessionVersionDto(Guid VersionId, string Etag);
public sealed record SessionCopyDto(WorkbookRefDto Workbook, string Access, Guid VersionId, string Etag);

/// <summary>A file session that passed this request's checks: its person, its workbook, their level now.</summary>
public sealed record OpenSession(FileSession Session, Member Member, Workbook Workbook, string Level);

/// <summary>
/// Sheet's file sessions (contract <c>sheet-session.1</c>; INTEGRATIONS.md, Opening the full
/// editor). The app asks for a launch ticket (256 random bits, 120 seconds, one use, kept as its
/// SHA-256, bound to the person, the workbook and the access); Sheet redeems it, from an origin on
/// <c>Sheet__Origins</c>, for an opaque token, 30 minutes idle and 10 hours at most. Every request
/// on a session checks again that its person is a member, its workbook is there and not in the
/// trash, and their level now; a save needs an <c>edit</c> session and edit access now.
/// </summary>
public sealed class SheetSessions(
    CgwDb db,
    TenantScope scope,
    Access access,
    WorkbookAccess levels,
    WorkbookService workbooks,
    BlobStore blob,
    Audit audit,
    TimeProvider clock,
    Integrations settings)
{
    public const string Header = "X-Workspace-File-Session";
    public const string Edit = "edit";
    public const string View = "view";

    public static readonly TimeSpan TicketLifetime = TimeSpan.FromSeconds(120);
    public static readonly TimeSpan IdleLifetime = TimeSpan.FromMinutes(30);
    public static readonly TimeSpan MaxLifetime = TimeSpan.FromHours(10);

    private static Failure TicketInvalid() => new(Codes.TicketInvalid, 401, "This link has expired or has already been used");
    public static Failure Expired() => new(Codes.SessionExpired, 401, "The file session has ended");

    /// <summary>256 random bits in base64url without padding: 43 characters.</summary>
    private static string NewToken() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    public static string LanguageOf(string? locale) => locale is { } l && l.StartsWith("ar", StringComparison.OrdinalIgnoreCase) ? "ar" : "en";

    public bool OriginAllowed(string? origin) => origin is { Length: > 0 } o && settings.SheetOrigins.Contains(o, StringComparer.Ordinal);

    /// <summary><c>POST /workbooks/{id}/launch</c>: a ticket for the caller, at the access their level gives now.</summary>
    public async Task<Result<WorkbookLaunchDto>> LaunchAsync(Member member, Workbook book, string level, CancellationToken ct = default)
    {
        if (book.TrashedAt is not null) return WorkbookService.Gone();
        if (WorkbookAccess.SessionAccess(level) is not { } sessionAccess) return Failure.NotFound("No such workbook");
        var ticket = NewToken();
        var now = clock.GetUtcNow();
        db.WorkbookTickets.Add(new WorkbookTicket
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            WorkbookId = book.Id,
            UserId = member.UserId,
            Access = sessionAccess,
            TokenHash = WorkspaceService.Hash(ticket),
            ExpiresAt = now + TicketLifetime,
            CreatedAt = now,
        });
        await db.SaveChangesAsync(ct);
        return new WorkbookLaunchDto(settings.LaunchUrl(ticket), now + TicketLifetime);
    }

    /// <summary>
    /// A ticket for a session (the route checks the <c>Origin</c> first, so a refused site cannot use
    /// a ticket up). Unknown, used and expired tickets look the same. The ticket is used up by the
    /// first request that marks it, race or not; then the workbook and the person's level now decide.
    /// </summary>
    public async Task<Result<FileSessionDto>> RedeemAsync(Actor actor, string? ticket, CancellationToken ct = default)
    {
        if (ticket is not { Length: > 0 }) return Failure.Invalid("ticket is required");
        if (ticket.Length > 200) return TicketInvalid();
        var hash = WorkspaceService.Hash(ticket);
        var now = clock.GetUtcNow();
        var tickets = db.WorkbookTickets.IgnoreQueryFilters([CgwDb.Tenant]);
        var row = await tickets.AsNoTracking().FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
        if (row is null || row.UsedAt is not null || row.ExpiresAt <= now) return TicketInvalid();
        if (await tickets.Where(t => t.Id == row.Id && t.UsedAt == null).ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), ct) != 1)
            return TicketInvalid();

        scope.Enter(row.WorkspaceId);
        if (await access.MemberAsync(row.WorkspaceId, row.UserId) is not { } member) return Failure.Denied("You no longer have access to this workbook");
        var book = await db.Workbooks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == row.WorkbookId, ct);
        if (book is null || book.TrashedAt is not null) return WorkbookService.Gone();
        if (WorkbookAccess.SessionAccess(await levels.LevelAsync(member, book, ct)) is not { } nowAccess) return Failure.Denied("You no longer have access to this workbook");
        var sessionAccess = row.Access == Edit && nowAccess == Edit ? Edit : View;
        var user = await db.Users.AsNoTracking().Where(u => u.Id == row.UserId).Select(u => new { u.DisplayName, u.Locale }).FirstAsync(ct);
        var language = LanguageOf(user.Locale);
        var token = NewToken();
        var session = new FileSession
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = row.WorkspaceId,
            UserId = row.UserId,
            WorkbookId = book.Id,
            Access = sessionAccess,
            TokenHash = WorkspaceService.Hash(token),
            Language = language,
            CreatedAt = now,
            IdleExpiresAt = now + IdleLifetime,
            MaxExpiresAt = now + MaxLifetime,
        };
        db.FileSessions.Add(session);
        audit.Add(actor with { UserId = row.UserId }, "workbook.session", row.WorkspaceId, "workbook", book.Id, new { sessionId = session.Id, access = sessionAccess });
        await db.SaveChangesAsync(ct);
        return new FileSessionDto(token, Expiry(session), session.MaxExpiresAt, new WorkbookRefDto(book.Id, book.Name), sessionAccess,
            new UserRefDto(row.UserId, user.DisplayName is { Length: > 0 } name ? name : "Someone"), language);
    }

    private static DateTimeOffset Expiry(FileSession session) => session.IdleExpiresAt < session.MaxExpiresAt ? session.IdleExpiresAt : session.MaxExpiresAt;

    /// <summary>The live session the token names, tracked; null when it is unknown, ended or expired.</summary>
    private async Task<FileSession?> FindAsync(string? token, CancellationToken ct)
    {
        if (token is not { Length: > 0 and <= 200 }) return null;
        var hash = WorkspaceService.Hash(token);
        var session = await db.FileSessions.IgnoreQueryFilters([CgwDb.Tenant]).FirstOrDefaultAsync(s => s.TokenHash == hash, ct);
        var now = clock.GetUtcNow();
        return session is null || session.EndedAt is not null || now >= session.IdleExpiresAt || now >= session.MaxExpiresAt ? null : session;
    }

    /// <summary>Every check a session's request passes before it acts: the session, its person, its workbook, their level now.</summary>
    public async Task<Result<OpenSession>> OpenAsync(string? token, CancellationToken ct = default)
    {
        if (await FindAsync(token, ct) is not { } session) return Expired();
        scope.Enter(session.WorkspaceId);
        if (await access.MemberAsync(session.WorkspaceId, session.UserId) is not { } member) return Failure.Denied("You no longer have access to this workbook");
        var book = await db.Workbooks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == session.WorkbookId, ct);
        if (book is null || book.TrashedAt is not null) return WorkbookService.Gone();
        var level = await levels.LevelAsync(member, book, ct);
        if (level == Levels.None) return Failure.Denied("You no longer have access to this workbook");
        return new OpenSession(session, member, book, level);
    }

    /// <summary>Slides the idle expiry by 30 minutes, never past the session's maximum.</summary>
    public async Task<Result<SessionRenewDto>> RenewAsync(OpenSession open, CancellationToken ct = default)
    {
        var session = open.Session;
        var idle = clock.GetUtcNow() + IdleLifetime;
        session.IdleExpiresAt = idle < session.MaxExpiresAt ? idle : session.MaxExpiresAt;
        session.Renews++;
        await db.SaveChangesAsync(ct);
        return new SessionRenewDto(Expiry(session));
    }

    /// <summary>Ends a live session; its workbook and access are not asked about (an end always helps).</summary>
    public async Task<Result<bool>> EndAsync(string? token, CancellationToken ct = default)
    {
        if (await FindAsync(token, ct) is not { } session) return Expired();
        session.EndedAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<SessionWorkbookDto> WorkbookAsync(OpenSession open, CancellationToken ct = default)
    {
        if (await workbooks.CurrentAsync(open.Workbook.Id, ct) is not { } version) return new SessionWorkbookDto(null, null, open.Workbook.Name, null);
        var url = await blob.ReadUrlAsync(version.BlobKey, ct: ct);
        return new SessionWorkbookDto(url.ToString(), WorkbookService.Etag(version.Id), open.Workbook.Name, version.SizeBytes);
    }

    /// <summary>Whether the session may save now: an <c>edit</c> session and edit access now.</summary>
    public static bool MaySave(OpenSession open) => open.Session.Access == Edit && Levels.AtLeast(open.Level, Levels.Edit);

    public async Task<Result<SessionVersionDto>> SaveAsync(Actor actor, OpenSession open, byte[] bytes, SavePrecondition condition, CancellationToken ct = default)
    {
        if (!MaySave(open)) return Failure.Denied("This session may not save the workbook");
        var saved = await workbooks.SaveAsync(actor with { UserId = open.Member.UserId }, open.Workbook.Id, open.Member.UserId, bytes, condition, ct);
        if (!saved.Ok) return saved.Failure!;
        return new SessionVersionDto(saved.Value!.Id, WorkbookService.Etag(saved.Value.Id));
    }

    /// <summary>"Save a copy": a new workbook beside the session's, to which the session moves, with the copy's access.</summary>
    public async Task<Result<SessionCopyDto>> CopyAsync(Actor actor, OpenSession open, byte[] bytes, CancellationToken ct = default)
    {
        var copy = await workbooks.CopyAsync(open.Member, actor with { UserId = open.Member.UserId }, open.Workbook, open.Session.Language, bytes, ct);
        if (!copy.Ok) return copy.Failure!;
        var (book, version, level) = copy.Value;
        var session = open.Session;
        session.WorkbookId = book.Id;
        session.Access = WorkbookAccess.SessionAccess(level) ?? View;
        await db.SaveChangesAsync(ct);
        return new SessionCopyDto(new WorkbookRefDto(book.Id, book.Name), session.Access, version.Id, WorkbookService.Etag(version.Id));
    }
}
