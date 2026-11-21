using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Cgw.LocalModel;

/// <summary>
/// voyage-4-nano's tokenizer (Phase 13, M13.4; the spike, decisions 2026-11-21): Qwen2's byte-level BPE
/// from its <c>vocab.json</c> and <c>merges.txt</c>: the text in NFC, split as Qwen2's pre-tokeniser
/// splits it (<see cref="QwenSplit"/>), each piece's UTF-8 bytes as GPT-2's printable characters, then
/// merged by rank. No beginning or end token is added (the model's own tokenizer adds none), and its
/// special tokens are never matched in text: a page holding "&lt;|endoftext|&gt;" is that text. Held to
/// Hugging Face's own ids by 20,000 cases in the spike (English, Arabic, emoji, CJK, supplementary
/// letters, odd spaces, contractions in any case).
/// </summary>
public sealed class QwenTokenizer
{
    private readonly Dictionary<string, int> vocab;
    private readonly Dictionary<(string, string), int> ranks;
    private readonly char[] byteChar = new char[256];
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, int[]> cache = new(StringComparer.Ordinal);

    private QwenTokenizer(Dictionary<string, int> vocab, Dictionary<(string, string), int> ranks)
    {
        this.vocab = vocab;
        this.ranks = ranks;
        var n = 0;
        for (var b = 0; b < 256; b++)
        {
            var printable = b is >= 33 and <= 126 or >= 161 and <= 172 or >= 174 and <= 255;
            byteChar[b] = printable ? (char)b : (char)(256 + n++);
        }
    }

    public static QwenTokenizer Load(string vocabPath, string mergesPath)
    {
        var vocab = JsonSerializer.Deserialize<Dictionary<string, int>>(File.ReadAllText(vocabPath, Encoding.UTF8))
            ?? throw new InvalidDataException("vocab.json holds no vocabulary");
        var ranks = new Dictionary<(string, string), int>();
        var rank = 0;
        foreach (var line in File.ReadLines(mergesPath, Encoding.UTF8))
        {
            if (line.Length == 0 || line.StartsWith("#version", StringComparison.Ordinal)) continue;
            var space = line.IndexOf(' ');
            if (space <= 0) throw new InvalidDataException("merges.txt holds a line that is not a pair");
            ranks[(line[..space], line[(space + 1)..])] = rank++;
        }
        return new QwenTokenizer(vocab, ranks);
    }

    /// <summary>The text's token ids, at most <paramref name="max"/> (the rest cut).</summary>
    public List<int> Encode(string text, int max = int.MaxValue)
    {
        var ids = new List<int>();
        foreach (var piece in QwenSplit.Pieces(text.Normalize(NormalizationForm.FormC)))
        {
            var bytes = Encoding.UTF8.GetBytes(piece);
            var mapped = new string(bytes.Select(b => byteChar[b]).ToArray());
            if (!cache.TryGetValue(mapped, out var word))
            {
                word = Merge(mapped);
                if (cache.Count < 200_000) cache[mapped] = word;
            }
            foreach (var id in word)
            {
                if (ids.Count >= max) return ids;
                ids.Add(id);
            }
        }
        return ids;
    }

    private int[] Merge(string word)
    {
        if (vocab.TryGetValue(word, out var whole)) return [whole];
        var parts = word.Select(c => c.ToString()).ToList();
        while (parts.Count > 1)
        {
            var best = int.MaxValue;
            var at = -1;
            for (var i = 0; i < parts.Count - 1; i++)
                if (ranks.TryGetValue((parts[i], parts[i + 1]), out var r) && r < best)
                {
                    best = r;
                    at = i;
                }
            if (at < 0) break;
            var (left, right) = (parts[at], parts[at + 1]);
            var merged = new List<string>(parts.Count);
            for (var i = 0; i < parts.Count; i++)
            {
                if (i < parts.Count - 1 && parts[i] == left && parts[i + 1] == right)
                {
                    merged.Add(left + right);
                    i++;
                }
                else merged.Add(parts[i]);
            }
            parts = merged;
        }
        // A part the vocabulary lacks (never, for a byte-level vocabulary): each of its characters.
        return parts.SelectMany(p => vocab.TryGetValue(p, out var id) ? [id] : p.Select(c => vocab.GetValueOrDefault(c.ToString()))).ToArray();
    }
}

