using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Identity;

/// <summary>A passkey of the signed-in account, as Settings lists it. <c>Id</c> is the credential id, base64url.</summary>
public sealed record PasskeyDto(string Id, string Name, DateTimeOffset CreatedAt, DateTimeOffset? LastUsedAt);
public sealed record PasskeyList(IReadOnlyList<PasskeyDto> Passkeys);
public sealed record PasskeyRename(string? Name);

/// <summary>What became of a creation ceremony's answer.</summary>
public enum PasskeyAdded
{
    Added,
    /// <summary>The answer did not verify (origin, relying party, challenge, user verification, signature), or was used before.</summary>
    Refused,
    /// <summary>The credential is on an account already (this one or another): never written over.</summary>
    Taken,
    /// <summary>The account has <see cref="Passkeys.Max"/> already.</summary>
    Limit,
    /// <summary>The name is longer than <see cref="Passkeys.NameMax"/> characters.</summary>
    BadName,
}

/// <summary>
/// Phase 11 (M11.2): passkeys' settings. The relying party is the API's own host: in Production
/// <c>Identity__Passkeys__ServerDomain</c> (the API does not start without it, ProductionChecks),
/// elsewhere the request's host when unset, so the e2e stack works on <c>localhost</c> while the rest
/// of development is on 127.0.0.1. The only origin a ceremony may come from is the API's own: the
/// origin of <c>Api__PublicUrl</c>, and on a developer's machine the request's own. User
/// verification and discoverable credentials are required; no attestation is asked for.
/// </summary>
public static class PasskeySetup
{
    public const string ServerDomainKey = "Identity:Passkeys:ServerDomain";

    /// <summary>How long a ceremony's state lasts between its options and its answer (and the browser waits).</summary>
    public static readonly TimeSpan Ceremony = TimeSpan.FromMinutes(5);

    public static IServiceCollection AddCgwPasskeys(this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment, Shortcuts shortcuts, CookieNames cookies, CookieSecurePolicy secure)
    {
        var serverDomain = configuration[ServerDomainKey] is { Length: > 0 } domain ? domain : null;
        var publicUrl = configuration["Api:PublicUrl"];
        var fromRequest = Shortcuts.IsLocal(environment) || shortcuts.PublicUrlFromRequest;
        services.Configure<IdentityPasskeyOptions>(o =>
        {
            o.ServerDomain = serverDomain;
            o.UserVerificationRequirement = "required";
            o.ResidentKeyRequirement = "required";
            o.AttestationConveyancePreference = "none";
            o.AuthenticatorTimeout = Ceremony;
            o.ValidateOrigin = context => ValueTask.FromResult(OriginAllowed(context.Origin, context.CrossOrigin, context.TopOrigin, context.HttpContext.Request, publicUrl, fromRequest));
        });
        // Identity keeps a ceremony's state in its two-factor cookie (no two-factor sign-in here):
        // named and secured as the session's, Strict, gone after five minutes or its first read.
        services.Configure<CookieAuthenticationOptions>(IdentityConstants.TwoFactorUserIdScheme, o =>
        {
            o.Cookie.Name = cookies.Passkey;
            o.Cookie.Path = "/";
            o.Cookie.HttpOnly = true;
            o.Cookie.SecurePolicy = secure;
            o.Cookie.SameSite = SameSiteMode.Strict;
            o.ExpireTimeSpan = Ceremony;
            o.SlidingExpiration = false;
        });
        return services;
    }

    /// <summary>
    /// A ceremony's origin (its client data's), exactly an origin: the API's public one, or on a
    /// developer's machine the request's own. Never from a frame, never with a top origin.
    /// </summary>
    public static bool OriginAllowed(string? origin, bool crossOrigin, string? topOrigin, HttpRequest request, string? publicUrl, bool fromRequest)
    {
        if (crossOrigin || topOrigin is not null || Origin(origin) is not { } given || !string.Equals(given, origin, StringComparison.OrdinalIgnoreCase)) return false;
        if (Origin(publicUrl) is { } api && string.Equals(api, given, StringComparison.OrdinalIgnoreCase)) return true;
        return fromRequest && Origin($"{request.Scheme}://{request.Host}") is { } own && string.Equals(own, given, StringComparison.OrdinalIgnoreCase);
    }

