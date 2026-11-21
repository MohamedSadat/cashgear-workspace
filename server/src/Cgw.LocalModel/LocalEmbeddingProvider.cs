using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using Cgw.Core;
using Cgw.Core.Ai;

namespace Cgw.LocalModel;

/// <summary>
/// The local model's package as written by <c>scripts/local-model.mjs</c> (Phase 13, M13.4): a folder
/// holding <c>model.onnx</c> (token ids to the pooled, cut and normalised vector), the tokenizer's
/// <c>vocab.json</c> and <c>merges.txt</c>, and <c>cgw-model.json</c>, this description of them.
/// </summary>
public sealed record LocalModelManifest
{
    public required string Model { get; init; }
    /// <summary>Where it was exported from: the repository and the revision of its weights.</summary>
    public string Source { get; init; } = "";
    public int Dimensions { get; init; } = EmbeddingsOptions.Dimensions;
    /// <summary>The most tokens one text is cut to.</summary>
    public int MaxTokens { get; init; } = 2048;
    public required LocalPrompts Prompts { get; init; }
    /// <summary>Each file's SHA-256, lower-case hex.</summary>
    public required Dictionary<string, string> Files { get; init; }
    /// <summary>A stand-in for tests (outside Production only): its own hashes are taken, not the pinned ones.</summary>
    public bool Test { get; init; }
}

/// <summary>What each kind of text is prefixed with (the model's own prompts).</summary>
public sealed record LocalPrompts(string Document, string Query);

/// <summary>
/// Embeddings made on this server (Phase 13, M13.4; the spike's model and runtime): voyage-4-nano on
/// ONNX Runtime, on the processor, one text a run, one run at a time a process, its threads bounded,
/// loaded on first use and let go when unused (<see cref="LocalModelOptions.Idle"/>). No text leaves the
/// host. A package is loaded only when each file's SHA-256 is the pinned one (a stand-in's own outside
/// Production). Each vector is the model's own, cut to 1,024 dimensions and normalised in the graph,
/// then made int8 as Voyage's are: scaled so its largest value is 127. Failures are
/// <see cref="AiProviderException"/> with <c>ai.provider</c>, never holding a text.
/// </summary>
public sealed class LocalEmbeddingProvider(LocalModelOptions options, ILogger<LocalEmbeddingProvider> logger) : IEmbeddingProvider, IDisposable
{
    public const string ProviderId = "local";
    public const string ManifestFile = LocalModelOptions.ManifestFile;

    public string Id => ProviderId;

    private readonly SemaphoreSlim gate = new(1, 1);
    private Loaded? loaded;
    private long lastUsed;
    private Timer? idleTimer;

    private sealed record Loaded(LocalModelManifest Manifest, QwenTokenizer Tokenizer, InferenceSession Session) : IDisposable
    {
        public void Dispose() => Session.Dispose();
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { NumberHandling = JsonNumberHandling.Strict };

    /// <summary>Whether the model is in memory now (for tests and the bench).</summary>
    public bool IsLoaded => loaded is not null;

    /// <summary>The package read and checked; null with the reason when it cannot be used.</summary>
    public static (LocalModelManifest? Manifest, string? Problem) Check(string folder, bool production)
    {
        LocalModelManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<LocalModelManifest>(File.ReadAllText(Path.Combine(folder, ManifestFile)), Json);
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
            return (null, "the package's description could not be read");
        }
        if (manifest is null || manifest.Model != LocalModelOptions.Model) return (null, "the package is not " + LocalModelOptions.Model);
        if (manifest.Dimensions != EmbeddingsOptions.Dimensions) return (null, "the package's vectors are not 1,024 dimensions");
        if (manifest.Test && production) return (null, "a test package is refused in Production");
        var expected = manifest.Test ? manifest.Files : LocalModelOptions.Pinned;
        foreach (var name in new[] { "model.onnx", "vocab.json", "merges.txt" })
        {
            if (!expected.TryGetValue(name, out var hash)) return (null, $"{name} has no hash");
            var file = Path.Combine(folder, name);
            if (!File.Exists(file)) return (null, $"{name} is missing");
            using var stream = File.OpenRead(file);
            if (!string.Equals(Convert.ToHexStringLower(SHA256.HashData(stream)), hash, StringComparison.Ordinal))
                return (null, $"{name} is not the file pinned for it");
        }
        return (manifest, null);
    }

