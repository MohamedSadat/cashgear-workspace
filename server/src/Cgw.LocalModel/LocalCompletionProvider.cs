using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Cgw.Core;
using Cgw.Core.Ai;
using Microsoft.Extensions.Logging;
using Microsoft.ML.OnnxRuntimeGenAI;

namespace Cgw.LocalModel;

/// <summary>
/// The completion model's package as written by <c>scripts/completion-model.mjs</c> (Phase 18,
/// M18.1): ONNX Runtime GenAI's folder (<c>genai_config.json</c>, <c>model.onnx</c> and its weights,
/// the tokenizer's files) and <c>cgw-model.json</c>, this description of them.
/// </summary>
public sealed record CompletionManifest
{
    public required string Model { get; init; }
    /// <summary>Where it was built from: the repository and the revision of its weights.</summary>
    public string Source { get; init; } = "";
    /// <summary>How a request becomes the model's prompt: <c>qwen</c> (ChatML), <c>qwen35</c> (ChatML, thinking off) or <c>phi</c>.</summary>
    public required string Family { get; init; }
    /// <summary>Each file's SHA-256, lower-case hex.</summary>
    public required Dictionary<string, string> Files { get; init; }
    /// <summary>A stand-in for tests (outside Production only): its own hashes are taken, not the pinned ones.</summary>
    public bool Test { get; init; }
}

/// <summary>
/// Completions written on this server (Phase 18, M18.1; the spike's model and runtime): an
/// instruction model on ONNX Runtime GenAI over the same ONNX Runtime as the embedding model, on the
/// processor, one answer at a time a process, the rest waiting their turn in order (at most
/// <see cref="CompletionModelOptions.Queue"/>; past it 503 <c>ai.limit</c>), loaded on first use and
/// let go when unused. No text leaves the host. The request is <see cref="AiRequestBuilder"/>'s, as it
/// is for Anthropic: its system and user text in the model's own turns, its token limit, and for a
/// JSON action its schema held while the answer is made (GenAI's guidance). A package is loaded only
/// when each file's SHA-256 is the pinned one (a stand-in's own outside Production).
/// </summary>
public sealed class LocalCompletionProvider(CompletionModelOptions options, ILogger<LocalCompletionProvider> logger) : IAiProvider, IDisposable
{
    public const string ProviderId = "local";

    public string Id => ProviderId;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { NumberHandling = JsonNumberHandling.Strict };

    // GenAI's process-wide state, made once and kept until the process ends.
    private static readonly Lazy<OgaHandle> Oga = new(() => new OgaHandle());

    private readonly SemaphoreSlim loading = new(1, 1);
    private Loaded? loaded;
    private long lastUsed;
    private Timer? idleTimer;

    // The line: the answer being written, and those waiting, in order.
    private readonly Lock sync = new();
    private readonly LinkedList<TaskCompletionSource> line = new();
    private bool writing;

    private sealed record Loaded(CompletionManifest Manifest, Config Config, Model Model, Tokenizer Tokenizer) : IDisposable
    {
        public void Dispose()
        {
            Tokenizer.Dispose();
            Model.Dispose();
            Config.Dispose();
        }
    }

    /// <summary>Whether the model is in memory now (for tests and the bench).</summary>
    public bool IsLoaded => loaded is not null;

    /// <summary>Answers waiting now, the one being written not counted (for tests).</summary>
    public int Waiting
    {
        get
        {
            lock (sync) return line.Count;
        }
    }

