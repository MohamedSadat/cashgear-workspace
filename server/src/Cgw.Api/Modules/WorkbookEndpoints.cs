using System.Globalization;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Sharing;
using Cgw.Core.Workbooks;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Modules;

/// <summary>A workbook route's caller: their membership, the workbook, and their level on it.</summary>
public sealed record WorkbookCaller(Member Member, Workbook Workbook, string Level);

/// <summary>
/// Routes under <c>/workbooks/{workbookId}</c>: the workbook's workspace is found, the caller's
/// membership checked and the tenant scope entered before any handler runs. A workbook the caller
/// may not read (or in a workspace they are not in) is 404, as if it did not exist. These routes
/// take a Workspace session only: a share link reaches none of them.
/// </summary>
public sealed class WorkbookFilter(Access access, WorkbookAccess levels, TenantScope scope, CgwDb db) : IEndpointFilter
{
    public const string Key = "cgw.workbook";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.UserId() is not { } userId) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
        if (!Guid.TryParse(http.Request.RouteValues["workbookId"]?.ToString(), out var id)) return Problems.From(Failure.NotFound("No such workbook"));
        var book = await db.Workbooks.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(w => w.Id == id);
        if (book is null || await access.MemberAsync(book.WorkspaceId, userId) is not { } member) return Problems.From(Failure.NotFound("No such workbook"));
        scope.Enter(book.WorkspaceId);
        var level = await levels.LevelAsync(member, book);
        if (level == Levels.None) return Problems.From(Failure.NotFound("No such workbook"));
        http.Items[Key] = new WorkbookCaller(member, book, level);
        return await next(context);
    }
}

public static class WorkbookEndpoints
{
    public static WorkbookCaller Workbook(this HttpContext http) => (WorkbookCaller)http.Items[WorkbookFilter.Key]!;

    /// <summary>An optional <c>If-Match</c> holding the record's version (<c>"&lt;version&gt;"</c>, as <c>ETag</c> gave it).</summary>
    public static bool TryIfMatchVersion(HttpContext http, out long? version)
    {
        version = null;
        var match = http.Request.Headers.IfMatch.ToString().Trim().Trim('"');
        if (match.Length == 0 || match == "*") return true;
        if (!long.TryParse(match, NumberStyles.None, CultureInfo.InvariantCulture, out var n)) return false;
        version = n;
        return true;
    }

    private static string RecordTag(long version) => $"\"{version.ToString(CultureInfo.InvariantCulture)}\"";

    /// <summary>The request's body, at most <paramref name="max"/> bytes; null when it is longer.</summary>
    public static async Task<byte[]?> ReadBodyAsync(HttpRequest request, long max, CancellationToken ct)
    {
        if (request.ContentLength is { } length && length > max) return null;
        using var buffer = new MemoryStream((int)Math.Min(request.ContentLength ?? 81_920, max));
        var chunk = new byte[81_920];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > max) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    public static Failure TooLarge(long limit, string what) =>
        new(Codes.LimitSize, 413, what) { Extensions = new Dictionary<string, object?> { ["limit"] = limit } };

