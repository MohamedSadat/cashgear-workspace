using System.Globalization;
using System.Text.Json;
using Cgw.Core.Assets;
using Cgw.Core.Databases;
using Cgw.Core.Documents;
using Cgw.Core.Sharing;

namespace Cgw.Core.Sites;

/// <summary>
/// Databases on a site page (DECISIONS.md, 2026-11-17): a view's rows as a share link reads them
/// (<see cref="SharedDatabases"/>): a database block's first 100 with "N of M rows", a database page
/// 500 a page; a board as columns of cards, a gallery as cards, every other view as a table; only
/// the view's visible values, a person's cell empty, a related row by its title only when its
/// database is published too, never a link into a row. A chart is drawn as SVG with its numbers as
/// a table, a board plugin as columns, both from their view's rows and only by properties the view
/// shows. A chart view (Phase 12) is drawn as the chart block is, by the same drawing, from its
/// view's own settings and group, wherever its database is (a block or the database's page).
/// </summary>
public static class SiteDatabaseHtml
{
    public const string ChartType = "cashgear.chart";
    public const string KanbanType = "cashgear.kanban";
    /// <summary>Rows a chart's sum or average reads, as the app's chart does.</summary>
    public const int ChartRows = 5000;
    /// <summary>A board plugin's group when it names none: the database's first select or status property.</summary>
    public const string FirstOptions = "*";

    /// <summary>The group a plugin block's view is read by, as its key names it.</summary>
    public static string? GroupOf(string? type, string? groupBy) => groupBy ?? (type == KanbanType ? FirstOptions : null);

    private static string? Str(JsonElement? value) => SiteRenderer.Str(value);

    public static void Block(SiteHtml h, SitePage page, SiteViewData data, SiteWords words)
    {
        var view = data.View;
        h.Raw("<section class=\"database\">\n<div class=\"db-title\"><a").Attr("href", SiteRenderer.PageUrl(page.Base, page.Scope, view.Database.Id)).Raw(">");
        Icon(h, view.Database.Icon);
        h.Text(view.Database.Title.Length > 0 ? view.Database.Title : words.Untitled).Raw("</a></div>\n");
        if (view.Type == ChartView.Type) ViewChart(h, data, words);
        else
        {
            var rows = view.Rows.Take(SiteRenderer.BlockRows).ToList();
            Rows(h, page, data, rows, words);
            Count(h, rows.Count, view.Rows.Count, words);
        }
        h.Raw("</section>\n");
    }

    public static void FullPage(SiteHtml h, SitePage page, SiteViewData data, SiteWords words)
    {
        var view = data.View;
        if (view.Type == ChartView.Type)
        {
            // A chart is one figure of every row: no pages of rows.
            h.Raw("<section class=\"database\">\n");
            ViewChart(h, data, words);
            h.Raw("</section>\n");
            return;
        }
        var pages = Math.Max(1, (view.Rows.Count + SiteRenderer.PageRows - 1) / SiteRenderer.PageRows);
        var number = Math.Clamp(page.PageNumber, 1, pages);
        var rows = view.Rows.Skip((number - 1) * SiteRenderer.PageRows).Take(SiteRenderer.PageRows).ToList();
        h.Raw("<section class=\"database\">\n");
        Rows(h, page, data, rows, words);
        Count(h, rows.Count, view.Rows.Count, words);
        if (pages > 1)
        {
            var url = SiteRenderer.PageUrl(page.Base, page.Scope, view.Database.Id);
            h.Raw("<nav class=\"pager\"").Attr("aria-label", words.PageNumber(number, pages)).Raw(">");
            if (number > 1) h.Raw("<a").Attr("href", number == 2 ? url : $"{url}?page={number - 1}").Attr("rel", "prev").Raw(">").Text(words.Previous).Raw("</a>");
            h.Raw("<span>").Text(words.PageNumber(number, pages)).Raw("</span>");
            if (number < pages) h.Raw("<a").Attr("href", $"{url}?page={number + 1}").Attr("rel", "next").Raw(">").Text(words.Next).Raw("</a>");
            h.Raw("</nav>\n");
        }
        h.Raw("</section>\n");
    }