    private static string? Origin(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "http" ? uri.GetLeftPart(UriPartial.Authority) : null;
}

/// <summary>
/// Phase 11 (M11.2): an account's passkeys, through Identity's own (store schema 3, its passkey
/// handler, <c>SignInManager</c>'s ceremonies). The ceremonies run only on the API's own pages
/// (AccountPages); signing in goes on through <see cref="AccountService.SignInSessionAsync"/>, the
/// path a password takes, so it makes a device. Identity keeps a ceremony's state in a cookie a
/// copied request would carry again: a challenge that succeeded once is written down and refused
/// after. At most <see cref="Max"/> an account, added one at a time.
/// </summary>
public sealed class Passkeys(UserManager<User> users, SignInManager<User> signIn, AccountService accounts, SsoPolicy sso, CgwDb db, Audit audit, TimeProvider clock)
{
    public const int Max = 20;
    public const int NameMax = 60;

    /// <summary>
    /// Signing in with a passkey: its answer verified, the account not deleted, not locked out
    /// and confirmed (as a password's sign-in asks), then the one session path a password takes
    /// (<see cref="AccountService.SignInSessionAsync"/>: a device, the cookie, audited
    /// <c>account.signin</c> with <c>method: "passkey"</c>). Every refusal reads the same.
    /// </summary>
    public async Task<SignInOutcome> SignInAsync(string? credentialJson, HttpContext http)
    {
        var user = await AssertAsync(credentialJson, null, http);
        if (user is null) return SignInOutcome.Invalid;
        if (user.DeletedAt is not null || !await signIn.CanSignInAsync(user))
        {
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.fail", targetType: "user", targetId: user.Id, detail: new { method = AccountService.Methods.Passkey, reason = "notAllowed" });
            return SignInOutcome.Invalid;
        }
        if (await users.IsLockedOutAsync(user))
        {
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.lockedOut", targetType: "user", targetId: user.Id, detail: new { method = AccountService.Methods.Passkey });
            return SignInOutcome.LockedOut;
        }
        // Phase 11: a domain that requires its workspace's provider, unless this is one of its owners.
        if (await sso.RequiredForAsync(user.Email, user.Id) is { } requiring)
        {
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.fail", requiring, "user", user.Id, new { method = AccountService.Methods.Passkey, reason = Codes.SsoRequired });
            return SignInOutcome.SsoRequired;
        }
        await users.ResetAccessFailedCountAsync(user);
        await accounts.SignInSessionAsync(user, AccountService.Methods.Passkey, http);
        return SignInOutcome.Ok;
    }

    /// <summary>A passkey of the signed-in <paramref name="user"/> asked again (deleting the account, adding a passkey); a locked account is refused, as its password is.</summary>
    public async Task<bool> ConfirmAsync(User user, string? credentialJson, HttpContext http)
    {
        if (await AssertAsync(credentialJson, user, http) is null) return false;
        if (!await users.IsLockedOutAsync(user)) return true;
        await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.lockedOut", targetType: "user", targetId: user.Id, detail: new { method = AccountService.Methods.Passkey, reason = "reauthenticate" });
        return false;
    }

    public Task<int> CountAsync(Guid userId) => db.UserPasskeys.CountAsync(p => p.UserId == userId);

    public async Task<List<PasskeyDto>> ListAsync(Guid userId)
    {
        var rows = await db.UserPasskeys.AsNoTracking()
            .Where(p => p.UserId == userId)
            .Select(p => new { p.CredentialId, p.Data.Name, p.Data.CreatedAt, LastUsedAt = EF.Property<DateTimeOffset?>(p, CgwDb.PasskeyLastUsedAt) })
            .ToListAsync();
        return [.. rows.OrderBy(r => r.CreatedAt).Select(r => new PasskeyDto(Id(r.CredentialId), r.Name ?? "Passkey", r.CreatedAt, r.LastUsedAt))];
    }

    /// <summary>Options for <c>navigator.credentials.get</c>: any of the server's passkeys (signing in), or this account's (asked again).</summary>
    public Task<string> RequestOptionsAsync(User? user) => signIn.MakePasskeyRequestOptionsAsync(user);

