using System.Globalization;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Sites;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Publishing (Phase 9, M9.1): a page's site (full on the page), and the workspace's switch (owners
/// and admins change it). The site itself is served by the Sites process on its own origin
/// (<c>Sites__PublicUrl</c>), never by this one.
/// </summary>
public static class PublishingEndpoints
{
    public static void MapPublishing(this RouteGroupBuilder api)
    {
        var page = api.MapGroup("/pages/{pageId:guid}/site").WithTags("Publishing").RequireAuthorization()
            .AddEndpointFilter<PageFilter>().RequireRateLimiting(RateLimits.User);

        page.MapGet("", async Task<Results<Ok<PageSiteDto>, ProblemHttpResult>> (PublishingService publishing, HttpContext http) =>
            {
                var access = http.PageAccess();
                if (access.Level != Levels.Full) return Problems.From(Failure.Denied("Publishing needs full access to the page"));
                var result = await publishing.PageAsync(access.Page, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                if (result.Value!.Site is { } site) http.Response.Headers.ETag = PublishingService.Etag(site.Version);
                return TypedResults.Ok(result.Value);
            })
            .WithName("getPageSite");

        page.MapPut("", async Task<Results<Ok<SiteDto>, ProblemHttpResult>> (SiteRequest body, PublishingService publishing, HttpContext http) =>
            {
                var access = http.PageAccess();
                long? ifVersion = null;
                var match = http.Request.Headers.IfMatch.ToString().Trim().Trim('"');
                if (match.Length > 0 && match != "*")
                {
                    if (!long.TryParse(match, NumberStyles.None, CultureInfo.InvariantCulture, out var version))
                        return Problems.Of(Codes.RequestInvalid, 400, "If-Match is the site's version from its ETag");
                    ifVersion = version;
                }
                var result = await publishing.PutAsync(access.Member, http.Actor(), access.Page, access.Level, body, ifVersion, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                http.Response.Headers.ETag = PublishingService.Etag(result.Value!.Version);
                return TypedResults.Ok(result.Value);
            })
            .WithName("publishPage");

        page.MapDelete("", async Task<Results<NoContent, ProblemHttpResult>> (PublishingService publishing, HttpContext http) =>
            {
                var access = http.PageAccess();
                var result = await publishing.DeleteAsync(access.Member, http.Actor(), access.Page, access.Level, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("unpublishPage");

        var workspace = api.MapGroup("/workspaces/{workspaceId:guid}/publishing").WithTags("Publishing").RequireAuthorization()
            .AddEndpointFilter<MemberFilter>().RequireRateLimiting(RateLimits.User);

        workspace.MapGet("", async (PublishingService publishing, HttpContext http) =>
                TypedResults.Ok(await publishing.WorkspaceAsync(http.Member(), http.RequestAborted)))
            .WithName("getPublishing");

        workspace.MapPut("", async Task<Results<Ok<PublishingDto>, ProblemHttpResult>> (PublishingUpdate body, PublishingService publishing, HttpContext http) =>
            {
                var result = await publishing.SetAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("setPublishing");
    }
}
