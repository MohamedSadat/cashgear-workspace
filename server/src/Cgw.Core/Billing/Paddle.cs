using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cgw.Core.Billing;

/// <summary>A subscription as Paddle's API answers it, read for what decides a workspace's plan.</summary>
public sealed record PaddleSubscription(
    string Id,
    string Status,
    string? CustomerId,
    string? PriceId,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? PeriodEndsAt,
    string? ScheduledAction,
    DateTimeOffset? ScheduledAt,
    Guid? WorkspaceId);

/// <summary>A price as Paddle's catalogue holds it: its amount in the currency's smallest unit, and how often it bills.</summary>
public sealed record PaddlePrice(string Id, string Amount, string Currency, string? Interval, int Frequency);

/// <summary>A Paddle call that failed: <c>billing.provider</c> (502), with Paddle's own error code for the log.</summary>
public sealed class PaddleException(string message, string? paddleCode = null, HttpStatusCode? status = null) : Exception(message)
{
    public string? PaddleCode { get; } = paddleCode;
    public HttpStatusCode? Status { get; } = status;
}

/// <summary>
/// Paddle Billing's API (<c>Paddle-Version: 1</c>) over HttpClient, the server's key as a bearer
/// token (INTEGRATIONS.md, Billing). Only what billing needs: a transaction for a checkout, a
/// subscription read or its price changed, a portal session, a price. Never a card, an address or a
/// customer's details: the checkout and the portal are Paddle's own pages.
/// </summary>
public sealed class PaddleClient(BillingOptions billing, HttpClient http)
{
    private PaddleOptions options => billing.Paddle ?? throw new PaddleException("Billing is not configured on this server");

    public const string WorkspaceKey = "cgwWorkspaceId";

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    private async Task<JsonNode> SendAsync(HttpMethod method, string path, JsonNode? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, options.ApiBase + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
        request.Headers.Add("Paddle-Version", "1");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Timeout);
        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, timeout.Token);
        }
        catch (Exception error) when (error is HttpRequestException || (error is OperationCanceledException && !ct.IsCancellationRequested))
        {
            throw new PaddleException("Paddle could not be reached", error is HttpRequestException ? "connection" : "timeout");
        }
        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            JsonNode? json = null;
            try { json = text.Length > 0 ? JsonNode.Parse(text) : null; } catch (JsonException) { }
            if (!response.IsSuccessStatusCode)
                throw new PaddleException($"Paddle answered {(int)response.StatusCode}", json?["error"]?["code"]?.GetValue<string>(), response.StatusCode);
            return json?["data"] ?? throw new PaddleException("Paddle's answer held no data");
        }
    }

    /// <summary>
    /// A transaction of one plan's price for a workspace, its id in <c>custom_data</c> (which Paddle
    /// copies to the subscription the checkout makes), checked out on the pay page at
    /// <paramref name="checkoutUrl"/>. An existing customer is named so the subscription is theirs.
    /// </summary>
    public async Task<(string Id, string CheckoutUrl)> CreateTransactionAsync(string priceId, string? customerId, Guid workspaceId, string checkoutUrl, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["items"] = new JsonArray(new JsonObject { ["price_id"] = priceId, ["quantity"] = 1 }),
            ["custom_data"] = new JsonObject { [WorkspaceKey] = workspaceId.ToString("D") },
            ["collection_mode"] = "automatic",
            ["checkout"] = new JsonObject { ["url"] = checkoutUrl },
        };
        if (customerId is not null) body["customer_id"] = customerId;
        var data = await SendAsync(HttpMethod.Post, "/transactions", body, ct);
        var id = data["id"]?.GetValue<string>();
        var url = data["checkout"]?["url"]?.GetValue<string>();
        if (!BillingOptions.PaddleId(id, "txn_") || url is null || !Uri.TryCreate(url, UriKind.Absolute, out _))
            throw new PaddleException("Paddle's transaction had no checkout");
        return (id!, url);
    }

    /// <summary>A transaction's subscription, once its checkout was paid (null until then).</summary>
    public async Task<string?> TransactionSubscriptionAsync(string transactionId, CancellationToken ct)
    {
        var data = await SendAsync(HttpMethod.Get, "/transactions/" + Uri.EscapeDataString(transactionId), null, ct);
        var id = data["subscription_id"]?.GetValue<string>();
        return BillingOptions.PaddleId(id, "sub_") ? id : null;
    }

    /// <summary>A subscription, or null when Paddle has none of that id.</summary>
    public async Task<PaddleSubscription?> SubscriptionAsync(string subscriptionId, CancellationToken ct)
    {
        try
        {
            return ReadSubscription(await SendAsync(HttpMethod.Get, "/subscriptions/" + Uri.EscapeDataString(subscriptionId), null, ct));
        }
        catch (PaddleException error) when (error.Status == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    /// <summary>Many subscriptions by id, at most 200 a call (the daily reconcile).</summary>
    public async Task<List<PaddleSubscription>> SubscriptionsAsync(IReadOnlyCollection<string> ids, CancellationToken ct)
    {
        if (ids.Count == 0) return [];
        if (ids.Count > 200) throw new ArgumentOutOfRangeException(nameof(ids));
        var data = await SendAsync(HttpMethod.Get, "/subscriptions?per_page=200&id=" + string.Join(',', ids.Select(Uri.EscapeDataString)), null, ct);
        return data is JsonArray list ? list.Select(ReadSubscription).OfType<PaddleSubscription>().ToList() : [];
    }

    /// <summary>A subscription moved to another plan's price at once, prorated (an upgrade or a downgrade).</summary>
    public async Task<PaddleSubscription?> ChangePriceAsync(string subscriptionId, string priceId, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["items"] = new JsonArray(new JsonObject { ["price_id"] = priceId, ["quantity"] = 1 }),
            ["proration_billing_mode"] = "prorated_immediately",
            ["on_payment_failure"] = "prevent_change",
        };
        return ReadSubscription(await SendAsync(HttpMethod.Patch, "/subscriptions/" + Uri.EscapeDataString(subscriptionId), body, ct));
    }

    /// <summary>An authenticated link to Paddle's customer portal for the customer (made anew each time; it expires).</summary>
    public async Task<string> PortalAsync(string customerId, string? subscriptionId, CancellationToken ct)
    {
        var body = new JsonObject();
        if (subscriptionId is not null) body["subscription_ids"] = new JsonArray(subscriptionId);
        var data = await SendAsync(HttpMethod.Post, "/customers/" + Uri.EscapeDataString(customerId) + "/portal-sessions", body, ct);
        var url = data["urls"]?["general"]?["overview"]?.GetValue<string>();
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
            throw new PaddleException("Paddle's portal session had no link");
        return url;
    }

    /// <summary>A price of the catalogue, to show beside its plan.</summary>
    public async Task<PaddlePrice?> PriceAsync(string priceId, CancellationToken ct)
    {
        var data = await SendAsync(HttpMethod.Get, "/prices/" + Uri.EscapeDataString(priceId), null, ct);
        var amount = data["unit_price"]?["amount"]?.GetValue<string>();
        var currency = data["unit_price"]?["currency_code"]?.GetValue<string>();
        if (amount is null || !amount.All(char.IsAsciiDigit) || currency is not { Length: 3 }) return null;
        var cycle = data["billing_cycle"];
        return new PaddlePrice(priceId, amount, currency, cycle?["interval"]?.GetValue<string>(), cycle?["frequency"]?.GetValue<int>() ?? 1);
    }

    /// <summary>The fields of a subscription that decide a plan; null when it is not one Paddle would send.</summary>
    public static PaddleSubscription? ReadSubscription(JsonNode? data)
    {
        if (data is not JsonObject o) return null;
        var id = Text(o["id"]);
        var status = Text(o["status"]);
        var updated = Time(o["updated_at"]);
        if (!BillingOptions.PaddleId(id, "sub_") || status is null || !BillingStatuses.All.Contains(status) || status == BillingStatuses.None || updated is null) return null;
        var customer = Text(o["customer_id"]);
        // One price a plan: the first active item's (a subscription this server made holds one).
        string? price = null;
        if (o["items"] is JsonArray items)
            foreach (var item in items.OfType<JsonObject>())
                if (Text(item["status"]) is null or "active" or "trialing" && Text(item["price"]?["id"]) is { } p && BillingOptions.PaddleId(p, "pri_"))
                {
                    price = p;
                    break;
                }
        Guid? workspace = Guid.TryParse(Text(o["custom_data"]?[WorkspaceKey]), out var ws) ? ws : null;
        var scheduled = o["scheduled_change"] as JsonObject;
        var action = Text(scheduled?["action"]);
        return new PaddleSubscription(id!, status, BillingOptions.PaddleId(customer, "ctm_") ? customer : null, price, updated.Value,
            Time(o["current_billing_period"]?["ends_at"]), action is "cancel" or "pause" ? action : null, action is "cancel" or "pause" ? Time(scheduled?["effective_at"]) : null, workspace);
    }

    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static DateTimeOffset? Time(JsonNode? node) =>
        Text(node) is { } s && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t.ToUniversalTime() : null;
}

