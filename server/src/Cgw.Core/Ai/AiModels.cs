using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Ai;

/// <summary>The actions <c>POST /ai/complete</c> takes (INTEGRATIONS.md, AI, As agreed for 0.7.0).</summary>
public static class AiActions
{
    public const string Rewrite = "rewrite";
    public const string Summarise = "summarise";
    public const string ActionItems = "actionItems";
    public const string GeneratePage = "generatePage";
    public const string GenerateDatabase = "generateDatabase";
    public const string Ask = "ask";
    public const string ErpChanges = "erpChanges";

    public static readonly string[] All = [Rewrite, Summarise, ActionItems, GeneratePage, GenerateDatabase, Ask, ErpChanges];

    /// <summary>Actions about a page, which must name it.</summary>
    public static bool NeedsPage(string action) => action is Rewrite or Summarise or ActionItems or ErpChanges;
}

/// <summary>A workspace's AI settings, as <c>GET</c> and <c>PUT /workspaces/{id}/ai-settings</c> answer them.</summary>
public sealed record AiSettingsDto
{
    /// <summary>On, with a key set, and AI on for this server.</summary>
    public required bool Enabled { get; init; }
    public required string Provider { get; init; }
    public required string Model { get; init; }
    public required IReadOnlyList<string> Models { get; init; }
    // Owners and admins only; absent for everyone else.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? HasKey { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public DateTimeOffset? KeySetAt { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public AiPersonDto? KeySetBy { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public AiUsageDto? Usage { get; init; }
    /// <summary>Phase 10: embeddings (search by meaning), a switch and a key of their own.</summary>
    public required EmbeddingsSettingsDto Embeddings { get; init; }
}

/// <summary>Who set the key: a workspace member's id and name.</summary>
public sealed record AiPersonDto(Guid Id, string Name);

/// <summary>This calendar month's use (UTC) of completions, for owners and admins.</summary>
public sealed record AiUsageDto(string Month, int Requests, long InputTokens, long OutputTokens);

/// <summary>
/// The workspace's embeddings (Phase 10): on (with a key, and AI on for this server), the
/// provider and model; to owners and admins the key's details, the month's use and how far the
/// worker has come (pages to embed, and those with vectors of this model).
/// </summary>
public sealed record EmbeddingsSettingsDto
{
    public required bool Enabled { get; init; }
    public required string Provider { get; init; }
    public required string Model { get; init; }
    public required IReadOnlyList<string> Models { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? HasKey { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public DateTimeOffset? KeySetAt { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public AiPersonDto? KeySetBy { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public EmbeddingsUsageDto? Usage { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public EmbeddingsProgressDto? Progress { get; init; }
}

/// <summary>This calendar month's embeddings calls (the worker's and the questions') and their tokens.</summary>
public sealed record EmbeddingsUsageDto(string Month, int Requests, long Tokens);

/// <summary>Pages (and rows) to embed, not trashed; and of them, those with vectors of the current model.</summary>
public sealed record EmbeddingsProgressDto(int Pages, int Embedded);

/// <summary>
/// <c>PUT /workspaces/{id}/ai-settings</c>: each field absent keeps what is set. <c>apiKey</c> is a
/// string to set the key or <c>null</c> to remove it (a <see cref="JsonElement"/>, so absent and
/// null differ).
/// </summary>
public sealed record AiSettingsUpdate
{
    public bool? Enabled { get; init; }
    public string? Model { get; init; }
    public JsonElement ApiKey { get; init; }
    /// <summary>Phase 10: absent keeps the embeddings' settings as they are.</summary>
    public EmbeddingsUpdate? Embeddings { get; init; }
}

/// <summary>
/// The embeddings' part of the settings' <c>PUT</c>: <c>apiKey</c> a string sets the Voyage key,
/// <c>null</c> removes it (turning embeddings off), absent keeps it.
/// </summary>
public sealed record EmbeddingsUpdate
{
    public bool? Enabled { get; init; }
    public string? Model { get; init; }
    public JsonElement ApiKey { get; init; }
}

/// <summary><c>POST /ai/complete</c>'s body. <c>input</c> is read field by field, per action, by <see cref="AiRequestBuilder"/>.</summary>
public sealed record AiCompleteRequest
{
    public required Guid WorkspaceId { get; init; }
    public string? Action { get; init; }
    public Guid? PageId { get; init; }
    public string? Language { get; init; }
    public JsonElement Input { get; init; }
}

/// <summary>
/// One line of <c>/ai/complete</c>'s NDJSON stream (for the OpenAPI document; each line holds the
/// members of its <c>type</c> only): <c>start</c>, <c>sources</c>, <c>text</c>, <c>done</c>, <c>error</c>.
/// </summary>
public sealed record AiEventDto
{
    public required string Type { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? RequestId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Model { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Text { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<AiSourceDto>? Pages { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? StopReason { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public AiTokensDto? Usage { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Code { get; init; }
}

public sealed record AiSourceDto(Guid PageId, string Title);

public sealed record AiTokensDto(long InputTokens, long OutputTokens);

/// <summary>
/// The server's AI settings (<c>Ai__*</c>): <c>Ai__Enabled</c> (default true) turns AI off for every
/// workspace; <c>Ai__AnthropicBaseUrl</c> points the provider elsewhere, outside Production only
/// (the mock in <c>tests/mocks/ai</c>); <c>Ai__Models</c> what an admin may choose, the first the
/// default.
/// </summary>
public sealed record AiOptions(bool Enabled, string? AnthropicBaseUrl, IReadOnlyList<string> Models)
{
    public const string Section = "Ai";

    /// <summary>The Claude models offered (decisions, 2026-11-15): the most capable first, the default.</summary>
    public static readonly string[] DefaultModels = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

    public string DefaultModel => Models[0];

    public static AiOptions From(IConfiguration configuration, bool production)
    {
        var section = configuration.GetSection(Section);
        var enabled = section["Enabled"] is not { } on || !string.Equals(on, "false", StringComparison.OrdinalIgnoreCase);
        // The provider's address is never moved in Production: the key goes only to Anthropic.
        var baseUrl = production ? null : BaseUrl(section["AnthropicBaseUrl"]);
        var models = (section.GetSection("Models").Get<string[]>() ?? [])
            .Select(m => m.Trim()).Where(m => m.Length is > 0 and <= 64 && m.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '.' or '_'))
            .Distinct(StringComparer.Ordinal).ToArray();
        return new AiOptions(enabled, baseUrl, models.Length > 0 ? models : DefaultModels);
    }

    /// <summary>An absolute http(s) URL with no query, fragment or user: the provider's base address.</summary>
    public static string? BaseUrl(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
            return null;
        return (uri.GetLeftPart(UriPartial.Authority) + uri.AbsolutePath).TrimEnd('/');
    }
}