    private static void Count(SiteHtml h, int shown, int total, SiteWords words)
    {
        if (total == 0) h.Raw("<p class=\"count\">").Text(words.NoRows).Raw("</p>\n");
        else if (shown < total) h.Raw("<p class=\"count\">").Text(words.Rows(shown, total)).Raw("</p>\n");
    }

    private static void Icon(SiteHtml h, string? icon)
    {
        if (string.IsNullOrWhiteSpace(icon)) return;
        h.Raw("<span class=\"icon\" aria-hidden=\"true\">").Text(icon.Length > 64 ? icon[..64] : icon).Raw("</span>");
    }

    private static void Rows(SiteHtml h, SitePage page, SiteViewData data, List<RowData> rows, SiteWords words)
    {
        switch (data.View.Type)
        {
            case "board" when data.View.Group is not null && data.View.Groups is not null:
                Board(h, page, data, rows, data.View.Group.PropertyId, data.View.Shown.Select(d => d.Id).ToList(), new HashSet<string>(), words, 3);
                break;
            case "gallery":
                Gallery(h, page, data, rows, words);
                break;
            default:
                Table(h, page, data, rows, words);
                break;
        }
    }

    private static string Name(RowData row, SiteWords words) => row.Title.Length > 0 ? row.Title : words.Untitled;

    private static void Table(SiteHtml h, SitePage page, SiteViewData data, List<RowData> rows, SiteWords words)
    {
        var view = data.View;
        h.Raw("<div class=\"table-wrap\"><table>\n<caption>").Text(view.Database.Title.Length > 0 ? view.Database.Title : words.Untitled).Raw("</caption>\n<thead><tr>");
        foreach (var def in view.Shown) h.Raw("<th scope=\"col\">").Text(def.Name).Raw("</th>");
        h.Raw("</tr></thead>\n<tbody>\n");
        foreach (var row in rows)
        {
            h.Raw("<tr>");
            foreach (var def in view.Shown)
            {
                if (def.Type == PropertyTypes.Title)
                {
                    h.Raw("<th scope=\"row\" dir=\"auto\">").Text(Name(row, words)).Raw("</th>");
                    continue;
                }
                h.Raw("<td dir=\"auto\">");
                Cell(h, page, data, def, row, words);
                h.Raw("</td>");
            }
            h.Raw("</tr>\n");
        }
        h.Raw("</tbody>\n</table></div>\n");
    }

    /// <summary>A board's columns: its groups in their order (hidden ones left out), each with its cards.</summary>
    private static void Board(SiteHtml h, SitePage page, SiteViewData data, List<RowData> rows, string groupBy, IReadOnlyList<string> cardProperties,
        IReadOnlySet<string> hidden, SiteWords words, int headingLevel)
    {
        var view = data.View;
        var def = view.Schema.Live(groupBy)!;
        var tag = "h" + headingLevel.ToString(CultureInfo.InvariantCulture);
        h.Raw("<div class=\"board\">\n");
        foreach (var group in view.Groups ?? [])
        {
            if (hidden.Contains(group.Key)) continue;
            var cards = rows.Where(r => Query.GroupKeys(view.Schema, r, view.Group!, data.Context).Contains(group.Key)).ToList();
            h.Raw("<section class=\"column\"><" + tag + ">").Text(GroupLabel(def, group.Key, words)).Raw(" <span class=\"count\">")
                .Text(group.Count.ToString(CultureInfo.InvariantCulture)).Raw("</span></" + tag + ">\n<ul class=\"cards\">\n");
            foreach (var row in cards) Card(h, page, data, row, cardProperties.Where(id => id != groupBy), words);
            h.Raw("</ul></section>\n");
        }
        h.Raw("</div>\n");
    }

    private static void Card(SiteHtml h, SitePage page, SiteViewData data, RowData row, IEnumerable<string> properties, SiteWords words)
    {
        var view = data.View;
        h.Raw("<li class=\"card\"><div dir=\"auto\">").Text(Name(row, words)).Raw("</div>");
        var defs = properties.Select(view.Schema.Live).OfType<PropertyDef>()
            .Where(d => d.Type != PropertyTypes.Title && view.Visible.Contains(d.Id) && Cells.Read(d, row) is not null).ToList();
        if (defs.Count > 0)
        {
            h.Raw("<dl>");
            foreach (var def in defs)
            {
                h.Raw("<dt>").Text(def.Name).Raw("</dt><dd dir=\"auto\">");
                Cell(h, page, data, def, row, words);
                h.Raw("</dd>");
            }
            h.Raw("</dl>");
        }
        h.Raw("</li>\n");
    }

