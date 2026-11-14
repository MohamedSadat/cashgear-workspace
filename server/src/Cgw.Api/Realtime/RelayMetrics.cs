using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Threading.RateLimiting;
using Cgw.Core.Documents;

namespace Cgw.Api.Realtime;

public sealed record RelayTimes(long Count, double P50Ms, double P95Ms, double MaxMs);

/// <summary><c>GET /api/v1/realtime/metrics</c> (the bench, M6.6; never in Production).</summary>
public sealed record RealtimeMetricsDto(int Connections, int Pages, RelayTimes Relayed, DateTimeOffset Since);

/// <summary>
/// The relay's times for the bench (Phase 6 contracts, section 1): from a push reaching the API (the
/// hub call or the HTTP request) to the frame carrying it being sent. Kept only while
/// <c>Realtime__Metrics</c> is on, outside Production.
/// </summary>
public sealed class RelayMetrics(RealtimeSettings settings, TimeProvider clock)
{
    private const int MaxPending = 200_000;
    private const int MaxSamples = 200_000;
    private readonly ConcurrentDictionary<(Guid Page, long Seq), long> pushed = new();
    private readonly List<double> samples = [];
    private DateTimeOffset since = clock.GetUtcNow();

    public bool Enabled => settings.Metrics;

    public static long Now() => Stopwatch.GetTimestamp();

    /// <summary>A push's acks, with when it reached the API.</summary>
    public void Pushed(Guid pageId, IReadOnlyList<DocAck> acks, long started)
    {
        if (!Enabled) return;
        if (pushed.Count > MaxPending) pushed.Clear();
        foreach (var ack in acks) pushed.TryAdd((pageId, ack.Seq), started);
    }

    /// <summary>A frame went out with these sequences.</summary>
    public void Relayed(Guid pageId, IEnumerable<long> seqs)
    {
        if (!Enabled) return;
        var now = Now();
        lock (samples)
            foreach (var seq in seqs)
                if (pushed.TryRemove((pageId, seq), out var started))
                {
                    if (samples.Count >= MaxSamples) samples.RemoveRange(0, MaxSamples / 2);
                    samples.Add(Stopwatch.GetElapsedTime(started, now).TotalMilliseconds);
                }
    }

    public RealtimeMetricsDto Snapshot(RealtimeRegistry registry)
    {
        double[] sorted;
        lock (samples) sorted = [.. samples.Order()];
        double At(double q) => sorted.Length == 0 ? 0 : Math.Round(sorted[Math.Min(sorted.Length - 1, (int)Math.Ceiling(q * sorted.Length) - 1)], 2);
        return new RealtimeMetricsDto(registry.Count, registry.PageCount,
            new RelayTimes(sorted.Length, At(0.5), At(0.95), sorted.Length == 0 ? 0 : Math.Round(sorted[^1], 2)), since);
    }

    public void Reset()
    {
        lock (samples) samples.Clear();
        pushed.Clear();
        since = clock.GetUtcNow();
    }
}

/// <summary>
/// The hub's push budget per person: the same size as the HTTP <c>push</c> bucket
/// (<c>RateLimits__push</c>, 600 a minute), counted apart from it.
/// </summary>
public sealed class HubPushBudget : IDisposable
{
    public const int DefaultPermits = 600;
    private readonly PartitionedRateLimiter<Guid> limiter;

    public HubPushBudget(IConfiguration configuration)
    {
        var permits = int.TryParse(configuration["RateLimits:push"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : DefaultPermits;
        limiter = PartitionedRateLimiter.Create<Guid, Guid>(user => RateLimitPartition.GetFixedWindowLimiter(user, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = permits,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));
    }

    /// <summary>Null when the call fits; else how long until the window opens.</summary>
    public TimeSpan? Take(Guid userId)
    {
        using var lease = limiter.AttemptAcquire(userId);
        if (lease.IsAcquired) return null;
        return lease.TryGetMetadata(MetadataName.RetryAfter, out var wait) ? wait : TimeSpan.FromSeconds(60);
    }

    public void Dispose() => limiter.Dispose();
}
