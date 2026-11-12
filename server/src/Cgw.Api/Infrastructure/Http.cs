using System.Globalization;
using System.Security.Claims;
using System.Threading.RateLimiting;
using Cgw.Core;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Cgw.Api.Infrastructure;

/// <summary>
/// A correlation id on every request and response (<c>X-Correlation-Id</c>), in every log line's
/// scope and in every problem body.
/// </summary>
public static class Correlation
{
    public const string Header = "X-Correlation-Id";

    public static IApplicationBuilder UseCorrelation(this IApplicationBuilder app) =>
        app.Use(async (context, next) =>
        {
            var given = context.Request.Headers[Header].FirstOrDefault();
            var id = given is { Length: > 0 and <= 64 } && given.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')
                ? given
                : Guid.CreateVersion7().ToString("N");
            context.TraceIdentifier = id;
            context.Response.Headers[Header] = id;
            var logger = context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Cgw.Request");
            using (logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = id }))
                await next();
        });

    public static Actor Actor(this HttpContext context) =>
        new(context.User.UserId(), context.Connection.RemoteIpAddress?.ToString(), context.TraceIdentifier);
}

/// <summary>RFC 9457 problems with a stable <c>code</c> and the <c>correlationId</c> (ARCHITECTURE.md).</summary>
public static class Problems
{
    public static ProblemHttpResult From(Failure failure) =>
        TypedResults.Problem(
            statusCode: failure.Status,
            title: failure.Title,
            extensions: new Dictionary<string, object?> { ["code"] = failure.Code });

    public static ProblemHttpResult Of(string code, int status, string title) => From(new Failure(code, status, title));

    public static string CodeFor(int status) => status switch
    {
        400 => Codes.RequestInvalid,
        401 => Codes.AuthRequired,
        403 => Codes.AccessDenied,
        404 => Codes.NotFound,
        405 => Codes.RequestInvalid,
        409 => Codes.Conflict,
        410 => Codes.PageGone,
        413 => Codes.LimitSize,
        415 => Codes.RequestInvalid,
        426 => Codes.ClientTooOld,
        429 => Codes.LimitRate,
        _ => Codes.ServerError,
    };

    public static IServiceCollection AddCgwProblems(this IServiceCollection services) =>
        services.AddProblemDetails(options => options.CustomizeProblemDetails = context =>
        {
            var problem = context.ProblemDetails;
            problem.Extensions["correlationId"] = context.HttpContext.TraceIdentifier;
            var status = problem.Status ?? context.HttpContext.Response.StatusCode;
            if (!problem.Extensions.ContainsKey("code")) problem.Extensions["code"] = CodeFor(status);
            // Unexpected failures say nothing about the server's insides.
            if (status >= 500)
            {
                problem.Detail = null;
                problem.Extensions.Remove("exception");
            }
            if (context.Exception is BadHttpRequestException bad && status == 400)
                problem.Title = bad.Message;
        });

    /// <summary>A request body that does not bind is <c>request.invalid</c>, not a 500.</summary>
    public static IApplicationBuilder UseCgwExceptions(this IApplicationBuilder app) =>
        app.UseExceptionHandler(new ExceptionHandlerOptions
        {
            StatusCodeSelector = exception => exception switch
            {
                BadHttpRequestException bad => bad.StatusCode,
                DbUpdateConcurrencyException => 409,
                _ => 500,
            },
        });
}

public static class Users
{
    /// <summary>The signed-in user, from the cookie or a bearer token.</summary>
    public static Guid? UserId(this ClaimsPrincipal user)
    {
        var value = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub");
        return Guid.TryParse(value, out var id) ? id : null;
    }

    public static Guid? DeviceId(this ClaimsPrincipal user) =>
        Guid.TryParse(user.FindFirstValue("device_id"), out var id) ? id : null;
}