    /// <summary>Options for <c>navigator.credentials.create</c>, the account's own passkeys excluded. The user handle is the account's id, never its address.</summary>
    public Task<string> CreationOptionsAsync(User user) =>
        signIn.MakePasskeyCreationOptionsAsync(new PasskeyUserEntity
        {
            Id = user.Id.ToString(),
            Name = user.Email!,
            DisplayName = user.DisplayName is { Length: > 0 } name ? name : user.Email!,
        });

    /// <summary>A creation ceremony's answer, for the signed-in <paramref name="user"/>; <paramref name="fallbackName"/> when no name is given.</summary>
    public async Task<PasskeyAdded> AddAsync(User user, string? credentialJson, string? name, string fallbackName, HttpContext http)
    {
        var actor = http.Actor() with { UserId = user.Id };
        var clean = CleanName(name);
        if (!string.IsNullOrWhiteSpace(name) && clean is null) return PasskeyAdded.BadName;
        PasskeyAttestationResult? result = null;
        if (!string.IsNullOrWhiteSpace(credentialJson))
        {
            try
            {
                result = await signIn.PerformPasskeyAttestationAsync(credentialJson);
            }
            catch (Exception e) when (e is JsonException or FormatException or ArgumentException or InvalidOperationException or PasskeyException)
            {
                result = null;
            }
        }
        if (result is not { Succeeded: true, Passkey: not null } || result.UserEntity?.Id != user.Id.ToString())
        {
            await audit.WriteAsync(actor, "account.passkey.refused", targetType: "user", targetId: user.Id, detail: new { ceremony = "create", reason = result?.Failure?.Message });
            return PasskeyAdded.Refused;
        }
        if (!await UseChallengeAsync(credentialJson!))
        {
            await audit.WriteAsync(actor, "account.passkey.refused", targetType: "user", targetId: user.Id, detail: new { ceremony = "create", reason = "challenge used before" });
            return PasskeyAdded.Refused;
        }
        var passkey = result.Passkey;
        // A credential on any account already is refused, never written over: Identity's store
        // would otherwise update that passkey's key in place.
        if (await users.FindByPasskeyIdAsync(passkey.CredentialId) is not null) return PasskeyAdded.Taken;

        await using var tx = await db.Database.BeginTransactionAsync();
        // One account's passkeys are added one at a time, so the count holds when the add commits.
        await db.Database.ExecuteSqlAsync($"SELECT 1 FROM [Users] WITH (UPDLOCK, HOLDLOCK) WHERE [Id] = {GuidBytes.ToBytes(user.Id)}");
        if (await CountAsync(user.Id) >= Max)
        {
            await tx.RollbackAsync();
            return PasskeyAdded.Limit;
        }
        passkey.Name = clean ?? fallbackName;
        var saved = await users.AddOrUpdatePasskeyAsync(user, passkey);
        if (!saved.Succeeded)
        {
            await tx.RollbackAsync();
            return PasskeyAdded.Refused;
        }
        audit.Add(actor, "account.passkey.add", targetType: "user", targetId: user.Id, detail: new { id = Id(passkey.CredentialId), name = passkey.Name });
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        return PasskeyAdded.Added;
    }

