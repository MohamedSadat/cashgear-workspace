using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Cgw.Api;
using Cgw.Api.Identity;
using Cgw.Api.Infrastructure;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Cgw.Tests;

/// <summary>The fixes from the M2.2 security review, one test (or more) each.</summary>
public sealed class AccountSecurityTests(ServerFixture server)
{
    private static async Task<string> Text(HttpResponseMessage response) => await response.Content.ReadAsStringAsync();

    private static async Task<int> Devices(ServerFixture server, Guid userId, string platform)
    {
        await using var db = server.NewDb();
        return await db.Devices.CountAsync(d => d.UserId == userId && d.Platform == platform);
    }

    // 1. A desktop authorisation waits for the person.

    [Fact]
    public async Task A_signed_in_browser_is_asked_before_a_desktop_gets_a_code()
    {
        var account = await server.NewAccount();
        var (_, challenge) = AccountTests.Pkce();
        var question = await account.Client.GetAsync(AccountTests.AuthorizeUrl(challenge, 50001, "st"));
        Assert.Equal(HttpStatusCode.OK, question.StatusCode);
        var html = await Text(question);
        Assert.Contains($"Sign in the Cash Gear Workspace desktop app on this computer as <strong><bdi>{account.Email}</bdi></strong>?", html);
        Assert.Contains("Only continue if you just pressed Sign in in the app.", html);
        Assert.Contains("value=\"accept\">Continue</button>", html);
        Assert.Contains("value=\"deny\" class=\"secondary\">Cancel</button>", html);
        Assert.Contains("default-src 'none'", question.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal(0, await Devices(server, account.Id, "desktop"));

        // In Arabic too.
        var arabic = await Text(await account.Client.GetAsync(AccountTests.AuthorizeUrl(challenge, 50001, "st", "&ui_locales=ar")));
        Assert.Contains("dir=\"rtl\"", arabic);
        Assert.Contains(System.Text.Encodings.Web.HtmlEncoder.Default.Encode("لا تتابع إلا إذا ضغطت للتو على «تسجيل الدخول» في التطبيق."), arabic);

        // A POST that did not come from the page (no antiforgery token) answers nothing.
        var token = account.Client.DefaultRequestHeaders.GetValues("X-CSRF-TOKEN").Single();
        account.Client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        var fields = ServerFixture.FormFields(html, "/connect/authorize").Where(f => f.Key != "__RequestVerificationToken").ToList();
        fields.Add(KeyValuePair.Create("cgw_consent", "accept"));
        var forged = await account.Client.PostAsync("/connect/authorize", new FormUrlEncodedContent(fields));
        account.Client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, forged.StatusCode);
        Assert.Contains("The page had expired", await Text(forged));
        Assert.Equal(0, await Devices(server, account.Id, "desktop"));

        // Cancel: access_denied to the app, and still no device.
        var cancelled = await ServerFixture.Submit(account.Client, html, "/connect/authorize", ("cgw_consent", "deny"));
        Assert.Equal(HttpStatusCode.Redirect, cancelled.StatusCode);
        var location = cancelled.Headers.Location!;
        Assert.StartsWith("http://127.0.0.1:50001/callback", location.ToString());
        var query = QueryHelpers.ParseQuery(location.Query);
        Assert.Equal("access_denied", query["error"].ToString());
        Assert.Equal("st", query["state"].ToString());
        Assert.False(query.ContainsKey("code"));
        Assert.Equal(0, await Devices(server, account.Id, "desktop"));

        // Continue: the code, and the device with it.
        var accepted = await ServerFixture.Submit(account.Client, html, "/connect/authorize", ("cgw_consent", "accept"));
        Assert.Equal(HttpStatusCode.Redirect, accepted.StatusCode);
        Assert.True(QueryHelpers.ParseQuery(accepted.Headers.Location!.Query).ContainsKey("code"));
        Assert.Equal(1, await Devices(server, account.Id, "desktop"));
    }

