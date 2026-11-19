using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cgw.Api.Identity;
using Cgw.Core.Data;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>Phase 11 (M11.2): passkeys on the API's own pages, through a software authenticator.</summary>
public sealed class PasskeyTests(ServerFixture server)
{
    private const string Refused = "The passkey was not accepted. Try again, or sign in with your password.";
    private const string Settings = "http://localhost:5273/#/settings/account";

    private static async Task<string> Text(HttpResponseMessage response) => await response.Content.ReadAsStringAsync();

    private async Task<int> Devices(Guid userId)
    {
        await using var db = server.NewDb();
        return await db.Devices.CountAsync(d => d.UserId == userId);
    }

    private async Task<List<AuditEntry>> Audit(Guid userId, string action)
    {
        await using var db = server.NewDb();
        return await db.AuditLog.IgnoreQueryFilters().AsNoTracking().Where(a => a.ActorUserId == userId && a.Action == action).OrderBy(a => a.CreatedAt).ToListAsync();
    }

    private static async Task<JsonElement> List(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/v1/account/passkeys")).GetProperty("passkeys");

    [Fact]
    public async Task A_passkey_added_on_the_page_signs_in_and_makes_a_device()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        var added = await PasskeyFlow.Add(account.Client, authenticator, "My laptop", Settings);
        Assert.True(added.StatusCode == HttpStatusCode.Redirect, await Text(added));
        Assert.Equal(Settings, added.Headers.Location!.ToString());

        var listed = await List(account.Client);
        var passkey = Assert.Single(listed.EnumerateArray());
        Assert.Equal(authenticator.Passkeys[0].IdText, passkey.GetProperty("id").GetString());
        Assert.Equal("My laptop", passkey.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, passkey.GetProperty("lastUsedAt").ValueKind);
        Assert.Single(await Audit(account.Id, "account.passkey.add"));

        var devices = await Devices(account.Id);
        var browser = server.Anonymous();
        var signedIn = await PasskeyFlow.SignIn(browser, authenticator, "http://localhost:5273/#/p/x");
        Assert.True(signedIn.StatusCode == HttpStatusCode.Redirect, await Text(signedIn));
        Assert.Equal("http://localhost:5273/#/p/x", signedIn.Headers.Location!.ToString());
        var me = await browser.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
        Assert.Equal(account.Id, me.GetProperty("id").GetGuid());
        Assert.Equal(devices + 1, await Devices(account.Id));
        Assert.NotEqual((await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("deviceId").GetString(), me.GetProperty("deviceId").GetString());
        // The session writes as any other (its antiforgery header), and is audited with its method.
        Assert.Equal(HttpStatusCode.NoContent, (await browser.PatchAsJsonAsync("/api/v1/account/me", new { locale = "ar" })).StatusCode);
        var signIns = await Audit(account.Id, "account.signin");
        Assert.Contains(signIns, a => a.Detail!.Contains("\"method\":\"passkey\"", StringComparison.Ordinal) && a.Detail.Contains("\"platform\":\"web\"", StringComparison.Ordinal));
        Assert.Contains(signIns, a => a.Detail!.Contains("\"method\":\"password\"", StringComparison.Ordinal));
        Assert.Equal(JsonValueKind.String, Assert.Single((await List(browser)).EnumerateArray()).GetProperty("lastUsedAt").ValueKind);
    }

    [Fact]
    public async Task The_options_ask_for_user_verification_a_discoverable_key_and_no_attestation()
    {
        var account = await server.NewAccount("Ada");
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator);
        var token = PasskeyFlow.Token(await Text(await account.Client.GetAsync("/account/passkeys/new")));
        using var create = JsonDocument.Parse(await PasskeyFlow.Options(account.Client, "/account/passkey/creation-options", token));
        var o = create.RootElement;
        Assert.Equal("localhost", o.GetProperty("rp").GetProperty("id").GetString());
        Assert.Equal("required", o.GetProperty("authenticatorSelection").GetProperty("residentKey").GetString());
        Assert.Equal("required", o.GetProperty("authenticatorSelection").GetProperty("userVerification").GetString());
        Assert.Equal("none", o.GetProperty("attestation").GetString());
        // The user handle is the account's id, never its address; its passkeys are excluded.
        Assert.Equal(account.Id.ToString(), Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(o.GetProperty("user").GetProperty("id").GetString()!)));
        Assert.Equal("Ada", o.GetProperty("user").GetProperty("displayName").GetString());
        Assert.Equal(authenticator.Passkeys[0].IdText, Assert.Single(o.GetProperty("excludeCredentials").EnumerateArray()).GetProperty("id").GetString());

