using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Cgw.Api.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Whose window a request counts in (CLAUDE.md, Phase 12): a person's, by the web's cookie or the
/// desktop's token alike, whatever address they ask from; an address's for a caller not signed in,
/// and on the anonymous, sign-in and token routes whoever asks (OpenIddict's taken before
/// authentication, which answers what it refuses there). Each test runs on a variant of its own with
/// the limits it tests, every request from the address its client names (<see cref="Addresses"/>):
/// in the tests every request otherwise comes from one address.
/// </summary>
public sealed class RateLimitTests(ServerFixture server)
{
    private const string Office = "203.0.113.10";
    private const string Home = "198.51.100.20";
    private const string Cafe = "192.0.2.30";

    [Fact]
    public async Task A_person_has_one_window_from_every_address_and_people_behind_one_address_have_one_each()
    {
        const int limit = 6;
        await using var api = Limited((RateLimits.User, limit), (RateLimits.Realtime, 3));
        var alice = await server.NewAccount();
        var bob = await server.NewAccount();
        // Alice in her browser at the office and on her desktop at home; Bob in his browser at the office.
        var aliceWeb = await Browser(api, alice, Office);
        var aliceDesktop = await Desktop(api, alice, Home);
        var bobWeb = await Browser(api, bob, Office);

        // Alice's requests from both addresses, by cookie and by token in turn, fill one window
        // between them (her sign-ins' reads of the antiforgery token were in it first).
        var sent = 0;
        HttpResponseMessage? refused = null;
        while (refused is null && sent < 2 * limit)
        {
            var response = await (sent % 2 == 0 ? aliceWeb : aliceDesktop).GetAsync("/api/v1/account/me");
            sent++;
            if (response.StatusCode == HttpStatusCode.TooManyRequests) refused = response;
            else Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        Assert.NotNull(refused);
        Assert.True(sent <= limit, $"Alice sent {sent} requests before one was refused; her window is {limit}");
        Assert.Equal("limit.rate", await Kit.Code(refused));
        Assert.NotNull(refused.Headers.RetryAfter);
        // Every way in of hers is refused now, from either address.
        Assert.Equal(HttpStatusCode.TooManyRequests, (await aliceWeb.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await aliceDesktop.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await From(aliceDesktop, Office).GetAsync("/api/v1/account/me")).StatusCode);
        // Bob, behind the same office address, has a window of his own.
        Assert.Equal(HttpStatusCode.OK, (await bobWeb.GetAsync("/api/v1/account/me")).StatusCode);

        // Someone not signed in at the office is counted by the address, apart from both of them...
        var stranger = Anonymous(api, Office);
        sent = 0;
        refused = null;
        while (refused is null && sent < 2 * limit)
        {
            var response = await stranger.GetAsync("/api/v1/account/session");
            sent++;
            if (response.StatusCode == HttpStatusCode.TooManyRequests) refused = response;
            else Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        Assert.NotNull(refused);
        Assert.Equal(limit + 1, sent);
        // ...and the address's window is not anyone's who is signed in there, nor another address's.
        Assert.Equal(HttpStatusCode.OK, (await bobWeb.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Anonymous(api, Home).GetAsync("/api/v1/account/session")).StatusCode);

        // Another of the person's policies, the hub's tickets: Alice's three from two addresses, then none.
        Assert.Equal(HttpStatusCode.OK, (await From(aliceWeb, Office).PostAsync("/api/v1/realtime/tickets", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await From(aliceDesktop, Home).PostAsync("/api/v1/realtime/tickets", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await aliceDesktop.PostAsync("/api/v1/realtime/tickets", null)).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await aliceWeb.PostAsync("/api/v1/realtime/tickets", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await bobWeb.PostAsync("/api/v1/realtime/tickets", null)).StatusCode);
    }

    [Fact]
    public async Task Anonymous_sign_in_and_token_routes_count_by_address_whoever_asks()
    {
        await using var api = Limited((RateLimits.Anonymous, 2), (RateLimits.SignIn, 2), (RateLimits.Token, 2));
        var alice = await server.NewAccount();
        // Alice signs in from an address of its own: her sign-in is in that address's window.
        var aliceWeb = await Browser(api, alice, Cafe);
        var office = Anonymous(api, Office);
        var home = Anonymous(api, Home);

        // An anonymous route: the office's two, then none, for Alice there too; home has its own.
        for (var i = 0; i < 2; i++) Assert.Equal(HttpStatusCode.OK, (await office.GetAsync("/api/v1/version")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await office.GetAsync("/api/v1/version")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await From(aliceWeb, Office).GetAsync("/api/v1/version")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await home.GetAsync("/api/v1/version")).StatusCode);

        // A sign-in route, the same.
        HttpContent Forgot() => JsonContent.Create(new { email = $"nobody-{Guid.NewGuid():N}@example.test", locale = "en" });
        for (var i = 0; i < 2; i++) Assert.Equal(HttpStatusCode.Accepted, (await office.PostAsync("/api/v1/account/password/forgot", Forgot())).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await office.PostAsync("/api/v1/account/password/forgot", Forgot())).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await aliceWeb.PostAsync("/api/v1/account/password/forgot", Forgot())).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await home.PostAsync("/api/v1/account/password/forgot", Forgot())).StatusCode);

        // OpenIddict's token and revocation routes, which it refuses inside authentication: still
        // limited, by address.
        FormUrlEncodedContent Grant() => new(new Dictionary<string, string> { ["grant_type"] = "refresh_token", ["client_id"] = "cgw-desktop", ["refresh_token"] = "x" });
        FormUrlEncodedContent Revoke() => new(new Dictionary<string, string> { ["token"] = "x", ["client_id"] = "cgw-desktop" });
        foreach (var (path, body) in new (string, Func<HttpContent>)[] { ("/connect/token", Grant), ("/connect/revoke", Revoke) })
        {
            for (var i = 0; i < 2; i++) Assert.NotEqual(HttpStatusCode.TooManyRequests, (await office.PostAsync(path, body())).StatusCode);
            var refused = await office.PostAsync(path, body());
            Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
            Assert.Equal("limit.rate", await Kit.Code(refused));
            Assert.NotNull(refused.Headers.RetryAfter);
            Assert.NotEqual(HttpStatusCode.TooManyRequests, (await home.PostAsync(path, body())).StatusCode);
        }

        // Every route of OpenIddict's has an address's policy: no person is known before authentication.
        var connect = server.Api.Services.GetServices<EndpointDataSource>().SelectMany(s => s.Endpoints).OfType<RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText?.StartsWith("/connect", StringComparison.Ordinal) == true).ToList();
        Assert.Contains(connect, e => e.RoutePattern.RawText == "/connect/token");
        Assert.All(connect, e => Assert.True(
            e.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName is RateLimits.SignIn or RateLimits.Token, e.RoutePattern.RawText));
    }

