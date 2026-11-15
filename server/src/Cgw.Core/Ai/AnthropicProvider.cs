using System.Runtime.CompilerServices;
using System.Text.Json;
using Anthropic;
using Anthropic.Exceptions;
using Anthropic.Models.Beta;
using Anthropic.Models.Beta.Messages;

namespace Cgw.Core.Ai;

/// <summary>
/// Anthropic's Messages API through its official C# SDK, streamed (decisions, 2026-11-15): the
/// workspace's own key, the workspace's model, adaptive thinking with the action's effort, a JSON
/// answer by structured output where the action wants one, and the server-side refusal fallback
/// (<c>fallbacks: "default"</c>) on the models that have it. The SDK never reads a key or a profile
/// of this machine: only the workspace's key is sent. The base address is Anthropic's, named here
/// (never the environment's <c>ANTHROPIC_BASE_URL</c>), unless <c>Ai__AnthropicBaseUrl</c> moved it, which
/// Production never does.
/// </summary>
public sealed class AnthropicProvider(AiOptions options, HttpClient http) : IAiProvider
{
    public const string ProviderId = "anthropic";
    public const string FallbackBeta = "server-side-fallback-2026-07-01";

    /// <summary>Anthropic's API: where a workspace's key goes in Production, and the only place.</summary>
    public const string AnthropicBaseUrl = "https://api.anthropic.com";

    public string Id => ProviderId;

    /// <summary>A long answer streams for minutes; the stream's own silence is what ends a call.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(10);

    /// <summary>Claude Haiku 5.5 has no server-side refusal fallback.</summary>
    public static bool HasFallback(string model) => !model.StartsWith("claude-haiku", StringComparison.Ordinal);

    public static MessageCreateParams Parameters(AiCall call)
    {
        var request = call.Request;
        var output = new BetaOutputConfig { Effort = request.Effort == "low" ? Effort.Low : Effort.Medium };
        if (request.Schema is { } schema)
            output = output with
            {
                Format = new BetaJsonOutputFormat
                {
                    Schema = schema.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone()),
                },
            };
        var parameters = new MessageCreateParams
        {
            Model = call.Model,
            MaxTokens = request.MaxTokens,
            System = request.System,
            Messages = [new BetaUserMessageParam { Content = request.User }],
            Thinking = new BetaThinkingConfigAdaptive(),
            OutputConfig = output,
        };
        if (HasFallback(call.Model))
            parameters = parameters with { Betas = [FallbackBeta], Fallbacks = new Default() };
        return parameters;
    }

    public async IAsyncEnumerable<AiChunk> CompleteAsync(AiCall call, [EnumeratorCancellation] CancellationToken ct)
    {
        // Always named, so an ANTHROPIC_BASE_URL in the host's environment cannot move the key.
        var client = new WorkspaceKeyClient
        {
            ApiKey = call.ApiKey,
            HttpClient = http,
            MaxRetries = 2,
            Timeout = Timeout,
            BaseUrl = options.AnthropicBaseUrl ?? AnthropicBaseUrl,
        };

        var events = client.Beta.Messages.CreateStreaming(Parameters(call), ct).GetAsyncEnumerator(ct);
        long input = 0, outputTokens = 0;
        var stop = AiFinished.End;
        var started = false;
        try
        {
            while (true)
            {
                BetaRawMessageStreamEvent e;
                try
                {
                    if (!await events.MoveNextAsync()) break;
                    e = events.Current;
                }
                // A timeout of the SDK's own is a failure; only the caller's cancellation is not.
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    throw Map(error);
                }
                if (e.TryPickStart(out var start))
                {
                    input = start.Message.Usage.InputTokens;
                    outputTokens = start.Message.Usage.OutputTokens;
                    if (!started)
                    {
                        started = true;
                        yield return new AiStarted(start.Message.Model);
                    }
                }
                else if (e.TryPickContentBlockDelta(out var delta) && delta.Delta.TryPickText(out var text))
                {
                    if (text.Text.Length > 0) yield return new AiText(text.Text);
                }
                else if (e.TryPickDelta(out var message))
                {
                    if (message.Usage.InputTokens is { } i) input = i;
                    outputTokens = message.Usage.OutputTokens;
                    stop = StopOf(message.Delta.StopReason?.Raw());
                }
            }
        }
        finally
        {
            await events.DisposeAsync();
        }
        if (!started) throw new AiProviderException(Codes.AiProvider, "The provider answered nothing");
        yield return new AiFinished(stop, input, outputTokens);
    }

    private static string StopOf(string? reason) => reason switch
    {
        "max_tokens" => AiFinished.Length,
        "refusal" => AiFinished.Refused,
        _ => AiFinished.End,
    };

    /// <summary>The SDK's errors as the AI codes; the provider's own message is never passed on.</summary>
    public static AiProviderException Map(Exception error) => error switch
    {
        AiProviderException known => known,
        AnthropicUnauthorizedException or AnthropicForbiddenException => new(Codes.AiKeyInvalid, "The provider refused the workspace's key", error),
        AnthropicRateLimitException => new(Codes.AiLimit, "The provider is busy or the key's limit is reached", error),
        Anthropic5xxException => new(Codes.AiProvider, "The provider is unavailable", error),
        _ => new(Codes.AiProvider, "The provider failed", error),
    };
}

/// <summary>A client that uses the key it is given and never looks for one in this machine's environment or profiles.</summary>
internal sealed class WorkspaceKeyClient : AnthropicClient
{
    protected override bool ShouldAutoResolveCredentials => false;
}
