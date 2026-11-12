using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Mail;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Identity;

public enum SignInOutcome
{
    Ok,
    Invalid,
    LockedOut,
    NotConfirmed,
}

/// <summary>
/// Accounts (M2.2): sign-up with a confirmed email, sign-in with lockout, password reset, sign-out.
/// ASP.NET Core Identity does the cryptography; nothing here hashes, signs or compares secrets.
/// Answers never say whether an email has an account: not by their words, and not by their time
/// (mail goes out after the answer, and an unknown address costs a password check too).
/// </summary>
public sealed class AccountService(
    UserManager<User> users,
    SignInManager<User> signIn,
    Devices devices,
    MailQueue mail,
    MailCooldown cooldown,
    Audit audit,
    IConfiguration configuration,
    Shortcuts shortcuts,
    CgwDb db,
    TimeProvider clock)
{
    public const string DeviceClaim = "device_id";

    /// <summary>
    /// The claims a sign-in adds to the user's own; the security-stamp refresh carries them over
    /// (ApiServices, <c>OnRefreshingPrincipal</c>).
    /// </summary>
    public static readonly string[] SessionClaims = [DeviceClaim];

    /// <summary>The local pages a sign-in may return to, besides the web app's origins.</summary>
    private static readonly string[] LocalReturns = ["/connect/authorize", "/account/delete"];

    /// <summary>A password hash nobody has, checked for an unknown address so it costs what a real one does.</summary>
    private static string? dummyHash;

    /// <summary>
    /// Where links in mails point (Api__PublicUrl). Only a developer's machine may build them from
    /// the request (Api__PublicUrlFromRequest): a Host header can be pointed elsewhere by whoever
    /// sent the request.
    /// </summary>
    public string PublicUrl(HttpContext http) => PublicUrl(configuration, shortcuts, http.Request);

    public static string PublicUrl(IConfiguration configuration, Shortcuts shortcuts, HttpRequest request)
    {
        var configured = configuration["Api:PublicUrl"];
        if (!string.IsNullOrEmpty(configured)) return configured.TrimEnd('/');
        if (!shortcuts.PublicUrlFromRequest)
            throw new InvalidOperationException("Set Api__PublicUrl (Api__PublicUrlFromRequest=true builds links from the request, on a developer's machine only).");
        return $"{request.Scheme}://{request.Host}{request.PathBase}";
    }

    /// <summary>The web app's address, for links back into it.</summary>
    public string AppUrl() => (configuration["Web:AppUrl"] ?? ApiServices.Origins(configuration)[0]).TrimEnd('/');

    /// <summary>
    /// A return address is kept only if it is a local page that sends people on (the authorise
    /// endpoint, the account deletion page) or a page of the web app's own origins; anything else
    /// becomes the app's start page (no open redirect).
    /// </summary>
    public string SafeReturn(string? url)
    {
        if (string.IsNullOrEmpty(url)) return AppUrl();
        if (url.Any(char.IsControl) || url.Contains('\\')) return AppUrl();
        if (LocalReturns.Any(path => url == path || url.StartsWith(path + "?", StringComparison.Ordinal))) return url;
        if (Uri.TryCreate(url, UriKind.Absolute, out var parsed) && parsed.Scheme is "http" or "https")
        {
            var origin = parsed.GetLeftPart(UriPartial.Authority);
            if (ApiServices.Origins(configuration).Contains(origin, StringComparer.OrdinalIgnoreCase)) return url;
        }
        return AppUrl();
    }

    public static string Language(string? lang, HttpContext http) =>
        lang is "ar" or "en" ? lang
        : http.Request.Headers.AcceptLanguage.ToString().StartsWith("ar", StringComparison.OrdinalIgnoreCase) ? "ar"
        : "en";

    /// <summary>An account mail, queued unless the address had one in the cooldown window.</summary>
    private void Mail(string kind, string normalisedAddress, MailMessage message)
    {
        if (cooldown.Take(normalisedAddress)) mail.Enqueue(kind, message);
    }

    private string Normalise(string email) => users.NormalizeEmail(email) ?? email.ToUpperInvariant();

    /// <summary>Spends what a password check spends, for an answer that must not be quicker than one.</summary>
    private void SpendPasswordCheck(string password) =>
        users.PasswordHasher.VerifyHashedPassword(new User(), dummyHash ??= users.PasswordHasher.HashPassword(new User(), Guid.NewGuid().ToString()), password);

    private bool ValidEmail(string email)
    {
        if (email.Length is 0 or > 256 || !new EmailAddressAttribute().IsValid(email)) return false;
        var allowed = users.Options.User.AllowedUserNameCharacters;
        return string.IsNullOrEmpty(allowed) || email.All(allowed.Contains);
    }

    public async Task<Result<bool>> RegisterAsync(string email, string displayName, string password, string lang, string? returnUrl, HttpContext http)
    {
        email = email.Trim();
        displayName = displayName.Trim();
        // Everything that can be wrong with the request is said before the address is looked up,
        // so a taken address gets the same answer as a new one.
        if (displayName.Length is 0 or > 200) return Failure.Invalid("A name of 1 to 200 characters is needed");
        if (!ValidEmail(email)) return Failure.Invalid("The email address is not valid");
        var candidate = new User { UserName = email, Email = email };
        var weak = new List<string>();
        foreach (var validator in users.PasswordValidators)
        {
            var checkedPassword = await validator.ValidateAsync(users, candidate, password);
            if (!checkedPassword.Succeeded) weak.AddRange(checkedPassword.Errors.Select(e => e.Description));
        }
        if (weak.Count > 0) return Failure.Invalid(string.Join(" ", weak));

        var existing = await users.FindByEmailAsync(email);
        if (existing is not null)
        {
            // The same answer and the same work as a new account; the owner of the address is told.
            users.PasswordHasher.HashPassword(existing, password);
            if (existing.DeletedAt is null)
                Mail("alreadyRegistered", existing.NormalizedEmail ?? Normalise(email), Mails.AlreadyRegistered(lang, existing.Email!, $"{PublicUrl(http)}/account/signin?lang={lang}", $"{PublicUrl(http)}/account/forgot?lang={lang}"));
            return true;
        }
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            UserName = email,
            Email = email,
            DisplayName = displayName,
            Locale = lang,
            CreatedAt = clock.GetUtcNow(),
        };
        var created = await users.CreateAsync(user, password);
        if (!created.Succeeded)
            return Failure.Invalid(string.Join(" ", created.Errors.Select(e => e.Description)));
        audit.Add(http.Actor() with { UserId = user.Id }, "account.create", targetType: "user", targetId: user.Id);
        await db.SaveChangesAsync();
        await SendConfirmationAsync(user, lang, returnUrl, http);
        return true;
    }

    private async Task SendConfirmationAsync(User user, string lang, string? returnUrl, HttpContext http)
    {
        var code = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(await users.GenerateEmailConfirmationTokenAsync(user)));
        var link = $"{PublicUrl(http)}/account/confirm?userId={user.Id}&code={code}&lang={lang}&returnUrl={Uri.EscapeDataString(SafeReturn(returnUrl))}";
        Mail("confirm", user.NormalizedEmail ?? Normalise(user.Email!), Mails.Confirm(lang, user.Email!, link));
    }

    public async Task<Result<User>> ConfirmAsync(Guid userId, string code, HttpContext http)
    {
        var user = await users.FindByIdAsync(userId.ToString());
        if (user is null || user.DeletedAt is not null) return Failure.Invalid("The link is not valid");
        string token;
        try
        {
            token = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(code));
        }
        catch (FormatException)
        {
            return Failure.Invalid("The link is not valid");
        }
        var result = await users.ConfirmEmailAsync(user, token);
        if (!result.Succeeded) return Failure.Invalid("The link is not valid or has expired");
        await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "account.confirm", targetType: "user", targetId: user.Id);
        return user;
    }

    /// <summary>
    /// A reset link, for a confirmed account or not: whoever holds the mailbox chooses the
    /// password, so an address someone else signed up with is the mailbox owner's after a reset.
    /// </summary>
    public async Task ForgotAsync(string email, string lang, string? returnUrl, HttpContext http)
    {
        var user = await users.FindByEmailAsync(email.Trim());
        if (user is null || user.DeletedAt is not null) return;
        var code = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(await users.GeneratePasswordResetTokenAsync(user)));
        var link = $"{PublicUrl(http)}/account/reset?userId={user.Id}&code={code}&lang={lang}&returnUrl={Uri.EscapeDataString(SafeReturn(returnUrl))}";
        // An unconfirmed account's name was never the mailbox owner's to vouch for.
        Mail("reset", user.NormalizedEmail ?? Normalise(user.Email!), Mails.Reset(lang, user.Email!, user.EmailConfirmed ? user.DisplayName : null, link));
        await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "password.resetRequested", targetType: "user", targetId: user.Id);
    }

    public async Task<Result<bool>> ResetAsync(Guid userId, string code, string password, HttpContext http)
    {
        var user = await users.FindByIdAsync(userId.ToString());
        if (user is null || user.DeletedAt is not null) return Failure.Invalid("The link is not valid");
        string token;
        try
        {
            token = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(code));
        }
        catch (FormatException)
        {
            return Failure.Invalid("The link is not valid");
        }
        var result = await users.ResetPasswordAsync(user, token, password);
        if (!result.Succeeded) return Failure.Invalid(string.Join(" ", result.Errors.Select(e => e.Description)));
        await users.SetLockoutEndDateAsync(user, null);
        await users.ResetAccessFailedCountAsync(user);
        // The link came by mail, so the address is the resetter's: it counts as confirmed.
        if (!user.EmailConfirmed)
        {
            user.EmailConfirmed = true;
            await users.UpdateAsync(user);
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "account.confirm", targetType: "user", targetId: user.Id, detail: new { by = "reset" });
        }
        // A new password signs every device out.
        await devices.RevokeAllAsync(user.Id, http.Actor() with { UserId = user.Id });
        await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "password.reset", targetType: "user", targetId: user.Id);
        return true;
    }

    /// <summary>
    /// Password sign-in for the web cookie; a new device record names the session. Every answer
    /// that is not "signed in" costs one password check, and only the right password learns that
    /// the email still needs confirming.
    /// </summary>
    public async Task<SignInOutcome> PasswordSignInAsync(string email, string password, HttpContext http)
    {
        var user = await users.FindByEmailAsync(email.Trim());
        if (user is null || user.DeletedAt is not null)
        {
            SpendPasswordCheck(password);
            await audit.WriteAsync(http.Actor(), "signin.fail", detail: new { reason = "unknown" });
            return SignInOutcome.Invalid;
        }
        var check = await signIn.CheckPasswordSignInAsync(user, password, lockoutOnFailure: true);
        if (check.IsNotAllowed)
        {
            // Unconfirmed: Identity answered before it looked at the lockout or the password.
            if (await users.IsLockedOutAsync(user))
            {
                SpendPasswordCheck(password);
                await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.lockedOut", targetType: "user", targetId: user.Id);
                return SignInOutcome.LockedOut;
            }
            if (await users.CheckPasswordAsync(user, password)) return SignInOutcome.NotConfirmed;
            await users.AccessFailedAsync(user);
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.fail", targetType: "user", targetId: user.Id);
            return SignInOutcome.Invalid;
        }
        if (check.IsLockedOut)
        {
            // Identity answers a locked account before hashing anything.
            SpendPasswordCheck(password);
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.lockedOut", targetType: "user", targetId: user.Id);
            return SignInOutcome.LockedOut;
        }
        if (!check.Succeeded)
        {
            await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin.fail", targetType: "user", targetId: user.Id);
            return SignInOutcome.Invalid;
        }
        var device = await devices.CreateAsync(user.Id, "web", Devices.NameFromUserAgent(http.Request.Headers.UserAgent));
        await signIn.SignInWithClaimsAsync(user, isPersistent: true, [new Claim(DeviceClaim, device.Id.ToString())]);
        await audit.WriteAsync(http.Actor() with { UserId = user.Id }, "signin", targetType: "device", targetId: device.Id, detail: new { platform = "web" });
        return SignInOutcome.Ok;
    }

    /// <summary>The signed-in person's password, asked again before something that cannot be undone; wrong tries count towards the lockout.</summary>
    public async Task<bool> ConfirmPasswordAsync(User user, string password, HttpContext http)
    {
        var check = await signIn.CheckPasswordSignInAsync(user, password, lockoutOnFailure: true);
        if (check.Succeeded) return true;
        await audit.WriteAsync(http.Actor() with { UserId = user.Id }, check.IsLockedOut ? "signin.lockedOut" : "signin.fail", targetType: "user", targetId: user.Id, detail: new { reason = "reauthenticate" });
        return false;
    }

    public async Task ResendConfirmationAsync(string email, string lang, string? returnUrl, HttpContext http)
    {
        var user = await users.FindByEmailAsync(email.Trim());
        if (user is null || user.EmailConfirmed || user.DeletedAt is not null) return;
        await SendConfirmationAsync(user, lang, returnUrl, http);
    }

    public async Task SignOutAsync(HttpContext http)
    {
        if (http.User.UserId() is { } userId && http.User.DeviceId() is { } deviceId)
            await devices.RevokeAsync(userId, deviceId, http.Actor());
        await signIn.SignOutAsync();
    }

    public async Task<User?> CurrentAsync(ClaimsPrincipal principal) =>
        principal.UserId() is { } id ? await db.Users.FirstOrDefaultAsync(u => u.Id == id && u.DeletedAt == null) : null;
}

