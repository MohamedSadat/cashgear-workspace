using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Modules;

/// <summary>A page route's caller: their membership, the page, and their level on it.</summary>
public sealed record PageAccess(Member Member, Page Page, string Level);

/// <summary>
/// Routes under <c>/pages/{pageId}</c>: the page's workspace is found, the caller's membership in
/// it checked and the tenant scope entered before any handler runs. A page the caller may not see
/// is 404, as if it did not exist; a page deleted for good is 410, to those who could see it.
/// </summary>
public sealed class PageFilter(Access access, TenantScope scope, CgwDb db) : IEndpointFilter
{
    public const string Key = "cgw.page";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.UserId() is not { } userId) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
        if (!Guid.TryParse(http.Request.RouteValues["pageId"]?.ToString(), out var pageId)) return Problems.From(Failure.NotFound("No such page"));
        var page = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(p => p.Id == pageId);
        if (page is null || await access.MemberAsync(page.WorkspaceId, userId) is not { } member) return Problems.From(Failure.NotFound("No such page"));
        scope.Enter(page.WorkspaceId);
        // The level first: that a page was deleted is said only to those who could see it.
        var level = page.DeletedAt is null ? await access.PageLevelAsync(member, page.Id) : await access.DeletedLevelAsync(member, page);
        if (level == Levels.None) return Problems.From(Failure.NotFound("No such page"));
        if (page.DeletedAt is not null) return Problems.Of(Codes.PageGone, 410, "The page was deleted for good");
        http.Items[Key] = new PageAccess(member, page, level);
        return await next(context);
    }
}

public static class DocEndpoints
{
    public static PageAccess PageAccess(this HttpContext http) => (PageAccess)http.Items[PageFilter.Key]!;

    public static void MapDocs(this RouteGroupBuilder api)
    {
        var page = api.MapGroup("/pages/{pageId:guid}").WithTags("Documents").RequireAuthorization().AddEndpointFilter<PageFilter>();

        page.MapPost("/doc/updates", async Task<Results<Ok<PushResponse>, ProblemHttpResult>> (PushRequest body, DocService docs, HttpContext http) =>
            {
                var access = http.PageAccess();
                if (!Levels.AtLeast(access.Level, Levels.Edit)) return Problems.From(Failure.Denied("This page is read-only for you"));
                var result = await docs.PushAsync(access.Member, access.Page, body, http.User.DeviceId());
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("pushDocUpdates").RequireRateLimiting(RateLimits.Push)
            // 4 MB of updates as base64, and the rest of the body.
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(6 * 1024 * 1024));

        page.MapGet("/doc", async (long? after, DocService docs, HttpContext http) =>
            {
                var access = http.PageAccess();
                return TypedResults.Ok(await docs.PullAsync(access.Member, access.Page, after ?? 0));
            })
            .WithName("pullDoc").RequireRateLimiting(RateLimits.User);

        page.MapGet("/doc/json", async Task<Results<Ok<DocJsonResponse>, ProblemHttpResult>> (DocService docs, HttpContext http) =>
            {
                var json = await docs.JsonAsync(http.PageAccess().Page);
                return json is null ? Problems.From(Failure.NotFound("The page has no document on the server yet")) : TypedResults.Ok(json);
            })
            .WithName("getDocJson").RequireRateLimiting(RateLimits.User);

        api.MapGroup("/workspaces/{workspaceId:guid}").WithTags("Documents").RequireAuthorization().AddEndpointFilter<MemberFilter>()
            .MapPost("/yjs-clients", async (YjsClientsRequest body, DocService docs, HttpContext http) =>
                TypedResults.Ok(await docs.ClientsAsync(http.Member(), http.User.DeviceId(), body)))
            .WithName("yjsClients").RequireRateLimiting(RateLimits.User);
    }
}
