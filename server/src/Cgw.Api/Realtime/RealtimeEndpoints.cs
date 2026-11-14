using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Realtime;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Realtime;

/// <summary>
/// The Realtime module (Phase 6 contracts, section 1): the ticket route, the hub on
/// <c>/api/v1/realtime</c> (WebSockets only, no negotiation, the JSON protocol), the relay, and the
/// bench's metrics route outside Production. One node until measured (Q17): nothing here stops a
/// backplane or Azure SignalR Service being added later.
/// </summary>
public static class RealtimeEndpoints
{
    public static IServiceCollection AddCgwRealtime(this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment)
    {
        services.AddSingleton(RealtimeSettings.From(configuration, environment));
        services.AddSingleton<RealtimeRegistry>();
        services.AddSingleton<RelayMetrics>();
        services.AddSingleton<HubPushBudget>();
        services.AddScoped<RealtimeTickets>();
        services.AddSingleton<RealtimeRelay>();
        services.AddHostedService(provider => provider.GetRequiredService<RealtimeRelay>());
        services.AddSignalR(o =>
            {
                o.MaximumReceiveMessageSize = 2 * 1024 * 1024;
                o.KeepAliveInterval = TimeSpan.FromSeconds(15);
                o.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
                o.EnableDetailedErrors = false;
                o.SupportedProtocols = ["json"];
            })
            .AddJsonProtocol();
        return services;
    }

    /// <summary><c>POST /realtime/tickets</c>, in the <c>/api/v1</c> group (a cookie's write needs its antiforgery header).</summary>
    public static void MapRealtimeTickets(this RouteGroupBuilder api)
    {
        api.MapPost("/realtime/tickets", async Task<Results<Ok<RealtimeTicketDto>, ProblemHttpResult>> (RealtimeTickets tickets, HttpContext http) =>
            {
                // A connection's device must be signed in at connect, and a session without one never is.
                if (http.User.UserId() is not { } userId || http.User.DeviceId() is not { } deviceId)
                    return Problems.Of(Codes.AuthRequired, 401, "Not signed in on a device");
                return TypedResults.Ok(await tickets.IssueAsync(userId, deviceId, http.RequestAborted));
            })
            .WithName("createRealtimeTicket").WithTags("Realtime").RequireAuthorization().RequireRateLimiting(RateLimits.Realtime);
    }

    /// <summary>The hub, and the metrics route where it is allowed.</summary>
    public static void MapCgwRealtime(this WebApplication app)
    {
        app.MapHub<RealtimeHub>(RealtimeGate.Path, o =>
            {
                o.Transports = HttpTransportType.WebSockets;
                o.AllowStatefulReconnects = false;
                // A whole message or frame (2 MB at most) is buffered before either side waits.
                o.ApplicationMaxBufferSize = 2 * 1024 * 1024;
                o.TransportMaxBufferSize = 2 * 1024 * 1024;
            })
            // The ticket's identity only (the gate and the policy scheme route this path to it).
            .RequireAuthorization(new AuthorizationPolicyBuilder(RealtimeTicketHandler.SchemeName).RequireAuthenticatedUser().Build());

        var settings = app.Services.GetRequiredService<RealtimeSettings>();
        if (!settings.Metrics || app.Environment.IsProduction()) return;
        var metrics = app.MapGroup(RealtimeGate.Path + "/metrics").AllowAnonymous().ExcludeFromDescription();
        metrics.MapGet("", (RelayMetrics relay, RealtimeRegistry registry) => TypedResults.Ok(relay.Snapshot(registry)));
        metrics.MapDelete("", (RelayMetrics relay) =>
        {
            relay.Reset();
            return TypedResults.NoContent();
        });
    }
}
