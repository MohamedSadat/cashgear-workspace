using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Domains;
using Cgw.Core.Sites;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Cgw.Tests;

/// <summary>
/// Phase 14, M14.4: a workspace's host names for its sites. Owners and admins add one, prove it by its
/// <c>TXT</c> record and remove it; everyone reads the proven ones; whoever may publish gives a site
/// one; the Sites process serves the site there once its certificate is live, from <c>/</c>, and the
/// slug's addresses lead there; the worker gets the certificate by ACME (against the mock, HTTP-01
/// answered by the Sites process), renews it, and takes a name whose proof is lost off its site.
/// </summary>
public sealed class SiteDomainTests(ServerFixture server)
{
    private static string Route(Ws ws, string rest = "") => $"/api/v1/workspaces/{ws.Id}/publishing/domains{rest}";

    /// <summary>A name only this test uses: under <c>.localhost</c> (pointed here by itself) or <c>example.test</c> (pointed nowhere).</summary>
    private static string Host(string under = "localhost") => $"docs-{Guid.NewGuid():N}"[..17] + "." + under;

    private static string Slug(string stem) => $"{stem}-{Guid.NewGuid():N}"[..(stem.Length + 13)];

    private static async Task<JsonElement> Added(HttpClient client, Ws ws, string host)
    {
        var response = await client.PostAsJsonAsync(Route(ws), new { host });
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    /// <summary>A name added and proven by the workspace's owner.</summary>
    private async Task<(Guid Id, string Host)> Proven(Ws ws, string host)
    {
        var added = await Added(ws.Client, ws, host);
        var record = added.GetProperty("record");
        await SsoKit.Dns(server, record.GetProperty("name").GetString()!, record.GetProperty("value").GetString()!);
        var verified = await ws.Client.PostAsync(Route(ws, $"/{added.GetProperty("id").GetGuid()}/verify"), null);
        Assert.True(verified.IsSuccessStatusCode, await verified.Content.ReadAsStringAsync());
        return (added.GetProperty("id").GetGuid(), host);
    }

    private static async Task<HttpResponseMessage> Attach(HttpClient client, Guid page, string? host) =>
        await client.PutAsJsonAsync($"/api/v1/pages/{page}/site/domain", new { host });

    private static HttpClient At(WebApplicationFactory<Cgw.Sites.SitesProgram> sites, string host) => sites.CreateClient(new WebApplicationFactoryClientOptions
    {
        BaseAddress = new Uri($"http://{host}:5290"),
        HandleCookies = false,
        AllowAutoRedirect = false,
    });

    private async Task Live(Guid workspace, string host)
    {
        await using var db = server.NewDb(workspace);
        await db.SiteDomains.Where(d => d.Host == host).ExecuteUpdateAsync(u => u.SetProperty(d => d.Certificate, CertificateStates.Live));
    }

    [Fact]
    public async Task Owners_and_admins_add_prove_and_remove_a_host_name_and_everyone_reads_the_proven_ones()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var host = Host("example.test");

        foreach (var refused in new[] { member, guest })
        {
            var response = await refused.Client.PostAsJsonAsync(Route(ws), new { host });
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal("access.denied", await Kit.Code(response));
        }
        // Names that may not serve a site: the server's own, a single label, an address, a wildcard, a port.
        foreach (var bad in new[] { "localhost", "pages", "127.0.0.1", "*.example.test", "docs.example.test:443", "a.b", "", "x..example.test" })
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.Client.PostAsJsonAsync(Route(ws), new { host = bad })).StatusCode);

        var added = await Added(admin.Client, ws, host.ToUpperInvariant() + ".");
        Assert.Equal(host, added.GetProperty("host").GetString());
        Assert.Equal($"_cashgear-workspace.{host}", added.GetProperty("record").GetProperty("name").GetString());
        Assert.StartsWith("cgw-verify=", added.GetProperty("record").GetProperty("value").GetString(), StringComparison.Ordinal);
        Assert.Equal("localhost", added.GetProperty("target").GetString());
        Assert.Equal(JsonValueKind.Null, added.GetProperty("verifiedAt").ValueKind);
        Assert.Equal("none", added.GetProperty("certificate").GetString());
        var id = added.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Conflict, (await admin.Client.PostAsJsonAsync(Route(ws), new { host })).StatusCode);

        // Not proven yet: said, and nobody may choose it.
        var early = await admin.Client.PostAsync(Route(ws, $"/{id}/verify"), null);
        Assert.Equal(HttpStatusCode.BadRequest, early.StatusCode);
        Assert.Equal("domain.dnsNotFound", await Kit.Code(early));
        Assert.Empty((await member.Client.GetFromJsonAsync<JsonElement>(Route(ws))).GetProperty("choices").EnumerateArray());

        var record = added.GetProperty("record");
        await SsoKit.Dns(server, record.GetProperty("name").GetString()!, "v=spf1 -all", record.GetProperty("value").GetString()!);
        var verified = await Kit.Json(await admin.Client.PostAsync(Route(ws, $"/{id}/verify"), null));
        Assert.NotEqual(JsonValueKind.Null, verified.GetProperty("verifiedAt").ValueKind);

        // Everyone reads the proven names; only owners and admins the records and states.
        foreach (var who in new[] { member, guest })
        {
            var read = await who.Client.GetFromJsonAsync<JsonElement>(Route(ws));
            Assert.Empty(read.GetProperty("domains").EnumerateArray());
            Assert.Equal([host], read.GetProperty("choices").EnumerateArray().Select(c => c.GetProperty("host").GetString()));
            Assert.DoesNotContain("cgw-verify", read.GetRawText(), StringComparison.Ordinal);
        }
        var listed = await admin.Client.GetFromJsonAsync<JsonElement>(Route(ws));
        Assert.Equal([host], listed.GetProperty("domains").EnumerateArray().Select(d => d.GetProperty("host").GetString()));
        Assert.False(listed.GetProperty("certificates").GetBoolean());

        // Another workspace cannot take a name this one proved.
        var other = await Ws.Create(server);
        var taken = await other.Client.PostAsJsonAsync(Route(other), new { host });
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
        Assert.Equal("domain.taken", await Kit.Code(taken));

        Assert.Equal(HttpStatusCode.NoContent, (await admin.Client.DeleteAsync(Route(ws, $"/{id}"))).StatusCode);
        Assert.Empty((await admin.Client.GetFromJsonAsync<JsonElement>(Route(ws))).GetProperty("domains").EnumerateArray());
        await using (var db = server.NewDb(ws.Id))
        {
            var actions = await db.AuditLog.Where(a => a.WorkspaceId == ws.Id && a.Action.StartsWith("site.domain")).Select(a => a.Action).ToListAsync();
            Assert.Equal(["site.domain.add", "site.domain.verify", "site.domain.remove"], actions);
        }
        // Freed: the other workspace may add it now.
        Assert.Equal(HttpStatusCode.Created, (await other.Client.PostAsJsonAsync(Route(other), new { host })).StatusCode);
    }

    [Fact]
    public async Task A_site_given_a_proven_name_is_served_there_from_its_root_once_its_certificate_is_live()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var root = (await ws.NewPage("Handbook")).GetProperty("id").GetGuid();
        var chapter = (await ws.NewPage("Chapter", root)).GetProperty("id").GetGuid();
        var slug = Slug("handbook");
        Assert.True((await ws.Client.PutAsJsonAsync($"/api/v1/pages/{root}/site", new { slug, indexing = false, language = "en" })).IsSuccessStatusCode);
        var (_, host) = await Proven(ws, Host("example.test"));

        // Full on the page, a proven name, one site a name.
        Assert.Equal(HttpStatusCode.Forbidden, (await Attach(member.Client, root, host)).StatusCode);
        var unproven = await Added(ws.Client, ws, Host("example.test"));
        var refused = await Attach(ws.Client, root, unproven.GetProperty("host").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("domain.notVerified", await Kit.Code(refused));
        var given = await Kit.Json(await Attach(ws.Client, root, host));
        Assert.Equal(host, given.GetProperty("domain").GetProperty("host").GetString());
        Assert.Equal("none", given.GetProperty("domain").GetProperty("certificate").GetString());
        // Until its certificate is live the site stays at the slug's address.
        Assert.EndsWith("/" + slug, given.GetProperty("url").GetString(), StringComparison.Ordinal);
        var second = (await ws.NewPage("Second")).GetProperty("id").GetGuid();
        Assert.True((await ws.Client.PutAsJsonAsync($"/api/v1/pages/{second}/site", new { slug = Slug("second"), indexing = false, language = "en" })).IsSuccessStatusCode);
        var inUse = await Attach(ws.Client, second, host);
        Assert.Equal(HttpStatusCode.Conflict, inUse.StatusCode);
        Assert.Equal("domain.inUse", await Kit.Code(inUse));

        await using (var before = server.NewSites(_ => { }))
            Assert.Equal(HttpStatusCode.NotFound, (await At(before, host).GetAsync("/")).StatusCode);

        await Live(ws.Id, host);
        var site = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{root}/site")).GetProperty("site");
        Assert.Equal($"http://{host}:5290", site.GetProperty("url").GetString());

        await using var sites = server.NewSites(_ => { });
        var reader = At(sites, host);
        var home = await reader.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, home.StatusCode);
        var html = await home.Content.ReadAsStringAsync();
        Assert.Contains("Handbook", html, StringComparison.Ordinal);
        Assert.Contains($"href=\"/{chapter}\"", html, StringComparison.Ordinal);
        Assert.DoesNotContain($"/{slug}", html, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync($"/{chapter}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/{Guid.NewGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync($"/{slug}")).StatusCode);
        Assert.Equal("User-agent: *\nDisallow: /\n", await reader.GetStringAsync("/robots.txt"));
        Assert.Equal("noindex", Assert.Single(home.Headers.GetValues("X-Robots-Tag")));

        // The slug's addresses lead there, path and all.
        var pages = ServerFixture.SiteClient(sites);
        var moved = await pages.GetAsync($"/{slug}");
        Assert.Equal(HttpStatusCode.Redirect, moved.StatusCode);
        Assert.Equal($"http://{host}:5290/", moved.Headers.Location?.ToString());
        Assert.Equal($"http://{host}:5290/{chapter}", (await pages.GetAsync($"/{slug}/{chapter}")).Headers.Location?.ToString());

        // A name nobody proved, and another workspace's name: the 404 page.
        Assert.Equal(HttpStatusCode.NotFound, (await At(sites, Host("example.test")).GetAsync("/")).StatusCode);

        // Unpublished: the name serves nothing any more, and is free for another site.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/pages/{root}/site")).StatusCode);
        await using (var after = server.NewSites(_ => { }))
            Assert.Equal(HttpStatusCode.NotFound, (await At(after, host).GetAsync("/")).StatusCode);
        Assert.True((await Attach(ws.Client, second, host)).IsSuccessStatusCode);
    }

    [Fact]
    public async Task An_arabic_site_reads_at_its_own_name_right_to_left_in_its_language()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("دليل الفريق")).GetProperty("id").GetGuid();
        var chapter = (await ws.NewPage("الفصل الأول", root)).GetProperty("id").GetGuid();
        Assert.True((await ws.Client.PutAsJsonAsync($"/api/v1/pages/{root}/site", new { slug = Slug("dalil"), indexing = false, language = "ar" })).IsSuccessStatusCode);
        var (_, host) = await Proven(ws, Host("example.test"));
        Assert.True((await Attach(ws.Client, root, host)).IsSuccessStatusCode);
        await Live(ws.Id, host);

        await using var sites = server.NewSites(_ => { });
        var reader = At(sites, host);
        foreach (var path in new[] { "/", $"/{chapter}" })
        {
            var html = await reader.GetStringAsync(path);
            Assert.Contains("<html lang=\"ar\" dir=\"rtl\">", html, StringComparison.Ordinal);
            Assert.Contains($"href=\"/{chapter}\"", html, StringComparison.Ordinal);
            var title = path == "/" ? "دليل الفريق" : "الفصل الأول";
            Assert.True(html.Contains(title, StringComparison.Ordinal) || html.Contains(System.Text.Encodings.Web.HtmlEncoder.Default.Encode(title), StringComparison.Ordinal), path);
        }
    }

    [Fact]
    public async Task The_sites_answer_acmes_challenge_for_an_order_under_way_and_nothing_else()
    {
        var ws = await Ws.Create(server);
        var (_, host) = await Proven(ws, Host("example.test"));
        var token = "tok-" + Guid.NewGuid().ToString("N");
        await using (var db = server.NewDb(ws.Id))
            await db.SiteDomains.Where(d => d.Host == host).ExecuteUpdateAsync(u => u.SetProperty(d => d.ChallengeToken, token).SetProperty(d => d.ChallengeAnswer, token + ".thumb"));
        await using var sites = server.NewSites(_ => { });
        var reader = At(sites, host);
        var answer = await reader.GetAsync("/.well-known/acme-challenge/" + token);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Equal(token + ".thumb", await answer.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync("/.well-known/acme-challenge/other")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await At(sites, Host("example.test")).GetAsync("/.well-known/acme-challenge/" + token)).StatusCode);
        // The sites' own host, where the IIS host's port 80 sends ACME's path of a name it does not
        // bind yet: by the token alone.
        var own = ServerFixture.SiteClient(sites);
        var redirected = await own.GetAsync("/.well-known/acme-challenge/" + token);
        Assert.Equal(HttpStatusCode.OK, redirected.StatusCode);
        Assert.Equal(token + ".thumb", await redirected.Content.ReadAsStringAsync());
        Assert.Equal("no-store", redirected.Headers.CacheControl?.ToString());
        Assert.Equal(HttpStatusCode.NotFound, (await own.GetAsync("/.well-known/acme-challenge/tok-" + Guid.NewGuid().ToString("N"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await own.GetAsync("/.well-known/acme-challenge/a.b")).StatusCode);
        // Once the order is over, nowhere.
        await using (var db = server.NewDb(ws.Id))
            await db.SiteDomains.Where(d => d.Host == host).ExecuteUpdateAsync(u => u.SetProperty(d => d.ChallengeToken, (string?)null).SetProperty(d => d.ChallengeAnswer, (string?)null));
        Assert.Equal(HttpStatusCode.NotFound, (await own.GetAsync("/.well-known/acme-challenge/" + token)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await reader.GetAsync("/.well-known/acme-challenge/" + token)).StatusCode);
    }

    [Fact]
    public async Task The_worker_gets_a_certificate_by_acme_renews_it_and_takes_a_name_whose_proof_is_lost_off_its_site()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Notes")).GetProperty("id").GetGuid();
        Assert.True((await ws.Client.PutAsJsonAsync($"/api/v1/pages/{root}/site", new { slug = Slug("notes"), indexing = false, language = "en" })).IsSuccessStatusCode);
        var (id, host) = await Proven(ws, Host());
        Assert.True((await Attach(ws.Client, root, host)).IsSuccessStatusCode);

        await using var sites = server.NewSites(_ => { });
        using var bridge = new Bridge(sites);
        await using var acme = await MockAcme.StartAsync(server, bridge.Port);
        var store = Path.Combine(Path.GetTempPath(), "cgw-certs-" + Guid.NewGuid().ToString("N"));
        var password = Guid.NewGuid().ToString("N");
        var clock = TimeProvider.System;
        var job = new SiteCertificateJob(
            new SiteCertificateOptions(new Uri($"{acme.Url}/directory"), AgreeToTerms: true, Email: null, Store: store, Password: password),
            server.Worker.GetRequiredService<SitesOptions>(), server.Worker.GetRequiredService<IDomainDns>(),
            server.Worker.GetRequiredService<IDataProtectionProvider>(), clock, server.Worker.GetRequiredService<ILogger<SiteCertificateJob>>())
        { Only = [host] };
        async Task Run() => await JobLoop.RunOnceAsync(server.Worker, job, server.Worker.GetRequiredService<ILoggerFactory>().CreateLogger("test"), clock, CancellationToken.None);
        async Task<SiteDomain> Row()
        {
            await using var db = server.NewDb(ws.Id);
            return await db.SiteDomains.AsNoTracking().SingleAsync(d => d.Id == id);
        }
        // Time passing, as the worker would see it: the row's own times moved back.
        async Task Set(Action<Microsoft.EntityFrameworkCore.Query.UpdateSettersBuilder<SiteDomain>> set)
        {
            await using var db = server.NewDb(ws.Id);
            await db.SiteDomains.Where(d => d.Id == id).ExecuteUpdateAsync(set);
        }

        try
        {
            await Run();
            var row = await Row();
            Assert.True(row.Certificate == CertificateStates.Live, $"{row.Certificate} {row.CertificateError}");
            Assert.Null(row.ChallengeToken);
            Assert.InRange(row.CertificateExpiresAt!.Value, DateTimeOffset.UtcNow.AddDays(89), DateTimeOffset.UtcNow.AddDays(91));
            Assert.InRange(row.CertificateRenewAt!.Value, DateTimeOffset.UtcNow.AddDays(59), DateTimeOffset.UtcNow.AddDays(61));
            // The store's file: the name's certificate with its key, under the store's password.
            using (var pfx = X509CertificateLoader.LoadPkcs12FromFile(Path.Combine(store, host + ".pfx"), password))
            {
                Assert.True(pfx.HasPrivateKey);
                Assert.Equal(host, pfx.GetNameInfo(X509NameType.DnsName, false));
                Assert.Equal(row.CertificateThumbprint, pfx.Thumbprint);
            }
            // The account's key is kept as Data Protection's output, never in a file.
            await using (var db = server.NewDb())
            {
                var account = await db.AcmeAccounts.AsNoTracking().SingleAsync(a => a.Directory == $"{acme.Url}/directory");
                Assert.DoesNotContain("PRIVATE", account.KeyCipher, StringComparison.Ordinal);
            }
            Assert.Single(Directory.EnumerateFiles(store));
            // Live: the site is served at its name.
            await using (var fresh = server.NewSites(_ => { }))
                Assert.Equal(HttpStatusCode.OK, (await At(fresh, host).GetAsync("/")).StatusCode);

            // Nothing due: nothing ordered. Past two thirds of its lifetime: renewed by the same account.
            await Run();
            Assert.Equal(1, await acme.CertificatesAsync());
            await Set(u => u.SetProperty(d => d.CertificateRenewAt, DateTimeOffset.UtcNow.AddMinutes(-1)));
            await Run();
            Assert.Equal(2, await acme.CertificatesAsync());
            Assert.True((await Row()).CertificateRenewAt > DateTimeOffset.UtcNow.AddDays(55));

            // A challenge that fails: the order is tried again later, the certificate still live.
            await Set(u => u.SetProperty(d => d.CertificateRenewAt, DateTimeOffset.UtcNow.AddMinutes(-1)));
            await acme.FaultAsync("challenge");
            await Run();
            row = await Row();
            Assert.Equal(CertificateStates.Live, row.Certificate);
            Assert.Equal("challenge", row.CertificateError);
            Assert.True(row.CertificateNextAttemptAt > DateTimeOffset.UtcNow.AddMinutes(59));

            // The proof gone: kept a day, then the name leaves its site and its certificate goes.
            await SsoKit.Dns(server, SiteHosts.RecordName(host));
            await Set(u => u.SetProperty(d => d.ProofCheckedAt, DateTimeOffset.UtcNow.AddDays(-2)));
            await Run();
            row = await Row();
            Assert.NotNull(row.ProofMissingSince);
            Assert.NotNull(row.SiteId);
            await Set(u => u.SetProperty(d => d.ProofCheckedAt, DateTimeOffset.UtcNow.AddDays(-2)).SetProperty(d => d.ProofMissingSince, DateTimeOffset.UtcNow.AddDays(-1.5)));
            await Run();
            row = await Row();
            Assert.Null(row.SiteId);
            Assert.Null(row.VerifiedAt);
            Assert.False(File.Exists(Path.Combine(store, host + ".pfx")));
            await using (var db = server.NewDb(ws.Id))
                Assert.Contains(await db.AuditLog.Where(a => a.WorkspaceId == ws.Id && a.Action == "site.domain").Select(a => a.Detail).ToListAsync(), d => d!.Contains("proof.lost", StringComparison.Ordinal));
        }
        finally
        {
            if (Directory.Exists(store)) Directory.Delete(store, recursive: true);
        }
    }

    [Fact]
    public async Task A_name_that_does_not_lead_here_is_not_ordered_and_says_so()
    {
        var ws = await Ws.Create(server);
        var root = (await ws.NewPage("Elsewhere")).GetProperty("id").GetGuid();
        Assert.True((await ws.Client.PutAsJsonAsync($"/api/v1/pages/{root}/site", new { slug = Slug("elsewhere"), indexing = false, language = "en" })).IsSuccessStatusCode);
        var (id, host) = await Proven(ws, Host("example.test"));
        Assert.True((await Attach(ws.Client, root, host)).IsSuccessStatusCode);
        await using var acme = await MockAcme.StartAsync(server, 9);
        var job = new SiteCertificateJob(
            new SiteCertificateOptions(new Uri($"{acme.Url}/directory"), true, null, Path.Combine(Path.GetTempPath(), "cgw-certs-" + Guid.NewGuid().ToString("N")), "x"),
            server.Worker.GetRequiredService<SitesOptions>(), server.Worker.GetRequiredService<IDomainDns>(),
            server.Worker.GetRequiredService<IDataProtectionProvider>(), TimeProvider.System, server.Worker.GetRequiredService<ILogger<SiteCertificateJob>>())
        { Only = [host] };
        await JobLoop.RunOnceAsync(server.Worker, job, server.Worker.GetRequiredService<ILoggerFactory>().CreateLogger("test"), TimeProvider.System, CancellationToken.None);
        await using var db = server.NewDb(ws.Id);
        var row = await db.SiteDomains.AsNoTracking().SingleAsync(d => d.Id == id);
        Assert.Equal(CertificateStates.Failed, row.Certificate);
        Assert.Equal("notPointed", row.CertificateError);
        Assert.Equal(0, await acme.CertificatesAsync());
        var listed = await ws.Client.GetFromJsonAsync<JsonElement>(Route(ws));
        Assert.Equal("notPointed", listed.GetProperty("domains").EnumerateArray().Single(d => d.GetProperty("host").GetString() == host).GetProperty("certificateError").GetString());
    }

    /// <summary>The mock ACME server (<c>tests/mocks/acme</c>) of one test, fetching challenges from <paramref name="challengePort"/>.</summary>
    private sealed class MockAcme : IAsyncDisposable
    {
        private static readonly HttpClient Http = new();
        private readonly Process process;

        public string Url { get; }

        private MockAcme(Process process, string url)
        {
            this.process = process;
            Url = url;
        }

        public static async Task<MockAcme> StartAsync(ServerFixture server, int challengePort)
        {
            var port = FreePort();
            var process = Process.Start(new ProcessStartInfo("node",
            [
                Path.Combine(server.Root, "tests", "mocks", "acme", "server.mjs"), "--port", port.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--host", "127.0.0.1", "--challenge-port", challengePort.ToString(System.Globalization.CultureInfo.InvariantCulture), "--resolve", "127.0.0.1",
            ])
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }) ?? throw new InvalidOperationException("The mock ACME server did not start.");
            var url = $"http://127.0.0.1:{port}";
            for (var i = 0; i < 100; i++)
            {
                try
                {
                    if ((await Http.GetAsync($"{url}/directory")).IsSuccessStatusCode) return new MockAcme(process, url);
                }
                catch (HttpRequestException)
                {
                }
                await Task.Delay(100);
            }
            process.Kill(entireProcessTree: true);
            throw new InvalidOperationException("The mock ACME server did not answer.");
        }

        public async Task<int> CertificatesAsync() =>
            (await Http.GetFromJsonAsync<JsonElement>($"{Url}/__mock/state")).GetProperty("certificates").GetArrayLength();

        public async Task FaultAsync(string kind) =>
            (await Http.PostAsJsonAsync($"{Url}/__mock/fault", new { kind })).EnsureSuccessStatusCode();

        private static int FreePort()
        {
            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }

        public ValueTask DisposeAsync()
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }
            process.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    /// <summary>A real port in front of the Sites process's test server: what ACME's validator reaches, its <c>Host</c> kept.</summary>
    private sealed class Bridge : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);

        public int Port { get; }

        public Bridge(WebApplicationFactory<Cgw.Sites.SitesProgram> sites)
        {
            listener.Start();
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var client = sites.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    TcpClient socket;
                    try
                    {
                        socket = await listener.AcceptTcpClientAsync();
                    }
                    catch (Exception e) when (e is SocketException or ObjectDisposedException)
                    {
                        return;
                    }
                    _ = Task.Run(async () =>
                    {
                        using var _ = socket;
                        var stream = socket.GetStream();
                        var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
                        var line = await reader.ReadLineAsync() ?? "";
                        string? host = null;
                        for (var header = await reader.ReadLineAsync(); !string.IsNullOrEmpty(header); header = await reader.ReadLineAsync())
                            if (header.StartsWith("Host:", StringComparison.OrdinalIgnoreCase)) host = header[5..].Trim();
                        var request = new HttpRequestMessage(HttpMethod.Get, "http://" + (host ?? "localhost") + (line.Split(' ').ElementAtOrDefault(1) ?? "/"));
                        using var response = await client.SendAsync(request);
                        var body = await response.Content.ReadAsByteArrayAsync();
                        var head = $"HTTP/1.1 {(int)response.StatusCode} X\r\nContent-Length: {body.Length}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n";
                        await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
                        await stream.WriteAsync(body);
                    });
                }
            });
        }

        public void Dispose() => listener.Stop();
    }
}