/// <summary>The account mails, in English and Arabic.</summary>
public static class Mails
{
    private static string E(string s) => HtmlEncoder.Default.Encode(s);

    private static MailMessage Make(string lang, string to, string subject, string greeting, string body, string action, string link, string footer)
    {
        var dir = lang == "ar" ? "rtl" : "ltr";
        var text = $"{greeting}\n\n{body}\n\n{link}\n\n{footer}";
        var html = $"""
            <!doctype html><html lang="{lang}" dir="{dir}"><body style="font-family:system-ui,sans-serif">
            <p>{E(greeting)}</p><p>{E(body)}</p>
            <p><a href="{E(link)}">{E(action)}</a></p>
            <p style="color:#555">{E(footer)}</p></body></html>
            """;
        return new MailMessage(to, subject, text, html);
    }

    /// <summary>No name in it: anyone can sign up with any address, and the name is theirs to choose.</summary>
    public static MailMessage Confirm(string lang, string to, string link) => lang == "ar"
        ? Make(lang, to, "أكّد بريدك الإلكتروني لمساحة عمل كاش جير", "مرحبًا،", "افتح هذا الرابط لتأكيد بريدك الإلكتروني وإكمال إنشاء حسابك.", "تأكيد البريد الإلكتروني", link, "إن لم تنشئ هذا الحساب فتجاهل هذه الرسالة.")
        : Make(lang, to, "Confirm your email for Cash Gear Workspace", "Hello,", "Open this link to confirm your email and finish making your account.", "Confirm email", link, "If you did not make this account, ignore this mail.");

