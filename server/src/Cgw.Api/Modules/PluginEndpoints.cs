using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Plugins;
using Cgw.Core.Search;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Phase 10: search by meaning, and a workspace's third-party plugins (decisions, 2026-11-18).
/// Signed-in members only; a share link reaches none of these.
/// </summary>
public static class PluginEndpoints
{
    public const string ZipType = "application/zip";

    public static void MapPlugins(this RouteGroupBuilder api)
    {
        var workspace = api.MapGroup("/workspaces/{workspaceId:guid}").RequireAuthorization().AddEndpointFilter<MemberFilter>();

        // The checks in the contract's order: a member (the filter's 404), not a guest (403), on
        // (403 ai.disabled), q (400), the key opens (502 ai.keyInvalid); provider failures 502 or 503.
        workspace.MapGet("/search/meaning", async Task<Results<Ok<MeaningResultDto>, ProblemHttpResult>> (string? q, int? limit, MeaningSearch meaning, HttpContext http) =>
            {
                var result = await meaning.SearchAsync(http.Member(), q, limit, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!.Result) : Problems.From(result.Failure!, http);
            })
            .WithName("searchByMeaning").WithTags("Search").RequireRateLimiting(RateLimits.Meaning)
            .ProducesProblem(400).ProducesProblem(403).ProducesProblem(502).ProducesProblem(503);

        var plugins = workspace.MapGroup("/plugins").WithTags("Plugins");

        plugins.MapGet("", async (PluginService service, HttpContext http) => TypedResults.Ok(await service.ListAsync(http.RequestAborted)))
            .WithName("listPlugins").RequireRateLimiting(RateLimits.User);

        // The zip as the body (application/zip, at most 5 MB): 201 for a new type, 200 for a new bundle of one already there.
        plugins.MapPost("", async Task<Results<Created<WorkspacePluginDto>, Ok<WorkspacePluginDto>, ProblemHttpResult>> (PluginService service, HttpContext http) =>
            {
                var member = http.Member();
                if (!member.IsAdmin) return Problems.From(Failure.Denied("Only an owner or admin adds a plugin"));
                var bytes = await WorkbookEndpoints.ReadBodyAsync(http.Request, PluginBundle.MaxZip, http.RequestAborted);
                if (bytes is null) return Problems.From(WorkbookEndpoints.TooLarge(PluginBundle.MaxZip, "A plugin's bundle is at most 5 MB"));
                var result = await service.AddAsync(member, http.Actor(), bytes, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                var (plugin, created) = result.Value;
                return created
                    ? TypedResults.Created($"/api/v1/workspaces/{member.WorkspaceId}/plugins/{plugin.Id}", plugin)
                    : TypedResults.Ok(plugin);
            })
            .WithMetadata(new DocumentedBody(ZipType))
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(PluginBundle.MaxZip + 64 * 1024))
            .ProducesProblem(400).ProducesProblem(403).ProducesProblem(409).ProducesProblem(413)
            .WithName("addPlugin").RequireRateLimiting(RateLimits.User);

        plugins.MapPatch("/{pluginId:guid}", async Task<Results<Ok<WorkspacePluginDto>, ProblemHttpResult>> (Guid pluginId, PluginPatch? body, PluginService service, HttpContext http) =>
            {
                var result = await service.PatchAsync(http.Member(), http.Actor(), pluginId, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updatePlugin").RequireRateLimiting(RateLimits.User);

        plugins.MapDelete("/{pluginId:guid}", async Task<Results<NoContent, ProblemHttpResult>> (Guid pluginId, PluginService service, HttpContext http) =>
            {
                var result = await service.RemoveAsync(http.Member(), http.Actor(), pluginId, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("removePlugin").RequireRateLimiting(RateLimits.User);

        plugins.MapPost("/{pluginId:guid}/frames", async Task<Results<Ok<PluginFrameDto>, ProblemHttpResult>> (Guid pluginId, PluginService service, HttpContext http) =>
            {
                var result = await service.FrameAsync(http.Member(), pluginId, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createPluginFrame").RequireRateLimiting(RateLimits.Frames);
    }
}
