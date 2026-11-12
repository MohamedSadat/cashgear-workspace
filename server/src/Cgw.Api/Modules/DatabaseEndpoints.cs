using System.Text.Json;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Modules;

/// <summary>A database route's caller: their membership, the database's page, and their level on it.</summary>
public sealed record DatabaseAccess(Member Member, Page Page, string Level);

/// <summary>
/// Routes under <c>/databases/{databaseId}</c>: the database page's workspace is found, the
/// caller's membership checked and the tenant scope entered before any handler runs. A database
/// the caller may not see (or an id that is not a database's) is 404; one deleted for good is 410,
/// to those who could see it. Rows have their database's level, so it is the only check.
/// </summary>
public sealed class DatabaseFilter(Access access, TenantScope scope, CgwDb db) : IEndpointFilter
{
    public const string Key = "cgw.database";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.UserId() is not { } userId) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
        if (!Guid.TryParse(http.Request.RouteValues["databaseId"]?.ToString(), out var id)) return Problems.From(Failure.NotFound("No such database"));
        var page = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(p => p.Id == id && p.Kind == PageKinds.Database);
        if (page is null || await access.MemberAsync(page.WorkspaceId, userId) is not { } member) return Problems.From(Failure.NotFound("No such database"));
        scope.Enter(page.WorkspaceId);
        var level = page.DeletedAt is null ? await access.PageLevelAsync(member, page.Id) : await access.DeletedLevelAsync(member, page);
        if (level == Levels.None) return Problems.From(Failure.NotFound("No such database"));
        if (page.DeletedAt is not null) return Problems.Of(Codes.PageGone, 410, "The database was deleted for good");
        http.Items[Key] = new DatabaseAccess(member, page, level);
        return await next(context);
    }
}

public static class DatabaseEndpoints
{
    public static DatabaseAccess DatabaseAccess(this HttpContext http) => (DatabaseAccess)http.Items[DatabaseFilter.Key]!;

    /// <summary>Import's body: a 20 MB file as JSON text, escaped, and the rest.</summary>
    public const long ImportBodyLimit = 64L * 1024 * 1024;

    public static void MapDatabases(this RouteGroupBuilder api)
    {
        var one = api.MapGroup("/databases/{databaseId:guid}").WithTags("Databases").RequireAuthorization().AddEndpointFilter<DatabaseFilter>();

        // A device's full fetch: every row by id, trashed rows and templates included.
        one.MapGet("/rows", async Task<Results<Ok<RowsPageDto>, ProblemHttpResult>> (string? after, int? limit, DatabaseService service, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await service.RowsAsync(access.Member, access.Page, access.Level, after, limit, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listDatabaseRows").RequireRateLimiting(RateLimits.User);

        // The server's query: a view's (or the request's) filter, sorts and group; a keyset cursor.
        // Read as JSON so a part given as null (no group) is told from one not given (the view's).
        one.MapPost("/query", async Task<Results<Ok<QueryResponseDto>, ProblemHttpResult>> (HttpContext http, DatabaseService service) =>
            {
                var access = http.DatabaseAccess();
                JsonElement body;
                try
                {
                    using var document = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted);
                    body = document.RootElement.Clone();
                }
                catch (JsonException)
                {
                    return Problems.From(Failure.Invalid("The query is not JSON"));
                }
                var result = await service.QueryAsync(access.Member, access.Page, access.Level, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .Accepts<QueryRequestDto>("application/json")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(1024 * 1024))
            .WithName("queryDatabase").RequireRateLimiting(RateLimits.User);

        one.MapPost("/import", async Task<Results<Ok<ImportResponseDto>, ProblemHttpResult>> (ImportRequestDto body, DatabaseService service, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                if (!Levels.AtLeast(access.Level, Levels.Edit)) return Problems.From(Failure.Denied("Importing rows needs edit on the database"));
                var result = await service.ImportAsync(access.Member, http.Actor(), access.Page, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("importDatabaseRows").RequireRateLimiting(RateLimits.Import)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(ImportBodyLimit));

        // The view's rows in its order, as the app's export writes them. Today and the offset date
        // filters read are the caller's, as a query's context gives them (UTC when not given).
        one.MapGet("/export", async Task<Results<FileContentHttpResult, ProblemHttpResult>> (Guid? viewId, string? today, int? offsetMinutes, DatabaseService service, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await service.ExportAsync(access.Member, access.Page, viewId, new QueryContextDto(today, offsetMinutes, null, null), http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                return TypedResults.File(result.Value.Bytes, "text/csv; charset=utf-8", result.Value.FileName);
            })
            .Produces<string>(StatusCodes.Status200OK, "text/csv")
            .WithName("exportDatabase").RequireRateLimiting(RateLimits.User);
    }
}
