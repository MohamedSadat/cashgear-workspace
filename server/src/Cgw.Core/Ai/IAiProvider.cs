using System.Text.Json;

namespace Cgw.Core.Ai;

/// <summary>
/// What is sent to a model, and nothing else: built in one place (<see cref="AiRequestBuilder"/>)
/// from the action's fixed instructions and the fields its table names. <c>Schema</c> asks for a
/// JSON answer of that shape (structured output); null for Markdown.
/// </summary>
public sealed record AiRequest(string Action, string System, string User, string Effort, int MaxTokens, JsonElement? Schema);

/// <summary>One call to a provider: the request, the workspace's model and its key (never logged).</summary>
public sealed record AiCall(AiRequest Request, string Model, string ApiKey)
{
    // The key must not reach a log line through a record's generated ToString.
    public override string ToString() => $"AiCall {{ Action = {Request.Action}, Model = {Model} }}";
}

/// <summary>What a provider streams back.</summary>
public abstract record AiChunk;

/// <summary>The provider accepted the call and began to answer, with the model that is answering.</summary>
public sealed record AiStarted(string Model) : AiChunk;

/// <summary>The next piece of the answer.</summary>
public sealed record AiText(string Text) : AiChunk;

/// <summary>The end: <c>end</c>, <c>length</c> (cut at the token limit) or <c>refused</c>, and the tokens used.</summary>
public sealed record AiFinished(string StopReason, long InputTokens, long OutputTokens) : AiChunk
{
    public const string End = "end";
    public const string Length = "length";
    public const string Refused = "refused";
}

/// <summary>A provider failure, as one of the AI codes: <c>ai.keyInvalid</c>, <c>ai.limit</c> or <c>ai.provider</c>.</summary>
public sealed class AiProviderException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}

/// <summary>
/// A model provider (INTEGRATIONS.md, AI). The Ai module is the only code that calls one, and only
/// with what <see cref="AiRequestBuilder"/> built. The first chunk is <see cref="AiStarted"/> once
/// the provider has accepted the call; failures before it throw <see cref="AiProviderException"/>.
/// </summary>
public interface IAiProvider
{
    string Id { get; }

    IAsyncEnumerable<AiChunk> CompleteAsync(AiCall call, CancellationToken ct);
}
