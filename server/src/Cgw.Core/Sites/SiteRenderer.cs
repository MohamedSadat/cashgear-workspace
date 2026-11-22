using System.Globalization;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Documents;
using Cgw.Core.Sharing;

namespace Cgw.Core.Sites;

/// <summary>One database view a site page draws, read as a share link reads it (<see cref="SharedDatabases"/>).</summary>
public sealed class SiteViewData
{
    public required ScopedView View { get; init; }
    /// <summary>Related rows' titles, for the visible relation cells.</summary>
    public required IReadOnlyDictionary<string, string> Titles { get; init; }
    public required QueryContext Context { get; init; }
    /// <summary>Rows' covers (a gallery's), by row id.</summary>
    public IReadOnlyDictionary<Guid, Guid> Covers { get; init; } = new Dictionary<Guid, Guid>();
}

/// <summary>What a site page is drawn from: all of it read before drawing, so drawing is plain and synchronous.</summary>
public sealed class SitePage
{
    public required PublishedSite Site { get; init; }
    /// <summary>Phase 14: what the site's addresses start with: <c>/&lt;slug&gt;</c> (unless set), or empty at its own host name.</summary>
    public string Base
    {
        get => given ?? "/" + Site.Slug;
        init => given = value;
    }

    private readonly string? given;
    public required PageScope Scope { get; init; }
    public required Page Page { get; init; }
    /// <summary>The worker's derived JSON of the page; null when it has none yet.</summary>
    public string? Json { get; init; }
    /// <summary>Files the page or its databases name, ready ones only (their names).</summary>
    public IReadOnlyDictionary<Guid, Asset> Assets { get; init; } = new Dictionary<Guid, Asset>();
    /// <summary>The database views its blocks draw, by <see cref="SiteRenderer.ViewKey"/>.</summary>
    public IReadOnlyDictionary<string, SiteViewData> Views { get; init; } = new Dictionary<string, SiteViewData>();
    /// <summary>A database page: its first view.</summary>
    public SiteViewData? Database { get; init; }
    /// <summary>A database page's page of rows (from 1).</summary>
    public int PageNumber { get; init; } = 1;
}

/// <summary>A database a page's block draws: the block's database and view, and a chart's or board's own group.</summary>
public sealed record SiteNeed(Guid DatabaseId, Guid? ViewId, string? GroupBy);

/// <summary>What drawing a page needs read first.</summary>
public sealed class SiteNeeds
{
    public List<SiteNeed> Views { get; } = [];
    public HashSet<Guid> Assets { get; } = [];
}

/// <summary>
/// A published page as HTML (Phase 9, M9.1), from the worker's derived JSON, with no script at all:
/// every node of schema 6 drawn by its meaning (toggles as <c>details</c>, checkboxes disabled),
/// a heading under the page's title, each block keeping its own direction; links only of a few
/// schemes, files and images through the site's own checked address; a database by its view
/// (<see cref="SiteDatabaseHtml"/>), a workbook and an ERP view always a placeholder, a chart and a
/// board from their view's rows, an unknown node a placeholder. People are never named. Every value
/// from the document is escaped (<see cref="SiteHtml"/>).
/// </summary>
public static class SiteRenderer
{
    public const int BlockRows = 100;
    public const int PageRows = 500;
    public const int MaxDepth = 40;
    public const int MaxTableRows = 2000;
    public const int MaxTableCells = 100;

    public static string ViewKey(Guid database, Guid? view, string? groupBy) => $"{database}|{view}|{groupBy}";

    /// <summary>A document's JSON nests a few levels for every level of blocks: deeper than the reader's default allows.</summary>
    private static readonly JsonDocumentOptions Deep = new() { MaxDepth = 512 };

    private static readonly HashSet<string> ListKinds = ["bulletItem", "numberedItem", "checkItem"];

    // Reading the document -------------------------------------------------------------------------------

    internal static string? Str(JsonElement? value) => value is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

