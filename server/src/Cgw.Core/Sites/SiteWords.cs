using System.Globalization;
using Cgw.Core.Databases;

namespace Cgw.Core.Sites;

/// <summary>
/// The site's own words (navigation, placeholders, counts, dates), in the language the publisher
/// chose (DECISIONS.md, 2026-11-17): English or Arabic. Dates are written with Western digits and
/// month names from these tables, never the server's culture, so a page reads the same on every host.
/// </summary>
public sealed class SiteWords
{
    public required string Language { get; init; }
    public required string Direction { get; init; }
    public required string Pages { get; init; }
    public required string Skip { get; init; }
    public required string Untitled { get; init; }
    public required string Someone { get; init; }
    public required string APage { get; init; }
    public required string Contents { get; init; }
    public required string WorkbookHidden { get; init; }
    public required string ErpHidden { get; init; }
    public required string DatabaseHidden { get; init; }
    public required string BlockHidden { get; init; }
    public required string ChartHidden { get; init; }
    public required string BoardHidden { get; init; }
    /// <summary>Phase 10: a third-party plugin's block, named by its type (<c>{0}</c>): it runs only in the app.</summary>
    public required string PluginHidden { get; init; }
    public required string NoRows { get; init; }
    public required string NoValue { get; init; }
    public required string Checked { get; init; }
    public required string NotChecked { get; init; }
    public required string Previous { get; init; }
    public required string Next { get; init; }
    public required string File { get; init; }
    public required string Footer { get; init; }
    public required string Count { get; init; }
    public required string Sum { get; init; }
    public required string Average { get; init; }
    public required string Group { get; init; }
    public required string Value { get; init; }
    public required string Chart { get; init; }
    public required string Board { get; init; }
    public required string TableCut { get; init; }
    public required string[] Months { get; init; }
    /// <summary><c>{0}</c> rows shown <c>of</c> <c>{1}</c>.</summary>
    public required string RowsOf { get; init; }
    /// <summary>Page <c>{0}</c> of <c>{1}</c>.</summary>
    public required string PageOf { get; init; }

    public static readonly SiteWords English = new()
    {
        Language = "en",
        Direction = "ltr",
        Pages = "Pages",
        Skip = "Skip to content",
        Untitled = "Untitled",
        Someone = "someone",
        APage = "a page",
        Contents = "Contents",
        WorkbookHidden = "This workbook is not published",
        ErpHidden = "Cash Gear ERP data is not published",
        DatabaseHidden = "This database is not published",
        BlockHidden = "This block cannot be shown here",
        ChartHidden = "This chart is not published",
        BoardHidden = "This board is not published",
        PluginHidden = "The plugin {0} is shown in Cash Gear Workspace only",
        NoRows = "No rows",
        NoValue = "No value",
        Checked = "Checked",
        NotChecked = "Not checked",
        Previous = "Previous",
        Next = "Next",
        File = "File",
        Footer = "Published with Cash Gear Workspace",
        Count = "Count",
        Sum = "Sum",
        Average = "Average",
        Group = "Group",
        Value = "Value",
        Chart = "Chart",
        Board = "Board",
        TableCut = "Only the first part of this table is shown",
        Months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
        RowsOf = "{0} of {1} rows",
        PageOf = "Page {0} of {1}",
    };

    public static readonly SiteWords Arabic = new()
    {
        Language = "ar",
        Direction = "rtl",
        Pages = "الصفحات",
        Skip = "انتقل إلى المحتوى",
        Untitled = "بدون عنوان",
        Someone = "شخص",
        APage = "صفحة",
        Contents = "المحتويات",
        WorkbookHidden = "هذا المصنف غير منشور",
        ErpHidden = "بيانات Cash Gear ERP غير منشورة",
        DatabaseHidden = "قاعدة البيانات هذه غير منشورة",
        BlockHidden = "لا يمكن عرض هذه الكتلة هنا",
        ChartHidden = "هذا المخطط غير منشور",
        BoardHidden = "هذه اللوحة غير منشورة",
        PluginHidden = "تظهر الإضافة {0} في Cash Gear Workspace فقط",
        NoRows = "لا توجد صفوف",
        NoValue = "بلا قيمة",
        Checked = "محدد",
        NotChecked = "غير محدد",
        Previous = "السابق",
        Next = "التالي",
        File = "ملف",
        Footer = "نُشر باستخدام Cash Gear Workspace",
        Count = "العدد",
        Sum = "المجموع",
        Average = "المتوسط",
        Group = "المجموعة",
        Value = "القيمة",
        Chart = "مخطط",
        Board = "لوحة",
        TableCut = "يُعرض الجزء الأول فقط من هذا الجدول",
        Months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
        RowsOf = "{0} من {1}",
        PageOf = "الصفحة {0} من {1}",
    };

    public static SiteWords For(string? language) => language == "ar" ? Arabic : English;

    public string Rows(int shown, long total) => string.Format(CultureInfo.InvariantCulture, RowsOf, shown, total);

    public string PageNumber(int page, int pages) => string.Format(CultureInfo.InvariantCulture, PageOf, page, pages);

    /// <summary>A stored point (<c>YYYY-MM-DD</c> or a UTC instant) as words: <c>1 December 2026</c>, with <c>, 09:30 UTC</c> for an instant.</summary>
    public string Date(string point)
    {
        if (!DbDates.IsPoint(point)) return point;
        var year = point[..4].TrimStart('0');
        var month = int.Parse(point[5..7], CultureInfo.InvariantCulture);
        var day = int.Parse(point[8..10], CultureInfo.InvariantCulture);
        var text = $"{day.ToString(CultureInfo.InvariantCulture)} {Months[month - 1]} {(year.Length == 0 ? "0" : year)}";
        return DbDates.IsDateOnly(point) ? text : $"{text}, {point[11..16]} UTC";
    }

    /// <summary>A date value as words: its start, then <c> → </c> and its end.</summary>
    public string DateSpan(string start, string? end) => end is { Length: > 0 } && DbDates.IsPoint(end) ? $"{Date(start)} → {Date(end)}" : Date(start);

    /// <summary>A group key of a date as words: a month <c>2026-03</c>, a year, a week or a day.</summary>
    public string DateKey(string key)
    {
        if (key.Length == 7 && key[4] == '-' && int.TryParse(key[5..7], NumberStyles.None, CultureInfo.InvariantCulture, out var m) && m is >= 1 and <= 12)
            return $"{Months[m - 1]} {key[..4]}";
        return DbDates.IsPoint(key) ? Date(key) : key;
    }
}
