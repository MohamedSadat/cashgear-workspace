using System.Text.Json;
using Cgw.Api.Identity;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Cgw.Core.Workspaces;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Modules;

public sealed record WorkspaceUpdate(string? Name, string? Icon);
public sealed record RoleUpdate(string Role);
public sealed record NewInvite(string Email, string Role);

/// <summary>
/// Routes under <c>/workspaces/{workspaceId}</c>: the caller's membership is checked before any
/// handler runs, and a non-member gets 404 for every id, as if the workspace did not exist
/// (ARCHITECTURE.md, Tenancy). The tenant scope is entered here.
/// </summary>
public sealed class MemberFilter(Access access, TenantScope scope) : IEndpointFilter
{
    public const string Key = "cgw.member";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.UserId() is not { } userId) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
        if (!Guid.TryParse(http.Request.RouteValues["workspaceId"]?.ToString(), out var workspaceId)
            || await access.MemberAsync(workspaceId, userId) is not { } member)
            return Problems.From(Failure.NotFound("No such workspace"));
        scope.Enter(workspaceId);
        http.Items[Key] = member;
        return await next(context);
    }
}

public static class WorkspaceEndpoints
{
    public static Member Member(this HttpContext http) => (Member)http.Items[MemberFilter.Key]!;

    private static IResult Answer<T>(Result<T> result, Func<T, IResult>? ok = null) =>
        result.Ok ? (ok?.Invoke(result.Value!) ?? TypedResults.Ok(result.Value)) : Problems.From(result.Failure!);

    public static void MapWorkspaces(this RouteGroupBuilder api)
    {
        var root = api.MapGroup("/workspaces").WithTags("Workspaces").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        root.MapGet("", async (WorkspaceService service, HttpContext http) =>
            TypedResults.Ok(await service.ListAsync(http.User.UserId()!.Value)))
            .WithName("listWorkspaces");

        root.MapPost("", async Task<Results<Ok<WorkspaceDto>, ProblemHttpResult>> (NewWorkspace body, WorkspaceService service, HttpContext http) =>
            {
                var result = await service.CreateAsync(http.User.UserId()!.Value, http.Actor(), body);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createWorkspace");

        api.MapPost("/invites/{token}/accept", async Task<Results<Ok<WorkspaceDto>, ProblemHttpResult>> (string token, WorkspaceService service, HttpContext http) =>
            {
                var result = await service.AcceptAsync(http.User.UserId()!.Value, http.Actor(), token);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("acceptInvite").WithTags("Workspaces").RequireAuthorization().RequireRateLimiting(RateLimits.SignIn);

        var one = root.MapGroup("/{workspaceId:guid}").AddEndpointFilter<MemberFilter>();

        one.MapGet("", async (CgwDb db, HttpContext http) =>
            {
                var member = http.Member();
                var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId);
                return TypedResults.Ok(WorkspaceDto.From(workspace, member.Role));
            })
            .WithName("getWorkspace");

        one.MapPatch("", async Task<Results<Ok<OpResultDto>, ProblemHttpResult>> (WorkspaceUpdate body, OpsService ops, HttpContext http) =>
            {
                var member = http.Member();
                var payload = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
                {
                    ["name"] = body.Name,
                    ["icon"] = body.Icon,
                }.Where(p => p.Value is not null).ToDictionary());
                var response = await ops.ApplyAsync(member, http.Actor(), new OpsRequest(null,
                    [new OperationDto(Guid.CreateVersion7(), "workspace.update", member.WorkspaceId, member.WorkspaceId, null, payload, null)]));
                var result = response.Results[0];
                return result.Status == "applied" ? TypedResults.Ok(result) : Problems.Of(result.Error!.Code, result.Error.Code == Codes.AccessDenied ? 403 : 400, result.Error.Title);
            })
            .WithName("updateWorkspace");

        one.MapDelete("", async (WorkspaceService service, HttpContext http) =>
                Answer(await service.DeleteAsync(http.Member(), http.Actor()), _ => TypedResults.NoContent()))
            .WithName("deleteWorkspace");

        one.MapGet("/members", async (WorkspaceService service) => TypedResults.Ok(await service.MembersAsync()))
            .WithName("listMembers");

        // Someone joins only through an invitation they accept (POST /invites): an answer that
        // depended on whether the address has an account would tell any admin who has one.
        one.MapPatch("/members/{userId:guid}", async Task<Results<Ok<MemberDto>, ProblemHttpResult>> (Guid userId, RoleUpdate body, WorkspaceService service, HttpContext http) =>
            {
                var result = await service.SetRoleAsync(http.Member(), http.Actor(), userId, body.Role ?? "");
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updateMember");

        one.MapDelete("/members/{userId:guid}", async (Guid userId, WorkspaceService service, HttpContext http) =>
                Answer(await service.RemoveMemberAsync(http.Member(), http.Actor(), userId), _ => TypedResults.NoContent()))
            .WithName("removeMember");

        // The same answer whether or not the address has an account; the mail goes after it.
        one.MapPost("/invites", async Task<Results<Ok<InviteDto>, ProblemHttpResult>> (NewInvite body, WorkspaceService service, AccountService account, MailQueue mail, CgwDb db, HttpContext http) =>
            {
                var member = http.Member();
                var result = await service.InviteAsync(member, http.Actor(), body.Email ?? "", body.Role ?? "");
                if (!result.Ok) return Problems.From(result.Failure!);
                var inviter = await db.Users.AsNoTracking().FirstAsync(u => u.Id == member.UserId);
                var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId);
                var link = $"{account.AppUrl()}/#/invite/{result.Value!.Token}";
                mail.Enqueue("invite", Mails.Invite(inviter.Locale, result.Value.Invite.Email, inviter.DisplayName, workspace.Name, link));
                return TypedResults.Ok(result.Value.Invite);
            })
            .WithName("createInvite");

        one.MapGet("/invites", async (WorkspaceService service, HttpContext http) =>
                http.Member().IsAdmin ? Results.Ok(await service.InvitesAsync()) : Problems.From(Failure.Denied("Only an owner or admin sees invites")))
            .WithName("listInvites").Produces<List<InviteDto>>();

        one.MapDelete("/invites/{inviteId:guid}", async (Guid inviteId, WorkspaceService service, HttpContext http) =>
                Answer(await service.RevokeInviteAsync(http.Member(), http.Actor(), inviteId), _ => TypedResults.NoContent()))
            .WithName("revokeInvite");

        // Metadata sync (SYNC_DESIGN.md, Channel 2).
        one.MapPost("/ops", async Task<Results<Ok<OpsResponse>, ProblemHttpResult>> (OpsRequest body, OpsService ops, HttpContext http) =>
            {
                if (body.Ops is null || body.Ops.Count is 0 or > 100) return Problems.Of(Codes.RequestInvalid, 400, "Send 1 to 100 operations");
                return TypedResults.Ok(await ops.ApplyAsync(http.Member(), http.Actor(), body));
            })
            .WithName("pushOps");

        one.MapGet("/changes", async (long? after, int? limit, FeedService feed, HttpContext http) =>
                TypedResults.Ok(await feed.ChangesAsync(http.Member(), after ?? 0, limit ?? FeedService.DefaultLimit)))
            .WithName("listChanges");

        one.MapGet("/tree", async (Guid? root, FeedService feed, HttpContext http) =>
                TypedResults.Ok(await feed.TreeAsync(http.Member(), root)))
            .WithName("getTree");
    }
}