    internal static string? Attr(JsonElement node, string name) => Str(Js.Prop(Js.Prop(node, "attrs"), name));

    internal static string? Type(JsonElement node) => Str(Js.Prop(node, "type"));

    internal static IReadOnlyList<JsonElement> Content(JsonElement node) =>
        Js.Prop(node, "content") is { ValueKind: JsonValueKind.Array } content ? content.EnumerateArray().ToList() : [];

    private static Guid? Id(string? text) => Guid.TryParse(text, out var id) ? id : null;

    /// <summary>A plugin block's props: the JSON object its <c>props</c> text holds, or an empty one.</summary>
    internal static JsonElement Props(JsonElement node)
    {
        try
        {
            using var doc = JsonDocument.Parse(Attr(node, "props") ?? "{}");
            if (doc.RootElement.ValueKind == JsonValueKind.Object) return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
        }
        using var empty = JsonDocument.Parse("{}");
        return empty.RootElement.Clone();
    }

    /// <summary>The databases and files a document's blocks name, walked as drawing walks it.</summary>
    public static SiteNeeds Needs(string? json)
    {
        var needs = new SiteNeeds();
        if (json is null) return needs;
        using var doc = JsonDocument.Parse(json, Deep);
        void Walk(JsonElement node, int depth)
        {
            if (depth > MaxDepth) return;
            switch (Type(node))
            {
                case "databaseView":
                    if (Id(Attr(node, "databaseId")) is { } database) needs.Views.Add(new SiteNeed(database, Id(Attr(node, "viewId")), null));
                    break;
                case "pluginBlock":
                {
                    var type = Attr(node, "type");
                    if (type is SiteDatabaseHtml.ChartType or SiteDatabaseHtml.KanbanType)
                    {
                        var props = Props(node);
                        if (Id(Str(Js.Prop(props, "databaseId"))) is { } pluginDatabase)
                            needs.Views.Add(new SiteNeed(pluginDatabase, Id(Str(Js.Prop(props, "viewId"))),
                                SiteDatabaseHtml.GroupOf(type, Str(Js.Prop(props, "groupBy")) is { Length: > 0 } g ? g : null)));
                    }
                    break;
                }
                case "image" or "file":
                    if (Id(Attr(node, "assetId")) is { } asset) needs.Assets.Add(asset);
                    break;
            }
            foreach (var child in Content(node)) Walk(child, depth + 1);
        }
        Walk(doc.RootElement, 0);
        return needs;
    }

    // The page ---------------------------------------------------------------------------------------------

    /// <summary>A page's address under the site's base (Phase 14: from <c>/</c> at its own host name).</summary>
    public static string PageUrl(string @base, PageScope scope, Guid pageId) =>
        pageId == scope.Root.Id ? (@base.Length == 0 ? "/" : @base) : $"{@base}/{pageId}";

    public static string FileUrl(string @base, Guid assetId) => $"{@base}/files/{assetId}";

