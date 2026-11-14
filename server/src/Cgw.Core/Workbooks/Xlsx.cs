using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Cgw.Core.Databases;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;

namespace Cgw.Core.Workbooks;

/// <summary>A block of cells in A1 notation, without a sheet or <c>$</c> (sheet-embed.1's <c>range</c>).</summary>
public readonly partial record struct CellRange(int Col1, int Row1, int Col2, int Row2)
{
    public const int MaxColumn = 16_384;
    public const int MaxRow = 1_048_576;

    public long Cells => (long)(Col2 - Col1 + 1) * (Row2 - Row1 + 1);

    [GeneratedRegex("^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$")]
    private static partial Regex Pattern();

    /// <summary><c>A1</c> or <c>A1:D20</c>, columns <c>A</c> to <c>XFD</c>, rows 1 to 1,048,576; corners in either order.</summary>
    public static bool TryParse(string? text, out CellRange range)
    {
        range = default;
        var match = Pattern().Match(text ?? "");
        if (!match.Success) return false;
        var c1 = Column(match.Groups[1].Value);
        var r1 = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        var c2 = match.Groups[3].Success ? Column(match.Groups[3].Value) : c1;
        var r2 = match.Groups[4].Success ? int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture) : r1;
        if (c1 > MaxColumn || c2 > MaxColumn || r1 > MaxRow || r2 > MaxRow) return false;
        range = new CellRange(Math.Min(c1, c2), Math.Min(r1, r2), Math.Max(c1, c2), Math.Max(r1, r2));
        return true;
    }

    /// <summary>1 for <c>A</c>, 27 for <c>AA</c>.</summary>
    public static int Column(string letters)
    {
        var n = 0;
        foreach (var c in letters) n = n * 26 + (c - 'A' + 1);
        return n;
    }

    public static string Letters(int column)
    {
        var sb = new StringBuilder();
        for (var n = column; n > 0; n = (n - 1) / 26) sb.Insert(0, (char)('A' + (n - 1) % 26));
        return sb.ToString();
    }

    public static string Cell(int column, int row) => Letters(column) + row.ToString(CultureInfo.InvariantCulture);

    public override string ToString() =>
        Col1 == Col2 && Row1 == Row2 ? Cell(Col1, Row1) : $"{Cell(Col1, Row1)}:{Cell(Col2, Row2)}";
}

/// <summary>The workbook's bytes could not be read as an xlsx.</summary>
public sealed class XlsxUnreadableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>A read or a write past the limits (413 <c>limit.size</c>).</summary>
public sealed class XlsxLimitException(string message) : Exception(message);

/// <summary>One sheet of a workbook: its name, the cells that hold values (null when none), whether it is hidden.</summary>
public sealed record SheetSummary(string Name, string? UsedRange, bool Hidden);

/// <summary>A cell to write: text, a number, a boolean, or a date (an Excel serial, whole days or with a time).</summary>
public readonly record struct XValue(XKind Kind, string? Text = null, double Number = 0)
{
    public static readonly XValue Empty = new(XKind.Empty);
    public static XValue Of(string text) => new(XKind.Text, text);
    public static XValue Of(double number) => new(XKind.Number, Number: number);
    public static XValue Of(bool value) => new(XKind.Boolean, Number: value ? 1 : 0);
    public static XValue Day(double serial) => new(XKind.Date, Number: serial);
    public static XValue Instant(double serial) => new(XKind.DateTime, Number: serial);
}

public enum XKind
{
    Empty,
    Text,
    Number,
    Boolean,
    Date,
    DateTime,
}

