using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Api.Identity;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Cgw.Core.Sharing;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.DependencyInjection;
using DataColumn = System.Data.DataColumn;
using DataTable = System.Data.DataTable;

namespace Cgw.Tests;

/// <summary>Phase 11's benchmarks run alone, one at a time, so nothing else shares the machine.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class Phase11BenchCollection
{
    public const string Name = "Phase 11 benchmarks";
}

/// <summary>
/// Phase 11's server budgets (IMPLEMENTATION_PLAN.md, Phase 11, Performance benchmarks), measured in
/// process through the real API on SQL Server, as Phase 2's are:
/// <list type="bullet">
/// <item>search, the change feed and the tree at 10,000 pages for a member in 20 of the workspace's 50
/// groups, with 500 group rows on pages at random depths beside restricted pages, people's and the
/// workspace's rows: search p95 ≤ 300 ms (the palette's queries, English and Arabic), the feed of
/// 1,000 changes ≤ 500 ms, the tree tracked; search and the tree also for a member in no group;</item>
/// <item>a sign-in by passkey, the API's own time p95 ≤ 200 ms: the options and the answer's POST,
/// the software authenticator's signing between them not timed;</item>
/// <item>a sign-in through single sign-on, the API's own time p95 ≤ 200 ms: the sign-on POST and the
/// callback, less the time the API waits on the provider (the mock, <c>tests/mocks/oidc</c>).
/// <see cref="Cgw.Api.Identity.SsoMetadata"/> owns its HTTP client (no <c>IHttpClientFactory</c>), so
/// that wait is read from the runtime's own <c>System.Net.Http</c> activities, one per request the
/// API sends to the provider (send to the answer's headers; the bodies are a few kilobytes on
/// loopback).</item>
/// </list>
/// They run only when PHASE11_BENCH is set (bench/phase11.mjs sets it), so <c>pnpm server:test</c>
/// skips them; build with <c>-c Release</c>. Figures go into bench/results/phase11-server.json, which
/// phase11.mjs gates against the budgets and the last run on main.
/// </summary>
[Collection(Phase11BenchCollection.Name)]
public sealed class Phase11Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE11_BENCH"));
    private static readonly Lock ResultsGate = new();
    public const double SearchBudgetMs = 300;
    public const double FeedBudgetMs = 500;
    public const double SignInBudgetMs = 200;

    private static void SkipUnlessAsked() => Assert.SkipWhen(!Asked, "Set PHASE11_BENCH=1 (bench/phase11.mjs does)");

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

    /// <summary>Puts one section into bench/results/phase11-server.json, with what ran it.</summary>
    private async Task Record(string section, JsonNode value)
    {
        var environment = await EnvironmentAsync();
        lock (ResultsGate)
        {
            var file = Path.Combine(server.Root, "bench", "results", "phase11-server.json");
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
    private static async Task<(HttpResponseMessage Response, byte[] Body, double Ms)> Time(Func<Task<HttpResponseMessage>> send)
    {
        var started = Stopwatch.GetTimestamp();
        var response = await send();
        var body = await response.Content.ReadAsByteArrayAsync();
        return (response, body, Ms(started));
    }

    private static async Task<(byte[] Body, double Ms)> Get(HttpClient client, string url)
    {
        var (response, body, ms) = await Time(() => client.GetAsync(url));
        using (response)
            Assert.True(response.IsSuccessStatusCode, $"GET {url}: {(int)response.StatusCode} {Encoding.UTF8.GetString(body)}");
        return (body, ms);
    }

    private static List<string> OrderKeysFor(int count)
    {
        var keys = new List<string>(count);
        string? last = null;
        for (var i = 0; i < count; i++) keys.Add(last = OrderKeys.Between(last, null));
        return keys;
    }

    /// <summary>Rows written with SqlBulkCopy, their columns and conversions read from EF's model (as Phase2Bench does).</summary>
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
        using var bulk = new SqlBulkCopy(server.SqlConnection) { DestinationTableName = $"[{table.Name}]", BatchSize = 5000, BulkCopyTimeout = 600 };
        foreach (DataColumn column in data.Columns) bulk.ColumnMappings.Add(column.ColumnName, column.ColumnName);
        await bulk.WriteToServerAsync(data);
    }

    // The words and queries of Phase2Bench's search, so the two measure the same palette.
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

    // ------------------------------------------------------------------ groups at 10,000 pages

    /// <summary>One permission row as seeded, by page index.</summary>
    private sealed record Seeded(int Page, string Type, Guid Principal, string Level);

    /// <summary>
    /// Search p95 ≤ 300 ms and the feed of 1,000 changes ≤ 500 ms at 10,000 pages for a member in 20
    /// groups with 500 group rows; the tree tracked; search and the tree for a member in no group beside.
    /// </summary>
    [Fact]
    public async Task Search_the_feed_and_the_tree_for_a_member_in_20_groups_at_10000_pages()
    {
        SkipUnlessAsked();
        var count = Setting("PHASE11_PAGES", 10_000);
        var groupCount = Setting("PHASE11_GROUPS", 50);
        var mine = Math.Min(groupCount, Setting("PHASE11_MEMBER_GROUPS", 20));
        var groupRowCount = Setting("PHASE11_GROUP_ROWS", 500);
        var random = new Random(20261119);
        var setup = Stopwatch.GetTimestamp();

        // People, as they join: the member in 20 groups, one in none, and six others the groups hold too.
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var loner = await Kit.Join(server, ws, "member");
        var others = new List<Account>();
        for (var i = 0; i < 6; i++) others.Add(await Kit.Join(server, ws, "member"));

        // The groups through their route (the service's checks, the feed's and the audit's entries).
        var memberIn = Enumerable.Range(0, groupCount).OrderBy(_ => random.Next()).Take(mine).ToHashSet();
        var groups = new List<Guid>(groupCount);
        for (var g = 0; g < groupCount; g++)
        {
            var people = others.Where(_ => random.Next(3) == 0).Select(a => a.Id).ToList();
            if (memberIn.Contains(g)) people.Add(member.Id);
            groups.Add(await GroupKit.New(ws, $"Team {g + 1}", [.. people]));
        }
        var memberGroups = memberIn.Select(g => groups[g]).ToHashSet();
        using (var listed = JsonDocument.Parse((await Get(member.Client, GroupKit.Url(ws.Id))).Body))
            Assert.Equal(mine, listed.RootElement.GetProperty("groups").EnumerateArray()
                .Count(g => g.GetProperty("people").EnumerateArray().Any(p => p.GetProperty("userId").GetGuid() == member.Id)));
        var peopleMs = Ms(setup);

        // The tree: 40 pages at the top, each later page under a random earlier one less than seven
        // deep, so pages sit at every depth from 0 to 7. Pages, the closure table, the worker's derived
        // text and the permission rows written straight in with SqlBulkCopy (as Phase2Bench's search).
        var seeding = Stopwatch.GetTimestamp();
        const int Roots = 40, MaxDepth = 7;
        var parentOf = new int[count];
        var depthOf = new int[count];
        var childNo = new int[count];
        var childCount = new int[count];
        var open = new List<int>(count);
        for (var i = 0; i < count; i++)
        {
            if (i < Roots)
            {
                parentOf[i] = -1;
                childNo[i] = i;
            }
            else
            {
                var p = open[random.Next(open.Count)];
                parentOf[i] = p;
                depthOf[i] = depthOf[p] + 1;
                childNo[i] = childCount[p]++;
            }
            if (depthOf[i] < MaxDepth) open.Add(i);
        }
        var keys = OrderKeysFor(Math.Max(Roots, childCount.Max()) + 1);
        var ids = Enumerable.Range(0, count).Select(_ => Guid.CreateVersion7()).ToArray();
        var restricted = new HashSet<int>();
        while (restricted.Count < Math.Max(1, count / 100)) restricted.Add(random.Next(count));

        string Words(int n) => string.Join(' ', Enumerable.Range(0, n).Select(_ =>
            random.Next(3) == 0 ? Arabic[random.Next(Arabic.Length)] : English[random.Next(English.Length)]));
        var now = DateTimeOffset.UtcNow;
        var json = Cgw.Core.Documents.DocService.Gzip("""{"type":"doc","content":[]}""");
        var pages = new List<Page>(count);
        var ancestors = new List<PageAncestor>(count * (MaxDepth + 1));
        var derived = new List<PageDocDerived>(count);
        for (var i = 0; i < count; i++)
        {
            var title = (random.Next(2) == 0 ? Arabic[random.Next(Arabic.Length)] : English[random.Next(English.Length)]) + " " + Words(1 + random.Next(3));
            // One page in every 1,000 says a word no other does: the probe that full-text has caught up.
            var text = Words(60 + random.Next(120)) + (i % 1000 == 7 ? " zqxprobe" : "");
            pages.Add(new Page
            {
                Id = ids[i],
                WorkspaceId = ws.Id,
                SectionId = ws.Shared,
                ParentPageId = parentOf[i] < 0 ? null : ids[parentOf[i]],
                OrderKey = keys[childNo[i]],
                Title = title,
                SearchTitle = TextNormaliser.Normalise(title),
                Restricted = restricted.Contains(i),
                CreatedBy = ws.Account.Id,
                UpdatedBy = ws.Account.Id,
                CreatedAt = now,
                UpdatedAt = now.AddSeconds(-i),
            });
            for (int a = i, d = 0; a >= 0; a = parentOf[a], d++)
                ancestors.Add(new PageAncestor { PageId = ids[i], AncestorPageId = ids[a], Depth = d, WorkspaceId = ws.Id });
            derived.Add(new PageDocDerived
            {
                PageId = ids[i],
                WorkspaceId = ws.Id,
                UpToSeq = 0,
                Json = json,
                PlainText = text,
                SearchText = TextNormaliser.Normalise(text),
                UpdatedAt = now,
            });
        }

        // Permission rows: 500 groups' (ten of them opening a restricted page to one of the member's
        // groups), 300 people's (the member's, the loner's, the others'), 100 the workspace's.
        string[] grades = [Levels.View, Levels.Comment, Levels.Edit, Levels.Full];
        var seeded = new List<Seeded>();
        var taken = new HashSet<(int, string, Guid)>();
        void Add(int page, string type, Guid principal)
        {
            if (taken.Add((page, type, principal))) seeded.Add(new Seeded(page, type, principal, grades[random.Next(grades.Length)]));
        }
        var mineList = memberGroups.ToList();
        foreach (var page in restricted.Take(10)) Add(page, Principals.Group, mineList[random.Next(mineList.Count)]);
        while (seeded.Count < groupRowCount) Add(random.Next(count), Principals.Group, groups[random.Next(groups.Count)]);
        Guid[] people2 = [member.Id, loner.Id, .. others.Select(o => o.Id)];
        while (seeded.Count < groupRowCount + 300) Add(random.Next(count), Principals.User, people2[random.Next(people2.Length)]);
        while (seeded.Count < groupRowCount + 400) Add(random.Next(count), Principals.Workspace, ws.Id);
        var permissions = seeded.Select(r => new PagePermission
        {
            PageId = ids[r.Page],
            PrincipalType = r.Type,
            PrincipalId = r.Principal,
            Level = r.Level,
            WorkspaceId = ws.Id,
            CreatedBy = ws.Account.Id,
            CreatedAt = now,
        }).ToList();
        await BulkInsert(pages);
        await BulkInsert(ancestors);
        await BulkInsert(derived);
        await BulkInsert(permissions);
        var seedMs = Ms(seeding);

        // Full-text indexes the rows in its own time: wait until it has all of them (read as the owner,
        // who sees every page; the member does not).
        var full = await FullTextAsync();
        if (Environment.GetEnvironmentVariable("CGW_TEST_FULLTEXT") == "required")
            Assert.True(full, "CGW_TEST_FULLTEXT=required, but search is not using full-text");
        string Url(string q, int? limit = null) => $"/api/v1/workspaces/{ws.Id}/search?q={Uri.EscapeDataString(q)}" + (limit is { } l ? $"&limit={l}" : "");
        var populating = Stopwatch.GetTimestamp();
        if (full)
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
                    using var probe = JsonDocument.Parse((await Get(ws.Client, Url("zqxprobe", 50))).Body);
                    if (probe.RootElement.GetProperty("hits").GetArrayLength() == count / 1000) break;
                }
                if (i > 2400) throw new TimeoutException("Full-text did not finish populating in 10 minutes.");
                await Task.Delay(250);
            }
        var populateMs = full ? Ms(populating) : 0;
        using (var probe = JsonDocument.Parse((await Get(ws.Client, Url("zqxprobe", 50))).Body))
            Assert.Equal(count / 1000, probe.RootElement.GetProperty("hits").GetArrayLength());

        // What the rule gives each of the two on every page (DATA_MODEL.md, Permissions), to hold the
        // tree's answers to: nearest page that is restricted or has a row for them decides; there their
        // own row, else the highest of their groups' rows, else the workspace's; else none; else edit.
        var rowsOn = seeded.ToLookup(r => r.Page);
        string Expected(int page, Guid user, IReadOnlySet<Guid> theirGroups)
        {
            for (var p = page; p >= 0; p = parentOf[p])
            {
                string? own = null, group = null, workspace = null;
                foreach (var row in rowsOn[p])
                    if (row.Type == Principals.User && row.Principal == user) own = row.Level;
                    else if (row.Type == Principals.Group && theirGroups.Contains(row.Principal))
                    {
                        if (group is null || Levels.Rank(row.Level) > Levels.Rank(group)) group = row.Level;
                    }
                    else if (row.Type == Principals.Workspace) workspace = row.Level;
                if ((own ?? group ?? workspace) is { } decided) return decided;
                if (restricted.Contains(p)) return Levels.None;
            }
            return Levels.Edit;
        }
        var callers = new (string Name, Account Account, IReadOnlySet<Guid> Groups)[]
        {
            ("member", member, memberGroups),
            ("noGroup", loner, new HashSet<Guid>()),
        };

        // Search: one pass not counted, then each query in turn as the palette asks it (the first page
        // of 20), the two callers one after the other.
        foreach (var q in Queries)
            foreach (var caller in callers)
                await Get(caller.Account.Client, Url(q));
        var searchMs = callers.ToDictionary(c => c.Name, _ => (English: new List<double>(), Arabic: new List<double>(), Hits: new JsonObject()));
        for (var round = 0; round < Setting("PHASE11_SEARCH_ROUNDS", 2); round++)
            foreach (var q in Queries)
                foreach (var caller in callers)
                {
                    var (body, ms) = await Get(caller.Account.Client, Url(q));
                    var into = searchMs[caller.Name];
                    (q.Any(c => c is >= (char)0x0600 and <= (char)0x06FF) ? into.Arabic : into.English).Add(ms);
                    using var result = JsonDocument.Parse(body);
                    into.Hits[q] = result.RootElement.GetProperty("hits").GetArrayLength();
                }
        var search = new JsonObject();
        foreach (var (name, (english, arabic, hits)) in searchMs)
        {
            var stats = Stats([.. english, .. arabic]);
            stats["english"] = Stats(english);
            stats["arabic"] = Stats(arabic);
            stats["hits"] = hits;
            search[name] = stats;
        }

        // The tree at 10,000 pages, its access read by AllLevelsAsync, each page's level held to the rule.
        var treeUrl = $"/api/v1/workspaces/{ws.Id}/tree";
        var tree = new JsonObject();
        var treeRuns = callers.ToDictionary(c => c.Name, _ => new List<double>());
        var treeBodies = new Dictionary<string, byte[]>();
        for (var i = 0; i < 3; i++)
            foreach (var caller in callers)
                await Get(caller.Account.Client, treeUrl);
        for (var i = 0; i < Setting("PHASE11_TREES", 20); i++)
            foreach (var caller in callers)
            {
                var (body, ms) = await Get(caller.Account.Client, treeUrl);
                treeRuns[caller.Name].Add(ms);
                treeBodies[caller.Name] = body;
            }
        var index = ids.Select((id, i) => (id, i)).ToDictionary(x => x.id, x => x.i);
        var visibleCounts = new Dictionary<string, int>();
        foreach (var caller in callers)
        {
            using var answer = JsonDocument.Parse(treeBodies[caller.Name]);
            var shown = answer.RootElement.GetProperty("pages").EnumerateArray()
                .ToDictionary(p => p.GetProperty("id").GetGuid(), p => p.GetProperty("access").GetString()!);
            var wrong = Enumerable.Range(0, count)
                .Select(i => (Page: i, Want: Expected(i, caller.Account.Id, caller.Groups), Got: shown.GetValueOrDefault(ids[i], Levels.None)))
                .Where(x => x.Want != x.Got).ToList();
            Assert.True(wrong.Count == 0, $"{caller.Name}: {wrong.Count} pages not as the rule says, first: page {wrong.FirstOrDefault().Page} (depth {(wrong.Count > 0 ? depthOf[wrong[0].Page] : 0)}) {wrong.FirstOrDefault().Want} != {wrong.FirstOrDefault().Got}");
            var levels = new JsonObject();
            foreach (var level in shown.Values.GroupBy(v => v).OrderBy(g => g.Key, StringComparer.Ordinal)) levels[level.Key] = level.Count();
            visibleCounts[caller.Name] = shown.Count(p => index.ContainsKey(p.Key));
            var stats = Stats(treeRuns[caller.Name]);
            stats["pagesShown"] = visibleCounts[caller.Name];
            stats["levels"] = levels;
            stats["responseBytes"] = treeBodies[caller.Name].Length;
            tree[caller.Name] = stats;
        }
        // The groups give the member pages the workspace does not give everyone.
        Assert.True(visibleCounts["member"] > visibleCounts["noGroup"], $"member {visibleCounts["member"]}, no group {visibleCounts["noGroup"]}");

        // The feed: 1,000 pages made through the operations route by the owner, 20 under each of 50
        // pages holding a row of one of the member's groups (so a group's row decides each), then read
        // as the member (and the loner, tracked) after the cursor taken before them.
        var cursor = (await ws.Tree(member.Client)).GetProperty("cursor").GetInt64();
        var parents = seeded.Where(r => r.Type == Principals.Group && memberGroups.Contains(r.Principal))
            .Select(r => r.Page).Distinct().OrderBy(_ => random.Next()).Take(50).ToList();
        Assert.Equal(50, parents.Count);
        var making = Stopwatch.GetTimestamp();
        var childKeys = OrderKeysFor(childCount.Max() + 21);
        var ops = new List<JsonObject>();
        foreach (var parent in parents)
            for (var c = 0; c < 20; c++)
            {
                var child = Guid.CreateVersion7();
                ops.Add(ws.Op("page.create", child, Ws.Page(child, ws.Id, ws.Shared, ids[parent], childKeys[childCount[parent] + c], $"Under a group's page {parent} {c}")));
            }
        foreach (var batch in ops.Chunk(100))
        {
            var results = await ws.Push([.. batch]);
            Assert.All(results.EnumerateArray(), r => Assert.Equal("applied", r.GetProperty("status").GetString()));
        }
        var feedSeedMs = Ms(making);
        var feedUrl = $"/api/v1/workspaces/{ws.Id}/changes?after={cursor}&limit=1000";
        for (var i = 0; i < 3; i++)
            foreach (var caller in callers)
                await Get(caller.Account.Client, feedUrl);
        var feedRuns = callers.ToDictionary(c => c.Name, _ => new List<double>());
        var feedBodies = new Dictionary<string, byte[]>();
        for (var i = 0; i < Setting("PHASE11_FEEDS", 30); i++)
            foreach (var caller in callers)
            {
                var (body, ms) = await Get(caller.Account.Client, feedUrl);
                feedRuns[caller.Name].Add(ms);
                feedBodies[caller.Name] = body;
            }
        var feed = new JsonObject();
        foreach (var caller in callers)
        {
            using var answer = JsonDocument.Parse(feedBodies[caller.Name]);
            var changes = answer.RootElement.GetProperty("changes").EnumerateArray().ToList();
            Assert.Equal(1000, changes.Count);
            var upserts = changes.Count(c => c.GetProperty("kind").GetString() == "upsert");
            if (caller.Name == "member") Assert.Equal(1000, upserts);
            var stats = Stats(feedRuns[caller.Name]);
            stats["changes"] = changes.Count;
            stats["upserts"] = upserts;
            stats["responseBytes"] = feedBodies[caller.Name].Length;
            feed[caller.Name] = stats;
        }

        var depths = new JsonObject();
        foreach (var level in depthOf.GroupBy(d => d).OrderBy(g => g.Key)) depths[level.Key.ToString(System.Globalization.CultureInfo.InvariantCulture)] = level.Count();
        await Record("groups", new JsonObject
        {
            ["pages"] = count,
            ["depths"] = depths,
            ["ancestorRows"] = ancestors.Count,
            ["groups"] = groupCount,
            ["memberGroups"] = mine,
            ["groupRows"] = seeded.Count(r => r.Type == Principals.Group),
            ["memberGroupRows"] = seeded.Count(r => r.Type == Principals.Group && memberGroups.Contains(r.Principal)),
            ["userRows"] = seeded.Count(r => r.Type == Principals.User),
            ["memberUserRows"] = seeded.Count(r => r.Type == Principals.User && r.Principal == member.Id),
            ["workspaceRows"] = seeded.Count(r => r.Type == Principals.Workspace),
            ["restrictedPages"] = restricted.Count,
            ["people"] = 3 + others.Count,
            ["peopleMs"] = Round(peopleMs),
            ["seedMs"] = Round(seedMs),
            ["populateMs"] = Round(populateMs),
            ["path"] = full ? "fullText" : "like",
            ["budgetsMs"] = new JsonObject { ["search"] = SearchBudgetMs, ["feed1000"] = FeedBudgetMs },
            ["search"] = search,
            ["tree"] = tree,
            ["feed1000"] = feed,
            ["feedSeedMs"] = Round(feedSeedMs),
        });
        var searchP95 = Percentile([.. searchMs["member"].English, .. searchMs["member"].Arabic], 0.95);
        Assert.True(searchP95 <= SearchBudgetMs, $"search p95 {searchP95:0.0} ms for the member in {mine} groups");
        var feedP95 = Percentile(feedRuns["member"], 0.95);
        Assert.True(feedP95 <= FeedBudgetMs, $"feed of 1,000 changes p95 {feedP95:0.0} ms for the member in {mine} groups");
    }

    // ------------------------------------------------------------------ a sign-in by passkey

    /// <summary>A sign-in by passkey, the API's own time p95 ≤ 200 ms: the options and the answer, the authenticator apart.</summary>
    [Fact]
    public async Task A_sign_in_by_passkey()
    {
        SkipUnlessAsked();
        var warm = Setting("PHASE11_SIGNIN_WARMUP", 50);
        var runs = Setting("PHASE11_SIGNIN_RUNS", 200);
        var account = await server.NewAccount("Passkey bench");
        var authenticator = new SoftwareAuthenticator();
        await PasskeyFlow.AddOk(account.Client, authenticator, "Bench passkey");

        var page = new List<double>();
        var options = new List<double>();
        var answer = new List<double>();
        var signIn = new List<double>();
        var signing = new List<double>();
        for (var i = 0; i < warm + runs; i++)
        {
            // A fresh browser each time: no session, its own antiforgery cookie, as "Sign in with a passkey" starts.
            using var browser = server.Anonymous();
            var (signinPage, pageMs) = await Get(browser, "/account/signin");
            var token = PasskeyFlow.Token(Encoding.UTF8.GetString(signinPage));
            var (asked, optionsBody, optionsMs) = await Time(() => PasskeyFlow.AskOptions(browser, "/account/passkey/request-options?for=signin", token));
            using (asked) Assert.Equal(HttpStatusCode.OK, asked.StatusCode);
            var signed = Stopwatch.GetTimestamp();
            var credential = authenticator.Get(Encoding.UTF8.GetString(optionsBody));
            var signingMs = Ms(signed);
            using var form = PasskeyFlow.Form(token, credential);
            var (done, doneBody, answerMs) = await Time(() => browser.PostAsync("/account/signin/passkey", form));
            using (done) Assert.True(done.StatusCode == HttpStatusCode.Redirect, $"The passkey sign-in was refused: {Encoding.UTF8.GetString(doneBody)}");
            if (i < warm) continue;
            page.Add(pageMs);
            options.Add(optionsMs);
            answer.Add(answerMs);
            signIn.Add(optionsMs + answerMs);
            signing.Add(signingMs);
        }
        // Every round signed in with the one passkey: its counter moved each time.
        Assert.Equal((uint)(warm + runs), authenticator.Passkeys[0].SignCount);

        var result = Stats(signIn);
        result["budgetMs"] = SignInBudgetMs;
        result["warmup"] = warm;
        result["options"] = Stats(options);
        result["answer"] = Stats(answer);
        result["page"] = Stats(page);
        result["authenticator"] = Stats(signing);
        await Record("passkey", new JsonObject { ["signIn"] = result });
        var p95 = Percentile(signIn, 0.95);
        Assert.True(p95 <= SignInBudgetMs, $"passkey sign-in p95 {p95:0.0} ms");
    }

    // ------------------------------------------------------------------ a sign-in through single sign-on

    /// <summary>
    /// The time the API's own process spends waiting on the provider: every request the runtime's
    /// HttpClient sends (its <c>System.Net.Http</c> activity, from send to the answer's headers) to the
    /// mock provider's port. Read before and after each timed request, which the test makes one at a
    /// time, so a difference is that request's wait.
    /// </summary>
    private sealed class ProviderWait : IDisposable
    {
        private readonly ActivityListener listener;
        private long ticks;
        private long calls;

        public ProviderWait(int port)
        {
            var portText = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
            listener = new ActivityListener
            {
                ShouldListenTo = source => source.Name == "System.Net.Http",
                Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                ActivityStopped = activity =>
                {
                    if (activity.GetTagItem("server.port") is { } p && Convert.ToString(p, System.Globalization.CultureInfo.InvariantCulture) != portText) return;
                    Interlocked.Add(ref ticks, activity.Duration.Ticks);
                    Interlocked.Increment(ref calls);
                },
            };
            ActivitySource.AddActivityListener(listener);
        }

        public (long Ticks, long Calls) Now => (Interlocked.Read(ref ticks), Interlocked.Read(ref calls));

        public static (double Ms, long Calls) Between((long Ticks, long Calls) before, (long Ticks, long Calls) after) =>
            (TimeSpan.FromTicks(after.Ticks - before.Ticks).TotalMilliseconds, after.Calls - before.Calls);

        public void Dispose() => listener.Dispose();
    }

    private sealed record SsoRound(double Page, double Post, double PostWait, double Callback, double CallbackWait, long Calls)
    {
        /// <summary>The API's own time: the sign-on POST and the callback, less what they waited on the provider.</summary>
        public double Own => Post - PostWait + Callback - CallbackWait;
        public double Wait => PostWait + CallbackWait;
    }

    /// <summary>
    /// A sign-in through single sign-on, the API's own time p95 ≤ 200 ms: the sign-on POST and the
    /// callback (the token exchange and the id token's check), less the provider's time. A person
    /// signing in again (their account and membership made already) is the budget; first sign-ins
    /// (the account made, the membership joined) are tracked beside it.
    /// </summary>
    [Fact]
    public async Task A_sign_in_through_single_sign_on()
    {
        SkipUnlessAsked();
        var warm = Setting("PHASE11_SIGNIN_WARMUP", 50);
        var runs = Setting("PHASE11_SIGNIN_RUNS", 200);
        var firsts = Setting("PHASE11_SSO_FIRSTS", 50);
        var ws = await Ws.Create(server);
        var sso = await SsoKit.SetUp(server, ws);
        using var wait = new ProviderWait(server.OidcPort);

        async Task<SsoRound> SignIn(string email)
        {
            await SsoKit.Next(sso.Issuer, email);
            // A fresh browser each time, as "Sign in with your organisation's account" starts.
            using var browser = server.Anonymous();
            var (page, pageMs) = await Get(browser, "/account/sso?lang=en");
            var fields = ServerFixture.FormFields(Encoding.UTF8.GetString(page), "/account/sso");
            fields.Add(KeyValuePair.Create("Email", email));
            using var form = new FormUrlEncodedContent(fields);
            var beforePost = wait.Now;
            var (start, startBody, postMs) = await Time(() => browser.PostAsync("/account/sso", form));
            var postWait = ProviderWait.Between(beforePost, wait.Now);
            Uri authorize;
            using (start)
            {
                Assert.True(start.StatusCode == HttpStatusCode.Redirect, $"The sign-on was not sent to the provider: {Encoding.UTF8.GetString(startBody)}");
                authorize = start.Headers.Location!;
            }
            // At the provider (the browser's step, not the API's).
            Uri callback;
            using (var at = await SsoKit.Mock.GetAsync(authorize))
                callback = at.Headers.Location ?? throw new InvalidOperationException($"The provider did not send the browser back: {(int)at.StatusCode}");
            var beforeCallback = wait.Now;
            var (done, doneBody, callbackMs) = await Time(() => browser.GetAsync(callback.PathAndQuery));
            var callbackWait = ProviderWait.Between(beforeCallback, wait.Now);
            using (done) Assert.True(done.StatusCode == HttpStatusCode.Redirect, $"The callback signed nobody in: {Encoding.UTF8.GetString(doneBody)}");
            // The token exchange at least: the measure of the provider's time sees the API's requests.
            Assert.True(callbackWait.Calls >= 1, "No request to the provider was seen during the callback");
            return new SsoRound(pageMs, postMs, postWait.Ms, callbackMs, callbackWait.Ms, postWait.Calls + callbackWait.Calls);
        }

        // One person signing in again and again (the first of these makes their account and membership).
        var person = $"ada@{sso.Domain}";
        var again = new List<SsoRound>();
        for (var i = 0; i < warm + runs; i++)
        {
            var round = await SignIn(person);
            if (i >= warm) again.Add(round);
        }
        // New people of the domain: each sign-in makes an account and joins the workspace.
        var first = new List<SsoRound>();
        for (var i = 0; i < firsts; i++) first.Add(await SignIn($"p{i}-{Guid.NewGuid():N}@{sso.Domain}"));
        await using (var db = server.NewDb())
        {
            var login = SsoText.LoginProvider(ws.Id);
            Assert.Equal(1 + firsts, await db.UserLogins.CountAsync(l => l.LoginProvider == login));
        }

        JsonObject Of(List<SsoRound> rounds)
        {
            var stats = Stats([.. rounds.Select(r => r.Own)]);
            stats["post"] = Stats([.. rounds.Select(r => r.Post - r.PostWait)]);
            stats["callback"] = Stats([.. rounds.Select(r => r.Callback - r.CallbackWait)]);
            stats["provider"] = Stats([.. rounds.Select(r => r.Wait)]);
            stats["withProvider"] = Stats([.. rounds.Select(r => r.Post + r.Callback)]);
            stats["page"] = Stats([.. rounds.Select(r => r.Page)]);
            stats["providerRequestsPerSignIn"] = Round(rounds.Average(r => r.Calls));
            return stats;
        }
        var signIn = Of(again);
        signIn["budgetMs"] = SignInBudgetMs;
        signIn["warmup"] = warm;
        await Record("sso", new JsonObject
        {
            ["signIn"] = signIn,
            ["firstSignIn"] = Of(first),
            ["providerMeasure"] = "System.Net.Http activities to the mock provider's port (send to the answer's headers), taken off each request's time",
        });
        var p95 = Percentile([.. again.Select(r => r.Own)], 0.95);
        Assert.True(p95 <= SignInBudgetMs, $"single sign-on sign-in p95 {p95:0.0} ms (the API's own time)");
    }
}
