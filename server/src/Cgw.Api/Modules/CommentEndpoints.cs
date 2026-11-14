using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Comments;
using Cgw.Core.Notifications;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Comments (Phase 6 contracts, section 3) and the person's inbox (section 5). Signed-in members
/// only: a page's share link reaches none of these. A page the caller cannot see is 404, its threads
/// and comments too.
/// </summary>
public static class CommentEndpoints
{
    public static void MapComments(this RouteGroupBuilder api)
    {
        var page = api.MapGroup("/pages/{pageId:guid}/comments").WithTags("Comments").RequireAuthorization()
            .AddEndpointFilter<PageFilter>().RequireRateLimiting(RateLimits.User);

        page.MapGet("/threads", async Task<Results<Ok<ThreadsDto>, ProblemHttpResult>> (string? state, CommentService comments, HttpContext http) =>
            {
                var result = await comments.ListAsync(http.PageAccess(), state, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listCommentThreads");

        page.MapPost("/threads", async Task<Results<Created<ThreadDto>, ProblemHttpResult>> (NewThreadRequest body, CommentService comments, HttpContext http) =>
            {
                var result = await comments.CreateThreadAsync(http.PageAccess(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Created($"/api/v1/comments/threads/{result.Value.Thread.Id}", result.Value.Thread) : Problems.From(result.Failure!);
            })
            .WithName("createCommentThread")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(256 * 1024));

        var threads = api.MapGroup("/comments").WithTags("Comments").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        threads.MapPatch("/threads/{threadId:guid}", async Task<Results<Ok<ThreadDto>, ProblemHttpResult>> (Guid threadId, ThreadUpdateRequest body, CommentService comments, HttpContext http) =>
            {
                var open = await comments.OpenThreadAsync(http.User.UserId()!.Value, threadId, http.RequestAborted);
                if (!open.Ok) return Problems.From(open.Failure!);
                var result = await comments.ResolveAsync(open.Value!, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updateCommentThread");

        threads.MapPost("/threads/{threadId:guid}/comments", async Task<Results<Created<CommentDto>, ProblemHttpResult>> (Guid threadId, NewCommentRequest body, CommentService comments, HttpContext http) =>
            {
                var open = await comments.OpenThreadAsync(http.User.UserId()!.Value, threadId, http.RequestAborted);
                if (!open.Ok) return Problems.From(open.Failure!);
                var result = await comments.ReplyAsync(open.Value!, body, http.RequestAborted);
                return result.Ok ? TypedResults.Created($"/api/v1/comments/{result.Value.Comment.Id}", result.Value.Comment) : Problems.From(result.Failure!);
            })
            .WithName("createComment")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(256 * 1024));

        threads.MapPatch("/{commentId:guid}", async Task<Results<Ok<CommentDto>, ProblemHttpResult>> (Guid commentId, CommentUpdateRequest body, CommentService comments, HttpContext http) =>
            {
                var open = await comments.OpenCommentAsync(http.User.UserId()!.Value, commentId, http.RequestAborted);
                if (!open.Ok) return Problems.From(open.Failure!);
                var result = await comments.EditAsync(open.Value!, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updateComment")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(256 * 1024));

        threads.MapDelete("/{commentId:guid}", async Task<Results<NoContent, ProblemHttpResult>> (Guid commentId, CommentService comments, HttpContext http) =>
            {
                var open = await comments.OpenCommentAsync(http.User.UserId()!.Value, commentId, http.RequestAborted);
                if (!open.Ok) return Problems.From(open.Failure!);
                var result = await comments.DeleteAsync(open.Value!, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("deleteComment");

        var inbox = api.MapGroup("/account/notifications").WithTags("Notifications").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        // Across every workspace the person is in, newest first; each checked against the page's access now.
        inbox.MapGet("", async Task<Results<Ok<NotificationsDto>, ProblemHttpResult>> (bool? unread, string? after, int? limit, NotificationService notifications, HttpContext http) =>
            {
                var result = await notifications.ListAsync(http.User.UserId()!.Value, unread == true, after, limit ?? NotificationService.DefaultLimit, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listNotifications");

        inbox.MapPost("/read", async Task<Results<Ok<UnreadDto>, ProblemHttpResult>> (ReadNotificationsRequest body, NotificationService notifications, HttpContext http) =>
            {
                var result = await notifications.ReadAsync(http.User.UserId()!.Value, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("readNotifications");
    }
}
