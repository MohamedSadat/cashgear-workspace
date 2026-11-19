using System.Text.Json.Nodes;
using Cgw.Core.Databases;

namespace Cgw.Core.Sharing;

/// <summary>Why a chart view draws nothing by link: it has no group, or it reads a property whose values may not leave.</summary>
public enum ChartProblem
{
    None,
    NoGroup,
    Hidden,
}

/// <summary>
/// A chart view as a share link and a site read it (Phase 12, M12.1; db/types.ts <c>ChartConfig</c>):
/// its kind, measure and title from <c>config.chart</c>, its rows grouped by the view's own group
/// (its <c>dateBy</c>, <c>hidden</c> and <c>hideEmpty</c>, applied by the query). A chart view shows
/// exactly the title, its group's property and its measure's property, whatever its
/// <c>properties</c> says (<see cref="Shown"/>): a property added to the database after the view was
/// made is in no view's <c>hidden</c>, and must not leave through a chart that does not draw it. It is
/// drawn only when its group's and its measure's values may leave (never a person's, a formula of
/// one, a rollup out of the scope); otherwise it is refused, so a sum or a group never tells what a
/// link may not show. As the app's chart: a group on a property that is gone, or that rows cannot be
/// grouped by, is no group; a sum or an average of a property that is gone, or is not a number,
/// formula or rollup, counts.
/// </summary>
public sealed record ChartView(string Kind, string Measure, PropertyDef? Measured, GroupRule Group, PropertyDef GroupDef, string? Title)
{
    public const string Type = "chart";

    /// <summary>Property types a sum or an average reads (the chart block's <c>MEASURABLE</c>).</summary>
    public static readonly HashSet<string> Measurable = [PropertyTypes.Number, PropertyTypes.Formula, PropertyTypes.Rollup];

    private static string? Str(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>The view's group's property: live and one rows can be grouped by, else none.</summary>
    private static PropertyDef? GroupOf(Schema schema, JsonObject? config) =>
        Str((config?["group"] as JsonObject)?["propertyId"]) is { } id && schema.Live(id) is { } def && Query.IsGroupable(def.Type) ? def : null;

    /// <summary>The measure's kind and property: a sum or an average of a live number, formula or rollup, else a count.</summary>
    private static (string Kind, PropertyDef? Measured) MeasureOf(Schema schema, JsonObject? config)
    {
        var measure = (config?["chart"] as JsonObject)?["measure"] as JsonObject;
        if (Str(measure?["kind"]) is not (("sum" or "average") and var kind)) return ("count", null);
        return Str(measure?["propertyId"]) is { } id && schema.Live(id) is { } def && Measurable.Contains(def.Type) ? (kind, def) : ("count", null);
    }

    /// <summary>A chart view's shown properties: the title, its group's property and its measure's, in that order.</summary>
    public static List<PropertyDef> Shown(Schema schema, JsonObject? config)
    {
        var shown = new List<PropertyDef>();
        if (schema.Properties.FirstOrDefault(p => p is { Trashed: false, Type: PropertyTypes.Title }) is { } title) shown.Add(title);
        foreach (var def in new[] { GroupOf(schema, config), MeasureOf(schema, config).Measured })
            if (def is not null && !shown.Contains(def)) shown.Add(def);
        return shown;
    }

    /// <summary>The chart <paramref name="view"/> draws, or why it draws none.</summary>
    public static (ChartView? Chart, ChartProblem Problem) Read(ScopedView view)
    {
        var shown = view.Shown.Select(d => d.Id).ToHashSet(StringComparer.Ordinal);
        bool Leaves(PropertyDef def) => shown.Contains(def.Id) && view.Visible.Contains(def.Id);
        var groupDef = GroupOf(view.Schema, view.Config);
        var (measureKind, measured) = MeasureOf(view.Schema, view.Config);
        if ((groupDef is not null && !Leaves(groupDef)) || (measured is not null && !Leaves(measured))) return (null, ChartProblem.Hidden);
        // Grouped only when the query grouped the rows by it.
        if (groupDef is null || view.Group is not { } rule || rule.PropertyId != groupDef.Id || view.Groups is null) return (null, ChartProblem.NoGroup);

        var chart = view.Config?["chart"] as JsonObject;
        var kind = Str(chart?["kind"]) is ("line" or "pie") and var named ? named : "bar";
        var title = Str(chart?["title"]) is { Length: > 0 } t ? (t.Length > 200 ? t[..200] : t) : null;
        return (new ChartView(kind, measureKind, measured, rule, groupDef, title), ChartProblem.None);
    }

    /// <summary>Whether a chart view reads a property whose values may not leave: a share link refuses its rows.</summary>
    public static bool Hides(ScopedView view) => view.Type == Type && Read(view).Problem == ChartProblem.Hidden;
}