/// <summary>
/// The ASP.NET Core rate limiter (ARCHITECTURE.md, Rate limiting): per IP on anonymous routes,
/// per user on the rest, tighter on sign-in, ticket redemption, push and search. The desktop's
/// token requests (<c>/connect/token</c>, and <c>/connect/revoke</c>, which OpenIddict answers
/// before routing, through the global limiter) have a bucket of their own, so an office behind one
/// address refreshing its tokens does not use up the sign-in forms'. Limits per minute are in
/// configuration (<c>RateLimits__*</c>) so a load test can raise them.
/// </summary>
public static class RateLimits
{
    public const string Anonymous = "anonymous";
    public const string SignIn = "signin";
    public const string Token = "token";
    public const string User = "user";
    public const string Push = "push";
    public const string Search = "search";
    public const string Preview = "preview";

    public static IServiceCollection AddCgwRateLimits(this IServiceCollection services, IConfiguration configuration)
    {
        var limits = configuration.GetSection("RateLimits");
        int Limit(string name, int fallback) => int.TryParse(limits[name], CultureInfo.InvariantCulture, out var n) ? n : fallback;
        string Ip(HttpContext c) => c.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        string Who(HttpContext c) => c.User.UserId()?.ToString() ?? "ip:" + Ip(c);
        RateLimitPartition<string> Window(string key, int permits) =>
            RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = permits,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            });

        return services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = 429;
            options.OnRejected = async (context, ct) =>
            {
                context.HttpContext.Response.Headers.RetryAfter = "60";
                await TypedResults.Problem(statusCode: 429, title: "Too many requests",
                        extensions: new Dictionary<string, object?> { ["code"] = Codes.LimitRate, ["correlationId"] = context.HttpContext.TraceIdentifier })
                    .ExecuteAsync(context.HttpContext);
            };
            options.AddPolicy(Anonymous, c => Window("anon:" + Ip(c), Limit(Anonymous, 120)));
            options.AddPolicy(SignIn, c => Window("signin:" + Ip(c), Limit(SignIn, 20)));
            options.AddPolicy(Token, c => Window("token:" + Ip(c), Limit(Token, 120)));
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(c =>
                c.Request.Path.StartsWithSegments("/connect/revoke")
                    ? Window("revoke:" + Ip(c), Limit(Token, 120))
                    : RateLimitPartition.GetNoLimiter(""));
            options.AddPolicy(User, c => Window("user:" + Who(c), Limit(User, 1200)));
            options.AddPolicy(Push, c => Window("push:" + Who(c), Limit(Push, 600)));
            options.AddPolicy(Search, c => Window("search:" + Who(c), Limit(Search, 240)));
            options.AddPolicy(Preview, c => Window("preview:" + Who(c), Limit(Preview, 60)));
        });
    }
}

public sealed class SqlHealth(CgwDb db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default) =>
        await db.Database.CanConnectAsync(ct) ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy("SQL Server is unreachable");
}

public sealed class BlobHealth(BlobStore blob) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        try
        {
            return (await blob.Container.ExistsAsync(ct)).Value ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy("The container is missing");
        }
        catch (Exception e)
        {
            return HealthCheckResult.Unhealthy("Blob storage is unreachable", e);
        }
    }
}

/// <summary>The worker's jobs ran recently: pulls work without it, but new edits wait (Q20).</summary>
public sealed class WorkerHealth(CgwDb db, TimeProvider clock) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        var validate = await db.JobStates.AsNoTracking().FirstOrDefaultAsync(j => j.Name == "validate", ct);
        if (validate?.LastOkAt is not { } ok) return HealthCheckResult.Degraded("The worker has not run");
        var lag = clock.GetUtcNow() - ok;
        return lag < TimeSpan.FromMinutes(1)
            ? HealthCheckResult.Healthy($"validated {lag.TotalSeconds:0}s ago")
            : HealthCheckResult.Degraded($"The worker last validated {lag.TotalMinutes:0} minutes ago");
    }
}