    /// <summary>
    /// A request ceremony's answer: the account it proves (one of the server's, signing in; or
    /// <paramref name="expected"/>, asked again), with the passkey's counter and last use written;
    /// null when it does not verify. A wrong answer for a known passkey counts towards its
    /// account's lockout, as a wrong password does. Lockout and a confirmed address are the
    /// caller's to check, as for a password.
    /// </summary>
    public async Task<User?> AssertAsync(string? credentialJson, User? expected, HttpContext http)
    {
        PasskeyAssertionResult<User>? result = null;
        if (!string.IsNullOrWhiteSpace(credentialJson))
        {
            try
            {
                result = await signIn.PerformPasskeyAssertionAsync(credentialJson);
            }
            catch (Exception e) when (e is JsonException or FormatException or ArgumentException or InvalidOperationException or PasskeyException)
            {
                result = null;
            }
        }
        var reason = expected is null ? null : "reauthenticate";
        if (result is not { Succeeded: true, User: not null, Passkey: not null } || (expected is not null && result.User.Id != expected.Id))
        {
            var owner = credentialJson is null ? null : await OwnerAsync(credentialJson);
            if (owner is not null && (expected is null || owner.Id == expected.Id) && owner.DeletedAt is null)
                await users.AccessFailedAsync(owner);
            var who = expected?.Id ?? owner?.Id;
            await audit.WriteAsync(http.Actor() with { UserId = who }, "signin.fail", targetType: who is null ? null : "user", targetId: who,
                detail: new { method = AccountService.Methods.Passkey, reason = reason ?? (owner is null ? "unknown" : null), failure = result?.Failure?.Message });
            return null;
        }
        var user = result.User;
        if (!await UseChallengeAsync(credentialJson!))
        {
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.fail", targetType: "user", targetId: user.Id,
                detail: new { method = AccountService.Methods.Passkey, reason = "challenge used before" });
            return null;
        }
        // Its counter and backup state, as Identity asks, then when it was used.
        await users.AddOrUpdatePasskeyAsync(user, result.Passkey);
        var now = clock.GetUtcNow();
        await db.UserPasskeys.Where(p => p.CredentialId == result.Passkey.CredentialId)
            .ExecuteUpdateAsync(s => s.SetProperty(p => EF.Property<DateTimeOffset?>(p, CgwDb.PasskeyLastUsedAt), now));
        return user;
    }

    public async Task<Result<PasskeyDto>> RenameAsync(User user, string id, string? name, Actor actor)
    {
        if (Decode(id) is not { } credentialId || await users.GetPasskeyAsync(user, credentialId) is not { } passkey)
            return Failure.NotFound("No such passkey");
        if (CleanName(name) is not { } clean) return Failure.Invalid($"A name of 1 to {NameMax} characters is needed");
        var before = passkey.Name;
        passkey.Name = clean;
        var saved = await users.AddOrUpdatePasskeyAsync(user, passkey);
        if (!saved.Succeeded) return Failure.Conflict(Codes.Conflict, "The account changed meanwhile: try again");
        await audit.WriteAsync(actor, "account.passkey.rename", targetType: "user", targetId: user.Id, detail: new { id, name = clean, before });
        return (await ListAsync(user.Id)).First(p => p.Id == id);
    }

    /// <summary>Removed at once: the next ceremony with it finds no passkey. Sessions it signed in stay until signed out (Settings, Devices).</summary>
    public async Task<Result<bool>> RemoveAsync(User user, string id, Actor actor)
    {
        if (Decode(id) is not { } credentialId || await users.GetPasskeyAsync(user, credentialId) is not { } passkey)
            return Failure.NotFound("No such passkey");
        var removed = await users.RemovePasskeyAsync(user, credentialId);
        if (!removed.Succeeded) return Failure.Conflict(Codes.Conflict, "The account changed meanwhile: try again");
        await audit.WriteAsync(actor, "account.passkey.remove", targetType: "user", targetId: user.Id, detail: new { id, name = passkey.Name });
        return true;
    }

    /// <summary>A name as kept: no control, format or line characters, trimmed, 1 to <see cref="NameMax"/> characters; null otherwise.</summary>
    public static string? CleanName(string? name)
    {
        if (name is null) return null;
        var clean = new string([.. name.Where(c => char.GetUnicodeCategory(c) is not (UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator))]).Trim();
        return clean.Length is 0 or > NameMax ? null : clean;
    }

    public static string Id(byte[] credentialId) => WebEncoders.Base64UrlEncode(credentialId);

