using System.Security.Claims;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Primitives;
using OpenIddict.Abstractions;
using OpenIddict.Server.AspNetCore;
using Microsoft.AspNetCore;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Cgw.Api.Identity;

/// <summary>
/// The desktop app's sign-in (D16): authorisation code with PKCE through the system browser,
/// returning to a loopback listener. The browser signs in on the account pages; this endpoint then
/// makes a device and a permanent authorisation, so signing the device out revokes its tokens.
/// Access tokens last 15 minutes; refresh tokens 30 days, rolled on use.
/// </summary>
public static class ConnectEndpoints
{
    private static readonly string[] Allowed = [Scopes.OfflineAccess, "workspace"];

    public static void MapConnect(this WebApplication app)
    {
        var connect = app.MapGroup("/connect").ExcludeFromDescription();

        connect.MapMethods("/authorize", ["GET", "POST"], async (
            HttpContext http,
            UserManager<User> users,
            Devices devices,
            IOpenIddictApplicationManager applications,
            IOpenIddictAuthorizationManager authorizations,
            CgwDb db,
            Audit audit) =>
        {
            var request = http.GetOpenIddictServerRequest() ?? throw new InvalidOperationException("Not an OpenID Connect request.");
            var cookie = await http.AuthenticateAsync(IdentityConstants.ApplicationScheme);
            var user = cookie.Succeeded ? await users.GetUserAsync(cookie.Principal!) : null;
            if (user is null || user.DeletedAt is not null || request.HasPromptValue(PromptValues.Login))
            {
                if (request.HasPromptValue(PromptValues.None))
                    return Forbid(Errors.LoginRequired, "The user is not signed in.");
                // Sign in, then come back here with the same parameters.
                var parameters = http.Request.HasFormContentType
                    ? http.Request.Form.Where(p => p.Key != "prompt").ToList()
                    : http.Request.Query.Where(p => p.Key != "prompt").ToList();
                var back = "/connect/authorize" + QueryString.Create(parameters.Select(p => new KeyValuePair<string, StringValues>(p.Key, p.Value)));
                var lang = request["ui_locales"]?.ToString() is { } locales && locales.StartsWith("ar", StringComparison.Ordinal) ? "ar" : "en";
                return Results.Redirect($"/account/signin?lang={lang}&returnUrl={Uri.EscapeDataString(back)}");
            }

            var application = await applications.FindByClientIdAsync(request.ClientId!)
                ?? throw new InvalidOperationException("The client is not registered.");
            var name = request["device_name"]?.ToString();
            var device = await devices.CreateAsync(user.Id, "desktop", string.IsNullOrWhiteSpace(name) ? "Desktop" : name);

            var identity = Identity(user, device.Id);
            identity.SetScopes(request.GetScopes().Intersect(Allowed));
            var authorization = await authorizations.CreateAsync(
                identity: identity,
                subject: user.Id.ToString(),
                client: (await applications.GetIdAsync(application))!,
                type: AuthorizationTypes.Permanent,
                scopes: identity.GetScopes());
            var authorizationId = await authorizations.GetIdAsync(authorization);
            identity.SetAuthorizationId(authorizationId);
            device.AuthorizationId = Guid.Parse(authorizationId!);
            db.Devices.Update(device);
            audit.Add(http.Actor() with { UserId = user.Id }, "signin", targetType: "device", targetId: device.Id, detail: new { platform = "desktop" });
            await db.SaveChangesAsync();
            return Results.SignIn(new ClaimsPrincipal(identity), properties: null, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        }).AllowAnonymous().RequireRateLimiting(RateLimits.SignIn);

        connect.MapPost("/token", async (HttpContext http, UserManager<User> users, CgwDb db, Devices devices) =>
        {
            var request = http.GetOpenIddictServerRequest() ?? throw new InvalidOperationException("Not an OpenID Connect request.");
            if (!request.IsAuthorizationCodeGrantType() && !request.IsRefreshTokenGrantType())
                return Forbid(Errors.UnsupportedGrantType, "Only the authorisation code and refresh token grants are allowed.");
            var result = await http.AuthenticateAsync(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
            var principal = result.Principal ?? throw new InvalidOperationException("No principal.");
            var user = await users.FindByIdAsync(principal.GetClaim(Claims.Subject) ?? "");
            var deviceId = Guid.TryParse(principal.GetClaim(AccountService.DeviceClaim), out var id) ? id : Guid.Empty;
            var device = await db.Devices.AsNoTracking().FirstOrDefaultAsync(d => d.Id == deviceId);
            if (user is null || user.DeletedAt is not null || await users.IsLockedOutAsync(user)
                || device is null || device.UserId != user.Id || device.RevokedAt is not null)
                return Forbid(Errors.InvalidGrant, "The device is signed out.");
            await devices.TouchAsync(device.Id);
            var identity = Identity(user, device.Id);
            identity.SetScopes(principal.GetScopes());
            identity.SetAuthorizationId(principal.GetAuthorizationId());
            return Results.SignIn(new ClaimsPrincipal(identity), properties: null, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        }).AllowAnonymous().RequireRateLimiting(RateLimits.SignIn);

        // The desktop signs out by revoking its refresh token (/connect/revoke) and its device
        // (DELETE /api/v1/account/devices/{id}); this ends the browser's own session too.
        connect.MapMethods("/logout", ["GET", "POST"], async (HttpContext http, SignInManager<User> signIn) =>
        {
            await signIn.SignOutAsync();
            return Results.SignOut(properties: new AuthenticationProperties { RedirectUri = "/account/signin" },
                authenticationSchemes: [OpenIddictServerAspNetCoreDefaults.AuthenticationScheme]);
        }).AllowAnonymous();
    }

    private static ClaimsIdentity Identity(User user, Guid deviceId)
    {
        var identity = new ClaimsIdentity(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme, Claims.Name, Claims.Role);
        identity.SetClaim(Claims.Subject, user.Id.ToString())
            .SetClaim(Claims.Email, user.Email)
            .SetClaim(Claims.Name, user.DisplayName)
            .SetClaim(AccountService.DeviceClaim, deviceId.ToString());
        identity.SetDestinations(_ => [Destinations.AccessToken]);
        return identity;
    }

    private static IResult Forbid(string error, string description) =>
        Results.Forbid(
            new AuthenticationProperties(new Dictionary<string, string?>
            {
                [OpenIddictServerAspNetCoreConstants.Properties.Error] = error,
                [OpenIddictServerAspNetCoreConstants.Properties.ErrorDescription] = description,
            }),
            [OpenIddictServerAspNetCoreDefaults.AuthenticationScheme]);
}
