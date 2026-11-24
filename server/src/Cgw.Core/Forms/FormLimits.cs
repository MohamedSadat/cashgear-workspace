using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Forms;

/// <summary>
/// How often an address answers a form by its link (Phase 16; decisions, 2026-11-24): at most 10 a
/// minute and 100 a day a link (<c>RateLimits:formMinute</c>, <c>RateLimits:formDay</c>), each a fixed
/// window from the address's first answer in it; an IPv6 address counted by its /64. Counted in the API
/// process's memory: a restart starts the counts again. Past either, the answer route answers 429
/// with the wait, while every other address answers on.
/// </summary>
public sealed class FormLimits
{
    public const string MinuteKey = "RateLimits:formMinute";
    public const string DayKey = "RateLimits:formDay";

    private sealed class Window
    {
        public DateTimeOffset MinuteFrom;
        public int Minute;
        public DateTimeOffset DayFrom;
        public int Day;
    }

    private readonly TimeProvider clock;
    private readonly ConcurrentDictionary<string, Window> windows = new(StringComparer.Ordinal);
    private long takes;

    public int PerMinute { get; }
    public int PerDay { get; }

    public FormLimits(TimeProvider clock, int perMinute = FormRules.AnswersPerMinute, int perDay = FormRules.AnswersPerDay)
    {
        this.clock = clock;
        PerMinute = perMinute;
        PerDay = perDay;
    }

    public static FormLimits From(IConfiguration configuration, TimeProvider clock)
    {
        static int Limit(IConfiguration c, string key, int fallback) =>
            int.TryParse(c[key], NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0 ? n : fallback;
        return new FormLimits(clock, Limit(configuration, MinuteKey, FormRules.AnswersPerMinute), Limit(configuration, DayKey, FormRules.AnswersPerDay));
    }

    /// <summary>Whose window: an IPv4 address (a mapped one too) as it is, an IPv6 address by its first 64 bits.</summary>
    public static string Partition(IPAddress? address)
    {
        if (address is null) return "unknown";
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return address.ToString();
        var bytes = address.GetAddressBytes();
        for (var i = 8; i < 16; i++) bytes[i] = 0;
        return new IPAddress(bytes) + "/64";
    }

    /// <summary>One answer of the address to the link (its token's hash, as text): taken, or refused with the wait.</summary>
    public (bool Taken, TimeSpan Wait) Take(IPAddress? address, string link)
    {
        var now = clock.GetUtcNow();
        if (Interlocked.Increment(ref takes) % 4096 == 0) Prune(now);
        var window = windows.GetOrAdd(Partition(address) + "|" + link, _ => new Window { MinuteFrom = now, DayFrom = now });
        lock (window)
        {
            if (now - window.MinuteFrom >= TimeSpan.FromMinutes(1))
            {
                window.MinuteFrom = now;
                window.Minute = 0;
            }
            if (now - window.DayFrom >= TimeSpan.FromDays(1))
            {
                window.DayFrom = now;
                window.Day = 0;
            }
            if (window.Day >= PerDay) return (false, window.DayFrom.AddDays(1) - now);
            if (window.Minute >= PerMinute) return (false, window.MinuteFrom.AddMinutes(1) - now);
            window.Minute++;
            window.Day++;
            return (true, TimeSpan.Zero);
        }
    }

    /// <summary>Windows whose day is over are forgotten.</summary>
    private void Prune(DateTimeOffset now)
    {
        foreach (var (key, window) in windows)
            if (now - window.DayFrom >= TimeSpan.FromDays(1)) windows.TryRemove(key, out _);
    }
}
