using System.Globalization;
using Cgw.Core.Databases;

namespace Cgw.Core.Forms;

/// <summary>
/// A form link's page as an HTML form posts it (Phase 16): each question's field is
/// <c>q.&lt;propertyId&gt;</c> (a multi-select's repeated, a checkbox's present when ticked), the page
/// posted is <c>at</c>, the way <c>go</c> (<c>next</c>, <c>back</c>), and <see cref="Trap"/> a field a
/// person never fills. The Sites process and the API read the same fields the same way.
/// </summary>
public static class FormPosts
{
    public const string Prefix = "q.";
    public const string At = "at";
    public const string Go = "go";
    /// <summary>The hidden field a person never fills: an answer that fills it is dropped.</summary>
    public const string Trap = "website";

    public static string Field(string propertyId) => Prefix + propertyId;

    /// <summary>A field's one value: its first that is not empty, or null.</summary>
    public static string? One(IReadOnlyDictionary<string, string[]> fields, string name) =>
        fields.TryGetValue(name, out var values) ? values.FirstOrDefault(v => v.Length > 0) : null;

    /// <summary>The page posted (a whole number of a page the form has), else 0.</summary>
    public static int PageOf(IReadOnlyDictionary<string, string[]> fields, FormConfig form) =>
        int.TryParse(One(fields, At), NumberStyles.None, CultureInfo.InvariantCulture, out var at) && at >= 0 && at < form.Pages.Count ? at : 0;

    /// <summary>
    /// The raw answers the fields hold, for the form's questions only: text as posted; a
    /// multi-select's choices as a list; a ticked checkbox as its field's text (<c>on</c>); a date and
    /// time (<c>YYYY-MM-DDTHH:mm</c>, a browser's <c>datetime-local</c>) read in the workspace's time
    /// zone as the UTC instant a date property holds. The rules then check each as the app's are.
    /// </summary>
    public static Dictionary<string, object?> Read(FormConfig form, Schema db, IReadOnlyDictionary<string, string[]> fields, TimeZoneInfo zone)
    {
        var raw = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var question in form.Pages.SelectMany(p => p.Questions))
        {
            if (db.Live(question.PropertyId) is not { } def || !fields.TryGetValue(Field(def.Id), out var values)) continue;
            var given = values.Where(v => v.Length > 0).ToArray();
            if (given.Length == 0) continue;
            raw[def.Id] = def.Type switch
            {
                PropertyTypes.MultiSelect => given,
                PropertyTypes.Date when def.IncludeTime => Instant(given[0], zone),
                _ => given[0],
            };
        }
        return raw;
    }

    private static readonly string[] LocalFormats = ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss"];

    /// <summary>A local date and time in the zone as a UTC instant; anything else as it was posted.</summary>
    public static string Instant(string text, TimeZoneInfo zone)
    {
        if (!DateTime.TryParseExact(text, LocalFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var local)) return text;
        local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
        // A time the clock skips (a change to summer time) is the first minute after the gap.
        while (zone.IsInvalidTime(local)) local = local.AddMinutes(1);
        var utc = TimeZoneInfo.ConvertTimeToUtc(local, zone);
        return utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
    }
}
