using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cgw.Core.Automations;

/// <summary>
/// Phase 17, M17.2: the days a repeating row falls on (packages/workspace/src/db/recurrence.ts,
/// held to it by packages/workspace/vectors/db-recurrence-vectors.json), from the series' first day,
/// by a rule of the shape the recurrence fields edit. Days only: the runner turns a day into its
/// instant at the trigger's time of day in the workspace's zone (<see cref="AutomationTimes.Due"/>).
/// </summary>
public static class Recurrence
{
    public static readonly string[] Weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    private static readonly string[] Weeks = ["none", "first", "second", "third", "fourth", "last"];
    private const int Periods = 100_000;

    public sealed record Rule(string Frequency, int Interval, int[]? WeekDays, int? DayOfMonth, int? Month, string WeekOfMonth, string Range, int? OccurrenceCount, string? EndDate);

    private static string? Str(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

    private static bool Whole(JsonNode? n, int min, int max, out int value)
    {
        value = 0;
        if (n is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return false;
        // A value made in code holds its own type (JsonValue.Create(1) is no double): read it as each.
        double d;
        if (v.TryGetValue<double>(out var real)) d = real;
        else if (v.TryGetValue<int>(out var small)) d = small;
        else if (v.TryGetValue<long>(out var large)) d = large;
        else return false;
        if (d != Math.Floor(d) || d < min || d > max) return false;
        value = (int)d;
        return true;
    }

    /// <summary>A <c>YYYY-MM-DD</c> day that exists.</summary>
    public static bool IsDay(string? text) =>
        text is { Length: 10 } && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    /// <summary>db/recurrence.ts <c>readRecurrence</c>: the rule, or null when it is not one.</summary>
    public static Rule? Read(JsonNode? value)
    {
        if (value is not JsonObject o) return null;
        var frequency = Str(o["frequency"]);
        if (frequency is not ("daily" or "weekly" or "monthly" or "yearly")) return null;
        var interval = 1;
        if (o.ContainsKey("interval") && !Whole(o["interval"], 1, 999, out interval)) return null;
        int[]? weekDays = null;
        if (o.ContainsKey("weekDays"))
        {
            if (o["weekDays"] is not JsonArray list) return null;
            var names = new List<string>();
            foreach (var d in list)
                if (Str(d) is { } name && Weekdays.Contains(name)) names.Add(name);
                else return null;
            weekDays = [.. Enumerable.Range(0, 7).Where(i => names.Contains(Weekdays[i]))];
        }
        int? dayOfMonth = null, month = null;
        if (o.ContainsKey("dayOfMonth"))
        {
            if (!Whole(o["dayOfMonth"], 1, 31, out var day)) return null;
            dayOfMonth = day;
        }
        if (o.ContainsKey("month"))
        {
            if (!Whole(o["month"], 1, 12, out var m)) return null;
            month = m;
        }
        var week = "none";
        if (o.ContainsKey("weekOfMonth") && (Str(o["weekOfMonth"]) is not { } w || !Weeks.Contains(w))) return null;
        if (o.ContainsKey("weekOfMonth")) week = Str(o["weekOfMonth"])!;
        var range = "noEndDate";
        if (o.ContainsKey("range"))
        {
            range = Str(o["range"]) ?? "";
            if (range is not ("noEndDate" or "occurrenceCount" or "endByDate")) return null;
        }
        int? count = null;
        string? end = null;
        if (range == "occurrenceCount")
        {
            if (!Whole(o["occurrenceCount"], 1, 10_000, out var c)) return null;
            count = c;
        }
        if (range == "endByDate")
        {
            end = Str(o["endDate"]);
            if (!IsDay(end)) return null;
        }
        return new Rule(frequency, interval, weekDays is { Length: > 0 } ? weekDays : null, dayOfMonth, month, week, range, count, end);
    }

    /// <summary>The rule as a rule keeps it (readRecurrence's output): the fields given, checked, the weekdays in order once each.</summary>
    public static JsonObject? Kept(JsonNode? value)
    {
        if (Read(value) is not { } rule) return null;
        var given = (JsonObject)value!;
        var kept = new JsonObject { ["frequency"] = rule.Frequency };
        if (given.ContainsKey("interval")) kept["interval"] = rule.Interval;
        if (given.ContainsKey("weekDays")) kept["weekDays"] = new JsonArray([.. (rule.WeekDays ?? []).Select(i => (JsonNode)JsonValue.Create(Weekdays[i]))]);
        if (rule.DayOfMonth is { } day) kept["dayOfMonth"] = day;
        if (rule.Month is { } month) kept["month"] = month;
        if (given.ContainsKey("weekOfMonth")) kept["weekOfMonth"] = rule.WeekOfMonth;
        if (given.ContainsKey("range")) kept["range"] = rule.Range;
        if (rule.OccurrenceCount is { } count) kept["occurrenceCount"] = count;
        if (rule.EndDate is { } end) kept["endDate"] = end;
        return kept;
    }

    private static DateOnly Day(string text) => DateOnly.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);
    private static string Text(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    private static int Weekday(DateOnly day) => (int)day.DayOfWeek;

    private static List<DateOnly> MonthDays(int year, int month, DateOnly first, Rule rule)
    {
        var start = new DateOnly(year, month, 1);
        var last = DateTime.DaysInMonth(year, month);
        if (rule.WeekOfMonth == "none") return [start.AddDays(Math.Min(rule.DayOfMonth ?? first.Day, last) - 1)];
        var days = rule.WeekDays ?? [Weekday(first)];
        var lastDay = start.AddDays(last - 1);
        var list = days.Select(day => rule.WeekOfMonth == "last"
            ? lastDay.AddDays(-((Weekday(lastDay) - day + 7) % 7))
            : start.AddDays((day - Weekday(start) + 7) % 7 + Array.IndexOf(Weeks, rule.WeekOfMonth) * 7 - 7)).ToList();
        list.Sort();
        return list;
    }

    /// <summary>The days the rule falls on from <paramref name="first"/>, in order.</summary>
    private static IEnumerable<DateOnly> Days(Rule rule, DateOnly first)
    {
        var own = Weekday(first);
        var weekDays = rule.WeekDays ?? [own];
        var count = 0;
        for (var period = 0; period < Periods; period++)
        {
            List<DateOnly> candidates;
            if (rule.Frequency == "daily")
            {
                var offset = (long)period * rule.Interval;
                if (first.DayNumber + offset > DateOnly.MaxValue.DayNumber) yield break;
                var day = first.AddDays((int)offset);
                candidates = rule.WeekDays is null || weekDays.Contains(Weekday(day)) ? [day] : [];
            }
            else if (rule.Frequency == "weekly")
            {
                candidates = [];
                foreach (var d in weekDays.Order())
                {
                    var offset = -own + (long)period * rule.Interval * 7 + d;
                    if (first.DayNumber + offset > DateOnly.MaxValue.DayNumber) yield break;
                    // The week before 1 January of the year 1 has no days (TypeScript's are before the first and skipped).
                    if (first.DayNumber + offset < 0) continue;
                    candidates.Add(first.AddDays((int)offset));
                }
            }
            else
            {
                var index = first.Year * 12L + first.Month - 1 + (rule.Frequency == "monthly" ? (long)period * rule.Interval : (long)period * rule.Interval * 12);
                var year = index / 12;
                if (year > 9999) yield break;
                var month = rule.Frequency == "yearly" ? rule.Month ?? first.Month : (int)(index % 12) + 1;
                candidates = MonthDays((int)year, month, first, rule);
            }
            foreach (var day in candidates)
            {
                if (day < first) continue;
                if (rule.Range == "endByDate" && string.CompareOrdinal(Text(day), rule.EndDate) > 0) yield break;
                if (rule.Range == "occurrenceCount" && count >= rule.OccurrenceCount) yield break;
                count++;
                yield return day;
            }
        }
    }

    /// <summary>The first day after <paramref name="after"/> (exclusive), or null when the series has ended.</summary>
    public static string? Next(Rule rule, string first, string after)
    {
        var bound = Day(after);
        foreach (var day in Days(rule, Day(first)))
            if (day > bound) return Text(day);
        return null;
    }

    /// <summary>The days from <paramref name="from"/> to <paramref name="to"/>, both inclusive, at most <paramref name="limit"/>.</summary>
    public static List<string> Between(Rule rule, string first, string from, string to, int limit = 1000)
    {
        var low = Day(from);
        var high = Day(to);
        var list = new List<string>();
        foreach (var day in Days(rule, Day(first)))
        {
            if (day > high || list.Count >= limit) break;
            if (day >= low) list.Add(Text(day));
        }
        return list;
    }
}
