using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sharing;
using Cgw.Core.Sites;

namespace Cgw.Tests;

/// <summary>
/// Phase 9: the renderer's vectors. Every node of schema 6 (the version-5 fixture's document,
/// <c>packages/doc/fixtures/doc-v5.json</c>, with version 6's plugin blocks after it), in English
/// and in Arabic, and hostile content, each drawn and compared with an expected HTML file under
/// <c>fixtures/sites</c> (the one stylesheet left out). <c>SITE_VECTORS_WRITE=1</c> writes them
/// again; review the diff. The hostile document is also checked by rule: no script, no event
/// handler, no style attribute, no scheme but the allowed ones, no person.
/// </summary>
public sealed partial class SiteRendererTests(ServerFixture server)
{
    private static readonly Guid Root = Guid.Parse("01936f6e-0000-7000-8000-0000000000a0");
    private static readonly Guid Linked = Guid.Parse("01936f6e-0000-7000-8000-0000000000f2");
    private static readonly Guid Database = Guid.Parse("01936f6e-0000-7000-8000-0000000000f6");
    private static readonly Guid View = Guid.Parse("01936f6e-0000-7000-8000-0000000000f7");
    private static readonly Guid Picture = Guid.Parse("01936f6e-0000-7000-8000-0000000000f3");
    private const string Person = "01936f6e-0000-7000-8000-0000000000b1";
    private static readonly DateTimeOffset At = new(2026, 11, 17, 9, 0, 0, TimeSpan.Zero);

    private static Page PageOf(Guid id, string title, string kind = PageKinds.Page, Guid? parent = null, string? icon = null, string order = "a0") => new()
    {
        Id = id,
        WorkspaceId = Guid.Empty,
        SectionId = Guid.Empty,
        ParentPageId = parent,
        Title = title,
        Kind = kind,
        Icon = icon,
        OrderKey = order,
        DocHeadSeq = 1,
        CreatedAt = At,
        UpdatedAt = At,
    };

