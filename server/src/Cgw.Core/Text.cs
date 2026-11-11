using System.Globalization;
using System.Text;

namespace Cgw.Core;

/// <summary>
/// Order keys: the C# side of the in-house fractional index (D19), answering exactly as
/// <c>packages/workspace/src/order.ts</c> does; both are checked against
/// <c>packages/workspace/vectors/order-vectors.json</c>. Keys are base-62 ASCII and compare
/// ordinally (the database column is binary-collated).
/// </summary>
public static class OrderKeys
{
    public const string Digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    private const string Zero = "a0";
    private static readonly string Smallest = "A" + new string('0', 26);

    private static int Digit(char c)
    {
        var value = Digits.IndexOf(c);
        if (value < 0) throw new ArgumentException($"Not an order-key digit: {c}");
        return value;
    }

    private static string Midpoint(string a, string? b)
    {
        if (b is not null && string.CompareOrdinal(a, b) >= 0) throw new ArgumentException($"{a} >= {b}");
        if (a.EndsWith('0') || (b is not null && b.EndsWith('0'))) throw new ArgumentException("Trailing zero");
        if (b is not null)
        {
            var n = 0;
            while ((n < a.Length ? a[n] : '0') == (n < b.Length ? b[n] : '\0')) n++;
            if (n > 0) return b[..n] + Midpoint(a.Length > n ? a[n..] : "", b[n..]);
        }
        var low = a.Length > 0 ? Digit(a[0]) : 0;
        var high = b is not null ? Digit(b[0]) : Digits.Length;
        if (high - low > 1) return Digits[(int)Math.Round((low + high) / 2.0, MidpointRounding.AwayFromZero)].ToString();
        if (b is not null && b.Length > 1) return b[..1];
        return Digits[low] + Midpoint(a.Length > 1 ? a[1..] : "", null);
    }

    private static int IntegerLength(char head) => head switch
    {
        >= 'a' and <= 'z' => head - 'a' + 2,
        >= 'A' and <= 'Z' => 'Z' - head + 2,
        _ => throw new ArgumentException($"Not an order-key head: {head}"),
    };

    private static string IntegerPart(string key)
    {
        var length = IntegerLength(key[0]);
        if (length > key.Length) throw new ArgumentException($"Order key too short: {key}");
        return key[..length];
    }

    public static bool IsValid(string? key)
    {
        if (string.IsNullOrEmpty(key) || key.Length > 200 || key == Smallest) return false;
        try
        {
            var integer = IntegerPart(key);
            foreach (var c in key) Digit(c);
            return !key[integer.Length..].EndsWith('0');
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static string? Increment(string integer)
    {
        var head = integer[0];
        var digits = integer[1..].ToCharArray().ToList();
        var carry = true;
        for (var i = digits.Count - 1; carry && i >= 0; i--)
        {
            var next = Digit(digits[i]) + 1;
            if (next == Digits.Length) digits[i] = '0';
            else
            {
                digits[i] = Digits[next];
                carry = false;
            }
        }
        if (!carry) return head + new string([.. digits]);
        if (head == 'Z') return Zero;
        if (head == 'z') return null;
        var nextHead = (char)(head + 1);
        if (nextHead > 'a') digits.Add('0');
        else digits.RemoveAt(digits.Count - 1);
        return nextHead + new string([.. digits]);
    }

    private static string? Decrement(string integer)
    {
        var head = integer[0];
        var digits = integer[1..].ToCharArray().ToList();
        var borrow = true;
        for (var i = digits.Count - 1; borrow && i >= 0; i--)
        {
            var next = Digit(digits[i]) - 1;
            if (next == -1) digits[i] = Digits[^1];
            else
            {
                digits[i] = Digits[next];
                borrow = false;
            }
        }
        if (!borrow) return head + new string([.. digits]);
        if (head == 'a') return "Z" + Digits[^1];
        if (head == 'A') return null;
        var nextHead = (char)(head - 1);
        if (nextHead < 'Z') digits.Add(Digits[^1]);
        else digits.RemoveAt(digits.Count - 1);
        return nextHead + new string([.. digits]);
    }

    /// <summary>A key strictly between a and b; null is the start or the end of the list.</summary>
    public static string Between(string? a, string? b)
    {
        if (a is not null && !IsValid(a)) throw new ArgumentException($"Not an order key: {a}");
        if (b is not null && !IsValid(b)) throw new ArgumentException($"Not an order key: {b}");
        if (a is not null && b is not null && string.CompareOrdinal(a, b) >= 0) throw new ArgumentException($"{a} >= {b}");
        if (a is null)
        {
            if (b is null) return Zero;
            var ib = IntegerPart(b);
            var fb = b[ib.Length..];
            if (ib == Smallest) return ib + Midpoint("", fb);
            if (string.CompareOrdinal(ib, b) < 0) return ib;
            var lower = Decrement(ib) ?? throw new ArgumentException("No key before the smallest");
            return lower == Smallest ? lower + Midpoint("", null) : lower;
        }
        if (b is null)
        {
            var ia = IntegerPart(a);
            var higher = Increment(ia);
            return higher ?? ia + Midpoint(a[ia.Length..], null);
        }
        {
            var ia = IntegerPart(a);
            var fa = a[ia.Length..];
            var ib = IntegerPart(b);
            var fb = b[ib.Length..];
            if (ia == ib) return ia + Midpoint(fa, fb);
            var higher = Increment(ia) ?? throw new ArgumentException("No key after the largest");
            if (string.CompareOrdinal(higher, b) < 0) return higher;
            return ia + Midpoint(fa, null);
        }
    }
}

/// <summary>
/// Text normalised for search (D25), exactly as <c>normaliseText</c> in
/// <c>packages/workspace/src/search.ts</c>; both are checked against
/// <c>packages/workspace/vectors/search-vectors.json</c>. Works on code points, as the
/// JavaScript does with its <c>u</c> flag.
/// </summary>
public static class TextNormaliser
{
    public static string Normalise(string text)
    {
        var decomposed = text.Normalize(NormalizationForm.FormKD);
        var builder = new StringBuilder(decomposed.Length);
        var pendingSpace = false;
        foreach (var rune in decomposed.EnumerateRunes())
        {
            var category = Rune.GetUnicodeCategory(rune);
            if (category is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark)
                continue;
            var value = rune.Value switch
            {
                0x0640 => -1, // tatweel
                0x0671 => 0x0627, // alef wasla to alef
                0x0649 or 0x06CC => 0x064A, // alef maqsura and Persian ya to ya
                0x0629 => 0x0647, // ta marbuta to ha
                >= 0x0660 and <= 0x0669 or >= 0x06F0 and <= 0x06F9 => '0' + (rune.Value & 0xf) % 10,
                _ => rune.Value,
            };
            if (value < 0) continue;
            var lowered = Rune.ToLowerInvariant(new Rune(value));
            if (Rune.IsLetter(lowered) || Rune.IsNumber(lowered))
            {
                if (pendingSpace && builder.Length > 0) builder.Append(' ');
                pendingSpace = false;
                builder.Append(lowered.ToString());
            }
            else
            {
                pendingSpace = true;
            }
        }
        return builder.ToString();
    }

    public static string[] Terms(string normalised) => normalised.Split(' ', StringSplitOptions.RemoveEmptyEntries);
}
