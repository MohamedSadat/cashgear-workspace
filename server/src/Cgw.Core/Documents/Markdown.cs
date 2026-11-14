using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cgw.Core.Documents;

/// <summary>
/// Names for what a document stores only by id (D6), resolved by whoever writes it out: the
/// C# side of <c>TextContext</c> in <c>packages/doc/src/text.ts</c>. A function left null, or one
/// that answers null, is JavaScript's <c>undefined</c>.
/// </summary>
public sealed class TextContext
{
    public Func<string, string?>? PageTitle { get; init; }
    /// <summary>A link target for a page, in an export: a relative path.</summary>
    public Func<string, string?, string?>? PageHref { get; init; }
    public Func<string, string?>? AssetName { get; init; }
    public Func<string, string?>? AssetHref { get; init; }
    /// <summary>What an image or file with no name says.</summary>
    public string? Untitled { get; init; }
    /// <summary>
    /// A mentioned person's name now (schema version 5): a mention writes <c>@</c> and it, or
    /// <c>@</c> alone without one.
    /// </summary>
    public Func<string, string?>? UserName { get; init; }
}

/// <summary>
/// A page's ProseMirror JSON as Markdown: a port of <c>toMarkdown</c> in
/// <c>packages/doc/src/text.ts</c> (the to-Markdown direction only), so the server's export
/// writes what the app's does. Both are checked against
/// <c>packages/doc/vectors/markdown-vectors.json</c>. It keeps JavaScript's meaning where the
/// document could be odd: truthiness, <c>String()</c>, <c>Number()</c>, <c>\s</c> and
/// <c>encodeURIComponent</c>.
/// </summary>
public static partial class Markdown
{
    public static string Write(JsonElement doc, TextContext? context = null)
    {
        context ??= new TextContext();
        var output = new List<string>();
        Walk(Content(doc), "", context, output);
        return string.Join("\n\n", output.Where(chunk => chunk != "")) + "\n";
    }

    private static void Walk(IReadOnlyList<JsonElement> blocks, string indent, TextContext context, List<string> output)
    {
        var number = 0;
        foreach (var block in blocks)
        {
            var bodies = Content(block).Where(c => !IsBlock(c)).ToList();
            string? kind = null;
            if (bodies.Count > 0)
            {
                var first = bodies[0];
                kind = Type(first) == "textBody"
                    ? Js.String(Js.Prop(Js.Prop(first, "attrs"), "kind"), "paragraph")
                    : Type(first);
            }
            number = kind == "numberedItem" ? number + 1 : 0;
            foreach (var body in bodies) output.Add(Body(body, context, indent, number == 0 ? 1 : number));
            Walk(Content(block).Where(IsBlock).ToList(), indent + "  ", context, output);
        }
    }