/// <summary>
/// Qwen2's pre-tokeniser split, over code points (as Hugging Face's Rust regex reads it), written out
/// rather than as a .NET regex, which reads <c>\p{L}</c> one UTF-16 unit at a time:
/// <c>(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+</c>,
/// the first alternative that matches at a position winning, as a backtracking regex decides.
/// </summary>
public static class QwenSplit
{
    public static IEnumerable<string> Pieces(string text)
    {
        var runes = new List<Rune>(text.Length);
        foreach (var r in text.EnumerateRunes()) runes.Add(r);
        var at = 0;
        var piece = new StringBuilder();
        while (at < runes.Count)
        {
            var length = Match(runes, at);
            piece.Clear();
            for (var i = at; i < at + length; i++) piece.Append(runes[i].ToString());
            yield return piece.ToString();
            at += length;
        }
    }

    private static bool Letter(Rune r) => Rune.GetUnicodeCategory(r) is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter
        or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter;

    private static bool Number(Rune r) => Rune.GetUnicodeCategory(r) is UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber;

    /// <summary>Unicode's White_Space, as Rust's <c>\s</c>.</summary>
    private static bool Space(Rune r) => r.Value is >= 0x09 and <= 0x0D or 0x20 or 0x85 or 0xA0 or 0x1680 or >= 0x2000 and <= 0x200A
        or 0x2028 or 0x2029 or 0x202F or 0x205F or 0x3000;

    private static bool Newline(Rune r) => r.Value is '\r' or '\n';

    private static bool Other(Rune r) => !Space(r) && !Letter(r) && !Number(r);

    /// <summary>The length (in runes) of the match at <paramref name="at"/>; always at least one.</summary>
    private static int Match(List<Rune> s, int at)
    {
        var n = s.Count;
        // 1. Contractions, any case (Unicode's simple folding: the long s is an s too).
        if (s[at].Value == '\'' && at + 1 < n)
        {
            static char Low(Rune r) => r.Value < 128 ? char.ToLowerInvariant((char)r.Value) : r.Value == 0x17F ? 's' : '\0';
            var a = Low(s[at + 1]);
            if (a is 's' or 't' or 'm' or 'd') return 2;
            if (at + 2 < n)
            {
                var b = Low(s[at + 2]);
                if ((a, b) is ('r', 'e') or ('v', 'e') or ('l', 'l')) return 3;
            }
        }
        // 2. One optional character that is not a line end, letter or number, then letters.
        {
            var start = at;
            if (!Newline(s[at]) && !Letter(s[at]) && !Number(s[at]) && at + 1 < n && Letter(s[at + 1])) start = at + 1;
            if (Letter(s[start]))
            {
                var end = start;
                while (end < n && Letter(s[end])) end++;
                return end - at;
            }
        }
        // 3. One number.
        if (Number(s[at])) return 1;
        // 4. An optional space, then other characters, then line ends.
        {
            var start = s[at].Value == ' ' && at + 1 < n && Other(s[at + 1]) ? at + 1 : at;
            if (Other(s[start]))
            {
                var end = start;
                while (end < n && Other(s[end])) end++;
                while (end < n && Newline(s[end])) end++;
                return end - at;
            }
        }
        // 5 to 7: white space.
        var run = at;
        while (run < n && Space(s[run])) run++;
        var length = run - at;
        // 5. White space up to its last line end.
        for (var i = run - 1; i >= at; i--)
            if (Newline(s[i])) return i + 1 - at;
        // 6. White space not followed by a non-space: the whole run at the end, else all but its last.
        if (run == n) return length;
        if (length >= 2) return length - 1;
        // 7. White space.
        return length;
    }
}
