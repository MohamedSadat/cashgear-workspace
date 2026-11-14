namespace Cgw.Core;

/// <summary>
/// The stable error codes clients switch on (IMPLEMENTATION_PLAN.md, Phase 2, API contracts).
/// Every one has a test (ContractTests).
/// </summary>
public static class Codes
{
    public const string AuthRequired = "auth.required";
    public const string AccessDenied = "access.denied";
    public const string NotFound = "not.found";
    public const string VersionConflict = "version.conflict";
    public const string TreeCycle = "tree.cycle";
    public const string TreeParentMissing = "tree.parentMissing";
    public const string TreeSection = "tree.section";
    public const string DocEpochMismatch = "doc.epochMismatch";
    public const string ClientTooOld = "client.tooOld";
    public const string PageGone = "page.gone";
    /// <summary>The change feed no longer holds what came after the cursor: fetch the tree again.</summary>
    public const string FeedExpired = "feed.expired";
    /// <summary>An import over 50,000 rows or 20 MB (413).</summary>
    public const string DbTooLarge = "db.tooLarge";
    public const string LimitSize = "limit.size";
    public const string LimitRate = "limit.rate";
    public const string AssetTypeNotAllowed = "asset.typeNotAllowed";
    public const string RequestInvalid = "request.invalid";
    public const string Conflict = "conflict";
    public const string ServerError = "server.error";

    // Phase 5: Sheet's file sessions (sheet-session.1) and workbooks.

    /// <summary>A launch ticket unknown, used or expired (401); the three look the same.</summary>
    public const string TicketInvalid = "ticket.invalid";
    /// <summary>A file session ended, expired or unknown (401).</summary>
    public const string SessionExpired = "session.expired";
    /// <summary>A ticket redeemed from an <c>Origin</c> not on <c>Sheet__Origins</c> (403).</summary>
    public const string OriginDenied = "origin.denied";
    /// <summary>The session's workbook was trashed or deleted since the launch (410).</summary>
    public const string WorkbookGone = "workbook.gone";
    /// <summary>A save with neither <c>If-Match</c> nor <c>If-None-Match</c> (428).</summary>
    public const string VersionRequired = "version.required";

    /// <summary>Every code, for the contract test.</summary>
    public static readonly IReadOnlyList<string> All =
    [
        AuthRequired, AccessDenied, NotFound, VersionConflict, TreeCycle, TreeParentMissing,
        TreeSection, DocEpochMismatch, ClientTooOld, PageGone, FeedExpired, LimitSize, LimitRate,
        AssetTypeNotAllowed, RequestInvalid, Conflict, ServerError, DbTooLarge,
        TicketInvalid, SessionExpired, OriginDenied, WorkbookGone, VersionRequired,
    ];
}

/// <summary>An expected failure: a code, an HTTP status and a short English title.</summary>
public sealed record Failure(string Code, int Status, string Title)
{
    /// <summary>For a 429 or 503: when to ask again (the <c>Retry-After</c> header).</summary>
    public TimeSpan? RetryAfter { get; init; }

    /// <summary>Members of the problem body beside <c>code</c> (a 412's <c>current</c>, a 413's <c>limit</c>).</summary>
    public IReadOnlyDictionary<string, object?>? Extensions { get; init; }

    public static Failure NotFound(string what = "Not found") => new(Codes.NotFound, 404, what);
    public static Failure Denied(string why = "Access denied") => new(Codes.AccessDenied, 403, why);
    public static Failure Invalid(string why) => new(Codes.RequestInvalid, 400, why);
    public static Failure Conflict(string code, string why) => new(code, 409, why);
}

/// <summary>Services return this for expected failures instead of throwing (ARCHITECTURE.md).</summary>
public readonly struct Result<T>
{
    private Result(T? value, Failure? failure)
    {
        Value = value;
        Failure = failure;
    }

    public T? Value { get; }
    public Failure? Failure { get; }
    public bool Ok => Failure is null;

    public static Result<T> Success(T value) => new(value, null);

    public static implicit operator Result<T>(T value) => new(value, null);

    public static implicit operator Result<T>(Failure failure) => new(default, failure);
}
