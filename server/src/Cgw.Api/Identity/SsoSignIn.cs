using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Workspaces;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Cgw.Api.Identity;

/// <summary>Why a sign-in through a workspace's provider did not happen; the page says each in words.</summary>
public enum SsoRefusal
{
    None,
    /// <summary>No verified domain with a provider for the address (the same answer for an unknown domain).</summary>
    NoProvider,
    /// <summary>The provider could not be reached (its discovery, its keys or its token endpoint).</summary>
    Unavailable,
    /// <summary>No state cookie, or another state, or one used before: start again.</summary>
    Expired,
    /// <summary>The person cancelled at the provider (<c>access_denied</c>).</summary>
    Cancelled,
    /// <summary>The provider refused (another error, the code exchange) or changed meanwhile.</summary>
    Provider,
    /// <summary>The id token failed a check (signature, issuer, audience, expiry, nonce, algorithm).</summary>
    Token,
    NoEmail,
    Unverified,
    /// <summary>The address is not in a verified domain of the workspace.</summary>
    Outside,
    /// <summary>The account could not be made or used (a deleted one, an address Identity refuses).</summary>
    Account,
}

/// <summary>Where a sign-on step goes next: a redirect, or the refusal shown on the page (in <c>Lang</c>, keeping <c>ReturnUrl</c>).</summary>
public sealed record SsoOutcome(string? RedirectTo, SsoRefusal Refusal, string Lang, string? ReturnUrl);

/// <summary>What the callback needs, kept in the state cookie under Data Protection (purpose <c>Cgw.Sso.State.v1</c>), ten minutes.</summary>
internal sealed record SsoState(string State, string Nonce, string Verifier, Guid WorkspaceId, string Issuer, string ClientId, string? ReturnUrl, string Lang);

