using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sharing;

/// <summary>A database as a share link shows it: its page's title and icon and its properties' definitions.</summary>
public sealed record SharedDatabaseInfoDto(Guid Id, string Title, string? Icon, JsonElement Properties);

/// <summary><c>GET /shared/databases/{id}</c>: the database and its views, in order.</summary>
public sealed record SharedDatabaseDto(SharedDatabaseInfoDto Database, IReadOnlyList<ViewDto> Views);

/// <summary>
/// <c>POST /shared/databases/{id}/query</c>: always through a view (<c>viewId</c>, else the
/// database's first), with its own filter, sorts and group. A filter, sort or group the reader
/// sends is not read; <c>search</c> is the title search; <c>window</c> may name only a property the
/// view shows; <c>context</c> gives today and the reader's offset (nothing else of it is read);
/// <c>undated</c> asks a calendar's or a timeline's rows with no value in its own date property (the
/// list beside it), the view's filter still applied. A chart view (Phase 12) shows only its group's
/// and its measure's values, and is refused, <c>chart.hidden</c> (403), when either may not leave.
/// </summary>
public sealed record SharedQueryRequestDto(
    Guid? ViewId = null,
    string? GroupKey = null,
    string? After = null,
    int? Limit = null,
    string? Search = null,
    QueryContextDto? Context = null,
    QueryWindowDto? Window = null,
    bool? Undated = null);

/// <summary>
/// The query's answer in <c>queryDatabase</c>'s shape: each row's values cut to what the view
/// shows, no person's id anywhere; <c>titles</c> names the related rows a shown relation cell
/// holds, each in a database the scope holds.
/// </summary>
public sealed record SharedQueryResponseDto(IReadOnlyList<RowDto> Rows, IReadOnlyList<GroupCountDto>? Groups, long Total, string? Next, IReadOnlyDictionary<string, string> Titles);

/// <summary>
/// One view of a database in a scope, evaluated: its rows in order (after its own filter, sorts and
/// group; a search and a window when asked), and what may leave of them.
/// </summary>
public sealed class ScopedView
{
    public required Page Database { get; init; }
    public required WorkspaceDatabase Record { get; init; }
    public required Schema Schema { get; init; }
    /// <summary>Null for a database with no views: every property shown, no filter.</summary>
    public DatabaseView? View { get; init; }
    public required string Type { get; init; }
    public JsonObject? Config { get; init; }
    /// <summary>The view's shown properties in order, title first (people's included: they draw empty).</summary>
    public required IReadOnlyList<PropertyDef> Shown { get; init; }
    /// <summary>The properties whose values may leave: shown or laying the view out, and never a person's.</summary>
    public required IReadOnlySet<string> Visible { get; init; }
    public required List<RowData> Rows { get; init; }
    public List<GroupCount>? Groups { get; init; }
    /// <summary>The group the rows were read by (the view's, or a chart's or board's own); null for none.</summary>
    public GroupRule? Group { get; init; }
    /// <summary>The databases the scope holds, by page id.</summary>
    public required IReadOnlySet<Guid> ScopeDatabases { get; init; }
}

/// <summary>
/// A database's rows read with no account (Phase 9; DECISIONS.md 2026-11-17), on share links and
/// published sites alike: only a database whose page the scope holds, always through one of its
/// views (its filter, sorts and group), and of each row only the values of the properties that view
/// shows (or lays its rows out by: a board's group, a calendar's date, a timeline's dates and lanes, a
/// gallery's cover), so a hidden property's values never leave and cannot be probed. Never a
/// person: person, created-by and edited-by cells are left out, and a formula or rollup that reads
/// one; a rollup is kept only when its relation's database is in the scope. A relation cell keeps
/// only rows of a database the scope holds, named by <c>titles</c>. Row pages stay closed.
/// </summary>
public sealed partial class SharedDatabases(CgwDb db, DatabaseRowCache cache, TimeProvider clock)
{
    public const int DefaultLimit = 100;
    public const int MaxLimit = 500;

    private static readonly ConcurrentDictionary<string, (long At, Query.Result Result)> Results = new(StringComparer.Ordinal);

    private static bool People(string type) => type is PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy;

    [GeneratedRegex("""prop\(\s*"([^"]*)"\s*\)""")]
    private static partial Regex PropReference();

