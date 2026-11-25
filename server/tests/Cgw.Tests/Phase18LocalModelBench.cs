using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Ai;
using Cgw.LocalModel;
using Microsoft.Extensions.Logging.Abstractions;

namespace Cgw.Tests;

/// <summary>
/// Phase 18's local completion budget (IMPLEMENTATION_PLAN.md, Phase 18, Performance benchmarks; the
/// spike's figures in DECISIONS.md): a rewrite of 2,000 characters ("improve"), in English and in
/// Arabic, through <see cref="LocalCompletionProvider"/> with <see cref="AiRequestBuilder"/>'s own
/// request and the local limits, as the API runs it, with the threads the server would give it (half
/// the processors, at most 8, or PHASE18_LOCAL_THREADS): the time to the answer's first text and to
/// its end, after a warm-up, the median and the slowest of PHASE18_LOCAL_RUNS (3) each. The load and
/// the working set it adds are tracked. Runs only when PHASE18_LOCAL_BENCH is set and
/// CGW_COMPLETION_MODEL names the real package's folder (node scripts/completion-model.mjs makes it);
/// build with <c>-c Release</c>. Figures go into bench/results/phase18-local-model.json.
/// </summary>
public sealed class Phase18LocalModelBench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE18_LOCAL_BENCH"));

    /// <summary>
    /// Set by the spike (DECISIONS.md, Phase 18): the answer's first text of a 2,000-character rewrite,
    /// either language, on the reference machine (Xeon E5-2680 v3, 8 threads), where this bench runs;
    /// on the production host the budget is 10 s, held by the host's own run.
    /// </summary>
    public const double FirstTextBudgetMs = 25_000;

    /// <summary>Set by the spike: the whole answer of the same rewrite on the reference machine (on the production host, 60 s).</summary>
    public const double WholeBudgetMs = 90_000;

    /// <summary>A meeting's notes of 2,000 characters, with the faults a rewrite improves.</summary>
    public const string English =
        "Last week the operations team met to talk about the new warehouse in Dammam, which is supposed to open at the start of next quarter but there is a number of things that are still not finished and we need to decide what we do about them. The racking was delivered on time, however the installation company told us they can only send two people instead of four, so the work will take longer than we planned, maybe three weeks instead of ten days. Khalid said he will call the supplier again and ask if they can add more staff, but he was not very hopeful because they have other projects at the same time.\n\n"
        + "The second problem is the barcode scanners. We ordered forty units and only twenty-five arrived, and five of those do not connect to the wireless network properly. IT thinks it is a firmware issue and they want to update all of them before the go-live, which means somebody has to collect them from the site and bring them to the office. Sara offered to do this on Thursday.\n\n"
        + "We also talked about the opening stock. Finance wants the opening balances to be loaded into the ERP no later than the 20th, so that the first month closes correctly. To do that, the counts from the old warehouse must be finished and checked, and the item master must be cleaned, because there are many duplicate items with slightly different names. Omar will prepare a list of the duplicates and send it to the category managers, who will decide which ones to keep.\n\n"
        + "Training for the warehouse staff was planned for the last week of the month. Some people asked if it could be done in Arabic and English, since not everyone is comfortable with English screens. The team agreed that this is a good idea and that the trainer should prepare short guides in both languages.\n\n"
        + "Finally, the budget. The project is about eight percent over budget, mostly because of the extra racking and the transport costs. The manager asked everyone to avoid new spending unless it is necessary, and to send any request for extra money to him first. The next meeting will be on Sunday at ten.";

    /// <summary>The same notes in Arabic, about 2,000 characters, with the faults of a hurried draft.</summary>
    public const string Arabic =
        "اجتمع فريق العمليات الأسبوع الماضي للحديث عن المستودع الجديد في الدمام، والذي من المفروض أن يفتح في بداية الربع القادم، لكن هناك عدد من الأمور التي لم تنتهي بعد ويجب أن نقرر ماذا نفعل بها. الأرفف وصلت في موعدها، لكن شركة التركيب قالت أنها تستطيع إرسال شخصين فقط بدل أربعة، لذلك العمل سوف يأخذ وقت أطول من المخطط، ربما ثلاثة أسابيع بدل عشرة أيام. خالد قال أنه سيتصل بالمورد مرة ثانية ويطلب منهم زيادة العمال، لكنه لم يكن متفائل كثيراً لأن عندهم مشاريع أخرى في نفس الوقت.\n\n"
        + "المشكلة الثانية هي أجهزة قراءة الباركود. طلبنا أربعين جهاز ووصل خمسة وعشرين فقط، وخمسة منها لا تتصل بالشبكة اللاسلكية بشكل صحيح. قسم تقنية المعلومات يعتقد أن المشكلة في البرنامج الثابت ويريدون تحديث جميع الأجهزة قبل التشغيل، وهذا يعني أن أحد يجب أن يجمعها من الموقع ويحضرها للمكتب. سارة عرضت أن تقوم بذلك يوم الخميس.\n\n"
        + "تكلمنا أيضاً عن مخزون الافتتاح. الإدارة المالية تريد إدخال أرصدة الافتتاح في نظام تخطيط الموارد في موعد لا يتجاوز يوم ٢٠، حتى يتم إقفال الشهر الأول بشكل صحيح. ولكي يتم ذلك يجب الانتهاء من جرد المستودع القديم ومراجعته، ويجب تنظيف بيانات الأصناف، لأن هناك أصناف كثيرة مكررة بأسماء مختلفة قليلاً. عمر سوف يجهز قائمة بالأصناف المكررة ويرسلها لمدراء الفئات، وهم سيقررون أي منها يتم الإبقاء عليه.\n\n"
        + "التدريب لموظفي المستودع كان مخطط له في الأسبوع الأخير من الشهر. بعض الموظفين سألوا إذا كان ممكن أن يكون التدريب بالعربي والإنجليزي، لأنه ليس الجميع مرتاح مع الشاشات الإنجليزية. الفريق وافق أن هذه فكرة جيدة وأن المدرب يجب أن يجهز أدلة قصيرة باللغتين.\n\n"
        + "وأخيراً الميزانية. المشروع تجاوز الميزانية بحوالي ثمانية بالمئة، وأغلب السبب هو الأرفف الإضافية وتكاليف النقل. المدير طلب من الجميع تجنب أي مصاريف جديدة إلا إذا كانت ضرورية، وإرسال أي طلب لمبالغ إضافية له أولاً. كذلك تم الاتفاق أن يكون هناك تقرير أسبوعي مختصر عن حالة المشروع يرسل لكل الأقسام، فيه ما تم إنجازه وما تبقى والمخاطر الجديدة إن وجدت، حتى لا يتفاجأ أحد بأي تأخير في آخر لحظة. نورة سوف تكتب أول تقرير وترسله يوم الثلاثاء، وبعدها يتناوب أعضاء الفريق على كتابته كل أسبوع. الاجتماع القادم سيكون يوم الأحد الساعة العاشرة.";

    private sealed record Run(double FirstText, double Whole, long InputTokens, long OutputTokens, string StopReason);

    private static async Task<Run> RewriteAsync(LocalCompletionProvider provider, string text, string language)
    {
        var input = AiRequestBuilder.Read(AiActions.Rewrite, JsonSerializer.SerializeToElement(new { text, instruction = "improve" }), AiLimits.Local);
        Assert.True(input.Ok, input.Failure?.Title);
        var request = AiRequestBuilder.Build(input.Value!, language, null, AiLimits.Local);
        var watch = Stopwatch.StartNew();
        double first = -1;
        AiFinished? done = null;
        await foreach (var chunk in provider.CompleteAsync(new AiCall(request, CompletionModelOptions.Model, ""), CancellationToken.None))
            switch (chunk)
            {
                case AiText t when first < 0 && t.Text.Trim().Length > 0:
                    first = watch.Elapsed.TotalMilliseconds;
                    break;
                case AiFinished f:
                    done = f;
                    break;
            }
        Assert.NotNull(done);
        return new Run(first, watch.Elapsed.TotalMilliseconds, done.InputTokens, done.OutputTokens, done.StopReason);
    }

    private static double Median(IEnumerable<double> values)
    {
        var sorted = values.Order().ToArray();
        return sorted.Length == 0 ? double.NaN : sorted[sorted.Length / 2];
    }

    [Fact]
    public async Task A_rewrite_of_2000_characters_on_the_servers_processor()
    {
        if (!Asked) return;
        var folder = Environment.GetEnvironmentVariable("CGW_COMPLETION_MODEL")
            ?? throw new InvalidOperationException("Set CGW_COMPLETION_MODEL to the completion model's package (node scripts/completion-model.mjs).");
        var threads = int.TryParse(Environment.GetEnvironmentVariable("PHASE18_LOCAL_THREADS"), out var t) && t > 0 ? t : Math.Clamp(Environment.ProcessorCount / 2, 1, 8);
        var runs = int.TryParse(Environment.GetEnvironmentVariable("PHASE18_LOCAL_RUNS"), out var r) && r > 0 ? r : 3;
        var (manifest, problem) = LocalCompletionProvider.Check(folder, production: false);
        Assert.True(manifest is not null, problem);
        Assert.False(manifest!.Test, "the bench measures the real package, not the tests' stand-in");
        Assert.InRange(English.Length, 1_900, 2_100);
        Assert.InRange(Arabic.Length, 1_900, 2_100);

        var options = new CompletionModelOptions(folder, threads, TimeSpan.FromMinutes(30), 8, Production: false);
        using var provider = new LocalCompletionProvider(options, NullLogger<LocalCompletionProvider>.Instance);
        var before = Process.GetCurrentProcess().WorkingSet64;
        var load = Stopwatch.StartNew();
        await RewriteAsync(provider, "Warm up.", "en");
        load.Stop();
        Process.GetCurrentProcess().Refresh();
        var loadedMb = (Process.GetCurrentProcess().WorkingSet64 - before) / 1048576;

        var figures = new JsonObject
        {
            ["threads"] = threads,
            ["runs"] = runs,
            ["model"] = manifest.Model,
            ["source"] = manifest.Source,
            ["loadMs"] = Math.Round(load.Elapsed.TotalMilliseconds),
            ["loadedMb"] = loadedMb,
        };
        foreach (var (language, text) in new[] { ("en", English), ("ar", Arabic) })
        {
            var all = new List<Run>();
            for (var i = 0; i < runs; i++) all.Add(await RewriteAsync(provider, text, language));
            figures[language] = new JsonObject
            {
                ["firstTextMedianMs"] = Math.Round(Median(all.Select(a => a.FirstText))),
                ["firstTextMaxMs"] = Math.Round(all.Max(a => a.FirstText)),
                ["wholeMedianMs"] = Math.Round(Median(all.Select(a => a.Whole))),
                ["wholeMaxMs"] = Math.Round(all.Max(a => a.Whole)),
                ["inputTokens"] = all[0].InputTokens,
                ["outputTokensMedian"] = Median(all.Select(a => (double)a.OutputTokens)),
                ["cut"] = all.Count(a => a.StopReason == AiFinished.Length),
            };
        }
        var results = Path.Combine(server.Root, "bench", "results");
        Directory.CreateDirectory(results);
        await File.WriteAllTextAsync(Path.Combine(results, "phase18-local-model.json"), figures.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

        foreach (var language in new[] { "en", "ar" })
        {
            Assert.True(figures[language]!["firstTextMaxMs"]!.GetValue<double>() <= FirstTextBudgetMs, $"{language}: first text over {FirstTextBudgetMs} ms");
            Assert.True(figures[language]!["wholeMaxMs"]!.GetValue<double>() <= WholeBudgetMs, $"{language}: the whole answer over {WholeBudgetMs} ms");
        }
    }
}
