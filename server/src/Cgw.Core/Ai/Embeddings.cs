using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Ai;

/// <summary>The <c>AiUsage.Action</c>s of the embeddings provider's calls (Phase 10).</summary>
public static class EmbeddingActions
{
    /// <summary>The worker embedding pages' chunks (no person).</summary>
    public const string Embed = "embed";
    /// <summary>A question embedded for search by meaning (the palette's or <c>ask</c>'s).</summary>
    public const string Search = "search";

    public static readonly string[] All = [Embed, Search];
}

/// <summary>
/// The server's embeddings settings (<c>Ai__*</c>, Phase 10): <c>Ai__VoyageBaseUrl</c> points the
/// provider elsewhere outside Production only (the mock in <c>tests/mocks/ai</c>);
/// <c>Ai__EmbeddingsCacheMb</c> caps the API's in-memory copies of the vectors (1,024);
/// <c>Ai__EmbeddingsFloor</c> is the least cosine similarity a page found by meaning must have,
/// and <c>Ai__EmbeddingsFloors__&lt;model&gt;</c> one model's; <c>Ai__EmbeddingsSettleSeconds</c> how long a
/// page is left unchanged before the worker embeds it (30).
/// </summary>
public sealed record EmbeddingsOptions(
    IReadOnlyList<string> Models,
    string? VoyageBaseUrl,
    long CacheBytes,
    double DefaultFloor,
    IReadOnlyDictionary<string, double> Floors,
    TimeSpan Settle,
    TimeSpan RetryDelay)
{
    public const string Provider = "voyage";

    /// <summary>Voyage's 4 series (decisions, 2026-11-18): the default first.</summary>
    public static readonly string[] DefaultModels = ["voyage-4", "voyage-4-large", "voyage-4-lite"];

    public const int Dimensions = 1024;
    /// <summary>At most this many texts in one call, and this many characters together.</summary>
    public const int MaxInputs = 128;
    public const int MaxCallChars = 100_000;
    /// <summary>A question for search by meaning: 1 to 1,000 characters after trimming.</summary>
    public const int MaxQuestion = 1_000;

    /// <summary>
    /// The floor when none is set: tuned on the mock (an unrelated page scores about 0, a page that
    /// shares the question's concepts 0.6 and more) and to be checked against Voyage's own scores
    /// (<c>A_real_embedding</c>).
    /// </summary>
    public const double FloorDefault = 0.3;

    public string DefaultModel => Models[0];

    public double FloorOf(string model) => Floors.TryGetValue(model, out var floor) ? floor : DefaultFloor;

    public static EmbeddingsOptions From(IConfiguration configuration, bool production)
    {
        var section = configuration.GetSection(AiOptions.Section);
        static double? Number(string? value) =>
            double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) && n is >= 0 and <= 1 ? n : null;
        var floors = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var child in section.GetSection("EmbeddingsFloors").GetChildren())
            if (Number(child.Value) is { } floor) floors[child.Key] = floor;
        var cacheMb = long.TryParse(section["EmbeddingsCacheMb"], NumberStyles.None, CultureInfo.InvariantCulture, out var mb) && mb > 0 ? mb : 1024;
        var settle = int.TryParse(section["EmbeddingsSettleSeconds"], NumberStyles.None, CultureInfo.InvariantCulture, out var s) ? s : 30;
        var retry = int.TryParse(section["EmbeddingsRetryMs"], NumberStyles.None, CultureInfo.InvariantCulture, out var r) ? r : 500;
        return new EmbeddingsOptions(
            DefaultModels,
            // The key goes only to Voyage's API in Production.
            production ? null : AiOptions.BaseUrl(section["VoyageBaseUrl"]),
            cacheMb * 1024 * 1024,
            Number(section["EmbeddingsFloor"]) ?? FloorDefault,
            floors,
            TimeSpan.FromSeconds(Math.Max(0, settle)),
            TimeSpan.FromMilliseconds(Math.Clamp(retry, 0, 10_000)));
    }
}

/// <summary>
/// The workspace's Voyage key, kept as Data Protection's output (purpose
/// <c>Cgw.Ai.EmbeddingsKey.v1</c>, bound to the workspace), opened only for the provider's call.
/// </summary>
public sealed class EmbeddingKeys(IDataProtectionProvider protection)
{
    public const string Purpose = "Cgw.Ai.EmbeddingsKey.v1";