    private static string Body(JsonElement body, TextContext context, string indent, int number)
    {
        var attrs = Js.Prop(body, "attrs");
        switch (Type(body))
        {
            case "textBody":
            {
                var text = Inline(Content(body), context, indent + "  ");
                var safe = EscapeLineStart(text);
                switch (StrictString(Js.Prop(attrs, "kind")))
                {
                    case "heading":
                    {
                        var level = Js.Number(Js.Prop(attrs, "level"));
                        if (double.IsNaN(level) || level == 0) level = 1;
                        var count = (int)Math.Max(0, Math.Truncate(Math.Min(3, level)));
                        return $"{indent}{new string('#', count)} {text}";
                    }
                    case "bulletItem":
                    case "toggle":
                        return $"{indent}- {text}";
                    case "numberedItem":
                        return $"{indent}{number}. {text}";
                    case "checkItem":
                        return $"{indent}- [{(Js.Truthy(Js.Prop(attrs, "checked")) ? "x" : " ")}] {text}";
                    case "quote":
                        return $"{indent}> {text.Replace("\n", $"\n{indent}> ")}";
                    case "callout":
                    {
                        var icon = Js.Prop(attrs, "icon");
                        return $"{indent}> {(Js.Truthy(icon) ? Js.String(icon) + " " : "")}{text.Replace("\n", $"\n{indent}> ")}";
                    }
                    default:
                        return $"{indent}{safe}";
                }
            }
            case "codeBlock":
            {
                var code = PlainInline(Content(body), context);
                var fence = code.Contains("```", StringComparison.Ordinal) ? "````" : "```";
                var language = Js.Prop(attrs, "language");
                var lines = new List<string> { $"{indent}{fence}{(Js.Nullish(language) ? "" : Js.String(language))}" };
                lines.AddRange(code.Split('\n').Select(line => indent + line));
                lines.Add($"{indent}{fence}");
                return string.Join("\n", lines);
            }
            case "divider":
                return $"{indent}---";
            case "image":
            {
                var id = Js.String(Js.Prop(attrs, "assetId"), "");
                var alt = EscapeInline(Js.String(Js.Prop(attrs, "alt"), ""));
                var href = context.AssetHref?.Invoke(id) ?? $"asset:{id}";
                var captionValue = Js.Prop(attrs, "caption");
                var caption = Js.Truthy(captionValue) ? $"\n{indent}*{EscapeInline(Js.String(captionValue))}*" : "";
                return $"{indent}![{alt}]({href}){caption}";
            }
            case "file":
            {
                var id = Js.String(Js.Prop(attrs, "assetId"), "");
                var name = context.AssetName?.Invoke(id) ?? context.Untitled ?? id;
                return $"{indent}[{EscapeInline(name)}]({context.AssetHref?.Invoke(id) ?? $"asset:{id}"})";
            }
            case "bookmark":
            {
                var url = Js.Prop(attrs, "url");
                return Js.Truthy(url) ? $"{indent}<{Js.String(url)}>" : "";
            }
            case "childPage":
            {
                var id = Js.String(Js.Prop(attrs, "pageId"), "");
                var title = context.PageTitle?.Invoke(id) ?? context.Untitled ?? id;
                var href = context.PageHref?.Invoke(id, null);
                return !string.IsNullOrEmpty(href) ? $"{indent}[{EscapeInline(title)}]({href})" : $"{indent}{EscapeInline(title)}";
            }
            case "table":
                return Table(body, context, indent);
            // Schema version 2: the page's own headings, drawn by the app; nothing of its own to
            // write (the document layer's writer agrees). Version 3's database view writes nothing
            // either: a database's rows are pages of their own. Nor do version 4's workbook embed
            // (a workbook is a record of its own) and ERP view (nothing from the ERP is written).
            case "tableOfContents":
            case "databaseView":
            case "sheetEmbed":
            case "erpView":
                return "";
            default:
                return "";
        }
    }

    /// <summary>Plain text of inline nodes: what a code block holds.</summary>
    private static string PlainInline(IReadOnlyList<JsonElement> nodes, TextContext context)
    {
        var output = new StringBuilder();
        foreach (var node in nodes)
        {
            var type = Type(node);
            if (type == "text") output.Append(Js.String(Js.Prop(node, "text"), ""));
            else if (type == "hardBreak") output.Append('\n');
            else if (type == "pageMention")
                output.Append(context.PageTitle?.Invoke(Js.String(Js.Prop(Js.Prop(node, "attrs"), "pageId"), "")) ?? "");
            else if (type == "dateMention") output.Append(DateMentionText(Js.Prop(node, "attrs")));
            else if (type == "userMention") output.Append(UserMentionText(node, context));
        }
        return output.ToString();
    }

