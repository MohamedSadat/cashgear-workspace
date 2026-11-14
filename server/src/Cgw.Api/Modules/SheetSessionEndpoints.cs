using System.Text.Json;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Workbooks;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

namespace Cgw.Api.Modules;

/// <summary>
/// Sheet's routes (contract <c>sheet-session.1</c>, Track S1 and S2 as built against Sheet's mock):
/// no Workspace session, no cookie; a ticket redeemed from an allowed <c>Origin</c>, then the file
/// session's token in <c>X-Workspace-File-Session</c> only. A CORS policy of their own (Sheet's
/// origins, no credentials), a rate limit per address, <c>Cache-Control: no-store</c> on every
/// answer (as every API answer has), and never a redirect.
/// </summary>
public static class SheetSessionEndpoints
{
    private static ProblemHttpResult Problem(Failure failure, HttpContext http) => Problems.From(failure, http);

    private static bool IsXlsx(HttpRequest request) =>
        (request.ContentType ?? "").Split(';')[0].Trim().Equals(Xlsx.ContentType, StringComparison.OrdinalIgnoreCase);

    /// <summary>A save's or a copy's body: the xlsx content type, at most the cap (413 with <c>limit</c>), a zip.</summary>
    private static async Task<Result<byte[]>> WorkbookBodyAsync(HttpContext http, Integrations settings)
    {
        if (!IsXlsx(http.Request)) return Failure.Invalid($"Content-Type must be {Xlsx.ContentType}");
        var bytes = await WorkbookEndpoints.ReadBodyAsync(http.Request, settings.MaxSaveBytes, http.RequestAborted);
        if (bytes is null) return WorkbookEndpoints.TooLarge(settings.MaxSaveBytes, "The workbook is too large");
        if (!Xlsx.LooksLikeZip(bytes)) return Failure.Invalid("The body is not an xlsx");
        return bytes;
    }

    /// <summary>The comma-separated entity tags of <c>If-Match</c>.</summary>
    private static List<string> Tags(string header) =>
        header.Split(',').Select(t => t.Trim()).Where(t => t.Length > 0).ToList();