    private static byte[]? Decode(string id)
    {
        if (id.Length is 0 or > 1400) return null;
        try
        {
            return WebEncoders.Base64UrlDecode(id);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>The account a ceremony's answer names by its credential id, whether or not it verifies.</summary>
    private async Task<User?> OwnerAsync(string credentialJson)
    {
        try
        {
            using var json = JsonDocument.Parse(credentialJson);
            var raw = json.RootElement.TryGetProperty("rawId", out var r) ? r.GetString() : json.RootElement.GetProperty("id").GetString();
            return raw is null || Decode(raw) is not { } id ? null : await users.FindByPasskeyIdAsync(id);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or KeyNotFoundException)
        {
            return null;
        }
    }

    /// <summary>
    /// Writes down a verified answer's challenge; false when it was written before (a copied
    /// request, or the same answer posted twice). Rows older than any state go as new ones come.
    /// </summary>
    private async Task<bool> UseChallengeAsync(string credentialJson)
    {
        byte[] hash;
        try
        {
            using var json = JsonDocument.Parse(credentialJson);
            var clientData = WebEncoders.Base64UrlDecode(json.RootElement.GetProperty("response").GetProperty("clientDataJSON").GetString()!);
            using var data = JsonDocument.Parse(clientData);
            hash = SHA256.HashData(Encoding.UTF8.GetBytes(data.RootElement.GetProperty("challenge").GetString()!));
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException or KeyNotFoundException or ArgumentNullException)
        {
            return false;
        }
        var now = clock.GetUtcNow();
        return await OneUse.TakeAsync(db, hash, now, now + PasskeySetup.Ceremony + TimeSpan.FromMinutes(1));
    }
}

/// <summary>
/// Values that may be used once (Phase 11): a passkey ceremony's challenge, and single sign-on's
/// <c>state</c> (its hash domain-separated), each kept in <c>PasskeyChallenges</c> by its SHA-256
/// until the state that carried it could no longer be read.
/// </summary>
internal static class OneUse
{
    /// <summary>Writes the hash down; false when it was written before. Rows past their time go as new ones come.</summary>
    public static async Task<bool> TakeAsync(CgwDb db, byte[] hash, DateTimeOffset now, DateTimeOffset until)
    {
        try
        {
            // Only the insert's count is told: 1 for a value new here, 0 for one seen before.
            var written = await db.Database.ExecuteSqlAsync($"""
                SET NOCOUNT ON;
                DELETE TOP (100) FROM [PasskeyChallenges] WHERE [ExpiresAt] < {now};
                SET NOCOUNT OFF;
                INSERT INTO [PasskeyChallenges] ([Hash], [ExpiresAt])
                SELECT {hash}, {until}
                WHERE NOT EXISTS (SELECT 1 FROM [PasskeyChallenges] WITH (UPDLOCK, HOLDLOCK) WHERE [Hash] = {hash});
                """);
            return written == 1;
        }
        catch (SqlException e) when (e.Number is 2627 or 2601)
        {
            // Two of the same at the very same moment: the key still lets one through.
            return false;
        }
    }
}

/// <summary>Phase 11: the account's passkeys for the app (Settings, Account). Adding one is not an API call: it is the API's page /account/passkeys/new, after a recent sign-in.</summary>
public static class PasskeyEndpoints
{
    public static void MapPasskeys(this RouteGroupBuilder account)
    {
        account.MapGet("/passkeys", async Task<Results<Ok<PasskeyList>, ProblemHttpResult>> (AccountService service, Passkeys passkeys, HttpContext http) =>
            {
                var user = await service.CurrentAsync(http.User);
                if (user is null) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
                return TypedResults.Ok(new PasskeyList(await passkeys.ListAsync(user.Id)));
            })
            .WithName("listPasskeys").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        account.MapPatch("/passkeys/{id}", async Task<Results<Ok<PasskeyDto>, ProblemHttpResult>> (string id, PasskeyRename body, AccountService service, Passkeys passkeys, HttpContext http) =>
            {
                var user = await service.CurrentAsync(http.User);
                if (user is null) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
                var result = await passkeys.RenameAsync(user, id, body.Name, http.Actor());
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("renamePasskey").RequireAuthorization().RequireRateLimiting(RateLimits.User);

        account.MapDelete("/passkeys/{id}", async Task<Results<NoContent, ProblemHttpResult>> (string id, AccountService service, Passkeys passkeys, HttpContext http) =>
            {
                var user = await service.CurrentAsync(http.User);
                if (user is null) return Problems.Of(Codes.AuthRequired, 401, "Not signed in");
                var result = await passkeys.RemoveAsync(user, id, http.Actor());
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("removePasskey").RequireAuthorization().RequireRateLimiting(RateLimits.User);
    }
}