/// <summary>
/// Phase 11 (M11.3): signing in through a workspace's OpenID Connect provider, on the API's own
/// pages. <see cref="StartAsync"/> finds the address's verified domain and its workspace's provider
/// and sends the browser there (the code flow with PKCE S256, <c>state</c>, <c>nonce</c> and
/// <c>login_hint</c>; what the callback needs in a cookie under Data Protection, <c>HttpOnly</c>,
/// <c>Lax</c>, ten minutes, one use). <see cref="CallbackAsync"/> checks the state (once), exchanges
/// the code (the client secret by <c>client_secret_basic</c> or <c>_post</c> as discovery says),
/// checks the id token in full against the provider's published keys, then the address: present,
/// not unverified, in a verified domain of the workspace. Then the account: linked by (provider,
/// <c>sub</c>) in <c>UserLogins</c>; else the account with that address, linked; else a new one with
/// no password. A first sign-in joins the workspace as a member when it lets its people. Then the
/// one session path every sign-in takes (<see cref="AccountService.SignInSessionAsync"/>, a device),
/// ending <c>SessionHours</c> after this sign-in. An owner's sign-in marks the provider tested.
/// Nothing of the code, the tokens or the secret is logged, audited or shown.
/// </summary>
public sealed class SsoSignIn(
    CgwDb db,
    SsoMetadata metadata,
    SsoSecrets secrets,
    UserManager<User> users,
    SignInManager<User> signIn,
    AccountService accounts,
    WorkspaceService workspaces,
    IDataProtectionProvider protection,
    CookieNames cookies,
    Shortcuts shortcuts,
    Audit audit,
    TimeProvider clock,
    ILogger<SsoSignIn> log)
{
    public const string StatePurpose = "Cgw.Sso.State.v1";
    public const string CallbackPath = "/account/sso/callback";
    public static readonly TimeSpan StateLifetime = TimeSpan.FromMinutes(10);

    /// <summary>The id token's algorithms: RSA, ECDSA and RSA-PSS only; never <c>none</c>, never a shared secret (HS*).</summary>
    public static readonly string[] Algorithms =
    [
        SecurityAlgorithms.RsaSha256, SecurityAlgorithms.RsaSha384, SecurityAlgorithms.RsaSha512,
        SecurityAlgorithms.EcdsaSha256, SecurityAlgorithms.EcdsaSha384, SecurityAlgorithms.RsaSsaPssSha256,
    ];

    public static readonly TimeSpan Skew = TimeSpan.FromMinutes(2);

    public static string RedirectUri(string publicUrl) => publicUrl.TrimEnd('/') + CallbackPath;

    private ITimeLimitedDataProtector Protector => protection.CreateProtector(StatePurpose).ToTimeLimitedDataProtector();

    private CookieOptions StateCookie(HttpContext http) => new()
    {
        HttpOnly = true,
        Secure = !shortcuts.AllowHttp || http.Request.IsHttps,
        SameSite = SameSiteMode.Lax,
        Path = "/",
        IsEssential = true,
    };

    private static string Random() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private static bool Same(string? a, string b) =>
        a is not null && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    /// <summary>The verified domain's workspace and its provider, of a workspace not deleted.</summary>
    private async Task<SsoProvider?> ProviderForAsync(string domain, CancellationToken ct)
    {
        var workspace = await db.SsoDomains.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.Domain == domain && d.VerifiedAt != null)
            .Where(d => db.Workspaces.Any(w => w.Id == d.WorkspaceId && w.DeletedAt == null))
            .Select(d => (Guid?)d.WorkspaceId)
            .FirstOrDefaultAsync(ct);
        return workspace is { } id
            ? await db.SsoProviders.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(p => p.WorkspaceId == id, ct)
            : null;
    }

    /// <summary>
    /// "Sign in with your organisation's account": the address's provider, the browser sent there.
    /// The same refusal for an address of no domain, of an unverified one, and of one with no provider.
    /// </summary>
    public async Task<SsoOutcome> StartAsync(string? email, string? returnUrl, string lang, HttpContext http, CancellationToken ct = default)
    {
        var typed = email?.Trim() ?? "";
        if (typed.Length > 256 || SsoText.EmailDomain(typed) is not { } domain || await ProviderForAsync(domain, ct) is not { } provider)
            return new SsoOutcome(null, SsoRefusal.NoProvider, lang, returnUrl);
        if (await metadata.GetAsync(provider.Issuer, ct) is not { } discovery)
            return new SsoOutcome(null, SsoRefusal.Unavailable, lang, returnUrl);
        var state = new SsoState(Random(), Random(), Random(), provider.WorkspaceId, provider.Issuer, provider.ClientId, returnUrl, lang);
        http.Response.Cookies.Append(cookies.Sso, Protector.Protect(JsonSerializer.Serialize(state), StateLifetime),
            new CookieOptions(StateCookie(http)) { MaxAge = StateLifetime });
        var challenge = WebEncoders.Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(state.Verifier)));
        var url = QueryHelpers.AddQueryString(discovery.AuthorizationEndpoint, new Dictionary<string, string?>
        {
            ["response_type"] = "code",
            ["client_id"] = provider.ClientId,
            ["redirect_uri"] = RedirectUri(accounts.PublicUrl(http)),
            ["scope"] = "openid email profile",
            ["state"] = state.State,
            ["nonce"] = state.Nonce,
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
            ["login_hint"] = typed,
            ["response_mode"] = "query",
            ["ui_locales"] = lang,
        });
        return new SsoOutcome(url, SsoRefusal.None, lang, returnUrl);
    }

    /// <summary>The provider's answer: a session and where to go on, or why not.</summary>
    public async Task<SsoOutcome> CallbackAsync(HttpContext http, CancellationToken ct = default)
    {
        var lang = AccountService.Language(null, http);
        // The cookie goes whatever happens: one use.
        var raw = http.Request.Cookies[cookies.Sso];
        http.Response.Cookies.Delete(cookies.Sso, StateCookie(http));
        SsoState? state = null;
        if (!string.IsNullOrEmpty(raw))
            try
            {
                state = JsonSerializer.Deserialize<SsoState>(Protector.Unprotect(raw));
            }
            catch (Exception e) when (e is CryptographicException or JsonException or FormatException)
            {
                state = null;
            }
        var query = http.Request.Query;
        string? One(string name) => query.TryGetValue(name, out var values) && values.Count == 1 ? values[0] : null;
        if (state is null) return await RefuseAsync(http, null, SsoRefusal.Expired, "no state cookie", lang, null);
        lang = state.Lang;
        var ws = state.WorkspaceId;
        async Task<SsoOutcome> Refuse(SsoRefusal refusal, string reason) => await RefuseAsync(http, ws, refusal, reason, lang, state.ReturnUrl);

        if (!Same(One("state"), state.State)) return await Refuse(SsoRefusal.Expired, "another state");
        var now = clock.GetUtcNow();
        if (!await OneUse.TakeAsync(db, SHA256.HashData(Encoding.UTF8.GetBytes("sso-state\n" + state.State)), now, now + StateLifetime + TimeSpan.FromMinutes(1)))
            return await Refuse(SsoRefusal.Expired, "state used before");

        var provider = await db.SsoProviders.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(p => p.WorkspaceId == ws, ct);
        if (provider is null || provider.Issuer != state.Issuer || provider.ClientId != state.ClientId
            || !await db.Workspaces.AnyAsync(w => w.Id == ws && w.DeletedAt == null, ct))
            return await Refuse(SsoRefusal.Provider, "the provider changed");
        if (await metadata.GetAsync(provider.Issuer, ct) is not { } discovery) return await Refuse(SsoRefusal.Unavailable, "discovery");
        // RFC 9207: the issuer the answer names must be this provider (no mix-up with another).
        var iss = One("iss");
        if (iss is not null ? iss != provider.Issuer : discovery.IssParameterSupported) return await Refuse(SsoRefusal.Provider, "iss");
        if (One("error") is { } error)
            return await Refuse(error == "access_denied" ? SsoRefusal.Cancelled : SsoRefusal.Provider, "error " + Word(error));
        if (One("code") is not { Length: > 0 and <= 4096 } code) return await Refuse(SsoRefusal.Provider, "no code");

        string? secret = null;
        if (provider.SecretCipher is { } cipher && (secret = secrets.Unprotect(ws, cipher)) is null)
            return await Refuse(SsoRefusal.Provider, "the client secret could not be read: an owner enters it again");
        var (idToken, exchange, exchangeReason) = await ExchangeAsync(discovery, provider.ClientId, secret, code, RedirectUri(accounts.PublicUrl(http)), state.Verifier, ct);
        if (idToken is null) return await Refuse(exchange, exchangeReason);
        var (token, checkReason) = await CheckAsync(idToken, discovery, provider.ClientId, state.Nonce, ct);
        if (token is null) return await Refuse(SsoRefusal.Token, checkReason);

        // The address: present, not unverified, in a verified domain of this workspace.
        if (!token.TryGetClaim("email", out var emailClaim) || string.IsNullOrWhiteSpace(emailClaim.Value)) return await Refuse(SsoRefusal.NoEmail, "no email");
        if (token.TryGetClaim("email_verified", out var verified) && string.Equals(verified.Value, "false", StringComparison.OrdinalIgnoreCase))
            return await Refuse(SsoRefusal.Unverified, "email_verified false");
        var email = SsoText.Email(emailClaim.Value);
        var domain = SsoText.EmailDomain(email);
        if (email is null || email.Length > 256 || domain is null
            || !await db.SsoDomains.IgnoreQueryFilters([CgwDb.Tenant]).AnyAsync(d => d.WorkspaceId == ws && d.Domain == domain && d.VerifiedAt != null, ct))
            return await Refuse(SsoRefusal.Outside, "email outside the domains");

        var name = token.TryGetClaim("name", out var nameClaim) ? CleanName(nameClaim.Value) : null;
        var user = await AccountAsync(ws, token.Subject, email, name ?? CleanName(email[..email.LastIndexOf('@')]) ?? email, lang, http, ct);
        if (user is null) return await Refuse(SsoRefusal.Account, "the account could not be made or used");
        if (!await signIn.CanSignInAsync(user)) return await Refuse(SsoRefusal.Account, "the account may not sign in");

        var actor = http.Actor() with { UserId = user.Id };
        if (provider.JoinAsMember) await workspaces.JoinThroughSignOnAsync(ws, user.Id, actor, ct);
        // An owner's sign-in proves the provider works: required sign-on may be turned on now.
        if (provider.TestedAt is null && await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .AnyAsync(m => m.WorkspaceId == ws && m.UserId == user.Id && m.Role == Roles.Owner, ct))
        {
            var marked = await db.SsoProviders.IgnoreQueryFilters([CgwDb.Tenant])
                .Where(p => p.WorkspaceId == ws && p.TestedAt == null && p.Version == provider.Version)
                .ExecuteUpdateAsync(s => s.SetProperty(p => p.TestedAt, now).SetProperty(p => p.TestedBy, user.Id), ct);
            if (marked == 1) await audit.WriteAsync(actor, "sso.provider.tested", ws, "workspace", ws, new { issuer = provider.Issuer });
        }
        await accounts.SignInSessionAsync(user, AccountService.Methods.Sso, http, sso: new SsoSession(ws, now, now + TimeSpan.FromHours(provider.SessionHours)));
        return new SsoOutcome(accounts.SafeReturn(state.ReturnUrl), SsoRefusal.None, lang, state.ReturnUrl);
    }

    private async Task<SsoOutcome> RefuseAsync(HttpContext http, Guid? workspaceId, SsoRefusal refusal, string reason, string lang, string? returnUrl)
    {
        log.LogWarning("Single sign-on refused for workspace {Workspace}: {Refusal} ({Reason})", workspaceId, refusal, reason);
        await audit.WriteAsync(http.Actor(), "signin.fail", workspaceId, workspaceId is null ? null : "workspace", workspaceId,
            new { method = AccountService.Methods.Sso, refusal = refusal.ToString(), reason });
        return new SsoOutcome(null, refusal, lang, returnUrl);
    }

    /// <summary>An OAuth error code as it may be written down: letters and underscores, at most 40.</summary>
    private static string Word(string value) =>
        new string([.. value.Where(c => char.IsAsciiLetterOrDigit(c) || c == '_').Take(40)]);

    /// <summary>A display name as kept: no control or format characters, trimmed, 1 to 200 characters; null otherwise.</summary>
    private static string? CleanName(string? name)
    {
        if (name is null) return null;
        var clean = new string([.. name.Where(c => char.GetUnicodeCategory(c) is not (System.Globalization.UnicodeCategory.Control or System.Globalization.UnicodeCategory.Format or System.Globalization.UnicodeCategory.LineSeparator or System.Globalization.UnicodeCategory.ParagraphSeparator))]).Trim();
        return clean.Length == 0 ? null : clean.Length > 200 ? clean[..200] : clean;
    }

    /// <summary>
    /// The token request (RFC 6749, 4.1.3): the client by <c>client_secret_basic</c> when the
    /// provider takes it (its id and secret form-encoded before they are joined, 2.3.1), else
    /// <c>client_secret_post</c>; with no secret, the client id alone (a public client).
    /// </summary>
    internal static HttpRequestMessage TokenRequest(SsoDiscovery discovery, string clientId, string? secret, string code, string redirectUri, string verifier)
    {
        var fields = new List<KeyValuePair<string, string>>
        {
            new("grant_type", "authorization_code"),
            new("code", code),
            new("redirect_uri", redirectUri),
            new("code_verifier", verifier),
        };
        var request = new HttpRequestMessage(HttpMethod.Post, discovery.TokenEndpoint);
        switch (AuthMethod(discovery, secret))
        {
            case "client_secret_basic":
                request.Headers.Authorization = new AuthenticationHeaderValue("Basic",
                    Convert.ToBase64String(Encoding.UTF8.GetBytes(FormEncode(clientId) + ":" + FormEncode(secret!))));
                break;
            case "client_secret_post":
                fields.Add(new("client_id", clientId));
                fields.Add(new("client_secret", secret!));
                break;
            default:
                fields.Add(new("client_id", clientId));
                break;
        }
        request.Content = new FormUrlEncodedContent(fields);
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    /// <summary><c>client_secret_basic</c> when offered (the specification's default), else <c>client_secret_post</c>; <c>none</c> without a secret.</summary>
    internal static string AuthMethod(SsoDiscovery discovery, string? secret) =>
        secret is null ? "none"
        : discovery.TokenAuthMethods.Contains("client_secret_basic") ? "client_secret_basic"
        : discovery.TokenAuthMethods.Contains("client_secret_post") ? "client_secret_post"
        : "none";

    /// <summary>application/x-www-form-urlencoded, as RFC 6749 Appendix B has it (a space as <c>+</c>).</summary>
    internal static string FormEncode(string value) => Uri.EscapeDataString(value).Replace("%20", "+", StringComparison.Ordinal);

    private async Task<(string? IdToken, SsoRefusal Refusal, string Reason)> ExchangeAsync(SsoDiscovery discovery, string clientId, string? secret, string code, string redirectUri, string verifier, CancellationToken ct)
    {
        using var request = TokenRequest(discovery, clientId, secret, code, redirectUri, verifier);
        HttpResponseMessage response;
        try
        {
            response = await metadata.Http.SendAsync(request, ct);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return (null, SsoRefusal.Unavailable, "the token endpoint could not be reached");
        }
        using (response)
        {
            string body;
            try
            {
                body = await response.Content.ReadAsStringAsync(ct);
            }
            catch (HttpRequestException)
            {
                return (null, SsoRefusal.Provider, "the token answer could not be read");
            }
            JsonElement root = default;
            try
            {
                using var json = JsonDocument.Parse(body);
                root = json.RootElement.Clone();
            }
            catch (JsonException)
            {
            }
            if (!response.IsSuccessStatusCode)
            {
                var error = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? Word(e.GetString()!) : "";
                return (null, SsoRefusal.Provider, $"the token endpoint answered {(int)response.StatusCode} {error}".Trim());
            }
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("id_token", out var idToken) || idToken.ValueKind != JsonValueKind.String)
                return (null, SsoRefusal.Provider, "no id_token");
            return (idToken.GetString(), SsoRefusal.None, "");
        }
    }

    private static TokenValidationParameters Parameters(SsoDiscovery discovery, string clientId) => new()
    {
        ValidIssuer = discovery.Issuer,
        ValidateIssuer = true,
        ValidAudience = clientId,
        ValidateAudience = true,
        ValidateLifetime = true,
        RequireExpirationTime = true,
        RequireSignedTokens = true,
        IssuerSigningKeys = discovery.SigningKeys,
        ValidAlgorithms = Algorithms,
        ClockSkew = Skew,
    };

    /// <summary>
    /// The id token, checked in full (OpenID Connect Core 1.0, 3.1.3.7): its signature by one of the
    /// provider's published keys (asked again once when it names a key not held), an allowed
    /// algorithm, the issuer, the audience (and <c>azp</c>), its lifetime with two minutes of skew,
    /// the nonce, a subject. The reason is a word for the audit, never the token.
    /// </summary>
    private async Task<(JsonWebToken? Token, string Reason)> CheckAsync(string idToken, SsoDiscovery discovery, string clientId, string nonce, CancellationToken ct)
    {
        var handler = new JsonWebTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(idToken, Parameters(discovery, clientId));
        if (!result.IsValid && result.Exception is SecurityTokenSignatureKeyNotFoundException && await metadata.RefreshAsync(discovery.Issuer, ct) is { } fresh)
            result = await handler.ValidateTokenAsync(idToken, Parameters(fresh, clientId));
        if (!result.IsValid || result.SecurityToken is not JsonWebToken token)
            return (null, result.Exception?.GetType().Name ?? "invalid");
        var audiences = token.Audiences.ToList();
        var azp = token.TryGetClaim("azp", out var party) ? party.Value : null;
        if ((audiences.Count > 1 && azp is null) || (azp is not null && azp != clientId)) return (null, "azp");
        if (!token.TryGetClaim("nonce", out var said) || !Same(said.Value, nonce)) return (null, "nonce");
        if (string.IsNullOrEmpty(token.Subject) || token.Subject.Length > 255 || token.Subject.Any(char.IsControl)) return (null, "sub");
        return (token, "");
    }

    /// <summary>
    /// The account the provider vouches for: linked by (provider, <c>sub</c>); else the account with
    /// the address, linked (one never confirmed loses the password whoever made it chose, as a reset
    /// would); else a new one, confirmed, with no password. Null when none can be used.
    /// </summary>
    private async Task<User?> AccountAsync(Guid workspaceId, string sub, string email, string name, string lang, HttpContext http, CancellationToken ct)
    {
        var login = SsoText.LoginProvider(workspaceId);
        var user = await users.FindByLoginAsync(login, sub);
        if (user is not null) return user.DeletedAt is null ? user : null;
        var actor = http.Actor();
        var info = new UserLoginInfo(login, sub, "Single sign-on");
        var existing = await users.FindByEmailAsync(email);
        if (existing is { DeletedAt: null })
        {
            var unconfirmed = !existing.EmailConfirmed;
            if (unconfirmed)
            {
                // Whoever signed up with the address never proved it; the domain's provider has.
                existing.EmailConfirmed = true;
                existing.DisplayName = name;
                existing.Locale = lang;
                var saved = await users.HasPasswordAsync(existing) ? await users.RemovePasswordAsync(existing) : await users.UpdateSecurityStampAsync(existing);
                if (!saved.Succeeded) return null;
            }
            if (!(await users.AddLoginAsync(existing, info)).Succeeded)
                return await users.FindByLoginAsync(login, sub) is { DeletedAt: null } raced ? raced : null;
            await audit.WriteAsync(actor with { UserId = existing.Id }, "sso.link", workspaceId, "user", existing.Id, new { unconfirmed });
            return existing;
        }
        var fresh = new User
        {
            Id = Guid.CreateVersion7(),
            UserName = email,
            Email = email,
            EmailConfirmed = true,
            DisplayName = name,
            Locale = lang,
            CreatedAt = clock.GetUtcNow(),
        };
        var created = await users.CreateAsync(fresh);
        if (!created.Succeeded)
        {
            log.LogWarning("Single sign-on: no account could be made for workspace {Workspace}: {Errors}", workspaceId, string.Join(", ", created.Errors.Select(e => e.Code)));
            return await users.FindByLoginAsync(login, sub) is { DeletedAt: null } raced ? raced : null;
        }
        if (!(await users.AddLoginAsync(fresh, info)).Succeeded) return null;
        audit.Add(actor with { UserId = fresh.Id }, "account.create", targetType: "user", targetId: fresh.Id, detail: new { by = AccountService.Methods.Sso });
        await audit.WriteAsync(actor with { UserId = fresh.Id }, "sso.account", workspaceId, "user", fresh.Id);
        return fresh;
    }
}