    public static string Render(SitePage page)
    {
        var words = SiteWords.For(page.Site.Language);
        var h = new SiteHtml();
        var root = page.Scope.Root;
        var title = page.Page.Title.Length > 0 ? page.Page.Title : words.Untitled;
        var siteTitle = root.Title.Length > 0 ? root.Title : words.Untitled;
        h.Raw("<!doctype html>\n<html").Attr("lang", words.Language).Attr("dir", words.Direction).Raw(">\n<head>\n<meta charset=\"utf-8\">\n")
            .Raw("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
            .Raw("<meta name=\"referrer\" content=\"no-referrer\">\n");
        if (!page.Site.Indexing) h.Raw("<meta name=\"robots\" content=\"noindex\">\n");
        h.Raw("<title>").Text(page.Page.Id == root.Id ? siteTitle : $"{title} · {siteTitle}").Raw("</title>\n");
        h.Raw("<style>").Raw(SiteStyle.Css).Raw("</style>\n</head>\n<body>\n");
        h.Raw("<a class=\"skip\" href=\"#main\">").Text(words.Skip).Raw("</a>\n");
        h.Raw("<header class=\"site-header\"><a").Attr("href", PageUrl(page.Base, page.Scope, page.Scope.Root.Id)).Raw(">");
        Icon(h, root.Icon);
        h.Text(siteTitle).Raw("</a></header>\n<div class=\"layout\">\n");
        Tree(h, page, words);
        h.Raw("<main id=\"main\">\n");
        if (page.Page.CoverAssetId is { } cover) h.Raw("<img class=\"cover\"").Attr("src", FileUrl(page.Base, cover)).Attr("alt", "").Raw(">\n");
        h.Raw("<h1>");
        Icon(h, page.Page.Icon);
        h.Text(title).Raw("</h1>\n");
        if (page.Page.Kind == PageKinds.Database)
        {
            if (page.Database is { } database) SiteDatabaseHtml.FullPage(h, page, database, words);
            else Placeholder(h, words.DatabaseHidden);
        }
        else
        {
            h.Raw("<article>\n");
            if (page.Json is { } json)
            {
                using var doc = JsonDocument.Parse(json, Deep);
                new Writer(h, page, words, doc.RootElement).Blocks(Content(doc.RootElement), 0);
            }
            h.Raw("</article>\n");
        }
        h.Raw("</main>\n</div>\n<footer>").Text(words.Footer).Raw("</footer>\n</body>\n</html>\n");
        return h.ToString();
    }

    private static void Icon(SiteHtml h, string? icon)
    {
        if (string.IsNullOrWhiteSpace(icon)) return;
        h.Raw("<span class=\"icon\" aria-hidden=\"true\">").Text(icon.Length > 64 ? icon[..64] : icon).Raw("</span>");
    }

    internal static void Placeholder(SiteHtml h, string text) =>
        h.Raw("<div class=\"placeholder\" role=\"note\">").Text(text).Raw("</div>\n");

    /// <summary>The site's pages as nested lists, the one shown marked <c>aria-current="page"</c>.</summary>
    private static void Tree(SiteHtml h, SitePage page, SiteWords words)
    {
        var scope = page.Scope;
        var children = scope.Pages.Where(p => p.Id != scope.Root.Id).ToLookup(p => p.ParentPageId);
        h.Raw("<nav class=\"tree\"").Attr("aria-label", words.Pages).Raw(">\n<ul>");
        void Item(Page p, int depth)
        {
            h.Raw("<li><a").Attr("href", PageUrl(page.Base, scope, p.Id));
            if (p.Id == page.Page.Id) h.Raw(" aria-current=\"page\"");
            h.Raw(">");
            Icon(h, p.Icon);
            h.Text(p.Title.Length > 0 ? p.Title : words.Untitled).Raw("</a>");
            var under = children[p.Id].OrderBy(c => c.OrderKey, StringComparer.Ordinal).ThenBy(c => c.Id.ToString(), StringComparer.Ordinal).ToList();
            if (under.Count > 0 && depth < MaxDepth)
            {
                h.Raw("<ul>");
                foreach (var child in under) Item(child, depth + 1);
                h.Raw("</ul>");
            }
            h.Raw("</li>");
        }
        Item(scope.Root, 0);
        h.Raw("</ul>\n</nav>\n");
    }

    /// <summary>The page answered for any address that is not a live site's page: in both languages, never indexed.</summary>
    public static string NotFound()
    {
        var h = new SiteHtml();
        h.Raw("<!doctype html>\n<html lang=\"en\" dir=\"ltr\">\n<head>\n<meta charset=\"utf-8\">\n")
            .Raw("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n")
            .Raw("<title>Not available · غير متاحة</title>\n<style>").Raw(SiteStyle.Css).Raw("</style>\n</head>\n<body>\n<main class=\"gone\">\n")
            .Raw("<h1>This page is not available</h1>\n<p>It may have been unpublished, or the address is not right.</p>\n")
            .Raw("<div lang=\"ar\" dir=\"rtl\">\n<h2>هذه الصفحة غير متاحة</h2>\n<p>ربما أُلغي نشرها، أو أن العنوان غير صحيح.</p>\n</div>\n")
            .Raw("</main>\n</body>\n</html>\n");
        return h.ToString();
    }

    /// <summary>
    /// Phase 14: the page a reader past the Sites process's rate limit is given, in both languages:
    /// it is answered before the site is read, so its language is not known.
    /// </summary>
    public static string TooMany()
    {
        var h = new SiteHtml();
        h.Raw("<!doctype html>\n<html lang=\"en\" dir=\"ltr\">\n<head>\n<meta charset=\"utf-8\">\n")
            .Raw("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n")
            .Raw("<title>Too many requests · طلبات كثيرة</title>\n<style>").Raw(SiteStyle.Css).Raw("</style>\n</head>\n<body>\n<main class=\"gone\">\n")
            .Raw("<h1>Too many requests</h1>\n<p>This address has asked for many pages in a short time. Wait a minute, then try again.</p>\n")
            .Raw("<div lang=\"ar\" dir=\"rtl\">\n<h2>طلبات كثيرة جدًا</h2>\n<p>طلب هذا العنوان صفحات كثيرة في وقت قصير. انتظر دقيقة، ثم حاول مرة أخرى.</p>\n</div>\n")
            .Raw("</main>\n</body>\n</html>\n");
        return h.ToString();
    }

    // The document -------------------------------------------------------------------------------------------

    private sealed class Writer(SiteHtml h, SitePage page, SiteWords words, JsonElement doc)
    {
        public void Blocks(IReadOnlyList<JsonElement> blocks, int depth)
        {
            if (depth > MaxDepth)
            {
                Placeholder(h, words.BlockHidden);
                return;
            }
            for (var i = 0; i < blocks.Count;)
            {
                var kind = ListKind(blocks[i]);
                if (kind is null)
                {
                    Block(blocks[i], depth);
                    i++;
                    continue;
                }
                var run = new List<JsonElement>();
                while (i < blocks.Count && ListKind(blocks[i]) == kind) run.Add(blocks[i++]);
                List(kind, run, depth);
            }
        }

        private static List<JsonElement> Bodies(JsonElement block) => Content(block).Where(c => Type(c) != "block").ToList();

        private static List<JsonElement> Nested(JsonElement block) => Content(block).Where(c => Type(c) == "block").ToList();

        private static string? ListKind(JsonElement block)
        {
            if (Type(block) != "block") return null;
            var first = Bodies(block).FirstOrDefault();
            return first.ValueKind == JsonValueKind.Object && Type(first) == "textBody" && Attr(first, "kind") is { } kind && ListKinds.Contains(kind) ? kind : null;
        }

        private void List(string kind, List<JsonElement> items, int depth)
        {
            switch (kind)
            {
                case "numberedItem":
                    h.Raw("<ol");
                    var start = Js.Number(Js.Prop(Js.Prop(Bodies(items[0])[0], "attrs"), "start"));
                    if (double.IsFinite(start) && start >= 1 && start <= 1_000_000_000 && start != 1) h.Attr("start", (long)start);
                    h.Raw(">\n");
                    break;
                case "checkItem":
                    h.Raw("<ul class=\"checks\">\n");
                    break;
                default:
                    h.Raw("<ul>\n");
                    break;
            }
            foreach (var item in items)
            {
                var bodies = Bodies(item);
                var body = bodies[0];
                h.Raw("<li");
                BlockId(item);
                TextAttributes(body, null);
                h.Raw(">");
                if (kind == "checkItem")
                {
                    var done = Js.Truthy(Js.Prop(Js.Prop(body, "attrs"), "checked"));
                    h.Raw("<label><input type=\"checkbox\" disabled").Raw(done ? " checked" : "").Raw("><span").Raw(done ? " class=\"done\"" : "").Raw(">");
                    Inline(Content(body));
                    h.Raw("</span></label>");
                }
                else Inline(Content(body));
                foreach (var extra in bodies.Skip(1)) Body(extra, null, depth);
                var nested = Nested(item);
                if (nested.Count > 0) Blocks(nested, depth + 1);
                h.Raw("</li>\n");
            }
            h.Raw(kind == "numberedItem" ? "</ol>\n" : "</ul>\n");
        }

        private void BlockId(JsonElement block)
        {
            if (Attr(block, "id") is { } id && SiteHtml.IsBlockId(id)) h.Attr("id", "b-" + id);
        }

        private void Block(JsonElement block, int depth)
        {
            if (Type(block) != "block")
            {
                // Not a block where a block belongs: drawn as a body would be, or a placeholder.
                Body(block, null, depth);
                return;
            }
            var bodies = Bodies(block);
            var nested = Nested(block);
            if (bodies.Count > 0 && Type(bodies[0]) == "textBody" && Attr(bodies[0], "kind") == "toggle")
            {
                h.Raw("<details");
                BlockId(block);
                h.Raw("><summary");
                TextAttributes(bodies[0], null);
                h.Raw(">");
                Inline(Content(bodies[0]));
                h.Raw("</summary>\n");
                foreach (var extra in bodies.Skip(1)) Body(extra, null, depth);
                if (nested.Count > 0)
                {
                    h.Raw("<div class=\"children\">\n");
                    Blocks(nested, depth + 1);
                    h.Raw("</div>\n");
                }
                h.Raw("</details>\n");
                return;
            }
            for (var i = 0; i < bodies.Count; i++) Body(bodies[i], i == 0 ? block : null, depth);
            if (nested.Count > 0)
            {
                h.Raw("<div class=\"children\">\n");
                Blocks(nested, depth + 1);
                h.Raw("</div>\n");
            }
        }

        /// <summary><c> dir</c>, a colour's class (and the block's id), on a text body's element.</summary>
        private void TextAttributes(JsonElement body, string? extraClass)
        {
            var dir = Attr(body, "dir");
            h.Attr("dir", dir is "ltr" or "rtl" ? dir : "auto");
            var colour = Attr(body, "colour");
            var classes = string.Join(' ', new[] { extraClass, colour is not null && SiteHtml.Colours.Contains(colour) ? "c-" + colour : null }.Where(c => c is not null));
            if (classes.Length > 0) h.Attr("class", classes);
        }

        private void Body(JsonElement body, JsonElement? block, int depth)
        {
            void MarkId()
            {
                if (block is { } b) BlockId(b);
            }
            switch (Type(body))
            {
                case "textBody":
                {
                    var kind = Attr(body, "kind") ?? "paragraph";
                    switch (kind)
                    {
                        case "heading":
                        {
                            var level = Js.Number(Js.Prop(Js.Prop(body, "attrs"), "level"));
                            var tag = "h" + (double.IsFinite(level) && level >= 2 ? (level >= 3 ? 4 : 3) : 2).ToString(CultureInfo.InvariantCulture);
                            h.Raw("<" + tag);
                            MarkId();
                            TextAttributes(body, null);
                            h.Raw(">");
                            Inline(Content(body));
                            h.Raw("</" + tag + ">\n");
                            return;
                        }
                        case "quote":
                            h.Raw("<blockquote");
                            MarkId();
                            TextAttributes(body, null);
                            h.Raw("><p>");
                            Inline(Content(body));
                            h.Raw("</p></blockquote>\n");
                            return;
                        case "callout":
                        {
                            var tone = Attr(body, "tone");
                            h.Raw("<aside");
                            MarkId();
                            TextAttributes(body, "callout tone-" + (tone is "info" or "success" or "warning" or "danger" ? tone : "neutral"));
                            h.Raw(" role=\"note\">");
                            if (Attr(body, "icon") is { Length: > 0 } icon) Icon(h, icon);
                            h.Raw("<div>");
                            Inline(Content(body));
                            h.Raw("</div></aside>\n");
                            return;
                        }
                        default:
                            // A paragraph, and a list item or toggle met out of its place.
                            h.Raw("<p");
                            MarkId();
                            TextAttributes(body, null);
                            h.Raw(">");
                            Inline(Content(body));
                            h.Raw("</p>\n");
                            return;
                    }
                }
                case "codeBlock":
                {
                    h.Raw("<pre");
                    MarkId();
                    h.Raw(" dir=\"ltr\"");
                    if (Js.Truthy(Js.Prop(Js.Prop(body, "attrs"), "wrap"))) h.Raw(" class=\"wrap\"");
                    h.Raw("><code>");
                    foreach (var node in Content(body))
                        if (Type(node) == "text") h.Text(Str(Js.Prop(node, "text")));
                    h.Raw("</code></pre>\n");
                    return;
                }
                case "divider":
                    h.Raw("<hr>\n");
                    return;
                case "table":
                    Table(body);
                    return;
                case "image":
                {
                    if (Id(Attr(body, "assetId")) is not { } asset)
                        return;
                    var align = Attr(body, "align");
                    h.Raw("<figure");
                    MarkId();
                    if (align is "center" or "end") h.Attr("class", "align-" + align);
                    h.Raw("><img").Attr("src", FileUrl(page.Base, asset)).Attr("alt", Attr(body, "alt") ?? "").Raw(" loading=\"lazy\"");
                    var width = Js.Number(Js.Prop(Js.Prop(body, "attrs"), "width"));
                    if (double.IsFinite(width) && width >= 1) h.Attr("width", (long)Math.Min(width, 4096));
                    h.Raw(">");
                    if (Attr(body, "caption") is { Length: > 0 } caption) h.Raw("<figcaption>").Text(caption).Raw("</figcaption>");
                    h.Raw("</figure>\n");
                    return;
                }
                case "file":
                {
                    if (Id(Attr(body, "assetId")) is not { } asset) return;
                    var name = page.Assets.TryGetValue(asset, out var known) ? known.FileName : words.File;
                    h.Raw("<p");
                    MarkId();
                    h.Raw("><a class=\"file\"").Attr("href", FileUrl(page.Base, asset)).Raw(" download>").Text(name).Raw("</a></p>\n");
                    return;
                }
                case "bookmark":
                {
                    if (SiteHtml.SafeUrl(Attr(body, "url")) is not { } url || !url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return;
                    h.Raw("<p");
                    MarkId();
                    h.Raw("><a class=\"bookmark\"").Attr("href", url).Raw(" rel=\"noopener noreferrer nofollow\">").Text(url).Raw("</a></p>\n");
                    return;
                }
                case "childPage":
                {
                    // A page the site does not hold is not named.
                    if (Id(Attr(body, "pageId")) is not { } child || page.Scope.Pages.FirstOrDefault(p => p.Id == child) is not { } target) return;
                    h.Raw("<p");
                    MarkId();
                    h.Raw("><a").Attr("href", PageUrl(page.Base, page.Scope, child)).Raw(">");
                    Icon(h, target.Icon);
                    h.Text(target.Title.Length > 0 ? target.Title : words.Untitled).Raw("</a></p>\n");
                    return;
                }
                case "tableOfContents":
                    Contents();
                    return;
                case "databaseView":
                {
                    var database = Id(Attr(body, "databaseId"));
                    if (database is { } d && page.Views.TryGetValue(ViewKey(d, Id(Attr(body, "viewId")), null), out var data))
                        SiteDatabaseHtml.Block(h, page, data, words);
                    else Placeholder(h, words.DatabaseHidden);
                    return;
                }
                case "sheetEmbed":
                    Placeholder(h, words.WorkbookHidden);
                    return;
                case "erpView":
                    Placeholder(h, words.ErpHidden);
                    return;
                case "pluginBlock":
                    SiteDatabaseHtml.Plugin(h, page, body, words);
                    return;
                default:
                    Placeholder(h, words.BlockHidden);
                    return;
            }
        }

        private void Table(JsonElement table)
        {
            var headerRow = Js.Truthy(Js.Prop(Js.Prop(table, "attrs"), "headerRow"));
            var headerColumn = Js.Truthy(Js.Prop(Js.Prop(table, "attrs"), "headerColumn"));
            var rows = Content(table).Where(r => Type(r) == "tableRow").ToList();
            h.Raw("<div class=\"table-wrap\"><table>\n");
            var cut = rows.Count > MaxTableRows;
            for (var r = 0; r < Math.Min(rows.Count, MaxTableRows); r++)
            {
                if (r == 0 && headerRow) h.Raw("<thead>");
                if (r == (headerRow ? 1 : 0)) h.Raw("<tbody>");
                h.Raw("<tr>");
                var cells = Content(rows[r]).Where(c => Type(c) == "tableCell").ToList();
                if (cells.Count > MaxTableCells) cut = true;
                for (var c = 0; c < Math.Min(cells.Count, MaxTableCells); c++)
                {
                    var head = (r == 0 && headerRow) || (c == 0 && headerColumn);
                    h.Raw(head ? "<th" : "<td");
                    if (head) h.Attr("scope", r == 0 && headerRow ? "col" : "row");
                    TextAttributes(cells[c], null);
                    foreach (var span in new[] { "colspan", "rowspan" })
                    {
                        var n = Js.Number(Js.Prop(Js.Prop(cells[c], "attrs"), span));
                        if (double.IsFinite(n) && n >= 2) h.Attr(span, (long)Math.Min(n, 1000));
                    }
                    h.Raw(">");
                    Inline(Content(cells[c]));
                    h.Raw(head ? "</th>" : "</td>");
                }
                h.Raw("</tr>\n");
                if (r == 0 && headerRow) h.Raw("</thead>\n");
            }
            if (rows.Count > (headerRow ? 1 : 0)) h.Raw("</tbody>\n");
            h.Raw("</table></div>\n");
            if (cut) h.Raw("<p class=\"count\">").Text(words.TableCut).Raw("</p>\n");
        }

        /// <summary>The page's headings, each a link to its block.</summary>
        private void Contents()
        {
            var headings = new List<(string Id, int Level, JsonElement Body)>();
            void Walk(JsonElement node, int depth)
            {
                if (depth > MaxDepth) return;
                if (Type(node) == "block")
                {
                    var first = Content(node).FirstOrDefault(c => Type(c) != "block");
                    if (first.ValueKind == JsonValueKind.Object && Type(first) == "textBody" && Attr(first, "kind") == "heading" && Attr(node, "id") is { } id && SiteHtml.IsBlockId(id))
                    {
                        var level = Js.Number(Js.Prop(Js.Prop(first, "attrs"), "level"));
                        headings.Add((id, double.IsFinite(level) ? (int)Math.Clamp(level, 1, 3) : 1, first));
                    }
                }
                foreach (var child in Content(node)) Walk(child, depth + 1);
            }
            Walk(doc, 0);
            if (headings.Count == 0) return;
            h.Raw("<nav class=\"toc\"").Attr("aria-label", words.Contents).Raw("><ol>\n");
            foreach (var (id, level, body) in headings)
            {
                h.Raw("<li");
                if (level > 1) h.Attr("class", "level-" + level.ToString(CultureInfo.InvariantCulture));
                h.Raw("><a").Attr("href", "#b-" + id).Raw(">");
                Inline(Content(body), links: false);
                h.Raw("</a></li>\n");
            }
            h.Raw("</ol></nav>\n");
        }

        // Inline nodes ------------------------------------------------------------------------------------------

        private void Inline(IReadOnlyList<JsonElement> nodes, bool links = true)
        {
            foreach (var node in nodes)
            {
                switch (Type(node))
                {
                    case "text":
                        Text(node, links);
                        break;
                    case "hardBreak":
                        h.Raw("<br>");
                        break;
                    case "pageMention":
                    {
                        var target = Id(Attr(node, "pageId")) is { } id ? page.Scope.Pages.FirstOrDefault(p => p.Id == id) : null;
                        if (target is null)
                        {
                            h.Raw("<span class=\"mention\">").Text(words.APage).Raw("</span>");
                            break;
                        }
                        var href = PageUrl(page.Base, page.Scope, target.Id);
                        if (Attr(node, "blockId") is { } blockId && SiteHtml.IsBlockId(blockId)) href += "#b-" + blockId;
                        if (links) h.Raw("<a class=\"mention\"").Attr("href", href).Raw(">");
                        else h.Raw("<span class=\"mention\">");
                        Icon(h, target.Icon);
                        h.Text(target.Title.Length > 0 ? target.Title : words.Untitled).Raw(links ? "</a>" : "</span>");
                        break;
                    }
                    case "dateMention":
                    {
                        var date = Attr(node, "date");
                        if (date is null || !DbDates.IsPoint(date)) break;
                        var end = Attr(node, "end");
                        h.Raw("<time").Attr("datetime", date).Raw(">").Text(words.DateSpan(date, end is not null && DbDates.IsPoint(end) ? end : null)).Raw("</time>");
                        break;
                    }
                    case "userMention":
                        // Never a person's name, nor their id.
                        h.Raw("<span class=\"mention\">@").Text(words.Someone).Raw("</span>");
                        break;
                    default:
                        // An inline node this build does not know: what text it holds, if any.
                        Inline(Content(node), links);
                        break;
                }
            }
        }

        private void Text(JsonElement node, bool links)
        {
            var marks = Js.Prop(node, "marks") is { ValueKind: JsonValueKind.Array } list ? list.EnumerateArray().ToList() : [];
            var open = new List<string>();
            foreach (var mark in marks)
            {
                switch (Type(mark))
                {
                    case "bold": open.Add("strong"); h.Raw("<strong>"); break;
                    case "italic": open.Add("em"); h.Raw("<em>"); break;
                    case "underline": open.Add("u"); h.Raw("<u>"); break;
                    case "strike": open.Add("s"); h.Raw("<s>"); break;
                    case "code": open.Add("code"); h.Raw("<code>"); break;
                    case "textColour" when Attr(mark, "token") is { } token && SiteHtml.Colours.Contains(token):
                        open.Add("span");
                        h.Raw("<span").Attr("class", "c-" + token).Raw(">");
                        break;
                    case "highlight" when Attr(mark, "token") is { } token && SiteHtml.Colours.Contains(token):
                        open.Add("mark");
                        h.Raw("<mark").Attr("class", "h-" + token).Raw(">");
                        break;
                    case "link" when links:
                    {
                        var href = Href(Attr(mark, "href"));
                        if (href is null) break;
                        open.Add("a");
                        h.Raw("<a").Attr("href", href);
                        if (!href.StartsWith('/')) h.Raw(" rel=\"noopener noreferrer nofollow\"");
                        h.Raw(">");
                        break;
                    }
                }
            }
            h.Text(Str(Js.Prop(node, "text")));
            for (var i = open.Count - 1; i >= 0; i--) h.Raw("</" + open[i] + ">");
        }

        /// <summary>A link's target on the site: an outside address of the allowed schemes, or an in-app page link to a page the site holds.</summary>
        private string? Href(string? href)
        {
            if (href is null) return null;
            var value = href.Trim();
            if (value.StartsWith("#/p/", StringComparison.Ordinal))
            {
                var id = value.Length >= 40 ? Id(value[4..40]) : null;
                return id is { } page1 && page.Scope.Holds(page1) ? PageUrl(page.Base, page.Scope, page1) : null;
            }
            return SiteHtml.SafeUrl(value);
        }
    }
}