    [Fact]
    public async Task Prompt_none_cannot_skip_the_question()
    {
        var account = await server.NewAccount();
        var (_, challenge) = AccountTests.Pkce();
        var response = await account.Client.GetAsync(AccountTests.AuthorizeUrl(challenge, 50002, "st", "&prompt=none"));
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        var query = QueryHelpers.ParseQuery(response.Headers.Location!.Query);
        Assert.Equal("consent_required", query["error"].ToString());
        Assert.False(query.ContainsKey("code"));
    }

    // 2. A lockout does not sign a desktop out.

    [Fact]
    public async Task A_locked_account_keeps_its_desktop_signed_in()
    {
        var account = await server.NewAccount();
        var (_, refresh) = await AccountTests.DesktopSignIn(account);
        var anyone = server.Anonymous();
        for (var i = 0; i < 5; i++) await ServerFixture.SignIn(anyone, account.Email, "wrong password " + i);
        await using (var db = server.NewDb())
            Assert.True((await db.Users.AsNoTracking().SingleAsync(u => u.Id == account.Id)).LockoutEnd > DateTimeOffset.UtcNow);
        var refreshed = await AccountTests.Refresh(server.Anonymous(), refresh);
        Assert.True(refreshed.IsSuccessStatusCode, await Text(refreshed));
    }

    // 3. Enumeration.

    [Fact]
    public async Task A_weak_password_gets_the_same_answer_for_a_taken_address_as_for_a_new_one()
    {
        var taken = await server.NewAccount();
        async Task<(HttpStatusCode, string?, string?)> Register(string email)
        {
            var response = await server.Anonymous().PostAsJsonAsync("/api/v1/account/register", new { email, password = "short", displayName = "X" });
            var body = await Kit.Json(response);
            return (response.StatusCode, body.GetProperty("code").GetString(), body.GetProperty("title").GetString());
        }
        var forTaken = await Register(taken.Email);
        var forNew = await Register($"new-{Guid.NewGuid():N}@example.test");
        Assert.Equal(HttpStatusCode.BadRequest, forTaken.Item1);
        Assert.Equal(forNew, forTaken);
    }

    [Fact]
    public async Task An_unconfirmed_account_says_so_only_to_its_right_password()
    {
        var email = $"unconfirmed-{Guid.NewGuid():N}@example.test";
        await server.Anonymous().PostAsJsonAsync("/api/v1/account/register", new { email, password = "the right long password", displayName = "U" });
        var wrong = await Text(await ServerFixture.SignIn(server.Anonymous(), email, "a wrong long password"));
        Assert.Contains(AccountTests.Generic, wrong);
        Assert.DoesNotContain("Confirm your email first", wrong);
        var right = await Text(await ServerFixture.SignIn(server.Anonymous(), email, "the right long password"));
        Assert.Contains("Confirm your email first", right);
        // Wrong tries count towards the lockout there too, so the question cannot be asked for ever.
        await using var db = server.NewDb();
        Assert.True((await db.Users.AsNoTracking().SingleAsync(u => u.NormalizedEmail == email.ToUpperInvariant())).AccessFailedCount >= 1);
    }

