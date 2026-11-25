using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Automations;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Phase 15: automations. A database's rules and runs (its readers read them; full access changes
/// them through <c>automation.upsert</c> and <c>automation.delete</c>), a row's runs, a button's
/// press, and Settings → Automations for owners and admins (every rule, the switches, the time zone,
/// the webhooks).
/// </summary>
public static class AutomationEndpoints
{
    private static IResult Answer<T>(Result<T> result, Func<T, IResult>? ok = null) =>
        result.Ok ? (ok?.Invoke(result.Value!) ?? TypedResults.Ok(result.Value)) : Problems.From(result.Failure!);

    public static void MapAutomations(this RouteGroupBuilder api)
    {
        var database = api.MapGroup("/databases/{databaseId:guid}").WithTags("Automations").RequireAuthorization()
            .AddEndpointFilter<DatabaseFilter>().RequireRateLimiting(RateLimits.User);

        database.MapGet("/automations", async Task<Results<Ok<DatabaseAutomationsDto>, ProblemHttpResult>> (AutomationQueries queries, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await queries.ForDatabaseAsync(access.Member, access.Page.Id, access.Level, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listDatabaseAutomations");

        database.MapGet("/automations/{automationId:guid}/runs", async Task<Results<Ok<RunsDto>, ProblemHttpResult>> (Guid automationId, string? before, int? limit,
                AutomationQueries queries, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await queries.RuleRunsAsync(access.Member, access.Page.Id, access.Level, automationId, before, limit, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listAutomationRuns");

        database.MapGet("/rows/{rowId:guid}/runs", async Task<Results<Ok<RunsDto>, ProblemHttpResult>> (Guid rowId, string? before, int? limit,
                AutomationQueries queries, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await queries.RowRunsAsync(access.Member, access.Page.Id, rowId, before, limit, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listRowRuns");

        database.MapPost("/rows/{rowId:guid}/press", async Task<Results<Accepted<PressDto>, ProblemHttpResult>> (Guid rowId, PressRequest body,
                AutomationQueries queries, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await queries.PressAsync(access.Member, access.Page.Id, access.Level, rowId, body, http.RequestAborted);
                return result.Ok ? TypedResults.Accepted((string?)null, result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("pressButton")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        // Phase 17: the person's own reminders of a row's dates (anyone who can read the row).
        database.MapGet("/rows/{rowId:guid}/reminders", async Task<Results<Ok<RowRemindersDto>, ProblemHttpResult>> (Guid rowId,
                ReminderService reminders, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await reminders.ForRowAsync(access.Member, access.Page.Id, rowId, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listRowReminders");

        database.MapPut("/rows/{rowId:guid}/reminders/{propertyId}", async Task<Results<Ok<RowRemindersDto>, ProblemHttpResult>> (Guid rowId, string propertyId,
                ReminderRequest body, ReminderService reminders, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await reminders.SetAsync(access.Member, access.Page.Id, rowId, propertyId, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("setRowReminder")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        database.MapDelete("/rows/{rowId:guid}/reminders/{propertyId}", async Task<Results<Ok<RowRemindersDto>, ProblemHttpResult>> (Guid rowId, string propertyId,
                ReminderService reminders, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await reminders.DeleteAsync(access.Member, access.Page.Id, rowId, propertyId, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("deleteRowReminder");

        var workspace = api.MapGroup("/workspaces/{workspaceId:guid}").WithTags("Automations").RequireAuthorization()
            .AddEndpointFilter<MemberFilter>().RequireRateLimiting(RateLimits.User);

        workspace.MapGet("/automations", async Task<Results<Ok<WorkspaceAutomationsDto>, ProblemHttpResult>> (AutomationQueries queries, HttpContext http) =>
            {
                var result = await queries.ForWorkspaceAsync(http.Member(), http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listWorkspaceAutomations");

        workspace.MapPut("/automations/settings", async Task<Results<Ok<WorkspaceAutomationsDto>, ProblemHttpResult>> (AutomationSettingsRequest body,
                AutomationQueries queries, HttpContext http) =>
            {
                var result = await queries.UpdateSettingsAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updateAutomationSettings")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        workspace.MapPut("/automations/{automationId:guid}/enabled", async Task<Results<Ok<AutomationDto>, ProblemHttpResult>> (Guid automationId,
                AutomationSwitchRequest body, AutomationQueries queries, HttpContext http) =>
            {
                var result = await queries.SwitchAsync(http.Member(), automationId, body.Enabled, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("switchAutomation")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        workspace.MapGet("/webhooks", async Task<Results<Ok<IReadOnlyList<WebhookDto>>, ProblemHttpResult>> (AutomationQueries queries, HttpContext http) =>
            {
                var result = await queries.WebhooksAsync(http.Member(), http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("listWebhooks");

        workspace.MapPost("/webhooks", async Task<Results<Ok<WebhookMadeDto>, ProblemHttpResult>> (WebhookRequest body, AutomationQueries queries, HttpContext http) =>
            {
                var result = await queries.CreateWebhookAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createWebhook")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8 * 1024));

        workspace.MapDelete("/webhooks/{webhookId:guid}", async Task<Results<NoContent, ProblemHttpResult>> (Guid webhookId, AutomationQueries queries, HttpContext http) =>
            {
                var result = await queries.DeleteWebhookAsync(http.Member(), http.Actor(), webhookId, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("deleteWebhook");
    }
}