    private static void Gallery(SiteHtml h, SitePage page, SiteViewData data, List<RowData> rows, SiteWords words)
    {
        var view = data.View;
        static string? Text(System.Text.Json.Nodes.JsonNode? node) =>
            node is System.Text.Json.Nodes.JsonValue value && value.TryGetValue<string>(out var s) ? s : null;
        var cover = view.Config?["cover"] as System.Text.Json.Nodes.JsonObject;
        var kind = Text(cover?["kind"]);
        var coverProperty = kind == "property" ? Text(cover?["propertyId"]) : null;
        h.Raw("<ul class=\"gallery\">\n");
        foreach (var row in rows)
        {
            Guid? picture = null;
            if (kind == "pageCover" && data.Covers.TryGetValue(row.Id, out var c)) picture = c;
            else if (coverProperty is not null && view.Visible.Contains(coverProperty) && view.Schema.Live(coverProperty) is { Type: PropertyTypes.Files } files
                     && Cells.Read(files, row) is string[] { Length: > 0 } ids && Guid.TryParse(ids[0], out var first) && page.Assets.TryGetValue(first, out var asset)
                     && AssetTypes.Images.Contains(asset.ContentType))
                picture = first;
            h.Raw("<li class=\"card\">");
            if (picture is { } p) h.Raw("<img").Attr("src", SiteRenderer.FileUrl(page.Base, p)).Attr("alt", "").Raw(" loading=\"lazy\">");
            h.Raw("<div dir=\"auto\">").Text(Name(row, words)).Raw("</div>");
            var defs = view.Shown.Where(d => d.Type != PropertyTypes.Title && view.Visible.Contains(d.Id) && Cells.Read(d, row) is not null).ToList();
            if (defs.Count > 0)
            {
                h.Raw("<dl>");
                foreach (var def in defs)
                {
                    h.Raw("<dt>").Text(def.Name).Raw("</dt><dd dir=\"auto\">");
                    Cell(h, page, data, def, row, words);
                    h.Raw("</dd>");
                }
                h.Raw("</dl>");
            }
            h.Raw("</li>\n");
        }
        h.Raw("</ul>\n");
    }

    /// <summary>What a group's key names: an option, checked or not, a date, or no value.</summary>
    internal static string GroupLabel(PropertyDef def, string key, SiteWords words)
    {
        if (key.Length == 0) return words.NoValue;
        return def.Type switch
        {
            PropertyTypes.Select or PropertyTypes.Status or PropertyTypes.MultiSelect => def.Option(key)?.Name is { Length: > 0 } name ? name : words.NoValue,
            PropertyTypes.Checkbox => key == "true" ? words.Checked : words.NotChecked,
            _ => words.DateKey(key),
        };
    }

