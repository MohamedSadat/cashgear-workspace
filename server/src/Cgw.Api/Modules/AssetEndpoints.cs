using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Assets;
using Cgw.Core.Data;
using Cgw.Core.Previews;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Modules;

public sealed record AssetAccess(Member Member, Asset Asset);

/// <summary>Routes under <c>/assets/{assetId}</c>: membership in the asset's workspace first, as for pages.</summary>
public sealed class AssetFilter(Access access, TenantScope scope, CgwDb db) : IEndpointFilter
{
    public const string Key = "cgw.asset";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.UserId() is not { } userId) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
        if (!Guid.TryParse(http.Request.RouteValues["assetId"]?.ToString(), out var assetId)) return Problems.From(Failure.NotFound("No such file"));
        var workspace = await db.Assets.IgnoreQueryFilters([CgwDb.Tenant]).Where(a => a.Id == assetId).Select(a => (Guid?)a.WorkspaceId).FirstOrDefaultAsync();
        if (workspace is null || await access.MemberAsync(workspace.Value, userId) is not { } member) return Problems.From(Failure.NotFound("No such file"));
        scope.Enter(workspace.Value);
        var asset = await db.Assets.FirstAsync(a => a.Id == assetId);
        http.Items[Key] = new AssetAccess(member, asset);
        return await next(context);
    }
}

public static class AssetEndpoints
{
    private static AssetAccess AssetAccess(this HttpContext http) => (AssetAccess)http.Items[AssetFilter.Key]!;

    public static void MapAssets(this RouteGroupBuilder api)
    {
        var workspace = api.MapGroup("/workspaces/{workspaceId:guid}").WithTags("Assets").RequireAuthorization().AddEndpointFilter<MemberFilter>();

        workspace.MapPost("/assets", async Task<Results<Ok<AssetTicketDto>, ProblemHttpResult>> (NewAsset body, AssetService assets, HttpContext http) =>
            {
                var result = await assets.TicketAsync(http.Member(), body);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createAssetTicket").RequireRateLimiting(RateLimits.User);

        workspace.MapGet("/link-preview", async Task<Results<Ok<LinkPreviewDto>, ProblemHttpResult>> (string url, LinkPreviews previews, HttpContext http) =>
            {
                var result = await previews.GetAsync(http.Member(), url ?? "");
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("getLinkPreview").RequireRateLimiting(RateLimits.Preview);

        var one = api.MapGroup("/assets/{assetId:guid}").WithTags("Assets").RequireAuthorization().AddEndpointFilter<AssetFilter>();

        one.MapGet("", async Task<Results<Ok<AssetDto>, ProblemHttpResult>> (AssetService assets, HttpContext http) =>
            {
                var access = http.AssetAccess();
                return await assets.CanReadAsync(access.Member, access.Asset) ? TypedResults.Ok(AssetService.Dto(access.Asset)) : Problems.From(Failure.NotFound("No such file"));
            })
            .WithName("getAsset").RequireRateLimiting(RateLimits.User);

        one.MapPost("/complete", async Task<Results<Ok<AssetDto>, ProblemHttpResult>> (AssetService assets, HttpContext http) =>
            {
                var access = http.AssetAccess();
                var result = await assets.CompleteAsync(access.Member, access.Asset);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("completeAsset").RequireRateLimiting(RateLimits.User);

        one.MapGet("/url", async Task<Results<Ok<AssetUrlDto>, ProblemHttpResult>> (AssetService assets, HttpContext http) =>
            {
                var access = http.AssetAccess();
                var result = await assets.ReadUrlAsync(access.Member, access.Asset);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("getAssetUrl").RequireRateLimiting(RateLimits.User);
    }
}
