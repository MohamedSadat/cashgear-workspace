using System.Globalization;
using System.Text.RegularExpressions;

namespace Cgw.Core.Databases;

/// <summary>
/// Dates in database values (db/dates.ts): a value's <c>start</c> and <c>end</c> are each a calendar
/// date <c>YYYY-MM-DD</c> or a UTC instant <c>YYYY-MM-DDTHH:mm:ssZ</c>, years 1 to 9999. Calendar
/// arithmetic in whole days and milliseconds (proleptic Gregorian), as the TypeScript does it.
/// </summary>
public static partial class DbDates
{
    public const long MinuteMs = 60_000;
    public const long HourMs = 3_600_000;
    public const long DayMs = 86_400_000;

    private static long FloorDiv(long a, long b) => a / b - ((a % b != 0) && ((a < 0) != (b < 0)) ? 1 : 0);

    /// <summary>Days since 1970-01-01 (H. Hinnant's <c>days_from_civil</c>).</summary>
    public static long DaysFromCivil(long y, long m, long d)
    {
        var yy = m <= 2 ? y - 1 : y;
        var era = FloorDiv(yy, 400);
        var yoe = yy - era * 400;
        var doy = FloorDiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
        var doe = yoe * 365 + FloorDiv(yoe, 4) - FloorDiv(yoe, 100) + doy;
        return era * 146097 + doe - 719468;
    }

    public static (long Y, long M, long D) CivilFromDays(long days)
    {
        var z = days + 719468;
        var era = FloorDiv(z, 146097);
        var doe = z - era * 146097;
        var yoe = FloorDiv(doe - FloorDiv(doe, 1460) + FloorDiv(doe, 36524) - FloorDiv(doe, 146096), 365);
        var doy = doe - (365 * yoe + FloorDiv(yoe, 4) - FloorDiv(yoe, 100));
        var mp = FloorDiv(5 * doy + 2, 153);
        var d = doy - FloorDiv(153 * mp + 2, 5) + 1;
        var m = mp < 10 ? mp + 3 : mp - 9;
        return (yoe + era * 400 + (m <= 2 ? 1 : 0), m, d);
    }

    private static bool IsLeap(long y) => (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;

    public static long DaysInMonth(long y, long m) => m == 2 ? (IsLeap(y) ? 29 : 28) : m is 4 or 6 or 9 or 11 ? 30 : 31;

    private static readonly long FirstDay = DaysFromCivil(1, 1, 1);
    private static readonly long LastDay = DaysFromCivil(9999, 12, 31);
    private static bool InRange(long day) => day >= FirstDay && day <= LastDay;

    private static string Pad(long n, int width = 2) => n.ToString(CultureInfo.InvariantCulture).PadLeft(width, '0');

    public static string DayText(long day)
    {
        var (y, m, d) = CivilFromDays(day);
        return $"{Pad(y, 4)}-{Pad(m)}-{Pad(d)}";
    }

    /// <summary>The canonical instant of a millisecond time, whole seconds (floored); null out of range.</summary>
    public static string? InstantText(double ms)
    {
        if (!double.IsFinite(ms)) return null;
        var day = (long)Math.Floor(ms / DayMs);
        if (!InRange(day)) return null;
        var rest = (long)Math.Floor((ms - day * (double)DayMs) / 1000);
        var h = rest / 3600;
        var min = rest % 3600 / 60;
        return $"{DayText(day)}T{Pad(h)}:{Pad(min)}:{Pad(rest % 60)}Z";
    }

    [GeneratedRegex(@"^([0-9]{4})-([0-9]{2})-([0-9]{2})\z")]
    private static partial Regex DatePattern();

    // JavaScript's \s, not .NET's.
    private const string Space = @"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";

    [GeneratedRegex(@"^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:[.,][0-9]+)?)?" + Space + @"*(?:([Zz])|([+-])([0-9]{2})(?::?([0-9]{2}))?)?\z")]
    private static partial Regex DateTimePattern();

    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)?\z")]
    private static partial Regex PointPattern();

    /// <summary>A stored point: canonical forms only.</summary>
    public static bool IsPoint(string? s) => s is not null && PointPattern().IsMatch(s);

    private static bool ValidDay(long y, long m, long d) => y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= DaysInMonth(y, m);

    private static long N(string s) => long.Parse(s, CultureInfo.InvariantCulture);

    /// <summary>The ASCII digits of a canonical point at <paramref name="start"/>, without a substring (sorts read millions).</summary>
    private static long Digits(string s, int start, int length)
    {
        long n = 0;
        for (var i = start; i < start + length; i++) n = n * 10 + (s[i] - '0');
        return n;
    }

    /// <summary>
    /// A date or instant read from text, in canonical form, or null (db/dates.ts
    /// <c>parseDatePoint</c>): <c>YYYY-MM-DD</c>, or that then <c>T</c> or a space, <c>HH:mm</c>,
    /// optional seconds and fraction (dropped), then <c>Z</c>, an offset or nothing (UTC).
    /// </summary>
    public static string? ParsePoint(string text)
    {
        var t = DbText.Trim(text);
        var date = DatePattern().Match(t);
        if (date.Success) return ValidDay(N(date.Groups[1].Value), N(date.Groups[2].Value), N(date.Groups[3].Value)) ? t : null;
        var time = DateTimePattern().Match(t);
        if (!time.Success) return null;
        long y = N(time.Groups[1].Value), m = N(time.Groups[2].Value), d = N(time.Groups[3].Value);
        long h = N(time.Groups[4].Value), min = N(time.Groups[5].Value);
        var s = time.Groups[6].Success ? N(time.Groups[6].Value) : 0;
        if (!ValidDay(y, m, d) || h > 23 || min > 59 || s > 59) return null;
        long offset = 0;
        if (time.Groups[8].Success)
        {
            var oh = N(time.Groups[9].Value);
            var om = time.Groups[10].Success ? N(time.Groups[10].Value) : 0;
            if (oh > 23 || om > 59) return null;
            offset = (time.Groups[8].Value == "-" ? -1 : 1) * (oh * 60 + om);
        }
        return InstantText(DaysFromCivil(y, m, d) * (double)DayMs + ((h * 60 + min) * 60 + s) * 1000 - offset * MinuteMs);
    }

