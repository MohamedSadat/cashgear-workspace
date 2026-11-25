using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Billing;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Cgw.Tests;

/// <summary>
/// The mock Paddle (<c>tests/mocks/paddle</c>) for one test class: its own port, reset by each test.
/// Its webhooks wait in its outbox, which a test delivers to the API in process (no port reaches it).
/// </summary>
public sealed class PaddleMock : IAsyncLifetime
{
    public const string Key = "mock_paddle_api_key_for_tests_only_0001";
    public const string Secret = "mock_paddle_webhook_secret_for_tests_0001";
    public const string Starter = "pri_01mockstarter";
    public const string Team = "pri_01mockteam";

    private Process? process;
    public int Port { get; } = Free();
    public string Url => $"http://127.0.0.1:{Port}";
    public HttpClient Http { get; } = new();

    private static int Free()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    public async ValueTask InitializeAsync()
    {
        var root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "pnpm-workspace.yaml"))) root = Path.GetDirectoryName(root)!;
        process = Process.Start(new ProcessStartInfo("node", [Path.Combine(root, "tests", "mocks", "paddle", "server.mjs"), "--port", Port.ToString(), "--host", "127.0.0.1"])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        }) ?? throw new InvalidOperationException("The mock Paddle did not start.");
        for (var i = 0; i < 100; i++)
        {
            try
            {
                if ((await Http.GetAsync(Url + "/__mock/state")).IsSuccessStatusCode) return;
            }
            catch (HttpRequestException)
            {
            }
            await Task.Delay(100);
        }
        throw new InvalidOperationException("The mock Paddle did not answer.");
    }

    public ValueTask DisposeAsync()
    {
        if (process is { HasExited: false }) process.Kill(entireProcessTree: true);
        process?.Dispose();
        Http.Dispose();
        return ValueTask.CompletedTask;
    }

    public async Task<JsonElement> Control(string name, object? body = null)
    {
        var response = await Http.PostAsync($"{Url}/__mock/{name}", JsonContent.Create(body ?? new { }));
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    public async Task<JsonElement> Get(string name) =>
        JsonDocument.Parse(await Http.GetStringAsync($"{Url}/__mock/{name}")).RootElement.Clone();

    /// <summary>The webhooks waiting, each body with the signature Paddle would send now.</summary>
    public async Task<List<(string EventId, string Type, string Body, string Signature)>> Outbox() =>
        (await Get("outbox")).GetProperty("events").EnumerateArray()
            .Select(e => (e.GetProperty("eventId").GetString()!, e.GetProperty("type").GetString()!, e.GetProperty("body").GetString()!, e.GetProperty("signature").GetString()!))
            .ToList();
}

/// <summary>
/// Phase 18, M18.2: Cash Gear's AI subscription paid through Paddle. An owner's checkout is a
/// transaction carrying the workspace's id; Paddle's webhooks are taken only with its signature, read
/// the subscription from Paddle's API and apply it once; the plan gives its allowance (a workspace's
/// own override still wins); a cancel lasts the period paid, a failed payment ends the plan when
/// Paddle stops retrying; the daily reconcile finds what a lost webhook missed. No card, address or
/// amount is ever stored.
/// </summary>
public sealed class BillingTests(ServerFixture server, PaddleMock paddle) : IClassFixture<PaddleMock>
{
    private const long StarterTokens = 100_000;
    private const long TeamTokens = 1_000_000;

    private WebApplicationFactory<Program> Billing(Action<IWebHostBuilder>? more = null)
    {
        var api = server.Variant(b =>
        {
            b.UseSetting("Billing:Paddle:ApiKey", PaddleMock.Key)
                .UseSetting("Billing:Paddle:WebhookSecret", PaddleMock.Secret)
                .UseSetting("Billing:Paddle:Environment", "sandbox")
                .UseSetting("Billing:Paddle:BaseUrl", paddle.Url)
                .UseSetting("Billing:Plans:starter:PriceId", PaddleMock.Starter)
                .UseSetting("Billing:Plans:starter:MonthlyTokens", StarterTokens.ToString(System.Globalization.CultureInfo.InvariantCulture))
                .UseSetting("Billing:Plans:starter:EmbeddingsMonthlyTokens", "50000")
                .UseSetting("Billing:Plans:starter:Names:en", "Starter")
                .UseSetting("Billing:Plans:starter:Names:ar", "البداية")
                .UseSetting("Billing:Plans:team:PriceId", PaddleMock.Team)
                .UseSetting("Billing:Plans:team:MonthlyTokens", TeamTokens.ToString(System.Globalization.CultureInfo.InvariantCulture))
                .UseSetting("Billing:Plans:team:EmbeddingsMonthlyTokens", "500000")
                .UseSetting("Ai:Subscription:AnthropicKey", AiKit.NewKey())
                .UseSetting("Ai:Subscription:VoyageKey", EmbedKit.NewKey())
                .UseSetting("RateLimits:billing", "100000")
                .UseSetting("RateLimits:paddle", "100000");
            more?.Invoke(b);
        });
        return api;
    }

