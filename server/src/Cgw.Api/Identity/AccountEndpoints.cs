using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Identity;

public sealed record RegisterRequest(string Email, string Password, string DisplayName, string? Locale, string? ReturnUrl);
public sealed record ConfirmRequest(Guid UserId, string Code);
public sealed record ForgotRequest(string Email, string? Locale, string? ReturnUrl);
public sealed record ResetRequest(Guid UserId, string Code, string Password);
public sealed record Me(Guid Id, string Email, string DisplayName, string Locale, Guid? DeviceId, string SignInUrl);
public sealed record MeUpdate(string? DisplayName, string? Locale);
public sealed record DeviceInfo(Guid Id, string Name, string Platform, DateTimeOffset CreatedAt, DateTimeOffset LastSeenAt, bool Current);
public sealed record CsrfToken(string Token, string HeaderName);

/// <summary>The account routes of IMPLEMENTATION_PLAN.md (Phase 2, API contracts).</summary>
public static class AccountEndpoints
{
    public static void MapAccount(this RouteGroupBuilder api)
    {
        var account = api.MapGroup("/account").WithTags("Account");

        account.MapPost("/register", async Task<Results<Accepted, ProblemHttpResult>> (RegisterRequest body, AccountService service, HttpContext http) =>
            {
                var lang = body.Locale is "ar" ? "ar" : "en";
                var result = await service.RegisterAsync(body.Email ?? "", body.DisplayName ?? "", body.Password ?? "", lang, body.ReturnUrl, http);
                return result.Ok ? TypedResults.Accepted((string?)null) : Problems.From(result.Failure!);
            })
            .WithName("register").AllowAnonymous().RequireRateLimiting(RateLimits.SignIn);

        account.MapPost("/confirm", async Task<Results<NoContent, ProblemHttpResult>> (ConfirmRequest body, AccountService service, HttpContext http) =>
            {
                var result = await service.ConfirmAsync(body.UserId, body.Code ?? "", http);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("confirmEmail").AllowAnonymous().RequireRateLimiting(RateLimits.SignIn);

        account.MapPost("/password/forgot", async (ForgotRequest body, AccountService service, HttpContext http) =>
            {
                await service.ForgotAsync(body.Email ?? "", body.Locale is "ar" ? "ar" : "en", body.ReturnUrl, http);
                return TypedResults.Accepted((string?)null);
            })
            .WithName("forgotPassword").AllowAnonymous().RequireRateLimiting(RateLimits.SignIn);

        account.MapPost("/password/reset", async Task<Results<NoContent, ProblemHttpResult>> (ResetRequest body, AccountService service, HttpContext http) =>
            {
                var result = await service.ResetAsync(body.UserId, body.Code ?? "", body.Password ?? "", http);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("resetPassword").AllowAnonymous().RequireRateLimiting(RateLimits.SignIn);

        // The web app reads this to know whether it is signed in; 401 when it is not.
        account.MapGet("/me", async Task<Results<Ok<Me>, ProblemHttpResult>> (AccountService service, HttpContext http) =>
            {
                var user = await service.CurrentAsync(http.User);
                if (user is null) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
                return TypedResults.Ok(new Me(user.Id, user.Email!, user.DisplayName, user.Locale, http.User.DeviceId(), $"{service.PublicUrl(http)}/account/signin"));
            })
            .WithName("getMe").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        account.MapPatch("/me", async Task<Results<NoContent, ProblemHttpResult>> (MeUpdate body, AccountService service, CgwDb db, HttpContext http) =>
            {
                var user = await service.CurrentAsync(http.User);
                if (user is null) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
                if (body.DisplayName is { } name)
                {
                    name = name.Trim();
                    if (name.Length is 0 or > 200) return Problems.Of(Codes.RequestInvalid, 400, "A name of 1 to 200 characters is needed");
                    user.DisplayName = name;
                }
                if (body.Locale is { } locale)
                {
                    if (locale is not ("en" or "ar")) return Problems.Of(Codes.RequestInvalid, 400, "The language is en or ar");
                    user.Locale = locale;
                }
                await db.SaveChangesAsync();
                return TypedResults.NoContent();
            })
            .WithName("updateMe").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        // A token for the X-CSRF-TOKEN header on the web app's writes (D16).
        account.MapGet("/antiforgery", (IAntiforgery antiforgery, HttpContext http) =>
            {
                var tokens = antiforgery.GetAndStoreTokens(http);
                return TypedResults.Ok(new CsrfToken(tokens.RequestToken!, ApiServices.CsrfHeader));
            })
            .WithName("getAntiforgeryToken").AllowAnonymous().RequireRateLimiting(RateLimits.User);

        account.MapPost("/signout", async (AccountService service, HttpContext http) =>
            {
                await service.SignOutAsync(http);
                return TypedResults.NoContent();
            })
            .WithName("signOut").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        account.MapGet("/devices", async (CgwDb db, HttpContext http) =>
            {
                var userId = http.User.UserId()!.Value;
                var current = http.User.DeviceId();
                var list = await db.Devices.AsNoTracking().Where(d => d.UserId == userId && d.RevokedAt == null)
                    .OrderByDescending(d => d.LastSeenAt).ToListAsync();
                return TypedResults.Ok(list.Select(d => new DeviceInfo(d.Id, d.Name, d.Platform, d.CreatedAt, d.LastSeenAt, d.Id == current)).ToList());
            })
            .WithName("listDevices").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        account.MapDelete("/devices/{id:guid}", async Task<Results<NoContent, ProblemHttpResult>> (Guid id, Devices devices, AccountService service, HttpContext http) =>
            {
                var userId = http.User.UserId()!.Value;
                if (!await devices.RevokeAsync(userId, id, http.Actor())) return Problems.From(Failure.NotFound("No such device"));
                if (id == http.User.DeviceId()) await service.SignOutAsync(http);
                return TypedResults.NoContent();
            })
            .WithName("revokeDevice").RequireAuthorization().RequireRateLimiting(RateLimits.User);
    }
}