    private IDataProtector For(Guid workspaceId) => protection.CreateProtector(Purpose, workspaceId.ToString("N"));

    public string Protect(Guid workspaceId, string key) => For(workspaceId).Protect(key);

    /// <summary>The key, or null when the cipher no longer opens.</summary>
    public string? Unprotect(Guid workspaceId, string cipher)
    {
        try
        {
            return For(workspaceId).Unprotect(cipher);
        }
        catch (CryptographicException)
        {
            return null;
        }
    }
}

/// <summary>One call to the embeddings provider: the texts, what they are, the model and the key (never logged).</summary>
public sealed record EmbeddingCall(IReadOnlyList<string> Inputs, string InputType, string Model, string ApiKey)
{
    public const string Document = "document";
    public const string Query = "query";

    // The key and the texts must not reach a log line through a record's generated ToString.
    public override string ToString() => $"EmbeddingCall {{ Inputs = {Inputs.Count}, InputType = {InputType}, Model = {Model} }}";
}

/// <summary>The vectors, in the inputs' order; the tokens the provider counted; the time it took.</summary>
public sealed record EmbeddingResult(IReadOnlyList<sbyte[]> Vectors, long Tokens, TimeSpan Took)
{
    public override string ToString() => $"EmbeddingResult {{ Vectors = {Vectors.Count}, Tokens = {Tokens} }}";
}

/// <summary>
/// An embeddings provider (Phase 10; INTEGRATIONS.md, AI): the worker and search by meaning are its
/// only callers. Failures throw <see cref="AiProviderException"/> with <c>ai.keyInvalid</c>,
/// <c>ai.limit</c> or <c>ai.provider</c>; the message never holds the key or a text.
/// </summary>
public interface IEmbeddingProvider
{
    string Id { get; }

    Task<EmbeddingResult> EmbedAsync(EmbeddingCall call, CancellationToken ct);
}

/// <summary>
/// Voyage AI's embeddings API over HTTP (Voyage has no C# SDK): <c>POST {base}/v1/embeddings</c>
/// with <c>{input, model, input_type, output_dimension: 1024, output_dtype: "int8", truncation:
/// true}</c> and the workspace's key as a bearer token. A 401 or 403 is <c>ai.keyInvalid</c>; 429 and
/// 5xx (and a connection that fails or times out) are tried twice more with a growing wait, then
/// <c>ai.limit</c> (429) or <c>ai.provider</c>; 60 s an attempt. The base is Voyage's unless
/// <c>Ai__VoyageBaseUrl</c> moved it, which Production never does.
/// </summary>
public sealed class VoyageProvider(EmbeddingsOptions options, HttpClient http) : IEmbeddingProvider
{
    public const string ProviderId = EmbeddingsOptions.Provider;
    public const string VoyageBaseUrl = "https://api.voyageai.com";
    private static readonly TimeSpan AttemptTimeout = TimeSpan.FromSeconds(60);
    private const int Attempts = 3;

    public string Id => ProviderId;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The request body, as Voyage's reference names its fields.</summary>
    public static Dictionary<string, object> Body(EmbeddingCall call) => new()
    {
        ["input"] = call.Inputs,
        ["model"] = call.Model,
        ["input_type"] = call.InputType,
        ["output_dimension"] = EmbeddingsOptions.Dimensions,
        ["output_dtype"] = "int8",
        ["truncation"] = true,
    };

