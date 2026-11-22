using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Api.Identity;
using Cgw.Core.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenIddict.EntityFrameworkCore.Models;

namespace Cgw.Tests;

/// <summary>
/// Phase 11 (M11.3): single sign-on through a workspace's own OpenID Connect provider, against the
/// mock provider (<c>tests/mocks/oidc</c>, a realm per test) and its DNS stand-in.
/// </summary>
public sealed class SsoTests(ServerFixture server)
{
    private const string App = "http://localhost:5273/#/p/x";
    private const string NoProvider = "No organisation sign-in is set up for this address.";
    /// <summary>The codes the pages carry on their refusals (<c>data-code</c>), for the e2e specs and the app.</summary>
    private const string Required = "data-code=\"" + "sso.required" + "\"";
    private const string Failed = "data-code=\"" + "sso.failed" + "\"";

    private async Task<List<AuditEntry>> Audit(Func<AuditEntry, bool> where)
    {
        await using var db = server.NewDb();
        return (await db.AuditLog.IgnoreQueryFilters().AsNoTracking().OrderBy(a => a.CreatedAt).ToListAsync()).Where(where).ToList();
    }

    private async Task<User?> UserByEmail(string email)
    {
        await using var db = server.NewDb();
        var normalised = email.ToUpperInvariant();
        return await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.NormalizedEmail == normalised);
    }

    private static async Task<HttpStatusCode> MeStatus(HttpClient client) => (await client.GetAsync("/api/v1/account/me")).StatusCode;

    [Fact]
    public async Task A_person_of_a_verified_domain_signs_in_with_no_password_making_their_account_and_joining_as_a_member()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        var email = $"ada@{sso.Domain}";
        await SsoKit.Next(sso.Issuer, email, sub: "sub-ada-" + sso.Domain, name: "Ada Lovelace");

        var browser = server.Anonymous();
        var run = await SsoKit.SignIn(browser, email, App);
        Assert.True(run.Response.StatusCode == HttpStatusCode.Redirect, await run.Text());
        Assert.Equal(App, run.Response.Headers.Location!.ToString());

        // The request to the provider: the code flow, PKCE S256, state, nonce, the address as a hint.
        var asked = QueryHelpers.ParseQuery(run.Authorize!.Query);
        Assert.StartsWith(sso.Issuer + "/authorize?", run.Authorize.ToString(), StringComparison.Ordinal);
        Assert.Equal("code", asked["response_type"].ToString());
        Assert.Equal(sso.ClientId, asked["client_id"].ToString());
        Assert.Equal(SsoKit.Callback, asked["redirect_uri"].ToString());
        Assert.Equal("openid email profile", asked["scope"].ToString());
        Assert.Equal("S256", asked["code_challenge_method"].ToString());
        Assert.Equal(43, asked["code_challenge"].ToString().Length);
        Assert.Equal(email, asked["login_hint"].ToString());
        Assert.Equal("query", asked["response_mode"].ToString());
        Assert.True(asked["state"].ToString().Length >= 43 && asked["nonce"].ToString().Length >= 43);
        Assert.NotEqual(asked["state"].ToString(), asked["nonce"].ToString());
        // The state cookie: HttpOnly, Lax, ten minutes, the whole site's path.
        var cookie = run.StateHeader!.ToLowerInvariant();
        Assert.Contains("httponly", cookie, StringComparison.Ordinal);
        Assert.Contains("samesite=lax", cookie, StringComparison.Ordinal);
        Assert.Contains("max-age=600", cookie, StringComparison.Ordinal);
        Assert.Contains("path=/", cookie, StringComparison.Ordinal);

        // The client authenticated by client_secret_basic, its parts form-encoded (the mock decodes strictly).
        var token = Assert.Single((await SsoKit.Requests(sso.Issuer, "token")).EnumerateArray());
        Assert.Equal(200, token.GetProperty("status").GetInt32());
        Assert.Equal("client_secret_basic", token.GetProperty("auth").GetString());
        Assert.Equal(SsoKit.HashOf(sso.Secret), token.GetProperty("secretHash").GetString());

        // The account: confirmed, no password, named by the provider, linked by (provider, sub).
        var me = await SsoKit.Me(browser);
        Assert.Equal(email, me.GetProperty("email").GetString());
        Assert.Equal("Ada Lovelace", me.GetProperty("displayName").GetString());
        Assert.False(me.GetProperty("hasPassword").GetBoolean());
        Assert.False(me.GetProperty("ssoRequired").GetBoolean());
        var userId = me.GetProperty("id").GetGuid();
        await using (var db = server.NewDb())
        {
            var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == userId);
            Assert.True(user.EmailConfirmed);
            Assert.Null(user.PasswordHash);
            var login = Assert.Single(await db.UserLogins.AsNoTracking().Where(l => l.UserId == userId).ToListAsync());
            Assert.Equal("sso:" + ws.Id.ToString("D"), login.LoginProvider);
            Assert.Equal("sub-ada-" + sso.Domain, login.ProviderKey);
            // Its device is the provider's, and ends SessionHours (24) after the sign-in.
            var device = await db.Devices.AsNoTracking().FirstAsync(d => d.Id == me.GetProperty("deviceId").GetGuid());
            Assert.Equal(ws.Id, device.SsoWorkspaceId);
            Assert.InRange(device.EndsAt!.Value - DateTimeOffset.UtcNow, TimeSpan.FromHours(23.9), TimeSpan.FromHours(24.1));
            // A member, with the feed's entries a join writes.
            db.Scope.Enter(ws.Id);
            Assert.Equal(Roles.Member, (await db.WorkspaceMembers.AsNoTracking().FirstAsync(m => m.UserId == userId)).Role);
            var changes = await db.WorkspaceChanges.AsNoTracking().Where(c => c.EntityId == userId || c.UserId == userId).ToListAsync();
            Assert.Contains(changes, c => c.EntityType == "member" && c.Kind == "upsert" && c.EntityId == userId);
            Assert.Contains(changes, c => c.EntityType == "access" && c.Kind == "grant" && c.UserId == userId);
        }
        // The workspace is theirs to open, as a member's.
        var list = await browser.GetFromJsonAsync<JsonElement>("/api/v1/workspaces");
        Assert.Contains(list.EnumerateArray(), w => w.GetProperty("id").GetGuid() == ws.Id && w.GetProperty("role").GetString() == "member");
        // Audited: the account made by sign-on, the join, the sign-in with its method.
        var audit = await Audit(a => a.ActorUserId == userId);
        Assert.Contains(audit, a => a.Action == "account.create" && a.Detail!.Contains("\"by\":\"sso\"", StringComparison.Ordinal));
        Assert.Contains(audit, a => a.Action == "sso.account" && a.WorkspaceId == ws.Id);
        Assert.Contains(audit, a => a.Action == "member.add" && a.WorkspaceId == ws.Id && a.Detail!.Contains("\"via\":\"sso\"", StringComparison.Ordinal));
        Assert.Contains(audit, a => a.Action == "account.signin" && a.Detail!.Contains("\"method\":\"sso\"", StringComparison.Ordinal));
        // The session writes as any other (its antiforgery header).
        Assert.Equal(HttpStatusCode.NoContent, (await browser.PatchAsJsonAsync("/api/v1/account/me", new { locale = "ar" })).StatusCode);

        // The second sign-in finds the account by its subject, even with the address changed at the provider.
        await SsoKit.Next(sso.Issuer, $"ada.lovelace@{sso.Domain}", sub: "sub-ada-" + sso.Domain);
        var again = await SsoKit.SignIn(server.Anonymous(), $"ada.lovelace@{sso.Domain}", App);
        Assert.Equal(HttpStatusCode.Redirect, again.Response.StatusCode);
        Assert.Null(await UserByEmail($"ada.lovelace@{sso.Domain}"));
    }

    [Fact]
    public async Task An_es256_provider_and_one_by_client_secret_post_sign_in_too()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws, alg: "ES256");
        await SsoKit.Next(sso.Issuer, $"eve@{sso.Domain}", emailVerified: null);
        var run = await SsoKit.SignIn(server.Anonymous(), $"eve@{sso.Domain}");
        Assert.True(run.Response.StatusCode == HttpStatusCode.Redirect, await run.Text());
        // No email_verified at all is not "false": accepted.
        Assert.NotNull(await UserByEmail($"eve@{sso.Domain}"));

        // client_secret_post when discovery offers only that (RFC 6749 2.3.1), and basic encoded part by part.
        var discovery = new SsoDiscovery
        {
            Issuer = "https://id.example", AuthorizationEndpoint = "https://id.example/a", TokenEndpoint = "https://id.example/t", JwksUri = "https://id.example/k",
            TokenAuthMethods = ["client_secret_post"], SigningKeys = [],
        };
        using var post = SsoSignIn.TokenRequest(discovery, "cli:ent", "s+c r%t", "the-code", "https://api/cb", "verifier");
        Assert.Null(post.Headers.Authorization);
        var form = QueryHelpers.ParseQuery(await post.Content!.ReadAsStringAsync());
        Assert.Equal("cli:ent", form["client_id"].ToString());
        Assert.Equal("s+c r%t", form["client_secret"].ToString());
        Assert.Equal("authorization_code", form["grant_type"].ToString());
        Assert.Equal("verifier", form["code_verifier"].ToString());
        var both = new SsoDiscovery
        {
            Issuer = discovery.Issuer, AuthorizationEndpoint = discovery.AuthorizationEndpoint, TokenEndpoint = discovery.TokenEndpoint, JwksUri = discovery.JwksUri,
            TokenAuthMethods = ["client_secret_post", "client_secret_basic"], SigningKeys = [],
        };
        using var basic = SsoSignIn.TokenRequest(both, "cli:ent", "s+c r%t", "c", "https://api/cb", "v");
        Assert.Equal("Basic", basic.Headers.Authorization!.Scheme);
        Assert.Equal("cli%3Aent:s%2Bc+r%25t", System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(basic.Headers.Authorization.Parameter!)));
        Assert.DoesNotContain("client_secret", await basic.Content!.ReadAsStringAsync(), StringComparison.Ordinal);
        using var none = SsoSignIn.TokenRequest(discovery, "public", null, "c", "https://api/cb", "v");
        Assert.Null(none.Headers.Authorization);
        Assert.DoesNotContain("client_secret", await none.Content!.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_existing_account_with_the_address_is_linked_and_an_unconfirmed_one_loses_its_password()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        var pat = await SsoKit.NewAccount(server, $"pat@{sso.Domain}");
        await SsoKit.Next(sso.Issuer, pat.Email.ToUpperInvariant(), sub: "sub-pat");
        var browser = server.Anonymous();
        var run = await SsoKit.SignIn(browser, pat.Email);
        Assert.Equal(HttpStatusCode.Redirect, run.Response.StatusCode);
        Assert.Equal(pat.Id, (await SsoKit.Me(browser)).GetProperty("id").GetGuid());
        Assert.Contains(await Audit(a => a.ActorUserId == pat.Id), a => a.Action == "sso.link" && a.Detail!.Contains("\"unconfirmed\":false", StringComparison.Ordinal));
        // Their password still signs them in (the domain does not require sign-on).
        Assert.Equal(HttpStatusCode.Redirect, (await ServerFixture.SignIn(server.Anonymous(), pat.Email, pat.Password)).StatusCode);

        // Someone signed up with an address of the domain and never confirmed it: the provider's person
        // gets the account, without the password whoever signed up chose.
        var squatter = server.Anonymous();
        var email = $"quinn@{sso.Domain}";
        Assert.Equal(HttpStatusCode.Accepted, (await squatter.PostAsJsonAsync("/api/v1/account/register", new { email, password = "squatter password 1", displayName = "Not Quinn", locale = "en" })).StatusCode);
        await SsoKit.Next(sso.Issuer, email, name: "Quinn");
        var quinn = server.Anonymous();
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(quinn, email)).Response.StatusCode);
        var user = await UserByEmail(email);
        Assert.NotNull(user);
        Assert.True(user.EmailConfirmed);
        Assert.Null(user.PasswordHash);
        Assert.Equal("Quinn", user.DisplayName);
        Assert.NotEqual(HttpStatusCode.Redirect, (await ServerFixture.SignIn(server.Anonymous(), email, "squatter password 1")).StatusCode);
        Assert.Contains(await Audit(a => a.ActorUserId == user.Id), a => a.Action == "sso.link" && a.Detail!.Contains("\"unconfirmed\":true", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Without_join_as_member_the_account_is_made_but_not_a_membership()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws, extra: new { joinAsMember = false });
        await SsoKit.Next(sso.Issuer, $"solo@{sso.Domain}");
        var browser = server.Anonymous();
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(browser, $"solo@{sso.Domain}")).Response.StatusCode);
        Assert.Empty((await browser.GetFromJsonAsync<JsonElement>("/api/v1/workspaces")).EnumerateArray());
        Assert.False((await ws.Client.GetFromJsonAsync<JsonElement>(SsoKit.Route(ws))).GetProperty("provider").GetProperty("joinAsMember").GetBoolean());
    }

    [Theory]
    [InlineData("wrongKey", "could not be checked")]
    [InlineData("algNone", "could not be checked")]
    [InlineData("wrongAudience", "could not be checked")]
    [InlineData("wrongIssuer", "could not be checked")]
    [InlineData("expired", "could not be checked")]
    [InlineData("nonce", "could not be checked")]
    [InlineData("emailUnverified", "has not confirmed your email address")]
    [InlineData("noEmail", "did not give your email address")]
    [InlineData("tokenError", "did not complete")]
    public async Task An_answer_the_checks_refuse_signs_nobody_in(string fault, string words)
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        await SsoKit.Fault(sso.Issuer, fault);
        var email = $"mallory@{sso.Domain}";
        await SsoKit.Next(sso.Issuer, email);
        var browser = server.Anonymous();
        var run = await SsoKit.SignIn(browser, email, App);
        Assert.Equal(HttpStatusCode.OK, run.Response.StatusCode);
        var page = await run.Text();
        Assert.Contains(Failed, page, StringComparison.Ordinal);
        Assert.Contains(words, page, StringComparison.Ordinal);
        // The page says why in words: nothing of the provider's answer is in it.
        var code = QueryHelpers.ParseQuery(run.Callback!.Query)["code"].ToString();
        Assert.DoesNotContain(code, page, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(browser));
        Assert.Null(await UserByEmail(email));
        Assert.Contains(await Audit(a => a.WorkspaceId == ws.Id), a => a.Action == "signin.fail" && a.Detail!.Contains("\"method\":\"sso\"", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_address_outside_the_domains_or_in_one_not_verified_is_refused()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        // Another domain the workspace added, not verified.
        var pending = SsoKit.NewDomain();
        Assert.Equal(HttpStatusCode.Created, (await ws.Client.PostAsJsonAsync(SsoKit.Route(ws, "/domains"), new { domain = pending })).StatusCode);

        // The page has no sign-in for an unknown domain, nor an unverified one: the same words.
        foreach (var address in new[] { $"x@{pending}", $"x@{SsoKit.NewDomain()}", "not an address" })
        {
            var page = await (await SsoKit.SignIn(server.Anonymous(), address)).Text();
            Assert.Contains(NoProvider, page, StringComparison.Ordinal);
        }
        // The provider answers for someone outside the verified domains (the typed address was inside).
        foreach (var address in new[] { $"zed@{pending}", "zed@other.test", $"zed@sub.{sso.Domain}" })
        {
            await SsoKit.Next(sso.Issuer, address);
            var browser = server.Anonymous();
            var run = await SsoKit.SignIn(browser, $"anyone@{sso.Domain}");
            Assert.Contains("an address this workspace does not sign in", await run.Text(), StringComparison.Ordinal);
            Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(browser));
            Assert.Null(await UserByEmail(address));
        }
    }

    [Fact]
    public async Task A_state_used_twice_a_code_used_twice_and_a_callback_without_its_cookie_are_refused()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        var email = $"replay@{sso.Domain}";
        await SsoKit.Next(sso.Issuer, email);
        var run = await SsoKit.SignIn(server.Anonymous(), email);
        Assert.Equal(HttpStatusCode.Redirect, run.Response.StatusCode);
        Assert.NotNull(run.StateCookie);

        // The same callback, with the same state cookie copied: refused, the state was used.
        using var copied = server.Api.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), HandleCookies = false, AllowAutoRedirect = false });
        using var replay = new HttpRequestMessage(HttpMethod.Get, run.Callback!.PathAndQuery);
        replay.Headers.Add("Cookie", run.StateCookie);
        var replayed = await copied.SendAsync(replay);
        Assert.Equal(HttpStatusCode.OK, replayed.StatusCode);
        var page = await replayed.Content.ReadAsStringAsync();
        Assert.Contains(Failed, page, StringComparison.Ordinal);
        Assert.Contains("took longer than 10 minutes", page, StringComparison.Ordinal);
        Assert.False(replayed.Headers.TryGetValues("Set-Cookie", out var given) && given.Any(c => c.StartsWith("cgw_session=", StringComparison.Ordinal)));
        Assert.Contains(await Audit(a => a.WorkspaceId == ws.Id), a => a.Action == "signin.fail" && a.Detail!.Contains("state used before", StringComparison.Ordinal));

        // A callback with no cookie (another browser): refused.
        var other = server.Anonymous();
        Assert.Contains(Failed, await (await other.GetAsync(run.Callback.PathAndQuery)).Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(other));

        // A new sign-in's state with the first one's code: the provider refuses the code's second use.
        var browser = server.Anonymous();
        var page2 = await (await browser.GetAsync("/account/sso")).Content.ReadAsStringAsync();
        var start = await ServerFixture.Submit(browser, page2, "/account/sso", ("Email", email));
        var state = QueryHelpers.ParseQuery(start.Headers.Location!.Query)["state"].ToString();
        var oldCode = QueryHelpers.ParseQuery(run.Callback.Query)["code"].ToString();
        var reused = await browser.GetAsync($"/account/sso/callback?code={Uri.EscapeDataString(oldCode)}&state={Uri.EscapeDataString(state)}&iss={Uri.EscapeDataString(sso.Issuer)}");
        Assert.Contains("did not complete", await reused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(browser));
        Assert.Contains((await SsoKit.Requests(sso.Issuer, "token")).EnumerateArray(), r => r.GetProperty("status").GetInt32() == 400 && r.GetProperty("error").GetString() == "invalid_grant");
    }

    [Fact]
    public async Task The_providers_own_refusal_and_an_answer_naming_another_issuer_are_said_in_words()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        await SsoKit.NextError(sso.Issuer, "access_denied");
        var browser = server.Anonymous();
        var run = await SsoKit.SignIn(browser, $"x@{sso.Domain}");
        Assert.Contains(System.Text.Encodings.Web.HtmlEncoder.Default.Encode("The sign-in was cancelled on your organisation's page."), await run.Text(), StringComparison.Ordinal);
        await SsoKit.NextError(sso.Issuer, "server_error");
        Assert.Contains("did not complete", await (await SsoKit.SignIn(server.Anonymous(), $"x@{sso.Domain}")).Text(), StringComparison.Ordinal);

        // RFC 9207: an answer that says it comes from another issuer (a mix-up) is refused before any exchange.
        await SsoKit.Next(sso.Issuer, $"y@{sso.Domain}");
        var page = await (await browser.GetAsync("/account/sso")).Content.ReadAsStringAsync();
        var start = await ServerFixture.Submit(browser, page, "/account/sso", ("Email", $"y@{sso.Domain}"));
        var answer = (await SsoKit.Mock.GetAsync(start.Headers.Location!)).Headers.Location!;
        var mixed = QueryHelpers.ParseQuery(answer.Query);
        var refused = await browser.GetAsync($"/account/sso/callback?code={Uri.EscapeDataString(mixed["code"].ToString())}&state={Uri.EscapeDataString(mixed["state"].ToString())}&iss={Uri.EscapeDataString(server.NewOidcIssuer())}");
        Assert.Contains(Failed, await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(browser));
        Assert.Empty((await SsoKit.Requests(sso.Issuer, "token")).EnumerateArray());
    }

    [Fact]
    public async Task A_provider_whose_discovery_is_down_is_not_saved_and_cannot_be_signed_in_through()
    {
        var ws = await Ws.Create(server);
        var issuer = server.NewOidcIssuer();
        await SsoKit.Client(issuer, "cgw-down", "a-secret");
        await SsoKit.Fault(issuer, "discoveryDown");
        var put = await SsoKit.SetProvider(ws.Client, ws, new { issuer, clientId = "cgw-down", clientSecret = "a-secret" });
        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        Assert.Equal("sso.discoveryFailed", await Kit.Code(put));
        Assert.Equal(JsonValueKind.Null, (await ws.Client.GetFromJsonAsync<JsonElement>(SsoKit.Route(ws))).GetProperty("provider").ValueKind);
        // Another issuer than the one asked for (OpenID Connect Discovery 4.3), and a page that is not discovery.
        var wrong = await SsoKit.SetProvider(ws.Client, ws, new { issuer = server.OidcMockUrl + "/realms/" + Guid.NewGuid().ToString("N") + "/", clientId = "c", clientSecret = "s" });
        Assert.Equal("sso.discoveryFailed", await Kit.Code(wrong));
        Assert.Contains("not ", (await Kit.Json(wrong)).GetProperty("title").GetString(), StringComparison.Ordinal);
        Assert.Equal("sso.discoveryFailed", await Kit.Code(await SsoKit.SetProvider(ws.Client, ws, new { issuer = "http://127.0.0.1:1", clientId = "c", clientSecret = "s" })));
        // An issuer that is not an address the server may use.
        foreach (var bad in new[] { "not a url", "ftp://id.example", "http://127.0.0.1:4287/?q=1", "https://user:pass@id.example" })
            Assert.Equal("request.invalid", await Kit.Code(await SsoKit.SetProvider(ws.Client, ws, new { issuer = bad, clientId = "c", clientSecret = "s" })));

        // A provider the API holds no document for, and whose discovery is down: no sign-in starts.
        var domain = SsoKit.NewDomain();
        await SsoKit.VerifiedDomain(server, ws, domain);
        await using (var db = server.NewDb(ws.Id))
        {
            var secrets = server.Api.Services.GetRequiredService<SsoSecrets>();
            db.SsoProviders.Add(new SsoProvider
            {
                WorkspaceId = ws.Id, Issuer = issuer, ClientId = "cgw-down", SecretCipher = secrets.Protect(ws.Id, "a-secret"),
                CreatedBy = ws.Account.Id, CreatedAt = DateTimeOffset.UtcNow, UpdatedBy = ws.Account.Id, UpdatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }
        var run = await SsoKit.SignIn(server.Anonymous(), $"x@{domain}");
        Assert.Equal(HttpStatusCode.OK, run.Response.StatusCode);
        Assert.Contains("cannot be reached now", await run.Text(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_domain_is_proven_by_its_txt_record_and_then_belongs_to_one_workspace()
    {
        var ws = await Ws.Create(server);
        var domain = SsoKit.NewDomain();
        var added = await ws.Client.PostAsJsonAsync(SsoKit.Route(ws, "/domains"), new { domain = "  " + domain.ToUpperInvariant() + ". " });
        Assert.Equal(HttpStatusCode.Created, added.StatusCode);
        var dto = await Kit.Json(added);
        Assert.Equal(domain, dto.GetProperty("domain").GetString());
        var record = dto.GetProperty("record");
        Assert.Equal("_cashgear-workspace." + domain, record.GetProperty("name").GetString());
        var value = record.GetProperty("value").GetString()!;
        Assert.StartsWith("cgw-verify=", value, StringComparison.Ordinal);
        Assert.Equal(22, value["cgw-verify=".Length..].Length);
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("verifiedAt").ValueKind);
        Assert.Equal("conflict", await Kit.Code(await ws.Client.PostAsJsonAsync(SsoKit.Route(ws, "/domains"), new { domain })));

        // No record, a wrong one: sso.dnsNotFound. The lookup is the stand-in's, by the record's name.
        var verify = SsoKit.Route(ws, $"/domains/{domain}/verify");
        Assert.Equal("sso.dnsNotFound", await Kit.Code(await ws.Client.PostAsync(verify, null)));
        await SsoKit.Dns(server, "_cashgear-workspace." + domain, "cgw-verify=someone-elses", "v=spf1 -all");
        Assert.Equal("sso.dnsNotFound", await Kit.Code(await ws.Client.PostAsync(verify, null)));
        Assert.Contains((await SsoKit.Requests(server.OidcMockUrl, "dns")).EnumerateArray(), r => r.ToString().Contains("_cashgear-workspace." + domain, StringComparison.OrdinalIgnoreCase));
        await SsoKit.Dns(server, "_cashgear-workspace." + domain, "v=spf1 -all", $"\"{value}\"");
        var verified = await ws.Client.PostAsync(verify, null);
        Assert.Equal(HttpStatusCode.OK, verified.StatusCode);
        Assert.Equal(JsonValueKind.String, (await Kit.Json(verified)).GetProperty("verifiedAt").ValueKind);

        // Another workspace: taken, to add or to verify (it added it before the first verified it).
        var other = await Ws.Create(server);
        var otherDomain = SsoKit.NewDomain();
        Assert.Equal(HttpStatusCode.Created, (await other.Client.PostAsJsonAsync(SsoKit.Route(other, "/domains"), new { domain = otherDomain })).StatusCode);
        var taken = await other.Client.PostAsJsonAsync(SsoKit.Route(other, "/domains"), new { domain });
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
        Assert.Equal("sso.domainTaken", await Kit.Code(taken));
        var third = await Ws.Create(server);
        var early = SsoKit.NewDomain();
        Assert.Equal(HttpStatusCode.Created, (await third.Client.PostAsJsonAsync(SsoKit.Route(third, "/domains"), new { domain = early })).StatusCode);
        await SsoKit.VerifiedDomain(server, ws, early);
        var lateVerify = await third.Client.PostAsync(SsoKit.Route(third, $"/domains/{early}/verify"), null);
        Assert.Equal("sso.domainTaken", await Kit.Code(lateVerify));

        // Removed, it is free: the other workspace proves it with its own record.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync(SsoKit.Route(ws, $"/domains/{early}"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.DeleteAsync(SsoKit.Route(ws, $"/domains/{early}"))).StatusCode);
        var thirdRecord = (await third.Client.GetFromJsonAsync<JsonElement>(SsoKit.Route(third))).GetProperty("domains")[0].GetProperty("record");
        await SsoKit.Dns(server, thirdRecord.GetProperty("name").GetString()!, thirdRecord.GetProperty("value").GetString()!);
        Assert.Equal(HttpStatusCode.OK, (await third.Client.PostAsync(SsoKit.Route(third, $"/domains/{early}/verify"), null)).StatusCode);

        // What is not a domain.
        foreach (var bad in new[] { "*.acme.test", "localhost", "a..test", "1.2.3.4", "-x.test", "x_y.test", "a@b.test", "", new string('a', 64) + ".test", string.Join('.', Enumerable.Repeat("abcdefghi", 26)) + ".test" })
            Assert.Equal("request.invalid", await Kit.Code(await ws.Client.PostAsJsonAsync(SsoKit.Route(ws, "/domains"), new { domain = bad })));
        // An IDN is kept as punycode.
        var idn = (await Kit.Json(await ws.Client.PostAsJsonAsync(SsoKit.Route(ws, "/domains"), new { domain = $"bücher-{Guid.NewGuid():N}.test" }))).GetProperty("domain").GetString()!;
        Assert.StartsWith("xn--bcher-", idn, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.PostAsync(SsoKit.Route(ws, $"/domains/{SsoKit.NewDomain()}/verify"), null)).StatusCode);

        // DNS that cannot answer reads as a record not found, and says so.
        await using var failing = server.Variant(b => b.ConfigureTestServices(s => s.AddSingleton<Cgw.Core.Domains.IDomainDns>(new DownDns())));
        var owner = await SsoKit.NewAccount(server, $"o-{Guid.NewGuid():N}@example.test", failing);
        var fourth = await Ws.Create(server, owner);
        var down = SsoKit.NewDomain();
        await owner.Client.PostAsJsonAsync(SsoKit.Route(fourth, "/domains"), new { domain = down });
        var unanswered = await owner.Client.PostAsync(SsoKit.Route(fourth, $"/domains/{down}/verify"), null);
        Assert.Equal("sso.dnsNotFound", await Kit.Code(unanswered));
        Assert.Contains("could not be read", (await Kit.Json(unanswered)).GetProperty("title").GetString(), StringComparison.Ordinal);

        // Audited.
        var audit = await Audit(a => a.WorkspaceId == ws.Id);
        Assert.Contains(audit, a => a.Action == "sso.domain.add");
        Assert.Contains(audit, a => a.Action == "sso.domain.verify");
        Assert.Contains(audit, a => a.Action == "sso.domain.remove");
    }

    private sealed class DownDns : Cgw.Core.Domains.IDomainDns
    {
        public Task<IReadOnlyList<string>> TxtAsync(string name, CancellationToken ct) => throw new Cgw.Core.Domains.DomainDnsException("DNS did not answer");

        public Task<IReadOnlyList<System.Net.IPAddress>> AddressesAsync(string name, CancellationToken ct) => throw new Cgw.Core.Domains.DomainDnsException("DNS did not answer");
    }

    [Fact]
    public async Task Only_owners_read_or_change_single_sign_on()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        var people = new Dictionary<string, Account>();
        foreach (var role in new[] { "admin", "member", "guest" }) people[role] = await Kit.Join(server, ws, role);
        var other = SsoKit.NewDomain();
        foreach (var (role, account) in people)
        {
            var client = account.Client;
            var answers = new[]
            {
                await client.GetAsync(SsoKit.Route(ws)),
                await client.PostAsJsonAsync(SsoKit.Route(ws, "/domains"), new { domain = other }),
                await client.PostAsync(SsoKit.Route(ws, $"/domains/{sso.Domain}/verify"), null),
                await client.PatchAsJsonAsync(SsoKit.Route(ws, $"/domains/{sso.Domain}"), new { required = false }),
                await client.DeleteAsync(SsoKit.Route(ws, $"/domains/{sso.Domain}")),
                await SsoKit.SetProvider(client, ws, new { issuer = sso.Issuer, clientId = sso.ClientId }),
                await client.DeleteAsync(SsoKit.Route(ws, "/provider")),
            };
            foreach (var answer in answers)
            {
                Assert.True(answer.StatusCode == HttpStatusCode.Forbidden, $"{role} {answer.RequestMessage!.Method} {answer.RequestMessage.RequestUri}: {(int)answer.StatusCode}");
                Assert.Equal("access.denied", await Kit.Code(answer));
            }
        }
        // Nothing changed.
        var settings = await ws.Client.GetFromJsonAsync<JsonElement>(SsoKit.Route(ws));
        Assert.Single(settings.GetProperty("domains").EnumerateArray());
        Assert.Equal(sso.ClientId, settings.GetProperty("provider").GetProperty("clientId").GetString());
        Assert.Equal(SsoKit.Callback, settings.GetProperty("redirectUri").GetString());
    }

    [Fact]
    public async Task The_secret_is_in_no_answer_log_or_audit_and_is_kept_or_removed_as_asked()
    {
        var recorder = new Recorder();
        await using var api = server.Variant(b => b.ConfigureLogging(l => l.AddProvider(recorder).SetMinimumLevel(LogLevel.Trace)));
        var owner = await SsoKit.NewAccount(server, $"o-{Guid.NewGuid():N}@example.test", api);
        var ws = await Ws.Create(server, owner);
        var issuer = server.NewOidcIssuer();
        var secret = "Zz9-" + Guid.NewGuid().ToString("N") + "+%secret";
        await SsoKit.Client(issuer, "cgw-quiet", secret);
        var set = await SsoKit.SetProvider(owner.Client, ws, new { issuer, clientId = "cgw-quiet", clientSecret = secret, sessionHours = 8 });
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        var answers = new List<string> { await set.Content.ReadAsStringAsync() };
        var provider = (await Kit.Json(set));
        Assert.True(provider.GetProperty("hasSecret").GetBoolean());
        Assert.Equal(8, provider.GetProperty("sessionHours").GetInt32());
        Assert.Equal(JsonValueKind.Null, provider.GetProperty("testedAt").ValueKind);
        Assert.Equal("\"1\"", set.Headers.ETag!.Tag);
        var domain = SsoKit.NewDomain();
        await SsoKit.VerifiedDomain(server, ws, domain);
        await SsoKit.Next(issuer, $"quiet@{domain}");
        var browser = ServerFixture.ClientOf(api);
        var run = await SsoKit.SignIn(browser, $"quiet@{domain}");
        Assert.Equal(HttpStatusCode.Redirect, run.Response.StatusCode);
        answers.Add(await (await owner.Client.GetAsync(SsoKit.Route(ws))).Content.ReadAsStringAsync());

        // Kept when absent, with If-Match; a stale If-Match is a conflict.
        var stale = new HttpRequestMessage(HttpMethod.Put, SsoKit.Route(ws, "/provider")) { Content = JsonContent.Create(new { issuer, clientId = "cgw-quiet" }) };
        stale.Headers.TryAddWithoutValidation("If-Match", "\"7\"");
        var conflict = await owner.Client.SendAsync(stale);
        Assert.Equal("version.conflict", await Kit.Code(conflict));
        var kept = new HttpRequestMessage(HttpMethod.Put, SsoKit.Route(ws, "/provider")) { Content = JsonContent.Create(new { issuer, clientId = "cgw-quiet" }) };
        kept.Headers.TryAddWithoutValidation("If-Match", "\"1\"");
        var keptAnswer = await owner.Client.SendAsync(kept);
        Assert.Equal(HttpStatusCode.OK, keptAnswer.StatusCode);
        Assert.True((await Kit.Json(keptAnswer)).GetProperty("hasSecret").GetBoolean());
        answers.Add(await keptAnswer.Content.ReadAsStringAsync());
        // A bad secret, and none for a provider that authenticates its clients.
        Assert.Equal("request.invalid", await Kit.Code(await SsoKit.SetProvider(owner.Client, ws, new { issuer, clientId = "cgw-quiet", clientSecret = "has a space" })));
        Assert.Equal("request.invalid", await Kit.Code(await SsoKit.SetProvider(owner.Client, ws, new { issuer, clientId = "cgw-quiet", clientSecret = (string?)null })));
        Assert.Equal("request.invalid", await Kit.Code(await SsoKit.SetProvider(owner.Client, ws, new { issuer, clientId = "cgw-quiet", sessionHours = 721 })));

        foreach (var answer in answers) Assert.DoesNotContain(secret, answer, StringComparison.Ordinal);
        Assert.DoesNotContain(recorder.Lines, line => line.Contains(secret, StringComparison.Ordinal) || line.Contains(Uri.EscapeDataString(secret), StringComparison.Ordinal));
        Assert.NotEmpty(recorder.Lines);
        var audit = await Audit(a => a.WorkspaceId == ws.Id || a.ActorUserId == owner.Id);
        Assert.Contains(audit, a => a.Action == "sso.provider.set" && a.Detail!.Contains("\"secret\":\"set\"", StringComparison.Ordinal));
        Assert.Contains(audit, a => a.Action == "sso.provider.set" && a.Detail!.Contains("\"secret\":\"kept\"", StringComparison.Ordinal));
        Assert.DoesNotContain(audit, a => (a.Detail ?? "").Contains(secret, StringComparison.Ordinal));
        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.SsoProviders.AsNoTracking().FirstAsync();
            Assert.DoesNotContain(secret, row.SecretCipher!, StringComparison.Ordinal);
            Assert.Equal(secret, server.Api.Services.GetRequiredService<SsoSecrets>().Unprotect(ws.Id, row.SecretCipher!));
            // Bound to the workspace: another workspace's purpose does not open it.
            Assert.Null(server.Api.Services.GetRequiredService<SsoSecrets>().Unprotect(Guid.NewGuid(), row.SecretCipher!));
        }
        // The secret went to the token endpoint only, as its hash in the mock's record.
        foreach (var endpoint in new[] { "authorize", "token", "jwks", "discovery" })
            foreach (var request in (await SsoKit.Requests(issuer, endpoint)).EnumerateArray())
                Assert.DoesNotContain(secret, request.ToString(), StringComparison.Ordinal);
    }

    /// <summary>Every log line of an API variant, at every level.</summary>
    private sealed class Recorder : ILoggerProvider
    {
        public ConcurrentQueue<string> Lines { get; } = new();
        public ILogger CreateLogger(string categoryName) => new Line(this, categoryName);
        public void Dispose() { }

        private sealed class Line(Recorder recorder, string category) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(LogLevel logLevel) => true;
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
                recorder.Lines.Enqueue($"{category}: {formatter(state, exception)} {exception}");
        }
    }

    [Fact]
    public async Task Required_sign_on_needs_an_owners_test_ends_other_sessions_refuses_other_ways_in_and_keeps_owners()
    {
        var domain = SsoKit.NewDomain();
        var boss = await SsoKit.NewAccount(server, $"boss@{domain}");
        var ws = await Ws.Create(server, boss);
        var sso = await SsoKit.SetUp(server, ws, domain: domain);
        var pat = await Kit.Join(server, ws, "member", await SsoKit.NewAccount(server, $"pat@{domain}"));
        var stranger = await SsoKit.NewAccount(server, $"stranger@{domain}");
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(pat.Client, authenticator);
        // Pat also signs in through the provider (a second session, which stays).
        await SsoKit.Next(sso.Issuer, pat.Email);
        var patSso = server.Anonymous();
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(patSso, pat.Email)).Response.StatusCode);

        // Not before an owner has signed in through the provider.
        var patch = SsoKit.Route(ws, $"/domains/{domain}");
        var early = await boss.Client.PatchAsJsonAsync(patch, new { required = true });
        Assert.Equal(HttpStatusCode.BadRequest, early.StatusCode);
        Assert.Equal("sso.notTested", await Kit.Code(early));
        // A member's sign-in through it does not count; the owner's does.
        Assert.Equal(JsonValueKind.Null, (await boss.Client.GetFromJsonAsync<JsonElement>(SsoKit.Route(ws))).GetProperty("provider").GetProperty("testedAt").ValueKind);
        await SsoKit.Next(sso.Issuer, boss.Email);
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(server.Anonymous(), boss.Email)).Response.StatusCode);
        Assert.Equal(JsonValueKind.String, (await boss.Client.GetFromJsonAsync<JsonElement>(SsoKit.Route(ws))).GetProperty("provider").GetProperty("testedAt").ValueKind);
        Assert.Contains(await Audit(a => a.WorkspaceId == ws.Id), a => a.Action == "sso.provider.tested");

        var on = await boss.Client.PatchAsJsonAsync(patch, new { required = true });
        Assert.True(on.StatusCode == HttpStatusCode.OK, await on.Content.ReadAsStringAsync());
        Assert.True((await Kit.Json(on)).GetProperty("required").GetBoolean());
        // Sessions of the domain not made through the provider end, but the owner's.
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(pat.Client));
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(stranger.Client));
        Assert.Equal(HttpStatusCode.OK, await MeStatus(patSso));
        Assert.Equal(HttpStatusCode.OK, await MeStatus(boss.Client));
        var require = Assert.Single(await Audit(a => a.WorkspaceId == ws.Id && a.Action == "sso.domain.require"));
        Assert.Contains("\"sessionsEnded\":2", require.Detail!, StringComparison.Ordinal);
        Assert.Contains(await Audit(a => a.Action == "device.revoke" && a.ActorUserId == boss.Id), a => a.TargetId is not null);
        var patMe = await SsoKit.Me(patSso);
        Assert.True(patMe.GetProperty("ssoRequired").GetBoolean());
        Assert.True(patMe.GetProperty("hasPassword").GetBoolean());
        Assert.False((await SsoKit.Me(boss.Client)).GetProperty("ssoRequired").GetBoolean());

        // A password sign-in of the domain: refused, the page offering the organisation's sign-in.
        foreach (var (email, password) in new[] { (pat.Email, pat.Password), ($"nobody@{domain}", "any password at all") })
        {
            var browser = server.Anonymous();
            var refused = await ServerFixture.SignIn(browser, email, password);
            Assert.Equal(HttpStatusCode.OK, refused.StatusCode);
            var page = await refused.Content.ReadAsStringAsync();
            Assert.Contains(Required, page, StringComparison.Ordinal);
            Assert.Contains("""<form method="post" action="/account/sso">""", page, StringComparison.Ordinal);
            // The page has no password field, and its form may go on to the provider.
            Assert.DoesNotContain("type=\"password\"", page, StringComparison.Ordinal);
            Assert.Contains(" https:", refused.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
            Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(browser));
        }
        Assert.Contains(await Audit(a => a.ActorUserId == pat.Id && a.Action == "signin.fail"), a => a.Detail!.Contains("sso.required", StringComparison.Ordinal));
        // A passkey sign-in: refused.
        var byPasskey = server.Anonymous();
        var passkeyAnswer = await PasskeyFlow.SignIn(byPasskey, authenticator);
        Assert.Contains(Required, await passkeyAnswer.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(byPasskey));
        // A reset mail: the same answer as for any address, and nothing sent.
        Assert.Equal(HttpStatusCode.Accepted, (await server.Anonymous().PostAsJsonAsync("/api/v1/account/password/forgot", new { email = pat.Email })).StatusCode);
        Assert.Equal(0, await server.CountMailTo(pat.Email, "/account/reset"));
        // A sign-up: refused, on the page and through the route.
        var signUp = await server.Anonymous().PostAsJsonAsync("/api/v1/account/register", new { email = $"newcomer@{domain}", password = "a long enough password", displayName = "New", locale = "en" });
        Assert.Equal(HttpStatusCode.Forbidden, signUp.StatusCode);
        Assert.Equal("sso.required", await Kit.Code(signUp));
        var signUpPage = await ServerFixture.OpenAndSubmit(server.Anonymous(), "/account/signup", "/account/signup", ("Email", $"newcomer2@{domain}"), ("DisplayName", "New"), ("Password", "a long enough password"));
        Assert.Contains(Required, await signUpPage.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Null(await UserByEmail($"newcomer2@{domain}"));

        // The owner keeps their password, their reset mail and their passkeys.
        Assert.Equal(HttpStatusCode.Redirect, (await ServerFixture.SignIn(server.Anonymous(), boss.Email, boss.Password)).StatusCode);
        var before = server.MailFiles();
        await server.Anonymous().PostAsJsonAsync("/api/v1/account/password/forgot", new { email = boss.Email });
        Assert.Contains("/account/reset", await server.NewMailTo(boss.Email, "/account/reset", before), StringComparison.Ordinal);
        // Someone of the domain signs in through the provider, as before.
        await SsoKit.Next(sso.Issuer, $"newcomer@{domain}");
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(server.Anonymous(), $"newcomer@{domain}")).Response.StatusCode);

        // Removing the provider turns required off: passwords work again.
        Assert.Equal(HttpStatusCode.NoContent, (await boss.Client.DeleteAsync(SsoKit.Route(ws, "/provider"))).StatusCode);
        var settings = await boss.Client.GetFromJsonAsync<JsonElement>(SsoKit.Route(ws));
        Assert.Equal(JsonValueKind.Null, settings.GetProperty("provider").ValueKind);
        Assert.False(settings.GetProperty("domains")[0].GetProperty("required").GetBoolean());
        Assert.Equal(HttpStatusCode.Redirect, (await ServerFixture.SignIn(server.Anonymous(), pat.Email, pat.Password)).StatusCode);
        Assert.Contains(await Audit(a => a.WorkspaceId == ws.Id), a => a.Action == "sso.provider.remove" && a.Detail!.Contains(domain, StringComparison.Ordinal));
        // With no provider, required cannot be turned on again.
        Assert.Equal("sso.notTested", await Kit.Code(await boss.Client.PatchAsJsonAsync(patch, new { required = true })));
        // And the domain's page has no sign-in through it now.
        Assert.Contains(NoProvider, await (await SsoKit.SignIn(server.Anonymous(), pat.Email)).Text(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_session_through_the_provider_ends_after_its_hours_whatever_it_does()
    {
        // An API whose clock the test moves (a cookie is good only on the API that made the client).
        var clock = new MovableClock();
        await using var api = server.Variant(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var owner = await SsoKit.NewAccount(server, $"o-{Guid.NewGuid():N}@example.test", api);
        var ws = await Ws.Create(server, owner);
        var sso = await SsoKit.SetUp(server, ws, extra: new { sessionHours = 2 });
        await SsoKit.Next(sso.Issuer, $"brief@{sso.Domain}");
        var browser = ServerFixture.ClientOf(api);
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(browser, $"brief@{sso.Domain}")).Response.StatusCode);
        var me = await SsoKit.Me(browser);
        await using (var db = server.NewDb())
        {
            var device = await db.Devices.AsNoTracking().FirstAsync(d => d.Id == me.GetProperty("deviceId").GetGuid());
            Assert.InRange(device.EndsAt!.Value - clock.GetUtcNow(), TimeSpan.FromMinutes(119), TimeSpan.FromMinutes(121));
        }
        // Used all the while (the cookie slides), it still ends two hours after the sign-in.
        clock.Advance(TimeSpan.FromMinutes(70));
        Assert.Equal(HttpStatusCode.OK, await MeStatus(browser));
        clock.Advance(TimeSpan.FromMinutes(45));
        Assert.Equal(HttpStatusCode.OK, await MeStatus(browser));
        clock.Advance(TimeSpan.FromMinutes(6));
        Assert.Equal(HttpStatusCode.Unauthorized, await MeStatus(browser));
        // Signed out as a revoked session is: no longer in the account's devices.
        await SsoKit.Next(sso.Issuer, $"brief@{sso.Domain}");
        var again = ServerFixture.ClientOf(api);
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(again, $"brief@{sso.Domain}")).Response.StatusCode);
        var devices = await again.GetFromJsonAsync<JsonElement>("/api/v1/account/devices");
        Assert.DoesNotContain(devices.EnumerateArray(), d => d.GetProperty("id").GetGuid() == me.GetProperty("deviceId").GetGuid());
        Assert.Single(devices.EnumerateArray());
        // The owner's password session has no such end.
        Assert.Equal(HttpStatusCode.OK, await MeStatus(owner.Client));
    }

    [Fact]
    public async Task The_desktop_signs_in_through_the_provider_and_its_tokens_end_with_that_sign_in()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws, extra: new { sessionHours = 6 });
        var email = $"desk@{sso.Domain}";

        // The system browser, signed out: /connect/authorize sends it to sign in, which offers the organisation's.
        var browser = server.Anonymous();
        var (verifier, challenge) = AccountTests.Pkce();
        var authorize = await browser.GetAsync(AccountTests.AuthorizeUrl(challenge, 50124, "desk"));
        Assert.Equal(HttpStatusCode.Redirect, authorize.StatusCode);
        var signInUrl = authorize.Headers.Location!.ToString();
        var back = QueryHelpers.ParseQuery(new Uri("https://localhost" + signInUrl).Query)["returnUrl"].ToString();
        var signInPage = await (await browser.GetAsync(signInUrl)).Content.ReadAsStringAsync();
        Assert.Contains($"/account/sso?lang=en&returnUrl={Uri.EscapeDataString(back)}", signInPage, StringComparison.Ordinal);

        await SsoKit.Next(sso.Issuer, email);
        var run = await SsoKit.SignIn(browser, email, back);
        Assert.Equal(HttpStatusCode.Redirect, run.Response.StatusCode);
        Assert.Equal(back, run.Response.Headers.Location!.ToString());
        var question = await browser.GetAsync(back);
        Assert.Equal(HttpStatusCode.OK, question.StatusCode);
        var accepted = await ServerFixture.Submit(browser, await question.Content.ReadAsStringAsync(), "/connect/authorize", ("cgw_consent", "accept"));
        Assert.Equal(HttpStatusCode.Redirect, accepted.StatusCode);
        var code = QueryHelpers.ParseQuery(accepted.Headers.Location!.Query)["code"].ToString();
        var token = await server.Anonymous().PostAsync("/connect/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = "cgw-desktop",
            ["code"] = code,
            ["redirect_uri"] = "http://127.0.0.1:50124/callback",
            ["code_verifier"] = verifier,
        }));
        var body = await Kit.Json(token);
        Assert.True(token.IsSuccessStatusCode, body.ToString());
        Assert.InRange(body.GetProperty("expires_in").GetInt32(), 1, 900);
        var desktop = server.Anonymous();
        desktop.DefaultRequestHeaders.Authorization = new("Bearer", body.GetProperty("access_token").GetString());
        var me = await SsoKit.Me(desktop);
        Assert.Equal(email, me.GetProperty("email").GetString());
        Assert.Contains(await Audit(a => a.ActorUserId == me.GetProperty("id").GetGuid() && a.Action == "account.signin"),
            a => a.Detail!.Contains("\"platform\":\"desktop\"", StringComparison.Ordinal) && a.Detail.Contains("\"method\":\"sso\"", StringComparison.Ordinal));

        // The desktop's device ends with the browser's sign-in, and so does its refresh token.
        await using (var db = server.NewDb())
        {
            var device = await db.Devices.AsNoTracking().FirstAsync(d => d.Id == me.GetProperty("deviceId").GetGuid());
            Assert.Equal("desktop", device.Platform);
            Assert.Equal(ws.Id, device.SsoWorkspaceId);
            Assert.InRange(device.EndsAt!.Value - DateTimeOffset.UtcNow, TimeSpan.FromHours(5.9), TimeSpan.FromHours(6.1));
            var refreshes = await db.Set<OpenIddictEntityFrameworkCoreToken<Guid>>().AsNoTracking()
                .Where(t => t.Subject == me.GetProperty("id").GetString() && t.Type!.EndsWith("refresh_token")).ToListAsync();
            var refresh = Assert.Single(refreshes);
            Assert.InRange(new DateTimeOffset(refresh.ExpirationDate!.Value, TimeSpan.Zero) - device.EndsAt.Value, TimeSpan.FromMinutes(-1), TimeSpan.FromMinutes(1));
        }
        var refreshToken = body.GetProperty("refresh_token").GetString()!;
        // Before the end it refreshes; after it, the token endpoint refuses.
        await using (var later = server.Variant(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(new ShiftedClock(TimeSpan.FromHours(7))))))
        {
            var refused = await AccountTests.Refresh(ServerFixture.ClientOf(later), refreshToken);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("invalid_grant", (await Kit.Json(refused)).GetProperty("error").GetString());
        }
        var refreshed = await AccountTests.Refresh(server.Anonymous(), refreshToken);
        Assert.True(refreshed.IsSuccessStatusCode, await refreshed.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task An_account_with_no_password_deletes_itself_after_a_fresh_sign_in_through_the_provider_and_may_set_a_password_by_the_reset_mail()
    {
        var clock = new MovableClock();
        await using var api = server.Variant(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var owner = await SsoKit.NewAccount(server, $"o-{Guid.NewGuid():N}@example.test", api);
        var ws = await Ws.Create(server, owner);
        var sso = await SsoKit.SetUp(server, ws);

        // A password set by the reset mail (the domain does not require sign-on).
        var email = $"setter@{sso.Domain}";
        await SsoKit.Next(sso.Issuer, email);
        var setter = ServerFixture.ClientOf(api);
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(setter, email)).Response.StatusCode);
        Assert.False((await SsoKit.Me(setter)).GetProperty("hasPassword").GetBoolean());
        var before = server.MailFiles();
        Assert.Equal(HttpStatusCode.Accepted, (await ServerFixture.ClientOf(api).PostAsJsonAsync("/api/v1/account/password/forgot", new { email })).StatusCode);
        var link = ServerFixture.Link(await server.NewMailTo(email, "/account/reset", before), "/account/reset");
        var reset = await ServerFixture.OpenAndSubmit(ServerFixture.ClientOf(api), link, "/account/reset", ("Password", "a brand new password"));
        Assert.Contains("Your password is changed", await reset.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        var withPassword = ServerFixture.ClientOf(api);
        Assert.Equal(HttpStatusCode.Redirect, (await ServerFixture.SignIn(withPassword, email, "a brand new password")).StatusCode);
        Assert.True((await SsoKit.Me(withPassword)).GetProperty("hasPassword").GetBoolean());

        // Deleting with neither a password nor a passkey: a sign-in through the provider of the last
        // ten minutes is the proof; later, the page asks for one again.
        var gone = $"leaver@{sso.Domain}";
        await SsoKit.Next(sso.Issuer, gone);
        var leaver = ServerFixture.ClientOf(api);
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(leaver, gone)).Response.StatusCode);
        var leaverId = (await SsoKit.Me(leaver)).GetProperty("id").GetGuid();
        clock.Advance(TimeSpan.FromMinutes(11));
        var late = await (await leaver.GetAsync("/account/delete?lang=en")).Content.ReadAsStringAsync();
        Assert.Contains("To delete your account, sign in again first.", late, StringComparison.Ordinal);
        Assert.DoesNotContain("""<form method="post" action="/account/delete">""", late, StringComparison.Ordinal);
        // Signing in again goes through the sign-in page, which offers the organisation's sign-in, and back.
        var signInAgain = System.Text.RegularExpressions.Regex.Match(late, "href=\"(/account/signin[^\"]+)\"").Groups[1].Value;
        var back = QueryHelpers.ParseQuery(new Uri("https://localhost" + System.Net.WebUtility.HtmlDecode(signInAgain)).Query)["returnUrl"].ToString();
        Assert.StartsWith("/account/delete", back, StringComparison.Ordinal);
        await SsoKit.Next(sso.Issuer, gone);
        var fresh = await SsoKit.SignIn(leaver, gone, back);
        Assert.Equal(HttpStatusCode.Redirect, fresh.Response.StatusCode);
        Assert.Equal(back, fresh.Response.Headers.Location!.ToString());
        var html = await (await leaver.GetAsync(back)).Content.ReadAsStringAsync();
        Assert.Contains("Delete my account", html, StringComparison.Ordinal);
        var deleted = await ServerFixture.Submit(leaver, html, "/account/delete");
        Assert.Contains("Your account is deleted", await deleted.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        await using (var db = server.NewDb())
        {
            Assert.NotNull((await db.Users.AsNoTracking().FirstAsync(u => u.Id == leaverId)).DeletedAt);
            Assert.Empty(await db.UserLogins.AsNoTracking().Where(l => l.UserId == leaverId).ToListAsync());
        }
        // The provider's person again: a new account (the old one is gone, its login with it).
        await SsoKit.Next(sso.Issuer, gone);
        var again = ServerFixture.ClientOf(api);
        Assert.Equal(HttpStatusCode.Redirect, (await SsoKit.SignIn(again, gone)).Response.StatusCode);
        Assert.NotEqual(leaverId, (await SsoKit.Me(again)).GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task The_pages_offer_the_organisations_sign_in_in_english_and_arabic()
    {
        var signIn = await server.Anonymous().GetAsync("/account/signin?lang=en&returnUrl=%2Fconnect%2Fauthorize%3Fx%3D1");
        var html = await signIn.Content.ReadAsStringAsync();
        Assert.Contains("""<a href="/account/sso?lang=en&returnUrl=%2Fconnect%2Fauthorize%3Fx%3D1">Sign in with your organisation&#x27;s account</a>""", html, StringComparison.Ordinal);
        // The sign-in page's forms go nowhere new.
        Assert.DoesNotContain("https:;", signIn.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
        Assert.DoesNotContain(" https: ", signIn.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);

        var page = await server.Anonymous().GetAsync("/account/sso?lang=ar");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var arabic = await page.Content.ReadAsStringAsync();
        Assert.Contains("""<html lang="ar" dir="rtl">""", arabic, StringComparison.Ordinal);
        Assert.Contains(System.Text.Encodings.Web.HtmlEncoder.Default.Encode("تسجيل الدخول بحساب مؤسستك"), arabic, StringComparison.Ordinal);
        Assert.Contains("""autocomplete="username" required value="" dir="ltr">""", arabic, StringComparison.Ordinal);
        var csp = page.Headers.GetValues("Content-Security-Policy").Single();
        // Its form goes on to whichever provider the address names, and it runs no script.
        Assert.Contains(" https:", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("script-src", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("<script", arabic, StringComparison.Ordinal);
        Assert.Contains(NoProvider, await (await SsoKit.SignIn(server.Anonymous(), $"x@{SsoKit.NewDomain()}")).Text(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_deleted_workspace_lets_go_of_its_domains_and_its_purge_takes_its_sign_on()
    {
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}")).StatusCode);
        // At once: no sign-in through it, and another workspace may prove the domain.
        Assert.Contains(NoProvider, await (await SsoKit.SignIn(server.Anonymous(), $"x@{sso.Domain}")).Text(), StringComparison.Ordinal);
        var other = await Ws.Create(server);
        await SsoKit.VerifiedDomain(server, other, sso.Domain);
        await using (var db = server.NewDb())
            Assert.Equal(1, await db.SsoDomains.IgnoreQueryFilters().CountAsync(d => d.Domain == sso.Domain && d.VerifiedAt != null));

        // The purge takes the rows (30 days on).
        await using (var db = server.NewDb())
            await db.Workspaces.Where(w => w.Id == ws.Id).ExecuteUpdateAsync(s => s.SetProperty(w => w.DeletedAt, DateTimeOffset.UtcNow.AddDays(-31)));
        await server.RunJob<Cgw.Worker.Jobs.WorkspacePurgeJob>();
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.False(await db.Workspaces.AnyAsync(w => w.Id == ws.Id));
            Assert.Equal(0, await db.SsoDomains.CountAsync());
            Assert.Equal(0, await db.SsoProviders.CountAsync());
        }
    }

    [Fact]
    public void Domains_addresses_and_records_are_read_as_kept()
    {
        Assert.Equal("acme.test", SsoText.Domain(" ACME.test. "));
        Assert.Equal("xn--bcher-kva.test", SsoText.Domain("bücher.test"));
        Assert.Null(SsoText.Domain("*.acme.test"));
        Assert.Null(SsoText.Domain("acme"));
        Assert.Null(SsoText.Domain("10.0.0.1"));
        Assert.Equal("acme.test", SsoText.EmailDomain("Someone@Acme.Test"));
        Assert.Null(SsoText.EmailDomain("@acme.test"));
        Assert.Null(SsoText.EmailDomain("someone@"));
        Assert.Equal("ada@xn--bcher-kva.test", SsoText.Email(" ada@Bücher.test "));
        Assert.True(SsoText.HasRecord(["v=spf1", " \"cgw-verify=abc\" "], "abc"));
        Assert.False(SsoText.HasRecord(["cgw-verify=abcd", "cgw-verify=ab"], "abc"));
        Assert.Equal("sso:" + Guid.Empty.ToString("D"), SsoText.LoginProvider(Guid.Empty));
        // Discovery: the issuer exactly, https in Production, the code flow's endpoints.
        var good = """{"issuer":"https://id.example","authorization_endpoint":"https://id.example/a","token_endpoint":"https://id.example/t","jwks_uri":"https://keys.example/k","authorization_response_iss_parameter_supported":true}""";
        var read = SsoDiscoveryRetriever.Read(good, "https://id.example", allowHttp: false);
        Assert.Equal(["client_secret_basic"], read.TokenAuthMethods);
        Assert.True(read.IssParameterSupported);
        Assert.Throws<SsoDiscoveryException>(() => SsoDiscoveryRetriever.Read(good, "https://id.example/", allowHttp: false));
        Assert.Throws<SsoDiscoveryException>(() => SsoDiscoveryRetriever.Read(good.Replace("https://id.example/t", "http://id.example/t", StringComparison.Ordinal), "https://id.example", allowHttp: false));
        Assert.Throws<SsoDiscoveryException>(() => SsoDiscoveryRetriever.Read(good.Replace("\"jwks_uri\":\"https://keys.example/k\",", "", StringComparison.Ordinal), "https://id.example", allowHttp: false));
        Assert.Throws<SsoDiscoveryException>(() => SsoDiscoveryRetriever.Read(good.Replace("{", """{"code_challenge_methods_supported":["plain"],""", StringComparison.Ordinal), "https://id.example", allowHttp: false));
        Assert.Throws<SsoDiscoveryException>(() => SsoDiscoveryRetriever.Read(good.Replace("{", """{"token_endpoint_auth_methods_supported":["private_key_jwt"],""", StringComparison.Ordinal), "https://id.example", allowHttp: false));
        Assert.Throws<SsoDiscoveryException>(() => SsoDiscoveryRetriever.Read("[]", "https://id.example", allowHttp: false));
        Assert.False(SsoUrls.Issuer("http://id.example", allowHttp: false));
        Assert.True(SsoUrls.Issuer("http://127.0.0.1:4287/realms/x", allowHttp: true));
        Assert.Equal("https://id.example/.well-known/openid-configuration", SsoUrls.Discovery("https://id.example/"));
        Assert.DoesNotContain("HS256", SsoSignIn.Algorithms);
        Assert.DoesNotContain("none", SsoSignIn.Algorithms);
    }
}
