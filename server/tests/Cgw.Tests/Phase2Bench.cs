using System.Collections.Concurrent;
using DataColumn = System.Data.DataColumn;
using DataTable = System.Data.DataTable;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Cgw.Ydoc;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Cgw.Tests;

/// <summary>The benchmarks run alone, after the other tests, so nothing else shares the machine.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class Phase2BenchCollection
{
    public const string Name = "Phase 2 benchmarks";
}

/// <summary>
/// Phase 2's server budgets (IMPLEMENTATION_PLAN.md, Phase 2, Performance benchmarks), measured in
/// process on SQL Server and Azurite through the real API and worker, with the updates Yjs wrote in
/// bench/editor/src/phase2-corpus.test.ts. They run only when PHASE2_CORPUS names that folder
/// (bench/phase2.mjs sets it), so <c>pnpm server:test</c> skips them; build them with
/// <c>-c Release</c>. Each writes its figures into bench/results/phase2-server.json, which
/// phase2.mjs gates against the budgets and the last run on main.
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase2Bench(ServerFixture server)
{
    private static readonly string? Corpus = Environment.GetEnvironmentVariable("PHASE2_CORPUS");
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private static readonly Lock ResultsGate = new();

    private sealed record PushCorpus(long BaseClient, long Client, byte[] Base, List<byte[]> Edits);
    private sealed record BigCorpus(long BaseClient, long Client, byte[] Base, List<byte[]> Updates, long UpdateBytes, long MergedBytes);
    private sealed record LoadUser(long Client, string BlockId, string Text, List<byte[]> Edits, List<ulong> Ends);
    private sealed record LoadCorpus(long BaseClient, byte[] Base, List<LoadUser> Users);

    private static void SkipUnlessAsked() =>
        Assert.SkipWhen(string.IsNullOrEmpty(Corpus), "Set PHASE2_CORPUS to the corpus folder (pnpm bench:phase2 does)");

    private static T Load<T>(string file) =>
        JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(Corpus!, file)), Web)!;

    private static int Setting(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

    // ------------------------------------------------------------------ figures

    private static double Percentile(IReadOnlyCollection<double> values, double p)
    {
        if (values.Count == 0) return 0;
        var sorted = values.Order().ToArray();
        return sorted[Math.Min(sorted.Length - 1, Math.Max(0, (int)Math.Ceiling(p * sorted.Length) - 1))];
    }

    private static double Round(double value) => Math.Round(value, 1);

    private static JsonObject Stats(IReadOnlyCollection<double> ms) => new()
    {
        ["runs"] = ms.Count,
        ["p50"] = Round(Percentile(ms, 0.5)),
        ["p95"] = Round(Percentile(ms, 0.95)),
        ["max"] = ms.Count == 0 ? 0 : Round(ms.Max()),
        ["mean"] = ms.Count == 0 ? 0 : Round(ms.Average()),
    };

    private static double Ms(long started) => Stopwatch.GetElapsedTime(started).TotalMilliseconds;

    /// <summary>Puts one section into bench/results/phase2-server.json, with what ran it.</summary>
    private async Task Record(string section, JsonNode value)
    {
        var environment = await EnvironmentAsync();
        lock (ResultsGate)
        {
            var file = Path.Combine(server.Root, "bench", "results", "phase2-server.json");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var results = File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file))!.AsObject() : new JsonObject();
            results["environment"] = environment;
            results[section] = value;
            results["at"] = DateTimeOffset.UtcNow.ToString("O");
            File.WriteAllText(file, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        }
    }

    private async Task<bool> FullTextAsync()
    {
        await using var scope = server.Api.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<FullText>().AvailableAsync(scope.ServiceProvider.GetRequiredService<CgwDb>());
    }

    private async Task<JsonObject> EnvironmentAsync()
    {
        await using var db = server.NewDb();
        var edition = (await db.Database.SqlQueryRaw<string>("SELECT CAST(SERVERPROPERTY('Edition') AS nvarchar(200)) AS Value").ToListAsync()).Single();
        var version = (await db.Database.SqlQueryRaw<string>("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(200)) AS Value").ToListAsync()).Single();
        var local = server.ServerConnection.Contains("(localdb)", StringComparison.OrdinalIgnoreCase);
        return new JsonObject
        {
            ["os"] = RuntimeInformation.OSDescription,
            ["cores"] = Environment.ProcessorCount,
            ["memoryGB"] = Math.Round(GC.GetGCMemoryInfo().TotalAvailableMemoryBytes / 1073741824.0, 1),
            ["dotnet"] = RuntimeInformation.FrameworkDescription,
#if DEBUG
            ["configuration"] = "Debug",
#else
            ["configuration"] = "Release",
#endif
            ["sql"] = $"{(local ? "LocalDB " : "")}{edition} {version}",
            ["searchPath"] = await FullTextAsync() ? "fullText" : "like",
        };
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>A request timed from the first byte sent to the last byte of the answer read.</summary>
    private static async Task<(HttpResponseMessage Response, byte[] Body, double Ms)> Timed(HttpClient client, HttpMethod method, string url, object? body = null)
    {
        var started = Stopwatch.GetTimestamp();
        using var request = new HttpRequestMessage(method, url) { Content = body is null ? null : JsonContent.Create(body) };
        var response = await client.SendAsync(request);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        var ms = Ms(started);
        Assert.True(response.IsSuccessStatusCode, $"{method} {url}: {(int)response.StatusCode} {System.Text.Encoding.UTF8.GetString(bytes)}");
        return (response, bytes, ms);
    }

    private static object PushBody(params (Guid Id, byte[] Data)[] updates) => new
    {
        epoch = 0,
        clientSchemaVersion = 1,
        updates = updates.Select(u => new { updateId = u.Id, data = u.Data }).ToArray(),
    };

    private static async Task<T[]> InParallel<T>(int count, int degree, Func<int, Task<T>> make)
    {
        var results = new T[count];
        await Parallel.ForEachAsync(Enumerable.Range(0, count), new ParallelOptions { MaxDegreeOfParallelism = degree },
            async (i, _) => results[i] = await make(i));
        return results;
    }

    private async Task<(long Seq, long Head)> Heads(Guid page)
    {
        await using var db = server.NewDb();
        var row = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(p => p.Id == page)
            .Select(p => new { p.DocSeq, p.DocHeadSeq }).SingleAsync();
        return (row.DocSeq, row.DocHeadSeq);
    }

    /// <summary>Runs the worker's validation until every listed page's pushed updates are decided.</summary>
    private async Task ValidateAll(IReadOnlyCollection<Guid> pages)
    {
        for (var i = 0; i < 100; i++)
        {
            await server.RunJob<ValidateJob>(200);
            await using var db = server.NewDb();
            var waiting = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .CountAsync(p => pages.Contains(p.Id) && p.DocHeadSeq < p.DocSeq);
            if (waiting == 0) return;
        }
        throw new InvalidOperationException("The worker did not decide every pushed update.");
    }

    private static List<string> OrderKeysFor(int count)
    {
        var keys = new List<string>(count);
        string? last = null;
        for (var i = 0; i < count; i++) keys.Add(last = OrderKeys.Between(last, null));
        return keys;
    }

    /// <summary>A Yjs v1 state vector: client to the next clock it would write.</summary>
    private static Dictionary<ulong, ulong> StateVector(byte[] update)
    {
        var bytes = Yjs.StateVector(update);
        var at = 0;
        ulong Next()
        {
            ulong value = 0;
            for (var shift = 0; ; shift += 7)
            {
                var b = bytes[at++];
                value |= (ulong)(b & 0x7f) << shift;
                if (b < 0x80) return value;
            }
        }
        var vector = new Dictionary<ulong, ulong>();
        for (var n = Next(); n > 0; n--)
        {
            var client = Next();
            vector[client] = Next();
        }
        return vector;
    }

    // ------------------------------------------------------------------ push and pull

    /// <summary>Push round trip p95 ≤ 200 ms at the server; pull of 200 updates ≤ 300 ms.</summary>
    [Fact]
    public async Task Push_round_trips_and_pulls_of_200_updates()
    {
        SkipUnlessAsked();
        var corpus = Load<PushCorpus>("push.json");
        var pushes = Math.Min(corpus.Edits.Count, Setting("PHASE2_PUSHES", 300));
        Assert.True(pushes >= 200, "The corpus needs at least 200 keystrokes.");
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id, corpus.BaseClient, corpus.Client);
        var pushUrl = (Guid page) => $"/api/v1/pages/{page}/doc/updates";

        // Not counted: the first requests compile and pool what every later one uses.
        var warm = (await ws.NewPage("Warm-up")).GetProperty("id").GetGuid();
        await Timed(ws.Client, HttpMethod.Post, pushUrl(warm), PushBody((Guid.CreateVersion7(), corpus.Base)));
        foreach (var edit in corpus.Edits.Take(30))
            await Timed(ws.Client, HttpMethod.Post, pushUrl(warm), PushBody((Guid.CreateVersion7(), edit)));

        var page = (await ws.NewPage("Typing")).GetProperty("id").GetGuid();
        await Timed(ws.Client, HttpMethod.Post, pushUrl(page), PushBody((Guid.CreateVersion7(), corpus.Base)));
        var push = new List<double>();
        foreach (var edit in corpus.Edits.Take(pushes))
            push.Add((await Timed(ws.Client, HttpMethod.Post, pushUrl(page), PushBody((Guid.CreateVersion7(), edit)))).Ms);

        await ValidateAll([page, warm]);
        var (seq, head) = await Heads(page);
        Assert.Equal(1 + pushes, head);
        Assert.Equal(seq, head);

        // 200 validated updates after the cursor, as a device that last pulled 200 keystrokes ago.
        var after = head - 200;
        var pullUrl = $"/api/v1/pages/{page}/doc?after={after}";
        for (var i = 0; i < 3; i++) await Timed(ws.Client, HttpMethod.Get, pullUrl);
        var pull = new List<double>();
        long bytes = 0;
        for (var i = 0; i < Setting("PHASE2_PULLS", 30); i++)
        {
            var answer = await Timed(ws.Client, HttpMethod.Get, pullUrl);
            pull.Add(answer.Ms);
            bytes = answer.Body.Length;
            using var json = JsonDocument.Parse(answer.Body);
            Assert.Equal(200, json.RootElement.GetProperty("updates").GetArrayLength());
            Assert.Equal(JsonValueKind.Null, json.RootElement.GetProperty("snapshot").ValueKind);
        }

        var pushStats = Stats(push);
        pushStats["updateBytesP50"] = Round(Percentile(corpus.Edits.Take(pushes).Select(e => (double)e.Length).ToList(), 0.5));
        await Record("push", pushStats);
        var pullStats = Stats(pull);
        pullStats["updates"] = 200;
        pullStats["responseBytes"] = bytes;
        await Record("pull200", pullStats);
    }

    // ------------------------------------------------------------------ the change feed

    /// <summary>Change feed: 1,000 changes ≤ 500 ms.</summary>
    [Fact]
    public async Task The_change_feed_of_1000_changes()
    {
        SkipUnlessAsked();
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();

        // 1,000 pages through the operations endpoint, as clients make them: 50 with 19 under each.
        var started = Stopwatch.GetTimestamp();
        var keys = OrderKeysFor(50);
        var childKeys = OrderKeysFor(19);
        for (var batch = 0; batch < 10; batch++)
        {
            var ops = new List<JsonObject>();
            for (var p = batch * 5; p < batch * 5 + 5; p++)
            {
                var parent = Guid.CreateVersion7();
                ops.Add(ws.Op("page.create", parent, Ws.Page(parent, ws.Id, ws.Shared, null, keys[p], $"Project {p}")));
                for (var c = 0; c < 19; c++)
                {
                    var child = Guid.CreateVersion7();
                    ops.Add(ws.Op("page.create", child, Ws.Page(child, ws.Id, ws.Shared, parent, childKeys[c], $"Project {p} task {c}")));
                }
            }
            var results = await ws.Push([.. ops]);
            Assert.All(results.EnumerateArray(), r => Assert.Equal("applied", r.GetProperty("status").GetString()));
        }
        var seedMs = Ms(started);

        var url = $"/api/v1/workspaces/{ws.Id}/changes?after={cursor}&limit=1000";
        for (var i = 0; i < 3; i++) await Timed(member.Client, HttpMethod.Get, url);
        var feed = new List<double>();
        long bytes = 0;
        for (var i = 0; i < Setting("PHASE2_FEEDS", 30); i++)
        {
            var answer = await Timed(member.Client, HttpMethod.Get, url);
            feed.Add(answer.Ms);
            bytes = answer.Body.Length;
            using var json = JsonDocument.Parse(answer.Body);
            Assert.Equal(1000, json.RootElement.GetProperty("changes").GetArrayLength());
        }
        var stats = Stats(feed);
        stats["changes"] = 1000;
        stats["caller"] = "member";
        stats["responseBytes"] = bytes;
        stats["seedMs"] = Round(seedMs);
        await Record("feed1000", stats);
    }

    // ------------------------------------------------------------------ search

    private static readonly string[] English =
    [
        "invoice", "budget", "review", "ledger", "audit", "warehouse", "forecast", "quarterly", "report", "customer",
        "contract", "payroll", "supplier", "tax", "return", "shipment", "inventory", "count", "cash", "flow",
        "board", "meeting", "project", "plan", "sales", "target", "account", "balance", "expense", "claim",
        "purchase", "order", "delivery", "schedule", "pricing", "discount", "margin", "receipt", "vendor", "statement",
    ];

    private static readonly string[] Arabic =
    [
        "فاتورة", "ميزانية", "مراجعة", "دفتر", "تدقيق", "مستودع", "توقعات", "تقرير", "العميل", "عقد",
        "الرواتب", "المورد", "الضريبة", "إقرار", "الشحنة", "المخزون", "جرد", "النقد", "التدفق", "اجتماع",
        "المجلس", "خطة", "المشروع", "المبيعات", "الهدف", "حساب", "الرصيد", "المصروفات", "مطالبة", "طلب",
    ];

    private static readonly string[] Queries =
    [
        "invoice", "budget rev", "ledger aud", "warehouse forecast", "quarterly report", "customer contract", "payroll",
        "supplier inv", "tax ret", "shipment", "inventory count", "cash flow", "board meet", "project plan", "sales tar",
        "فاتوره", "ميزانيه تقرير", "مستودع", "حساب عقد", "العميل", "تقرير", "الرواتب", "المورد", "الضريبه", "الشحنه",
        "جرد المخزون", "التدفق النقد", "اجتماع المجلس", "خطه المشروع", "المبيعات",
    ];

    /// <summary>Search p95 ≤ 300 ms at 10,000 pages, in English and Arabic.</summary>
    [Fact]
    public async Task Search_at_10000_pages()
    {
        SkipUnlessAsked();
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var count = Setting("PHASE2_SEARCH_PAGES", 10_000);

        // Pages and the worker's derived text written straight in with SqlBulkCopy: search reads only
        // these rows (Pages, PageAncestors for access, PageDocDerived), as SearchTests does one by one.
        var random = new Random(20261112);
        string Words(int n) => string.Join(' ', Enumerable.Range(0, n).Select(_ =>
            random.Next(3) == 0 ? Arabic[random.Next(Arabic.Length)] : English[random.Next(English.Length)]));
        var started = Stopwatch.GetTimestamp();
        var now = DateTimeOffset.UtcNow;
        var pages = new List<Page>(count);
        var ancestors = new List<PageAncestor>(count * 2);
        var derived = new List<PageDocDerived>(count);
        var parents = OrderKeysFor(100);
        var children = OrderKeysFor(count / 100);
        var json = Cgw.Core.Documents.DocService.Gzip("""{"type":"doc","content":[]}""");
        Guid parent = default;
        for (var i = 0; i < count; i++)
        {
            var top = i % (count / 100) == 0;
            var id = Guid.CreateVersion7();
            if (top) parent = id;
            var title = (random.Next(2) == 0 ? Arabic[random.Next(Arabic.Length)] : English[random.Next(English.Length)]) + " " + Words(1 + random.Next(3));
            // One page in every 1,000 says a word no other does: the probe that full-text has caught up.
            var text = Words(60 + random.Next(120)) + (i % 1000 == 7 ? " zqxprobe" : "");
            pages.Add(new Page
            {
                Id = id,
                WorkspaceId = ws.Id,
                SectionId = ws.Shared,
                ParentPageId = top ? null : parent,
                OrderKey = top ? parents[i / (count / 100)] : children[i % (count / 100) - 1],
                Title = title,
                SearchTitle = TextNormaliser.Normalise(title),
                CreatedBy = ws.Account.Id,
                UpdatedBy = ws.Account.Id,
                CreatedAt = now,
                UpdatedAt = now.AddSeconds(-i),
            });
            ancestors.Add(new PageAncestor { PageId = id, AncestorPageId = id, Depth = 0, WorkspaceId = ws.Id });
            if (!top) ancestors.Add(new PageAncestor { PageId = id, AncestorPageId = parent, Depth = 1, WorkspaceId = ws.Id });
            derived.Add(new PageDocDerived
            {
                PageId = id,
                WorkspaceId = ws.Id,
                UpToSeq = 0,
                Json = json,
                PlainText = text,
                SearchText = TextNormaliser.Normalise(text),
                UpdatedAt = now,
            });
        }
        await BulkInsert(pages);
        await BulkInsert(ancestors);
        await BulkInsert(derived);
        var seedMs = Ms(started);

        // Full-text indexes the rows in its own time: wait until it has all of them.
        var full = await FullTextAsync();
        if (Environment.GetEnvironmentVariable("CGW_TEST_FULLTEXT") == "required")
            Assert.True(full, "CGW_TEST_FULLTEXT=required, but search is not using full-text");
        var populating = Stopwatch.GetTimestamp();
        string Url(string q) => $"/api/v1/workspaces/{ws.Id}/search?q={Uri.EscapeDataString(q)}&limit=50";
        if (full)
        {
            for (var i = 0; ; i++)
            {
                await using var db = server.NewDb();
                var state = (await db.Database.SqlQueryRaw<int>(
                    """
                    SELECT CAST(OBJECTPROPERTYEX(OBJECT_ID(N'dbo.PageDocDerived'), 'TableFullTextPendingChanges') AS int)
                        + CAST(OBJECTPROPERTYEX(OBJECT_ID(N'dbo.PageDocDerived'), 'TableFullTextPopulateStatus') AS int) AS Value
                    """).ToListAsync()).Single();
                if (state == 0)
                {
                    using var probe = JsonDocument.Parse((await Timed(member.Client, HttpMethod.Get, Url("zqxprobe"))).Body);
                    if (probe.RootElement.GetProperty("hits").GetArrayLength() == count / 1000) break;
                }
                if (i > 2400) throw new TimeoutException("Full-text did not finish populating in 10 minutes.");
                await Task.Delay(250);
            }
        }
        var populateMs = full ? Ms(populating) : 0;
        using (var probe = JsonDocument.Parse((await Timed(member.Client, HttpMethod.Get, Url("zqxprobe"))).Body))
            Assert.Equal(count / 1000, probe.RootElement.GetProperty("hits").GetArrayLength());

        // One pass not counted, then each query in turn, as the palette asks (the first page of 20).
        string Palette(string q) => $"/api/v1/workspaces/{ws.Id}/search?q={Uri.EscapeDataString(q)}";
        foreach (var q in Queries) await Timed(member.Client, HttpMethod.Get, Palette(q));
        var english = new List<double>();
        var arabic = new List<double>();
        var hits = new JsonObject();
        for (var round = 0; round < Setting("PHASE2_SEARCH_ROUNDS", 2); round++)
            foreach (var q in Queries)
            {
                var answer = await Timed(member.Client, HttpMethod.Get, Palette(q));
                (q.Any(c => c is >= (char)0x0600 and <= (char)0x06FF) ? arabic : english).Add(answer.Ms);
                using var result = JsonDocument.Parse(answer.Body);
                hits[q] = result.RootElement.GetProperty("hits").GetArrayLength();
            }
        var all = english.Concat(arabic).ToList();
        var stats = Stats(all);
        stats["pages"] = count;
        stats["path"] = full ? "fullText" : "like";
        stats["caller"] = "member";
        stats["english"] = Stats(english);
        stats["arabic"] = Stats(arabic);
        stats["seedMs"] = Round(seedMs);
        stats["populateMs"] = Round(populateMs);
        stats["hits"] = hits;
        await Record("search", stats);
    }

    /// <summary>Rows written with SqlBulkCopy, their columns and conversions read from EF's model.</summary>
    private async Task BulkInsert<T>(IReadOnlyList<T> rows) where T : class
    {
        await using var db = server.NewDb();
        var entity = db.Model.FindEntityType(typeof(T))!;
        var table = StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
        var columns = entity.GetProperties()
            .Select(p => (Property: p, Column: p.GetColumnName(table)!, Converter: p.GetValueConverter() ?? p.GetTypeMapping().Converter))
            .ToList();
        using var data = new DataTable();
        foreach (var (property, column, converter) in columns)
        {
            var type = converter?.ProviderClrType ?? property.ClrType;
            data.Columns.Add(column, Nullable.GetUnderlyingType(type) ?? type);
        }
        foreach (var row in rows)
            data.Rows.Add(columns.Select(c =>
            {
                var value = c.Property.PropertyInfo!.GetValue(row);
                return value is null ? DBNull.Value : c.Converter is { } converter ? converter.ConvertToProvider(value) ?? DBNull.Value : value;
            }).ToArray());
        using var bulk = new SqlBulkCopy(server.SqlConnection) { DestinationTableName = $"[{table.Name}]", BatchSize = 2000, BulkCopyTimeout = 600 };
        foreach (DataColumn column in data.Columns) bulk.ColumnMappings.Add(column.ColumnName, column.ColumnName);
        await bulk.WriteToServerAsync(data);
    }

    // ------------------------------------------------------------------ compaction

    /// <summary>Compaction of a 1 MB document ≤ 200 ms.</summary>
    [Fact]
    public async Task Compaction_of_a_1_MB_document()
    {
        SkipUnlessAsked();
        var corpus = Load<BigCorpus>("compaction.json");
        var runs = Setting("PHASE2_COMPACTIONS", 10);
        var ws = await Ws.Create(server);
        await Kit.Register(ws.Client, ws.Id, corpus.BaseClient, corpus.Client);
        var pages = new List<Guid>();
        var keys = OrderKeysFor(runs);
        for (var i = 0; i < runs; i++)
        {
            var page = (await ws.NewPage($"Long history {i}", orderKey: keys[i])).GetProperty("id").GetGuid();
            pages.Add(page);
            await Timed(ws.Client, HttpMethod.Post, $"/api/v1/pages/{page}/doc/updates", PushBody((Guid.CreateVersion7(), corpus.Base)));
            foreach (var chunk in corpus.Updates.Chunk(50))
                await Timed(ws.Client, HttpMethod.Post, $"/api/v1/pages/{page}/doc/updates", PushBody([.. chunk.Select(u => (Guid.CreateVersion7(), u))]));
        }
        await ValidateAll(pages);

        var merge = new List<double>();
        var compact = new List<double>();
        var step = new List<double>();
        var job = new List<double>();
        long mergedBytes = 0, compactedBytes = 0;
        foreach (var page in pages)
        {
            await using var scope = server.Worker.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
            db.Scope.Switch(ws.Id);
            var rows = await db.PageDocUpdates.AsNoTracking().Where(u => u.PageId == page && u.Status == UpdateStatus.Valid)
                .OrderBy(u => u.Seq).Select(u => u.Data).ToListAsync();
            Assert.Equal(1 + corpus.Updates.Count, rows.Count);

            // The step itself, in memory: the page's update rows merged, then garbage collected (cgw_compact).
            var started = Stopwatch.GetTimestamp();
            var merged = Yjs.Merge(rows);
            var mergedAt = Stopwatch.GetTimestamp();
            var compacted = Yjs.Compact(merged);
            merge.Add(Stopwatch.GetElapsedTime(started, mergedAt).TotalMilliseconds);
            compact.Add(Ms(mergedAt));
            step.Add(Ms(started));
            mergedBytes = merged.Length;
            compactedBytes = compacted.Length;
            if (page == pages[0]) Assert.Equal(Yjs.ToText(merged), Yjs.ToText(compacted));

            // The whole job, with nothing cached: rows read, merged, compacted, the blob written, the
            // snapshot committed and the rows deleted.
            var states = scope.ServiceProvider.GetRequiredService<DocStates>();
            states.Forget(page);
            var compactor = new CompactJob(states, scope.ServiceProvider.GetRequiredService<BlobStore>(), new NoFaults(), TimeProvider.System);
            started = Stopwatch.GetTimestamp();
            await compactor.CompactAsync(db, page, CancellationToken.None);
            job.Add(Ms(started));
            Assert.Equal(0, await db.PageDocUpdates.CountAsync(u => u.PageId == page));
        }
        var stats = Stats(step);
        stats["updates"] = 1 + corpus.Updates.Count;
        stats["updateBytes"] = corpus.UpdateBytes + corpus.Base.Length;
        stats["mergedBytes"] = mergedBytes;
        stats["compactedBytes"] = compactedBytes;
        stats["merge"] = Stats(merge);
        stats["compact"] = Stats(compact);
        stats["job"] = Stats(job);
        await Record("compaction", stats);
    }

    // ------------------------------------------------------------------ the load test

    /// <summary>One simulated person: an account, the workspaces they belong to, the page they type on.</summary>
    private sealed class Typist(int index, Account account, LoadUser corpus, Guid page, Guid[] workspaces)
    {
        public int Index { get; } = index;
        public Account Account { get; } = account;
        public LoadUser Corpus { get; } = corpus;
        public Guid Page { get; } = page;
        public Guid[] Workspaces { get; } = workspaces;
        public Dictionary<Guid, long> FeedCursors { get; } = [];
        public long DocCursor { get; set; }
        public bool WantDoc { get; set; } = true;
        public int Next { get; set; }
        public List<(Guid Id, int Edit)> Unsent { get; } = [];
        public HashSet<Guid> Seen { get; } = [];
        public List<Dictionary<ulong, ulong>> Snapshots { get; } = [];
        public HashSet<Guid> Rejected { get; } = [];
        public int Passes { get; set; }
        public int Acked { get; set; }
        public bool Finished { get; set; }
        public ulong[] Ends { get; set; } = [];
    }

    private sealed record PushedUpdate(Guid Id, int User, Guid Page, long Seq, ulong Client, ulong End, int Edit, double AckedAt);

    /// <summary>The run's shared state: what was pushed and seen, and every request's outcome.</summary>
    private sealed class LoadRun(TimeSpan timeout)
    {
        public Stopwatch Clock { get; } = Stopwatch.StartNew();
        public HttpClient Blob { get; } = new();
        public ConcurrentDictionary<Guid, PushedUpdate> Pushed { get; } = new();
        public ConcurrentDictionary<Guid, int> PushedBy { get; } = new();
        public ConcurrentDictionary<Guid, double> SeenByOther { get; } = new();
        public ConcurrentDictionary<string, ConcurrentBag<double>> Latency { get; } = new();
        public ConcurrentDictionary<string, int> Failures { get; } = new();
        public ConcurrentQueue<string> Samples { get; } = new();
        public long Requests;
        public long Errors;
        public long Timeouts;
        public int Finished;
        public volatile IReadOnlyDictionary<Guid, long>? FinalHeads;
        public TaskCompletionSource AllPushed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public double Now => Clock.Elapsed.TotalMilliseconds;

        public async Task<byte[]?> Send(string kind, HttpClient client, HttpMethod method, string url, object? body = null)
        {
            Interlocked.Increment(ref Requests);
            using var cancel = new CancellationTokenSource(timeout);
            var started = Stopwatch.GetTimestamp();
            try
            {
                using var request = new HttpRequestMessage(method, url) { Content = body is null ? null : JsonContent.Create(body) };
                using var response = await client.SendAsync(request, cancel.Token);
                var bytes = await response.Content.ReadAsByteArrayAsync(cancel.Token);
                Latency.GetOrAdd(kind, _ => new ConcurrentBag<double>()).Add(Ms(started));
                if (response.IsSuccessStatusCode) return bytes;
                Fail(kind, ((int)response.StatusCode).ToString(), System.Text.Encoding.UTF8.GetString(bytes));
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested)
            {
                Interlocked.Increment(ref Timeouts);
                Fail(kind, "timeout", url);
            }
            catch (Exception e)
            {
                Fail(kind, e.GetType().Name, e.Message);
            }
            return null;
        }

        private void Fail(string kind, string what, string detail)
        {
            Interlocked.Increment(ref Errors);
            Failures.AddOrUpdate($"{kind} {what}", 1, (_, n) => n + 1);
            if (Samples.Count < 20) Samples.Enqueue($"{kind} {what}: {(detail.Length > 300 ? detail[..300] : detail)}");
        }
    }

    /// <summary>One of the worker's jobs as it is, its runs timed.</summary>
    private sealed class TimedJob(IJob job) : IJob
    {
        public ConcurrentQueue<double> Runs { get; } = new();
        public string Name => job.Name;
        public TimeSpan Interval => job.Interval;

        public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
        {
            var started = Stopwatch.GetTimestamp();
            try
            {
                return await job.RunAsync(services, ct);
            }
            finally
            {
                Runs.Enqueue(Ms(started));
            }
        }
    }

    /// <summary>Counts what the worker's job loop logs as failed.</summary>
    private sealed class JobLog : ILogger<JobLoop>
    {
        public int Errors;
        public ConcurrentQueue<string> Messages { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Error;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel < LogLevel.Error) return;
            Interlocked.Increment(ref Errors);
            if (Messages.Count < 20) Messages.Enqueue($"{formatter(state, exception)}: {exception?.GetType().Name} {exception?.Message}");
        }
    }

    /// <summary>
    /// Load test: 200 people editing at once, no missed update, no error above 0.1%. Each person is
    /// an account in two workspaces, typing on a page with three others; every pass is the sync
    /// engine's (packages/workspace/src/sync/engine.ts): push the page's unsent keystrokes, pull the
    /// feed of each workspace, pull the page when the feed says its head moved, list the workspaces
    /// every tenth pass. A pass runs every 500 ms while typing, as autosave (500 ms at most) and the
    /// engine's kick do. The worker's job loop runs all its jobs as in production (validation every
    /// 100 ms; compaction after 200 updates). Then: every update a person was told was stored must
    /// have reached every reader of its page, as a row or inside a snapshot, and the page rebuilt
    /// from the server must hold every person's text.
    /// </summary>
    [Fact]
    public async Task Two_hundred_people_typing_and_no_update_is_missed()
    {
        SkipUnlessAsked();
        var corpus = Load<LoadCorpus>("load.json");
        var users = Math.Min(Setting("PHASE2_LOAD_USERS", 200), corpus.Users.Count);
        var seconds = Setting("PHASE2_LOAD_SECONDS", 60);
        var spaces = Setting("PHASE2_LOAD_WORKSPACES", 5);
        var perPage = Setting("PHASE2_LOAD_PER_PAGE", 4);
        var interval = Setting("PHASE2_LOAD_INTERVAL_MS", 500);
        var timeout = TimeSpan.FromSeconds(Setting("PHASE2_LOAD_TIMEOUT_S", 10));
        // 200 simulated people share this process with the API and the worker: enough threads that
        // a burst of continuations is not queued behind the pool's slow growth.
        ThreadPool.GetMinThreads(out var workers, out var ports);
        ThreadPool.SetMinThreads(Math.Max(workers, 128), Math.Max(ports, 128));

        // Setup: owners, their workspaces and pages; people signed up, invited and accepted.
        var setup = Stopwatch.GetTimestamp();
        var workspaces = new List<Ws>();
        for (var w = 0; w < spaces; w++) workspaces.Add(await Ws.Create(server));
        var accounts = await InParallel(users, 8, i => server.NewAccount($"Typist {i + 1}"));
        await InParallel(users, 8, async i =>
        {
            await Kit.Join(server, workspaces[i % spaces], "member", accounts[i]);
            if (spaces > 1) await Kit.Join(server, workspaces[(i + 1) % spaces], "member", accounts[i]);
            return true;
        });
        var pageOf = new Guid[users];
        var loadPages = new List<Guid>();
        for (var w = 0; w < spaces; w++)
        {
            var ws = workspaces[w];
            var mine = Enumerable.Range(0, users).Where(i => i % spaces == w).ToList();
            var count = (mine.Count + perPage - 1) / perPage;
            var keys = OrderKeysFor(count);
            await Kit.Register(ws.Client, ws.Id, corpus.BaseClient);
            for (var p = 0; p < count; p++)
            {
                var page = (await ws.NewPage($"Load page {w}.{p}", orderKey: keys[p])).GetProperty("id").GetGuid();
                loadPages.Add(page);
                await Timed(ws.Client, HttpMethod.Post, $"/api/v1/pages/{page}/doc/updates", PushBody((Guid.CreateVersion7(), corpus.Base)));
                foreach (var i in mine.Skip(p * perPage).Take(perPage)) pageOf[i] = page;
            }
        }
        await ValidateAll(loadPages);
        var typists = await InParallel(users, 8, async i =>
        {
            var home = workspaces[i % spaces];
            await Kit.Register(accounts[i].Client, home.Id, corpus.Users[i].Client);
            var mine = spaces > 1 ? new[] { home.Id, workspaces[(i + 1) % spaces].Id } : [home.Id];
            var typist = new Typist(i, accounts[i], corpus.Users[i], pageOf[i], mine);
            // The first sync: each workspace's tree and the feed's cursor.
            foreach (var w in mine)
                typist.FeedCursors[w] = (await workspaces.First(x => x.Id == w).Tree(accounts[i].Client)).GetProperty("cursor").GetInt64();
            typist.Ends = [.. typist.Corpus.Ends];
            return typist;
        });
        // The ends are exclusive, as a state vector's clocks are.
        Assert.Equal(typists[0].Ends[0], StateVector(typists[0].Corpus.Edits[0])[(ulong)typists[0].Corpus.Client]);
        var setupMs = Ms(setup);

        // The worker, as production runs it: one loop over every job.
        var jobLog = new JobLog();
        var timedJobs = server.Worker.GetServices<IJob>().Select(j => new TimedJob(j)).ToList();
        var loop = new JobLoop(server.Worker, timedJobs, jobLog, TimeProvider.System);
        await loop.StartAsync(CancellationToken.None);

        var run = new LoadRun(timeout);
        var typing = TimeSpan.FromSeconds(seconds);
        var deadline = typing + TimeSpan.FromSeconds(180);
        // The worker's progress: each page's validated head, four times a second, to tell how long an
        // update waited for validation before any reader could have it.
        var heads = new ConcurrentDictionary<Guid, List<(double At, long Head)>>();
        var backlog = new List<double>();
        using var sampling = new CancellationTokenSource();
        var sampler = Task.Run(async () =>
        {
            while (!sampling.IsCancellationRequested)
            {
                await using var db = server.NewDb();
                var rows = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(p => loadPages.Contains(p.Id))
                    .Select(p => new { p.Id, p.DocSeq, p.DocHeadSeq }).ToListAsync();
                var at = run.Now;
                foreach (var row in rows) heads.GetOrAdd(row.Id, _ => []).Add((at, row.DocHeadSeq));
                lock (backlog) backlog.Add(rows.Sum(r => r.DocSeq - r.DocHeadSeq));
                try
                {
                    await Task.Delay(250, sampling.Token);
                }
                catch (OperationCanceledException)
                {
                }
            }
        });
        var monitor = Task.Run(async () =>
        {
            await Task.WhenAny(run.AllPushed.Task, Task.Delay(deadline));
            while (run.Clock.Elapsed < deadline)
            {
                await using var db = server.NewDb();
                var pages = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(p => loadPages.Contains(p.Id))
                    .Select(p => new { p.Id, p.DocSeq, p.DocHeadSeq }).ToListAsync();
                if (run.AllPushed.Task.IsCompleted && pages.All(h => h.DocHeadSeq == h.DocSeq))
                {
                    run.FinalHeads = pages.ToDictionary(h => h.Id, h => h.DocHeadSeq);
                    return run.Clock.Elapsed.TotalMilliseconds;
                }
                await Task.Delay(100);
            }
            return -1;
        });
        double settledAt, ranFor;
        try
        {
            await Task.WhenAll(typists.Select(t => Task.Run(() => TypeAsync(t, run, typing, deadline, interval, users))));
            settledAt = await monitor;
            ranFor = run.Now;
        }
        finally
        {
            sampling.Cancel();
            await sampler;
            await loop.StopAsync(CancellationToken.None);
        }

        // Every update someone was told was stored, against what each reader of its page received.
        var pushed = run.Pushed.Values.ToList();
        var byPage = pushed.GroupBy(p => p.Page).ToDictionary(g => g.Key, g => g.ToList());
        long checkedPairs = 0, missedPairs = 0, asRows = 0;
        var missedUpdates = new HashSet<Guid>();
        foreach (var typist in typists)
            foreach (var update in byPage.GetValueOrDefault(typist.Page) ?? [])
            {
                checkedPairs++;
                if (typist.Seen.Contains(update.Id)) asRows++;
                else if (!typist.Snapshots.Any(s => s.TryGetValue(update.Client, out var clock) && clock >= update.End))
                {
                    missedPairs++;
                    missedUpdates.Add(update.Id);
                }
            }
        // And the page rebuilt from the server as a new device would: each person's text, whole.
        long missingInState = 0, textsWrong = 0;
        foreach (var page in loadPages)
        {
            var owner = workspaces.First(w => typists.Any(t => t.Page == page && t.Workspaces[0] == w.Id));
            var parts = new List<byte[]>();
            long after = 0;
            for (var more = true; more;)
            {
                using var answer = JsonDocument.Parse((await Timed(owner.Client, HttpMethod.Get, $"/api/v1/pages/{page}/doc?after={after}")).Body);
                var root = answer.RootElement;
                if (root.GetProperty("snapshot").ValueKind == JsonValueKind.Object)
                    parts.Add(await run.Blob.GetByteArrayAsync(root.GetProperty("snapshot").GetProperty("url").GetString()));
                parts.AddRange(root.GetProperty("updates").EnumerateArray().Select(u => u.GetProperty("data").GetBytesFromBase64()));
                after = root.GetProperty("cursor").GetInt64();
                more = root.GetProperty("more").GetBoolean();
            }
            var state = parts.Count == 1 ? parts[0] : Yjs.Merge(parts);
            var vector = StateVector(state);
            missingInState += (byPage.GetValueOrDefault(page) ?? []).Count(u => !(vector.TryGetValue(u.Client, out var clock) && clock >= u.End));
            var text = Yjs.ToText(state);
            textsWrong += typists.Where(t => t.Page == page).Count(t => !text.Contains(t.Corpus.Text[..t.Acked], StringComparison.Ordinal));
        }

        var visible = pushed.Where(p => run.SeenByOther.ContainsKey(p.Id))
            .Select(p => Math.Max(0, run.SeenByOther[p.Id] - p.AckedAt)).ToList();
        // When the first sample saw the page's head past each update: the wait for the worker, and
        // what is left of the wait above once it had passed it (the readers' feed and pull).
        double? ValidatedAt(PushedUpdate update) =>
            heads.TryGetValue(update.Page, out var samples) && samples.FirstOrDefault(s => s.Head >= update.Seq) is { At: > 0 } hit ? hit.At : null;
        var validation = new List<double>();
        var afterValidation = new List<double>();
        foreach (var update in pushed)
            if (ValidatedAt(update) is { } at)
            {
                validation.Add(Math.Max(0, at - update.AckedAt));
                if (run.SeenByOther.TryGetValue(update.Id, out var seen)) afterValidation.Add(Math.Max(0, seen - at));
            }
        var latency = new JsonObject();
        foreach (var (kind, values) in run.Latency.OrderBy(k => k.Key)) latency[kind] = Stats(values.ToList());
        var failures = new JsonObject();
        foreach (var (kind, n) in run.Failures.OrderBy(k => k.Key)) failures[kind] = n;
        var result = new JsonObject
        {
            ["users"] = users,
            ["workspaces"] = spaces,
            ["membershipsPerUser"] = Math.Min(2, spaces),
            ["pages"] = loadPages.Count,
            ["usersPerPage"] = perPage,
            ["passIntervalMs"] = interval,
            ["typingSeconds"] = seconds,
            ["timeoutSeconds"] = timeout.TotalSeconds,
            ["setupMs"] = Round(setupMs),
            ["ranForMs"] = Round(ranFor),
            ["settledAtMs"] = Round(settledAt),
            ["updatesPushed"] = pushed.Count,
            ["updatesUnacked"] = typists.Sum(t => t.Unsent.Count),
            // Each update against each reader of its page (the pusher included, as its device
            // records the update's sequence from the pull).
            ["updatesChecked"] = checkedPairs,
            ["servedAsRows"] = asRows,
            ["missed"] = missedPairs,
            ["missedUpdates"] = missedUpdates.Count,
            ["missingInState"] = missingInState,
            ["textsWrong"] = textsWrong,
            ["rejected"] = typists.Sum(t => t.Rejected.Count),
            ["snapshotsServed"] = typists.Sum(t => t.Snapshots.Count),
            ["requests"] = run.Requests,
            ["requestsPerSecond"] = Round(run.Requests / (ranFor / 1000)),
            ["errors"] = run.Errors,
            ["timeouts"] = run.Timeouts,
            ["errorRatePct"] = Math.Round(100.0 * run.Errors / Math.Max(1, run.Requests), 3),
            ["failures"] = failures,
            ["failureSamples"] = new JsonArray([.. run.Samples.Select(s => (JsonNode)s)]),
            ["workerErrors"] = jobLog.Errors,
            ["workerErrorSamples"] = new JsonArray([.. jobLog.Messages.Select(s => (JsonNode)s)]),
            // From the pusher's answer to another reader of the page holding the update.
            ["visibleToOthers"] = Stats(visible),
            // Each of the worker's jobs: how often it ran and how long its runs took.
            ["workerJobs"] = new JsonObject([.. timedJobs.Where(j => j.Runs.Count > 0).Select(j =>
                KeyValuePair.Create(j.Name, (JsonNode?)new JsonObject { ["totalMs"] = Round(j.Runs.Sum()), ["run"] = Stats(j.Runs.ToList()) }))]),
            // From the pusher's answer to the page's validated head passing it (sampled every 250 ms).
            ["validatedAfterAck"] = Stats(validation),
            ["seenAfterValidated"] = Stats(afterValidation),
            ["workerBacklog"] = Stats(backlog),
            ["latency"] = latency,
            ["caughtUp"] = typists.Count(t => t.Finished),
        };
        await Record("load", result);

        Assert.True(settledAt > 0, "The worker did not decide every update before the deadline.");
        Assert.Equal(0, missedPairs);
        Assert.Equal(0, missingInState);
        Assert.Equal(0, textsWrong);
    }

    /// <summary>One person's passes: typing until <paramref name="typing"/>, then until they hold the page's final head.</summary>
    private static async Task TypeAsync(Typist typist, LoadRun run, TimeSpan typing, TimeSpan deadline, int interval, int users)
    {
        await Task.Delay(Random.Shared.Next(interval));
        var stopped = false;
        while (run.Clock.Elapsed < deadline)
        {
            var started = run.Now;
            if (run.Clock.Elapsed < typing && typist.Next < typist.Corpus.Edits.Count)
            {
                var id = Guid.CreateVersion7();
                run.PushedBy[id] = typist.Index;
                typist.Unsent.Add((id, typist.Next++));
            }
            await PassAsync(typist, run);
            if (!stopped && run.Clock.Elapsed >= typing && typist.Unsent.Count == 0)
            {
                stopped = true;
                if (Interlocked.Increment(ref run.Finished) == users) run.AllPushed.TrySetResult();
            }
            if (stopped && run.FinalHeads is { } heads && typist.DocCursor >= heads[typist.Page] && !typist.WantDoc)
            {
                typist.Finished = true;
                return;
            }
            var wait = interval * (0.8 + 0.4 * Random.Shared.NextDouble()) - (run.Now - started);
            if (wait > 0) await Task.Delay(TimeSpan.FromMilliseconds(wait));
        }
    }

    private static async Task PassAsync(Typist typist, LoadRun run)
    {
        var client = typist.Account.Client;
        // 1. The page's unsent keystrokes, in one request; kept for the next pass if it fails.
        if (typist.Unsent.Count > 0)
        {
            var batch = typist.Unsent.ToList();
            var body = await run.Send("push", client, HttpMethod.Post, $"/api/v1/pages/{typist.Page}/doc/updates",
                PushBody([.. batch.Select(u => (u.Id, typist.Corpus.Edits[u.Edit]))]));
            if (body is not null)
            {
                using var json = JsonDocument.Parse(body);
                var now = run.Now;
                var seqs = json.RootElement.GetProperty("acks").EnumerateArray()
                    .ToDictionary(a => a.GetProperty("updateId").GetGuid(), a => a.GetProperty("seq").GetInt64());
                foreach (var (id, edit) in batch)
                {
                    if (!seqs.TryGetValue(id, out var seq)) continue;
                    run.Pushed[id] = new PushedUpdate(id, typist.Index, typist.Page, seq, (ulong)typist.Corpus.Client, typist.Ends[edit], edit, now);
                    typist.Acked = Math.Max(typist.Acked, edit + 1);
                }
                typist.Unsent.RemoveAll(u => seqs.ContainsKey(u.Id));
            }
        }
        // 2. The feed of each workspace, to its end.
        foreach (var workspace in typist.Workspaces)
            for (var more = true; more;)
            {
                var body = await run.Send("feed", client, HttpMethod.Get, $"/api/v1/workspaces/{workspace}/changes?after={typist.FeedCursors[workspace]}&limit=500");
                if (body is null) break;
                using var json = JsonDocument.Parse(body);
                foreach (var change in json.RootElement.GetProperty("changes").EnumerateArray())
                    if (change.GetProperty("entityType").GetString() == "page" && change.GetProperty("entityId").GetGuid() == typist.Page
                        && change.GetProperty("entity") is { ValueKind: JsonValueKind.Object } entity
                        && entity.GetProperty("page").GetProperty("docHeadSeq").GetInt64() > typist.DocCursor)
                        typist.WantDoc = true;
                typist.FeedCursors[workspace] = json.RootElement.GetProperty("cursor").GetInt64();
                more = json.RootElement.GetProperty("more").GetBoolean();
            }
        if (typist.Passes++ % 10 == 0) await run.Send("workspaces", client, HttpMethod.Get, "/api/v1/workspaces");
        // 3. The page, when its head moved.
        while (typist.WantDoc)
        {
            var body = await run.Send("pull", client, HttpMethod.Get, $"/api/v1/pages/{typist.Page}/doc?after={typist.DocCursor}");
            if (body is null) return;
            using var json = JsonDocument.Parse(body);
            var root = json.RootElement;
            if (root.GetProperty("snapshot").ValueKind == JsonValueKind.Object)
            {
                var bytes = await run.Send("snapshot", run.Blob, HttpMethod.Get, root.GetProperty("snapshot").GetProperty("url").GetString()!);
                if (bytes is null) return;
                typist.Snapshots.Add(StateVector(bytes));
            }
            var now = run.Now;
            foreach (var update in root.GetProperty("updates").EnumerateArray())
            {
                var id = update.GetProperty("updateId").GetGuid();
                typist.Seen.Add(id);
                if (run.PushedBy.TryGetValue(id, out var by) && by != typist.Index) run.SeenByOther.TryAdd(id, now);
            }
            foreach (var id in root.GetProperty("rejected").EnumerateArray()) typist.Rejected.Add(id.GetGuid());
            typist.DocCursor = root.GetProperty("cursor").GetInt64();
            typist.WantDoc = root.GetProperty("more").GetBoolean();
        }
    }
}
