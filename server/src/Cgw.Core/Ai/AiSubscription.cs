using System.Globalization;
using Cgw.Core.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Ai;

/// <summary>Where a workspace's AI calls get their key (Phase 13): its own, or Cash Gear's subscription.</summary>
public static class KeySources
{
    public const string Own = "own";
    public const string Subscription = "subscription";

    public static readonly string[] All = [Own, Subscription];
}

/// <summary>
/// Cash Gear's AI subscription (<c>Ai__Subscription__*</c>, Phase 13, M13.5; decisions, 2026-11-21):
/// Cash Gear's own Anthropic and Voyage keys, from the host's environment only (<c>AnthropicKey</c>,
/// <c>VoyageKey</c>; <c>install.ps1</c> sets them from the session, as the SMTP password), and each
/// workspace's monthly allowance in tokens (input and output alike), completions' and embeddings'
/// apart: <c>MonthlyTokens</c> and <c>EmbeddingsMonthlyTokens</c> for every workspace, and
/// <c>Workspaces__&lt;workspaceId&gt;__MonthlyTokens</c> (and <c>__EmbeddingsMonthlyTokens</c>) for one. A
/// workspace with no allowance (none set, or 0), or a server without the key, is not offered it.
/// Phase 18: a workspace on a paid plan (its AI settings' <c>PlanPriceId</c>, while its subscription
/// gives one) has the plan's allowance where it is more than the default; a workspace's own override
/// still wins over both.
/// </summary>
public sealed record AiSubscriptionOptions(
    string? AnthropicKey,
    string? VoyageKey,
    long? Completions,
    long? Embeddings,
    IReadOnlyDictionary<Guid, (long? Completions, long? Embeddings)> Workspaces)
{
    public const string Section = "Ai:Subscription";

    public static readonly AiSubscriptionOptions None = new(null, null, null, null, new Dictionary<Guid, (long?, long?)>());

    /// <summary>Phase 18: the paid plans, when this server offers billing (<see cref="Billing.BillingOptions"/>).</summary>
    public IReadOnlyList<Billing.BillingPlan> Plans { get; init; } = [];

    /// <summary>The plan of a workspace's paid price (its AI settings' <c>PlanPriceId</c>), or none.</summary>
    public Billing.BillingPlan? PlanOf(string? planPrice) => planPrice is null ? null : Plans.FirstOrDefault(p => p.PriceId == planPrice);

    /// <summary>A workspace's monthly allowance of completions' tokens; 0: not offered.</summary>
    public long CompletionsFor(Guid workspaceId, string? planPrice) =>
        Workspaces.TryGetValue(workspaceId, out var own) && own.Completions is { } mine ? mine
        : Math.Max(Completions ?? 0, PlanOf(planPrice)?.MonthlyTokens ?? 0);

    public long EmbeddingsFor(Guid workspaceId, string? planPrice) =>
        Workspaces.TryGetValue(workspaceId, out var own) && own.Embeddings is { } mine ? mine
        : Math.Max(Embeddings ?? 0, PlanOf(planPrice)?.EmbeddingsMonthlyTokens ?? 0);

    public bool OffersCompletions(Guid workspaceId, string? planPrice) => AnthropicKey is not null && CompletionsFor(workspaceId, planPrice) > 0;

    public bool OffersEmbeddings(Guid workspaceId, string? planPrice) => VoyageKey is not null && EmbeddingsFor(workspaceId, planPrice) > 0;

    public long AllowanceOf(Guid workspaceId, string kind, string? planPrice) =>
        kind == AiAllowance.Embeddings ? EmbeddingsFor(workspaceId, planPrice) : CompletionsFor(workspaceId, planPrice);

    // The key and the keys of the record must not reach a log through its generated ToString.
    public override string ToString() => $"AiSubscriptionOptions {{ Anthropic = {AnthropicKey is not null}, Voyage = {VoyageKey is not null} }}";

    public static AiSubscriptionOptions From(IConfiguration configuration, Billing.BillingOptions billing)
    {
        var section = configuration.GetSection(Section);
        static string? Key(string? value) => AiKeys.Plausible(value?.Trim()) ? value!.Trim() : null;
        static long? Tokens(string? value) => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n >= 0 ? n : null;
        var workspaces = new Dictionary<Guid, (long?, long?)>();
        foreach (var child in section.GetSection("Workspaces").GetChildren())
            if (Guid.TryParse(child.Key, out var id))
                workspaces[id] = (Tokens(child["MonthlyTokens"]), Tokens(child["EmbeddingsMonthlyTokens"]));
        return new AiSubscriptionOptions(Key(section["AnthropicKey"]), Key(section["VoyageKey"]), Tokens(section["MonthlyTokens"]), Tokens(section["EmbeddingsMonthlyTokens"]), workspaces)
        {
            Plans = billing.Offered ? billing.Plans : [],
        };
    }
}

/// <summary>A workspace's month on the subscription: its allowance, what calls used, what calls under way reserved.</summary>
public sealed record AllowanceDto(string Month, long Allowance, long Used, long Reserved);

