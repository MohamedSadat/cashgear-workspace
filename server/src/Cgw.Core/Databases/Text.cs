using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Cgw.Core.Databases;

/// <summary>
/// Canonical text forms of database values (db/text.ts): numbers as JavaScript's <c>String(n)</c>
/// writes them (<see cref="JsNumber"/>), JavaScript's <c>trim</c>, numbers and checkbox words read
/// from text, and comma-separated names.
/// </summary>
public static partial class DbText
{
    /// <summary>JavaScript's white space and line terminators (<c>trim</c>, <c>\s</c>).</summary>
    public static bool IsJsSpace(char c) => c switch
    {
        '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680' or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff' => true,
        >= '\u2000' and <= '\u200a' => true,
        _ => false,
    };

    /// <summary>JavaScript's <c>trim</c> (C#'s <c>Trim()</c> also takes U+0085 and keeps U+FEFF).</summary>
    public static string Trim(string text)
    {
        int start = 0, end = text.Length;
        while (start < end && IsJsSpace(text[start])) start++;
        while (end > start && IsJsSpace(text[end - 1])) end--;
        return start == 0 && end == text.Length ? text : text[start..end];
    }

    /// <summary>Arabic-Indic and Persian digits as 0-9.</summary>
    public static string AsciiDigits(string text)
    {
        if (!text.Any(c => c is >= '٠' and <= '٩' or >= '۰' and <= '۹')) return text;
        var sb = new StringBuilder(text.Length);
        foreach (var c in text)
            sb.Append(c is >= '٠' and <= '٩' or >= '۰' and <= '۹' ? (char)('0' + (c & 0xf) % 10) : c);
        return sb.ToString();
    }

    [GeneratedRegex(@"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z")]
    private static partial Regex NumberPattern();

    [GeneratedRegex(@"^[+-]?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]*)?\z")]
    private static partial Regex GroupedPattern();

    /// <summary>
    /// A number read from text (db/text.ts <c>parseNumberText</c>): trimmed; Arabic-Indic and
    /// Persian digits, <c>٫</c> and <c>٬</c> read; commas between groups of three dropped; then a
    /// decimal with an optional sign and exponent. Not finite is null; -0 is 0.
    /// </summary>
    public static double? ParseNumber(string text)
    {
        var t = AsciiDigits(Trim(text)).Replace('٫', '.').Replace('٬', ',');
        if (GroupedPattern().IsMatch(t)) t = t.Replace(",", "", StringComparison.Ordinal);
        if (!NumberPattern().IsMatch(t)) return null;
        if (!double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) || !double.IsFinite(n)) return null;
        return n == 0 ? 0 : n;
    }

    private static readonly HashSet<string> TrueWords = new(StringComparer.Ordinal) { "true", "yes", "y", "1", "on", "checked", "x", "✓", "✔", "نعم" };
    private static readonly HashSet<string> FalseWords = new(StringComparer.Ordinal) { "false", "no", "n", "0", "off", "unchecked", "لا" };

    /// <summary>A checkbox read from text (trimmed, digits as 0-9, lower case); null for any other word.</summary>
    public static bool? ParseBoolean(string text)
    {
        var t = AsciiDigits(Trim(text)).ToLowerInvariant();
        if (TrueWords.Contains(t)) return true;
        if (FalseWords.Contains(t)) return false;
        return null;
    }

    /// <summary>Comma-separated names: each trimmed, empty ones dropped, the first of each kept.</summary>
    public static List<string> SplitNames(string text)
    {
        var names = new List<string>();
        foreach (var part in text.Split(','))
        {
            var name = Trim(part);
            if (name.Length > 0 && !names.Contains(name, StringComparer.Ordinal)) names.Add(name);
        }
        return names;
    }

    /// <summary>JavaScript's <c>toLowerCase</c> and <c>toUpperCase</c>: the default Unicode mappings.</summary>
    public static string Lower(string text) => text.ToLowerInvariant();

    public static string Upper(string text) => text.ToUpperInvariant();
}
