using System.Diagnostics;
using System.Text.Json;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Ai;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// AI (INTEGRATIONS.md, AI, As agreed for 0.7.0): a workspace's settings, and completions streamed
/// as NDJSON. Before the stream starts every failure is a problem with a code; after it, an
/// <c>error</c> line. Signed-in members only: a share link reaches none of these.
/// </summary>
public static class AiEndpoints
{
    public const string NdJson = "application/x-ndjson";

    public static void MapAi(this RouteGroupBuilder api)
    {
        var settings = api.MapGroup("/workspaces/{workspaceId:guid}/ai-settings").WithTags("AI")
            .RequireAuthorization().AddEndpointFilter<MemberFilter>().RequireRateLimiting(RateLimits.User);

        settings.MapGet("", async (AiService ai, HttpContext http) => TypedResults.Ok(await ai.SettingsAsync(http.Member(), http.RequestAborted)))
            .WithName("getAiSettings");

        settings.MapPut("", async Task<Results<Ok<AiSettingsDto>, ProblemHttpResult>> (AiSettingsUpdate body, AiService ai, HttpContext http) =>
            {
                var result = await ai.UpdateAsync(http.Member(), http.Actor(), body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updateAiSettings")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16 * 1024));

        api.MapPost("/ai/complete", CompleteAsync)
            .WithTags("AI").RequireAuthorization().RequireRateLimiting(RateLimits.Ai)
            .WithName("completeAi")
            .Produces<AiEventDto>(200, NdJson)
            .ProducesProblem(400).ProducesProblem(403).ProducesProblem(404).ProducesProblem(413).ProducesProblem(502).ProducesProblem(503)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(1024 * 1024));
    }

    private static async Task<IResult> CompleteAsync(AiCompleteRequest body, AiService ai, IAiProvider provider, HttpContext http)
    {
        var prepared = await ai.PrepareAsync(http.User.UserId()!.Value, body, http.RequestAborted);
        if (!prepared.Ok) return Problems.From(prepared.Failure!, http);
        var ready = prepared.Value!;
        var actor = http.Actor();
        var took = Stopwatch.StartNew();
        if (ready.Call is null) return new AiStream(ready, ai, actor, null, null, took);

        // The provider has accepted the call before anything is answered: a refused key or a
        // provider that is down is a problem with its code, not a stream that ends at once.
        var chunks = provider.CompleteAsync(ready.Call, http.RequestAborted).GetAsyncEnumerator(http.RequestAborted);
        try
        {
            if (!await chunks.MoveNextAsync() || chunks.Current is not AiStarted started)
                throw new AiProviderException(Codes.AiProvider, "The provider answered nothing");
            return new AiStream(ready, ai, actor, chunks, started, took);
        }
        catch (Exception error) when (error is AiProviderException or OperationCanceledException)
        {
            await chunks.DisposeAsync();
            var code = error is AiProviderException p ? p.Code : "cancelled";
            if (error is AiProviderException failed) Log(http, failed);
            await ai.RecordAsync(ready, actor, code, 0, 0, took.Elapsed);
            if (error is OperationCanceledException) return Results.Empty;
            return Problems.From(new Failure(code, code == Codes.AiLimit ? 503 : 502, Title(code)), http);
        }
    }

    /// <summary>What failed, for the log: the code and the SDK's exception type, never the request, the answer or the key.</summary>
    private static void Log(HttpContext http, AiProviderException error) =>
        http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Cgw.Ai")
            .LogWarning("AI provider failed: {Code} ({Kind})", error.Code, error.InnerException?.GetType().Name ?? "none");

    private static string Title(string code) => code switch
    {
        Codes.AiKeyInvalid => "The provider refused the workspace's key",
        Codes.AiLimit => "The provider is busy; try again later",
        _ => "The provider failed",
    };

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// The stream: <c>start</c>, then <c>sources</c> for <c>ask</c>, then <c>text</c> lines as the
    /// provider sends them, then <c>done</c> (or <c>error</c>); each line flushed as it is written.
    /// Metered and audited however it ends, the person leaving included.
    /// </summary>
    private sealed class AiStream(AiPrepared ready, AiService ai, Actor actor, IAsyncEnumerator<AiChunk>? chunks, AiStarted? started, Stopwatch took) : IResult
    {
        public async Task ExecuteAsync(HttpContext http)
        {
            var response = http.Response;
            response.StatusCode = 200;
            response.ContentType = NdJson + "; charset=utf-8";
            response.Headers.CacheControl = "no-store";
            http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            var ct = http.RequestAborted;
            var outcome = "cancelled";
            long input = 0, output = 0;
            try
            {
                await WriteAsync(response, new AiEventDto { Type = "start", RequestId = ready.RequestId.ToString("D"), Model = started?.Model ?? ready.Model }, ct);
                if (ready.Sources is { } sources) await WriteAsync(response, new AiEventDto { Type = "sources", Pages = sources }, ct);
                if (chunks is null)
                {
                    outcome = "ok";
                    await WriteAsync(response, new AiEventDto { Type = "done", StopReason = AiFinished.End, Usage = new AiTokensDto(0, 0) }, ct);
                    return;
                }
                try
                {
                    while (await chunks.MoveNextAsync())
                        switch (chunks.Current)
                        {
                            case AiText text:
                                await WriteAsync(response, new AiEventDto { Type = "text", Text = text.Text }, ct);
                                break;
                            case AiFinished done:
                                input = done.InputTokens;
                                output = done.OutputTokens;
                                if (done.StopReason == AiFinished.Refused)
                                {
                                    outcome = AiFinished.Refused;
                                    await WriteAsync(response, new AiEventDto { Type = "error", Code = Codes.AiRefused }, ct);
                                }
                                else
                                {
                                    outcome = done.StopReason == AiFinished.Length ? AiFinished.Length : "ok";
                                    await WriteAsync(response, new AiEventDto { Type = "done", StopReason = done.StopReason, Usage = new AiTokensDto(input, output) }, ct);
                                }
                                break;
                        }
                }
                catch (AiProviderException error)
                {
                    Log(http, error);
                    outcome = error.Code;
                    await WriteAsync(response, new AiEventDto { Type = "error", Code = error.Code }, ct);
                }
            }
            // The person left (the request was aborted, or their socket closed mid-write).
            catch (Exception error) when (error is OperationCanceledException or IOException)
            {
                outcome = "cancelled";
            }
            finally
            {
                if (chunks is not null) await chunks.DisposeAsync();
                await ai.RecordAsync(ready, actor, outcome, input, output, took.Elapsed);
            }
        }

        private static async Task WriteAsync(HttpResponse response, AiEventDto line, CancellationToken ct)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(line, Json);
            await response.Body.WriteAsync(bytes, ct);
            await response.Body.WriteAsync("\n"u8.ToArray(), ct);
            await response.Body.FlushAsync(ct);
        }
    }
}
