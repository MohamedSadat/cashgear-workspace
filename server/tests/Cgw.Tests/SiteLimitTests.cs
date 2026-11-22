using System.Net;
using Cgw.Sites;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 14, M14.3: the Sites process's rate limit. One address has its own window of pages and
/// files across every site (an IPv6 address by its /64), the plugins host one of its own; past it,
/// 429 with <c>Retry-After</c> and the page in both languages, and nothing it asks reaches the
/// database; <c>robots.txt</c> and health stay outside it.
/// </summary>
public sealed class SiteLimitTests(ServerFixture server)
{
    private const int Pages = 5;
    private const int PluginFiles = 7;

    private WebApplicationFactory<SitesProgram> Limited() => server.NewSites(b =>
    {
        b.UseSetting(SiteLimits.PagesKey, Pages.ToString(System.Globalization.CultureInfo.InvariantCulture));
        b.UseSetting(SiteLimits.PluginsKey, PluginFiles.ToString(System.Globalization.CultureInfo.InvariantCulture));
        b.ConfigureTestServices(s => s.AddSingleton<IStartupFilter, Addresses>());
    });

    private static HttpClient From(HttpClient client, string address)
    {
        client.DefaultRequestHeaders.Remove(Addresses.Header);
        client.DefaultRequestHeaders.Add(Addresses.Header, address);
        return client;
    }

    private static string Slug() => "limit-" + Guid.NewGuid().ToString("N")[..20];

    [Fact]
    public async Task One_address_past_its_window_is_answered_429_before_anything_reads_the_database()
    {
        await using var sites = Limited();
        var reader = From(ServerFixture.SiteClient(sites), "203.0.113.7");
        using var sql = SqlCommands.Watch();
        // An unknown slug is read from the database once (then remembered a few seconds): the watch sees it.
        var first = Slug();
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/{first}")).StatusCode);
        Assert.NotEmpty(sql.Carrying(first));
        for (var i = 1; i < Pages; i++)
            Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/{Slug()}")).StatusCode);

        var past = Slug();
        sql.Clear();
        var refused = await reader.GetAsync($"/{past}");
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Empty(sql.Carrying(past));
        var wait = Assert.Single(refused.Headers.GetValues("Retry-After"));
        Assert.InRange(int.Parse(wait, System.Globalization.CultureInfo.InvariantCulture), 1, 60);
        Assert.Equal("text/html", refused.Content.Headers.ContentType?.MediaType);
        var page = await refused.Content.ReadAsStringAsync();
        Assert.Contains("Too many requests", page, StringComparison.Ordinal);
        Assert.Contains("lang=\"ar\"", page, StringComparison.Ordinal);
        // The site's headers still: its policy, no cookie, not indexed.
        Assert.StartsWith("default-src 'none'", Assert.Single(refused.Headers.GetValues("Content-Security-Policy")), StringComparison.Ordinal);
        Assert.False(refused.Headers.Contains("Set-Cookie"));
        Assert.Equal("noindex", Assert.Single(refused.Headers.GetValues("X-Robots-Tag")));
        // A file is in the same window.
        Assert.Equal(HttpStatusCode.TooManyRequests, (await reader.GetAsync($"/{Slug()}/files/{Guid.NewGuid()}")).StatusCode);

        // Crawlers' and IIS's paths are outside it.
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync("/robots.txt")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync("/health/live")).StatusCode);

        // Another address reads on.
        var other = From(ServerFixture.SiteClient(sites), "198.51.100.20");
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/{Slug()}")).StatusCode);
    }

    [Fact]
    public async Task An_ipv6_address_is_counted_by_its_64_bits_and_the_plugins_host_has_a_window_of_its_own()
    {
        await using var sites = Limited();
        var one = From(ServerFixture.SiteClient(sites), "2001:db8:1:2::1");
        var same = From(ServerFixture.SiteClient(sites), "2001:db8:1:2:ffff::9");
        var next = From(ServerFixture.SiteClient(sites), "2001:db8:1:3::1");
        for (var i = 0; i < Pages; i++)
            Assert.Equal(HttpStatusCode.NotFound, (await (i % 2 == 0 ? one : same).GetAsync($"/{Slug()}")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await one.GetAsync($"/{Slug()}")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await same.GetAsync($"/{Slug()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await next.GetAsync($"/{Slug()}")).StatusCode);

        // The same address on the plugins host: a window of its own, wider.
        var plugins = From(ServerFixture.PluginClient(sites), "2001:db8:1:2::1");
        for (var i = 0; i < PluginFiles; i++)
            Assert.Equal(HttpStatusCode.NotFound, (await plugins.GetAsync($"/f/nothing-{i}/index.html")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await plugins.GetAsync("/f/nothing/index.html")).StatusCode);
    }

    [Theory]
    [InlineData("203.0.113.7", "203.0.113.7")]
    [InlineData("::ffff:203.0.113.7", "203.0.113.7")]
    [InlineData("2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64")]
    public void A_window_is_an_ipv4_address_or_an_ipv6_64(string address, string partition) =>
        Assert.Equal(partition, SiteLimits.Partition(IPAddress.Parse(address)));

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