/// <summary>
/// Reads and writes xlsx with <c>DocumentFormat.OpenXml</c> (MIT; DECISIONS.md, 2026-11-14:
/// Phase 5). Import reads a range's stored values and their types: a number in a date format is a
/// date, written <c>YYYY-MM-DD</c> (or <c>YYYY-MM-DDTHH:mm:ssZ</c> with a time); other numbers as
/// JavaScript's <c>String(n)</c>; booleans <c>true</c> and <c>false</c>; formulas by their cached
/// values. Export writes a header row and typed cells, as the first version of a new workbook.
/// </summary>
public static class Xlsx
{
    public const string ContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    /// <summary>What one range read may give: the rows a CSV import takes (and its header), its size, its cells.</summary>
    public const int MaxRows = Csv.MaxRows + 1;
    public const int MaxCsvChars = Csv.MaxBytes;
    public const long MaxRangeCells = 5_000_000;
    /// <summary>Characters in one part (a sheet's XML): a zip that inflates past it is refused.</summary>
    public const long MaxPartCharacters = 1L << 30;
    /// <summary>Excel's longest cell text.</summary>
    public const int MaxCellText = 32_767;

    private static readonly long Day1900Jan1 = DbDates.DaysFromCivil(1900, 1, 1);
    private static readonly long Day1900Mar1 = DbDates.DaysFromCivil(1900, 3, 1);
    private static readonly long Day1904Jan1 = DbDates.DaysFromCivil(1904, 1, 1);
    /// <summary>Serial 25569 is 1970-01-01 in the 1900 system.</summary>
    private const long Serial1970 = 25569;

    // Reading ---------------------------------------------------------------------------------------

    private sealed class Book : IDisposable
    {
        public required MemoryStream Stream { get; init; }
        public required SpreadsheetDocument Document { get; init; }
        public required WorkbookPart Part { get; init; }
        public required List<string> Strings { get; init; }
        /// <summary>By cell style index: 1 a date format, 2 a time-only format, 0 anything else.</summary>
        public required byte[] StyleKinds { get; init; }
        public required bool Date1904 { get; init; }

        public void Dispose()
        {
            Document.Dispose();
            Stream.Dispose();
        }
    }

    private static Book Open(byte[] bytes)
    {
        var stream = new MemoryStream(bytes, writable: false);
        try
        {
            var document = SpreadsheetDocument.Open(stream, false, new OpenSettings { MaxCharactersInPart = MaxPartCharacters });
            var part = document.WorkbookPart ?? throw new XlsxUnreadableException("The file has no workbook");
            var strings = new List<string>();
            if (part.SharedStringTablePart?.SharedStringTable is { } table)
                foreach (var item in table.Elements<SharedStringItem>()) strings.Add(ItemText(item));
            return new Book
            {
                Stream = stream,
                Document = document,
                Part = part,
                Strings = strings,
                StyleKinds = StyleKinds(part.WorkbookStylesPart?.Stylesheet),
                Date1904 = part.Workbook?.WorkbookProperties?.Date1904?.Value == true,
            };
        }
        catch (Exception e) when (e is not XlsxUnreadableException and not OperationCanceledException)
        {
            stream.Dispose();
            throw new XlsxUnreadableException("The file is not an xlsx workbook", e);
        }
    }

    /// <summary>A shared or inline string's text: its own text or its runs', not phonetic guides.</summary>
    private static string ItemText(OpenXmlCompositeElement item)
    {
        var sb = new StringBuilder();
        foreach (var child in item.ChildElements)
        {
            if (child is Text t) sb.Append(t.Text);
            else if (child is Run r && r.Text is { } rt) sb.Append(rt.Text);
        }
        return sb.ToString();
    }

    private static byte[] StyleKinds(Stylesheet? styles)
    {
        var formats = styles?.CellFormats?.Elements<CellFormat>().ToList() ?? [];
        var custom = styles?.NumberingFormats?.Elements<NumberingFormat>()
            .Where(f => f.NumberFormatId?.Value is not null)
            .GroupBy(f => f.NumberFormatId!.Value)
            .ToDictionary(g => g.Key, g => g.First().FormatCode?.Value ?? "") ?? [];
        var kinds = new byte[formats.Count];
        for (var i = 0; i < formats.Count; i++)
        {
            var id = formats[i].NumberFormatId?.Value ?? 0;
            kinds[i] = custom.TryGetValue(id, out var code) ? FormatKind(code) : BuiltInKind(id);
        }
        return kinds;
    }

    /// <summary>Excel's built-in number formats that are dates (1) or times of day only (2).</summary>
    private static byte BuiltInKind(uint id) => id switch
    {
        >= 14 and <= 17 or 22 or >= 27 and <= 36 or >= 50 and <= 58 => 1,
        >= 18 and <= 21 or >= 45 and <= 47 => 2,
        _ => 0,
    };