    public static bool IsDateOnly(string point) => point.Length == 10;

    private static long PointDay(string point) => DaysFromCivil(Digits(point, 0, 4), Digits(point, 5, 2), Digits(point, 8, 2));

    /// <summary>Milliseconds of a canonical point; a date is its midnight <paramref name="offsetMinutes"/> east of UTC.</summary>
    public static double PointMs(string point, double offsetMinutes = 0)
    {
        var day = PointDay(point) * (double)DayMs;
        if (IsDateOnly(point)) return day - offsetMinutes * MinuteMs;
        return day + Digits(point, 11, 2) * (double)HourMs + Digits(point, 14, 2) * (double)MinuteMs + Digits(point, 17, 2) * 1000.0;
    }

    /// <summary>The calendar date of a canonical point as seen <paramref name="offsetMinutes"/> east of UTC.</summary>
    public static string CalendarDate(string point, double offsetMinutes)
    {
        if (IsDateOnly(point)) return point;
        return DayText((long)Math.Floor((PointMs(point) + offsetMinutes * MinuteMs) / DayMs));
    }

    /// <summary>A date value read from text: a point, or <c>start → end</c>.</summary>
    public static DateValue? ParseDateText(string text)
    {
        var parts = text.Split('→');
        if (parts.Length > 2) return null;
        var start = ParsePoint(parts[0]);
        if (start is null) return null;
        if (parts.Length == 1) return new DateValue(start);
        var end = ParsePoint(parts[1]);
        return end is null ? null : new DateValue(start, end);
    }

    public static string DateText(DateValue value) => string.IsNullOrEmpty(value.End) ? value.Start : $"{value.Start} → {value.End}";

    /// <summary>
    /// A date value in canonical form from any shape (db/dates.ts <c>coerceDate</c>): text as
    /// <see cref="ParseDateText"/> reads it, or an object with a start (and an end) each a point.
    /// </summary>
    public static DateValue? Coerce(object? raw)
    {
        if (raw is string s) return ParseDateText(s);
        if (!Raw.IsObject(raw) || Raw.Field(raw, "start") is not string startText) return null;
        var start = ParsePoint(startText);
        if (start is null) return null;
        var end = Raw.Field(raw, "end");
        if (end is null || end is "") return new DateValue(start);
        if (end is not string endText) return null;
        var endPoint = ParsePoint(endText);
        return endPoint is null ? null : new DateValue(start, endPoint);
    }

    public static string? AddDays(string point, double days)
    {
        if (!IsDateOnly(point)) return InstantText(PointMs(point) + days * DayMs);
        var day = PointDay(point) + (long)days;
        return InRange(day) ? DayText(day) : null;
    }

    /// <summary>Calendar months added, the day clamped to the month's last.</summary>
    public static string? AddMonths(string point, double months)
    {
        var total = N(point[..4]) * 12 + N(point[5..7]) - 1 + months;
        var y = (long)Math.Floor(total / 12);
        var m = (long)(total - y * 12) + 1;
        if (y < 1 || y > 9999) return null;
        var d = Math.Min(N(point[8..10]), DaysInMonth(y, m));
        var date = $"{Pad(y, 4)}-{Pad(m)}-{Pad(d)}";
        return IsDateOnly(point) ? date : date + point[10..];
    }

    public static string? AddMs(string point, double ms) => InstantText(PointMs(point) + ms);

    /// <summary>1 Monday to 7 Sunday, of a day number.</summary>
    public static long WeekdayOfDay(long day) => ((day + 3) % 7 + 7) % 7 + 1;

    public static long DateDay(string date) => PointDay(date);

    /// <summary>A relative date from the asker's today; null when today is not a date.</summary>
    public static string? Relative(string today, string relative)
    {
        if (!DatePattern().IsMatch(today) || ParsePoint(today) is null) return null;
        return relative switch
        {
            "today" => today,
            "tomorrow" => AddDays(today, 1),
            "yesterday" => AddDays(today, -1),
            "oneWeekAgo" => AddDays(today, -7),
            "oneWeekFromNow" => AddDays(today, 7),
            "oneMonthAgo" => AddMonths(today, -1),
            "oneMonthFromNow" => AddMonths(today, 1),
            _ => null,
        };
    }

    /// <summary>A date cut to its day, week (the Monday), month or year (the first day).</summary>
    public static string Truncate(string date, string by)
    {
        switch (by)
        {
            case "week":
            {
                var day = DateDay(date);
                return DayText(day - (WeekdayOfDay(day) - 1));
            }
            case "month": return date[..7] + "-01";
            case "year": return date[..4] + "-01-01";
            default: return date;
        }
    }

    public static bool IsDay(string? s) => s is not null && DatePattern().IsMatch(s) && ParsePoint(s) is not null;
}
