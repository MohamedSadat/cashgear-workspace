using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Ai;
using Cgw.LocalModel;
using Microsoft.Extensions.Logging.Abstractions;

namespace Cgw.Tests;

/// <summary>
/// Phase 13's local model budget (IMPLEMENTATION_PLAN.md, Phase 13, Performance benchmarks; the spike's
/// figures in DECISIONS.md): voyage-4-nano through <see cref="LocalEmbeddingProvider"/> as the worker
/// and the API run it, with the threads the server would give it (half the processors, at most 8, or
/// PHASE13_LOCAL_THREADS). A chunk is the chunker's full 2,000 characters, in English and in Arabic
/// (Arabic is about twice the tokens); a question is a short one in either language. p95 of each,
/// one text a call, after a warm-up; the load and the working set it adds are tracked. Runs only when
/// PHASE13_LOCAL_BENCH is set and CGW_LOCAL_MODEL names the real package's folder
/// (node scripts/local-model.mjs makes it); build with <c>-c Release</c>. Figures go into
/// bench/results/phase13-local-model.json.
/// </summary>
public sealed class Phase13LocalModelBench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE13_LOCAL_BENCH"));

    /// <summary>Set by the spike: a 2,000-character chunk in either language, p95, on the host's processor.</summary>
    public const double ChunkBudgetMs = 1_500;

    /// <summary>Set by the spike: a question in either language, p95 (the route embeds it before ranking).</summary>
    public const double QuestionBudgetMs = 100;

    private static readonly string[] English =
    [
        "The quarterly close is due on Friday, and every invoice must be matched to its purchase order first.",
        "Customers may return goods within thirty days for a full refund, provided the receipt is kept.",
        "The warehouse ships parcels every morning by courier, and late orders leave the next day.",
        "Each department submits its budget to finance before the end of the month for review.",
        "Annual leave is booked through the team's calendar and approved by the line manager.",
        "Vendors are paid on net thirty terms unless a different agreement was signed with them.",
        "The sales report lists every region's revenue, its margin and the change from last year.",
        "New employees receive a laptop, an access badge and a week of training in their first month.",
        "Stock counts are taken at each site twice a year, and differences are explained in writing.",
        "The board meets in the first week of each quarter to approve the plan and the forecast.",
    ];

    private static readonly string[] Arabic =
    [
        "يجب إغلاق الحسابات الفصلية يوم الجمعة، ومطابقة كل فاتورة مع أمر الشراء الخاص بها أولًا.",
        "يمكن للعملاء إرجاع البضائع خلال ثلاثين يومًا واسترداد أموالهم كاملة بشرط الاحتفاظ بالإيصال.",
        "يشحن المستودع الطرود كل صباح عبر شركة التوصيل، وتغادر الطلبات المتأخرة في اليوم التالي.",
        "يقدّم كل قسم ميزانيته إلى الإدارة المالية قبل نهاية الشهر لمراجعتها.",
        "تُحجز الإجازة السنوية من خلال تقويم الفريق ويوافق عليها المدير المباشر.",
        "يُدفع للموردين خلال ثلاثين يومًا ما لم يُوقّع معهم اتفاق مختلف.",
        "يعرض تقرير المبيعات إيرادات كل منطقة وهامشها والتغير عن العام الماضي.",
        "يحصل الموظفون الجدد على حاسوب محمول وبطاقة دخول وأسبوع من التدريب في شهرهم الأول.",
        "يُجرى جرد المخزون في كل موقع مرتين في السنة، وتُشرح الفروقات كتابيًا.",
        "يجتمع مجلس الإدارة في الأسبوع الأول من كل ربع لاعتماد الخطة والتوقعات.",
    ];

    private static readonly string[] Questions =
    [
        "How can a buyer get reimbursed?",
        "When is the quarterly close due?",
        "Who approves annual leave?",
        "كيف يمكن للمشتري استرجاع ماله؟",
        "متى يجب إغلاق الحسابات الفصلية؟",
        "من يوافق على الإجازة السنوية؟",
    ];

    private static int Setting(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

    private static double Percentile(IReadOnlyCollection<double> values, double p)
    {
        var sorted = values.Order().ToArray();
        return sorted[Math.Min(sorted.Length - 1, Math.Max(0, (int)Math.Ceiling(p * sorted.Length) - 1))];
    }

    private static JsonObject Stats(IReadOnlyCollection<double> ms) => new()
    {
        ["runs"] = ms.Count,
        ["p50"] = Math.Round(Percentile(ms, 0.5), 1),
        ["p95"] = Math.Round(Percentile(ms, 0.95), 1),
        ["max"] = Math.Round(ms.Max(), 1),
    };

    /// <summary>A chunk of the chunker's full length: the sentences in a shuffled order, cut at a space.</summary>
    private static string Chunk(string[] sentences, Random random)
    {
        var text = new StringBuilder();
        while (text.Length < EmbeddingText.Target)
            text.Append(sentences[random.Next(sentences.Length)]).Append(' ');
        var cut = text.ToString(0, EmbeddingText.Target);
        var space = cut.LastIndexOf(' ');
        return space > EmbeddingText.Target - 100 ? cut[..space] : cut;
    }

    [Fact]
    public async Task The_local_model_embeds_a_chunk_and_a_question_within_the_spikes_budget()
    {
        var folder = Environment.GetEnvironmentVariable("CGW_LOCAL_MODEL");
        Assert.SkipWhen(!Asked || string.IsNullOrEmpty(folder), "Set PHASE13_LOCAL_BENCH=1 and CGW_LOCAL_MODEL (bench/phase13.mjs --local-model does)");
        Assert.Null(LocalEmbeddingProvider.Check(folder!, production: true).Problem);
        var threads = Setting("PHASE13_LOCAL_THREADS", Math.Clamp(Environment.ProcessorCount / 2, 1, 8));
        var chunks = Setting("PHASE13_LOCAL_CHUNKS", 20);
        var questions = Setting("PHASE13_LOCAL_QUESTIONS", 40);
        using var provider = new LocalEmbeddingProvider(
            new LocalModelOptions(folder, threads, TimeSpan.FromMinutes(30), Production: true),
            NullLogger<LocalEmbeddingProvider>.Instance);
        var random = new Random(13);

        Task<EmbeddingResult> Embed(string text, string type) =>
            provider.EmbedAsync(new EmbeddingCall([text], type, LocalModelOptions.Model, ""), CancellationToken.None);

        GC.Collect();
        var before = Process.GetCurrentProcess().WorkingSet64;
        var loading = Stopwatch.GetTimestamp();
        await Embed(Questions[0], EmbeddingCall.Query);
        var loadMs = Stopwatch.GetElapsedTime(loading).TotalMilliseconds;
        var added = Process.GetCurrentProcess().WorkingSet64 - before;
        for (var i = 0; i < 3; i++)
        {
            await Embed(Chunk(English, random), EmbeddingCall.Document);
            await Embed(Questions[i], EmbeddingCall.Query);
        }

        async Task<(List<double> Ms, List<long> Tokens)> Time(Func<int, (string Text, string Type)> next, int count)
        {
            var ms = new List<double>();
            var tokens = new List<long>();
            for (var i = 0; i < count; i++)
            {
                var (text, type) = next(i);
                var t = Stopwatch.GetTimestamp();
                var result = await Embed(text, type);
                ms.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
                tokens.Add(result.Tokens);
                Assert.Single(result.Vectors);
            }
            return (ms, tokens);
        }

        var english = await Time(_ => (Chunk(English, random), EmbeddingCall.Document), chunks);
        var arabic = await Time(_ => (Chunk(Arabic, random), EmbeddingCall.Document), chunks);
        var asked = await Time(i => (Questions[i % Questions.Length], EmbeddingCall.Query), questions);
        var chunkP95 = Math.Max(Percentile(english.Ms, 0.95), Percentile(arabic.Ms, 0.95));
        var questionP95 = Percentile(asked.Ms, 0.95);

        var results = new JsonObject
        {
            ["environment"] = new JsonObject
            {
                ["os"] = RuntimeInformation.OSDescription,
                ["cores"] = Environment.ProcessorCount,
                ["threads"] = threads,
#if DEBUG
                ["build"] = "Debug",
#else
                ["build"] = "Release",
#endif
            },
            ["model"] = LocalModelOptions.Model,
            ["chunkChars"] = EmbeddingText.Target,
            ["budgets"] = new JsonObject { ["chunkMs"] = ChunkBudgetMs, ["questionMs"] = QuestionBudgetMs },
            ["load"] = new JsonObject { ["ms"] = Math.Round(loadMs), ["workingSetMb"] = Math.Round(added / 1048576.0) },
            ["chunkEnglish"] = Stats(english.Ms),
            ["chunkEnglishTokens"] = english.Tokens.Average(),
            ["chunkArabic"] = Stats(arabic.Ms),
            ["chunkArabicTokens"] = arabic.Tokens.Average(),
            ["question"] = Stats(asked.Ms),
            ["chunkP95"] = Math.Round(chunkP95, 1),
            ["questionP95"] = Math.Round(questionP95, 1),
            ["at"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        var file = Path.Combine(server.Root, "bench", "results", "phase13-local-model.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        Assert.True(chunkP95 <= ChunkBudgetMs, $"a chunk's p95 {chunkP95:0} ms");
        Assert.True(questionP95 <= QuestionBudgetMs, $"a question's p95 {questionP95:0} ms");
    }
}
