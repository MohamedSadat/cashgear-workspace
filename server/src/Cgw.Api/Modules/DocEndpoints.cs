using Cgw.Api.Infrastructure;
using Cgw.Api.Realtime;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Routes under <c>/pages/{pageId}</c>: <see cref="PageGate"/> finds the page's workspace, checks
/// the caller's membership in it and enters the tenant scope before any handler runs. A page the
/// caller may not see is 404, as if it did not exist; a page deleted for good is 410, to those who
/// could see it.
/// </summary>
public sealed class PageFilter(PageGate gate) : IEndpointFilter
{
    public const string Key = "cgw.page";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.UserId() is not { } userId) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
        if (!Guid.TryParse(http.Request.RouteValues["pageId"]?.ToString(), out var pageId)) return Problems.From(Failure.NotFound("No such page"));
        var opened = await gate.OpenAsync(userId, pageId, http.RequestAborted);
        if (!opened.Ok) return Problems.From(opened.Failure!);
        http.Items[Key] = opened.Value!;
        return await next(context);
    }
}

public static class DocEndpoints
{
    public static PageAccess PageAccess(this HttpContext http) => (PageAccess)http.Items[PageFilter.Key]!;

    public static void MapDocs(this RouteGroupBuilder api)
    {
        var page = api.MapGroup("/pages/{pageId:guid}").WithTags("Documents").RequireAuthorization().AddEndpointFilter<PageFilter>();

        // The same checked push as the hub's PushUpdates (Phase 6 contracts, section 1).
        page.MapPost("/doc/updates", async Task<Results<Ok<PushResponse>, ProblemHttpResult>> (PushRequest body, DocService docs, RelayMetrics metrics, HttpContext http) =>
            {
                var started = RelayMetrics.Now();
                var access = http.PageAccess();
                var result = await docs.PushCheckedAsync(access, body, http.User.DeviceId());
                if (!result.Ok) return Problems.From(result.Failure!, http);
                metrics.Pushed(access.Page.Id, result.Value!.Acks, started);
                return TypedResults.Ok(result.Value!);
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

        // The repair check (Phase 3 contracts, section 2): read access, as a pull.
        page.MapGet("/doc/state-hash", (HttpContext http) => TypedResults.Ok(DocService.StateHash(http.PageAccess().Page)))
            .WithName("getDocStateHash").RequireRateLimiting(RateLimits.User);

        // The device's full state in (to edit; checked as a push), the page from the start out.
        page.MapPost("/doc/repair", async Task<Results<Ok<RepairResponse>, ProblemHttpResult>> (RepairRequest body, DocService docs, HttpContext http) =>
            {
                var access = http.PageAccess();
                var result = await docs.RepairAsync(access.Member, access.Page, Levels.AtLeast(access.Level, Levels.Edit), body, http.User.DeviceId());
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!, http);
            })
            .WithName("repairDoc").RequireRateLimiting(RateLimits.Push)
            // A 1 MB update as base64, and the rest of the body.
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(2 * 1024 * 1024));

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
