using System.Security.Claims;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Microsoft.AspNetCore;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using OpenIddict.Abstractions;
using OpenIddict.Server.AspNetCore;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Cgw.Api.Identity;

/// <summary>
/// The desktop app's sign-in (D16): authorisation code with PKCE through the system browser,
/// returning to a loopback listener. The browser signs in on the account pages, then the person
/// confirms on a page of this endpoint's own: a public client on a loopback port proves nothing
/// about who it is, so no code is issued without that (RFC 8252, 8.6). Only the confirming POST
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
            IAntiforgery antiforgery,
            IOptions<AntiforgeryOptions> antiforgeryOptions,
            CgwDb db,
            Audit audit) =>
        {
            var request = http.GetOpenIddictServerRequest() ?? throw new InvalidOperationException("Not an OpenID Connect request.");
            // OpenIddict reads a POSTed request from its form: the consent form sends the request
            // back as its fields, with the antiforgery token and the button pressed.
            var tokenField = antiforgeryOptions.Value.FormFieldName;
            var source = http.Request.HasFormContentType
                ? (IEnumerable<KeyValuePair<string, StringValues>>)await http.Request.ReadFormAsync()
                : http.Request.Query;
            var answer = http.Request.HasFormContentType && HttpMethods.IsPost(http.Request.Method)
                ? source.FirstOrDefault(p => p.Key == AccountPages.ConsentField).Value.ToString()
                : "";
            var parameters = source
                .Where(p => p.Key != tokenField && p.Key != AccountPages.ConsentField)
                .SelectMany(p => p.Value.Select(v => KeyValuePair.Create(p.Key, v ?? "")))
                .ToList();
            var lang = AccountService.Language(request["lang"]?.ToString() ?? FromUiLocales(request.UiLocales), http);

            var cookie = await http.AuthenticateAsync(IdentityConstants.ApplicationScheme);
            var user = cookie.Succeeded ? await users.GetUserAsync(cookie.Principal!) : null;
            if (user is null || user.DeletedAt is not null || request.HasPromptValue(PromptValues.Login))
            {
                if (request.HasPromptValue(PromptValues.None))
                    return Forbid(Errors.LoginRequired, "The user is not signed in.");
                // Sign in, then come back here with the same parameters (and confirm then).
                var back = "/connect/authorize" + QueryString.Create(parameters.Where(p => p.Key != "prompt").Select(p => KeyValuePair.Create(p.Key, (string?)p.Value)));
                return Results.Redirect(AccountPages.SignInFor(back, lang));
            }
            // No page may be shown, and nothing is issued without one.
            if (request.HasPromptValue(PromptValues.None))
                return Forbid(Errors.ConsentRequired, "The person must confirm the sign-in.");

            if (answer is not ("accept" or "deny"))
                return AccountPages.Consent(http, antiforgery, lang, user.Email!, parameters, expired: false);
            // The token is tied to this person's session: a page from elsewhere cannot answer for them.
            if (!await antiforgery.IsRequestValidAsync(http))
                return AccountPages.Consent(http, antiforgery, lang, user.Email!, parameters, expired: true);
            if (answer == "deny")
                return Forbid(Errors.AccessDenied, "The sign-in was cancelled.");

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
            // A lockout stops password guessing, not a device already signed in: anyone who knows
            // the address can lock it, and would otherwise sign every desktop out with it.
            if (user is null || user.DeletedAt is not null
                || device is null || device.UserId != user.Id || device.RevokedAt is not null)
                return Forbid(Errors.InvalidGrant, "The device is signed out.");
            await devices.TouchAsync(device.Id);
            var identity = Identity(user, device.Id);
            identity.SetScopes(principal.GetScopes());
            identity.SetAuthorizationId(principal.GetAuthorizationId());
            return Results.SignIn(new ClaimsPrincipal(identity), properties: null, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        }).AllowAnonymous().RequireRateLimiting(RateLimits.Token);

        // The end-session endpoint, as OpenIddict's samples have it: a POST with an antiforgery
        // token (a header or the form's field), never a GET another site can send the browser to.
        // It signs the browser's session out and revokes its device; then it goes to the client's
        // registered post_logout_redirect_uri if one was given, else to the sign-in page. The
        // desktop signs itself out by revoking its refresh token (/connect/revoke) and its device
        // (DELETE /api/v1/account/devices/{id}).
        connect.MapPost("/logout", async (HttpContext http, AccountService service, IAntiforgery antiforgery) =>
        {
            if (!await antiforgery.IsRequestValidAsync(http))
                return Problems.Of(Codes.RequestInvalid, 400, "The antiforgery token is missing or wrong");
            await service.SignOutAsync(http);
            return Results.SignOut(properties: new AuthenticationProperties { RedirectUri = "/account/signin" },
                authenticationSchemes: [OpenIddictServerAspNetCoreDefaults.AuthenticationScheme]);
        }).AllowAnonymous().RequireRateLimiting(RateLimits.SignIn);
    }

    /// <summary>The page language from <c>ui_locales</c>: the first English or Arabic tag.</summary>
    private static string? FromUiLocales(string? locales) =>
        locales?.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(tag => tag.StartsWith("ar", StringComparison.OrdinalIgnoreCase) ? "ar" : tag.StartsWith("en", StringComparison.OrdinalIgnoreCase) ? "en" : null)
            .FirstOrDefault(lang => lang is not null);

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
