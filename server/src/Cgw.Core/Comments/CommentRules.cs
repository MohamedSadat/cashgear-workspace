using System.Buffers;
using System.Text;
using System.Text.Json;

namespace Cgw.Core.Comments;

/// <summary>A comment's body as checked: the JSON written back, who and what it mentions, its plain text.</summary>
public sealed record CommentBodyParsed(string Json, IReadOnlyList<Guid> UserMentions, IReadOnlyList<Guid> PageMentions, string Text);

/// <summary>A thread's anchor as checked: the two relative positions' bytes, or none for the whole block.</summary>
public sealed record CommentAnchorParsed(byte[]? Start, byte[]? End);

/// <summary>
/// The rules a comment's body and a thread's anchor must pass (Phase 6 contracts, section 3), or
/// <c>comment.invalid</c>. A body is the document's inline nodes, a strict subset, as ProseMirror
/// JSON: text without marks or line breaks, hard breaks, and mentions of people and pages, these
/// keys only. The server never decodes a relative position: it only checks it is base64 of at most
/// 256 bytes.
/// </summary>
public static class CommentRules
{
    public const int MaxTextLength = 4000;
    public const int MaxMentions = 50;
    /// <summary>Nodes in one body: its text, mentions and breaks, with room to spare.</summary>
    public const int MaxNodes = 1000;
    public const int MaxQuoteLength = 1000;
    public const int MaxAnchorBytes = 256;
    public const int ExcerptLength = 200;

    public static Failure Invalid(string why) => new(Codes.CommentInvalid, 400, why);

