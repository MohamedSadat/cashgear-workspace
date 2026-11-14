using System.Text;
using System.Text.Json;
using Cgw.Core.Comments;

namespace Cgw.Core.Notifications;

/// <summary>A person mentioned in a block, with the block's plain text for the inbox.</summary>
public sealed record BlockMention(string BlockId, Guid UserId, string Excerpt);

/// <summary>
/// The <c>userMention</c>s of a page's derived ProseMirror JSON (Phase 6 contracts, section 5):
/// <c>{ "type": "userMention", "attrs": { "userId": ... } }</c>, each in the nearest block around it
/// whose <c>attrs.id</c> is its block id. The worker compares a derive's pairs with the last one's
/// and notifies only for new ones.
/// </summary>
public static class Mentions
{
    private const int MaxDepth = 250;

    /// <summary>Every (block, person) pair once, in document order, with the block's text.</summary>
    public static List<BlockMention> InDocument(string json)
    {
        var found = new List<BlockMention>();
        var seen = new HashSet<(string, Guid)>();
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 1024 });
        Walk(document.RootElement, null, found, seen, 0);
        return found;
    }

    private static void Walk(JsonElement node, (string Id, JsonElement Node)? block, List<BlockMention> found, HashSet<(string, Guid)> seen, int depth)
    {
        if (depth > MaxDepth || node.ValueKind != JsonValueKind.Object) return;
        var type = node.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        if (type == "block" && node.TryGetProperty("attrs", out var blockAttrs) && blockAttrs.ValueKind == JsonValueKind.Object
            && blockAttrs.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && CommentRules.BlockId(id.GetString()))
            block = (id.GetString()!, node);
        if (type == "userMention" && block is { } owner && node.TryGetProperty("attrs", out var attrs) && attrs.ValueKind == JsonValueKind.Object
            && attrs.TryGetProperty("userId", out var user) && user.ValueKind == JsonValueKind.String
            && Guid.TryParse(user.GetString(), out var userId) && userId != Guid.Empty && seen.Add((owner.Id, userId)))
            found.Add(new BlockMention(owner.Id, userId, CommentRules.Excerpt(BlockText(owner.Node))));
        if (node.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
            foreach (var child in content.EnumerateArray()) Walk(child, block, found, seen, depth + 1);
    }

    /// <summary>A block's own text (its bodies, not the blocks inside it), mentions as "@" as the derived text writes them.</summary>
    public static string BlockText(JsonElement block)
    {
        var text = new StringBuilder();
        void Collect(JsonElement node, int depth)
        {
            if (depth > MaxDepth || node.ValueKind != JsonValueKind.Object || text.Length > 4 * CommentRules.ExcerptLength) return;
            var type = node.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            switch (type)
            {
                case "block":
                    return;
                case "text":
                    if (node.TryGetProperty("text", out var s) && s.ValueKind == JsonValueKind.String) text.Append(s.GetString());
                    return;
                case "hardBreak":
                    text.Append(' ');
                    return;
                case "userMention":
                case "pageMention":
                    text.Append('@');
                    return;
            }
            if (node.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                foreach (var child in content.EnumerateArray()) Collect(child, depth + 1);
        }
        if (block.TryGetProperty("content", out var bodies) && bodies.ValueKind == JsonValueKind.Array)
            foreach (var body in bodies.EnumerateArray())
            {
                Collect(body, 1);
                text.Append(' ');
            }
        return text.ToString();
    }

    /// <summary>The pairs as the derived row keeps them: <c>[["blockId","userId"],...]</c>, sorted.</summary>
    public static string Serialize(IEnumerable<BlockMention> mentions) =>
        JsonSerializer.Serialize(mentions.Select(m => new[] { m.BlockId, m.UserId.ToString() })
            .OrderBy(p => p[0], StringComparer.Ordinal).ThenBy(p => p[1], StringComparer.Ordinal).ToList());

    public static HashSet<(string BlockId, Guid UserId)> Parse(string? json)
    {
        var pairs = new HashSet<(string, Guid)>();
        if (string.IsNullOrEmpty(json)) return pairs;
        try
        {
            foreach (var pair in JsonSerializer.Deserialize<List<string[]>>(json) ?? [])
                if (pair is [var block, var user] && Guid.TryParse(user, out var userId)) pairs.Add((block, userId));
        }
        catch (JsonException)
        {
            // Unreadable: as if none were kept (a notification is deduplicated anyway).
        }
        return pairs;
    }
}
