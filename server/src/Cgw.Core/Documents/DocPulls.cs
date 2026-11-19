using System.Text.Json.Serialization;

namespace Cgw.Core.Documents;

/// <summary>One page of a batch pull: its id and the cursor <c>GET /pages/{pageId}/doc?after=</c> takes.</summary>
public sealed record DocsPullPage(Guid PageId, long After);

/// <summary><c>POST /workspaces/{workspaceId}/docs/pull</c>: 1 to 100 distinct pages of the workspace.</summary>
public sealed record DocsPullRequest(IReadOnlyList<DocsPullPage> Pages);

/// <summary>
/// One page's answer: <c>status</c> 200 with <c>pull</c>, exactly what the single route answers for
/// that page and <c>after</c>; the single route's refusal, its status and <c>code</c> (404
/// <c>not.found</c>, 410 <c>page.gone</c>); or <c>status</c> 0 with <c>code</c> <c>deferred</c>: not
/// read in this answer (its size cap), ask again.
/// </summary>
public sealed record DocsPullItem
{
    public required Guid PageId { get; init; }
    public required int Status { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public PullResponse? Pull { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Code { get; init; }
}

/// <summary>A batch pull's answer: one item per page asked for, in the request's order.</summary>
public sealed record DocsPullAnswer(IReadOnlyList<DocsPullItem> Docs);

/// <summary>
/// The batch pull (Phase 12, M12.4): a pin of a database reads every row's document through it, so
/// pinning thousands stays inside the person's rate limit. Each page is checked as its own route
/// checks it (<see cref="PageGate"/>: the caller's membership, the page's level, a row's its
/// database's, decided once a database a request; 404 for a page of another workspace) and answered
/// as that route answers (<see cref="DocService"/>'s <c>PullAsync</c>, the same answer), one page's
/// refusal in its own item. At most <see cref="MaxBytes"/> of updates in an answer: the page that
/// would pass it and every page after it are deferred; a page whose updates alone pass it is
/// answered whole (paged by its own <c>more</c>) when nothing before it in the answer carries
/// updates, so the first page of a request always is.
/// </summary>
public sealed class DocPulls(PageGate gate, DocService docs)
{
    public const int MaxPages = 100;
    public const long MaxBytes = 8L * 1024 * 1024;
    /// <summary>The item code of a page not read in this answer.</summary>
    public const string Deferred = "deferred";

    public async Task<Result<DocsPullAnswer>> PullAsync(Member member, DocsPullRequest request, CancellationToken ct = default)
    {
        // A body without them binds as null whatever the type says.
        var pages = (IReadOnlyList<DocsPullPage>?)request?.Pages;
        if (pages is null || pages.Count == 0) return Failure.Invalid("Ask for at least one page");
        if (pages.Count > MaxPages) return Failure.Invalid($"Ask for at most {MaxPages} pages at once");
        if (pages.Any(p => p is null)) return Failure.Invalid("Every page is a page id and a cursor");
        if (pages.Select(p => p.PageId).Distinct().Count() != pages.Count) return Failure.Invalid("Each page is asked for once");

        var answered = new List<DocsPullItem>(pages.Count);
        // A row's level is its database's: decided once a database in this request.
        var rowLevels = new Dictionary<Guid, string>();
        long bytes = 0;
        var full = false;
        foreach (var asked in pages)
        {
            if (full || bytes > MaxBytes)
            {
                full = true;
                answered.Add(new DocsPullItem { PageId = asked.PageId, Status = 0, Code = Deferred });
                continue;
            }
            var opened = await gate.OpenInAsync(member.UserId, member.WorkspaceId, asked.PageId, rowLevels, ct);
            if (!opened.Ok)
            {
                answered.Add(new DocsPullItem { PageId = asked.PageId, Status = opened.Failure!.Status, Code = opened.Failure.Code });
                continue;
            }
            var access = opened.Value!;
            var pull = await docs.PullAsync(access.Member, access.Page, asked.After, ct);
            var size = pull.Updates.Sum(u => (long)u.Data.Length);
            if (bytes > 0 && bytes + size > MaxBytes)
            {
                full = true;
                answered.Add(new DocsPullItem { PageId = asked.PageId, Status = 0, Code = Deferred });
                continue;
            }
            bytes += size;
            answered.Add(new DocsPullItem { PageId = asked.PageId, Status = 200, Pull = pull });
        }
        return new DocsPullAnswer(answered);
    }
}