/// <summary>
/// Paddle's webhook signature (<c>Paddle-Signature: ts=…;h1=…</c>): HMAC-SHA256, keyed by the
/// notification destination's secret, of the time, a colon and the raw body, in lowercase hex; any of
/// its <c>h1</c> values may match (a secret being rotated), and the time must be within
/// <see cref="PaddleOptions.Tolerance"/> of the server's.
/// </summary>
public static class PaddleSignature
{
    public static bool Verify(string? header, ReadOnlySpan<byte> body, string secret, DateTimeOffset now)
    {
        if (header is null || header.Length > 2_000) return false;
        long? ts = null;
        var signatures = new List<string>();
        foreach (var part in header.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var at = part.IndexOf('=');
            if (at <= 0) return false;
            var (name, value) = (part[..at], part[(at + 1)..]);
            if (name == "ts" && long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var t)) ts = t;
            else if (name == "h1" && value.Length == 64) signatures.Add(value);
        }
        if (ts is not { } seconds || signatures.Count == 0) return false;
        DateTimeOffset signedAt;
        try { signedAt = DateTimeOffset.FromUnixTimeSeconds(seconds); } catch (ArgumentOutOfRangeException) { return false; }
        if ((now - signedAt).Duration() > PaddleOptions.Tolerance) return false;
        var expected = Sign(seconds, body, secret);
        var ok = false;
        foreach (var signature in signatures)
            ok |= CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(signature.ToLowerInvariant()), Encoding.ASCII.GetBytes(expected));
        return ok;
    }

    /// <summary>The lowercase hex HMAC Paddle sends for this time and body (the mock signs the same way).</summary>
    public static string Sign(long seconds, ReadOnlySpan<byte> body, string secret)
    {
        var prefix = Encoding.UTF8.GetBytes(seconds.ToString(CultureInfo.InvariantCulture) + ":");
        var message = new byte[prefix.Length + body.Length];
        prefix.CopyTo(message, 0);
        body.CopyTo(message.AsSpan(prefix.Length));
        return Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), message));
    }
}