    public async Task<EmbeddingResult> EmbedAsync(EmbeddingCall call, CancellationToken ct)
    {
        if (call.Inputs.Count is 0 or > EmbeddingsOptions.MaxInputs) throw new ArgumentException("1 to 128 inputs a call");
        var url = (options.VoyageBaseUrl ?? VoyageBaseUrl) + "/v1/embeddings";
        var took = Stopwatch.StartNew();
        for (var attempt = 1; ; attempt++)
        {
            string? failed;
            var code = Codes.AiProvider;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(Body(call), options: Json) };
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", call.ApiKey);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(AttemptTimeout);
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                    throw new AiProviderException(Codes.AiKeyInvalid, "The provider refused the workspace's key");
                if (response.IsSuccessStatusCode)
                {
                    var body = await response.Content.ReadFromJsonAsync<JsonElement>(Json, timeout.Token);
                    return Read(body, call.Inputs.Count, took.Elapsed);
                }
                var status = (int)response.StatusCode;
                if (status != 429 && status < 500)
                    throw new AiProviderException(Codes.AiProvider, $"The provider refused the call ({status})");
                code = status == 429 ? Codes.AiLimit : Codes.AiProvider;
                failed = $"status {status}";
            }
            catch (AiProviderException)
            {
                throw;
            }
            // A connection that failed, an answer cut short, or the attempt's own 60 s: tried again.
            // Only the caller's cancellation is not a failure.
            catch (Exception error) when (error is HttpRequestException or JsonException or OperationCanceledException)
            {
                if (ct.IsCancellationRequested) throw;
                failed = error.GetType().Name;
            }
            if (attempt >= Attempts)
                throw new AiProviderException(code, code == Codes.AiLimit ? "The provider is busy or the key's limit is reached" : $"The provider failed ({failed})");
            await Task.Delay(options.RetryDelay * (attempt * attempt), ct);
        }
    }

    /// <summary>Voyage's answer: <c>data[].embedding</c> (1,024 integers from -128 to 127) by <c>data[].index</c>, and <c>usage.total_tokens</c>.</summary>
    public static EmbeddingResult Read(JsonElement body, int expected, TimeSpan took)
    {
        AiProviderException Bad() => new(Codes.AiProvider, "The provider's answer was not understood");
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) throw Bad();
        var vectors = new sbyte[]?[expected];
        foreach (var item in data.EnumerateArray())
        {
            if (!item.TryGetProperty("index", out var index) || !index.TryGetInt32(out var at) || at < 0 || at >= expected || vectors[at] is not null) throw Bad();
            if (!item.TryGetProperty("embedding", out var embedding) || embedding.ValueKind != JsonValueKind.Array || embedding.GetArrayLength() != EmbeddingsOptions.Dimensions) throw Bad();
            var vector = new sbyte[EmbeddingsOptions.Dimensions];
            var i = 0;
            foreach (var value in embedding.EnumerateArray())
            {
                if (!value.TryGetInt32(out var n) || n is < sbyte.MinValue or > sbyte.MaxValue) throw Bad();
                vector[i++] = (sbyte)n;
            }
            vectors[at] = vector;
        }
        if (vectors.Any(v => v is null)) throw Bad();
        long tokens = 0;
        if (body.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object
            && usage.TryGetProperty("total_tokens", out var total) && total.TryGetInt64(out var t)) tokens = t;
        return new EmbeddingResult(vectors!, tokens, took);
    }
}

/// <summary>
/// What of a page is embedded (decisions, 2026-11-18): its title, a blank line, then the worker's
/// derived text, cut into chunks of about 2,000 characters at paragraph ends, then sentence ends,
/// then spaces, overlapping about 200, each chunk starting with the title's line; at most 200 a
/// page. Pure and deterministic, so the worker and search (for a hit's snippet) cut alike.
/// </summary>
public static class EmbeddingText
{
    public const int Target = 2_000;
    public const int Overlap = 200;
    public const int MaxChunks = 200;
    public const int MaxSnippet = 200;

    /// <summary>A chunk: its text as embedded (the title's line first), and its own part of the page's text.</summary>
    public sealed record Chunk(string Text, string Own);

    /// <summary>The title as one line: line ends and runs of white space become one space.</summary>
    public static string TitleLine(string? title)
    {
        var builder = new StringBuilder();
        foreach (var c in title ?? "")
        {
            var space = char.IsWhiteSpace(c) || char.IsControl(c);
            if (space)
            {
                if (builder.Length > 0 && builder[^1] != ' ') builder.Append(' ');
            }
            else builder.Append(c);
        }
        if (builder.Length > 0 && builder[^1] == ' ') builder.Length--;
        return builder.ToString();
    }

