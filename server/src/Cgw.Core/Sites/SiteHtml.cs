using System.Globalization;
using System.Text;

namespace Cgw.Core.Sites;

/// <summary>
/// Writing HTML that a document cannot break out of: every text and attribute value escaped,
/// control characters dropped, attribute values always quoted, URLs only from ids or a short list of
/// schemes, names (tags, attributes, classes) never from the document.
/// </summary>
public sealed class SiteHtml
{
    private readonly StringBuilder html = new(16 * 1024);

    public int Length => html.Length;

    public override string ToString() => html.ToString();

    /// <summary>Markup this code wrote (a tag, an entity); never anything from a document.</summary>
    public SiteHtml Raw(string markup)
    {
        html.Append(markup);
        return this;
    }

    public SiteHtml Text(string? text)
    {
        Escape(html, text);
        return this;
    }

    /// <summary><c> name="value"</c>, the value escaped.</summary>
    public SiteHtml Attr(string name, string? value)
    {
        html.Append(' ').Append(name).Append("=\"");
        Escape(html, value);
        html.Append('"');
        return this;
    }

    public SiteHtml Attr(string name, long value)
    {
        html.Append(' ').Append(name).Append("=\"").Append(value.ToString(CultureInfo.InvariantCulture)).Append('"');
        return this;
    }

    public static string Escape(string? text)
    {
        var builder = new StringBuilder((text?.Length ?? 0) + 16);
        Escape(builder, text);
        return builder.ToString();
    }

    public static void Escape(StringBuilder into, string? text)
    {
        if (string.IsNullOrEmpty(text)) return;
        foreach (var c in text)
        {
            switch (c)
            {
                case '&': into.Append("&amp;"); break;
                case '<': into.Append("&lt;"); break;
                case '>': into.Append("&gt;"); break;
                case '"': into.Append("&quot;"); break;
                case '\'': into.Append("&#39;"); break;
                case '\n' or '\t': into.Append(c); break;
                case '\r': break;
                // C0 and C1 controls are never text a page needs; NUL and the like break parsers.
                case < ' ' or (>= '\u007f' and <= '\u009f'): break;
                default: into.Append(c); break;
            }
        }
    }

    /// <summary>
    /// A link a document may hold, for a page with no script: <c>http</c>, <c>https</c>,
    /// <c>mailto</c> and <c>tel</c> only (the schema's <c>safeHref</c>, without its in-app links),
    /// with no control character anywhere; null for anything else.
    /// </summary>
    public static string? SafeUrl(string? href)
    {
        if (href is null) return null;
        var value = href.Trim();
        if (value.Length is 0 or > 2048) return null;
        foreach (var c in value)
            if (c < ' ' || c == '\u007f') return null;
        var lower = value.ToLowerInvariant();
        return lower.StartsWith("https://", StringComparison.Ordinal) || lower.StartsWith("http://", StringComparison.Ordinal)
            || lower.StartsWith("mailto:", StringComparison.Ordinal) || lower.StartsWith("tel:", StringComparison.Ordinal)
            ? value
            : null;
    }

    /// <summary>A block id usable as an element id: the block-id plugin's base-62 ids, at most 64 characters.</summary>
    public static bool IsBlockId(string? id) => id is { Length: > 0 and <= 64 } && id.All(char.IsAsciiLetterOrDigit);

    /// <summary>The document's colour tokens: a class name only when the token is one of them.</summary>
    public static readonly HashSet<string> Colours = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
}
