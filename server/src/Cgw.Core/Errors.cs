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

    // Phase 6: comments.

    /// <summary>A comment's body or a thread's anchor that fails the rules (400).</summary>
    public const string CommentInvalid = "comment.invalid";

    // Phase 7: AI (INTEGRATIONS.md, AI, As agreed for 0.7.0).

    /// <summary>AI is off for the workspace, has no key, or is off on this server (403): nothing was sent.</summary>
    public const string AiDisabled = "ai.disabled";
    /// <summary>AI turned on with no key set (400).</summary>
    public const string AiKeyMissing = "ai.keyMissing";
    /// <summary>The provider refused the workspace's key, or it could not be read (502, or an event).</summary>
    public const string AiKeyInvalid = "ai.keyInvalid";
    /// <summary>The provider failed or could not be reached (502, or an event).</summary>
    public const string AiProvider = "ai.provider";
    /// <summary>The provider is busy or the key's own limit is reached (503, or an event).</summary>
    public const string AiLimit = "ai.limit";
    /// <summary>The model declined the request (an event only).</summary>
    public const string AiRefused = "ai.refused";

    // Phase 9: publishing.

    /// <summary>Another live site has the slug (409).</summary>
    public const string SlugTaken = "slug.taken";
    /// <summary>The workspace's publishing switch is off (403): nothing is published.</summary>
    public const string PublishingOff = "publishing.off";

    // Phase 10: plugins.

    /// <summary>A plugin's bundle refused (400), with <c>errors: [{code, path?}]</c>.</summary>
    public const string PluginInvalid = "plugin.invalid";
    /// <summary>A bundle of a lower version than the workspace's (400).</summary>
    public const string PluginOlder = "plugin.older";

    // Phase 11: single sign-on (M11.3).

    /// <summary>The domain is verified by another workspace (409).</summary>
    public const string SsoDomainTaken = "sso.domainTaken";
    /// <summary>The domain's <c>TXT</c> record is missing or holds another value (400).</summary>
    public const string SsoDnsNotFound = "sso.dnsNotFound";
    /// <summary>Sign-on required before an owner has signed in through the provider (400).</summary>
    public const string SsoNotTested = "sso.notTested";
    /// <summary>The issuer's discovery document could not be read or is not one the server can use (400).</summary>
    public const string SsoDiscoveryFailed = "sso.discoveryFailed";
    /// <summary>A password or passkey sign-in, or a sign-up, of a domain that requires its workspace's provider (403).</summary>
    public const string SsoRequired = "sso.required";
    /// <summary>The provider's answer was refused (the callback's page says why in words).</summary>
    public const string SsoFailed = "sso.failed";

    // Phase 12: chart views.

    /// <summary>
    /// A chart view read by a share link whose group's or measure's values may not leave (a person's,
    /// a formula of one, a rollup out of the scope) (403): its rows are not answered, as a site draws
    /// its placeholder.
    /// </summary>
    public const string ChartHidden = "chart.hidden";

    /// <summary>Every code, for the contract test.</summary>
    public static readonly IReadOnlyList<string> All =
    [
        AuthRequired, AccessDenied, NotFound, VersionConflict, TreeCycle, TreeParentMissing,
        TreeSection, DocEpochMismatch, ClientTooOld, PageGone, FeedExpired, LimitSize, LimitRate,
        AssetTypeNotAllowed, RequestInvalid, Conflict, ServerError, DbTooLarge,
        TicketInvalid, SessionExpired, OriginDenied, WorkbookGone, VersionRequired,
        CommentInvalid,
        AiDisabled, AiKeyMissing, AiKeyInvalid, AiProvider, AiLimit, AiRefused,
        SlugTaken, PublishingOff,
        PluginInvalid, PluginOlder,
        SsoDomainTaken, SsoDnsNotFound, SsoNotTested, SsoDiscoveryFailed, SsoRequired, SsoFailed,
        ChartHidden,
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
