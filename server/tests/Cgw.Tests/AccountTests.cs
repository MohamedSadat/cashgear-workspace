using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Cgw.Core.Data;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>M2.2: accounts, sessions, devices and the desktop's PKCE sign-in.</summary>
public sealed class AccountTests(ServerFixture server)
{
    [Fact]
    public async Task Sign_up_confirm_sign_in_and_out()
    {
        var account = await server.NewAccount("Ada");
        var me = await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
        Assert.Equal("Ada", me.GetProperty("displayName").GetString());
        Assert.True(me.TryGetProperty("deviceId", out var device) && device.ValueKind == JsonValueKind.String);

        var devices = await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/devices");
        Assert.Contains(devices.EnumerateArray(), d => d.GetProperty("current").GetBoolean() && d.GetProperty("platform").GetString() == "web");

        Assert.Equal(HttpStatusCode.NoContent, (await account.Client.PostAsync("/api/v1/account/signout", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);
    }

    [Fact]
    public async Task The_session_cookie_is_http_only_secure_and_lax()
    {
        var client = server.Anonymous();
        var email = $"cookie-{Guid.NewGuid():N}@example.test";
        await client.PostAsJsonAsync("/api/v1/account/register", new { email, password = "long enough password", displayName = "C" });
        await client.GetAsync(ServerFixture.Link(await server.MailTo(email), "/account/confirm"));
        var response = await ServerFixture.SignIn(client, email, "long enough password");
        var cookie = response.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("cgw_session=", StringComparison.Ordinal)).ToLowerInvariant();
        Assert.Contains("httponly", cookie);
        Assert.Contains("secure", cookie);
        Assert.Contains("samesite=lax", cookie);
    }

    [Fact]
    public async Task Writes_from_a_cookie_session_need_the_antiforgery_header()
    {
        var account = await server.NewAccount();
        var token = account.Client.DefaultRequestHeaders.GetValues("X-CSRF-TOKEN").Single();
        account.Client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        var refused = await account.Client.PatchAsJsonAsync("/api/v1/account/me", new { displayName = "Forged" });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("request.invalid", (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        account.Client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await account.Client.PatchAsJsonAsync("/api/v1/account/me", new { displayName = "Real" })).StatusCode);
    }

    [Fact]
    public async Task An_unconfirmed_account_cannot_sign_in()
    {
        var client = server.Anonymous();
        var email = $"unconfirmed-{Guid.NewGuid():N}@example.test";
        await client.PostAsJsonAsync("/api/v1/account/register", new { email, password = "long enough password", displayName = "U" });
        var response = await ServerFixture.SignIn(client, email, "long enough password");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("Confirm your email first", await response.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/account/me")).StatusCode);
    }

    [Fact]
    public async Task Signing_up_with_a_taken_email_looks_the_same_and_tells_the_owner()
    {
        var account = await server.NewAccount();
        var response = await server.Anonymous().PostAsJsonAsync("/api/v1/account/register", new { email = account.Email, password = "another long password", displayName = "X" });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Contains("already", await server.MailTo(account.Email, "already"));
    }

    [Fact]
    public async Task Short_passwords_are_refused()
    {
        var response = await server.Anonymous().PostAsJsonAsync("/api/v1/account/register", new { email = $"short-{Guid.NewGuid():N}@example.test", password = "short", displayName = "S" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("request.invalid", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Five_wrong_passwords_lock_the_account()
    {
        var account = await server.NewAccount();
        var client = server.Anonymous();
        for (var i = 0; i < 5; i++) await ServerFixture.SignIn(client, account.Email, "wrong password " + i);
        var locked = await ServerFixture.SignIn(client, account.Email, account.Password);
        Assert.Contains("Too many tries", await locked.Content.ReadAsStringAsync());
        await using var db = server.NewDb();
        Assert.True(await db.AuditLog.IgnoreQueryFilters().AnyAsync(a => a.ActorUserId == account.Id && a.Action == "signin.lockedOut"));
    }

    [Fact]
    public async Task Return_addresses_stay_on_known_origins()
    {
        var account = await server.NewAccount();
        var client = server.Anonymous();
        var evil = await ServerFixture.SignIn(client, account.Email, account.Password, "https://evil.example/steal");
        Assert.Equal("http://localhost:5273", evil.Headers.Location?.ToString().TrimEnd('/'));
        var client2 = server.Anonymous();
        var good = await ServerFixture.SignIn(client2, account.Email, account.Password, "http://localhost:5273/#/p/x");
        Assert.Equal("http://localhost:5273/#/p/x", good.Headers.Location?.ToString());
    }

    [Fact]
    public async Task A_password_reset_signs_every_device_out()
    {
        var account = await server.NewAccount();
        var other = server.Anonymous();
        await ServerFixture.SignIn(other, account.Email, account.Password);
        Assert.Equal(HttpStatusCode.Accepted, (await server.Anonymous().PostAsJsonAsync("/api/v1/account/password/forgot", new { email = account.Email })).StatusCode);
        var link = new Uri(ServerFixture.Link(await server.MailTo(account.Email, "reset"), "/account/reset"));
        var query = QueryHelpers.ParseQuery(link.Query);
        var reset = await server.Anonymous().PostAsJsonAsync("/api/v1/account/password/reset", new { userId = query["userId"].ToString(), code = query["code"].ToString(), password = "a brand new password" });
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await other.GetAsync("/api/v1/account/me")).StatusCode);
        var again = server.Anonymous();
        Assert.Equal(HttpStatusCode.Redirect, (await ServerFixture.SignIn(again, account.Email, "a brand new password")).StatusCode);
    }

    [Fact]
    public async Task Signing_a_device_out_ends_its_session()
    {
        var account = await server.NewAccount();
        var second = server.Anonymous();
        await ServerFixture.SignIn(second, account.Email, account.Password);
        var secondMe = await second.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
        var secondDevice = secondMe.GetProperty("deviceId").GetString();
        Assert.Equal(HttpStatusCode.NoContent, (await account.Client.DeleteAsync($"/api/v1/account/devices/{secondDevice}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await second.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);
        // Someone else's device is not found.
        var stranger = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Client.DeleteAsync($"/api/v1/account/devices/{Guid.NewGuid()}")).StatusCode);
    }

    public static (string Verifier, string Challenge) Pkce()
    {
        var verifier = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var challenge = WebEncoders.Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        return (verifier, challenge);
    }

    /// <summary>The desktop's flow, with the test as the system browser and the loopback listener.</summary>
    public static async Task<(string Access, string Refresh)> DesktopSignIn(Account account, int port = 54321)
    {
        var (verifier, challenge) = Pkce();
        var redirect = $"http://127.0.0.1:{port}/callback";
        var state = Guid.NewGuid().ToString("N");
        var authorize = await account.Client.GetAsync(
            $"/connect/authorize?client_id=cgw-desktop&response_type=code&scope=offline_access%20workspace&redirect_uri={Uri.EscapeDataString(redirect)}&code_challenge={challenge}&code_challenge_method=S256&state={state}&device_name=Test%20desktop");
        Assert.Equal(HttpStatusCode.Redirect, authorize.StatusCode);
        var location = authorize.Headers.Location!;
        Assert.StartsWith(redirect, location.ToString());
        var query = QueryHelpers.ParseQuery(location.Query);
        Assert.Equal(state, query["state"].ToString());
        var token = await account.Client.PostAsync("/connect/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = "cgw-desktop",
            ["code"] = query["code"].ToString(),
            ["redirect_uri"] = redirect,
            ["code_verifier"] = verifier,
        }));
        var body = await token.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(token.IsSuccessStatusCode, body.ToString());
        return (body.GetProperty("access_token").GetString()!, body.GetProperty("refresh_token").GetString()!);
    }

    [Fact]
    public async Task The_desktop_signs_in_with_pkce_on_any_loopback_port_and_refreshes()
    {
        var account = await server.NewAccount();
        var (access, refresh) = await DesktopSignIn(account, port: 61234);
        var bearer = server.Anonymous();
        bearer.DefaultRequestHeaders.Authorization = new("Bearer", access);
        var me = await bearer.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
        Assert.Equal(account.Id, me.GetProperty("id").GetGuid());
        // A bearer write needs no antiforgery header.
        Assert.Equal(HttpStatusCode.NoContent, (await bearer.PatchAsJsonAsync("/api/v1/account/me", new { locale = "ar" })).StatusCode);

        var refreshed = await server.Anonymous().PostAsync("/connect/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["client_id"] = "cgw-desktop",
            ["refresh_token"] = refresh,
        }));
        Assert.True(refreshed.IsSuccessStatusCode);

        // Signing the device out stops its tokens at once.
        var deviceId = me.GetProperty("deviceId").GetString();
        Assert.Equal(HttpStatusCode.NoContent, (await account.Client.DeleteAsync($"/api/v1/account/devices/{deviceId}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await bearer.GetAsync("/api/v1/account/me")).StatusCode);
        var afterRevoke = await server.Anonymous().PostAsync("/connect/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["client_id"] = "cgw-desktop",
            ["refresh_token"] = refresh,
        }));
        Assert.False(afterRevoke.IsSuccessStatusCode);
    }

    [Fact]
    public async Task Redirects_other_than_the_loopback_callback_are_refused()
    {
        var account = await server.NewAccount();
        var (_, challenge) = Pkce();
        foreach (var redirect in new[] { "http://127.0.0.1:5000/elsewhere", "http://evil.example/callback", "https://127.0.0.1:5000/callback" })
        {
            var response = await account.Client.GetAsync(
                $"/connect/authorize?client_id=cgw-desktop&response_type=code&scope=offline_access&redirect_uri={Uri.EscapeDataString(redirect)}&code_challenge={challenge}&code_challenge_method=S256");
            Assert.NotEqual(HttpStatusCode.Redirect, response.StatusCode);
        }
        // No PKCE, no code.
        var plain = await account.Client.GetAsync("/connect/authorize?client_id=cgw-desktop&response_type=code&scope=offline_access&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback");
        Assert.NotEqual(HttpStatusCode.Redirect, plain.StatusCode);
    }

    [Fact]
    public async Task Authorise_without_a_session_goes_to_the_sign_in_page_and_back()
    {
        var (_, challenge) = Pkce();
        var client = server.Anonymous();
        var response = await client.GetAsync($"/connect/authorize?client_id=cgw-desktop&response_type=code&scope=offline_access&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&code_challenge={challenge}&code_challenge_method=S256&ui_locales=ar");
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        var location = response.Headers.Location!.ToString();
        Assert.StartsWith("/account/signin?lang=ar&returnUrl=%2Fconnect%2Fauthorize", location);
        var page = await (await client.GetAsync(location)).Content.ReadAsStringAsync();
        Assert.Contains("dir=\"rtl\"", page);
        Assert.Matches(new Regex("name=\"ReturnUrl\" value=\"/connect/authorize"), page);
        await using var db = server.NewDb();
        Assert.True(await db.Devices.AnyAsync());
    }
}