    public static void MapWorkbooks(this RouteGroupBuilder api)
    {
        var workspace = api.MapGroup("/workspaces/{workspaceId:guid}/workbooks").WithTags("Workbooks")
            .RequireAuthorization().AddEndpointFilter<MemberFilter>().RequireRateLimiting(RateLimits.User);

        workspace.MapGet("", async (bool? trashed, string? q, WorkbookService workbooks, HttpContext http) =>
                TypedResults.Ok(await workbooks.ListAsync(http.Member(), trashed == true, q, http.RequestAborted)))
            .WithName("listWorkbooks");

        workspace.MapPost("", async Task<Results<Created<WorkbookDto>, ProblemHttpResult>> (NewWorkbook body, WorkbookService workbooks, HttpContext http) =>
            {
                var result = await workbooks.CreateAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                http.Response.Headers.ETag = RecordTag(result.Value!.Version);
                return TypedResults.Created($"/api/v1/workbooks/{result.Value.Id}", result.Value);
            })
            .WithName("createWorkbook");

        var one = api.MapGroup("/workbooks/{workbookId:guid}").WithTags("Workbooks")
            .RequireAuthorization().AddEndpointFilter<WorkbookFilter>().RequireRateLimiting(RateLimits.User);

        one.MapGet("", async (WorkbookService workbooks, HttpContext http) =>
            {
                var caller = http.Workbook();
                var dto = await workbooks.DtoAsync(caller.Workbook, caller.Level, http.RequestAborted);
                http.Response.Headers.ETag = RecordTag(dto.Version);
                return TypedResults.Ok(dto);
            })
            .WithName("getWorkbook");

        one.MapPatch("", async Task<Results<Ok<WorkbookDto>, ProblemHttpResult>> (WorkbookUpdate body, WorkbookService workbooks, HttpContext http) =>
            {
                var caller = http.Workbook();
                if (!TryIfMatchVersion(http, out var ifVersion)) return Problems.Of(Codes.RequestInvalid, 400, "If-Match is the workbook's version from its ETag");
                var result = await workbooks.UpdateAsync(caller.Member, http.Actor(), caller.Workbook, caller.Level, body, ifVersion, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                http.Response.Headers.ETag = RecordTag(result.Value!.Version);
                return TypedResults.Ok(result.Value);
            })
            .WithName("updateWorkbook");

        one.MapDelete("", async Task<Results<NoContent, ProblemHttpResult>> (WorkbookService workbooks, HttpContext http) =>
            {
                var caller = http.Workbook();
                var result = await workbooks.TrashAsync(caller.Member, http.Actor(), caller.Workbook, caller.Level, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("deleteWorkbook");

        one.MapGet("/permissions", async (WorkbookService workbooks, HttpContext http) =>
            {
                var caller = http.Workbook();
                http.Response.Headers.ETag = RecordTag(caller.Workbook.Version);
                return TypedResults.Ok(await workbooks.PermissionsAsync(caller.Workbook, caller.Level, http.RequestAborted));
            })
            .WithName("getWorkbookPermissions");

        one.MapPut("/permissions", async Task<Results<Ok<PermissionsDto>, ProblemHttpResult>> (PermissionsUpdate body, WorkbookService workbooks, CgwDb db, HttpContext http) =>
            {
                var caller = http.Workbook();
                if (!TryIfMatchVersion(http, out var ifVersion)) return Problems.Of(Codes.RequestInvalid, 400, "If-Match is the workbook's version from its ETag");
                var result = await workbooks.SetPermissionsAsync(caller.Member, http.Actor(), caller.Workbook, caller.Level, body, ifVersion, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                var version = await db.Workbooks.AsNoTracking().Where(w => w.Id == caller.Workbook.Id).Select(w => w.Version).FirstAsync(http.RequestAborted);
                http.Response.Headers.ETag = RecordTag(version);
                return TypedResults.Ok(result.Value!);
            })
            .WithName("setWorkbookPermissions");

        one.MapGet("/content", async Task<Results<Ok<WorkbookContentDto>, ProblemHttpResult>> (WorkbookService workbooks, HttpContext http) =>
            {
                var result = await workbooks.ContentAsync(http.Workbook().Workbook, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!, http);
            })
            .WithName("getWorkbookContent");

        one.MapGet("/previews/{viewHash}", async Task<Results<Ok<WorkbookPreviewDto>, ProblemHttpResult>> (string viewHash, WorkbookService workbooks, HttpContext http) =>
            {
                var result = await workbooks.PreviewAsync(http.Workbook().Workbook, viewHash, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("getWorkbookPreview");

        // The picture's bytes as the body; the version it shows in X-Workbook-Version.
        one.MapPut("/previews/{viewHash}", async Task<Results<NoContent, ProblemHttpResult>> (string viewHash, WorkbookService workbooks, HttpContext http) =>
            {
                var caller = http.Workbook();
                if (!Levels.AtLeast(caller.Level, Levels.Edit)) return Problems.From(Failure.Denied("Only someone who may edit the workbook sends its pictures"));
                var bytes = await ReadBodyAsync(http.Request, Png.MaxBytes, http.RequestAborted);
                if (bytes is null) return Problems.From(TooLarge(Png.MaxBytes, "A picture is at most 2 MB"));
                var result = await workbooks.PutPreviewAsync(caller.Member, caller.Workbook, caller.Level, viewHash,
                    http.Request.Headers[PreviewVersionHeader].ToString(), http.Request.ContentType, bytes, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithMetadata(new DocumentedBody(Png.ContentType))
            .WithName("putWorkbookPreview");

        one.MapPost("/launch", async Task<Results<Ok<WorkbookLaunchDto>, ProblemHttpResult>> (SheetSessions sessions, HttpContext http) =>
            {
                var caller = http.Workbook();
                var result = await sessions.LaunchAsync(caller.Member, caller.Workbook, caller.Level, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("launchWorkbook");

        one.MapGet("/sheets", async Task<Results<Ok<WorkbookSheetsDto>, ProblemHttpResult>> (WorkbookService workbooks, HttpContext http) =>
            {
                var result = await workbooks.SheetsAsync(http.Workbook().Workbook, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!, http);
            })
            .WithName("listWorkbookSheets");

        one.MapGet("/range", async Task<Results<Ok<WorkbookRangeDto>, ProblemHttpResult>> (string? sheet, string? range, WorkbookService workbooks, HttpContext http) =>
            {
                var result = await workbooks.RangeAsync(http.Workbook().Workbook, sheet, range, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!, http);
            })
            .WithName("getWorkbookRange");

        // A database view as a new workbook (read the database, create workbooks).
        api.MapGroup("/databases/{databaseId:guid}").WithTags("Workbooks").RequireAuthorization().AddEndpointFilter<DatabaseFilter>()
            .MapPost("/workbooks", async Task<Results<Created<WorkbookDto>, ProblemHttpResult>> (WorkbookExportRequest body, WorkbookService workbooks, HttpContext http) =>
            {
                var caller = http.DatabaseAccess();
                var result = await workbooks.ExportAsync(caller.Member, http.Actor(), caller.Page, body, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                http.Response.Headers.ETag = RecordTag(result.Value!.Version);
                return TypedResults.Created($"/api/v1/workbooks/{result.Value.Id}", result.Value);
            })
            .WithName("exportDatabaseWorkbook").RequireRateLimiting(RateLimits.Import);

        var links = api.MapGroup("/workspaces/{workspaceId:guid}/erp-links").WithTags("ERP links")
            .RequireAuthorization().AddEndpointFilter<MemberFilter>().RequireRateLimiting(RateLimits.User);

        links.MapGet("", async (ErpLinkService service, HttpContext http) => TypedResults.Ok(await service.ListAsync(http.RequestAborted)))
            .WithName("listErpLinks");

        links.MapPost("", async Task<Results<Created<ErpLinkDto>, ProblemHttpResult>> (NewErpLink body, ErpLinkService service, HttpContext http) =>
            {
                var result = await service.CreateAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Created($"/api/v1/workspaces/{http.Member().WorkspaceId}/erp-links/{result.Value!.Id}", result.Value) : Problems.From(result.Failure!);
            })
            .WithName("createErpLink");

        links.MapDelete("/{linkId:guid}", async Task<Results<NoContent, ProblemHttpResult>> (Guid linkId, ErpLinkService service, HttpContext http) =>
            {
                var result = await service.RevokeAsync(http.Member(), http.Actor(), linkId, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("deleteErpLink");
    }

    /// <summary>The version a picture shows (its <c>versionId</c>, or its ETag), on <c>PUT …/previews/{viewHash}</c>.</summary>
    public const string PreviewVersionHeader = "X-Workbook-Version";
}