    private Loaded Load()
    {
        if (options.Path is not { } folder) throw new AiProviderException(Codes.AiProvider, "No local model is installed on this server");
        var watch = Stopwatch.StartNew();
        var (manifest, problem) = Check(folder, options.Production);
        if (manifest is null) throw new AiProviderException(Codes.AiProvider, "The local model cannot be used: " + problem);
        var tokenizer = QwenTokenizer.Load(Path.Combine(folder, "vocab.json"), Path.Combine(folder, "merges.txt"));
        var session = new SessionOptions
        {
            GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL,
            ExecutionMode = ExecutionMode.ORT_SEQUENTIAL,
            IntraOpNumThreads = options.Threads,
            InterOpNumThreads = 1,
        };
        var model = new InferenceSession(Path.Combine(folder, "model.onnx"), session);
        logger.LogInformation("The local embedding model {Model} is loaded ({Threads} threads, {Ms} ms)", manifest.Model, options.Threads, watch.ElapsedMilliseconds);
        return new Loaded(manifest, tokenizer, model);
    }

    public async Task<EmbeddingResult> EmbedAsync(EmbeddingCall call, CancellationToken ct)
    {
        if (call.Inputs.Count is 0 or > EmbeddingsOptions.MaxInputs) throw new ArgumentException("1 to 128 inputs a call");
        var took = Stopwatch.StartNew();
        await gate.WaitAsync(ct);
        try
        {
            try
            {
                loaded ??= Load();
            }
            catch (AiProviderException)
            {
                throw;
            }
            catch (Exception error) when (error is OnnxRuntimeException or IOException or InvalidDataException or JsonException or UnauthorizedAccessException)
            {
                logger.LogWarning("The local embedding model could not be loaded: {Error}", error.GetType().Name);
                throw new AiProviderException(Codes.AiProvider, "The local model could not be loaded");
            }
            var model = loaded;
            var prompt = call.InputType == EmbeddingCall.Query ? model.Manifest.Prompts.Query : model.Manifest.Prompts.Document;
            var vectors = new List<sbyte[]>(call.Inputs.Count);
            long tokens = 0;
            foreach (var text in call.Inputs)
            {
                ct.ThrowIfCancellationRequested();
                var ids = model.Tokenizer.Encode(prompt + text, model.Manifest.MaxTokens);
                tokens += ids.Count;
                vectors.Add(Int8(Run(model.Session, ids)));
            }
            return new EmbeddingResult(vectors, tokens, took.Elapsed);
        }
        catch (OnnxRuntimeException error)
        {
            logger.LogWarning("The local embedding model failed: {Error}", error.GetType().Name);
            throw new AiProviderException(Codes.AiProvider, "The local model failed");
        }
        finally
        {
            Interlocked.Exchange(ref lastUsed, Environment.TickCount64);
            idleTimer ??= new Timer(_ => LetGoIfIdle(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
            gate.Release();
        }
    }

    private static float[] Run(InferenceSession session, List<int> ids)
    {
        var input = new DenseTensor<long>(ids.Select(i => (long)i).ToArray(), [1, ids.Count]);
        var mask = new DenseTensor<long>(Enumerable.Repeat(1L, ids.Count).ToArray(), [1, ids.Count]);
        using var results = session.Run([NamedOnnxValue.CreateFromTensor("input_ids", input), NamedOnnxValue.CreateFromTensor("attention_mask", mask)]);
        return results[0].AsEnumerable<float>().ToArray();
    }

    /// <summary>A float vector as Voyage's int8: scaled so its largest value is 127 (a cosine reads it as the float).</summary>
    public static sbyte[] Int8(IReadOnlyList<float> vector)
    {
        if (vector.Count != EmbeddingsOptions.Dimensions) throw new AiProviderException(Codes.AiProvider, "The local model's vector is not 1,024 dimensions");
        var max = 0f;
        foreach (var v in vector)
        {
            if (!float.IsFinite(v)) throw new AiProviderException(Codes.AiProvider, "The local model's vector is not finite");
            max = Math.Max(max, Math.Abs(v));
        }
        var q = new sbyte[vector.Count];
        if (max == 0) return q;
        for (var i = 0; i < q.Length; i++) q[i] = (sbyte)Math.Clamp(MathF.Round(vector[i] / max * 127), -127, 127);
        return q;
    }

    /// <summary>Lets the model go once unused for the idle time (another use loads it again).</summary>
    private void LetGoIfIdle()
    {
        if (loaded is null || Environment.TickCount64 - Interlocked.Read(ref lastUsed) < options.Idle.TotalMilliseconds) return;
        if (!gate.Wait(0)) return;
        try
        {
            loaded?.Dispose();
            loaded = null;
            logger.LogInformation("The local embedding model was let go after {Minutes} minutes unused", options.Idle.TotalMinutes);
        }
        finally
        {
            gate.Release();
        }
    }

    public void Dispose()
    {
        idleTimer?.Dispose();
        loaded?.Dispose();
        gate.Dispose();
    }
}