    public static Result<CommentBodyParsed> Body(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Array) return Invalid("The body is a list of inline nodes");
        var count = body.GetArrayLength();
        if (count is 0 or > MaxNodes) return Invalid($"The body holds 1 to {MaxNodes} nodes");
        var users = new List<Guid>();
        var pages = new List<Guid>();
        var text = new StringBuilder();
        var length = 0;
        var content = false;
        var output = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartArray();
            foreach (var node in body.EnumerateArray())
            {
                if (node.ValueKind != JsonValueKind.Object || !node.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String)
                    return Invalid("Every node is an object with a type");
                switch (type.GetString())
                {
                    case "text":
                    {
                        if (!OnlyKeys(node, "type", "text") || !node.TryGetProperty("text", out var value) || value.ValueKind != JsonValueKind.String)
                            return Invalid("A text node holds its text and nothing else (no marks)");
                        var s = value.GetString()!;
                        if (s.Length == 0) return Invalid("A text node is never empty");
                        if (Bad(s, allowNewLines: false)) return Invalid("A text node holds no line breaks or control characters (use a hard break)");
                        length += s.Length;
                        if (length > MaxTextLength) return Invalid($"A comment holds at most {MaxTextLength} characters of text");
                        content = true;
                        text.Append(s);
                        writer.WriteStartObject();
                        writer.WriteString("type", "text");
                        writer.WriteString("text", s);
                        writer.WriteEndObject();
                        break;
                    }
                    case "hardBreak":
                        if (!OnlyKeys(node, "type")) return Invalid("A hard break holds nothing");
                        text.Append(' ');
                        writer.WriteStartObject();
                        writer.WriteString("type", "hardBreak");
                        writer.WriteEndObject();
                        break;
                    case "userMention":
                    case "pageMention":
                    {
                        var mention = type.GetString()!;
                        var key = mention == "userMention" ? "userId" : "pageId";
                        if (!OnlyKeys(node, "type", "attrs") || !node.TryGetProperty("attrs", out var attrs) || attrs.ValueKind != JsonValueKind.Object
                            || !OnlyKeys(attrs, key) || !attrs.TryGetProperty(key, out var id) || id.ValueKind != JsonValueKind.String
                            || !Guid.TryParse(id.GetString(), out var guid) || guid == Guid.Empty)
                            return Invalid($"A {mention} holds attrs.{key}, an id, and nothing else");
                        if (users.Count + pages.Count >= MaxMentions) return Invalid($"A comment holds at most {MaxMentions} mentions");
                        (mention == "userMention" ? users : pages).Add(guid);
                        content = true;
                        // As the server's derived text writes a mention: "@" only (names change, and a
                        // page's title is not everyone's to see).
                        text.Append('@');
                        writer.WriteStartObject();
                        writer.WriteString("type", mention);
                        writer.WriteStartObject("attrs");
                        writer.WriteString(key, guid.ToString());
                        writer.WriteEndObject();
                        writer.WriteEndObject();
                        break;
                    }
                    default:
                        return Invalid($"A comment holds text, hard breaks and mentions, not {type.GetString()}");
                }
            }
            writer.WriteEndArray();
        }
        // Not empty: a character of text or a mention (a comment of one @mention is one).
        if (!content) return Invalid("A comment holds text or a mention");
        return new CommentBodyParsed(Encoding.UTF8.GetString(output.WrittenSpan), users.Distinct().ToList(), pages.Distinct().ToList(), text.ToString());
    }

    /// <summary><c>{ start, end }</c>: both null (the whole block) or both base64 of at most 256 bytes.</summary>
    public static Result<CommentAnchorParsed> Anchor(JsonElement anchor)
    {
        if (anchor.ValueKind != JsonValueKind.Object || !OnlyKeys(anchor, "start", "end")
            || !anchor.TryGetProperty("start", out var start) || !anchor.TryGetProperty("end", out var end))
            return Invalid("The anchor is { start, end }");
        if (start.ValueKind == JsonValueKind.Null && end.ValueKind == JsonValueKind.Null) return new CommentAnchorParsed(null, null);
        if (Position(start) is not { } a || Position(end) is not { } b)
            return Invalid($"The anchor's ends are both null, or both base64 of 1 to {MaxAnchorBytes} bytes");
        return new CommentAnchorParsed(a, b);
    }

    private static byte[]? Position(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String) return null;
        var s = value.GetString()!;
        if (s.Length is 0 or > (MaxAnchorBytes + 2) / 3 * 4) return null;
        var bytes = new byte[MaxAnchorBytes];
        return Convert.TryFromBase64String(s, bytes, out var written) && written > 0 ? bytes[..written] : null;
    }

    /// <summary>A block id: 12 characters of base 62 (the block-id plugin's).</summary>
    public static bool BlockId(string? id) => id is { Length: 12 } && id.All(char.IsAsciiLetterOrDigit);

    public static Result<string> Quote(string? quote)
    {
        quote ??= "";
        if (quote.Length > MaxQuoteLength) return Invalid($"The quote is at most {MaxQuoteLength} characters");
        if (Bad(quote, allowNewLines: true)) return Invalid("The quote holds no control characters");
        return quote;
    }

    /// <summary>A client-made id: a UUIDv7.</summary>
    public static bool ClientId(Guid id) => id != Guid.Empty && id.Version == 7;

    /// <summary>Plain text cut to the excerpt's length, never inside a surrogate pair.</summary>
    public static string Excerpt(string text)
    {
        var clean = string.Join(' ', text.Split([' ', '\n', '\t', '\r'], StringSplitOptions.RemoveEmptyEntries));
        if (clean.Length <= ExcerptLength) return clean;
        var cut = ExcerptLength;
        if (char.IsHighSurrogate(clean[cut - 1])) cut--;
        return clean[..cut];
    }

    private static bool OnlyKeys(JsonElement node, params string[] keys)
    {
        var seen = 0;
        foreach (var property in node.EnumerateObject())
        {
            if (!keys.Contains(property.Name)) return false;
            seen++;
        }
        return seen <= keys.Length;
    }

    /// <summary>Control characters, unpaired surrogates and, unless allowed, line breaks.</summary>
    private static bool Bad(string s, bool allowNewLines)
    {
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c == '\t') continue;
            if (c == '\n' && allowNewLines) continue;
            if (char.IsControl(c) || c is '\u2028' or '\u2029') return true;
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return true;
                i++;
            }
            else if (char.IsLowSurrogate(c)) return true;
        }
        return false;
    }
}
