using System.Globalization;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Core.Databases;

namespace Cgw.Core.Automations;

/// <summary>
/// Phase 17, M17.2: where a repeating row's series is (DATA_MODEL.md, Automations). A rule whose
/// trigger is <c>recurring</c> keeps the day it makes a row for next (<see cref="Automation.SeriesNext"/>,
/// its moment in <see cref="Automation.NextAt"/>), the last day it made one for and that row. By its
/// days, a row on each day at the trigger's time in the workspace's zone (a day a stopped worker
/// missed is skipped for the latest one); by the last done, the next day at once once the last row
/// is done, never a day already past.
/// </summary>
public static class RecurringSeries
{
    public const string ByDays = "date";
    public const string ByDone = "done";

    private static string Text(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static DateOnly LocalDay(DateTimeOffset at, TimeZoneInfo zone) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, zone).DateTime);

    /// <summary>A day's moment: the trigger's time of day (09:00 when none) in the zone.</summary>
    public static DateTimeOffset At(JsonObject trigger, string day, TimeZoneInfo zone) =>
        AutomationTimes.Due(day, 0, (string?)trigger["at"], zone)!.Value;

    private static (Recurrence.Rule Rule, string Start) Series(JsonObject trigger) =>
        (Recurrence.Read(trigger["rule"]) ?? throw new InvalidOperationException("A kept series has its rule"), (string)trigger["start"]!);

    /// <summary>The first day of the series, or the first after <paramref name="after"/>.</summary>
    private static string? After(Recurrence.Rule rule, string start, string? after) =>
        after is null ? Recurrence.Between(rule, start, start, "9999-12-31", 1).FirstOrDefault() : Recurrence.Next(rule, start, after);

    /// <summary>The first day after <paramref name="after"/> (from the start with none) whose moment is at or after <paramref name="from"/>.</summary>
    public static string? NextDay(JsonObject trigger, string? after, DateTimeOffset from, TimeZoneInfo zone)
    {
        var (rule, start) = Series(trigger);
        // A day two before the local day of `from` has its moment before it, whatever its time: begin there.
        var floor = LocalDay(from, zone).AddDays(-2);
        if (floor.Year >= 1 && (after is null || string.CompareOrdinal(Text(floor), after) > 0) && string.CompareOrdinal(Text(floor), start) >= 0) after = Text(floor);
        for (var i = 0; i < 10; i++)
        {
            var day = After(rule, start, after);
            if (day is null || At(trigger, day, zone) >= from) return day;
            after = day;
        }
        return null;
    }

    /// <summary>By its days: the latest day from <paramref name="due"/> whose moment has come (those a stopped worker missed are skipped).</summary>
    public static string Latest(JsonObject trigger, string due, DateTimeOffset now, TimeZoneInfo zone)
    {
        var (rule, start) = Series(trigger);
        var day = due;
        for (var i = 0; i < 1000; i++)
        {
            var next = Recurrence.Next(rule, start, day);
            if (next is null || At(trigger, next, zone) > now) break;
            day = next;
        }
        return day;
    }

    /// <summary>By the last done: the next day after the last made, or after yesterday in the zone when that is later; null once the series has ended.</summary>
    public static string? AfterDone(JsonObject trigger, string? lastDay, DateTimeOffset now, TimeZoneInfo zone)
    {
        var (rule, start) = Series(trigger);
        var yesterday = Text(LocalDay(now, zone).AddDays(-1));
        var bound = lastDay is not null && string.CompareOrdinal(lastDay, yesterday) > 0 ? lastDay : yesterday;
        if (string.CompareOrdinal(bound, start) < 0) return After(rule, start, null);
        return Recurrence.Next(rule, start, bound);
    }

    /// <summary>Whether a value says a row is done: a checkbox checked, or a status option in the complete group.</summary>
    public static bool IsDone(PropertyDef? def, object? value) => def?.Type switch
    {
        PropertyTypes.Checkbox => value is true,
        PropertyTypes.Status => value is string id && def.Option(id)?.Group == "complete",
        _ => false,
    };

    /// <summary>The value written into the series' date property: the day, or its moment when the property holds a time.</summary>
    public static JsonObject DateValue(JsonObject trigger, PropertyDef def, string day, TimeZoneInfo zone) => def.IncludeTime
        ? new JsonObject { ["start"] = At(trigger, day, zone).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture) }
        : new JsonObject { ["start"] = day };
}
