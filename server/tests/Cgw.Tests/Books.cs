using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Cgw.Core.Workbooks;

namespace Cgw.Tests;

/// <summary>Steps the Phase 5 tests share: workbooks, launch tickets, Sheet's file sessions, xlsx bytes.</summary>
public static class Books
{
    /// <summary>Sheet's preview server: on the development list of <c>Sheet__Origins</c>.</summary>
    public const string SheetOrigin = "http://127.0.0.1:4173";
    public const string XlsxType = Xlsx.ContentType;

    public static async Task<JsonElement> Create(Ws ws, string name, HttpClient? client = null)
    {
        var response = await (client ?? ws.Client).PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/workbooks", new { name });
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    /// <summary>What Sheet calls with: no cookie, its own origin.</summary>
    public static HttpClient Sheet(ServerFixture server, string origin = SheetOrigin)
    {
        var client = server.Anonymous();
        client.DefaultRequestHeaders.Add("Origin", origin);
        return client;
    }

    public static async Task<HttpResponseMessage> Launch(HttpClient client, Guid workbook) =>
        await client.PostAsJsonAsync($"/api/v1/workbooks/{workbook}/launch", new { });

    /// <summary>The ticket in a launch link's fragment.</summary>
    public static async Task<string> Ticket(HttpClient client, Guid workbook)
    {
        var response = await Launch(client, workbook);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var url = (await Kit.Json(response)).GetProperty("url").GetString()!;
        return url[(url.IndexOf("#launch=", StringComparison.Ordinal) + "#launch=".Length)..];
    }

    public static async Task<HttpResponseMessage> Redeem(HttpClient sheet, string? ticket) =>
        await sheet.PostAsJsonAsync("/api/v1/sheet-sessions/redeem", new { ticket });

    /// <summary>A file session's answer, opened by <paramref name="client"/>'s person.</summary>
    public static async Task<JsonElement> Open(ServerFixture server, HttpClient client, Guid workbook)
    {
        var response = await Redeem(Sheet(server), await Ticket(client, workbook));
        Assert.True(response.StatusCode == HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        return await Kit.Json(response);
    }

    public static async Task<string> Token(ServerFixture server, HttpClient client, Guid workbook) =>
        (await Open(server, client, workbook)).GetProperty("token").GetString()!;

    public static HttpRequestMessage Request(HttpMethod method, string path, string? token)
    {
        var request = new HttpRequestMessage(method, path);
        if (token is not null) request.Headers.Add("X-Workspace-File-Session", token);
        request.Headers.Add("Origin", SheetOrigin);
        return request;
    }

    public static HttpRequestMessage Save(string token, byte[] bytes, string? ifMatch = null, string? ifNoneMatch = null, string type = XlsxType, string path = "/api/v1/sheet-sessions/workbook/versions")
    {
        var request = Request(HttpMethod.Post, path, token);
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(type);
        if (ifMatch is not null) request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        if (ifNoneMatch is not null) request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        return request;
    }

    /// <summary>The first save, as Sheet makes it; the new version's ETag.</summary>
    public static async Task<string> SaveFirst(ServerFixture server, string token, byte[] bytes)
    {
        var response = await server.Anonymous().SendAsync(Save(token, bytes, ifNoneMatch: "*"));
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return (await Kit.Json(response)).GetProperty("etag").GetString()!;
    }

    /// <summary>A workbook with a first version, saved through Sheet's route by the workspace's owner.</summary>
    public static async Task<Guid> WithVersion(ServerFixture server, Ws ws, string name, byte[]? bytes = null)
    {
        var id = (await Create(ws, name)).GetProperty("id").GetGuid();
        await SaveFirst(server, await Token(server, ws.Client, id), bytes ?? Simple());
        return id;
    }

    /// <summary>A small workbook made by the server's own writer.</summary>
    public static byte[] Simple(string text = "hello") =>
        Xlsx.Write("Sheet1", ["Name"], [[XValue.Of(text)]]);

    /// <summary>A PNG header of the given size, then filler: enough for the route's checks.</summary>
    public static byte[] Png(int width = 320, int height = 200, int size = 64)
    {
        var bytes = new byte[Math.Max(size, 33)];
        byte[] head = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R'];
        head.CopyTo(bytes, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(16), (uint)width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(20), (uint)height);
        bytes[24] = 8;
        bytes[25] = 6;
        return bytes;
    }

    public static async Task<byte[]> Download(string url)
    {
        using var client = new HttpClient();
        return await client.GetByteArrayAsync(url);
    }

    /// <summary>
    /// A workbook written part by part as Excel writes one: a hidden first sheet, shared strings
    /// with rich-text runs and a phonetic guide, built-in and custom number formats (a date, a
    /// date and time, a percentage, a quoted text that holds a "d"), booleans, a formula's cached
    /// number and string, an inline string, an error, a styled cell with no value, and a sheet with
    /// nothing in it.
    /// </summary>
    public static byte[] Excel()
    {
        const string main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        const string rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        const string head = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
        var parts = new Dictionary<string, string>
        {
            ["[Content_Types].xml"] = head + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
                + "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
                + "<Override PartName=\"/xl/worksheets/sheet2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
                + "<Override PartName=\"/xl/worksheets/sheet3.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
                + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
                + "<Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/>"
                + "</Types>",
            ["_rels/.rels"] = head + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + $"<Relationship Id=\"rId1\" Type=\"{rel}/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>",
            ["xl/workbook.xml"] = head + $"<workbook xmlns=\"{main}\" xmlns:r=\"{rel}\"><workbookPr/><sheets>"
                + "<sheet name=\"Hidden\" sheetId=\"1\" state=\"hidden\" r:id=\"rId1\"/>"
                + "<sheet name=\"Budget\" sheetId=\"2\" r:id=\"rId2\"/>"
                + "<sheet name=\"Empty\" sheetId=\"3\" r:id=\"rId3\"/></sheets></workbook>",
            ["xl/_rels/workbook.xml.rels"] = head + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + $"<Relationship Id=\"rId1\" Type=\"{rel}/worksheet\" Target=\"worksheets/sheet1.xml\"/>"
                + $"<Relationship Id=\"rId2\" Type=\"{rel}/worksheet\" Target=\"worksheets/sheet2.xml\"/>"
                + $"<Relationship Id=\"rId3\" Type=\"{rel}/worksheet\" Target=\"worksheets/sheet3.xml\"/>"
                + $"<Relationship Id=\"rId4\" Type=\"{rel}/styles\" Target=\"styles.xml\"/>"
                + $"<Relationship Id=\"rId5\" Type=\"{rel}/sharedStrings\" Target=\"sharedStrings.xml\"/></Relationships>",
            ["xl/styles.xml"] = head + $"<styleSheet xmlns=\"{main}\">"
                + "<numFmts count=\"2\"><numFmt numFmtId=\"164\" formatCode=\"yyyy\\-mm\\-dd\\ hh:mm\"/><numFmt numFmtId=\"165\" formatCode=\"&quot;Due &quot;0.0\"/></numFmts>"
                + "<fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>"
                + "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>"
                + "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"
                + "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
                + "<cellXfs count=\"5\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"
                + "<xf numFmtId=\"14\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>"
                + "<xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>"
                + "<xf numFmtId=\"10\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>"
                + "<xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/></cellXfs>"
                + "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>",
            ["xl/sharedStrings.xml"] = head + $"<sst xmlns=\"{main}\" count=\"10\" uniqueCount=\"10\">"
                + "<si><t>Item</t></si><si><t>Amount</t></si><si><t>When</t></si><si><t>Paid</t></si><si><t>Note</t></si>"
                + "<si><t>Rent</t></si><si><t>=not a formula</t></si>"
                + "<si><r><t xml:space=\"preserve\">Travel, </t></r><r><rPr><b/></rPr><t>café</t></r><rPh sb=\"0\" eb=\"1\"><t>ignored</t></rPh></si>"
                + "<si><t>far</t></si><si><t>what the hidden sheet holds</t></si></sst>",
            ["xl/worksheets/sheet1.xml"] = head + $"<worksheet xmlns=\"{main}\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>9</v></c></row></sheetData></worksheet>",
            ["xl/worksheets/sheet2.xml"] = head + $"<worksheet xmlns=\"{main}\"><dimension ref=\"A1:F7\"/><sheetData>"
                + "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c><c r=\"C1\" t=\"s\"><v>2</v></c><c r=\"D1\" t=\"s\"><v>3</v></c><c r=\"E1\" t=\"s\"><v>4</v></c></row>"
                + "<row r=\"2\"><c r=\"A2\" t=\"s\"><v>5</v></c><c r=\"B2\"><v>1200</v></c><c r=\"C2\" s=\"1\"><v>46082</v></c><c r=\"D2\" t=\"b\"><v>1</v></c><c r=\"E2\" t=\"s\"><v>6</v></c></row>"
                + "<row r=\"3\"><c r=\"A3\" t=\"s\"><v>7</v></c><c r=\"B3\" s=\"4\"><v>300.5</v></c><c r=\"C3\" s=\"2\"><v>46082.5</v></c><c r=\"D3\" t=\"b\"><v>0</v></c><c r=\"E3\" t=\"inlineStr\"><is><t>a;b</t></is></c></row>"
                + "<row r=\"4\"><c r=\"A4\" t=\"str\"><f>\"To\"&amp;\"tal\"</f><v>Total</v></c><c r=\"B4\"><f>SUM(B2:B3)</f><v>1500.5</v></c><c r=\"C4\" s=\"1\"/><c r=\"E4\" t=\"e\"><f>1/0</f><v>#DIV/0!</v></c></row>"
                + "<row r=\"7\"><c r=\"B7\"><v>1E+21</v></c><c r=\"C7\" s=\"3\"><v>0.25</v></c><c r=\"F7\" t=\"s\"><v>8</v></c></row>"
                + "</sheetData></worksheet>",
            ["xl/worksheets/sheet3.xml"] = head + $"<worksheet xmlns=\"{main}\"><sheetData/></worksheet>",
        };
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, text) in parts)
            {
                var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                using var writer = entry.Open();
                writer.Write(Encoding.UTF8.GetBytes(text));
            }
        return stream.ToArray();
    }

    /// <summary>The Budget sheet of <see cref="Excel"/> as the range route writes it.</summary>
    public const string BudgetCsv =
        "Item,Amount,When,Paid,Note,\r\n"
        + "Rent,1200,2026-03-01,true,'=not a formula,\r\n"
        + "\"Travel, café\",300.5,2026-03-01T12:00:00Z,false,\"a;b\",\r\n"
        + "Total,1500.5,,,#DIV/0!,\r\n"
        + ",,,,,\r\n"
        + ",,,,,\r\n"
        + ",1e+21,0.25,,,far\r\n";
}