    private static async Task<HttpClient> SignedIn(WebApplicationFactory<Program> api, Account account)
    {
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, account.Email, account.Password);
        return client;
    }

    private static async Task<JsonElement> State(HttpClient owner, Guid ws)
    {
        var response = await owner.GetAsync($"/api/v1/workspaces/{ws}/billing");
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    /// <summary>A checkout of a plan, paid at the mock as Paddle's checkout would be; the transaction's id.</summary>
    private async Task<string> Subscribe(HttpClient owner, Guid ws, string plan)
    {
        var response = await owner.PostAsJsonAsync($"/api/v1/workspaces/{ws}/billing/checkout", new { planId = plan });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var url = (await Kit.Json(response)).GetProperty("url").GetString()!;
        Assert.StartsWith("http://localhost:5290/_pay/en?_ptxn=txn_", url, StringComparison.Ordinal);
        var transaction = url[(url.IndexOf("_ptxn=", StringComparison.Ordinal) + 6)..];
        var paid = await paddle.Control("pay", new { transactionId = transaction });
        Assert.Equal("ctm_", paid.GetProperty("customer").GetString()![..4]);
        return transaction;
    }

    /// <summary>Every webhook waiting at the mock, delivered to the API as Paddle sends them; their answers.</summary>
    private async Task<List<HttpStatusCode>> Deliver(WebApplicationFactory<Program> api)
    {
        var client = api.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), HandleCookies = false });
        var answers = new List<HttpStatusCode>();
        foreach (var e in await paddle.Outbox())
            answers.Add((await Post(client, e.Body, e.Signature)).StatusCode);
        return answers;
    }

    private static async Task<HttpResponseMessage> Post(HttpClient client, string body, string? signature)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/billing/paddle") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (signature is not null) request.Headers.TryAddWithoutValidation("Paddle-Signature", signature);
        return await client.SendAsync(request);
    }

    private async Task<long> Allowance(HttpClient owner, Guid ws)
    {
        var settings = await AiKit.Settings(owner, ws);
        return settings.TryGetProperty("subscription", out var s) ? s.GetProperty("allowance").GetInt64() : 0;
    }

    [Fact]
    public async Task An_owner_subscribes_in_paddles_checkout_and_the_allowance_follows_its_webhooks()
    {
        await paddle.Control("reset");
        var api = Billing();
        var ws = await Ws.Create(server);
        var owner = await SignedIn(api, ws.Account);

        // Offered: the plans with Paddle's prices; no plan yet, and no allowance (no default is set).
        var before = await State(owner, ws.Id);
        Assert.Equal("none", before.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, before.GetProperty("planId").ValueKind);
        Assert.True(before.GetProperty("canManage").GetBoolean());
        var plans = before.GetProperty("plans").EnumerateArray().ToList();
        Assert.Equal(["starter", "team"], plans.Select(p => p.GetProperty("id").GetString()));
        Assert.Equal("2900", plans[1].GetProperty("price").GetProperty("amount").GetString());
        Assert.Equal("USD", plans[1].GetProperty("price").GetProperty("currency").GetString());
        Assert.Equal("البداية", plans[0].GetProperty("nameAr").GetString());
        Assert.Equal(0, await Allowance(owner, ws.Id));
        var version = await Kit.Json(await owner.GetAsync("/api/v1/version"));
        Assert.True(version.GetProperty("billing").GetBoolean());

        // The checkout: a transaction of the team plan carrying the workspace's id, paid in Paddle's checkout.
        var transaction = await Subscribe(owner, ws.Id, "team");
        Assert.True((await State(owner, ws.Id)).GetProperty("checkoutPending").GetBoolean());
        var sent = (await paddle.Get("state")).GetProperty("transactions").EnumerateArray().Single(t => t.GetProperty("id").GetString() == transaction);
        Assert.Equal(ws.Id.ToString("D"), sent.GetProperty("custom_data").GetProperty("cgwWorkspaceId").GetString());

        // Paddle's webhooks: each taken, the subscription read from Paddle's API and applied.
        var watch = Stopwatch.StartNew();
        var answers = await Deliver(api);
        Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a));
        var after = await State(owner, ws.Id);
        Assert.Equal("team", after.GetProperty("planId").GetString());
        Assert.Equal("active", after.GetProperty("status").GetString());
        Assert.False(after.GetProperty("checkoutPending").GetBoolean());
        Assert.Equal(TeamTokens, await Allowance(owner, ws.Id));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(60));

        // Turned on with Cash Gear's key, the workspace's AI works on the plan.
        var on = await AiKit.Put(owner, ws.Id, new { keySource = "subscription", enabled = true });
        Assert.True(on.IsSuccessStatusCode, await on.Content.ReadAsStringAsync());

        // Stored: Paddle's ids, a status, a price and a period. Nothing of a card, an address or an amount.
        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.WorkspaceBilling.SingleAsync();
            Assert.StartsWith("sub_", row.SubscriptionId);
            Assert.StartsWith("ctm_", row.CustomerId);
            Assert.Equal(PaddleMock.Team, row.PriceId);
            Assert.NotNull(row.PeriodEndsAt);
            Assert.Equal(PaddleMock.Team, (await db.AiSettings.SingleAsync()).PlanPriceId);
            var events = await db.BillingEvents.Where(e => e.AppliedToWorkspace == ws.Id).ToListAsync();
            // The first event naming the subscription applies it; the rest find Paddle's state no newer.
            Assert.Single(events, e => e.Outcome == "applied");
            Assert.Contains(events, e => e.Type == "subscription.created" && e.Outcome == "stale");
            var audit = await db.AuditLog.Where(a => a.WorkspaceId == ws.Id && a.Action.StartsWith("billing.")).Select(a => a.Action).ToListAsync();
            Assert.Contains("billing.checkout", audit);
            Assert.Contains("billing.changed", audit);
        }
        // The server sent Paddle only its key and the price, the workspace's id and the pay page.
        var requests = (await paddle.Get("requests")).GetProperty("requests").EnumerateArray().ToList();
        Assert.All(requests, r => Assert.Equal("1", r.GetProperty("version").GetString()));
    }

    [Fact]
    public async Task A_webhook_replayed_forged_old_or_edited_changes_nothing()
    {
        await paddle.Control("reset");
        var api = Billing();
        var ws = await Ws.Create(server);
        var owner = await SignedIn(api, ws.Account);
        await Subscribe(owner, ws.Id, "starter");
        var events = await paddle.Outbox();
        var client = api.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), HandleCookies = false });
        var created = events.Single(e => e.Type == "subscription.created");

        // Forged: no signature, another secret's, an old one, a body changed after signing.
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(client, created.Body, null)).StatusCode);
        var forged = await paddle.Control("forge", new { });
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(client, forged.GetProperty("body").GetString()!, forged.GetProperty("signature").GetString())).StatusCode);
        var old = DateTimeOffset.UtcNow.AddMinutes(-6).ToUnixTimeSeconds();
        var oldSignature = $"ts={old};h1={PaddleSignature.Sign(old, Encoding.UTF8.GetBytes(created.Body), PaddleMock.Secret)}";
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(client, created.Body, oldSignature)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(client, created.Body.Replace("\"active\"", "\"trialing\"", StringComparison.Ordinal), created.Signature)).StatusCode);
        Assert.Equal("none", (await State(owner, ws.Id)).GetProperty("status").GetString());
        await using (var db = server.NewDb(ws.Id))
            Assert.Empty(await db.BillingEvents.Where(e => e.EventId == created.EventId).ToListAsync());

        // Delivered: applied once; again (Paddle delivers at least once): 200 and nothing more.
        Assert.Equal(HttpStatusCode.OK, (await Post(client, created.Body, created.Signature)).StatusCode);
        Assert.Equal("starter", (await State(owner, ws.Id)).GetProperty("planId").GetString());
        Assert.Equal(HttpStatusCode.OK, (await Post(client, created.Body, created.Signature)).StatusCode);
        await using (var db = server.NewDb(ws.Id))
            Assert.Single(await db.BillingEvents.Where(e => e.EventId == created.EventId).ToListAsync());

        // Cancelled at once; then an event with an old snapshot of it, signed: the state is Paddle's, still cancelled.
        var subscription = (await paddle.Get("state")).GetProperty("subscriptions")[0].GetProperty("id").GetString()!;
        await paddle.Control("cancel", new { subscriptionId = subscription, immediately = true });
        await Deliver(api);
        Assert.Equal("canceled", (await State(owner, ws.Id)).GetProperty("status").GetString());
        var stale = JsonDocument.Parse(created.Body).RootElement.GetProperty("data").GetRawText();
        await paddle.Control("send", new { type = "subscription.activated", data = JsonDocument.Parse(stale).RootElement });
        await Deliver(api);
        var final = await State(owner, ws.Id);
        Assert.Equal("canceled", final.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, final.GetProperty("planId").ValueKind);
        Assert.Equal(0, await Allowance(owner, ws.Id));
    }

    [Fact]
    public async Task A_cancelled_plan_lasts_its_period_and_a_failed_payment_ends_it_when_paddle_stops_retrying()
    {
        await paddle.Control("reset");
        var api = Billing();
        var ws = await Ws.Create(server);
        var owner = await SignedIn(api, ws.Account);
        await Subscribe(owner, ws.Id, "starter");
        await Deliver(api);
        var subscription = (await paddle.Get("state")).GetProperty("subscriptions")[0].GetProperty("id").GetString()!;

        // Cancelled at the period's end: the plan holds, and Settings says until when.
        await paddle.Control("cancel", new { subscriptionId = subscription });
        await Deliver(api);
        var scheduled = await State(owner, ws.Id);
        Assert.Equal("starter", scheduled.GetProperty("planId").GetString());
        Assert.Equal("cancel", scheduled.GetProperty("scheduledAction").GetString());
        Assert.Equal(StarterTokens, await Allowance(owner, ws.Id));
        await paddle.Control("periodEnd", new { subscriptionId = subscription });
        await Deliver(api);
        Assert.Equal(JsonValueKind.Null, (await State(owner, ws.Id)).GetProperty("planId").ValueKind);
        Assert.Equal(0, await Allowance(owner, ws.Id));

        // Subscribed again; a renewal fails: past due keeps the plan while Paddle retries; the retries end: no plan.
        await Subscribe(owner, ws.Id, "team");
        await Deliver(api);
        var again = (await paddle.Get("state")).GetProperty("subscriptions").EnumerateArray()
            .Single(s => s.GetProperty("status").GetString() == "active").GetProperty("id").GetString()!;
        await paddle.Control("renew", new { subscriptionId = again, fail = true });
        await Deliver(api);
        Assert.Equal("past_due", (await State(owner, ws.Id)).GetProperty("status").GetString());
        Assert.Equal(TeamTokens, await Allowance(owner, ws.Id));
        await paddle.Control("dunning", new { subscriptionId = again, outcome = "canceled" });
        await Deliver(api);
        Assert.Equal("canceled", (await State(owner, ws.Id)).GetProperty("status").GetString());
        Assert.Equal(0, await Allowance(owner, ws.Id));
    }

    [Fact]
    public async Task A_plan_changes_at_once_the_portal_is_paddles_and_a_workspaces_own_override_still_wins()
    {
        await paddle.Control("reset");
        var ws = await Ws.Create(server);
        var api = Billing();
        var owner = await SignedIn(api, ws.Account);
        await Subscribe(owner, ws.Id, "starter");
        await Deliver(api);

        // A second checkout is refused: the plan changes instead, at once.
        var twice = await owner.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/billing/checkout", new { planId = "team" });
        Assert.Equal(HttpStatusCode.Conflict, twice.StatusCode);
        Assert.Equal("billing.subscribed", (await Kit.Json(twice)).GetProperty("code").GetString());
        var changed = await owner.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/billing/plan", new { planId = "team" });
        Assert.True(changed.IsSuccessStatusCode, await changed.Content.ReadAsStringAsync());
        Assert.Equal("team", (await Kit.Json(changed)).GetProperty("planId").GetString());
        Assert.Equal(TeamTokens, await Allowance(owner, ws.Id));
        Assert.All(await Deliver(api), a => Assert.Equal(HttpStatusCode.OK, a));
        Assert.Equal("team", (await State(owner, ws.Id)).GetProperty("planId").GetString());

        // The portal: a link of Paddle's own, made anew each time.
        var portal = await owner.PostAsync($"/api/v1/workspaces/{ws.Id}/billing/portal", null);
        Assert.True(portal.IsSuccessStatusCode, await portal.Content.ReadAsStringAsync());
        Assert.StartsWith(paddle.Url + "/portal/", (await Kit.Json(portal)).GetProperty("url").GetString(), StringComparison.Ordinal);

        // The environment's override for this workspace wins over its plan.
        var overridden = Billing(b => b.UseSetting($"Ai:Subscription:Workspaces:{ws.Id}:MonthlyTokens", "1234"));
        Assert.Equal(1234, await Allowance(await SignedIn(overridden, ws.Account), ws.Id));
    }

    [Fact]
    public async Task Only_owners_buy_admins_see_members_do_not_and_without_paddle_nothing_is_there()
    {
        await paddle.Control("reset");
        var api = Billing();
        var ws = await Ws.Create(server);
        var admin = await SignedIn(api, await Kit.Join(server, ws, "admin"));
        var member = await SignedIn(api, await Kit.Join(server, ws, "member"));

        var seen = await State(admin, ws.Id);
        Assert.False(seen.GetProperty("canManage").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/billing/checkout", new { planId = "team" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/billing/plan", new { planId = "team" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PostAsync($"/api/v1/workspaces/{ws.Id}/billing/portal", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync($"/api/v1/workspaces/{ws.Id}/billing")).StatusCode);
        var owner = await SignedIn(api, ws.Account);
        var unknown = await owner.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/billing/checkout", new { planId = "gold" });
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        var never = await owner.PostAsync($"/api/v1/workspaces/{ws.Id}/billing/portal", null);
        Assert.Equal(HttpStatusCode.Conflict, never.StatusCode);
        Assert.Equal("billing.none", (await Kit.Json(never)).GetProperty("code").GetString());

        // Paddle unreachable: 502 billing.provider, and nothing recorded as a checkout.
        var down = Billing(b => b.UseSetting("Billing:Paddle:BaseUrl", "http://127.0.0.1:9"));
        var refused = await (await SignedIn(down, ws.Account)).PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/billing/checkout", new { planId = "team" });
        Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
        Assert.Equal("billing.provider", (await Kit.Json(refused)).GetProperty("code").GetString());
        await using (var db = server.NewDb(ws.Id))
            Assert.Empty(await db.BillingCheckouts.ToListAsync());

        // The default server: no Paddle, no plans, nothing of billing.
        var plain = await SignedIn(server.Api, ws.Account);
        Assert.Equal(HttpStatusCode.NotFound, (await plain.GetAsync($"/api/v1/workspaces/{ws.Id}/billing")).StatusCode);
        Assert.False((await Kit.Json(await plain.GetAsync("/api/v1/version"))).GetProperty("billing").GetBoolean());
        var anonymous = server.Api.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), HandleCookies = false });
        Assert.Equal(HttpStatusCode.NotFound, (await Post(anonymous, "{}", "ts=1;h1=00")).StatusCode);
    }

    [Fact]
    public async Task A_lost_webhook_is_found_by_the_owners_return_and_by_the_daily_reconcile()
    {
        await paddle.Control("reset");
        var api = Billing();
        var ws = await Ws.Create(server);
        var owner = await SignedIn(api, ws.Account);
        await Subscribe(owner, ws.Id, "starter");
        await paddle.Outbox();

        // Back from the checkout with no webhook: Settings reads the plan again from Paddle.
        var refreshed = await owner.PostAsync($"/api/v1/workspaces/{ws.Id}/billing/refresh", null);
        Assert.True(refreshed.IsSuccessStatusCode, await refreshed.Content.ReadAsStringAsync());
        Assert.Equal("starter", (await Kit.Json(refreshed)).GetProperty("planId").GetString());

        // Cancelled at Paddle, the webhook lost: the reconcile reads it and the plan ends.
        var subscription = (await paddle.Get("state")).GetProperty("subscriptions")[0].GetProperty("id").GetString()!;
        await paddle.Control("cancel", new { subscriptionId = subscription, immediately = true });
        await paddle.Outbox();
        Assert.Equal("starter", (await State(owner, ws.Id)).GetProperty("planId").GetString());
        await using (var scope = api.Services.CreateAsyncScope())
        {
            var job = new BillingReconcileJob(scope.ServiceProvider.GetRequiredService<BillingOptions>(), scope.ServiceProvider.GetRequiredService<PaddleClient>(),
                TimeProvider.System, NullLogger<BillingReconcileJob>.Instance);
            var report = await job.ReconcileAsync(scope.ServiceProvider, CancellationToken.None, ws.Id, force: true);
            Assert.Equal(1, report.Applied);
        }
        Assert.Equal("canceled", (await State(owner, ws.Id)).GetProperty("status").GetString());
        Assert.Equal(0, await Allowance(owner, ws.Id));
    }

    [Fact]
    public async Task The_pay_page_runs_paddles_checkout_on_the_sites_origin_with_no_cookie_and_no_session()
    {
        var sites = server.NewSites(b => b.UseSetting("Billing:Paddle:ClientToken", "test_0123456789abcdef0123456")
            .UseSetting("Billing:Paddle:ScriptUrl", paddle.Url + "/paddle.js"));
        var client = ServerFixture.SiteClient(sites);
        var page = await client.GetAsync("/_pay/ar?_ptxn=txn_01abc");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("lang=\"ar\" dir=\"rtl\"", html, StringComparison.Ordinal);
        Assert.Contains($"src=\"{paddle.Url}/paddle.js\"", html, StringComparison.Ordinal);
        Assert.Contains("data-sandbox=\"1\"", html, StringComparison.Ordinal);
        var csp = page.Headers.GetValues("Content-Security-Policy").Single();
        Assert.Contains($"script-src 'self' {paddle.Url}/paddle.js;", csp, StringComparison.Ordinal);
        Assert.Contains($"frame-src {paddle.Url};", csp, StringComparison.Ordinal);
        Assert.Contains("frame-ancestors 'none'", csp, StringComparison.Ordinal);
        Assert.False(page.Headers.Contains("Set-Cookie"));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/_pay/pay.js")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/_pay/fr")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/_pay/en", null)).StatusCode);

        // Without a client-side token the page is not there; published pages keep their own policy.
        var plain = ServerFixture.SiteClient(server.Sites);
        Assert.Equal(HttpStatusCode.NotFound, (await plain.GetAsync("/_pay/en")).StatusCode);
        Assert.DoesNotContain("paddle", (await plain.GetAsync("/_pay/en")).Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_signature_is_paddles_hex_hmac_of_the_time_and_body_and_any_h1_may_match()
    {
        var body = Encoding.UTF8.GetBytes("{\"event_id\":\"evt_01x\"}");
        var now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
        var good = PaddleSignature.Sign(1_800_000_000, body, "secret_secret_secret_1");
        Assert.Equal(64, good.Length);
        Assert.Equal(good, good.ToLowerInvariant());
        Assert.True(PaddleSignature.Verify($"ts=1800000000;h1={good}", body, "secret_secret_secret_1", now));
        Assert.True(PaddleSignature.Verify($"ts=1800000000;h1={new string('0', 64)};h1={good}", body, "secret_secret_secret_1", now));
        Assert.True(PaddleSignature.Verify($"ts=1800000000;h1={good}", body, "secret_secret_secret_1", now.AddMinutes(4)));
        Assert.False(PaddleSignature.Verify($"ts=1800000000;h1={good}", body, "secret_secret_secret_1", now.AddMinutes(6)));
        Assert.False(PaddleSignature.Verify($"ts=1800000000;h1={good}", body, "secret_secret_secret_2", now));
        Assert.False(PaddleSignature.Verify($"h1={good}", body, "secret_secret_secret_1", now));
        Assert.False(PaddleSignature.Verify("ts=1800000000", body, "secret_secret_secret_1", now));
        Assert.False(PaddleSignature.Verify(null, body, "secret_secret_secret_1", now));
    }
}
