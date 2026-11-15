using Cgw.Api.Infrastructure;
using Cgw.Core.Workbooks;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// <c>POST /pages/{pageId}/erp-commits</c> (INTEGRATIONS.md, <c>Commit</c> and <c>CommitStatus</c>):
/// the app records each real ERP commit attempt made from a page's ERP block in Workspace's audit,
/// without values. A page the caller cannot see is 404, as every page route answers.
/// </summary>
public static class ErpCommitEndpoints
{
    public static void MapErpCommits(this RouteGroupBuilder api)
    {
        api.MapGroup("/pages/{pageId:guid}/erp-commits").WithTags("ERP links")
            .RequireAuthorization().AddEndpointFilter<PageFilter>().RequireRateLimiting(RateLimits.User)
            .MapPost("", async Task<Results<NoContent, ProblemHttpResult>> (ErpCommitReport body, ErpCommitService commits, HttpContext http) =>
            {
                var result = await commits.RecordAsync(http.PageAccess(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("recordErpCommit")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16 * 1024));
    }
}