    /// <summary>One cell, only of a visible property: a person's, and anything computed from one, stays empty.</summary>
    private static void Cell(SiteHtml h, SitePage page, SiteViewData data, PropertyDef def, RowData row, SiteWords words)
    {
        if (!data.View.Visible.Contains(def.Id)) return;
        var cell = Cells.Read(def, row);
        if (cell is null || Raw.IsError(cell)) return;
        switch (def.Type)
        {
            case PropertyTypes.Url when cell is string url && SiteHtml.SafeUrl(url) is { } safe && safe.StartsWith("http", StringComparison.OrdinalIgnoreCase):
                h.Raw("<a").Attr("href", safe).Raw(" rel=\"noopener noreferrer nofollow\">").Text(url).Raw("</a>");
                return;
            case PropertyTypes.Email when cell is string email && !email.Any(c => c < ' ' || c is ':' or '?' or '&'):
                h.Raw("<a").Attr("href", "mailto:" + email).Raw(">").Text(email).Raw("</a>");
                return;
            case PropertyTypes.Checkbox:
                h.Raw("<input type=\"checkbox\" disabled").Raw(cell is true ? " checked" : "").Attr("aria-label", $"{def.Name}: {(cell is true ? words.Checked : words.NotChecked)}").Raw(">");
                return;
            case PropertyTypes.Select or PropertyTypes.Status:
                Option(h, def, cell as string);
                return;
            case PropertyTypes.MultiSelect:
                foreach (var id in Raw.List(cell)?.OfType<string>() ?? []) Option(h, def, id);
                return;
            case PropertyTypes.Relation:
            {
                var titles = (Raw.List(cell)?.OfType<string>() ?? []).Where(data.Titles.ContainsKey).Select(id => data.Titles[id]).ToList();
                h.Text(string.Join(", ", titles.Select(t => t.Length > 0 ? t : words.Untitled)));
                return;
            }
            case PropertyTypes.Files:
            {
                var first = true;
                foreach (var id in Raw.List(cell)?.OfType<string>() ?? [])
                {
                    if (!Guid.TryParse(id, out var asset) || !page.Assets.TryGetValue(asset, out var file)) continue;
                    if (!first) h.Raw(", ");
                    first = false;
                    h.Raw("<a").Attr("href", SiteRenderer.FileUrl(page.Base, asset)).Raw(" download>").Text(file.FileName).Raw("</a>");
                }
                return;
            }
        }
        h.Text(Plain(cell, words));
    }

    private static void Option(SiteHtml h, PropertyDef def, string? id)
    {
        if (id is null || def.Option(id) is not { } option) return;
        h.Raw("<span").Attr("class", SiteHtml.Colours.Contains(option.Colour) ? "option o-" + option.Colour : "option").Raw(">").Text(option.Name).Raw("</span>");
    }

    /// <summary>A value as words: a number as JavaScript writes it, a date in the site's words, a list joined.</summary>
    private static string Plain(object? cell, SiteWords words) => cell switch
    {
        null => "",
        string s => s,
        double d => JsNumber.ToString(d),
        bool b => b ? words.Checked : words.NotChecked,
        _ when Raw.IsObject(cell) && Raw.Field(cell, "start") is string start => words.DateSpan(start, Raw.Field(cell, "end") as string),
        _ when Raw.List(cell) is { } list => string.Join(", ", list.Select(x => Plain(x, words))),
        _ => "",
    };

    // Plugin blocks ------------------------------------------------------------------------------------------

    public static void Plugin(SiteHtml h, SitePage page, JsonElement body, SiteWords words)
    {
        var type = SiteRenderer.Attr(body, "type");
        if (type is not (ChartType or KanbanType))
        {
            // Phase 10: a third-party plugin runs only in its sandboxed frame in the app; its block
            // is named by its type (isolated, as a Latin name in Arabic words), nothing of its props.
            if (type is { Length: > 0 and <= 64 } named && named.All(c => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '.' or '-'))
            {
                var at = words.PluginHidden.IndexOf("{0}", StringComparison.Ordinal);
                h.Raw("<div class=\"placeholder\" role=\"note\">").Text(words.PluginHidden[..at]).Raw("<bdi>").Text(named).Raw("</bdi>")
                    .Text(words.PluginHidden[(at + 3)..]).Raw("</div>\n");
            }
            else SiteRenderer.Placeholder(h, words.BlockHidden);
            return;
        }
        var props = SiteRenderer.Props(body);
        var database = Guid.TryParse(Str(Js.Prop(props, "databaseId")), out var d) ? d : (Guid?)null;
        var viewId = Guid.TryParse(Str(Js.Prop(props, "viewId")), out var v) ? v : (Guid?)null;
        var groupBy = GroupOf(type, Str(Js.Prop(props, "groupBy")) is { Length: > 0 } g ? g : null);
        SiteViewData? data = null;
        if (database is { } id) page.Views.TryGetValue(SiteRenderer.ViewKey(id, viewId, groupBy), out data);
        if (type == ChartType) Chart(h, data, props, words);
        else Kanban(h, page, data, props, words);
    }

