using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Cgw.Tests;

/// <summary>A workspace's single sign-on as a test set it up: its realm of the mock provider, its client, its verified domain.</summary>
public sealed record SsoSetup(Ws Ws, string Issuer, string ClientId, string Secret, string Domain);

/// <summary>A sign-in through the provider as a browser makes it: the API's last answer, and the addresses it went through.</summary>
public sealed record SsoRun(HttpResponseMessage Response, Uri? Authorize, Uri? Callback, string? StateCookie, string? StateHeader = null)
{
    public async Task<string> Text() => await Response.Content.ReadAsStringAsync();
}

/// <summary>
/// Phase 11 (M11.3): single sign-on's steps against the mock provider (<c>tests/mocks/oidc</c>), each
/// test in a realm of its own (its own issuer, client, people queued and fault) and a domain of its
/// own (<c>{guid}.test</c>: a verified domain is one workspace's across the whole database).
/// </summary>
public static class SsoKit
{
    /// <summary>Where the API sends the provider's answer (<c>Api:PublicUrl</c> is <c>https://localhost</c> in the tests).</summary>
    public const string Callback = "https://localhost/account/sso/callback";

    /// <summary>A client of the mock: no cookies, no redirects followed (the test reads each <c>Location</c>).</summary>
    public static readonly HttpClient Mock = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(30) };

    public static string NewDomain() => $"{Guid.NewGuid():N}.test";

    /// <summary>A secret with the characters RFC 6749's encoding changes, so a client that does not encode them fails at the mock.</summary>
    public static string NewSecret() => "s3cr+t%:/~=" + Guid.NewGuid().ToString("N");

    /// <summary>The mock's <c>hashOf</c>: the first 16 hex digits of the value's SHA-256.</summary>
    public static string HashOf(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..16];

    public static async Task<HttpResponseMessage> Control(string issuer, string path, object body)
    {
        var response = await Mock.PostAsJsonAsync($"{issuer}/__mock/{path}", body);
        Assert.True(response.IsSuccessStatusCode, $"{path}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return response;
    }

    public static async Task Client(string issuer, string clientId, string secret, string alg = "RS256") =>
        await Control(issuer, "clients", new { clientId, clientSecret = secret, redirectUris = new[] { Callback }, alg });

    /// <summary>The next person the provider signs in (no page). <paramref name="emailVerified"/>: true, false, or null to leave the claim out.</summary>
    public static async Task Next(string issuer, string email, string? sub = null, string? name = null, bool? emailVerified = true, bool sendVerified = true)
    {
        var body = new JsonObject { ["email"] = email };
        if (sub is not null) body["sub"] = sub;
        if (name is not null) body["name"] = name;
        if (sendVerified) body["emailVerified"] = emailVerified;
        await Control(issuer, "next", body);
    }

    public static async Task NextError(string issuer, string error) => await Control(issuer, "next", new { error });

    public static async Task Fault(string issuer, string? kind) => await Control(issuer, "fault", new { kind });

    /// <summary>The DNS stand-in's records for a name (shared by every realm).</summary>
    public static async Task Dns(ServerFixture server, string name, params string[] txt) =>
        await Control(server.OidcMockUrl, "dns", new { name, txt });

    public static async Task<JsonElement> Requests(string issuer, string endpoint) =>
        (await Mock.GetFromJsonAsync<JsonElement>($"{issuer}/__mock/requests?endpoint={endpoint}")).GetProperty("requests");

    public static string Route(Ws ws, string path = "") => $"/api/v1/workspaces/{ws.Id}/sso{path}";

    public static async Task<HttpResponseMessage> SetProvider(HttpClient client, Ws ws, object body) =>
        await client.PutAsJsonAsync(Route(ws, "/provider"), body);

    /// <summary>Adds a domain, sets its record at the DNS stand-in, verifies it.</summary>
    public static async Task<JsonElement> VerifiedDomain(ServerFixture server, Ws ws, string domain)
    {
        var added = await ws.Client.PostAsJsonAsync(Route(ws, "/domains"), new { domain });
        Assert.True(added.StatusCode == HttpStatusCode.Created, await added.Content.ReadAsStringAsync());
        var record = (await Kit.Json(added)).GetProperty("record");
        await Dns(server, record.GetProperty("name").GetString()!, record.GetProperty("value").GetString()!);
        var verified = await ws.Client.PostAsync(Route(ws, $"/domains/{domain}/verify"), null);
        Assert.True(verified.IsSuccessStatusCode, await verified.Content.ReadAsStringAsync());
        return await Kit.Json(verified);
    }

    /// <summary>A realm with a client, the workspace's provider set to it, and a verified domain of the test's own.</summary>
    public static async Task<SsoSetup> SetUp(ServerFixture server, Ws ws, string alg = "RS256", string? domain = null, object? extra = null)
    {
        var issuer = server.NewOidcIssuer();
        var clientId = "cgw-" + Guid.NewGuid().ToString("N")[..12];
        var secret = NewSecret();
        await Client(issuer, clientId, secret, alg);
        var body = new JsonObject { ["issuer"] = issuer, ["clientId"] = clientId, ["clientSecret"] = secret };
        if (extra is not null)
            foreach (var (key, value) in JsonSerializer.SerializeToNode(extra, new JsonSerializerOptions(JsonSerializerDefaults.Web))!.AsObject())
                body[key] = value?.DeepClone();
        var set = await SetProvider(ws.Client, ws, body);
        Assert.True(set.IsSuccessStatusCode, await set.Content.ReadAsStringAsync());
        domain ??= NewDomain();
        await VerifiedDomain(server, ws, domain);
        return new SsoSetup(ws, issuer, clientId, secret, domain);
    }

    /// <summary>
    /// "Sign in with your organisation's account" as a browser does it: the page, its form, the
    /// provider's <c>/authorize</c> (the person queued with <see cref="Next"/>), back to the callback.
    /// Signed in, the client gets its antiforgery header, as <see cref="ServerFixture.SignIn"/> does.
    /// </summary>
    public static async Task<SsoRun> SignIn(HttpClient browser, string email, string? returnUrl = null, string lang = "en")
    {
        var page = await browser.GetAsync($"/account/sso?lang={lang}" + (returnUrl is null ? "" : "&returnUrl=" + Uri.EscapeDataString(returnUrl)));
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var start = await ServerFixture.Submit(browser, await page.Content.ReadAsStringAsync(), "/account/sso", ("Email", email));
        if (start.StatusCode != HttpStatusCode.Redirect) return new SsoRun(start, null, null, null);
        var header = start.Headers.TryGetValues("Set-Cookie", out var cookies)
            ? cookies.FirstOrDefault(c => c.StartsWith("cgw_sso=", StringComparison.Ordinal))
            : null;
        var cookie = header?.Split(';')[0];
        var authorize = start.Headers.Location!;
        var answer = await Mock.GetAsync(authorize);
        Assert.True(answer.Headers.Location is not null, $"The provider did not send the browser back: {(int)answer.StatusCode} {await answer.Content.ReadAsStringAsync()}");
        var callback = answer.Headers.Location!;
        Assert.StartsWith(Callback + "?", callback.ToString(), StringComparison.Ordinal);
        var done = await browser.GetAsync(callback.PathAndQuery);
        if (done.StatusCode == HttpStatusCode.Redirect) await Csrf(browser);
        return new SsoRun(done, authorize, callback, cookie, header);
    }

    /// <summary>The antiforgery header for a signed-in client's writes.</summary>
    public static async Task Csrf(HttpClient client)
    {
        var csrf = await client.GetFromJsonAsync<JsonElement>("/api/v1/account/antiforgery");
        client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
        client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", csrf.GetProperty("token").GetString());
    }

    /// <summary>A confirmed account with the given address (or a fresh one), signed in by password on a client of <paramref name="api"/>.</summary>
    public static async Task<Account> NewAccount(ServerFixture server, string email, WebApplicationFactory<Program>? api = null, string? name = null)
    {
        var password = "correct horse battery " + Guid.NewGuid().ToString("N")[..6];
        var client = ServerFixture.ClientOf(api ?? server.Api);
        var register = await client.PostAsJsonAsync("/api/v1/account/register", new { email, password, displayName = name ?? email.Split('@')[0], locale = "en" });
        Assert.Equal(HttpStatusCode.Accepted, register.StatusCode);
        var link = ServerFixture.Link(await server.MailTo(email), "/account/confirm");
        var confirmed = await ServerFixture.OpenAndSubmit(client, link, "/account/confirm");
        Assert.Contains("Your email is confirmed", await confirmed.Content.ReadAsStringAsync());
        var signedIn = await ServerFixture.SignIn(client, email, password);
        Assert.Equal(HttpStatusCode.Redirect, signedIn.StatusCode);
        var me = await client.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
        return new Account(client, email, password, me.GetProperty("id").GetGuid());
    }

    public static async Task<JsonElement> Me(HttpClient client) => await client.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
}