    private static ScopedView Scoped(Page database, string type, string? groupBy)
    {
        var properties = new JsonArray(
            DatabaseTests.Prop("title", "title", "Name"),
            DatabaseTests.Prop("pNum0001", "number", "Hours"),
            DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = new JsonArray(
                new JsonObject { ["id"] = "optA0001", ["name"] = "Doing", ["colour"] = "blue" },
                new JsonObject { ["id"] = "optB0001", ["name"] = "Done", ["colour"] = "green" }) }),
            DatabaseTests.Prop("pPer0001", "person", "Owner"),
            DatabaseTests.Prop("pDat0001", "date", "Due"),
            DatabaseTests.Prop("pChk0001", "checkbox", "Paid"));
        var schema = Schema.Parse(database.Id, 1, properties.ToJsonString());
        RowData Row(int n, string title, double hours, string stage, string due, bool paid) => new()
        {
            Id = Guid.Parse($"01936f6e-0000-7000-8000-00000000010{n}"),
            DatabaseId = database.Id,
            Title = title,
            OrderKey = "a" + n,
            CreatedAt = At,
            UpdatedAt = At,
            CreatedBy = Person,
            Values = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["pNum0001"] = hours,
                ["pSel0001"] = stage,
                ["pPer0001"] = new[] { Person },
                ["pDat0001"] = new DateValue(due),
                ["pChk0001"] = paid,
            },
        };
        List<RowData> rows = [Row(1, "Draft the plan", 3, "optA0001", "2026-12-01", true), Row(2, "Review", 1.5, "optB0001", "2026-12-03", false), Row(3, "<b>Ship</b>", 4, "optB0001", "2026-12-24", false)];
        var ctx = new QueryContext("2026-11-17", 0, null, null);
        var rule = groupBy is null ? null : new GroupRule(groupBy, null, false, []);
        var result = Query.Run(schema, rows, new QuerySpec { Group = rule }, ctx);
        return new ScopedView
        {
            Database = database,
            Record = new WorkspaceDatabase { PageId = database.Id, Properties = properties.ToJsonString() },
            Schema = schema,
            Type = type,
            Config = new JsonObject(),
            Shown = Csv.Shown(schema, null),
            // As SharedDatabases decides it: the person is not visible.
            Visible = new HashSet<string>(["title", "pNum0001", "pSel0001", "pDat0001", "pChk0001"], StringComparer.Ordinal),
            Rows = result.Rows,
            Groups = result.Groups,
            Group = rule,
            ScopeDatabases = new HashSet<Guid> { database.Id },
        };
    }

    private static SitePage Page(string json, string language, Page? page = null)
    {
        var root = PageOf(Root, "Handbook", icon: "📘");
        var linked = PageOf(Linked, "Linked page", parent: Root, order: "a1");
        var database = PageOf(Database, "Tasks", PageKinds.Database, Root, order: "a2");
        var ctx = new QueryContext("2026-11-17", 0, null, null);
        SiteViewData Data(string type, string? groupBy) => new() { View = Scoped(database, type, groupBy), Titles = new Dictionary<string, string>(), Context = ctx };
        return new SitePage
        {
            Site = new PublishedSite { Id = Guid.Parse("01936f6e-0000-7000-8000-0000000000c1"), Slug = "handbook", Language = language, RootPageId = Root, Version = 1 },
            Scope = new PageScope(root, [root, linked, database]),
            Page = page ?? root,
            Json = json,
            Assets = new Dictionary<Guid, Asset> { [Picture] = new() { Id = Picture, FileName = "picture.png", ContentType = "image/png", Status = AssetStatus.Ready } },
            Views = new Dictionary<string, SiteViewData>
            {
                [SiteRenderer.ViewKey(Database, View, null)] = Data("table", null),
                [SiteRenderer.ViewKey(Database, null, null)] = Data("board", "pSel0001"),
                [SiteRenderer.ViewKey(Database, null, "pSel0001")] = Data("table", "pSel0001"),
                [SiteRenderer.ViewKey(Database, View, SiteDatabaseHtml.FirstOptions)] = Data("table", "pSel0001"),
            },
        };
    }

    /// <summary>The version-5 fixture's document, then version 6's blocks: a chart, a board, a plugin this build does not know, and a node it does not know.</summary>
    private string SchemaSix()
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "doc", "fixtures", "doc-v5.json")));
        var doc = JsonNode.Parse(fixture.RootElement.GetProperty("json").GetRawText())!.AsObject();
        var content = doc["content"]!.AsArray();
        JsonObject Plugin(string id, string type, object props) => new()
        {
            ["type"] = "block",
            ["attrs"] = new JsonObject { ["id"] = id },
            ["content"] = new JsonArray(new JsonObject
            {
                ["type"] = "pluginBlock",
                ["attrs"] = new JsonObject { ["type"] = type, ["version"] = 1, ["props"] = JsonSerializer.Serialize(props) },
            }),
        };
        content.Add(Plugin("V6ChartBar01", "cashgear.chart", new { databaseId = Database, viewId = (Guid?)null, chart = "bar", groupBy = "pSel0001", measure = new { kind = "sum", propertyId = "pNum0001" }, title = "Hours by stage" }));
        content.Add(Plugin("V6ChartPie02", "cashgear.chart", new { databaseId = Database, chart = "pie", groupBy = "pSel0001", measure = new { kind = "count" } }));
        content.Add(Plugin("V6ChartNum03", "cashgear.chart", new { databaseId = Database, viewId = View, chart = "number", measure = new { kind = "count" } }));
        content.Add(Plugin("V6Kanban0004", "cashgear.kanban", new { databaseId = Database, viewId = View, cardProperties = new[] { "pNum0001", "pPer0001" }, hidden = new[] { "" } }));
        content.Add(Plugin("V6ChartPer05", "cashgear.chart", new { databaseId = Database, chart = "bar", groupBy = "pPer0001", measure = new { kind = "count" } }));
        content.Add(Plugin("V6Unknown006", "acme.widget", new { databaseId = Database }));
        content.Add(new JsonObject { ["type"] = "block", ["attrs"] = new JsonObject { ["id"] = "V6Future0007" }, ["content"] = new JsonArray(new JsonObject { ["type"] = "hologram" }) });
        return doc.ToJsonString();
    }

    private static string Hostile()
    {
        JsonObject Block(string id, params JsonNode[] content) => new() { ["type"] = "block", ["attrs"] = new JsonObject { ["id"] = id }, ["content"] = new JsonArray(content) };
        JsonObject Text(string text, params JsonNode[] marks)
        {
            var node = new JsonObject { ["type"] = "text", ["text"] = text };
            if (marks.Length > 0) node["marks"] = new JsonArray(marks);
            return node;
        }
        JsonObject Para(params JsonNode[] inline) => new() { ["type"] = "textBody", ["attrs"] = new JsonObject { ["kind"] = "paragraph" }, ["content"] = new JsonArray(inline) };
        JsonObject Link(string href) => new() { ["type"] = "link", ["attrs"] = new JsonObject { ["href"] = href } };
        var blocks = new JsonArray
        {
            Block("H1", Para(Text("<script>alert('text')</script> & \"quotes\" 'apostrophes'"))),
            Block("H2", Para(Text("js link", Link("javascript:alert(1)")), Text(" upper", Link("JaVaScRiPt:alert(2)")), Text(" tab", Link("java\tscript:alert(3)")),
                Text(" data", Link("data:text/html,<script>alert(4)</script>")), Text(" vb", Link("vbscript:msgbox(5)")), Text(" fine", Link("https://example.com/?a=1&b=\"2\"")),
                Text(" app", Link("#/p/" + Guid.Empty)))),
            Block("H3", new JsonObject { ["type"] = "image", ["attrs"] = new JsonObject { ["assetId"] = "\"><script>alert(6)</script>", ["alt"] = "x" } }),
            Block("H4", new JsonObject { ["type"] = "image", ["attrs"] = new JsonObject { ["assetId"] = Picture.ToString(), ["alt"] = "\" onerror=\"alert(7)", ["caption"] = "<img src=x onerror=alert(8)>", ["width"] = "320\" onload=\"x", ["align"] = "center\" onclick=\"x" } }),
            Block("H5", new JsonObject { ["type"] = "bookmark", ["attrs"] = new JsonObject { ["url"] = "javascript:alert(9)" } }),
            Block("H6", new JsonObject { ["type"] = "codeBlock", ["attrs"] = new JsonObject { ["language"] = "\"><script>" }, ["content"] = new JsonArray(Text("</code></pre><script>alert(10)</script>")) }),
            Block("H7", new JsonObject { ["type"] = "textBody", ["attrs"] = new JsonObject { ["kind"] = "callout", ["icon"] = "<img src=x onerror=alert(11)>", ["tone"] = "x\" onclick=\"alert(12)", ["colour"] = "red\" style=\"x", ["dir"] = "rtl\" onclick=\"alert(13)" }, ["content"] = new JsonArray(Text("callout")) }),
            Block("x\" onmouseover=\"alert(14)", new JsonObject { ["type"] = "textBody", ["attrs"] = new JsonObject { ["kind"] = "heading", ["level"] = 9 }, ["content"] = new JsonArray(Text("heading")) }),
            Block("H9", Para(Text("coloured", new JsonObject { ["type"] = "textColour", ["attrs"] = new JsonObject { ["token"] = "red\" onclick=\"alert(15)" } }),
                new JsonObject { ["type"] = "userMention", ["attrs"] = new JsonObject { ["userId"] = Person } },
                new JsonObject { ["type"] = "pageMention", ["attrs"] = new JsonObject { ["pageId"] = Guid.NewGuid().ToString(), ["blockId"] = "\"><x" } },
                new JsonObject { ["type"] = "dateMention", ["attrs"] = new JsonObject { ["date"] = "<script>" } },
                new JsonObject { ["type"] = "evilInline", ["content"] = new JsonArray(Text("inner text")) },
                Text("nul\u0000and\u0007bell"))),
            Block("H10", new JsonObject { ["type"] = "childPage", ["attrs"] = new JsonObject { ["pageId"] = Guid.NewGuid().ToString() } }),
            Block("H11", new JsonObject { ["type"] = "script", ["attrs"] = new JsonObject { ["src"] = "https://evil.example/x.js" } }),
            Block("H12", new JsonObject { ["type"] = "pluginBlock", ["attrs"] = new JsonObject { ["type"] = "cashgear.chart", ["props"] = "{not json" } }),
            Block("H13", new JsonObject { ["type"] = "file", ["attrs"] = new JsonObject { ["assetId"] = "../../etc/passwd" } }),
        };
        // A huge table: more rows than are drawn, and a cell whose spans try to break out.
        var rows = new JsonArray();
        for (var r = 0; r < SiteRenderer.MaxTableRows + 500; r++)
            rows.Add(new JsonObject
            {
                ["type"] = "tableRow",
                ["content"] = new JsonArray(new JsonObject { ["type"] = "tableCell", ["attrs"] = new JsonObject { ["colspan"] = r == 0 ? "2\" onclick=\"x" : 1 }, ["content"] = new JsonArray(Text($"r{r}")) }),
            });
        blocks.Add(Block("H14", new JsonObject { ["type"] = "table", ["attrs"] = new JsonObject { ["headerRow"] = true }, ["content"] = rows }));
        // Nesting deeper than is drawn.
        JsonObject deep = Block("D0", Para(Text("deepest")));
        for (var i = 1; i < SiteRenderer.MaxDepth + 20; i++) deep = Block("D" + i, Para(Text("level " + i)), deep);
        blocks.Add(deep);
        return new JsonObject { ["type"] = "doc", ["content"] = blocks }.ToJsonString();
    }

    [GeneratedRegex("<style>.*?</style>", RegexOptions.Singleline)]
    private static partial Regex Style();

    private void Compare(string name, string html)
    {
        var expected = Path.Combine(server.Root, "server", "tests", "Cgw.Tests", "fixtures", "sites", name);
        var actual = Style().Replace(html, "<style>/* SiteStyle.Css */</style>");
        if (Environment.GetEnvironmentVariable("SITE_VECTORS_WRITE") == "1")
        {
            Directory.CreateDirectory(Path.GetDirectoryName(expected)!);
            File.WriteAllText(expected, actual);
        }
        Assert.True(File.Exists(expected), $"No expected file {name}: run with SITE_VECTORS_WRITE=1 and review it");
        var want = File.ReadAllText(expected).Replace("\r\n", "\n");
        if (want != actual)
        {
            var at = want.Zip(actual).TakeWhile(p => p.First == p.Second).Count();
            Assert.Fail($"{name} differs at {at}: expected …{want[Math.Max(0, at - 80)..Math.Min(want.Length, at + 80)]}… got …{actual[Math.Max(0, at - 80)..Math.Min(actual.Length, at + 80)]}…");
        }
    }

    [Fact]
    public void Every_node_of_schema_six_draws_as_its_expected_html_in_english()
    {
        var html = SiteRenderer.Render(Page(SchemaSix(), "en"));
        Compare("schema6-en.html", html);
        Assert.Contains("<html lang=\"en\" dir=\"ltr\">", html);
        Assert.Contains("<meta name=\"robots\" content=\"noindex\">", html);
        Assert.Contains("This workbook is not published", html);
        Assert.Contains("Cash Gear ERP data is not published", html);
        Assert.Contains("<details", html);
        Assert.Contains("<input type=\"checkbox\" disabled checked>", html);
        Assert.Contains("<svg viewBox=\"0 0 600 300\" role=\"img\"", html);
        Assert.Contains("@someone", html);
        Assert.DoesNotContain("0000000000b1", html);
        Assert.DoesNotContain("0000000000b2", html);
        Assert.Contains("This chart is not published", html);
        Assert.Contains("This block cannot be shown here", html);
        Assert.Contains("aria-current=\"page\"", html);
        Assert.Contains("&lt;b&gt;Ship&lt;/b&gt;", html);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Every_node_of_schema_six_draws_as_its_expected_html_in_arabic()
    {
        var html = SiteRenderer.Render(Page(SchemaSix(), "ar"));
        Compare("schema6-ar.html", html);
        Assert.Contains("<html lang=\"ar\" dir=\"rtl\">", html);
        Assert.Contains("هذا المصنف غير منشور", html);
        Assert.Contains("@شخص", html);
        Assert.Contains("ديسمبر", html);
        // Each block keeps its own direction.
        Assert.Contains("dir=\"rtl\"", html);
        Assert.Contains("dir=\"auto\"", html);
    }

    [Fact]
    public void A_database_page_draws_its_first_view_with_pages_of_rows()
    {
        var page = Page("""{"type":"doc","content":[]}""", "en", PageOf(Database, "Tasks", PageKinds.Database, Root));
        var data = page.Views[SiteRenderer.ViewKey(Database, View, null)];
        var html = SiteRenderer.Render(new SitePage { Site = page.Site, Scope = page.Scope, Page = page.Page, Database = data, Assets = page.Assets });
        Compare("database-page.html", html);
        Assert.Contains("<caption>Tasks</caption>", html);
        Assert.Contains("<th scope=\"col\">Owner</th>", html);
        Assert.DoesNotContain("0000000000b1", html);
    }

    [Fact]
    public void Hostile_content_is_escaped_and_nothing_runs()
    {
        var html = SiteRenderer.Render(Page(Hostile(), "en"));
        Compare("hostile.html", html);
        var body = Style().Replace(html, "");
        Assert.DoesNotContain("<script", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("javascript:", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("vbscript:", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("data:text", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("evil.example", body, StringComparison.OrdinalIgnoreCase);
        // Attribute values hold no raw quote (every one is escaped): without them, only names are left.
        var names = Regex.Replace(body, "\"[^\"]*\"", "\"\"");
        Assert.DoesNotMatch(new Regex(@"<[^>]*\son[a-z]+\s*=", RegexOptions.IgnoreCase), names);
        Assert.DoesNotMatch(new Regex(@"<[^>]*\sstyle\s*=", RegexOptions.IgnoreCase), names);
        Assert.DoesNotMatch(new Regex("&(?!(amp|lt|gt|quot|#39);)"), body);
        Assert.DoesNotContain(Person, body);
        Assert.DoesNotContain(((char)0).ToString(), body, StringComparison.Ordinal);
        Assert.DoesNotContain(((char)7).ToString(), body, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;alert(&#39;text&#39;)&lt;/script&gt;", body);
        Assert.Contains("href=\"https://example.com/?a=1&amp;b=&quot;2&quot;\"", body);
        Assert.Contains("inner text", body);
        // The huge table is cut, and says so; the deep nesting stops with a placeholder.
        Assert.True(Regex.Matches(body, "<tr>").Count <= SiteRenderer.MaxTableRows + 10);
        Assert.Contains("Only the first part of this table is shown", body);
        Assert.Contains("deepest", Hostile());
        Assert.DoesNotContain(">deepest<", body);
        Assert.Contains("This block cannot be shown here", body);
    }

    [Fact]
    public void The_not_found_page_is_in_both_languages_and_never_indexed()
    {
        var html = SiteRenderer.NotFound();
        Assert.Contains("This page is not available", html);
        Assert.Contains("هذه الصفحة غير متاحة", html);
        Assert.Contains("<meta name=\"robots\" content=\"noindex\">", html);
        Assert.StartsWith("'sha256-", SiteStyle.Hash);
    }

    [Fact]
    public void Safe_urls_are_only_of_the_allowed_schemes()
    {
        foreach (var good in new[] { "https://a.example", "http://a.example/x?y=1", "mailto:a@b.example", "tel:+15551234" })
            Assert.Equal(good, SiteHtml.SafeUrl(good));
        foreach (var bad in new[] { "javascript:x", " JAVASCRIPT:x", "java\nscript:x", "data:x", "file:///c:/", "//evil.example", "#/p/x", "", "ftp://x" })
            Assert.Null(SiteHtml.SafeUrl(bad));
        Assert.Equal("&lt;&gt;&amp;&quot;&#39;", SiteHtml.Escape("<>&\"'\u0001"));
        Assert.Equal("1 December 2026, 09:30 UTC", SiteWords.English.Date("2026-12-01T09:30:00Z"));
        Assert.Equal("24 ديسمبر 2026", SiteWords.Arabic.Date("2026-12-24"));
        Assert.Equal("March 2026", SiteWords.English.DateKey("2026-03"));
    }
}