    private static void Kanban(SiteHtml h, SitePage page, SiteViewData? data, JsonElement props, SiteWords words)
    {
        if (data?.View is not { Group: { } group, Groups: not null } view || view.Schema.Live(group.PropertyId) is not { Type: PropertyTypes.Select or PropertyTypes.Status })
        {
            SiteRenderer.Placeholder(h, words.BoardHidden);
            return;
        }
        var cards = Js.Prop(props, "cardProperties") is { ValueKind: JsonValueKind.Array } list
            ? list.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).Distinct(StringComparer.Ordinal).Take(20).ToList()
            : [];
        var hidden = Js.Prop(props, "hidden") is { ValueKind: JsonValueKind.Array } keys
            ? keys.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToHashSet(StringComparer.Ordinal)
            : [];
        h.Raw("<section class=\"database\"").Attr("aria-label", $"{words.Board}: {view.Database.Title}").Raw(">\n<div class=\"db-title\">").Text(view.Database.Title).Raw("</div>\n");
        var rows = view.Rows.Take(SiteRenderer.BlockRows).ToList();
        Board(h, page, data, rows, group.PropertyId, cards, hidden, words, 3);
        Count(h, rows.Count, view.Rows.Count, words);
        h.Raw("</section>\n");
    }

    private sealed record Point(string Label, double? Value);

    /// <summary>The chart block (<c>cashgear.chart</c>): its own kind, group and measure over its view's rows.</summary>
    private static void Chart(SiteHtml h, SiteViewData? data, JsonElement props, SiteWords words)
    {
        if (data is null)
        {
            SiteRenderer.Placeholder(h, words.ChartHidden);
            return;
        }
        var view = data.View;
        var kind = Str(Js.Prop(props, "chart")) is ("line" or "pie" or "number") and var k ? k : "bar";
        var measure = Js.Prop(props, "measure");
        var measureKind = Str(Js.Prop(measure, "kind")) is ("sum" or "average") and var mk ? mk : "count";
        PropertyDef? measured = null;
        if (measureKind != "count")
        {
            var id = Str(Js.Prop(measure, "propertyId"));
            measured = id is null ? null : view.Schema.Live(id);
            // Only a number the view shows: a sum of a hidden property would tell its values.
            if (measured is null || !ChartView.Measurable.Contains(measured.Type) || !view.Visible.Contains(measured.Id))
            {
                SiteRenderer.Placeholder(h, words.ChartHidden);
                return;
            }
        }
        var groupBy = Str(Js.Prop(props, "groupBy")) is { Length: > 0 } g ? g : null;
        List<Point> points;
        var partial = false;
        if (groupBy is null)
        {
            points = [new Point(MeasureWord(measureKind, words), measured is null ? view.Rows.Count : Measure(view.Rows.Take(ChartRows), measureKind, measured))];
            partial = measured is not null && view.Rows.Count > ChartRows;
        }
        else
        {
            if (view.Group is not { } rule || rule.PropertyId != groupBy || view.Groups is null || view.Schema.Live(groupBy) is not { } groupDef)
            {
                SiteRenderer.Placeholder(h, words.ChartHidden);
                return;
            }
            points = GroupPoints(data, rule, groupDef, measureKind, measured, words, out partial);
        }
        var title = Str(Js.Prop(props, "title")) is { Length: > 0 } t ? (t.Length > 200 ? t[..200] : t) : $"{MeasureWord(measureKind, words)}: {view.Database.Title}";
        Figure(h, kind == "number" || groupBy is null ? "number" : kind, points, title, MeasureWord(measureKind, words), partial, words);
    }

    /// <summary>
    /// A chart view (Phase 12): drawn as the chart block is, from its view's <c>chart</c> settings,
    /// grouped by the view's own group; its placeholder when it has no group or its group or measure
    /// is a property the view does not show (<see cref="ChartView"/>, as a share link refuses it).
    /// </summary>
    private static void ViewChart(SiteHtml h, SiteViewData data, SiteWords words)
    {
        var (chart, _) = ChartView.Read(data.View);
        if (chart is null)
        {
            SiteRenderer.Placeholder(h, words.ChartHidden);
            return;
        }
        var points = GroupPoints(data, chart.Group, chart.GroupDef, chart.Measure, chart.Measured, words, out var partial);
        var title = chart.Title ?? chart.Measure switch
        {
            "sum" => string.Format(CultureInfo.InvariantCulture, words.SumBy, chart.Measured!.Name, chart.GroupDef.Name),
            "average" => string.Format(CultureInfo.InvariantCulture, words.AverageBy, chart.Measured!.Name, chart.GroupDef.Name),
            _ => string.Format(CultureInfo.InvariantCulture, words.CountBy, chart.GroupDef.Name),
        };
        Figure(h, chart.Kind, points, title, MeasureWord(chart.Measure, words), partial, words);
    }

    /// <summary>
    /// One point per group, in the query's group order: its count from the query, or the sum or
    /// average of the measure over the group's rows, at most <see cref="ChartRows"/> rows in all read
    /// group by group, as the app's chart reads them (<paramref name="partial"/> when some were not).
    /// </summary>
    private static List<Point> GroupPoints(SiteViewData data, GroupRule rule, PropertyDef groupDef, string measureKind, PropertyDef? measured, SiteWords words, out bool partial)
    {
        var view = data.View;
        partial = false;
        Dictionary<string, List<RowData>>? byGroup = null;
        if (measured is not null)
        {
            byGroup = new Dictionary<string, List<RowData>>(StringComparer.Ordinal);
            foreach (var row in view.Rows)
                foreach (var key in Query.GroupKeys(view.Schema, row, rule, data.Context))
                {
                    if (!byGroup.TryGetValue(key, out var list)) byGroup[key] = list = [];
                    list.Add(row);
                }
        }
        var left = ChartRows;
        var points = new List<Point>();
        foreach (var group in view.Groups ?? [])
        {
            double? value = group.Count;
            if (byGroup is not null)
            {
                var rows = byGroup.GetValueOrDefault(group.Key) ?? [];
                var read = rows.Take(Math.Max(left, 0)).ToList();
                if (read.Count < rows.Count) partial = true;
                left -= read.Count;
                value = Measure(read, measureKind, measured!);
            }
            points.Add(new Point(GroupLabel(groupDef, group.Key, words), value));
        }
        return points;
    }

    /// <summary>A sum or an average of the measure's finite numbers; an average of none is no value.</summary>
    private static double? Measure(IEnumerable<RowData> rows, string kind, PropertyDef measured)
    {
        var numbers = rows.Select(r => Cells.Read(measured, r)).OfType<double>().Where(double.IsFinite).ToList();
        if (kind == "sum") return numbers.Sum();
        return numbers.Count > 0 ? numbers.Average() : null;
    }

    /// <summary>
    /// The one drawing of a chart, the block's and the view's: its title, one number or the SVG
    /// (bars, a line or a pie), its numbers always as a table, and a note when a sum or an average
    /// read only some rows. A chart of no groups says there are no rows.
    /// </summary>
    private static void Figure(SiteHtml h, string kind, List<Point> points, string title, string measureWord, bool partial, SiteWords words)
    {
        h.Raw("<figure class=\"chart\">\n<figcaption>").Text(title).Raw("</figcaption>\n");
        if (kind == "number") h.Raw("<p class=\"number\">").Text(Number(points.Sum(p => p.Value ?? 0))).Raw("</p>\n");
        else if (points.Count == 0) h.Raw("<p class=\"count\">").Text(words.NoRows).Raw("</p>\n");
        else Svg(h, kind, points, title);
        if (points.Count > 0)
        {
            h.Raw("<div class=\"table-wrap\"><table>\n<thead><tr><th scope=\"col\">").Text(words.Group).Raw("</th><th scope=\"col\">").Text(measureWord)
                .Raw("</th></tr></thead>\n<tbody>\n");
            foreach (var point in points)
                h.Raw("<tr><th scope=\"row\" dir=\"auto\">").Text(point.Label).Raw("</th><td>").Text(point.Value is { } value ? Number(value) : "").Raw("</td></tr>\n");
            h.Raw("</tbody>\n</table></div>\n");
        }
        if (partial) h.Raw("<p class=\"count\">").Text(string.Format(CultureInfo.InvariantCulture, words.ChartPartial, ChartRows.ToString("N0", CultureInfo.InvariantCulture))).Raw("</p>\n");
        h.Raw("</figure>\n");
    }

    private static string MeasureWord(string kind, SiteWords words) => kind switch { "sum" => words.Sum, "average" => words.Average, _ => words.Count };

    private static string Number(double value) => JsNumber.ToString(double.IsFinite(value) ? value : 0);

    private static string F(double value) => value.ToString("0.##", CultureInfo.InvariantCulture);

    /// <summary>A bar, line or pie chart in a 600 by 300 box, coloured by the stylesheet's classes; the table beside it holds its numbers.</summary>
    private static void Svg(SiteHtml h, string kind, List<Point> points, string title)
    {
        const double width = 600, height = 300, pad = 30;
        h.Raw("<svg viewBox=\"0 0 600 300\" role=\"img\"").Attr("aria-label", title).Raw(" xmlns=\"http://www.w3.org/2000/svg\">\n");
        var max = Math.Max(points.Max(p => p.Value ?? 0), 0);
        if (max <= 0) max = 1;
        var n = Math.Max(points.Count, 1);
        switch (kind)
        {
            case "pie":
            {
                var total = points.Sum(p => Math.Max(p.Value ?? 0, 0));
                double cx = width / 2, cy = height / 2, r = height / 2 - pad, angle = -Math.PI / 2;
                var i = 0;
                foreach (var point in points)
                {
                    var share = total > 0 ? Math.Max(point.Value ?? 0, 0) / total : 0;
                    if (share <= 0)
                    {
                        i++;
                        continue;
                    }
                    var cls = "slice-" + (i % 8).ToString(CultureInfo.InvariantCulture);
                    if (share >= 0.9999)
                        h.Raw("<circle").Attr("class", cls).Attr("cx", F(cx)).Attr("cy", F(cy)).Attr("r", F(r)).Raw(">");
                    else
                    {
                        var next = angle + share * 2 * Math.PI;
                        var large = share > 0.5 ? 1 : 0;
                        h.Raw("<path").Attr("class", cls).Attr("d",
                            $"M{F(cx)} {F(cy)} L{F(cx + r * Math.Cos(angle))} {F(cy + r * Math.Sin(angle))} A{F(r)} {F(r)} 0 {large} 1 {F(cx + r * Math.Cos(next))} {F(cy + r * Math.Sin(next))} Z").Raw(">");
                        angle = next;
                    }
                    h.Raw("<title>").Text(point.Label).Raw("</title>");
                    h.Raw(share >= 0.9999 ? "</circle>\n" : "</path>\n");
                    i++;
                }
                break;
            }
            case "line":
            {
                var step = n > 1 ? (width - 2 * pad) / (n - 1) : 0;
                var coordinates = points.Select((p, i) => (X: pad + i * step, Y: height - pad - (p.Value ?? 0) / max * (height - 2 * pad))).ToList();
                h.Raw("<line class=\"axis\"").Attr("x1", F(pad)).Attr("y1", F(height - pad)).Attr("x2", F(width - pad)).Attr("y2", F(height - pad)).Raw("/>\n");
                h.Raw("<polyline class=\"line\"").Attr("points", string.Join(' ', coordinates.Select(c => $"{F(c.X)},{F(c.Y)}"))).Raw("/>\n");
                foreach (var (c, point) in coordinates.Zip(points))
                    h.Raw("<circle class=\"dot\"").Attr("cx", F(c.X)).Attr("cy", F(c.Y)).Attr("r", "4").Raw("><title>").Text(point.Label).Raw("</title></circle>\n");
                break;
            }
            default:
            {
                var slot = (width - 2 * pad) / n;
                var bar = Math.Max(slot * 0.7, 1);
                h.Raw("<line class=\"axis\"").Attr("x1", F(pad)).Attr("y1", F(height - pad)).Attr("x2", F(width - pad)).Attr("y2", F(height - pad)).Raw("/>\n");
                for (var i = 0; i < points.Count; i++)
                {
                    var value = Math.Max(points[i].Value ?? 0, 0);
                    var tall = value / max * (height - 2 * pad);
                    h.Raw("<rect class=\"bar\"").Attr("x", F(pad + i * slot + (slot - bar) / 2)).Attr("y", F(height - pad - tall)).Attr("width", F(bar)).Attr("height", F(tall))
                        .Raw("><title>").Text(points[i].Label).Raw("</title></rect>\n");
                }
                break;
            }
        }
        h.Raw("</svg>\n");
    }
}
