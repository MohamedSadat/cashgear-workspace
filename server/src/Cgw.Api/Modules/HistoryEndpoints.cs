using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Exports;
using Cgw.Core.History;
using Cgw.Core.Search;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Modules;

/// <summary>An export's requester, checked before any handler runs; anyone else gets 404.</summary>
public sealed record ExportAccess(Member Member, WorkspaceExport Export);

public sealed class ExportFilter(Access access, TenantScope scope, CgwDb db) : IEndpointFilter
{
    public const string Key = "cgw.export";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.UserId() is not { } userId) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
        if (!Guid.TryParse(http.Request.RouteValues["exportId"]?.ToString(), out var exportId)) return Problems.From(Failure.NotFound("No such export"));
        var export = await db.WorkspaceExports.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(e => e.Id == exportId);
        if (export is null || export.RequestedBy != userId || await access.MemberAsync(export.WorkspaceId, userId) is not { } member)
            return Problems.From(Failure.NotFound("No such export"));
        scope.Enter(export.WorkspaceId);
        http.Items[Key] = new ExportAccess(member, export);
        return await next(context);
    }
}

/// <summary>Search (M2.7), version history (M2.7) and workspace export (M2.8).</summary>
public static class HistoryEndpoints
{
    public static void MapHistory(this RouteGroupBuilder api)
    {
        var workspace = api.MapGroup("/workspaces/{workspaceId:guid}").RequireAuthorization().AddEndpointFilter<MemberFilter>();

        workspace.MapGet("/search", async Task<Results<Ok<SearchResultDto>, ProblemHttpResult>> (string? q, int? limit, string? cursor, SearchService search, HttpContext http) =>
            {
                var result = await search.SearchAsync(http.Member(), q, limit, cursor);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("search").WithTags("Search").RequireRateLimiting(RateLimits.Search);

        workspace.MapPost("/exports", async Task<Results<Ok<ExportDto>, ProblemHttpResult>> (ExportService exports, HttpContext http) =>
            {
                var result = await exports.RequestAsync(http.Member(), http.Actor());
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createExport").WithTags("Export").RequireRateLimiting(RateLimits.User);

        api.MapGroup("/exports/{exportId:guid}").WithTags("Export").RequireAuthorization().AddEndpointFilter<ExportFilter>()
            .MapGet("", async (ExportService exports, CgwDb db, HttpContext http) =>
            {
                var access = (ExportAccess)http.Items[ExportFilter.Key]!;
                var name = await db.Workspaces.AsNoTracking().Where(w => w.Id == access.Export.WorkspaceId).Select(w => w.Name).FirstAsync();
                return TypedResults.Ok(await exports.GetAsync(access.Export, name));
            })
            .WithName("getExport").RequireRateLimiting(RateLimits.User);

        var page = api.MapGroup("/pages/{pageId:guid}/versions").WithTags("History").RequireAuthorization().AddEndpointFilter<PageFilter>();

        page.MapGet("", async (VersionService versions, HttpContext http) =>
                TypedResults.Ok(await versions.ListAsync(http.PageAccess().Page)))
            .WithName("listVersions").RequireRateLimiting(RateLimits.User);

        page.MapPost("", async Task<Results<Ok<VersionDto>, ProblemHttpResult>> (NewVersion? body, VersionService versions, HttpContext http) =>
            {
                var access = http.PageAccess();
                if (!Levels.AtLeast(access.Level, Levels.Edit)) return Problems.From(Failure.Denied("Saving a version needs edit access"));
                var result = await versions.CreateAsync(access.Member, access.Page, body ?? new NewVersion(null, null));
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createVersion").RequireRateLimiting(RateLimits.User);

        page.MapGet("/{versionId:guid}", async Task<Results<Ok<VersionDetailDto>, ProblemHttpResult>> (Guid versionId, VersionService versions, HttpContext http) =>
            {
                var result = await versions.GetAsync(http.PageAccess().Page, versionId);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("getPageVersion").RequireRateLimiting(RateLimits.User);

        page.MapPost("/{versionId:guid}/restore", async Task<Results<Accepted<RestoreDto>, ProblemHttpResult>> (Guid versionId, RestoreRequest body, VersionService versions, HttpContext http) =>
            {
                var access = http.PageAccess();
                var result = await versions.RestoreAsync(access.Member, http.Actor(), access.Page, versionId, body);
                return result.Ok ? TypedResults.Accepted((string?)null, result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("restoreVersion").RequireRateLimiting(RateLimits.User);
    }
}