    public static MailMessage Reset(string lang, string to, string? name, string link) => lang == "ar"
        ? Make(lang, to, "إعادة تعيين كلمة المرور لمساحة عمل كاش جير", name is null ? "مرحبًا،" : $"مرحبًا {name}،", "افتح هذا الرابط خلال ساعة لاختيار كلمة مرور جديدة. ستُسجَّل خارج كل أجهزتك.", "اختيار كلمة مرور جديدة", link, "إن لم تطلب ذلك فتجاهل هذه الرسالة؛ كلمة مرورك لم تتغير.")
        : Make(lang, to, "Reset your Cash Gear Workspace password", name is null ? "Hello," : $"Hello {name},", "Open this link within an hour to choose a new password. Every device you use will be signed out.", "Choose a new password", link, "If you did not ask for this, ignore this mail; your password has not changed.");

    public static MailMessage AlreadyRegistered(string lang, string to, string signIn, string forgot) => lang == "ar"
        ? Make(lang, to, "لديك حساب في مساحة عمل كاش جير", "مرحبًا،", "طلب أحدهم إنشاء حساب بهذا البريد، ولديك حساب به بالفعل. سجّل الدخول، أو أعد تعيين كلمة المرور إن نسيتها: " + forgot, "تسجيل الدخول", signIn, "إن لم تكن أنت فتجاهل هذه الرسالة.")
        : Make(lang, to, "You already have a Cash Gear Workspace account", "Hello,", "Someone asked to make an account with this email, and it already has one. Sign in, or reset your password if you have forgotten it: " + forgot, "Sign in", signIn, "If this was not you, ignore this mail.");

    public static MailMessage Invite(string lang, string to, string inviter, string workspace, string link) => lang == "ar"
        ? Make(lang, to, $"دعوة إلى {workspace} في مساحة عمل كاش جير", "مرحبًا،", $"دعاك {inviter} إلى مساحة العمل «{workspace}». تنتهي صلاحية الدعوة بعد سبعة أيام.", "قبول الدعوة", link, "إن لم تتوقع هذه الدعوة فتجاهل الرسالة.")
        : Make(lang, to, $"Invitation to {workspace} on Cash Gear Workspace", "Hello,", $"{inviter} invited you to the workspace \"{workspace}\". The invitation lasts seven days.", "Accept the invitation", link, "If you did not expect this, ignore this mail.");
}