    /// <summary>A custom format's kind: quoted text, escapes and brackets taken out, then its first section's date and time tokens.</summary>
    public static byte FormatKind(string code)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < code.Length; i++)
        {
            var c = code[i];
            if (c == ';') break;
            if (c == '"')
            {
                i = code.IndexOf('"', i + 1) is var end and >= 0 ? end : code.Length;
                continue;
            }
            if (c is '\\' or '_' or '*')
            {
                i++;
                continue;
            }
            if (c == '[')
            {
                i = code.IndexOf(']', i + 1) is var end and >= 0 ? end : code.Length;
                continue;
            }
            sb.Append(char.ToLowerInvariant(c));
        }
        var text = sb.ToString();
        if (text.Contains("general", StringComparison.Ordinal)) text = text.Replace("general", "", StringComparison.Ordinal);
        if (text.IndexOfAny(['y', 'd']) >= 0) return 1;
        if (text.IndexOfAny(['h', 's']) >= 0) return 2;
        if (text.Contains('m')) return 1;
        return 0;
    }

    private static IEnumerable<(Sheet Sheet, WorksheetPart? Part)> SheetsOf(Book book)
    {
        foreach (var sheet in book.Part.Workbook?.Sheets?.Elements<Sheet>() ?? [])
        {
            WorksheetPart? part = null;
            if (sheet.Id?.Value is { } id)
            {
                try
                {
                    part = book.Part.GetPartById(id) as WorksheetPart;
                }
                catch (ArgumentOutOfRangeException)
                {
                    part = null;
                }
            }
            yield return (sheet, part);
        }
    }

    private static bool IsHidden(Sheet sheet) =>
        sheet.State?.Value is { } state && (state == SheetStateValues.Hidden || state == SheetStateValues.VeryHidden);

    /// <summary>Every sheet, in the workbook's order, with the bounds of the cells that hold values (chart sheets have none).</summary>
    public static List<SheetSummary> Sheets(byte[] bytes)
    {
        using var book = Open(bytes);
        try
        {
            var result = new List<SheetSummary>();
            foreach (var (sheet, part) in SheetsOf(book))
            {
                string? used = null;
                if (part is not null)
                {
                    var bounds = default(CellRange?);
                    foreach (var cell in Cells(book, part, null)) bounds = Grow(bounds, cell.Column, cell.Row);
                    used = bounds?.ToString();
                }
                result.Add(new SheetSummary(sheet.Name?.Value ?? "", used, IsHidden(sheet)));
            }
            return result;
        }
        catch (Exception e) when (e is not XlsxUnreadableException and not XlsxLimitException and not OperationCanceledException)
        {
            throw new XlsxUnreadableException("The workbook could not be read", e);
        }
    }

    private static CellRange Grow(CellRange? bounds, int column, int row) => bounds is { } b
        ? new CellRange(Math.Min(b.Col1, column), Math.Min(b.Row1, row), Math.Max(b.Col2, column), Math.Max(b.Row2, row))
        : new CellRange(column, row, column, row);

    /// <summary>
    /// A range of a sheet as CSV (comma, CRLF; text that a spreadsheet could run as a formula
    /// guarded with <c>'</c>, as the database's CSV does, so the client's import takes it back
    /// exactly). A null sheet is the first visible one; a null range the sheet's used range. The
    /// range is null and the CSV empty when the sheet holds no values.
    /// </summary>
    /// <exception cref="KeyNotFoundException">No such sheet.</exception>
    public static (string Sheet, string? Range, string Csv) Range(byte[] bytes, string? sheetName, CellRange? range)
    {
        using var book = Open(bytes);
        try
        {
            var sheets = SheetsOf(book).Where(s => s.Part is not null).ToList();
            var chosen = sheetName is null
                ? sheets.FirstOrDefault(s => !IsHidden(s.Sheet))
                : sheets.FirstOrDefault(s => s.Sheet.Name?.Value == sheetName) is { Part: not null } exact
                    ? exact
                    : sheets.FirstOrDefault(s => string.Equals(s.Sheet.Name?.Value, sheetName, StringComparison.OrdinalIgnoreCase));
            if (chosen.Part is null) throw new KeyNotFoundException(sheetName is null ? "The workbook has no visible sheet" : "No such sheet");
            var name = chosen.Sheet.Name?.Value ?? "";
            if (range is { } given && (given.Row2 - given.Row1 + 1 > MaxRows || given.Cells > MaxRangeCells))
                throw new XlsxLimitException($"A range read here is at most {MaxRows} rows and {MaxRangeCells} cells");

            var values = new Dictionary<(int Row, int Column), string>();
            CellRange? bounds = null;
            foreach (var cell in Cells(book, chosen.Part, range))
            {
                bounds = Grow(bounds, cell.Column, cell.Row);
                values[(cell.Row, cell.Column)] = cell.Text ? Csv.Guard(cell.Value) : cell.Value;
                if (values.Count > MaxRangeCells) throw new XlsxLimitException($"A range read here is at most {MaxRangeCells} cells");
            }
            var area = range ?? bounds;
            if (area is not { } a) return (name, null, "");
            if (a.Row2 - a.Row1 + 1 > MaxRows || a.Cells > MaxRangeCells)
                throw new XlsxLimitException($"A range read here is at most {MaxRows} rows and {MaxRangeCells} cells");
            var csv = new StringBuilder();
            for (var row = a.Row1; row <= a.Row2; row++)
            {
                for (var column = a.Col1; column <= a.Col2; column++)
                {
                    if (column > a.Col1) csv.Append(',');
                    if (values.TryGetValue((row, column), out var text)) csv.Append(Field(text));
                }
                csv.Append("\r\n");
                if (csv.Length > MaxCsvChars) throw new XlsxLimitException("A range read here is at most 20 MB of CSV");
            }
            return (name, a.ToString(), csv.ToString());
        }
        catch (Exception e) when (e is not XlsxUnreadableException and not XlsxLimitException and not KeyNotFoundException and not OperationCanceledException)
        {
            throw new XlsxUnreadableException("The workbook could not be read", e);
        }
    }

    /// <summary>Quoted when it holds a separator the import could take (comma, semicolon, tab), a quote or a line break.</summary>
    private static string Field(string text) =>
        text.IndexOfAny([',', ';', '\t', '"', '\r', '\n']) >= 0 ? "\"" + text.Replace("\"", "\"\"") + "\"" : text;

    private readonly record struct ReadCell(int Row, int Column, string Value, bool Text);

    /// <summary>The cells of a sheet that hold a value, in order, as canonical text; within <paramref name="range"/> when given.</summary>
    private static IEnumerable<ReadCell> Cells(Book book, WorksheetPart part, CellRange? range)
    {
        using var reader = OpenXmlReader.Create(part);
        var row = 0;
        var column = 0;
        while (reader.Read())
        {
            if (!reader.IsStartElement) continue;
            if (reader.ElementType == typeof(Row))
            {
                var r = reader.Attributes.FirstOrDefault(a => a.LocalName == "r").Value;
                row = int.TryParse(r, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : row + 1;
                column = 0;
                // Rows come in order: past the range's last row there is nothing more to read.
                if (range is { } past && row > past.Row2) yield break;
                continue;
            }
            if (reader.ElementType != typeof(Cell)) continue;
            if (reader.LoadCurrentElement() is not Cell cell) continue;
            var (refColumn, refRow) = Reference(cell.CellReference?.Value);
            column = refColumn > 0 ? refColumn : column + 1;
            var at = refRow > 0 ? refRow : row;
            if (range is { } r2 && (at < r2.Row1 || at > r2.Row2 || column < r2.Col1 || column > r2.Col2)) continue;
            if (Value(book, cell) is { } value) yield return new ReadCell(at, column, value.Text, value.IsText);
        }
    }

    private static (int Column, int Row) Reference(string? reference)
    {
        if (string.IsNullOrEmpty(reference)) return (0, 0);
        var i = 0;
        while (i < reference.Length && char.IsAsciiLetterUpper(reference[i])) i++;
        if (i == 0 || i > 3) return (0, 0);
        var column = CellRange.Column(reference[..i]);
        return int.TryParse(reference.AsSpan(i), NumberStyles.None, CultureInfo.InvariantCulture, out var row) ? (column, row) : (column, 0);
    }

    /// <summary>A cell's stored value as canonical text, and whether it is text; null when it holds none.</summary>
    private static (string Text, bool IsText)? Value(Book book, Cell cell)
    {
        var type = cell.DataType?.Value;
        var raw = cell.CellValue?.Text;
        if (type == CellValues.InlineString)
            return cell.InlineString is { } inline && ItemText(inline) is { Length: > 0 } s ? (s, true) : null;
        if (raw is null || raw.Length == 0) return null;
        if (type == CellValues.SharedString)
            return int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var index) && index < book.Strings.Count && book.Strings[index].Length > 0
                ? (book.Strings[index], true)
                : null;
        if (type == CellValues.String || type == CellValues.Error) return (raw, true);
        if (type == CellValues.Boolean) return (raw.Trim() is "1" or "true" ? "true" : "false", false);
        if (type == CellValues.Date) return DbDates.ParsePoint(raw) is { } point ? (Point(point), false) : (raw, true);
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) return (raw, true);
        var style = (int)(cell.StyleIndex?.Value ?? 0);
        var kind = style < book.StyleKinds.Length ? book.StyleKinds[style] : (byte)0;
        if (kind == 1 && SerialText(number, book.Date1904) is { } date) return (date, false);
        return (JsNumber.ToString(number), false);
    }

    /// <summary>A date at midnight is its day; anything else stays the instant.</summary>
    private static string Point(string point) => point.EndsWith("T00:00:00Z", StringComparison.Ordinal) ? point[..10] : point;

    /// <summary>An Excel serial date as <c>YYYY-MM-DD</c>, or <c>YYYY-MM-DDTHH:mm:ssZ</c> with a time (to the nearest second, as UTC).</summary>
    public static string? SerialText(double serial, bool date1904 = false)
    {
        if (!double.IsFinite(serial) || serial < (date1904 ? 0 : 1) || serial >= 2_958_466) return null;
        var whole = Math.Floor(serial);
        var seconds = (long)Math.Round((serial - whole) * 86_400, MidpointRounding.AwayFromZero);
        var serialDay = (long)whole;
        if (seconds >= 86_400)
        {
            serialDay++;
            seconds -= 86_400;
        }
        long day;
        if (date1904) day = Day1904Jan1 + serialDay;
        // Serial 60 is the 29 February 1900 Excel keeps from Lotus 1-2-3; there is no such day.
        else if (serialDay == 60) return null;
        else day = serialDay < 60 ? Day1900Jan1 + serialDay - 1 : serialDay - Serial1970;
        var text = DbDates.DayText(day);
        if (seconds == 0) return text;
        return $"{text}T{seconds / 3600:00}:{seconds % 3600 / 60:00}:{seconds % 60:00}Z";
    }

    /// <summary>The Excel serial of a canonical point (1900 system); null before 1 January 1900.</summary>
    public static double? Serial(string point)
    {
        if (!DbDates.IsPoint(point)) return null;
        var ms = DbDates.PointMs(point);
        var day = (long)Math.Floor(ms / DbDates.DayMs);
        if (day < Day1900Jan1) return null;
        var serialDay = day >= Day1900Mar1 ? day + Serial1970 : day - Day1900Jan1 + 1;
        return serialDay + (ms - day * (double)DbDates.DayMs) / DbDates.DayMs;
    }

    // Writing ---------------------------------------------------------------------------------------

    private const uint DateStyle = 1;
    private const uint DateTimeStyle = 2;
    private const uint HeaderStyle = 3;

    private static Stylesheet Styles() => new(
        new NumberingFormats(
            new NumberingFormat { NumberFormatId = 164U, FormatCode = "yyyy-mm-dd" },
            new NumberingFormat { NumberFormatId = 165U, FormatCode = "yyyy-mm-dd hh:mm:ss" }) { Count = 2U },
        new Fonts(
            new Font(new FontSize { Val = 11D }, new FontName { Val = "Calibri" }),
            new Font(new Bold(), new FontSize { Val = 11D }, new FontName { Val = "Calibri" })) { Count = 2U },
        new Fills(new Fill(new PatternFill { PatternType = PatternValues.None }), new Fill(new PatternFill { PatternType = PatternValues.Gray125 })) { Count = 2U },
        new Borders(new Border(new LeftBorder(), new RightBorder(), new TopBorder(), new BottomBorder(), new DiagonalBorder())) { Count = 1U },
        new CellStyleFormats(new CellFormat { NumberFormatId = 0U, FontId = 0U, FillId = 0U, BorderId = 0U }) { Count = 1U },
        new CellFormats(
            new CellFormat { NumberFormatId = 0U, FontId = 0U, FillId = 0U, BorderId = 0U, FormatId = 0U },
            new CellFormat { NumberFormatId = 164U, FontId = 0U, FillId = 0U, BorderId = 0U, FormatId = 0U, ApplyNumberFormat = true },
            new CellFormat { NumberFormatId = 165U, FontId = 0U, FillId = 0U, BorderId = 0U, FormatId = 0U, ApplyNumberFormat = true },
            new CellFormat { NumberFormatId = 0U, FontId = 1U, FillId = 0U, BorderId = 0U, FormatId = 0U, ApplyFont = true }) { Count = 4U },
        new CellStyles(new CellStyle { Name = "Normal", FormatId = 0U, BuiltinId = 0U }) { Count = 1U });

    /// <summary>A sheet name Excel takes: 1 to 31 characters, none of <c>[ ] : * ? / \</c>, not starting or ending with <c>'</c>.</summary>
    public static string SheetName(string? name, string fallback = "Sheet1")
    {
        var clean = new string((name ?? "").Where(c => c is not ('[' or ']' or ':' or '*' or '?' or '/' or '\\') && !char.IsControl(c)).ToArray()).Trim().Trim('\'');
        if (clean.Length > 31) clean = clean[..31].TrimEnd('\'');
        if (char.IsHighSurrogate(clean.LastOrDefault())) clean = clean[..^1];
        return clean.Length == 0 || clean.Equals("History", StringComparison.OrdinalIgnoreCase) ? fallback : clean;
    }

    /// <summary>Text XML can hold, at most Excel's cell length: characters XML 1.0 refuses and unpaired surrogates left out.</summary>
    public static string XmlText(string text)
    {
        StringBuilder? sb = null;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            bool keep;
            var pair = false;
            if (char.IsHighSurrogate(c)) keep = pair = i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]);
            else if (char.IsLowSurrogate(c)) keep = false;
            else keep = c is '\t' or '\n' or '\r' || (c >= ' ' && c != (char)0xFFFE && c != (char)0xFFFF);
            if (!keep)
            {
                sb ??= new StringBuilder(text, 0, i, text.Length);
                continue;
            }
            sb?.Append(c);
            if (pair)
            {
                sb?.Append(text[i + 1]);
                i++;
            }
        }
        var result = sb?.ToString() ?? text;
        if (result.Length <= MaxCellText) return result;
        var cut = char.IsHighSurrogate(result[MaxCellText - 1]) ? MaxCellText - 1 : MaxCellText;
        return result[..cut];
    }

    /// <summary>One sheet: a header row (bold) and the rows, typed cells, shared strings.</summary>
    public static byte[] Write(string sheetName, IReadOnlyList<string> header, IEnumerable<IReadOnlyList<XValue>> rows)
    {
        using var stream = new MemoryStream();
        using (var document = SpreadsheetDocument.Create(stream, SpreadsheetDocumentType.Workbook))
        {
            var workbookPart = document.AddWorkbookPart();
            var stylesPart = workbookPart.AddNewPart<WorkbookStylesPart>();
            stylesPart.Stylesheet = Styles();
            stylesPart.Stylesheet.Save();

            var strings = new Dictionary<string, int>(StringComparer.Ordinal);
            var ordered = new List<string>();
            var uses = 0;
            int StringIndex(string text)
            {
                uses++;
                if (strings.TryGetValue(text, out var index)) return index;
                strings[text] = ordered.Count;
                ordered.Add(text);
                return ordered.Count - 1;
            }

            var sheetPart = workbookPart.AddNewPart<WorksheetPart>();
            using (var writer = OpenXmlWriter.Create(sheetPart))
            {
                writer.WriteStartElement(new Worksheet());
                writer.WriteStartElement(new SheetData());
                var rowNumber = 0;
                void WriteRow(IReadOnlyList<XValue> cells, bool isHeader)
                {
                    rowNumber++;
                    writer.WriteStartElement(new Row(), [new OpenXmlAttribute("r", "", rowNumber.ToString(CultureInfo.InvariantCulture))]);
                    for (var i = 0; i < cells.Count; i++)
                    {
                        var cell = cells[i];
                        if (cell.Kind == XKind.Empty) continue;
                        var attributes = new List<OpenXmlAttribute> { new("r", "", CellRange.Cell(i + 1, rowNumber)) };
                        string value;
                        switch (cell.Kind)
                        {
                            case XKind.Text:
                                attributes.Add(new OpenXmlAttribute("t", "", "s"));
                                value = StringIndex(XmlText(cell.Text ?? "")).ToString(CultureInfo.InvariantCulture);
                                break;
                            case XKind.Boolean:
                                attributes.Add(new OpenXmlAttribute("t", "", "b"));
                                value = cell.Number != 0 ? "1" : "0";
                                break;
                            case XKind.Date:
                                attributes.Add(new OpenXmlAttribute("s", "", DateStyle.ToString(CultureInfo.InvariantCulture)));
                                value = cell.Number.ToString("R", CultureInfo.InvariantCulture);
                                break;
                            case XKind.DateTime:
                                attributes.Add(new OpenXmlAttribute("s", "", DateTimeStyle.ToString(CultureInfo.InvariantCulture)));
                                value = cell.Number.ToString("R", CultureInfo.InvariantCulture);
                                break;
                            default:
                                value = cell.Number.ToString("R", CultureInfo.InvariantCulture);
                                break;
                        }
                        if (isHeader) attributes.Add(new OpenXmlAttribute("s", "", HeaderStyle.ToString(CultureInfo.InvariantCulture)));
                        writer.WriteStartElement(new Cell(), attributes);
                        writer.WriteElement(new CellValue(value));
                        writer.WriteEndElement();
                    }
                    writer.WriteEndElement();
                }
                WriteRow(header.Select(XValue.Of).ToList(), isHeader: true);
                foreach (var row in rows)
                {
                    if (rowNumber >= CellRange.MaxRow) throw new XlsxLimitException("A sheet holds at most 1,048,576 rows");
                    WriteRow(row, isHeader: false);
                }
                writer.WriteEndElement();
                writer.WriteEndElement();
            }

            var stringsPart = workbookPart.AddNewPart<SharedStringTablePart>();
            using (var writer = OpenXmlWriter.Create(stringsPart))
            {
                writer.WriteStartElement(new SharedStringTable(),
                [
                    new OpenXmlAttribute("count", "", uses.ToString(CultureInfo.InvariantCulture)),
                    new OpenXmlAttribute("uniqueCount", "", ordered.Count.ToString(CultureInfo.InvariantCulture)),
                ]);
                foreach (var text in ordered)
                {
                    writer.WriteStartElement(new SharedStringItem());
                    writer.WriteElement(new Text(text) { Space = SpaceProcessingModeValues.Preserve });
                    writer.WriteEndElement();
                }
                writer.WriteEndElement();
            }

            workbookPart.Workbook = new DocumentFormat.OpenXml.Spreadsheet.Workbook(
                new Sheets(new Sheet { Id = workbookPart.GetIdOfPart(sheetPart), SheetId = 1U, Name = SheetName(sheetName) }));
            workbookPart.Workbook.Save();
        }
        return stream.ToArray();
    }

    /// <summary>Whether the bytes start as a zip does (an xlsx is one): the local file header's signature.</summary>
    public static bool LooksLikeZip(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 4 && bytes[0] == 0x50 && bytes[1] == 0x4B && bytes[2] == 0x03 && bytes[3] == 0x04;
}