    [Fact]
    public async Task Adding_someone_is_an_invitation_that_answers_the_same_with_or_without_an_account()
    {
        var ws = await Ws.Create(server);
        var known = await server.NewAccount();
        var unknown = $"nobody-{Guid.NewGuid():N}@example.test";
        var before = server.MailFiles();
        var toKnown = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/invites", new { email = known.Email, role = "member" });
        var toUnknown = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/invites", new { email = unknown, role = "member" });
        Assert.Equal(HttpStatusCode.OK, toKnown.StatusCode);
        Assert.Equal(HttpStatusCode.OK, toUnknown.StatusCode);
        string Shape(JsonElement e) => string.Join(",", e.EnumerateObject().Select(p => $"{p.Name}:{p.Value.ValueKind}"));
        Assert.Equal(Shape(await Kit.Json(toKnown)), Shape(await Kit.Json(toUnknown)));
        // Both are mailed; neither joins until they accept.
        Assert.NotEmpty(await Kit.InviteToken(server, unknown, before));
        var token = await Kit.InviteToken(server, known.Email, before);
        Assert.Equal(HttpStatusCode.NotFound, (await known.Client.GetAsync($"/api/v1/workspaces/{ws.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await known.Client.PostAsync($"/api/v1/invites/{token}/accept", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await known.Client.GetAsync($"/api/v1/workspaces/{ws.Id}")).StatusCode);
        // There is no direct add, which told an admin whether an address had an account.
        var direct = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members", new { email = unknown, role = "member" });
        Assert.Equal(HttpStatusCode.MethodNotAllowed, direct.StatusCode);
    }

    // 4. Squatting an address.

    [Fact]
    public async Task Opening_a_confirmation_link_confirms_nothing_until_its_button_is_pressed()
    {
        var email = $"scanned-{Guid.NewGuid():N}@example.test";
        var client = server.Anonymous();
        await client.PostAsJsonAsync("/api/v1/account/register", new { email, password = "a long enough password", displayName = "S" });
        var link = ServerFixture.Link(await server.MailTo(email), "/account/confirm");
        // A mail scanner follows the link.
        var opened = await server.Anonymous().GetAsync(link);
        Assert.Equal(HttpStatusCode.OK, opened.StatusCode);
        var page = await Text(opened);
        Assert.Contains("Press Confirm to finish making your account.", page);
        await using (var db = server.NewDb())
            Assert.False((await db.Users.AsNoTracking().SingleAsync(u => u.NormalizedEmail == email.ToUpperInvariant())).EmailConfirmed);
        // The scanner's page posted from another browser is refused (its token is the scanner's).
        Assert.Equal(HttpStatusCode.BadRequest, (await ServerFixture.Submit(client, page, "/account/confirm")).StatusCode);
        // The person opens the link and presses Confirm.
        var confirmed = await ServerFixture.OpenAndSubmit(client, link, "/account/confirm");
        Assert.Contains("Your email is confirmed", await Text(confirmed));
        await using (var db = server.NewDb())
            Assert.True((await db.Users.AsNoTracking().SingleAsync(u => u.NormalizedEmail == email.ToUpperInvariant())).EmailConfirmed);
    }

    [Fact]
    public async Task The_mailbox_owner_takes_over_an_address_someone_else_signed_up_with()
    {
        var email = $"squatted-{Guid.NewGuid():N}@example.test";
        await server.Anonymous().PostAsJsonAsync("/api/v1/account/register", new { email, password = "the squatter's password", displayName = "Squatter" });
        // The owner asks for a password link: an unconfirmed account gets one too.
        Assert.Equal(HttpStatusCode.Accepted, (await server.Anonymous().PostAsJsonAsync("/api/v1/account/password/forgot", new { email })).StatusCode);
        var mail = await server.MailTo(email, "reset");
        Assert.DoesNotContain("Squatter", mail);
        var link = new Uri(ServerFixture.Link(mail, "/account/reset"));
        var query = QueryHelpers.ParseQuery(link.Query);
        var reset = await server.Anonymous().PostAsJsonAsync("/api/v1/account/password/reset", new { userId = query["userId"].ToString(), code = query["code"].ToString(), password = "the owner's own password" });
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);
        // The reset proved the mailbox: the account is confirmed, with the owner's password only.
        Assert.Equal(HttpStatusCode.Redirect, (await ServerFixture.SignIn(server.Anonymous(), email, "the owner's own password")).StatusCode);
        Assert.Contains(AccountTests.Generic, await Text(await ServerFixture.SignIn(server.Anonymous(), email, "the squatter's password")));
    }

    // 5. The device claim across the security-stamp refresh.

    [Fact]
    public async Task A_session_keeps_its_device_when_the_security_stamp_is_checked_again()
    {
        var clock = new MovableClock();
        var api = server.Variant(b => b.ConfigureTestServices(s => s.Configure<SecurityStampValidatorOptions>(o => o.TimeProvider = clock)));
        var account = await server.NewAccount();
        var session = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(session, account.Email, account.Password);
        var device = (await session.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("deviceId").GetString();

        clock.Advance(TimeSpan.FromMinutes(2));
        var after = await session.GetAsync("/api/v1/account/me");
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
        Assert.Equal(device, (await Kit.Json(after)).GetProperty("deviceId").GetString());
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Equal(HttpStatusCode.OK, (await session.GetAsync("/api/v1/account/me")).StatusCode);

        // Signed out from another session, the device stops at once, refreshed principal or not.
        var other = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(other, account.Email, account.Password);
        Assert.Equal(HttpStatusCode.NoContent, (await other.DeleteAsync($"/api/v1/account/devices/{device}")).StatusCode);
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Equal(HttpStatusCode.Unauthorized, (await session.GetAsync("/api/v1/account/me")).StatusCode);
    }

    // 6. Timing.

    [Fact]
    public async Task Account_mail_goes_after_the_answer_and_a_failure_is_logged_without_its_link()
    {
        using var smtp = new TcpListener(IPAddress.Loopback, 0);
        smtp.Start();
        var port = ((IPEndPoint)smtp.LocalEndpoint).Port;
        // A mail server that takes its time, then hangs up.
        _ = Task.Run(async () =>
        {
            using var connection = await smtp.AcceptTcpClientAsync();
            await Task.Delay(TimeSpan.FromSeconds(5));
        });
        var logs = new CapturedLogs();
        var api = server.Variant(b =>
        {
            b.UseSetting("Smtp:PickupDirectory", "");
            b.UseSetting("Smtp:Host", "127.0.0.1");
            b.UseSetting("Smtp:Port", port.ToString());
            b.ConfigureLogging(l => l.AddProvider(logs));
        });
        var account = await server.NewAccount();
        var client = ServerFixture.ClientOf(api);
        await client.GetAsync("/api/v1/version");
        var watch = Stopwatch.StartNew();
        var forgot = await client.PostAsJsonAsync("/api/v1/account/password/forgot", new { email = account.Email });
        watch.Stop();
        Assert.Equal(HttpStatusCode.Accepted, forgot.StatusCode);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(3), $"The answer waited {watch.Elapsed} for the mail server");

        var failure = await Kit.Eventually(
            () => Task.FromResult(logs.Entries.FirstOrDefault(e => e.Category.EndsWith("MailSender", StringComparison.Ordinal) && e.Level == LogLevel.Error)),
            e => e.Message is not null, TimeSpan.FromSeconds(30));
        Assert.Contains("A reset mail was not sent", failure.Message);
        Assert.DoesNotContain(logs.Entries, e => e.Message.Contains("/account/reset", StringComparison.Ordinal) || e.Message.Contains("code=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Signing_in_with_an_unknown_address_checks_a_password_all_the_same()
    {
        var hasher = new CountingHasher();
        var api = server.Variant(b => b.ConfigureTestServices(s => s.AddSingleton<IPasswordHasher<User>>(hasher)));
        var client = ServerFixture.ClientOf(api);
        var before = hasher.Verifies;
        var answer = await ServerFixture.SignIn(client, $"nobody-{Guid.NewGuid():N}@example.test", "some long password");
        Assert.Contains(AccountTests.Generic, await Text(answer));
        Assert.Equal(before + 1, hasher.Verifies);
    }

    // 7. Mail abuse.

    [Fact]
    public async Task One_account_mail_per_address_in_two_minutes_and_no_name_in_the_confirmation()
    {
        var api = server.Variant(b => b.UseSetting("Mail:CooldownSeconds", "120"));
        var client = ServerFixture.ClientOf(api);
        var email = $"flooded-{Guid.NewGuid():N}@example.test";
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/v1/account/register", new { email, password = "a long enough password", displayName = "Win a prize at prize.example" })).StatusCode);
        var confirmation = await server.MailTo(email, "/account/confirm");
        Assert.DoesNotContain("prize.example", confirmation);
        Assert.Contains("Hello,", confirmation);

        // Inside the window every answer is the usual one, and no mail goes.
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/v1/account/password/forgot", new { email })).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/v1/account/register", new { email, password = "a long enough password", displayName = "Again" })).StatusCode);
        var page = await Text(await client.GetAsync("/account/signin"));
        var resend = await client.PostAsync("/account/resend", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["__RequestVerificationToken"] = ServerFixture.FormFields(page, "/account/signin").Single(f => f.Key == "__RequestVerificationToken").Value,
            ["Email"] = email,
        }));
        Assert.Contains("Check your email", await Text(resend));
        Assert.Equal(1, await server.CountMailTo(email, "Cash Gear"));
    }