    /// <summary>
    /// Schema version 5's user mention (<c>userMentionText</c> in packages/doc/src/text.ts):
    /// <c>@</c> and the name the writer is given for a user id that is a non-empty string, else
    /// <c>@</c> alone.
    /// </summary>
    private static string UserMentionText(JsonElement node, TextContext context)
    {
        var id = Js.Prop(Js.Prop(node, "attrs"), "userId");
        var name = id is { ValueKind: JsonValueKind.String } v && v.GetString() is { Length: > 0 } userId
            ? context.UserName?.Invoke(userId)
            : null;
        return "@" + (name ?? "");
    }

    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)?\z")]
    private static partial Regex DateValuePattern();

    /// <summary>
    /// Schema version 3's date mention (<c>dateMentionText</c> in packages/doc/src/dates.ts): its
    /// date as stored, then <c> → </c> and its end when it has a valid one; nothing when the date
    /// is missing or not a date's form.
    /// </summary>
    private static string DateMentionText(JsonElement? attrs)
    {
        static string? Date(JsonElement? value) =>
            value is { ValueKind: JsonValueKind.String } v && v.GetString() is { } s && DateValuePattern().IsMatch(s) ? s : null;
        if (Date(Js.Prop(attrs, "date")) is not { } date) return "";
        return Date(Js.Prop(attrs, "end")) is { } end ? $"{date} → {end}" : date;
    }

    private static string Inline(IReadOnlyList<JsonElement> nodes, TextContext context, string indent)
    {
        var output = new StringBuilder();
        foreach (var node in nodes)
        {
            var type = Type(node);
            if (type == "hardBreak")
            {
                output.Append("  \n").Append(indent);
                continue;
            }
            if (type == "pageMention")
            {
                var attrs = Js.Prop(node, "attrs");
                var id = Js.String(Js.Prop(attrs, "pageId"), "");
                var title = context.PageTitle?.Invoke(id) ?? id;
                var blockId = Js.Prop(attrs, "blockId");
                var href = context.PageHref?.Invoke(id, blockId is { ValueKind: JsonValueKind.String } b ? b.GetString() : null);
                output.Append(!string.IsNullOrEmpty(href) ? $"[{EscapeInline(title)}]({href})" : EscapeInline(title));
                continue;
            }
            if (type == "dateMention")
            {
                // Digits, '-', 'T', ':', 'Z', a space and an arrow: nothing Markdown reads as syntax.
                output.Append(DateMentionText(Js.Prop(node, "attrs")));
                continue;
            }
            if (type == "userMention")
            {
                // '@' is not Markdown; a name is escaped as any text is.
                output.Append(EscapeInline(UserMentionText(node, context)));
                continue;
            }
            if (type != "text") continue;
            var marks = Marks(node);
            if (marks.Any(m => Type(m) == "code"))
            {
                var raw = Js.String(Js.Prop(node, "text"), "");
                var fence = raw.Contains('`') ? "``" : "`";
                var coded = $"{fence}{raw}{fence}";
                foreach (var mark in marks)
                    if (Type(mark) == "link") coded = Wrap(coded, mark);
                output.Append(coded);
                continue;
            }
            var text = EscapeInline(Js.String(Js.Prop(node, "text"), ""));
            // Spaces stay outside the markers, which Markdown needs to see them.
            var lead = 0;
            while (lead < text.Length && Js.IsSpace(text[lead])) lead++;
            var end = text.Length;
            while (end > lead && Js.IsSpace(text[end - 1])) end--;
            var core = text[lead..end];
            if (core.Length > 0)
                foreach (var mark in marks) core = Wrap(core, mark);
            output.Append(text[..lead]).Append(core).Append(text[end..]);
        }
        return output.ToString();
    }

    private static string Wrap(string text, JsonElement mark)
    {
        switch (Type(mark))
        {
            case "bold":
                return $"**{text}**";
            case "italic":
                return $"*{text}*";
            case "strike":
                return $"~~{text}~~";
            case "underline":
                return $"<u>{text}</u>";
            case "link":
            {
                var href = Js.String(Js.Prop(Js.Prop(mark, "attrs"), "href"), "");
                if (href.Length == 0) return text;
                // href.replace(/[()\s]/g, encodeURIComponent): the parentheses come back as they were.
                var escaped = new StringBuilder();
                foreach (var c in href) escaped.Append(c is '(' or ')' ? c.ToString() : Js.IsSpace(c) ? Js.EncodeUriComponent(c.ToString()) : c.ToString());
                return $"[{text}]({escaped})";
            }
            default:
                // Colours are theme tokens with no Markdown form; the text stays.
                return text;
        }
    }

    private static string Table(JsonElement table, TextContext context, string indent)
    {
        var rows = Content(table).Select(row => Content(row).Select(cell =>
            {
                var text = Inline(Content(cell), context, "").Replace("\n", " ").Replace("|", "\\|");
                return text.Length == 0 ? " " : text;
            }).ToList()).ToList();
        if (rows.Count == 0) return "";
        var width = rows.Max(r => r.Count);
        List<string> Pad(List<string> r) => [.. r, .. Enumerable.Repeat(" ", width - r.Count)];
        List<string> header;
        if (Js.Truthy(Js.Prop(Js.Prop(table, "attrs"), "headerRow")))
        {
            header = Pad(rows[0]);
            rows.RemoveAt(0);
        }
        else header = Enumerable.Repeat(" ", width).ToList();
        string Line(IEnumerable<string> cells) => $"{indent}| {string.Join(" | ", cells)} |";
        var lines = new List<string> { Line(header), Line(Enumerable.Repeat("---", width)) };
        lines.AddRange(rows.Select(r => Line(Pad(r))));
        return string.Join("\n", lines);
    }

    // Helpers -------------------------------------------------------------------------------------

    private static bool IsBlock(JsonElement node) => Type(node) == "block";

    private static string? Type(JsonElement node) => StrictString(Js.Prop(node, "type"));

    private static string? StrictString(JsonElement? value) => value is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

    /// <summary><c>node.content ?? []</c>; anything that is not an array holds nothing.</summary>
    private static IReadOnlyList<JsonElement> Content(JsonElement node) =>
        Js.Prop(node, "content") is { ValueKind: JsonValueKind.Array } content ? content.EnumerateArray().ToList() : [];

    private static IReadOnlyList<JsonElement> Marks(JsonElement node) =>
        Js.Prop(node, "marks") is { ValueKind: JsonValueKind.Array } marks ? marks.EnumerateArray().ToList() : [];

    private const string Escaped = "\\`*_[]~<>|";

    public static string EscapeInline(string text)
    {
        var output = new StringBuilder(text.Length);
        foreach (var c in text)
        {
            if (Escaped.Contains(c)) output.Append('\\');
            output.Append(c);
        }
        return output.ToString();
    }

    /// <summary><c>/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|---|```)/</c>, with JavaScript's <c>\s</c> and <c>\d</c>.</summary>
    [GeneratedRegex(@"^([\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*)(#{1,6}[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|>|[-+*][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[0-9]+[.)][\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|---|```)")]
    private static partial Regex LineStart();

    public static string EscapeLineStart(string text) => LineStart().Replace(text, @"$1\$2", 1);
}