    /// <summary>The API with these limits a minute, each request from the address its client names.</summary>
    private WebApplicationFactory<Program> Limited(params (string Policy, int PerMinute)[] limits) =>
        server.Variant(b =>
        {
            foreach (var (policy, perMinute) in limits)
                b.UseSetting($"RateLimits:{policy}", perMinute.ToString(CultureInfo.InvariantCulture));
            b.ConfigureTestServices(s => s.AddSingleton<IStartupFilter, Addresses>());
        });

    private static HttpClient From(HttpClient client, string address)
    {
        client.DefaultRequestHeaders.Remove(Addresses.Header);
        client.DefaultRequestHeaders.Add(Addresses.Header, address);
        return client;
    }

    private static HttpClient Anonymous(WebApplicationFactory<Program> api, string address) => From(ServerFixture.ClientOf(api), address);

    /// <summary>A browser signed in on this API, with its antiforgery header.</summary>
    private static async Task<HttpClient> Browser(WebApplicationFactory<Program> api, Account account, string address)
    {
        var client = Anonymous(api, address);
        Assert.Equal(HttpStatusCode.Redirect, (await ServerFixture.SignIn(client, account.Email, account.Password)).StatusCode);
        return client;
    }

    /// <summary>The desktop: signed in through a browser on this API, then its access token alone, no cookie.</summary>
    private static async Task<HttpClient> Desktop(WebApplicationFactory<Program> api, Account account, string address)
    {
        var (access, _) = await AccountTests.DesktopSignIn(account with { Client = await Browser(api, account, address) });
        var client = Anonymous(api, address);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", access);
        return client;
    }

    /// <summary>The request's address from <c>X-Test-Address</c>, before anything else reads it.</summary>
    private sealed class Addresses : IStartupFilter
    {
        public const string Header = "X-Test-Address";

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((context, rest) =>
            {
                if (IPAddress.TryParse(context.Request.Headers[Header].ToString(), out var address))
                    context.Connection.RemoteIpAddress = address;
                return rest(context);
            });
            next(app);
        };
    }
}