    /// <summary>The database pages the scope holds.</summary>
    public static HashSet<Guid> DatabasesOf(PageScope scope) => scope.Pages.Where(p => p.Kind == PageKinds.Database).Select(p => p.Id).ToHashSet();

    // The database -------------------------------------------------------------------------------------

    public async Task<Result<SharedDatabaseDto>> DatabaseAsync(PageScope scope, Guid databaseId, CancellationToken ct = default)
    {
        var page = scope.Pages.FirstOrDefault(p => p.Id == databaseId && p.Kind == PageKinds.Database);
        if (page is null) return Failure.NotFound("No such database");
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == databaseId, ct);
        if (record is null) return Failure.NotFound("No such database");
        var views = await db.DatabaseViews.AsNoTracking().Where(v => v.DatabaseId == databaseId).ToListAsync(ct);
        // Every live property's definition: definitions (names, types, options) are what the view
        // draws by; values come only through the query, cut to the view.
        var live = new JsonArray(DatabaseService.SchemaOf(record).Properties.Where(p => !p.Trashed).Select(p => (JsonNode?)p.Json.DeepClone()).ToArray());
        using var properties = JsonDocument.Parse(live.ToJsonString());
        return new SharedDatabaseDto(
            new SharedDatabaseInfoDto(page.Id, page.Title, page.Icon, properties.RootElement.Clone()),
            views.OrderBy(v => v.OrderKey, StringComparer.Ordinal).ThenBy(v => v.Id.ToString(), StringComparer.Ordinal).Select(ViewDto.From).ToList());
    }

    // A view's rows -------------------------------------------------------------------------------------

    /// <summary>A reader's context: today and their offset; never "me" or people's names.</summary>
    public QueryContext Context(QueryContextDto? given)
    {
        var offset = Math.Clamp(given?.OffsetMinutes ?? 0, -14 * 60, 14 * 60);
        var today = given?.Today is { } t && DbDates.IsDay(t)
            ? t
            : clock.GetUtcNow().ToOffset(TimeSpan.FromMinutes(offset)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return new QueryContext(today, offset, null, null);
    }

    /// <summary>
    /// The view (<paramref name="viewId"/>, else the database's first) of a database the scope
    /// holds, evaluated over the cached rows; 404 for a database or view the scope does not hold.
    /// </summary>
    public async Task<Result<ScopedView>> OpenViewAsync(PageScope scope, Guid databaseId, Guid? viewId, QueryContext ctx,
        string? search = null, string? groupKey = null, QueryWindowDto? window = null, bool undated = false, CancellationToken ct = default) =>
        await OpenViewAsync(scope, databaseId, viewId, ctx, search, groupKey, window, null, ct, undated);

    /// <summary>
    /// <see cref="OpenViewAsync(PageScope, Guid, Guid?, QueryContext, string?, string?, QueryWindowDto?, bool, CancellationToken)"/>,
    /// grouped by <paramref name="groupBy"/> in place of the view's group: a published chart's or
    /// board's own property, refused (404) unless the view shows it.
    /// </summary>
    public async Task<Result<ScopedView>> OpenViewAsync(PageScope scope, Guid databaseId, Guid? viewId, QueryContext ctx,
        string? search, string? groupKey, QueryWindowDto? window, string? groupBy, CancellationToken ct = default, bool undated = false)
    {
        var page = scope.Pages.FirstOrDefault(p => p.Id == databaseId && p.Kind == PageKinds.Database);
        if (page is null) return Failure.NotFound("No such database");
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == databaseId, ct);
        if (record is null) return Failure.NotFound("No such database");
        var schema = DatabaseService.SchemaOf(record);
        DatabaseView? view;
        if (viewId is { } id)
        {
            view = await db.DatabaseViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == id && v.DatabaseId == databaseId, ct);
            if (view is null) return Failure.NotFound("No such view");
        }
        else
            view = (await db.DatabaseViews.AsNoTracking().Where(v => v.DatabaseId == databaseId).ToListAsync(ct))
                .OrderBy(v => v.OrderKey, StringComparer.Ordinal).ThenBy(v => v.Id.ToString(), StringComparer.Ordinal).FirstOrDefault();
        var config = view is null ? null : JsonNode.Parse(string.IsNullOrEmpty(view.Config) ? "{}" : view.Config) as JsonObject;
        var databases = DatabasesOf(scope);
        var type = view?.Type ?? "table";
        var shown = ShownBy(schema, type, config);
        var visible = await VisibleAsync(schema, type, config, shown, databases, ct);

        DateWindow? dates = null;
        if (window is not null)
        {
            if (!visible.Contains(window.PropertyId) || (window.EndPropertyId is { Length: > 0 } end && !visible.Contains(end)))
                return Failure.Invalid("A window names only a property the view shows");
            if (!DbDates.IsDay(window.From) || !DbDates.IsDay(window.To)) return Failure.Invalid("window's from and to are YYYY-MM-DD dates");
            dates = new DateWindow(window.PropertyId, window.EndPropertyId is { Length: > 0 } e ? e : null, window.From, window.To);
        }
        var spec = view is null ? new QuerySpec() : QuerySpec.FromView(view.Config);
        string? undatedBy = null;
        if (undated)
        {
            // The view's own date property, which it shows by position: the list of rows with none.
            undatedBy = LayoutDate(view?.Type ?? "table", config);
            if (undatedBy is null || !visible.Contains(undatedBy)) return Failure.Invalid("undated is for a calendar or a timeline with a date property");
            var both = new JsonObject
            {
                ["kind"] = "group",
                ["op"] = "and",
                ["children"] = new JsonArray(
                    config?["filter"] is JsonObject own ? own.DeepClone() : new JsonObject { ["kind"] = "group", ["op"] = "and", ["children"] = new JsonArray() },
                    new JsonObject { ["kind"] = "condition", ["propertyId"] = undatedBy, ["operator"] = "isEmpty" }),
            };
            using var parsed = JsonDocument.Parse(both.ToJsonString());
            spec = new QuerySpec { Filter = QuerySpec.ReadFilter(parsed.RootElement), Sorts = spec.Sorts, Group = spec.Group };
        }
        if (groupBy is not null)
        {
            if (!visible.Contains(groupBy)) return Failure.NotFound("The view does not show that property");
            spec = new QuerySpec { Filter = spec.Filter, Sorts = spec.Sorts, Group = new GroupRule(groupBy, null, false, []) };
        }
        // Groups by a person would name people by their ids: such a view reads ungrouped.
        var group = spec.Group is { } rule && schema.Live(rule.PropertyId) is { } groupDef && People(groupDef.Type) ? null : spec.Group;
        if (group is null) groupKey = null;
        spec = new QuerySpec { Filter = spec.Filter, Sorts = spec.Sorts, Group = group, Search = search, Window = dates };

        var snapshot = await cache.RowsAsync(db, record, ct);
        var key = string.Join('|', databaseId, record.Version, snapshot.Version, view?.Id, view?.Version, search, groupKey, groupBy, undatedBy,
            dates is null ? "" : $"{dates.PropertyId},{dates.EndPropertyId},{dates.From},{dates.To}", ctx.Today, ctx.OffsetMinutes.ToString(CultureInfo.InvariantCulture));
        Query.Result result;
        if (Results.TryGetValue(key, out var kept)) result = kept.Result;
        else
        {
            result = Query.Run(schema, snapshot.Rows.Values, spec, ctx, groupKey);
            if (Results.Count >= 64)
                foreach (var old in Results.OrderBy(r => r.Value.At).Take(16).ToList()) Results.TryRemove(old.Key, out _);
            Results[key] = (Environment.TickCount64, result);
        }
        return new ScopedView
        {
            Database = page,
            Record = record,
            Schema = schema,
            View = view,
            Type = view?.Type ?? "table",
            Config = config,
            Shown = shown,
            Visible = visible,
            Rows = result.Rows,
            Groups = result.Groups,
            Group = result.Groups is null ? null : group,
            ScopeDatabases = databases,
        };
    }

    /// <summary>A calendar's or a timeline's date property (its rows' place), else null.</summary>
    public static string? LayoutDate(string type, JsonObject? config)
    {
        static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        return type switch
        {
            "calendar" => Str(config?["calendarBy"]),
            "timeline" => Str((config?["timeline"] as JsonObject)?["start"]),
            _ => null,
        };
    }

    /// <summary>
    /// A view's shown properties in order, title first: its <c>properties</c>' order less its hidden
    /// ones; a chart view's exactly the title, its group's and its measure's (Phase 12,
    /// <see cref="ChartView.Shown"/>), so a property added after it was made never leaves through it.
    /// </summary>
    public static List<PropertyDef> ShownBy(Schema schema, string type, JsonObject? config) =>
        type == ChartView.Type ? ChartView.Shown(schema, config) : Csv.Shown(schema, config);

    /// <summary>The properties a view lays its rows out by, beside the ones it shows (a chart's are among its shown ones).</summary>
    public static IEnumerable<string> LayoutProperties(string type, JsonObject? config)
    {
        static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        if (config is null || type == ChartView.Type) yield break;
        if (Str((config["group"] as JsonObject)?["propertyId"]) is { } group) yield return group;
        switch (type)
        {
            case "calendar":
                if (Str(config["calendarBy"]) is { } by) yield return by;
                break;
            case "timeline":
                if (config["timeline"] is JsonObject timeline)
                    foreach (var name in new[] { "start", "end", "lane" })
                        if (Str(timeline[name]) is { } id) yield return id;
                break;
            case "gallery":
                if (config["cover"] is JsonObject cover && Str(cover["kind"]) == "property" && Str(cover["propertyId"]) is { } picture) yield return picture;
                break;
        }
    }

    /// <summary>What may leave of a view's rows: its shown and layout properties, live, never a person's or computed from one.</summary>
    private async Task<HashSet<string>> VisibleAsync(Schema schema, string type, JsonObject? config, IReadOnlyList<PropertyDef> shown, IReadOnlySet<Guid> databases, CancellationToken ct)
    {
        var wanted = shown.Select(d => d.Id).Concat(LayoutProperties(type, config)).ToHashSet(StringComparer.Ordinal);
        var others = new Dictionary<Guid, Schema?>();
        async Task<Schema?> SchemaAsync(Guid id)
        {
            if (others.TryGetValue(id, out var known)) return known;
            var record = databases.Contains(id) ? await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == id, ct) : null;
            return others[id] = record is null ? null : DatabaseService.SchemaOf(record);
        }
        var visible = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in wanted)
            if (schema.Live(id) is { } def && await AllowedAsync(schema, def, databases, SchemaAsync, [], 0))
                visible.Add(id);
        return visible;
    }

    /// <summary>
    /// Whether a property's values may leave: not a person's; a relation only into a database the
    /// scope holds; a rollup only over such a relation, of a property allowed there; a formula only
    /// of allowed properties. Anything that cannot be decided (a cycle, too deep) is not allowed.
    /// </summary>
    private static async Task<bool> AllowedAsync(Schema schema, PropertyDef def, IReadOnlySet<Guid> databases, Func<Guid, Task<Schema?>> schemas, HashSet<string> seen, int depth)
    {
        if (def.Trashed || People(def.Type)) return false;
        if (depth > 8 || !seen.Add($"{schema.IdText}/{def.Id}")) return false;
        switch (def.Type)
        {
            case PropertyTypes.Relation:
                return def.RelationDatabaseId is { } into && databases.Contains(into);
            case PropertyTypes.Rollup:
            {
                if (def.RollupRelation is not { } relationId || schema.Live(relationId) is not { Type: PropertyTypes.Relation } relation
                    || relation.RelationDatabaseId is not { } target || !databases.Contains(target)) return false;
                if (await schemas(target) is not { } other || def.RollupTarget is not { } targetId || other.Live(targetId) is not { } targetDef) return false;
                return await AllowedAsync(other, targetDef, databases, schemas, seen, depth + 1);
            }
            case PropertyTypes.Formula:
                foreach (Match match in PropReference().Matches(def.Expression ?? ""))
                {
                    var read = schema.Live(match.Groups[1].Value);
                    // A formula naming something that is not there reads nothing of it.
                    if (read is not null && !await AllowedAsync(schema, read, databases, schemas, seen, depth + 1)) return false;
                }
                return true;
            default:
                return true;
        }
    }

    /// <summary>
    /// Rows of a view as they may leave: values and computed results of its visible properties only,
    /// relation cells with only rows the scope holds, no person's id; and those rows' titles.
    /// </summary>
    public async Task<(List<RowDto> Rows, Dictionary<string, string> Titles)> ProjectAsync(ScopedView view, IReadOnlyList<RowData> rows, CancellationToken ct = default)
    {
        var schema = view.Schema;
        var titles = await RelatedTitlesAsync(view, rows, ct);
        var ids = rows.Select(r => r.Id).ToList();
        var pages = new Dictionary<Guid, Page>();
        foreach (var chunk in ids.Chunk(1000).Select(c => c.ToList()))
            foreach (var p in await db.Pages.AsNoTracking().Where(p => chunk.Contains(p.Id)).ToListAsync(ct))
                pages[p.Id] = p;

        // A row's times are a property's values too: sent only when the view shows that property.
        var created = view.Visible.Any(id => schema.Live(id) is { Type: PropertyTypes.CreatedTime });
        var edited = view.Visible.Any(id => schema.Live(id) is { Type: PropertyTypes.LastEditedTime });
        var result = new List<RowDto>(rows.Count);
        foreach (var row in rows)
        {
            if (!pages.TryGetValue(row.Id, out var page) || page.DeletedAt is not null) continue;
            var values = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var (key, value) in row.Values)
            {
                if (!view.Visible.Contains(key) || schema.Live(key) is not { } def || !PropertyTypes.IsStored(def.Type)) continue;
                if (def.Type == PropertyTypes.Relation)
                {
                    var kept = (value as string[] ?? []).Where(titles.ContainsKey).ToArray();
                    if (kept.Length > 0) values[key] = kept;
                    continue;
                }
                values[key] = value;
            }
            var computed = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (key, value) in row.Computed)
                if (view.Visible.Contains(key) && schema.Live(key) is { } def && PropertyTypes.IsComputed(def.Type))
                    computed[key] = value;
            result.Add(new RowDto(page.Id, Guid.Empty, Guid.Empty, page.ParentPageId, page.OrderKey, "row", page.Title, page.Icon, page.CoverAssetId,
                false, null, page.Version, created ? page.CreatedAt : DateTimeOffset.UnixEpoch, edited ? page.UpdatedAt : DateTimeOffset.UnixEpoch,
                null, null, false, 0, 0, 1, Levels.View, row.DatabaseId,
                Element(ValueJson.WriteMap(values)), Element("{}"), Element(ValueJson.WriteMap(computed)), row.ComputedVersion, null, null));
        }
        return (result, titles);
    }

    /// <summary>
    /// The titles of the rows the view's visible relation cells name, of those rows that are live
    /// and in a database the scope holds: a relation cell shows only these.
    /// </summary>
    public async Task<Dictionary<string, string>> RelatedTitlesAsync(ScopedView view, IReadOnlyList<RowData> rows, CancellationToken ct = default)
    {
        var schema = view.Schema;
        var relations = view.Visible.Select(schema.Live).OfType<PropertyDef>().Where(d => d.Type == PropertyTypes.Relation).ToList();
        var related = relations.SelectMany(d => rows.SelectMany(r => r.Values.GetValueOrDefault(d.Id) as string[] ?? []))
            .Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).Distinct().ToList();
        var titles = new Dictionary<string, string>(StringComparer.Ordinal);
        var databases = view.ScopeDatabases.ToList();
        foreach (var chunk in related.Chunk(1000).Select(c => c.ToList()))
            foreach (var p in await db.Pages.AsNoTracking()
                         .Where(p => chunk.Contains(p.Id) && p.Kind == PageKinds.Row && p.DeletedAt == null && p.TrashedAt == null && !p.IsTemplate
                             && p.ParentPageId != null && databases.Contains(p.ParentPageId.Value))
                         .Select(p => new { p.Id, p.Title }).ToListAsync(ct))
                titles[p.Id.ToString()] = p.Title;
        return titles;
    }

    private static JsonElement Element(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    /// <summary>The query route's work: a view's page of rows, by an offset cursor that says nothing of any value.</summary>
    public async Task<Result<SharedQueryResponseDto>> QueryAsync(PageScope scope, Guid databaseId, SharedQueryRequestDto request, CancellationToken ct = default)
    {
        var size = Math.Clamp(request.Limit ?? DefaultLimit, 1, MaxLimit);
        var start = 0;
        if (!string.IsNullOrEmpty(request.After))
        {
            if (ReadCursor(request.After) is not { } at) return Failure.Invalid("The cursor is not valid");
            start = at;
        }
        var search = request.Search is { Length: > 200 } s ? s[..200] : request.Search;
        var opened = await OpenViewAsync(scope, databaseId, request.ViewId, Context(request.Context), search, request.GroupKey, request.Window, request.Undated == true, ct);
        if (!opened.Ok) return opened.Failure!;
        var view = opened.Value!;
        // Phase 12: a chart view's group and measure must be values that may leave (a site draws its
        // placeholder for the same views).
        if (ChartView.Hides(view)) return new Failure(Codes.ChartHidden, 403, "The chart's group or measure cannot be shown by a link");
        var page = view.Rows.Skip(start).Take(size).ToList();
        var (rows, titles) = await ProjectAsync(view, page, ct);
        var next = start + page.Count < view.Rows.Count && page.Count > 0 ? Cursor(start + page.Count) : null;
        return new SharedQueryResponseDto(rows, view.Groups?.Select(g => new GroupCountDto(g.Key, g.Count)).ToList(), view.Rows.Count, next, titles);
    }

    /// <summary>A position in the view's order, opaque to clients; unlike the members' query's keyset cursor it holds no sort key (a sort may be on a hidden property).</summary>
    public static string Cursor(int offset) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes("o:" + offset.ToString(CultureInfo.InvariantCulture))).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static int? ReadCursor(string cursor)
    {
        try
        {
            var text = cursor.Replace('-', '+').Replace('_', '/');
            text = text.PadRight(text.Length + (4 - text.Length % 4) % 4, '=');
            var plain = Encoding.UTF8.GetString(Convert.FromBase64String(text));
            return plain.StartsWith("o:", StringComparison.Ordinal) && int.TryParse(plain[2..], NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    // Files ---------------------------------------------------------------------------------------------

    /// <summary>
    /// Whether a database the scope holds shows the asset: a row's cover, or a file cell of a
    /// property some view of it shows (every property, for a database with no views).
    /// </summary>
    public async Task<bool> ShowsFileAsync(PageScope scope, Guid assetId, CancellationToken ct = default)
    {
        var databases = DatabasesOf(scope).ToList();
        if (databases.Count == 0) return false;
        if (await db.Pages.AsNoTracking().AnyAsync(p => p.CoverAssetId == assetId && p.Kind == PageKinds.Row && p.DeletedAt == null && p.TrashedAt == null
                && !p.IsTemplate && p.ParentPageId != null && databases.Contains(p.ParentPageId.Value), ct))
            return true;
        // Phase 14: by the index of rows' files, not a scan of the rows' values.
        var holding = await db.DatabaseRowFiles.AsNoTracking()
            .Where(f => f.AssetId == assetId && databases.Contains(f.DatabaseId))
            .Join(db.Pages.Where(p => p.DeletedAt == null && p.TrashedAt == null && !p.IsTemplate), f => f.RowId, p => p.Id, (f, p) => new { f.DatabaseId, f.PropertyId })
            .Distinct().OrderBy(r => r.DatabaseId).ThenBy(r => r.PropertyId).Take(200).ToListAsync(ct);
        foreach (var group in holding.GroupBy(r => r.DatabaseId))
        {
            var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == group.Key, ct);
            if (record is null) continue;
            var schema = DatabaseService.SchemaOf(record);
            var views = await db.DatabaseViews.AsNoTracking().Where(v => v.DatabaseId == group.Key).ToListAsync(ct);
            var shown = views.Count == 0
                ? schema.Properties.Where(p => !p.Trashed).Select(p => p.Id).ToHashSet(StringComparer.Ordinal)
                : views.SelectMany(v =>
                {
                    var config = JsonNode.Parse(string.IsNullOrEmpty(v.Config) ? "{}" : v.Config) as JsonObject;
                    return ShownBy(schema, v.Type, config).Select(d => d.Id).Concat(LayoutProperties(v.Type, config));
                }).ToHashSet(StringComparer.Ordinal);
            if (group.Any(r => shown.Contains(r.PropertyId) && schema.Live(r.PropertyId) is { Type: PropertyTypes.Files })) return true;
        }
        return false;
    }
}