    public static void MapSheetSessions(this RouteGroupBuilder api)
    {
        var group = api.MapGroup("/sheet-sessions").WithTags("Sheet sessions").AllowAnonymous().RequireCors(ApiServices.SheetCorsPolicy);
        var max = ((IEndpointRouteBuilder)api).ServiceProvider.GetRequiredService<Integrations>().MaxSaveBytes;

        // The Origin before the ticket: a site not on the list cannot use a ticket up.
        group.MapPost("/redeem", async Task<Results<Ok<FileSessionDto>, ProblemHttpResult>> (SheetSessions sessions, HttpContext http) =>
            {
                if (!sessions.OriginAllowed(http.Request.Headers.Origin.ToString()))
                    return Problem(new Failure(Codes.OriginDenied, 403, "This site may not open Workspace workbooks"), http);
                string? ticket = null;
                try
                {
                    using var body = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted);
                    if (body.RootElement.ValueKind == JsonValueKind.Object && body.RootElement.TryGetProperty("ticket", out var value) && value.ValueKind == JsonValueKind.String)
                        ticket = value.GetString();
                }
                catch (JsonException)
                {
                    ticket = null;
                }
                var result = await sessions.RedeemAsync(http.Actor(), ticket, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problem(result.Failure!, http);
            })
            .WithMetadata(new DocumentedBody("application/json", typeof(RedeemRequest)))
            .WithMetadata(new RequestSizeLimitAttribute(64 * 1024))
            .WithName("redeemSheetSession").RequireRateLimiting(RateLimits.Ticket);

        group.MapPost("/renew", async Task<Results<Ok<SessionRenewDto>, ProblemHttpResult>> (
                [FromHeader(Name = SheetSessions.Header)] string? token, SheetSessions sessions, HttpContext http) =>
            {
                var open = await sessions.OpenAsync(token, http.RequestAborted);
                if (!open.Ok) return Problem(open.Failure!, http);
                var result = await sessions.RenewAsync(open.Value!, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problem(result.Failure!, http);
            })
            .WithName("renewSheetSession").RequireRateLimiting(RateLimits.Sheet);

        group.MapPost("/end", async Task<Results<NoContent, ProblemHttpResult>> (
                [FromHeader(Name = SheetSessions.Header)] string? token, SheetSessions sessions, HttpContext http) =>
            {
                var result = await sessions.EndAsync(token, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problem(result.Failure!, http);
            })
            .WithName("endSheetSession").RequireRateLimiting(RateLimits.Sheet);

        group.MapGet("/workbook", async Task<Results<Ok<SessionWorkbookDto>, ProblemHttpResult>> (
                [FromHeader(Name = SheetSessions.Header)] string? token, SheetSessions sessions, HttpContext http) =>
            {
                var open = await sessions.OpenAsync(token, http.RequestAborted);
                if (!open.Ok) return Problem(open.Failure!, http);
                var dto = await sessions.WorkbookAsync(open.Value!, http.RequestAborted);
                if (dto.Etag is { } etag) http.Response.Headers.ETag = etag;
                return TypedResults.Ok(dto);
            })
            .WithName("getSheetSessionWorkbook").RequireRateLimiting(RateLimits.Sheet);

        group.MapPost("/workbook/versions", async Task<Results<Created<SessionVersionDto>, ProblemHttpResult>> (
                [FromHeader(Name = SheetSessions.Header)] string? token, SheetSessions sessions, Integrations settings, HttpContext http) =>
            {
                var open = await sessions.OpenAsync(token, http.RequestAborted);
                if (!open.Ok) return Problem(open.Failure!, http);
                if (!SheetSessions.MaySave(open.Value!)) return Problem(Failure.Denied("This session may not save the workbook"), http);
                if (!IsXlsx(http.Request)) return Problem(Failure.Invalid($"Content-Type must be {Xlsx.ContentType}"), http);
                var ifMatch = http.Request.Headers.IfMatch.ToString();
                var ifNoneMatch = http.Request.Headers.IfNoneMatch.ToString();
                if (string.IsNullOrWhiteSpace(ifMatch) && string.IsNullOrWhiteSpace(ifNoneMatch))
                    return Problem(new Failure(Codes.VersionRequired, 428, "Send If-Match, or If-None-Match: * for the first version"), http);
                var body = await WorkbookBodyAsync(http, settings);
                if (!body.Ok) return Problem(body.Failure!, http);
                var condition = string.IsNullOrWhiteSpace(ifMatch) ? new SavePrecondition(null, ifNoneMatch) : new SavePrecondition(Tags(ifMatch), null);
                var result = await sessions.SaveAsync(http.Actor(), open.Value!, body.Value!, condition, http.RequestAborted);
                if (!result.Ok) return Problem(result.Failure!, http);
                http.Response.Headers.ETag = result.Value!.Etag;
                return TypedResults.Created($"/api/v1/sheet-sessions/workbook/versions/{result.Value.VersionId}", result.Value);
            })
            .WithMetadata(new DocumentedBody(Xlsx.ContentType))
            .WithMetadata(new RequestSizeLimitAttribute(max + 64 * 1024))
            .WithName("saveSheetSessionVersion").RequireRateLimiting(RateLimits.Sheet);

        group.MapPost("/workbook/copies", async Task<Results<Created<SessionCopyDto>, ProblemHttpResult>> (
                [FromHeader(Name = SheetSessions.Header)] string? token, SheetSessions sessions, Integrations settings, HttpContext http) =>
            {
                var open = await sessions.OpenAsync(token, http.RequestAborted);
                if (!open.Ok) return Problem(open.Failure!, http);
                // The right to create workbooks in the workspace: not a guest's.
                if (open.Value!.Member.IsGuest) return Problem(Failure.Denied("Workspace will not make a copy for you"), http);
                var body = await WorkbookBodyAsync(http, settings);
                if (!body.Ok) return Problem(body.Failure!, http);
                var result = await sessions.CopyAsync(http.Actor(), open.Value, body.Value!, http.RequestAborted);
                if (!result.Ok) return Problem(result.Failure!, http);
                http.Response.Headers.ETag = result.Value!.Etag;
                return TypedResults.Created((string?)null, result.Value);
            })
            .WithMetadata(new DocumentedBody(Xlsx.ContentType))
            .WithMetadata(new RequestSizeLimitAttribute(max + 64 * 1024))
            .WithName("copySheetSessionWorkbook").RequireRateLimiting(RateLimits.Sheet);
    }
}