    public static IReadOnlyList<Chunk> Chunks(string? title, string? text)
    {
        var head = TitleLine(title);
        var body = text ?? "";
        var chunks = new List<Chunk>();
        string Compose(string own) => head.Length == 0 ? own : own.Length == 0 ? head : head + "\n\n" + own;
        if (!body.Any(c => !char.IsWhiteSpace(c)))
        {
            if (head.Length > 0) chunks.Add(new Chunk(head, ""));
            return chunks;
        }
        var position = 0;
        while (position < body.Length && chunks.Count < MaxChunks)
        {
            var end = body.Length - position <= Target ? body.Length : CutAt(body, position);
            var own = body[position..end];
            if (own.Any(c => !char.IsWhiteSpace(c))) chunks.Add(new Chunk(Compose(own), own));
            if (end >= body.Length) break;
            // The next starts about 200 characters back, at the start of a word.
            var next = Math.Max(position + 1, end - Overlap);
            var space = body.IndexOfAny([' ', '\n', '\t', '\r'], next, end - next);
            if (space >= 0 && space + 1 < end) next = space + 1;
            if (next < body.Length && char.IsLowSurrogate(body[next])) next++;
            position = next;
        }
        return chunks;
    }

    /// <summary>Where a chunk starting at <paramref name="start"/> ends: past the last paragraph end, sentence end or space in its second half, else at 2,000.</summary>
    private static int CutAt(string body, int start)
    {
        var limit = start + Target;
        var half = start + Target / 2;
        for (var i = limit - 1; i >= half; i--)
            if (body[i] == '\n') return i + 1;
        for (var i = limit - 1; i >= half; i--)
            if (body[i] is ' ' or '\n' && i > 0 && body[i - 1] is '.' or '!' or '?' or '\u061F' or '\u06D4' or '\u3002' or ';')
                return i + 1;
        for (var i = limit - 1; i >= half; i--)
            if (char.IsWhiteSpace(body[i])) return i + 1;
        return char.IsHighSurrogate(body[limit - 1]) ? limit - 1 : limit;
    }

    public static byte[] Hash(string text) => SHA256.HashData(Encoding.UTF8.GetBytes(text));

    /// <summary>A hit's snippet: the start of the chunk's own text, white space made single, at most 200 characters.</summary>
    public static string Snippet(string own)
    {
        var line = TitleLine(own);
        if (line.Length <= MaxSnippet) return line;
        var cut = line.LastIndexOf(' ', MaxSnippet - 1);
        var end = cut > MaxSnippet / 2 ? cut : MaxSnippet - 1;
        if (char.IsHighSurrogate(line[end - 1])) end--;
        return line[..end] + "\u2026";
    }
}

/// <summary>Scores of int8 vectors: an integer dot product, and the norm that makes it a cosine.</summary>
public static class VectorMath
{
    public static float Norm(ReadOnlySpan<sbyte> vector)
    {
        long sum = 0;
        foreach (var v in vector) sum += v * v;
        return MathF.Sqrt(sum);
    }

    /// <summary>The dot product of two int8 vectors of the same length, in 32-bit integers.</summary>
    public static int Dot(ReadOnlySpan<sbyte> a, ReadOnlySpan<sbyte> b)
    {
        var i = 0;
        var total = 0;
        if (Avx2.IsSupported && a.Length >= 32)
        {
            var sum = Vector256<int>.Zero;
            ref var ra = ref MemoryMarshal.GetReference(a);
            ref var rb = ref MemoryMarshal.GetReference(b);
            for (; i + 32 <= a.Length; i += 32)
            {
                var va = Vector256.LoadUnsafe(ref ra, (nuint)i);
                var vb = Vector256.LoadUnsafe(ref rb, (nuint)i);
                var aLow = Avx2.ConvertToVector256Int16(va.GetLower());
                var aHigh = Avx2.ConvertToVector256Int16(va.GetUpper());
                var bLow = Avx2.ConvertToVector256Int16(vb.GetLower());
                var bHigh = Avx2.ConvertToVector256Int16(vb.GetUpper());
                sum = Avx2.Add(sum, Avx2.MultiplyAddAdjacent(aLow, bLow));
                sum = Avx2.Add(sum, Avx2.MultiplyAddAdjacent(aHigh, bHigh));
            }
            total = Vector256.Sum(sum);
        }
        for (; i < a.Length; i++) total += a[i] * b[i];
        return total;
    }
}
