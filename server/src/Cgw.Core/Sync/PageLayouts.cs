using System.Text.Encodings.Web;
using System.Text.Json;

namespace Cgw.Core.Sync;

/// <summary>
/// Phase 19: a page's print layout (DATA_MODEL.md, "A page's layout"), the C# port of
/// packages/workspace/src/layout.ts's <c>checkLayout</c>, held to
/// packages/workspace/vectors/page-layout-vectors.json. The server keeps a layout as the JSON it is
/// given, keys it does not know included, and never reads it: the device prints and writes Word.
/// Null takes a page's layout off; an edit that does not name <c>layout</c> keeps it, so an older
/// build's edits never lose it.
/// </summary>
public static class PageLayouts
{
    public const int MaxBandText = 200;
    public const int MaxJson = 4000;

    private static readonly string[] Sizes = ["a4", "letter"];
    private static readonly string[] Orientations = ["portrait", "landscape"];
    private static readonly string[] Margins = ["narrow", "normal", "wide"];
    private static readonly string[] Places = ["start", "center", "end"];

    // As JavaScript's JSON.stringify writes it: letters of every script as they are.
    private static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>The layout as stored, compact JSON; null for none.</summary>
    public static string? Stored(JsonElement layout) =>
        layout.ValueKind == JsonValueKind.Null ? null : JsonSerializer.Serialize(layout, Compact);

    /// <summary>Why a layout is refused, or null when it is kept (null itself is no layout).</summary>
    public static string? Check(JsonElement layout)
    {
        if (layout.ValueKind == JsonValueKind.Null) return null;
        if (layout.ValueKind != JsonValueKind.Object) return "A layout is an object";
        if (JsonSerializer.Serialize(layout, Compact).Length > MaxJson) return "The layout is too long";
        foreach (var (key, values) in new[] { ("size", Sizes), ("orientation", Orientations), ("margins", Margins) })
            if (layout.TryGetProperty(key, out var value) && !(value.ValueKind == JsonValueKind.String && values.Contains(value.GetString(), StringComparer.Ordinal)))
                return $"{key} is one of {string.Join(", ", values)}";
        foreach (var band in new[] { "header", "footer" })
        {
            if (!layout.TryGetProperty(band, out var value)) continue;
            if (value.ValueKind != JsonValueKind.Object) return $"{band} is an object";
            foreach (var place in Places)
                if (value.TryGetProperty(place, out var text) && !PlaceText(text))
                    return $"{band}.{place} is text of at most {MaxBandText} characters on one line";
        }
        return null;
    }

    /// <summary>Text a band's place holds: at most 200 UTF-16 units, no control character (JavaScript's \p{Cc}).</summary>
    private static bool PlaceText(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String) return false;
        var text = value.GetString()!;
        return text.Length <= MaxBandText && !text.Any(char.IsControl);
    }

    /// <summary>
    /// The layout an operation's payload names, as stored: refused with <c>invalid</c> when its
    /// check fails.
    /// </summary>
    internal static string? FromPayload(JsonElement payload)
    {
        var layout = payload.GetProperty("layout");
        if (Check(layout) is { } problem) throw new OpFailure("invalid", problem);
        return Stored(layout);
    }
}