    /// <summary>The package read and checked; null with the reason when it cannot be used.</summary>
    public static (CompletionManifest? Manifest, string? Problem) Check(string folder, bool production)
    {
        CompletionManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<CompletionManifest>(File.ReadAllText(Path.Combine(folder, CompletionModelOptions.ManifestFile)), Json);
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
            return (null, "the package's description could not be read");
        }
        if (manifest is null || manifest.Model != CompletionModelOptions.Model) return (null, "the package is not " + CompletionModelOptions.Model);
        if (manifest.Family is not ("qwen" or "qwen35" or "phi")) return (null, "the package's family is not one this server writes prompts for");
        if (manifest.Test && production) return (null, "a test package is refused in Production");
        var expected = manifest.Test ? manifest.Files : CompletionModelOptions.Pinned;
        if (expected.Count == 0) return (null, "no file of the package is pinned");
        foreach (var (name, hash) in expected)
        {
            var file = Path.Combine(folder, name);
            if (!File.Exists(file)) return (null, $"{name} is missing");
            using var stream = File.OpenRead(file);
            if (!string.Equals(Convert.ToHexStringLower(SHA256.HashData(stream)), hash, StringComparison.Ordinal))
                return (null, $"{name} is not the file pinned for it");
        }
        return (manifest, null);
    }

    private async Task<Loaded> LoadAsync(CancellationToken ct)
    {
        if (loaded is { } ready) return ready;
        await loading.WaitAsync(ct);
        try
        {
            if (loaded is { } again) return again;
            if (options.Path is not { } folder) throw new AiProviderException(Codes.AiProvider, "No local completion model is installed on this server");
            var watch = Stopwatch.StartNew();
            var (manifest, problem) = await Task.Run(() => Check(folder, options.Production), ct);
            if (manifest is null) throw new AiProviderException(Codes.AiProvider, "The local completion model cannot be used: " + problem);
            _ = Oga.Value;
            try
            {
                var config = new Config(folder);
                config.ClearProviders();
                config.Overlay(JsonSerializer.Serialize(new
                {
                    model = new { decoder = new { session_options = new { intra_op_num_threads = options.Threads, inter_op_num_threads = 1 } } },
                }));
                var model = new Model(config);
                var tokenizer = new Tokenizer(model);
                loaded = new Loaded(manifest, config, model, tokenizer);
            }
            catch (OnnxRuntimeGenAIException error)
            {
                logger.LogWarning("The local completion model could not be loaded: {Error}", error.GetType().Name);
                throw new AiProviderException(Codes.AiProvider, "The local completion model could not be loaded");
            }
            logger.LogInformation("The local completion model {Model} is loaded ({Threads} threads, {Ms} ms)", manifest.Model, options.Threads, watch.ElapsedMilliseconds);
            idleTimer ??= new Timer(_ => LetGoIfIdle(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
            return loaded;
        }
        finally
        {
            loading.Release();
        }
    }

    /// <summary>The model's prompt for a request: the system and user text in its own turns, the assistant's opened.</summary>
    public static string Prompt(string family, AiRequest request) => family switch
    {
        "qwen" => $"<|im_start|>system\n{request.System}<|im_end|>\n<|im_start|>user\n{request.User}<|im_end|>\n<|im_start|>assistant\n",
        // Qwen3.5 thinks unless the turn opens with an empty think block (its template's enable_thinking=false).
        "qwen35" => $"<|im_start|>system\n{request.System}<|im_end|>\n<|im_start|>user\n{request.User}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
        "phi" => $"<|system|>{request.System}<|end|><|user|>{request.User}<|end|><|assistant|>",
        _ => throw new ArgumentOutOfRangeException(nameof(family)),
    };

    /// <summary>A place in the line: null to write at once, or the turn to wait for.</summary>
    private TaskCompletionSource? Enter()
    {
        lock (sync)
        {
            if (!writing && line.Count == 0)
            {
                writing = true;
                return null;
            }
            if (line.Count >= options.Queue) throw new AiProviderException(Codes.AiLimit, "The server's model is busy");
            var turn = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            line.AddLast(turn);
            return turn;
        }
    }

    /// <summary>How many answers are before this one (the one being written included).</summary>
    private int Ahead(TaskCompletionSource turn)
    {
        lock (sync)
        {
            var ahead = 1;
            for (var node = line.First; node is not null && node.Value != turn; node = node.Next) ahead++;
            return ahead;
        }
    }

    /// <summary>The next answer's turn, or the line empty.</summary>
    private void Leave()
    {
        lock (sync)
        {
            if (line.First is { } next)
            {
                line.RemoveFirst();
                next.Value.TrySetResult();
            }
            else writing = false;
        }
    }

    /// <summary>An answer that left the line before its turn; one whose turn came is passed on.</summary>
    private void Abandon(TaskCompletionSource turn)
    {
        lock (sync)
        {
            if (line.Remove(turn)) return;
        }
        if (turn.Task.IsCompletedSuccessfully) Leave();
    }

    public async IAsyncEnumerable<AiChunk> CompleteAsync(AiCall call, [EnumeratorCancellation] CancellationToken ct)
    {
        if (options.Path is null) throw new AiProviderException(Codes.AiProvider, "No local completion model is installed on this server");
        var turn = Enter();
        var mine = turn is null;
        try
        {
            yield return new AiStarted(CompletionModelOptions.Model);
            if (turn is not null)
            {
                var said = -1;
                while (!turn.Task.IsCompleted)
                {
                    var ahead = Ahead(turn);
                    if (ahead != said)
                    {
                        said = ahead;
                        yield return new AiQueued(ahead);
                    }
                    await Task.WhenAny(turn.Task, Task.Delay(TimeSpan.FromSeconds(1), ct));
                    ct.ThrowIfCancellationRequested();
                }
                mine = true;
            }
            var model = await LoadAsync(ct);
            await foreach (var chunk in WriteAsync(model, call.Request, ct))
                yield return chunk;
        }
        finally
        {
            Interlocked.Exchange(ref lastUsed, Environment.TickCount64);
            if (mine) Leave();
            else if (turn is not null) Abandon(turn);
        }
    }

    /// <summary>One answer, written on a thread of its own a token at a time and streamed as it comes.</summary>
    private async IAsyncEnumerable<AiChunk> WriteAsync(Loaded model, AiRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var pieces = Channel.CreateUnbounded<AiChunk>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var writer = Task.Factory.StartNew(() =>
        {
            try
            {
                Generate(model, request, pieces.Writer, stop.Token);
                pieces.Writer.TryComplete();
            }
            catch (Exception error)
            {
                pieces.Writer.TryComplete(error);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        try
        {
            while (true)
            {
                AiChunk next;
                try
                {
                    if (!await pieces.Reader.WaitToReadAsync(ct)) break;
                    if (!pieces.Reader.TryRead(out next!)) continue;
                }
                catch (OnnxRuntimeGenAIException error)
                {
                    logger.LogWarning("The local completion model failed: {Error}", error.GetType().Name);
                    throw new AiProviderException(Codes.AiProvider, "The local completion model failed");
                }
                yield return next;
            }
        }
        finally
        {
            // The person left, or the answer ended: the writing stops before the next answer's turn.
            await stop.CancelAsync();
            await writer;
        }
    }

    private static void Generate(Loaded model, AiRequest request, ChannelWriter<AiChunk> output, CancellationToken ct)
    {
        using var sequences = model.Tokenizer.Encode(Prompt(model.Manifest.Family, request));
        var input = sequences[0].Length;
        using var parameters = new GeneratorParams(model.Model);
        parameters.SetSearchOption("max_length", input + request.MaxTokens);
        if (request.Schema is { } schema) parameters.SetGuidance("json_schema", schema.GetRawText(), false);
        using var generator = new Generator(model.Model, parameters);
        generator.AppendTokenSequences(sequences);
        // The answer's tokens decoded whole each time and only what is new sent: a character made of
        // bytes in two tokens is sent once it is complete, never as a replacement character.
        var tokens = new List<int>(request.MaxTokens);
        var sent = 0;
        while (!generator.IsDone())
        {
            ct.ThrowIfCancellationRequested();
            generator.GenerateNextToken();
            tokens.Add(generator.GetNextTokens()[0]);
            var text = model.Tokenizer.Decode(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(tokens));
            var whole = text.Length;
            while (whole > sent && text[whole - 1] == '�') whole--;
            if (whole > sent)
            {
                output.TryWrite(new AiText(text[sent..whole]));
                sent = whole;
            }
        }
        var cut = tokens.Count >= request.MaxTokens;
        output.TryWrite(new AiFinished(cut ? AiFinished.Length : AiFinished.End, input, tokens.Count));
    }

    /// <summary>Lets the model go once unused for the idle time (another answer loads it again).</summary>
    private void LetGoIfIdle()
    {
        if (loaded is null || Environment.TickCount64 - Interlocked.Read(ref lastUsed) < options.Idle.TotalMilliseconds) return;
        lock (sync)
        {
            if (writing || line.Count > 0) return;
            if (!loading.Wait(0)) return;
            try
            {
                loaded?.Dispose();
                loaded = null;
                logger.LogInformation("The local completion model was let go after {Minutes} minutes unused", options.Idle.TotalMinutes);
            }
            finally
            {
                loading.Release();
            }
        }
    }

    public void Dispose()
    {
        idleTimer?.Dispose();
        loaded?.Dispose();
        loading.Dispose();
    }
}

/// <summary>
/// The completion provider the API calls (Phase 18): a call of the server's own model goes to
/// <see cref="LocalCompletionProvider"/>, on this server and nowhere else; any other to Anthropic.
/// </summary>
public sealed class AiProviderRouter(AnthropicProvider anthropic, LocalCompletionProvider local) : IAiProvider
{
    public string Id => "router";

    public IAsyncEnumerable<AiChunk> CompleteAsync(AiCall call, CancellationToken ct) =>
        CompletionModelOptions.IsLocal(call.Model) ? local.CompleteAsync(call, ct) : anthropic.CompleteAsync(call, ct);
}
