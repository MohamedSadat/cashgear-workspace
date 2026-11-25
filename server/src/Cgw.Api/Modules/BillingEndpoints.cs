using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Billing;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Phase 18: billing for Cash Gear's AI subscription (INTEGRATIONS.md, Billing). A workspace's plan
/// for owners and admins; a checkout, a plan change and Paddle's portal for owners; and Paddle's
/// webhook, which carries no session (a cookie sent with it is never read) and no antiforgery token,
/// is taken only with Paddle's signature, and is answered 200 once it is applied or was before.
/// Without Paddle and a plan configured every route answers 404, as in 0.17.0.
/// </summary>
public static class BillingEndpoints
{
    /// <summary>The most a webhook's body may hold (Paddle's events are a few kilobytes).</summary>
    public const int MaxWebhookBytes = 256 * 1024;

    public static void MapBilling(this RouteGroupBuilder api)
    {
        var billing = api.MapGroup("/workspaces/{workspaceId:guid}/billing").WithTags("Billing")
            .RequireAuthorization().AddEndpointFilter<MemberFilter>();

        billing.MapGet("", async Task<Results<Ok<BillingDto>, ProblemHttpResult>> (BillingService service, HttpContext http) =>
            {
                var result = await service.StateAsync(http.Member(), http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("getBilling").RequireRateLimiting(RateLimits.User);

        billing.MapPost("/checkout", async Task<Results<Ok<BillingLinkDto>, ProblemHttpResult>> (BillingPlanChoice body, BillingService service, HttpContext http) =>
            {
                var result = await service.CheckoutAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("startBillingCheckout").RequireRateLimiting(RateLimits.Billing)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        billing.MapPost("/plan", async Task<Results<Ok<BillingDto>, ProblemHttpResult>> (BillingPlanChoice body, BillingService service, HttpContext http) =>
            {
                var result = await service.ChangePlanAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("changeBillingPlan").RequireRateLimiting(RateLimits.Billing)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        billing.MapPost("/portal", async Task<Results<Ok<BillingLinkDto>, ProblemHttpResult>> (BillingService service, HttpContext http) =>
            {
                var result = await service.PortalAsync(http.Member(), http.Actor(), http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("openBillingPortal").RequireRateLimiting(RateLimits.Billing);

        billing.MapPost("/refresh", async Task<Results<Ok<BillingDto>, ProblemHttpResult>> (BillingService service, HttpContext http) =>
            {
                var result = await service.RefreshAsync(http.Member(), http.Actor(), http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("refreshBilling").RequireRateLimiting(RateLimits.Billing);

        // Paddle's webhook: the raw body, signed. Nothing is read of a session.
        api.MapPost("/billing/paddle", async (HttpContext http, BillingService service, BillingOptions options) =>
            {
                if (!options.Offered) return Results.NotFound();
                if (http.Request.ContentLength > MaxWebhookBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                using var buffer = new MemoryStream();
                try
                {
                    await http.Request.Body.CopyToAsync(buffer, http.RequestAborted);
                }
                catch (Exception e) when (e is BadHttpRequestException or IOException)
                {
                    return Results.StatusCode(StatusCodes.Status400BadRequest);
                }
                if (buffer.Length > MaxWebhookBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                var outcome = await service.WebhookAsync(http.Request.Headers["Paddle-Signature"].ToString() is { Length: > 0 } s ? s : null, buffer.ToArray(), http.RequestAborted);
                return outcome switch
                {
                    BillingService.WebhookResult.Done or BillingService.WebhookResult.Again => Results.Ok(),
                    BillingService.WebhookResult.Forged => Results.StatusCode(StatusCodes.Status401Unauthorized),
                    BillingService.WebhookResult.Invalid => Results.StatusCode(StatusCodes.Status400BadRequest),
                    _ => Results.StatusCode(StatusCodes.Status503ServiceUnavailable),
                };
            })
            .AllowAnonymous().RequireRateLimiting(RateLimits.Paddle).ExcludeFromDescription()
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(MaxWebhookBytes));
    }
}
