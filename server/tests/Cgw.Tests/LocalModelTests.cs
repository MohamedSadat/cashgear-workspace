using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Cgw.LocalModel;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Cgw.Tests;

/// <summary>
/// Phase 13, M13.4: the local embedding model. In CI the stand-in package (tests/fixtures/local-model:
/// the real graph's inputs and output, a byte tokenizer) runs through the same ONNX Runtime and
/// tokenizer code; the real voyage-4-nano package is tried when <c>CGW_LOCAL_MODEL</c> names its folder
/// (target/local-model/package, made by scripts/local-model.mjs). A workspace that chooses it needs no
/// key, and no text leaves the host for its embeddings.
/// </summary>
public sealed class LocalModelTests(ServerFixture server)
{
    private static LocalEmbeddingProvider Provider(string folder, bool production = false) =>
        new(new LocalModelOptions(folder, 1, TimeSpan.FromMinutes(30), production), NullLogger<LocalEmbeddingProvider>.Instance);

    private static double Cosine(sbyte[] a, sbyte[] b) => VectorMath.Dot(a, b) / (double)(VectorMath.Norm(a) * VectorMath.Norm(b));

    [Fact]
    public async Task The_stand_in_package_embeds_texts_as_int8_vectors_through_onnx_runtime()
    {
        using var provider = Provider(server.LocalModelPath);
        Assert.False(provider.IsLoaded);
        var result = await provider.EmbedAsync(new EmbeddingCall(["refund of the money", "refund of money", "zzzz qqqq"], EmbeddingCall.Document, LocalModelOptions.Model, ""), CancellationToken.None);
        Assert.True(provider.IsLoaded);
        Assert.Equal(3, result.Vectors.Count);
        Assert.All(result.Vectors, v => Assert.Equal(1024, v.Length));
        // Scaled as Voyage's int8: the largest value 127.
        Assert.All(result.Vectors, v => Assert.Equal(127, v.Max(x => Math.Abs((int)x))));
        Assert.True(result.Tokens > 0);
        // Texts sharing their words are nearer than one sharing none; the same text the same vector.
        Assert.True(Cosine(result.Vectors[0], result.Vectors[1]) > Cosine(result.Vectors[0], result.Vectors[2]));
        var again = await provider.EmbedAsync(new EmbeddingCall(["refund of the money"], EmbeddingCall.Document, LocalModelOptions.Model, ""), CancellationToken.None);
        Assert.Equal(result.Vectors[0], again.Vectors[0]);
        // A question is prefixed with the query prompt, a chunk with the document one: different vectors.
        var asked = await provider.EmbedAsync(new EmbeddingCall(["refund of the money"], EmbeddingCall.Query, LocalModelOptions.Model, ""), CancellationToken.None);
        Assert.NotEqual(result.Vectors[0], asked.Vectors[0]);
    }

    [Fact]
    public async Task A_package_is_loaded_only_when_its_files_are_the_ones_described_and_never_a_test_one_in_production()
    {
        Assert.Null(LocalEmbeddingProvider.Check(server.LocalModelPath, production: false).Problem);
        Assert.Contains("test package", LocalEmbeddingProvider.Check(server.LocalModelPath, production: true).Problem);
        var copy = Directory.CreateTempSubdirectory("cgw-local-model-").FullName;
        try
        {
            foreach (var file in Directory.GetFiles(server.LocalModelPath)) File.Copy(file, Path.Combine(copy, Path.GetFileName(file)));
            await File.AppendAllTextAsync(Path.Combine(copy, "merges.txt"), "a b\n");
            Assert.Equal("merges.txt is not the file pinned for it", LocalEmbeddingProvider.Check(copy, production: false).Problem);
            using var provider = Provider(copy);
            var error = await Assert.ThrowsAsync<AiProviderException>(() => provider.EmbedAsync(new EmbeddingCall(["x"], EmbeddingCall.Query, LocalModelOptions.Model, ""), CancellationToken.None));
            Assert.Equal(Codes.AiProvider, error.Code);
            File.Delete(Path.Combine(copy, "model.onnx"));
            Assert.Equal("model.onnx is missing", LocalEmbeddingProvider.Check(copy, production: false).Problem);
        }
        finally
        {
            Directory.Delete(copy, recursive: true);
        }
        // No package at all: the model is not offered, and a call says so.
        Assert.False(new LocalModelOptions(null, 1, TimeSpan.FromMinutes(1), false).Available);
        using var none = Provider(Path.Combine(Path.GetTempPath(), "cgw-no-model-" + Guid.NewGuid().ToString("N")));
        Assert.Equal(Codes.AiProvider, (await Assert.ThrowsAsync<AiProviderException>(() => none.EmbedAsync(new EmbeddingCall(["x"], EmbeddingCall.Query, LocalModelOptions.Model, ""), CancellationToken.None))).Code);
        // The real package's pinned hashes are what the package script printed (scripts/local-model.mjs).
        Assert.All(LocalModelOptions.Pinned.Values, h => Assert.Matches("^[0-9a-f]{64}$", h));
    }