/// <summary>What JavaScript does with a JSON value, where a port must do the same.</summary>
public static class Js
{
    /// <summary>A property of an object; null (undefined) for anything else.</summary>
    public static JsonElement? Prop(JsonElement? node, string name) =>
        node is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty(name, out var value) ? value : null;

    /// <summary><c>value == null</c>: undefined or null.</summary>
    public static bool Nullish(JsonElement? value) => value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined;

    public static bool Truthy(JsonElement? value)
    {
        if (value is not { } v) return false;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.String => v.GetString()!.Length > 0,
            JsonValueKind.Number => v.GetDouble() is var d && d != 0 && !double.IsNaN(d),
            JsonValueKind.Object or JsonValueKind.Array => true,
            _ => false,
        };
    }

    /// <summary><c>String(value ?? fallback)</c> (and plain <c>String(value)</c> with no fallback).</summary>
    public static string String(JsonElement? value, string? fallback = null)
    {
        if (Nullish(value)) return fallback ?? (value is null ? "undefined" : "null");
        var v = value!.Value;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString()!,
            JsonValueKind.Number => NumberText(v.GetDouble()),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Array => string.Join(",", v.EnumerateArray().Select(e => Nullish(e) ? "" : String(e))),
            _ => "[object Object]",
        };
    }

    /// <summary><c>Number(value)</c>.</summary>
    public static double Number(JsonElement? value)
    {
        if (value is not { } v) return double.NaN;
        switch (v.ValueKind)
        {
            case JsonValueKind.Null:
            case JsonValueKind.False:
                return 0;
            case JsonValueKind.True:
                return 1;
            case JsonValueKind.Number:
                return v.GetDouble();
            case JsonValueKind.String:
            {
                var text = v.GetString()!.Trim();
                if (text.Length == 0) return 0;
                return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : double.NaN;
            }
            case JsonValueKind.Array:
            {
                var items = v.EnumerateArray().ToList();
                return items.Count switch
                {
                    0 => 0,
                    1 => items[0].ValueKind is JsonValueKind.Array or JsonValueKind.Object ? double.NaN : Number(items[0]),
                    _ => double.NaN,
                };
            }
            default:
                return double.NaN;
        }
    }

    /// <summary>A number as JavaScript prints it, for the values documents hold.</summary>
    public static string NumberText(double d)
    {
        if (double.IsNaN(d)) return "NaN";
        if (double.IsInfinity(d)) return d > 0 ? "Infinity" : "-Infinity";
        if (d == 0) return "0";
        if (d == Math.Truncate(d) && Math.Abs(d) < 1e21) return d.ToString("0", CultureInfo.InvariantCulture);
        var text = d.ToString("R", CultureInfo.InvariantCulture);
        if (!text.Contains('E')) return text;
        var parts = text.Split('E');
        var exponent = int.Parse(parts[1], CultureInfo.InvariantCulture);
        return $"{parts[0]}e{(exponent >= 0 ? "+" : "-")}{Math.Abs(exponent)}";
    }

    /// <summary>JavaScript's <c>\s</c>.</summary>
    public static bool IsSpace(char c) => c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680'
        or (>= '\u2000' and <= '\u200a') or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff';

    private const string Unescaped = "-_.!~*'()";

    /// <summary><c>encodeURIComponent</c>: UTF-8, upper-case hex, and <c>A-Z a-z 0-9 - _ . ! ~ * ' ( )</c> as they are.</summary>
    public static string EncodeUriComponent(string text)
    {
        var output = new StringBuilder(text.Length);
        Span<byte> bytes = stackalloc byte[4];
        foreach (var rune in text.EnumerateRunes())
        {
            if (rune.IsAscii && (char.IsAsciiLetterOrDigit((char)rune.Value) || Unescaped.Contains((char)rune.Value)))
            {
                output.Append((char)rune.Value);
                continue;
            }
            var count = rune.EncodeToUtf8(bytes);
            for (var i = 0; i < count; i++) output.Append('%').Append(bytes[i].ToString("X2", CultureInfo.InvariantCulture));
        }
        return output.ToString();
    }
}

/// <summary>Names safe as a file or folder on every system: <c>safeName</c> in the app's export.</summary>
public static partial class SafeNames
{
    [GeneratedRegex(@"[\\/:*?""<>|]")]
    private static partial Regex Reserved();

    [GeneratedRegex(@"\p{Cc}")]
    private static partial Regex Control();

    [GeneratedRegex(@"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")]
    private static partial Regex Spaces();

    [GeneratedRegex(@"^[.\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[.\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$")]
    private static partial Regex Edges();

    public static string Name(string name, string fallback)
    {
        var cleaned = Reserved().Replace(name, " ");
        cleaned = Control().Replace(cleaned, " ");
        cleaned = Spaces().Replace(cleaned, " ");
        cleaned = Edges().Replace(cleaned, "");
        if (cleaned.Length > 60) cleaned = cleaned[..60];
        return cleaned.Length > 0 ? cleaned : fallback;
    }
}
