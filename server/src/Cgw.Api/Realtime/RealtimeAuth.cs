using System.Security.Claims;
using System.Text.Encodings.Web;
using Cgw.Api.Identity;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Realtime;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Cgw.Api.Realtime;

/// <summary>
/// The hub's identity (Phase 6 contracts, section 1, Connecting): on <c>/api/v1/realtime</c> only,
/// the person and device come from the single-use ticket in <c>?ticket=</c>, used up here; cookies
/// and bearer tokens are never read on this path. The device must still be signed in.
/// </summary>
public sealed class RealtimeTicketHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    RealtimeTickets tickets,
    DeviceGate devices,
    CgwDb db)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "realtime";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!RealtimeGate.IsHub(Request.Path)) return AuthenticateResult.NoResult();
        var holder = await tickets.ConsumeAsync(Request.Query["ticket"].ToString(), Context.RequestAborted);
        if (holder is null) return AuthenticateResult.Fail("The ticket is unknown, used or expired");
        if (holder.DeviceId is not { } device || !await devices.IsActiveAsync(device)) return AuthenticateResult.Fail("The device is signed out");
        if (!await db.Users.AsNoTracking().AnyAsync(u => u.Id == holder.UserId && u.DeletedAt == null, Context.RequestAborted))
            return AuthenticateResult.Fail("The account is gone");
        var identity = new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, holder.UserId.ToString()), new Claim(AccountService.DeviceClaim, device.ToString())],
            SchemeName);
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }
}

/// <summary>
/// In front of authentication on the hub's path: WebSockets only and no negotiation (a ticket is
/// never used up by anything else), and the upgrade's <c>Origin</c> one of <c>Web__Origins</c>,
/// checked before the ticket is read so a refused site cannot use one up. A missing <c>Origin</c>
/// (a non-browser client) is let in only in Development and Testing.
/// </summary>
public static class RealtimeGate
{
    public const string Path = "/api/v1/realtime";

    public static bool IsHub(PathString path) =>
        string.Equals(path.Value?.TrimEnd('/'), Path, StringComparison.OrdinalIgnoreCase);

    private static bool IsNegotiate(PathString path) =>
        path.StartsWithSegments(Path + "/negotiate", StringComparison.OrdinalIgnoreCase);

    public static IApplicationBuilder UseCgwRealtimeGate(this IApplicationBuilder app)
    {
        app.UseWebSockets();
        return app.Use(async (context, next) =>
        {
            var path = context.Request.Path;
            if (IsNegotiate(path))
            {
                await Problems.Of(Codes.NotFound, 404, "The hub takes WebSockets without negotiation").ExecuteAsync(context);
                return;
            }
            if (IsHub(path))
            {
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    await Problems.Of(Codes.RequestInvalid, 400, "The hub takes WebSockets only").ExecuteAsync(context);
                    return;
                }
                var settings = context.RequestServices.GetRequiredService<RealtimeSettings>();
                var origin = context.Request.Headers.Origin.ToString();
                var allowed = origin.Length == 0 ? settings.AllowMissingOrigin : settings.Origins.Contains(origin, StringComparer.Ordinal);
                if (!allowed)
                {
                    await Problems.Of(Codes.OriginDenied, 403, "This site may not open the hub").ExecuteAsync(context);
                    return;
                }
            }
            await next();
        });
    }
}