    [Fact]
    public async Task The_router_sends_the_local_model_to_this_server_and_never_to_voyage()
    {
        var calls = 0;
        var voyage = new VoyageProvider(server.Api.Services.GetRequiredService<EmbeddingsOptions>(), new HttpClient(new CountingHandler(() => calls++)));
        using var local = Provider(server.LocalModelPath);
        var router = new EmbeddingRouter(voyage, local);
        var result = await router.EmbedAsync(new EmbeddingCall(["a question"], EmbeddingCall.Query, LocalModelOptions.Model, ""), CancellationToken.None);
        Assert.Single(result.Vectors);
        Assert.Equal(0, calls);
        await Assert.ThrowsAsync<AiProviderException>(() => router.EmbedAsync(new EmbeddingCall(["a question"], EmbeddingCall.Query, "voyage-4", "pa-key-0000000000000000"), CancellationToken.None));
        Assert.True(calls > 0);
    }

    private sealed class CountingHandler(Action counted) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            counted();
            throw new HttpRequestException("refused here");
        }
    }

    [Fact]
    public async Task A_workspace_on_the_local_model_needs_no_key_and_searches_by_meaning_on_this_server()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        // On with the local model and no key at all.
        var on = await EmbedKit.Put(ws.Client, ws.Id, new { enabled = true, model = LocalModelOptions.Model });
        Assert.True(on.IsSuccessStatusCode, await on.Content.ReadAsStringAsync());
        var settings = (await Kit.Json(on)).GetProperty("embeddings");
        Assert.True(settings.GetProperty("enabled").GetBoolean());
        Assert.Equal(LocalModelOptions.Model, settings.GetProperty("model").GetString());
        Assert.False(settings.GetProperty("hasKey").GetBoolean());

        var page = await EmbedKit.Page(server, ws, "Refund policy", "Customers may return goods for a refund of their money.");
        await EmbedKit.Page(server, ws, "Zebra", "qqq zzz xxx", orderKey: "a5");
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        var vectors = await EmbedKit.Vectors(server, ws.Id, page);
        Assert.NotEmpty(vectors);
        Assert.All(vectors, v => Assert.Equal(LocalModelOptions.Model, v.Model));
        // The stand-in reads bytes: a question sharing the page's words finds it first.
        var hits = await EmbedKit.Hits(member.Client, ws.Id, "refund of money for customers");
        Assert.Equal(page, hits[0].GetProperty("pageId").GetGuid());

        // Metered as any provider's calls, by the local model.
        await using var db = server.NewDb(ws.Id);
        var used = await db.AiUsage.Where(u => u.Action == EmbeddingActions.Embed || u.Action == EmbeddingActions.Search).ToListAsync();
        Assert.NotEmpty(used);
        Assert.All(used, u => Assert.Equal(LocalModelOptions.Model, u.Model));
        Assert.All(used, u => Assert.Equal("ok", u.Outcome));

        // Back to a Voyage model: needs its key again (none set: turned off).
        var back = await EmbedKit.Put(ws.Client, ws.Id, new { model = "voyage-4" });
        Assert.True(back.IsSuccessStatusCode);
        Assert.False((await Kit.Json(back)).GetProperty("embeddings").GetProperty("enabled").GetBoolean());
    }

    /// <summary>The real package, when CGW_LOCAL_MODEL names its folder: questions and chunks in both languages, timed.</summary>
    [Fact]
    public async Task A_real_local_model_when_its_package_is_named_in_the_environment()
    {
        var folder = Environment.GetEnvironmentVariable("CGW_LOCAL_MODEL");
        Assert.SkipWhen(string.IsNullOrEmpty(folder), "Set CGW_LOCAL_MODEL to the package's folder (node scripts/local-model.mjs makes it)");
        Assert.Null(LocalEmbeddingProvider.Check(folder!, production: true).Problem);
        using var provider = Provider(folder!, production: true);
        string[] documents =
        [
            "Refund policy\n\nCustomers may return goods within 30 days for a full refund of their money.",
            "سياسة الاسترداد\n\nيمكن للعملاء إرجاع البضائع خلال 30 يومًا واسترداد أموالهم كاملة.",
            "Holiday schedule\n\nThe office is closed on public holidays and every employee has annual leave.",
        ];
        var watch = Stopwatch.StartNew();
        var docs = (await provider.EmbedAsync(new EmbeddingCall(documents, EmbeddingCall.Document, LocalModelOptions.Model, ""), CancellationToken.None)).Vectors;
        var load = watch.Elapsed;
        foreach (var question in new[] { "How can a buyer get reimbursed?", "كيف يمكن للمشتري استرجاع ماله؟" })
        {
            var q = (await provider.EmbedAsync(new EmbeddingCall([question], EmbeddingCall.Query, LocalModelOptions.Model, ""), CancellationToken.None)).Vectors[0];
            // Both refund pages (English and Arabic) above the holiday page.
            Assert.True(Cosine(q, docs[0]) > Cosine(q, docs[2]), question);
            Assert.True(Cosine(q, docs[1]) > Cosine(q, docs[2]), question);
        }
        Console.WriteLine($"Loaded and embedded three chunks in {load.TotalMilliseconds:0} ms");
    }
}
