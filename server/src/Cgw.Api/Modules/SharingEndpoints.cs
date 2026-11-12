using System.Globalization;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Assets;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Sharing;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

namespace Cgw.Api.Modules;

/// <summary>
/// Sharing (M2.6): a page's access list and its share links, for members with the right level;
/// and the three reads a share link allows, with no account, by its token in a header.
/// </summary>
public static class SharingEndpoints
{
    private static ProblemHttpResult Missing() => Problems.From(Failure.NotFound("No such page or link"));

    public static void MapSharing(this RouteGroupBuilder api)
    {
        var page = api.MapGroup("/pages/{pageId:guid}").WithTags("Sharing").RequireAuthorization().AddEndpointFilter<PageFilter>();

        page.MapGet("/permissions", async (SharingService sharing, HttpContext http) =>
            {
                var access = http.PageAccess();
                http.Response.Headers.ETag = $"\"{access.Page.Version}\"";
                return TypedResults.Ok(await sharing.PermissionsAsync(access.Page, access.Level));
            })
            .WithName("getPermissions").RequireRateLimiting(RateLimits.User);

        page.MapPut("/permissions", async Task<Results<Ok<PermissionsDto>, ProblemHttpResult>> (PermissionsUpdate body, SharingService sharing, HttpContext http) =>
            {
                var access = http.PageAccess();
                if (access.Level != Levels.Full) return Problems.From(Failure.Denied("Sharing this page needs full access"));
                long? ifVersion = null;
                var match = http.Request.Headers.IfMatch.ToString().Trim().Trim('"');
                if (match.Length > 0 && match != "*")
                {
                    if (!long.TryParse(match, NumberStyles.None, CultureInfo.InvariantCulture, out var version))
                        return Problems.Of(Codes.RequestInvalid, 400, "If-Match is the page's version from its ETag");
                    ifVersion = version;
                }
                var result = await sharing.SetAsync(access.Member, http.Actor(), access.Page, body, ifVersion);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("setPermissions").RequireRateLimiting(RateLimits.User);

        page.MapGet("/share-links", async Task<Results<Ok<List<ShareLinkDto>>, ProblemHttpResult>> (SharingService sharing, HttpContext http) =>
            {
                var access = http.PageAccess();
                if (access.Level != Levels.Full) return Problems.From(Failure.Denied("Share links need full access"));
                return TypedResults.Ok(await sharing.LinksAsync(access.Page));
            })
            .WithName("listShareLinks").RequireRateLimiting(RateLimits.User);

        page.MapPost("/share-links", async Task<Results<Ok<CreatedShareLink>, ProblemHttpResult>> (NewShareLink? body, SharingService sharing, HttpContext http) =>
            {
                var access = http.PageAccess();
                if (access.Level != Levels.Full) return Problems.From(Failure.Denied("Share links need full access"));
                var result = await sharing.CreateLinkAsync(access.Member, http.Actor(), access.Page, body ?? new NewShareLink(null));
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createShareLink").RequireRateLimiting(RateLimits.User);

        page.MapDelete("/share-links/{linkId:guid}", async Task<Results<NoContent, ProblemHttpResult>> (Guid linkId, SharingService sharing, HttpContext http) =>
            {
                var access = http.PageAccess();
                if (access.Level != Levels.Full) return Problems.From(Failure.Denied("Share links need full access"));
                var result = await sharing.RevokeLinkAsync(access.Member, http.Actor(), access.Page, linkId);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("revokeShareLink").RequireRateLimiting(RateLimits.User);

        // Reading by link: no account, the token in a header, limited per address.
        var shared = api.MapGroup("/shared").WithTags("Sharing").AllowAnonymous().RequireRateLimiting(RateLimits.Anonymous);

        shared.MapGet("", async Task<Results<Ok<SharedTreeDto>, ProblemHttpResult>> (
                [FromHeader(Name = SharedReader.Header)] string? shareToken, SharedReader reader) =>
            await reader.OpenAsync(shareToken) is { } scope ? TypedResults.Ok(SharedReader.Tree(scope)) : Missing())
            .WithName("getShared");

        // The worker's JSON, not the Yjs updates: those still hold text deleted since the last compaction.
        shared.MapGet("/pages/{pageId:guid}/json", async Task<Results<Ok<DocJsonResponse>, ProblemHttpResult>> (
                Guid pageId, [FromHeader(Name = SharedReader.Header)] string? shareToken, SharedReader reader) =>
            {
                if (await reader.OpenAsync(shareToken) is not { } scope) return Missing();
                return await reader.JsonAsync(scope, pageId) is { } json ? TypedResults.Ok(json) : Missing();
            })
            .WithName("getSharedDocJson");

        shared.MapGet("/assets/{assetId:guid}/url", async Task<Results<Ok<AssetUrlDto>, ProblemHttpResult>> (
                Guid assetId, [FromHeader(Name = SharedReader.Header)] string? shareToken, SharedReader reader) =>
            {
                if (await reader.OpenAsync(shareToken) is not { } scope) return Missing();
                return await reader.AssetUrlAsync(scope, assetId) is { } url ? TypedResults.Ok(url) : Problems.From(Failure.NotFound("No such file"));
            })
            .WithName("getSharedAssetUrl");
    }
}
