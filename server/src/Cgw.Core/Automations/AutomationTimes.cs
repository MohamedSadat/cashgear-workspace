using System.Globalization;
using System.Text.Json.Nodes;

namespace Cgw.Core.Automations;

/// <summary>
/// When a date trigger's moment comes and a schedule runs next (DECISIONS.md, 2026-11-24: the
/// workspace's time zone, an IANA name; a day with no time is that day in it). A local time that
/// does not exist (a clock moved forward) is the first moment after the gap; one that comes twice
/// (moved back) is its first.
/// </summary>
public static class AutomationTimes
{
    /// <summary>The time of day a day with no time is reached at, when the trigger names none.</summary>
    public const string DefaultAt = "09:00";

    /// <summary>The zone by its IANA name, or UTC when there is none or it is not one this host knows.</summary>
    public static TimeZoneInfo Zone(string? id) =>
        !string.IsNullOrEmpty(id) && TimeZoneInfo.TryFindSystemTimeZoneById(id, out var zone) ? zone : TimeZoneInfo.Utc;

    /// <summary>Whether this host knows the zone by that IANA name (Settings refuses any other).</summary>
    public static bool IsZone(string? id) =>
        !string.IsNullOrEmpty(id) && id.Length <= 64 && TimeZoneInfo.TryFindSystemTimeZoneById(id, out var zone)
        && (zone.HasIanaId || TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out _));

    /// <summary>A wall-clock time in a zone as an instant (see the class for gaps and repeats).</summary>
    public static DateTimeOffset At(DateTime local, TimeZoneInfo zone)
    {
        local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
        // In a gap, the first minute after it (a gap is at most a few hours).
        for (var i = 0; i < 24 * 60 && zone.IsInvalidTime(local); i++) local = local.AddMinutes(1);
        if (zone.IsAmbiguousTime(local))
        {
            var offsets = zone.GetAmbiguousTimeOffsets(local);
            var first = offsets.Max();
            return new DateTimeOffset(local, first).ToUniversalTime();
        }
        return new DateTimeOffset(local, zone.GetUtcOffset(local)).ToUniversalTime();
    }

    private static (int Hour, int Minute) Clock(string? at)
    {
        var text = string.IsNullOrEmpty(at) ? DefaultAt : at;
        return (int.Parse(text[..2], CultureInfo.InvariantCulture), int.Parse(text[3..5], CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// When a date value's moment comes for a date trigger: a date-time at its instant, a day at
    /// <paramref name="at"/> in the zone, each moved by the offset. Null for a value that is not a date.
    /// </summary>
    public static DateTimeOffset? Due(string? start, int offsetMinutes, string? at, TimeZoneInfo zone)
    {
        if (string.IsNullOrEmpty(start)) return null;
        if (start.Length == 10)
        {
            if (!DateTime.TryParseExact(start, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)) return null;
            var (hour, minute) = Clock(at);
            return At(day.AddHours(hour).AddMinutes(minute), zone).AddMinutes(offsetMinutes);
        }
        if (!DateTimeOffset.TryParse(start, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var instant)) return null;
        return instant.AddMinutes(offsetMinutes);
    }

    /// <summary>A created time's moment (it is an instant always).</summary>
    public static DateTimeOffset Due(DateTimeOffset created, int offsetMinutes) => created.AddMinutes(offsetMinutes);

    /// <summary>
    /// A schedule's first run after <paramref name="after"/>: every day at its time; every week on
    /// its weekday (0 Sunday); every month on its day, or a shorter month's last day.
    /// </summary>
    public static DateTimeOffset? Next(JsonObject trigger, TimeZoneInfo zone, DateTimeOffset after)
    {
        var every = (string?)trigger["every"];
        var (hour, minute) = Clock((string?)trigger["at"]);
        var local = TimeZoneInfo.ConvertTime(after, zone).DateTime.Date;
        // Today first, then each later day: at most a month and a bit.
        for (var i = 0; i < 400; i++)
        {
            var day = local.AddDays(i);
            var fits = every switch
            {
                "day" => true,
                "week" => (int)day.DayOfWeek == ((int?)trigger["weekday"] ?? -1),
                "month" => day.Day == Math.Min((int?)trigger["day"] ?? 1, DateTime.DaysInMonth(day.Year, day.Month)),
                _ => false,
            };
            if (!fits) continue;
            var when = At(day.AddHours(hour).AddMinutes(minute), zone);
            if (when > after) return when;
        }
        return null;
    }
}