/// <summary>
/// A workspace's monthly allowance on Cash Gear's subscription (Phase 13, M13.5): every call reserves
/// its most (an estimate of its input and its output limit) before it is sent, under the workspace's
/// AI settings row's lock, so calls at once never pass the allowance together; a call settles by its
/// <see cref="AiUsage"/> row (marked <c>Subscription</c>, its tokens counted) taking the reservation's
/// place; a reservation a crash left lapses after 15 minutes. Past the allowance: 429 <c>ai.limit</c>
/// with <c>reason: "allowance"</c>. The month is the calendar month in UTC, as the usage totals'.
/// </summary>
public sealed class AiAllowance(CgwDb db, AiSubscriptionOptions options, TimeProvider clock)
{
    public const string Completions = "completions";
    public const string Embeddings = "embeddings";
    public const string Reason = "allowance";
    public static readonly TimeSpan Lapse = TimeSpan.FromMinutes(15);

    /// <summary>The refusal past an allowance.</summary>
    public static Failure Refused(string kind) => new(Codes.AiLimit, 429, kind == Embeddings
        ? "This workspace has used its allowance of search by meaning on Cash Gear's subscription for this month"
        : "This workspace has used its AI allowance on Cash Gear's subscription for this month")
    {
        Extensions = new Dictionary<string, object?> { ["reason"] = Reason },
    };

    /// <summary>The first instant of the month <paramref name="at"/> is in (UTC), and of the next.</summary>
    public static (DateTimeOffset Start, DateTimeOffset Next) MonthOf(DateTimeOffset at)
    {
        var start = new DateTimeOffset(at.UtcDateTime.Year, at.UtcDateTime.Month, 1, 0, 0, 0, TimeSpan.Zero);
        return (start, start.AddMonths(1));
    }

    private static string[] ActionsOf(string kind) => kind == Embeddings ? EmbeddingActions.All : AiActions.All;

    /// <summary>The workspace's paid plan's price, as its AI settings hold it (Phase 18).</summary>
    private Task<string?> PlanPriceAsync(Guid workspaceId, CancellationToken ct) =>
        db.AiSettings.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(s => s.WorkspaceId == workspaceId).Select(s => s.PlanPriceId).FirstOrDefaultAsync(ct);

    /// <summary>This month's use of the subscription by the workspace (the caller's tenant scope).</summary>
    public async Task<AllowanceDto> UsageAsync(Guid workspaceId, string kind, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        var (start, _) = MonthOf(now);
        var actions = ActionsOf(kind);
        var used = await db.AiUsage.AsNoTracking().Where(u => u.Subscription && u.CreatedAt >= start && actions.Contains(u.Action))
            .SumAsync(u => (long?)(u.InputTokens + u.OutputTokens), ct) ?? 0;
        var reserved = await db.AiReservations.AsNoTracking().Where(r => r.Kind == kind && r.ExpiresAt > now)
            .SumAsync(r => (long?)r.Tokens, ct) ?? 0;
        return new AllowanceDto(start.ToString("yyyy-MM", CultureInfo.InvariantCulture), options.AllowanceOf(workspaceId, kind, await PlanPriceAsync(workspaceId, ct)), used, reserved);
    }

    /// <summary>
    /// Reserves <paramref name="tokens"/> of the month's allowance for a call about to be sent, or
    /// refuses (<see cref="Refused"/>) when what is used and reserved and this would pass it. In a
    /// transaction of its own under the AI settings row's lock (the caller's tenant scope).
    /// </summary>
    public async Task<Result<Guid>> ReserveAsync(Guid workspaceId, string kind, long tokens, CancellationToken ct = default)
    {
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct);
            await db.Database.ExecuteSqlRawAsync("SELECT 1 FROM [AiSettings] WITH (UPDLOCK, HOLDLOCK) WHERE [WorkspaceId] = @ws",
                [new SqlParameter("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(workspaceId) }], ct);
            // The plan is read under the lock its change takes too (Phase 18: BillingService.ApplyAsync).
            var usage = await UsageAsync(workspaceId, kind, ct);
            if (usage.Allowance <= 0 || usage.Used + usage.Reserved + tokens > usage.Allowance)
            {
                await tx.RollbackAsync(ct);
                Result<Guid> refused = Refused(kind);
                return refused;
            }
            var now = clock.GetUtcNow();
            var id = Guid.CreateVersion7();
            db.AiReservations.Add(new AiReservation { Id = id, WorkspaceId = workspaceId, Kind = kind, Tokens = tokens, CreatedAt = now, ExpiresAt = now + Lapse });
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            db.ChangeTracker.Clear();
            return Result<Guid>.Success(id);
        });
    }

    /// <summary>Marks a reservation to go with the next save (the call's <see cref="AiUsage"/> row takes its place).</summary>
    public void Settle(Guid? reservation)
    {
        if (reservation is { } id) db.AiReservations.Remove(new AiReservation { Id = id });
    }

    /// <summary>Lets a reservation go at once (the call never went).</summary>
    public async Task ReleaseAsync(Guid? reservation, CancellationToken ct = default)
    {
        if (reservation is { } id) await db.AiReservations.Where(r => r.Id == id).ExecuteDeleteAsync(ct);
    }

    /// <summary>An estimate of a text's tokens that is never short: one a two characters (Arabic runs near it; English near four).</summary>
    public static long Estimate(long characters) => Math.Max(1, (characters + 1) / 2);
}