        // Signing in names no account; asked again, only this account's passkeys.
        var visitor = server.Anonymous();
        using var signIn = JsonDocument.Parse(await PasskeyFlow.Options(visitor, "/account/passkey/request-options?for=signin", PasskeyFlow.Token(await Text(await visitor.GetAsync("/account/signin")))));
        Assert.Equal("required", signIn.RootElement.GetProperty("userVerification").GetString());
        Assert.Empty(signIn.RootElement.GetProperty("allowCredentials").EnumerateArray());
        using var confirm = JsonDocument.Parse(await PasskeyFlow.Options(account.Client, "/account/passkey/request-options?for=confirm", token));
        Assert.Equal(authenticator.Passkeys[0].IdText, Assert.Single(confirm.RootElement.GetProperty("allowCredentials").EnumerateArray()).GetProperty("id").GetString());

        // Options are asked with the page's antiforgery token, and for=confirm only when signed in.
        Assert.Equal(HttpStatusCode.BadRequest, (await PasskeyFlow.AskOptions(account.Client, "/account/passkey/creation-options", "forged")).StatusCode);
        var anonymous = server.Anonymous();
        var anonymousToken = PasskeyFlow.Token(await Text(await anonymous.GetAsync("/account/signin")));
        Assert.Equal(HttpStatusCode.Unauthorized, (await PasskeyFlow.AskOptions(anonymous, "/account/passkey/request-options?for=confirm", anonymousToken)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PasskeyFlow.AskOptions(anonymous, "/account/passkey/creation-options", anonymousToken)).StatusCode);
    }

    /// <summary>An answer made wrong one way, and what checks it.</summary>
    public static TheoryData<string> Wrongs => ["another origin", "another port", "plain http", "another relying party", "no user verification", "no user presence", "another challenge", "a creation's type", "from a frame", "another key", "another account's handle"];

    private static SoftwareAuthenticator.Tweaks Wrong(string wrong, SoftwareAuthenticator.Passkey other) => wrong switch
    {
        "another origin" => new() { Origin = "https://evil.example" },
        "another port" => new() { Origin = "https://localhost:8443" },
        "plain http" => new() { Origin = "http://localhost" },
        "another relying party" => new() { RpId = "evil.example" },
        "no user verification" => new() { UserVerified = false },
        "no user presence" => new() { UserPresent = false },
        "another challenge" => new() { Challenge = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32)) },
        "a creation's type" => new() { Type = "webauthn.create" },
        "from a frame" => new() { CrossOrigin = true, TopOrigin = "https://evil.example" },
        "another key" => new() { SignWith = ECDsa.Create(ECCurve.NamedCurves.nistP256) },
        // The other account's passkey, answered under this one's user handle.
        "another account's handle" => new() { Use = other },
        _ => throw new ArgumentOutOfRangeException(nameof(wrong)),
    };

    [Theory]
    [MemberData(nameof(Wrongs))]
    public async Task A_wrong_answer_signs_nobody_in(string wrong)
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        var mine = await PasskeyFlow.AddOk(account.Client, authenticator);
        var stranger = await server.NewAccount();
        var theirs = new SoftwareAuthenticator();
        var other = await PasskeyFlow.AddOk(stranger.Client, theirs);
        var tweaks = Wrong(wrong, other) with { UserHandle = wrong == "another account's handle" ? mine.UserHandle : null };
        var devices = await Devices(account.Id);
        var strangerDevices = await Devices(stranger.Id);

        var browser = server.Anonymous();
        var answer = await PasskeyFlow.SignIn(browser, authenticator, tweaks: tweaks);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Contains(Refused, await Text(answer));
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(devices, await Devices(account.Id));
        Assert.Equal(strangerDevices, await Devices(stranger.Id));
        // The same browser signs in with the right answer.
        Assert.Equal(HttpStatusCode.Redirect, (await PasskeyFlow.SignIn(browser, authenticator)).StatusCode);
    }

    [Theory]
    [InlineData("another origin")]
    [InlineData("another relying party")]
    [InlineData("no user verification")]
    [InlineData("another challenge")]
    [InlineData("a request's type")]
    public async Task A_wrong_creation_adds_no_passkey(string wrong)
    {
        var account = await server.NewAccount();
        SoftwareAuthenticator.Tweaks tweaks = wrong switch
        {
            "another origin" => new() { Origin = "https://evil.example" },
            "another relying party" => new() { RpId = "evil.example" },
            "no user verification" => new() { UserVerified = false },
            "another challenge" => new() { Challenge = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32)) },
            _ => new() { Type = "webauthn.get" },
        };
        var answer = await PasskeyFlow.Add(account.Client, new SoftwareAuthenticator(), returnUrl: Settings, tweaks: tweaks);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Contains("The passkey was not accepted.", await Text(answer));
        Assert.Empty((await List(account.Client)).EnumerateArray());
        Assert.NotEmpty(await Audit(account.Id, "account.passkey.refused"));
    }

    /// <summary>A client that keeps its cookies by hand, so a test can send a request again exactly as it was.</summary>
    private sealed class Jar(HttpClient client)
    {
        private readonly Dictionary<string, string> cookies = [];

        public async Task<HttpResponseMessage> Send(HttpMethod method, string url, HttpContent? content = null, Dictionary<string, string>? with = null, string? csrf = null)
        {
            using var request = new HttpRequestMessage(method, url) { Content = content };
            var sent = with ?? cookies;
            if (sent.Count > 0) request.Headers.Add("Cookie", string.Join("; ", sent.Select(c => $"{c.Key}={c.Value}")));
            if (csrf is not null) request.Headers.Add("X-CSRF-TOKEN", csrf);
            var response = await client.SendAsync(request);
            if (response.Headers.TryGetValues("Set-Cookie", out var values))
                foreach (var value in values)
                {
                    var pair = value.Split(';')[0];
                    var name = pair[..pair.IndexOf('=')];
                    var text = pair[(pair.IndexOf('=') + 1)..];
                    if (text.Length == 0 || value.Contains("expires=Thu, 01 Jan 1970", StringComparison.OrdinalIgnoreCase)) cookies.Remove(name);
                    else cookies[name] = text;
                }
            return response;
        }

        public Dictionary<string, string> Now => new(cookies);
    }

    [Fact]
    public async Task An_answer_sent_again_with_its_state_is_refused()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator { CounterStep = 0 };
        await PasskeyFlow.AddOk(account.Client, authenticator);

        var jar = new Jar(server.Api.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), HandleCookies = false, AllowAutoRedirect = false }));
        var token = PasskeyFlow.Token(await Text(await jar.Send(HttpMethod.Get, "/account/signin")));
        var options = await jar.Send(HttpMethod.Post, "/account/passkey/request-options?for=signin", csrf: token);
        Assert.Equal(HttpStatusCode.OK, options.StatusCode);
        // The ceremony's state rides in its own cookie: HttpOnly, Strict, five minutes.
        var stateCookie = options.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("cgw_passkey=", StringComparison.Ordinal)).ToLowerInvariant();
        Assert.Contains("httponly", stateCookie);
        Assert.Contains("samesite=strict", stateCookie);
        var json = authenticator.Get(await Text(options));
        var copied = jar.Now;

        var first = await jar.Send(HttpMethod.Post, "/account/signin/passkey", PasskeyFlow.Form(token, json), copied);
        Assert.Equal(HttpStatusCode.Redirect, first.StatusCode);
        // The same request again, the state's cookie and all (a counter of 0 says nothing).
        var again = await jar.Send(HttpMethod.Post, "/account/signin/passkey", PasskeyFlow.Form(token, json), copied);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Contains(Refused, await Text(again));
        Assert.False(again.Headers.TryGetValues("Set-Cookie", out var set) && set.Any(c => c.StartsWith("cgw_session=", StringComparison.Ordinal)));
        Assert.Contains(await Audit(account.Id, "signin.fail"), a => a.Detail!.Contains("challenge used before", StringComparison.Ordinal));
        // Without the state (it is read once), nothing either.
        var stateless = await jar.Send(HttpMethod.Post, "/account/signin/passkey", PasskeyFlow.Form(token, authenticator.Get(await Text(options))),
            copied.Where(c => c.Key != "cgw_passkey").ToDictionary());
        Assert.Contains(Refused, await Text(stateless));
    }

    [Fact]
    public async Task A_signature_counter_that_goes_back_is_refused()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        var added = await PasskeyFlow.Add(account.Client, authenticator, returnUrl: Settings, tweaks: new() { SignCount = 5 });
        Assert.Equal(HttpStatusCode.Redirect, added.StatusCode);
        Assert.Equal(HttpStatusCode.Redirect, (await PasskeyFlow.SignIn(server.Anonymous(), authenticator)).StatusCode);
        await using (var db = server.NewDb())
            Assert.Equal(6u, (await db.UserPasskeys.AsNoTracking().SingleAsync(p => p.UserId == account.Id)).Data.SignCount);
        // A clone of the authenticator answers with an older count.
        Assert.Contains(Refused, await Text(await PasskeyFlow.SignIn(server.Anonymous(), authenticator, tweaks: new() { SignCount = 3 })));
        Assert.Contains(Refused, await Text(await PasskeyFlow.SignIn(server.Anonymous(), authenticator, tweaks: new() { SignCount = 6 })));
        Assert.Equal(HttpStatusCode.Redirect, (await PasskeyFlow.SignIn(server.Anonymous(), authenticator, tweaks: new() { SignCount = 7 })).StatusCode);
    }

    [Fact]
    public async Task Another_accounts_passkey_confirms_nobody_and_its_credential_cannot_be_added_again()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator);
        var stranger = await server.NewAccount();
        var theirs = new SoftwareAuthenticator();
        var other = await PasskeyFlow.AddOk(stranger.Client, theirs);

        // Asked again to delete this account, the stranger's passkey is refused.
        var refused = await PasskeyFlow.Confirm(account.Client, theirs, "/account/delete", "/account/delete", new() { Use = other });
        Assert.Contains("The passkey was not accepted.", await Text(refused));
        await using (var db = server.NewDb())
            Assert.Null((await db.Users.AsNoTracking().SingleAsync(u => u.Id == account.Id)).DeletedAt);

        // A credential already on an account is never written over: the stranger's id with this
        // account's new key (Identity's own check, and ours behind it).
        byte[] key;
        await using (var db = server.NewDb())
            key = (await db.UserPasskeys.AsNoTracking().SingleAsync(p => p.UserId == stranger.Id)).Data.PublicKey;
        var taken = await PasskeyFlow.Add(account.Client, new SoftwareAuthenticator(), returnUrl: Settings, tweaks: new() { CredentialId = other.Id });
        Assert.Equal(HttpStatusCode.OK, taken.StatusCode);
        Assert.Contains("The passkey was not accepted.", await Text(taken));
        Assert.Single((await List(account.Client)).EnumerateArray());
        await using (var db = server.NewDb())
        {
            var kept = await db.UserPasskeys.AsNoTracking().SingleAsync(p => p.CredentialId == other.Id);
            Assert.Equal(stranger.Id, kept.UserId);
            Assert.Equal(key, kept.Data.PublicKey);
        }
        Assert.Equal(HttpStatusCode.Redirect, (await PasskeyFlow.SignIn(server.Anonymous(), theirs)).StatusCode);
    }

    [Fact]
    public async Task Removing_a_passkey_stops_it_at_once_and_renaming_is_checked()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        var passkey = await PasskeyFlow.AddOk(account.Client, authenticator, "First");
        Assert.Equal(HttpStatusCode.Redirect, (await PasskeyFlow.SignIn(server.Anonymous(), authenticator)).StatusCode);

        var renamed = await account.Client.PatchAsJsonAsync($"/api/v1/account/passkeys/{passkey.IdText}", new { name = "  Work phone  " });
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal("Work phone", (await Kit.Json(renamed)).GetProperty("name").GetString());
        foreach (var bad in new[] { "", "   ", new string('x', 61), "\u0007" })
            Assert.Equal(HttpStatusCode.BadRequest, (await account.Client.PatchAsJsonAsync($"/api/v1/account/passkeys/{passkey.IdText}", new { name = bad })).StatusCode);
        Assert.Single(await Audit(account.Id, "account.passkey.rename"));

        // Nobody else renames or removes it, and an id that is not one is not found.
        var stranger = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Client.PatchAsJsonAsync($"/api/v1/account/passkeys/{passkey.IdText}", new { name = "Mine" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Client.DeleteAsync($"/api/v1/account/passkeys/{passkey.IdText}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await account.Client.DeleteAsync("/api/v1/account/passkeys/not*base64")).StatusCode);
        // A cookie session's writes need the antiforgery header, as every write does.
        var csrf = account.Client.DefaultRequestHeaders.GetValues("X-CSRF-TOKEN").Single();
        account.Client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        Assert.Equal(HttpStatusCode.BadRequest, (await account.Client.DeleteAsync($"/api/v1/account/passkeys/{passkey.IdText}")).StatusCode);
        account.Client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", csrf);

        Assert.Equal(HttpStatusCode.NoContent, (await account.Client.DeleteAsync($"/api/v1/account/passkeys/{passkey.IdText}")).StatusCode);
        Assert.Empty((await List(account.Client)).EnumerateArray());
        Assert.Single(await Audit(account.Id, "account.passkey.remove"));
        Assert.Contains(Refused, await Text(await PasskeyFlow.SignIn(server.Anonymous(), authenticator)));
        Assert.Equal(HttpStatusCode.NotFound, (await account.Client.DeleteAsync($"/api/v1/account/passkeys/{passkey.IdText}")).StatusCode);
    }

    [Fact]
    public async Task The_desktop_signs_in_through_a_passkey_in_the_system_browser()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator);

        // The system browser, signed out: /connect/authorize sends it to sign in.
        var browser = server.Anonymous();
        var (verifier, challenge) = AccountTests.Pkce();
        var authorize = await browser.GetAsync(AccountTests.AuthorizeUrl(challenge, 50123, "desk"));
        Assert.Equal(HttpStatusCode.Redirect, authorize.StatusCode);
        var signInUrl = authorize.Headers.Location!.ToString();
        var back = QueryHelpers.ParseQuery(new Uri("https://localhost" + signInUrl).Query)["returnUrl"].ToString();
        Assert.StartsWith("/connect/authorize?", back);

        // A passkey signs the browser in and goes back to the question; Continue gives the code.
        var signedIn = await PasskeyFlow.SignIn(browser, authenticator, back);
        Assert.Equal(HttpStatusCode.Redirect, signedIn.StatusCode);
        Assert.Equal(back, signedIn.Headers.Location!.ToString());
        var question = await browser.GetAsync(back);
        Assert.Equal(HttpStatusCode.OK, question.StatusCode);
        var accepted = await ServerFixture.Submit(browser, await Text(question), "/connect/authorize", ("cgw_consent", "accept"));
        Assert.Equal(HttpStatusCode.Redirect, accepted.StatusCode);
        var query = QueryHelpers.ParseQuery(accepted.Headers.Location!.Query);
        Assert.Equal("desk", query["state"].ToString());
        var token = await server.Anonymous().PostAsync("/connect/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = "cgw-desktop",
            ["code"] = query["code"].ToString(),
            ["redirect_uri"] = "http://127.0.0.1:50123/callback",
            ["code_verifier"] = verifier,
        }));
        var body = await Kit.Json(token);
        Assert.True(token.IsSuccessStatusCode, body.ToString());
        var desktop = server.Anonymous();
        desktop.DefaultRequestHeaders.Authorization = new("Bearer", body.GetProperty("access_token").GetString());
        Assert.Equal(account.Id, (await desktop.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("id").GetGuid());
        // The desktop lists its passkeys too (a bearer token, as /account/* has).
        Assert.Single((await List(desktop)).EnumerateArray());
        Assert.Contains(await Audit(account.Id, "account.signin"), a => a.Detail!.Contains("\"platform\":\"desktop\"", StringComparison.Ordinal) && a.Detail.Contains("\"method\":\"passkey\"", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Lockout_holds_for_passkeys_as_for_passwords()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator);
        // Five answers signed by the wrong key lock the account, as five wrong passwords do.
        for (var i = 0; i < 5; i++)
            Assert.Contains(Refused, await Text(await PasskeyFlow.SignIn(server.Anonymous(), authenticator, tweaks: new() { SignWith = ECDsa.Create(ECCurve.NamedCurves.nistP256) })));
        await using (var db = server.NewDb())
            Assert.True((await db.Users.AsNoTracking().SingleAsync(u => u.Id == account.Id)).LockoutEnd > DateTimeOffset.UtcNow);
        // Locked, the right passkey reads as any refusal; and the password too.
        var devices = await Devices(account.Id);
        Assert.Contains(Refused, await Text(await PasskeyFlow.SignIn(server.Anonymous(), authenticator)));
        Assert.Contains(AccountTests.Generic, await Text(await ServerFixture.SignIn(server.Anonymous(), account.Email, account.Password)));
        Assert.Equal(devices, await Devices(account.Id));
        Assert.Contains(await Audit(account.Id, "signin.lockedOut"), a => a.Detail!.Contains("\"method\":\"passkey\"", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_good_passkey_resets_the_failed_count()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator);
        for (var i = 0; i < 3; i++) await ServerFixture.SignIn(server.Anonymous(), account.Email, "wrong password " + i);
        Assert.Equal(HttpStatusCode.Redirect, (await PasskeyFlow.SignIn(server.Anonymous(), authenticator)).StatusCode);
        await using var db = server.NewDb();
        Assert.Equal(0, (await db.Users.AsNoTracking().SingleAsync(u => u.Id == account.Id)).AccessFailedCount);
    }

    [Fact]
    public async Task Adding_needs_a_sign_in_of_the_last_ten_minutes_or_the_password_or_a_passkey_again()
    {
        var clock = new MovableClock();
        var api = server.Variant(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var account = await server.NewAccount();
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, account.Email, account.Password);
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(client, authenticator);

        clock.Advance(TimeSpan.FromMinutes(11));
        var page = await client.GetAsync("/account/passkeys/new?return=" + Uri.EscapeDataString(Settings));
        var html = await Text(page);
        Assert.Contains("Confirm it is you", html);
        Assert.Contains("type=\"password\"", html);
        Assert.Contains("Confirm with a passkey", html);
        var token = PasskeyFlow.Token(html);
        Assert.Equal(HttpStatusCode.Forbidden, (await PasskeyFlow.AskOptions(client, "/account/passkey/creation-options", token)).StatusCode);

        // A wrong password is refused (and counts); the right one makes the session recent.
        var wrong = await ServerFixture.Submit(client, html, "/account/passkeys/confirm", ("Password", "not the password"));
        Assert.Contains("The password is not right.", await Text(wrong));
        var right = await ServerFixture.Submit(client, html, "/account/passkeys/confirm", ("Password", account.Password));
        Assert.Equal(HttpStatusCode.Redirect, right.StatusCode);
        Assert.Equal("/account/passkeys/new?lang=en&return=" + Uri.EscapeDataString(Settings), right.Headers.Location!.ToString());
        Assert.Contains("Name, to tell your passkeys apart", await Text(await client.GetAsync(right.Headers.Location)));
        await PasskeyFlow.AddOk(client, authenticator);
        Assert.Contains(await Audit(account.Id, "account.reauthenticate"), a => a.Detail!.Contains("\"method\":\"password\"", StringComparison.Ordinal));

        // Later again, a passkey of the account answers instead, on the same device.
        clock.Advance(TimeSpan.FromMinutes(11));
        var device = (await client.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("deviceId").GetString();
        var confirmed = await PasskeyFlow.Confirm(client, authenticator, "/account/passkeys/new", "/account/passkeys/confirm");
        Assert.Equal(HttpStatusCode.Redirect, confirmed.StatusCode);
        await PasskeyFlow.AddOk(client, authenticator);
        Assert.Equal(device, (await client.GetFromJsonAsync<JsonElement>("/api/v1/account/me")).GetProperty("deviceId").GetString());
        Assert.Equal(3, (await List(client)).GetArrayLength());

        // Signed out, the page sends the browser to sign in and back to it.
        var signedOut = await ServerFixture.ClientOf(api).GetAsync("/account/passkeys/new?lang=ar&return=" + Uri.EscapeDataString(Settings));
        Assert.Equal(HttpStatusCode.Redirect, signedOut.StatusCode);
        Assert.Equal(AccountPages.SignInFor(AccountPages.AddPasskeyUrl("ar", Settings), "ar"), signedOut.Headers.Location!.ToString());
    }

    [Fact]
    public async Task An_account_has_twenty_passkeys_at_most()
    {
        var account = await server.NewAccount();
        var second = ServerFixture.ClientOf(server.Api);
        await ServerFixture.SignIn(second, account.Email, account.Password);
        var authenticator = new SoftwareAuthenticator();
        for (var i = 0; i < Passkeys.Max - 1; i++) await PasskeyFlow.AddOk(account.Client, authenticator, $"Key {i}");

        // Two pages at once at 19: the options of both, then both answers; the second is refused.
        var token = PasskeyFlow.Token(await Text(await second.GetAsync("/account/passkeys/new")));
        var (late, _) = authenticator.Create(await PasskeyFlow.Options(second, "/account/passkey/creation-options", token));
        await PasskeyFlow.AddOk(account.Client, authenticator, "Twentieth");
        var refused = await second.PostAsync("/account/passkeys/new", PasskeyFlow.Form(token, late, Settings, ("Name", "Too many")));
        Assert.Contains("Your account has 20 passkeys", await Text(refused));
        Assert.Equal(Passkeys.Max, (await List(account.Client)).GetArrayLength());

        // The page says so, and no options are made.
        var page = await Text(await account.Client.GetAsync("/account/passkeys/new"));
        Assert.Contains("Your account has 20 passkeys", page);
        Assert.Equal(HttpStatusCode.Conflict, (await PasskeyFlow.AskOptions(account.Client, "/account/passkey/creation-options", PasskeyFlow.Token(await Text(await account.Client.GetAsync("/account/signin"))))).StatusCode);
    }

    [Fact]
    public async Task Deleting_the_account_takes_a_passkey_and_its_passkeys_go()
    {
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator);
        var page = await Text(await account.Client.GetAsync("/account/delete"));
        Assert.Contains("type=\"password\"", page);
        Assert.Contains("Delete my account with a passkey", page);
        Assert.Contains("script-src 'self'", (await account.Client.GetAsync("/account/delete")).Headers.GetValues("Content-Security-Policy").Single());

        var deleted = await PasskeyFlow.Confirm(account.Client, authenticator, "/account/delete", "/account/delete");
        Assert.Contains("Your account is deleted", await Text(deleted));
        await using var db = server.NewDb();
        Assert.NotNull((await db.Users.AsNoTracking().SingleAsync(u => u.Id == account.Id)).DeletedAt);
        Assert.False(await db.UserPasskeys.AnyAsync(p => p.UserId == account.Id));
        Assert.Contains(Refused, await Text(await PasskeyFlow.SignIn(server.Anonymous(), authenticator)));
    }

    [Fact]
    public async Task An_account_with_no_password_or_passkey_deletes_itself_after_a_recent_sign_in()
    {
        var clock = new MovableClock();
        var api = server.Variant(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var account = await server.NewAccount();
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, account.Email, account.Password);
        // As single sign-on will make them (Phase 11, M11.3): no password.
        await using (var db = server.NewDb())
            await db.Users.Where(u => u.Id == account.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.PasswordHash, (string?)null));

        clock.Advance(TimeSpan.FromMinutes(11));
        var stale = await Text(await client.GetAsync("/account/delete?returnUrl=" + Uri.EscapeDataString("http://localhost:5273/")));
        Assert.Contains("To delete your account, sign in again first.", stale);
        Assert.DoesNotContain("type=\"password\"", stale);
        var refused = await client.PostAsync("/account/delete", PasskeyFlow.Form(PasskeyFlow.Token(stale), ""));
        Assert.Contains("To delete your account, sign in again first.", await Text(refused));

        clock.Advance(TimeSpan.FromMinutes(-11));
        var recent = await Text(await client.GetAsync("/account/delete"));
        Assert.DoesNotContain("type=\"password\"", recent);
        Assert.Contains("Delete my account", recent);
        var done = await client.PostAsync("/account/delete", PasskeyFlow.Form(PasskeyFlow.Token(recent), ""));
        Assert.Contains("Your account is deleted", await Text(done));
    }

    [Fact]
    public async Task The_pages_run_one_script_of_their_own_and_nothing_inline()
    {
        var client = server.Anonymous();
        var signIn = await client.GetAsync("/account/signin?lang=ar");
        var csp = signIn.Headers.GetValues("Content-Security-Policy").Single();
        Assert.Contains("default-src 'none'", csp);
        Assert.Contains("script-src 'self';", csp);
        Assert.Contains("connect-src 'self';", csp);
        Assert.Contains("require-trusted-types-for 'script'", csp);
        Assert.DoesNotContain("unsafe", csp);
        Assert.DoesNotContain("'nonce-", csp);
        var html = await Text(signIn);
        Assert.Contains("dir=\"rtl\"", html);
        Assert.Contains(System.Text.Encodings.Web.HtmlEncoder.Default.Encode("تسجيل الدخول بمفتاح مرور"), html);
        Assert.Contains("autocomplete=\"username webauthn\"", html);
        // One script element, with a source and its integrity; no inline script, no handler attribute.
        var scripts = System.Text.RegularExpressions.Regex.Matches(html, "<script[^>]*>");
        var tag = Assert.Single(scripts).Value;
        var src = System.Text.RegularExpressions.Regex.Match(tag, "src=\"([^\"]+)\"").Groups[1].Value;
        Assert.StartsWith("/account/passkey.js?v=", src);
        Assert.Contains(tag + "</script>", html);
        Assert.DoesNotMatch(@"<[^>]+\son[a-z]+\s*=", html);
        Assert.DoesNotContain("javascript:", html, StringComparison.OrdinalIgnoreCase);

        var script = await client.GetAsync(src);
        Assert.Equal(HttpStatusCode.OK, script.StatusCode);
        Assert.Equal("text/javascript", script.Content.Headers.ContentType!.MediaType);
        var bytes = await script.Content.ReadAsByteArrayAsync();
        var integrity = System.Text.RegularExpressions.Regex.Match(tag, "integrity=\"([^\"]+)\"").Groups[1].Value;
        Assert.Equal("sha256-" + Convert.ToBase64String(SHA256.HashData(bytes)), integrity);
        var text = Encoding.UTF8.GetString(bytes);
        Assert.DoesNotContain("innerHTML", text, StringComparison.Ordinal);
        Assert.DoesNotContain("eval(", text, StringComparison.Ordinal);

        // A page with no ceremony has no script at all.
        var forgot = await client.GetAsync("/account/forgot");
        Assert.DoesNotContain("script-src", forgot.Headers.GetValues("Content-Security-Policy").Single());
        Assert.DoesNotContain("<script", await Text(forgot));
    }

    [Fact]
    public async Task The_adding_page_speaks_arabic_and_names_the_passkey_by_the_browser()
    {
        var account = await server.NewAccount();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/account/passkeys/new?lang=ar&return=" + Uri.EscapeDataString(Settings));
        request.Headers.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0");
        var html = await Text(await account.Client.SendAsync(request));
        Assert.Contains("dir=\"rtl\"", html);
        Assert.Contains(System.Text.Encodings.Web.HtmlEncoder.Default.Encode("إضافة مفتاح مرور"), html);
        Assert.Contains("value=\"Edge on Windows\"", html);
        Assert.Contains("<label for=\"name\">", html);
        // The other language's link keeps where to go back to.
        var other = WebUtility.HtmlDecode(System.Text.RegularExpressions.Regex.Match(html, "<nav><a href=\"([^\"]+)\"").Groups[1].Value);
        Assert.Equal($"/account/passkeys/new?return={Uri.EscapeDataString(Settings)}&lang=en", other);
        // With no name given, the passkey is named for where it was made, else "Passkey".
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator, "");
        Assert.Equal("Passkey", Assert.Single((await List(account.Client)).EnumerateArray()).GetProperty("name").GetString());
        var tooLong = await PasskeyFlow.Add(account.Client, authenticator, new string('n', 61), Settings);
        Assert.Contains("A name of 1 to 60 characters is needed.", await Text(tooLong));
    }

    [Fact]
    public async Task Passkey_sign_ins_share_the_sign_in_rate_limit()
    {
        var api = server.Variant(b => b.UseSetting("RateLimits:signin", "2"));
        var account = await server.NewAccount();
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator);
        var client = ServerFixture.ClientOf(api);
        for (var i = 0; i < 2; i++) Assert.Equal(HttpStatusCode.Redirect, (await PasskeyFlow.SignIn(client, authenticator)).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await PasskeyFlow.SignIn(client, authenticator)).StatusCode);
    }

    [Fact]
    public void Only_the_apis_own_origin_may_run_a_ceremony()
    {
        var http = new DefaultHttpContext();
        http.Request.Scheme = "http";
        http.Request.Host = new HostString("localhost", 5280);
        bool Allowed(string? origin, bool fromRequest, bool cross = false, string? top = null) =>
            PasskeySetup.OriginAllowed(origin, cross, top, http.Request, "https://workspace-api.cashgearerp.com", fromRequest);
        Assert.True(Allowed("https://workspace-api.cashgearerp.com", fromRequest: false));
        Assert.False(Allowed("https://workspace.cashgearerp.com", fromRequest: false));
        Assert.False(Allowed("https://workspace-api.cashgearerp.com:8443", fromRequest: false));
        Assert.False(Allowed("http://workspace-api.cashgearerp.com", fromRequest: false));
        Assert.False(Allowed("https://workspace-api.cashgearerp.com/account", fromRequest: false));
        Assert.False(Allowed("https://workspace-api.cashgearerp.com", fromRequest: false, cross: true));
        Assert.False(Allowed("https://workspace-api.cashgearerp.com", fromRequest: false, top: "https://evil.example"));
        Assert.False(Allowed(null, fromRequest: false));
        // The request's own origin, on a developer's machine only (the e2e stack's localhost:5280).
        Assert.False(Allowed("http://localhost:5280", fromRequest: false));
        Assert.True(Allowed("http://localhost:5280", fromRequest: true));
        Assert.False(Allowed("http://localhost:4268", fromRequest: true));
    }

    private static IConfiguration Config(params (string Key, string Value)[] pairs) =>
        new ConfigurationBuilder().AddInMemoryCollection(pairs.Select(p => KeyValuePair.Create(p.Key, (string?)p.Value))).Build();

    [Fact]
    public void Production_names_the_relying_party_as_the_apis_host()
    {
        var production = new Env("Production");
        (string, string)[] complete =
        [
            ("Web:Origins:0", "https://workspace.cashgearerp.com"), ("Api:PublicUrl", "https://workspace-api.cashgearerp.com"), ("DataProtection:Dpapi", "true"),
            ("Sheet:Origin", "https://sheet.cashgearerp.com"), ("Sheet:Origins:0", "https://sheet.cashgearerp.com"), ("Erp:ApiBase", "https://api.cashgearerp.com"),
            ("Sites:PublicUrl", "https://pages.cashgearerp.com"), ("Plugins:PublicUrl", "https://plugins.cashgearerp.com"),
        ];
        Assert.Contains(Cgw.Api.Infrastructure.ProductionChecks.Problems(Config(complete), production, windows: true), p => p.Contains("Identity__Passkeys__ServerDomain", StringComparison.Ordinal));
        Assert.Empty(Cgw.Api.Infrastructure.ProductionChecks.Problems(Config([.. complete, ("Identity:Passkeys:ServerDomain", "workspace-api.cashgearerp.com")]), production, windows: true));
        // A wider id would let the ERP, the sites and the plugins ask for assertions.
        Assert.Contains(Cgw.Api.Infrastructure.ProductionChecks.Problems(Config([.. complete, ("Identity:Passkeys:ServerDomain", "cashgearerp.com")]), production, windows: true), p => p.Contains("must be the host of Api__PublicUrl", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Every_process_builds_the_one_model_the_migrations_hold()
    {
        // Identity maps its passkeys only for a host whose IdentityOptions ask for its schema 3, which
        // would also narrow Phase 2's columns in that host alone: CgwDb maps them itself, the same in
        // the API (which has Identity), the worker and NewDb (which have none).
        await using var scope = server.Api.Services.CreateAsyncScope();
        var api = scope.ServiceProvider.GetRequiredService<CgwDb>();
        Assert.Equal(IdentitySchemaVersions.Default, scope.ServiceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<IdentityOptions>>().Value.Stores.SchemaVersion);
        await using var plain = server.NewDb();
        await using var workerScope = server.Worker.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<CgwDb>();
        // The fixture's database was migrated through NewDb's model, which EF refuses if it differs
        // from the migrations. The design-time models: a runtime model gains the ad-hoc types other
        // tests' raw queries made.
        static string Of(CgwDb db) => db.GetService<Microsoft.EntityFrameworkCore.Metadata.IDesignTimeModel>().Model.ToDebugString();
        var expected = Of(plain);
        Assert.Equal(expected, Of(api));
        Assert.Equal(expected, Of(worker));
        Assert.Equal("UserPasskeys", api.Model.FindEntityType(typeof(IdentityUserPasskey<Guid>))!.GetTableName());
    }
}