    // 8. /connect/logout.

    [Fact]
    public async Task Logout_is_a_post_with_an_antiforgery_token_and_signs_the_device_out()
    {
        var account = await server.NewAccount();
        var device = Guid.Parse((await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("deviceId").GetString()!);
        // Another site can send the browser to a GET: it does nothing.
        Assert.NotEqual(HttpStatusCode.Redirect, (await account.Client.GetAsync("/connect/logout")).StatusCode);
        // A POST without the token does nothing either.
        var token = account.Client.DefaultRequestHeaders.GetValues("X-CSRF-TOKEN").Single();
        account.Client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        Assert.Equal(HttpStatusCode.BadRequest, (await account.Client.PostAsync("/connect/logout", new FormUrlEncodedContent([]))).StatusCode);
        account.Client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);

        var loggedOut = await account.Client.PostAsync("/connect/logout", new FormUrlEncodedContent([]));
        Assert.Equal(HttpStatusCode.Redirect, loggedOut.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);
        await using var db = server.NewDb();
        Assert.NotNull((await db.Devices.AsNoTracking().SingleAsync(d => d.Id == device)).RevokedAt);
    }

    // 9. Cookie names.

    [Fact]
    public async Task Outside_a_developer_machine_the_cookies_carry_the_host_prefix()
    {
        CookieNames Names(string environment, params (string, string)[] settings) =>
            CookieNames.For(new Env(environment), Shortcuts.From(Settings(settings), new Env(environment)));
        Assert.Equal(new CookieNames("cgw_session", "cgw_xsrf"), Names("Development"));
        Assert.Equal(new CookieNames("__Host-cgw_session", "__Host-cgw_xsrf"), Names("Production"));
        Assert.Equal(new CookieNames("__Host-cgw_session", "__Host-cgw_xsrf"), Names("Staging"));
        // A host told to serve plain http cannot have Secure cookies, so it keeps the plain names.
        Assert.Equal(new CookieNames("cgw_session", "cgw_xsrf"), Names("Staging", (Shortcuts.AllowHttpKey, "true")));

        var api = server.Variant(b =>
        {
            b.UseEnvironment("Staging");
            b.UseSetting(Shortcuts.EphemeralKeysKey, "true");
        });
        var account = await server.NewAccount();
        var client = ServerFixture.ClientOf(api);
        var signedIn = await ServerFixture.SignIn(client, account.Email, account.Password);
        Assert.Equal(HttpStatusCode.Redirect, signedIn.StatusCode);
        var cookies = signedIn.Headers.GetValues("Set-Cookie").ToList();
        var session = cookies.Single(c => c.StartsWith("__Host-cgw_session=", StringComparison.Ordinal)).ToLowerInvariant();
        Assert.Contains("path=/;", session);
        Assert.Contains("secure", session);
        Assert.DoesNotContain("domain=", session);
        Assert.DoesNotContain(cookies, c => c.StartsWith("cgw_session=", StringComparison.Ordinal));
        // The CSRF check knows the cookie by its new name.
        var csrf = client.DefaultRequestHeaders.GetValues("X-CSRF-TOKEN").Single();
        client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PatchAsJsonAsync("/api/v1/account/me", new { displayName = "Forged" })).StatusCode);
        client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", csrf);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PatchAsJsonAsync("/api/v1/account/me", new { displayName = "Real" })).StatusCode);
    }

    /// <summary>The server stack (Development on http://127.0.0.1:5280) and the rehearsal (Staging on http): Api__AllowHttp.</summary>
    [Fact]
    public async Task A_developer_host_on_plain_http_serves_the_sign_in_page_and_signs_in()
    {
        static HttpClient Http(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> factory) =>
            factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { BaseAddress = new Uri("http://localhost"), HandleCookies = true, AllowAutoRedirect = false });

        // Without the switch the antiforgery cookie is Secure always, and a plain http request is refused.
        var strict = server.Variant(b => b.UseEnvironment("Development"));
        Assert.Equal(HttpStatusCode.InternalServerError, (await Http(strict).GetAsync("/account/signin")).StatusCode);

        var api = server.Variant(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting(Shortcuts.AllowHttpKey, "true");
        });
        var client = Http(api);
        var page = await client.GetAsync("/account/signin");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.Matches("name=\"__RequestVerificationToken\" value=\"[^\"]+\"", await Text(page));
        Assert.DoesNotContain("secure", page.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("cgw_xsrf=", StringComparison.Ordinal)).ToLowerInvariant());

        // The whole sign-in works over http, and the session cookie is not Secure there.
        var account = await server.NewAccount();
        var signedIn = await ServerFixture.SignIn(client, account.Email, account.Password);
        Assert.Equal(HttpStatusCode.Redirect, signedIn.StatusCode);
        Assert.DoesNotContain("secure", signedIn.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("cgw_session=", StringComparison.Ordinal)).ToLowerInvariant());
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/account/me")).StatusCode);
    }

    // 10. Reset tokens.

    [Fact]
    public async Task Reset_links_come_from_their_own_provider_and_last_an_hour()
    {
        var account = await server.NewAccount();
        await using var scope = server.Api.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<User>>();
        Assert.Equal(ResetTokenProvider.ProviderName, users.Options.Tokens.PasswordResetTokenProvider);
        Assert.Equal(TimeSpan.FromHours(1), scope.ServiceProvider.GetRequiredService<IOptions<ResetTokenProviderOptions>>().Value.TokenLifespan);
        Assert.Equal(TimeSpan.FromHours(24), scope.ServiceProvider.GetRequiredService<IOptions<DataProtectionTokenProviderOptions>>().Value.TokenLifespan);
        var user = (await users.FindByIdAsync(account.Id.ToString()))!;
        // A token from the day-long provider (the confirmation links') does not reset a password.
        var dayLong = await users.GenerateUserTokenAsync(user, TokenOptions.DefaultProvider, UserManager<User>.ResetPasswordTokenPurpose);
        Assert.False((await users.ResetPasswordAsync(user, dayLong, "another long password")).Succeeded);
        var hourLong = await users.GeneratePasswordResetTokenAsync(user);
        Assert.True((await users.ResetPasswordAsync(user, hourLong, "another long password")).Succeeded);
    }

    // 11. Fail closed.

    /// <summary>Settings from pairs, a later pair replacing an earlier one with the same key.</summary>
    private static IConfiguration Settings(params (string Key, string Value)[] values)
    {
        var data = new Dictionary<string, string?>();
        foreach (var (key, value) in values) data[key] = value;
        return new ConfigurationBuilder().AddInMemoryCollection(data).Build();
    }

    [Fact]
    public void Production_refuses_to_start_half_configured_or_with_a_shortcut()
    {
        var production = new Env("Production");
        var problems = ProductionChecks.Problems(Settings(), production, windows: true);
        Assert.Contains(problems, p => p.Contains("Web__Origins", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("Api__PublicUrl", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("DataProtection__Dpapi", StringComparison.Ordinal));
        Assert.Throws<InvalidOperationException>(() => ProductionChecks.Enforce(Settings(), production));

        (string, string)[] complete = [("Web:Origins:0", "https://workspace.cashgearerp.com"), ("Api:PublicUrl", "https://workspace-api.cashgearerp.com"), ("DataProtection:Dpapi", "true")];
        Assert.Empty(ProductionChecks.Problems(Settings(complete), production, windows: true));
        Assert.Contains(ProductionChecks.Problems(Settings([.. complete, ("Api:PublicUrl", "http://workspace-api.cashgearerp.com")]), production, windows: true), p => p.Contains("https", StringComparison.Ordinal));
        foreach (var key in Shortcuts.Keys)
            Assert.Contains(ProductionChecks.Problems(Settings([.. complete, (key, "true")]), production, windows: true), p => p.Contains("refused in Production", StringComparison.Ordinal));
        // Elsewhere nothing is required.
        Assert.Empty(ProductionChecks.Problems(Settings(), new Env("Staging"), windows: true));
    }

    [Fact]
    public void Shortcuts_are_explicit_outside_a_developer_machine()
    {
        // Plain http is never assumed, not even on a developer's machine; the other two are there.
        Assert.Equal(new Shortcuts(false, true, true), Shortcuts.From(Settings(), new Env("Development")));
        Assert.Equal(new Shortcuts(false, true, true), Shortcuts.From(Settings(), new Env("Testing")));
        Assert.Equal(new Shortcuts(true, true, true), Shortcuts.From(Settings((Shortcuts.AllowHttpKey, "true")), new Env("Development")));
        Assert.Equal(new Shortcuts(false, false, false), Shortcuts.From(Settings(), new Env("Staging")));
        Assert.Equal(new Shortcuts(true, true, false), Shortcuts.From(Settings((Shortcuts.AllowHttpKey, "true"), (Shortcuts.EphemeralKeysKey, "true")), new Env("Staging")));

        // Mail links come from the Host header only when the setting says so.
        var http = new DefaultHttpContext();
        http.Request.Scheme = "https";
        http.Request.Host = new HostString("evil.example");
        Assert.Throws<InvalidOperationException>(() => AccountService.PublicUrl(Settings(), Shortcuts.From(Settings(), new Env("Staging")), http.Request));
        Assert.Equal("https://evil.example", AccountService.PublicUrl(Settings(), Shortcuts.From(Settings(), new Env("Development")), http.Request));
        Assert.Equal("https://api.example", AccountService.PublicUrl(Settings(("Api:PublicUrl", "https://api.example/")), Shortcuts.From(Settings(), new Env("Staging")), http.Request));
    }

    [Fact]
    public void An_expired_certificate_is_refused_and_a_self_signed_one_is_not()
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=cgw-test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var now = DateTimeOffset.UtcNow;
        using var expired = request.CreateSelfSigned(now.AddDays(-30), now.AddDays(-1));
        var refused = Assert.Throws<InvalidOperationException>(() => ProductionKeys.Usable(expired, "Signing", now));
        Assert.Contains("expired", refused.Message);
        using var current = request.CreateSelfSigned(now.AddDays(-1), now.AddYears(1));
        Assert.Same(current, ProductionKeys.Usable(current, "Signing", now));
    }

    // 12. Rate limits.

    [Fact]
    public async Task Token_requests_have_a_bucket_of_their_own_and_revoke_and_logout_are_limited()
    {
        var api = server.Variant(b =>
        {
            b.UseSetting("RateLimits:token", "2");
            b.UseSetting("RateLimits:signin", "2");
        });
        var client = ServerFixture.ClientOf(api);
        FormUrlEncodedContent Grant() => new(new Dictionary<string, string> { ["grant_type"] = "refresh_token", ["client_id"] = "cgw-desktop", ["refresh_token"] = "x" });
        FormUrlEncodedContent Revoke() => new(new Dictionary<string, string> { ["token"] = "x", ["client_id"] = "cgw-desktop" });
        for (var i = 0; i < 2; i++) Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.PostAsync("/connect/token", Grant())).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.PostAsync("/connect/token", Grant())).StatusCode);
        for (var i = 0; i < 2; i++) Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.PostAsync("/connect/revoke", Revoke())).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.PostAsync("/connect/revoke", Revoke())).StatusCode);
        // The token requests did not use up the sign-in bucket, which /connect/logout shares.
        for (var i = 0; i < 2; i++) Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.PostAsync("/connect/logout", new FormUrlEncodedContent([]))).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.PostAsync("/connect/logout", new FormUrlEncodedContent([]))).StatusCode);
    }

    // 13. Account deletion.

    [Fact]
    public async Task Deleting_the_account_asks_for_the_password_on_the_account_page()
    {
        var account = await server.NewAccount();
        var browser = server.Anonymous();
        // Signed out, the page sends the browser to sign in and back to itself.
        var start = await browser.GetAsync("/account/delete?lang=en&returnUrl=" + Uri.EscapeDataString("http://localhost:5273/"));
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        var signInUrl = start.Headers.Location!.ToString();
        Assert.StartsWith("/account/signin?lang=en&returnUrl=%2Faccount%2Fdelete%3F", signInUrl);
        var back = QueryHelpers.ParseQuery(new Uri("https://localhost" + signInUrl).Query)["returnUrl"].ToString();
        var signedIn = await ServerFixture.SignIn(browser, account.Email, account.Password, back);
        Assert.Equal(back, signedIn.Headers.Location!.ToString());

        var page = await Text(await browser.GetAsync(back));
        Assert.Contains($"Signed in as <strong><bdi>{account.Email}</bdi></strong>.", page);
        Assert.Contains("type=\"password\"", page);
        var wrong = await ServerFixture.Submit(browser, page, "/account/delete", ("Password", "not the password"));
        Assert.Contains("The password is not right.", await Text(wrong));
        await using (var db = server.NewDb())
            Assert.Null((await db.Users.AsNoTracking().SingleAsync(u => u.Id == account.Id)).DeletedAt);

        var done = await ServerFixture.Submit(browser, page, "/account/delete", ("Password", account.Password));
        var html = await Text(done);
        Assert.Contains("Your account is deleted", html);
        Assert.Contains("href=\"http://localhost:5273/\"", html);
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);
        await using (var db = server.NewDb())
            Assert.NotNull((await db.Users.AsNoTracking().SingleAsync(u => u.Id == account.Id)).DeletedAt);
    }

    [Fact]
    public async Task The_api_no_longer_deletes_an_account_and_the_page_keeps_its_return_address_safe()
    {
        var account = await server.NewAccount();
        Assert.NotEqual(HttpStatusCode.NoContent, (await account.Client.DeleteAsync("/api/v1/account")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);
        var page = await Text(await account.Client.GetAsync("/account/delete?returnUrl=" + Uri.EscapeDataString("https://evil.example/")));
        Assert.DoesNotContain("evil.example\"", page.Replace("value=\"https://evil.example/\"", "", StringComparison.Ordinal));
        Assert.Contains("href=\"http://localhost:5273\"", page);
    }
}

/// <summary>Identity's hasher, counting the checks.</summary>
public sealed class CountingHasher : IPasswordHasher<User>
{
    private readonly PasswordHasher<User> inner = new();
    private int verifies;

    public int Verifies => Volatile.Read(ref verifies);

    public string HashPassword(User user, string password) => inner.HashPassword(user, password);

    public PasswordVerificationResult VerifyHashedPassword(User user, string hashedPassword, string providedPassword)
    {
        Interlocked.Increment(ref verifies);
        return inner.VerifyHashedPassword(user, hashedPassword, providedPassword);
    }
}

/// <summary>Every log line, kept for a test to read.</summary>
public sealed class CapturedLogs : ILoggerProvider
{
    public ConcurrentQueue<(string Category, LogLevel Level, string Message)> Entries { get; } = new();

    public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);

    public void Dispose()
    {
    }

    private sealed class Logger(CapturedLogs owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            owner.Entries.Enqueue((category, logLevel, formatter(state, exception) + (exception is null ? "" : " " + exception)));
    }
}
