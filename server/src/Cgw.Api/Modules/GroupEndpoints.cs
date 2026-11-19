using System.Globalization;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Workspaces;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Phase 11 (M11.1): a workspace's groups, under the membership filter as every
/// <c>/workspaces/{workspaceId}</c> route. Members, admins and owners read them (a guest 403);
/// owners and admins make, rename and delete them and set their people (<see cref="GroupService"/>).
/// A change takes an optional <c>If-Match</c> holding the group's version, as its <c>ETag</c> gave it.
/// </summary>
public static class GroupEndpoints
{
    private static string Tag(long version) => $"\"{version.ToString(CultureInfo.InvariantCulture)}\"";

    private static Results<Ok<GroupDto>, ProblemHttpResult> Answer(Result<GroupDto> result, HttpContext http)
    {
        if (!result.Ok) return Problems.From(result.Failure!);
        http.Response.Headers.ETag = Tag(result.Value!.Version);
        return TypedResults.Ok(result.Value);
    }

    public static void MapGroups(this RouteGroupBuilder api)
    {
        var groups = api.MapGroup("/workspaces/{workspaceId:guid}/groups").WithTags("Groups")
            .RequireAuthorization().AddEndpointFilter<MemberFilter>().RequireRateLimiting(RateLimits.User);

        groups.MapGet("", async Task<Results<Ok<GroupListDto>, ProblemHttpResult>> (GroupService service, HttpContext http) =>
            {
                var result = await service.ListAsync(http.Member(), http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listGroups").ProducesProblem(403);

        groups.MapPost("", async Task<Results<Created<GroupDto>, ProblemHttpResult>> (NewGroup body, GroupService service, HttpContext http) =>
            {
                var member = http.Member();
                var result = await service.CreateAsync(member, http.Actor(), body, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                http.Response.Headers.ETag = Tag(result.Value!.Version);
                return TypedResults.Created($"/api/v1/workspaces/{member.WorkspaceId}/groups/{result.Value.Id}", result.Value);
            })
            .WithName("createGroup").ProducesProblem(400).ProducesProblem(403).ProducesProblem(409);

        groups.MapPatch("/{groupId:guid}", async Task<Results<Ok<GroupDto>, ProblemHttpResult>> (Guid groupId, GroupRename body, GroupService service, HttpContext http) =>
            {
                if (!WorkbookEndpoints.TryIfMatchVersion(http, out var ifVersion)) return Problems.Of(Codes.RequestInvalid, 400, "If-Match is the group's version from its ETag");
                return Answer(await service.RenameAsync(http.Member(), http.Actor(), groupId, body, ifVersion, http.RequestAborted), http);
            })
            .WithName("renameGroup").ProducesProblem(400).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409);

        groups.MapPut("/{groupId:guid}/people", async Task<Results<Ok<GroupDto>, ProblemHttpResult>> (Guid groupId, GroupPeople body, GroupService service, HttpContext http) =>
            {
                if (!WorkbookEndpoints.TryIfMatchVersion(http, out var ifVersion)) return Problems.Of(Codes.RequestInvalid, 400, "If-Match is the group's version from its ETag");
                return Answer(await service.SetPeopleAsync(http.Member(), http.Actor(), groupId, body, ifVersion, http.RequestAborted), http);
            })
            .WithName("setGroupPeople").ProducesProblem(400).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409);

        groups.MapDelete("/{groupId:guid}", async Task<Results<NoContent, ProblemHttpResult>> (Guid groupId, GroupService service, HttpContext http) =>
            {
                var result = await service.DeleteAsync(http.Member(), http.Actor(), groupId, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("deleteGroup").ProducesProblem(403).ProducesProblem(404);
    }
}
