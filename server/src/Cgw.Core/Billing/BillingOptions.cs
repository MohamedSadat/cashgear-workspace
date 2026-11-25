using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Billing;

/// <summary>
/// A plan of Cash Gear's AI subscription (Phase 18, M18.2; decisions, 2026-11-25): a flat price a
/// month a workspace, Paddle's price (<c>PriceId</c>, whose amount is Paddle's catalogue's, never this
/// server's), and the monthly allowance of tokens it gives, completions' and search by meaning's
/// apart. Its names in both languages are shown in Settings.
/// </summary>
public sealed record BillingPlan(string Id, string PriceId, long MonthlyTokens, long EmbeddingsMonthlyTokens, string NameEn, string NameAr);

/// <summary>
/// Paddle, the merchant of record (<c>Billing__Paddle__*</c>): its API key and the webhook
/// destination's secret from the host's environment only (<c>install.ps1</c> reads them from the
/// session, as the SMTP password); the client-side token the pay page gives Paddle.js (public by
/// Paddle's design); sandbox or live, by <c>Environment</c> or else the key's own prefix. The API's
/// and the script's addresses are Paddle's own, moved only outside Production (the mock in
/// <c>tests/mocks/paddle</c>).
/// </summary>
public sealed record PaddleOptions(string ApiKey, string WebhookSecret, string? ClientToken, bool Sandbox, string ApiBase, string ScriptUrl)
{
    public const string LiveApi = "https://api.paddle.com";
    public const string SandboxApi = "https://sandbox-api.paddle.com";
    public const string Script = "https://cdn.paddle.com/paddle/v2/paddle.js";

    /// <summary>How old a webhook's signed time may be (clocks differ; a replay changes nothing anyway).</summary>
    public static readonly TimeSpan Tolerance = TimeSpan.FromMinutes(5);

    // The key and the secret must not reach a log through the record's generated ToString.
    public override string ToString() => $"PaddleOptions {{ Sandbox = {Sandbox}, ApiBase = {ApiBase} }}";
}

/// <summary>
/// The server's billing (<c>Billing__*</c>, Phase 18): Paddle and the plans
/// (<c>Billing__Plans__&lt;id&gt;__PriceId</c>, <c>__MonthlyTokens</c>, <c>__EmbeddingsMonthlyTokens</c>,
/// <c>__Names__en</c>, <c>__Names__ar</c>). Offered only with Paddle's key and secret and at least one
/// plan; without them nothing of billing is shown or reachable, as in 0.17.0.
/// </summary>
public sealed record BillingOptions(PaddleOptions? Paddle, IReadOnlyList<BillingPlan> Plans)
{
    public const string Section = "Billing";

    public static readonly BillingOptions None = new(null, []);

    public bool Offered => Paddle is not null && Plans.Count > 0;

    public BillingPlan? PlanById(string? id) => Plans.FirstOrDefault(p => p.Id == id);

    public BillingPlan? PlanByPrice(string? priceId) => priceId is null ? null : Plans.FirstOrDefault(p => p.PriceId == priceId);

    /// <summary>A plan's id: lowercase letters, digits and dashes, at most 32.</summary>
    public static bool PlanId(string? id) => id is { Length: > 0 and <= 32 } && id.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-');

    /// <summary>A Paddle id of its kind (<c>pri_</c>, <c>sub_</c>, <c>ctm_</c>, <c>txn_</c>, <c>evt_</c>): the prefix, then letters and digits.</summary>
    public static bool PaddleId(string? id, string prefix) =>
        id is { Length: > 4 and <= 64 } && id.StartsWith(prefix, StringComparison.Ordinal) && id[prefix.Length..].All(char.IsAsciiLetterOrDigit);

    public static BillingOptions From(IConfiguration configuration, bool production)
    {
        var section = configuration.GetSection(Section);
        var paddle = section.GetSection("Paddle");
        static string? Secret(string? value) => value?.Trim() is { Length: >= 20 and <= 500 } v && v.All(c => c is > ' ' and < '\u007f') ? v : null;
        PaddleOptions? options = null;
        if (Secret(paddle["ApiKey"]) is { } key && Secret(paddle["WebhookSecret"]) is { } secret)
        {
            var sandbox = paddle["Environment"]?.Trim().ToLowerInvariant() switch
            {
                "sandbox" => true,
                "live" => false,
                _ => key.StartsWith("pdl_sdbx_", StringComparison.Ordinal),
            };
            // Paddle's own addresses in Production; the mock's elsewhere, when named.
            var apiBase = (production ? null : Ai.AiOptions.BaseUrl(paddle["BaseUrl"])) ?? (sandbox ? PaddleOptions.SandboxApi : PaddleOptions.LiveApi);
            var script = (production ? null : Ai.AiOptions.BaseUrl(paddle["ScriptUrl"])) ?? PaddleOptions.Script;
            var token = paddle["ClientToken"]?.Trim() is { Length: > 0 and <= 200 } t && t.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ? t : null;
            options = new PaddleOptions(key, secret, token, sandbox, apiBase, script);
        }
        static long Tokens(string? value) => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n >= 0 ? n : 0;
        var plans = new List<BillingPlan>();
        foreach (var child in section.GetSection("Plans").GetChildren())
        {
            var id = child.Key.ToLowerInvariant();
            var price = child["PriceId"]?.Trim();
            if (!PlanId(id) || !PaddleId(price, "pri_") || plans.Any(p => p.PriceId == price)) continue;
            static string Name(string? value, string fallback) => value?.Trim() is { Length: > 0 and <= 60 } n ? n : fallback;
            var en = Name(child["Names:en"], id);
            plans.Add(new BillingPlan(id, price!, Tokens(child["MonthlyTokens"]), Tokens(child["EmbeddingsMonthlyTokens"]), en, Name(child["Names:ar"], en)));
        }
        // Smallest first, as Settings lists them.
        plans.Sort((a, b) => a.MonthlyTokens != b.MonthlyTokens ? a.MonthlyTokens.CompareTo(b.MonthlyTokens) : string.CompareOrdinal(a.Id, b.Id));
        return new BillingOptions(options, plans);
    }
}

/// <summary>A subscription's statuses at Paddle, and which give the plan's allowance.</summary>
public static class BillingStatuses
{
    public const string None = "none";
    public const string Active = "active";
    public const string Trialing = "trialing";
    /// <summary>A renewal failed and Paddle is retrying: the plan holds until it stops (decisions, 2026-11-25).</summary>
    public const string PastDue = "past_due";
    public const string Paused = "paused";
    public const string Canceled = "canceled";

    public static readonly string[] All = [None, Active, Trialing, PastDue, Paused, Canceled];

    public static bool Entitles(string? status) => status is Active or Trialing or PastDue;
}
