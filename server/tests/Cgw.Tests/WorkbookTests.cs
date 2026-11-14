using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Core.Workbooks;
using Cgw.Worker.Jobs;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// M5.2's Workspace routes for workbooks (INTEGRATIONS.md, Workbooks as their own documents;
/// contracts section 6): the record, its list, trash, access list, content, pictures, the range
/// import's two reads and the view export, and the worker's retention.
/// </summary>
public sealed class WorkbookTests(ServerFixture server)
{
    private static string Url(Guid workbook, string rest = "") => $"/api/v1/workbooks/{workbook}{rest}";

    private static async Task<HttpResponseMessage> Patch(HttpClient client, Guid workbook, object body, string? ifMatch = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Patch, Url(workbook)) { Content = JsonContent.Create(body) };
        if (ifMatch is not null) request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        return await client.SendAsync(request);
    }

    [Fact]
    public async Task A_workbook_is_made_with_no_version_listed_renamed_trashed_and_restored()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");

        var made = await Books.Create(ws, "  Budget 2027 ");
        var id = made.GetProperty("id").GetGuid();
        Assert.Equal("Budget 2027", made.GetProperty("name").GetString());
        Assert.Equal(ws.Id, made.GetProperty("workspaceId").GetGuid());
        Assert.Equal(1, made.GetProperty("version").GetInt64());
        foreach (var empty in new[] { "versionId", "etag", "size", "savedAt", "savedBy", "trashedAt" })
            Assert.Equal(JsonValueKind.Null, made.GetProperty(empty).ValueKind);
        Assert.Equal(ws.Account.Id, made.GetProperty("createdBy").GetGuid());
        Assert.Equal("full", made.GetProperty("access").GetString());

        // The client's id makes a retry safe; someone else's id is taken.
        var clientId = Guid.CreateVersion7();
        var first = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/workbooks", new { id = clientId, name = "Plan" });
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal($"/api/v1/workbooks/{clientId}", first.Headers.Location?.ToString());
        Assert.Equal(HttpStatusCode.Created, (await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/workbooks", new { id = clientId, name = "Plan" })).StatusCode);
        var taken = await member.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/workbooks", new { id = clientId, name = "Mine" });
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
        Assert.Equal("conflict", await Kit.Code(taken));
        // A name is needed; guests make none.
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/workbooks", new { name = " \t " })).StatusCode);
        var byGuest = await guest.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/workbooks", new { name = "Guest's" });
        Assert.Equal(HttpStatusCode.Forbidden, byGuest.StatusCode);
        Assert.Equal("access.denied", await Kit.Code(byGuest));

        // GET sends the record's version as the ETag; the member edits by the role's default.
        var got = await member.Client.GetAsync(Url(id));
        Assert.Equal("\"1\"", got.Headers.ETag?.Tag);
        Assert.Equal("edit", (await Kit.Json(got)).GetProperty("access").GetString());

        // The list: the caller's readable ones, by name with ?q=, the trash with ?trashed=true.
        var list = await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/workbooks");
        Assert.Equal(2, list.GetProperty("workbooks").GetArrayLength());
        var found = await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/workbooks?q=BUDGET");
        Assert.Equal(id, Assert.Single(found.GetProperty("workbooks").EnumerateArray()).GetProperty("id").GetGuid());
        Assert.Empty((await guest.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/workbooks")).GetProperty("workbooks").EnumerateArray());

        // A rename with a stale If-Match is a conflict; with the current one it applies.
        var stale = await Patch(member.Client, id, new { name = "Budget 2028" }, "\"7\"");
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal("version.conflict", await Kit.Code(stale));
        Assert.Equal(HttpStatusCode.BadRequest, (await Patch(member.Client, id, new { name = "x" }, "\"one\"")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Patch(member.Client, id, new { })).StatusCode);
        var renamed = await Patch(member.Client, id, new { name = "Budget 2028" }, "\"1\"");
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal("\"2\"", renamed.Headers.ETag?.Tag);
        Assert.Equal("Budget 2028", (await Kit.Json(renamed)).GetProperty("name").GetString());

        // Trash by PATCH (edit) and by DELETE (full); restore by PATCH.
        var trashed = await Kit.Json(await Patch(member.Client, id, new { trashed = true }));
        Assert.Equal(3, trashed.GetProperty("version").GetInt64());
        Assert.NotEqual(JsonValueKind.Null, trashed.GetProperty("trashedAt").ValueKind);
        Assert.Empty((await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/workbooks?q=budget")).GetProperty("workbooks").EnumerateArray());
        Assert.Single((await member.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/workbooks?trashed=true")).GetProperty("workbooks").EnumerateArray());
        var inTrash = await Patch(member.Client, id, new { name = "Renamed in the trash" });
        Assert.Equal(HttpStatusCode.Conflict, inTrash.StatusCode);
        var gone = await member.Client.GetAsync(Url(id, "/content"));
        Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
        Assert.Equal("workbook.gone", await Kit.Code(gone));
        var restored = await Kit.Json(await Patch(member.Client, id, new { trashed = false, name = "Back" }));
        Assert.Equal(JsonValueKind.Null, restored.GetProperty("trashedAt").ValueKind);
        Assert.Equal("Back", restored.GetProperty("name").GetString());
        var byMember = await member.Client.DeleteAsync(Url(id));
        Assert.Equal(HttpStatusCode.Forbidden, byMember.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync(Url(id))).StatusCode);
        Assert.NotEqual(JsonValueKind.Null, (await ws.Client.GetFromJsonAsync<JsonElement>(Url(id))).GetProperty("trashedAt").ValueKind);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync(Url(id))).StatusCode);

        await using var db = server.NewDb(ws.Id);
        var actions = (await db.AuditLog.Where(a => a.TargetId == id).Select(a => a.Action).ToListAsync()).Order(StringComparer.Ordinal);
        Assert.Equal(new[] { "workbook.create", "workbook.rename", "workbook.trash", "workbook.rename", "workbook.restore", "workbook.trash" }.Order(StringComparer.Ordinal), actions);
        // Not in the change feed: the app reads workbooks by route, online.
        Assert.False(await db.WorkspaceChanges.AnyAsync(c => c.EntityId == id));
    }

    [Fact]
    public async Task The_access_list_is_read_by_all_entries_by_full_and_changed_by_full_with_if_match()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var stranger = await server.NewAccount();
        var id = (await Books.Create(ws, "Shared book")).GetProperty("id").GetGuid();

        var mine = await ws.Client.GetAsync(Url(id, "/permissions"));
        Assert.Equal("\"1\"", mine.Headers.ETag?.Tag);
        var empty = await Kit.Json(mine);
        Assert.False(empty.GetProperty("restricted").GetBoolean());
        Assert.Equal("full", empty.GetProperty("yourLevel").GetString());

        foreach (var body in new[]
                 {
                     Kit.Entries(false, ("user", stranger.Id, "view")),
                     Kit.Entries(false, ("user", member.Id, "owner")),
                     Kit.Entries(false, ("workspace", Guid.CreateVersion7(), "view")),
                     Kit.Entries(false, ("group", member.Id, "view")),
                     Kit.Entries(false, ("user", member.Id, "view"), ("user", member.Id, "edit")),
                 })
        {
            var refused = await ws.Client.PutAsJsonAsync(Url(id, "/permissions"), body);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }
        var notFull = await member.Client.PutAsJsonAsync(Url(id, "/permissions"), Kit.Entries(true));
        Assert.Equal(HttpStatusCode.Forbidden, notFull.StatusCode);

        var stale = new HttpRequestMessage(HttpMethod.Put, Url(id, "/permissions")) { Content = JsonContent.Create(Kit.Entries(true, ("user", member.Id, "view"))) };
        stale.Headers.TryAddWithoutValidation("If-Match", "\"9\"");
        Assert.Equal("version.conflict", await Kit.Code(await ws.Client.SendAsync(stale)));
        var put = new HttpRequestMessage(HttpMethod.Put, Url(id, "/permissions")) { Content = JsonContent.Create(Kit.Entries(true, ("user", member.Id, "view"), ("user", guest.Id, "comment"))) };
        put.Headers.TryAddWithoutValidation("If-Match", "\"1\"");
        var set = await ws.Client.SendAsync(put);
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        Assert.Equal("\"2\"", set.Headers.ETag?.Tag);
        var after = await Kit.Json(set);
        Assert.True(after.GetProperty("restricted").GetBoolean());
        Assert.Equal(2, after.GetProperty("entries").GetArrayLength());
        Assert.Equal(member.Email, after.GetProperty("entries").EnumerateArray().Single(e => e.GetProperty("principalId").GetGuid() == member.Id).GetProperty("email").GetString());

        // Who is on it is for full only; each reads their own level.
        var asMember = await member.Client.GetFromJsonAsync<JsonElement>(Url(id, "/permissions"));
        Assert.Equal("view", asMember.GetProperty("yourLevel").GetString());
        Assert.Empty(asMember.GetProperty("entries").EnumerateArray());
        Assert.Equal("comment", (await guest.Client.GetFromJsonAsync<JsonElement>(Url(id))).GetProperty("access").GetString());

        // A member removed from the workspace loses their rows with them.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/members/{guest.Id}")).StatusCode);
        await using var db = server.NewDb(ws.Id);
        Assert.False(await db.WorkbookPermissions.AnyAsync(r => r.PrincipalId == guest.Id));
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "workbook.permissions" && a.TargetId == id));
    }

    [Fact]
    public async Task Content_is_a_signed_url_for_the_current_version_and_pictures_are_checked()
    {
        var ws = await Ws.Create(server);
        var reader = await Kit.Join(server, ws, "member");
        var bytes = Books.Simple("picture me");
        var id = await Books.WithVersion(server, ws, "Pictured", bytes);
        await Kit.Json(await ws.Client.PutAsJsonAsync(Url(id, "/permissions"), Kit.Entries(false, ("user", reader.Id, "view"))));

        var content = await reader.Client.GetFromJsonAsync<JsonElement>(Url(id, "/content"));
        var versionId = content.GetProperty("versionId").GetGuid();
        Assert.Equal($"\"{versionId}\"", content.GetProperty("etag").GetString());
        Assert.Equal(bytes.Length, content.GetProperty("size").GetInt64());
        var url = content.GetProperty("readUrl").GetString()!;
        Assert.Contains($"/workbooks/{id}/versions/{versionId}.xlsx", url, StringComparison.Ordinal);
        Assert.Contains("sig=", url, StringComparison.Ordinal);
        Assert.Equal(bytes, await Books.Download(url));
        var empty = (await Books.Create(ws, "Empty")).GetProperty("id").GetGuid();
        var none = await ws.Client.GetFromJsonAsync<JsonElement>(Url(empty, "/content"));
        Assert.Equal(JsonValueKind.Null, none.GetProperty("readUrl").ValueKind);
        Assert.Equal(JsonValueKind.Null, none.GetProperty("etag").ValueKind);

        var hash = new string('b', 64);
        var missing = await reader.Client.GetAsync(Url(id, $"/previews/{hash}"));
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("not.found", await Kit.Code(missing));
        HttpRequestMessage Picture(byte[] png, string? version, string type = "image/png", string viewHash = "")
        {
            var request = new HttpRequestMessage(HttpMethod.Put, Url(id, $"/previews/{(viewHash.Length > 0 ? viewHash : hash)}")) { Content = new ByteArrayContent(png) };
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(type);
            if (version is not null) request.Headers.TryAddWithoutValidation("X-Workbook-Version", version);
            return request;
        }
        // Only editors send pictures; a PNG of the current version, within the limits.
        var byReader = await reader.Client.SendAsync(Picture(Books.Png(), versionId.ToString()));
        Assert.Equal(HttpStatusCode.Forbidden, byReader.StatusCode);
        var noVersion = await ws.Client.SendAsync(Picture(Books.Png(), null));
        Assert.Equal(HttpStatusCode.PreconditionRequired, noVersion.StatusCode);
        Assert.Equal("version.required", await Kit.Code(noVersion));
        var old = await ws.Client.SendAsync(Picture(Books.Png(), Guid.CreateVersion7().ToString()));
        Assert.Equal(HttpStatusCode.Conflict, old.StatusCode);
        Assert.Equal("version.conflict", await Kit.Code(old));
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.SendAsync(Picture(Books.Png(), versionId.ToString(), "image/jpeg"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.SendAsync(Picture(new byte[64], versionId.ToString()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.SendAsync(Picture(Books.Png(4097, 10), versionId.ToString()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.SendAsync(Picture(Books.Png(), versionId.ToString(), viewHash: "NOT-A-HASH"))).StatusCode);
        var big = await ws.Client.SendAsync(Picture(Books.Png(size: Png.MaxBytes + 1), versionId.ToString()));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
        Assert.Equal("limit.size", await Kit.Code(big));
        Assert.Equal(Png.MaxBytes, (await Kit.Json(big)).GetProperty("limit").GetInt32());

        var png = Books.Png(640, 400, 4096);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.SendAsync(Picture(png, $"\"{versionId}\""))).StatusCode);
        var preview = await reader.Client.GetFromJsonAsync<JsonElement>(Url(id, $"/previews/{hash}"));
        Assert.Equal(versionId, preview.GetProperty("versionId").GetGuid());
        Assert.Equal($"\"{versionId}\"", preview.GetProperty("etag").GetString());
        Assert.Equal(640, preview.GetProperty("width").GetInt32());
        Assert.Equal(400, preview.GetProperty("height").GetInt32());
        Assert.Equal(png, await Books.Download(preview.GetProperty("url").GetString()!));
    }

    [Fact]
    public async Task The_range_import_reads_sheets_and_a_range_of_an_excel_workbook_as_canonical_csv()
    {
        var ws = await Ws.Create(server);
        var id = await Books.WithVersion(server, ws, "From Excel", Books.Excel());

        var sheets = await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/sheets"));
        Assert.Equal(
            [("Hidden", "A1", true), ("Budget", "A1:F7", false), ("Empty", (string?)null, false)],
            sheets.GetProperty("sheets").EnumerateArray().Select(s => (s.GetProperty("name").GetString()!, s.GetProperty("usedRange").GetString(), s.GetProperty("hidden").GetBoolean())));

        // No sheet: the first visible one; no range: its used range.
        var all = await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/range"));
        Assert.Equal("Budget", all.GetProperty("sheet").GetString());
        Assert.Equal("A1:F7", all.GetProperty("range").GetString());
        Assert.Equal(Books.BudgetCsv, all.GetProperty("csv").GetString());
        var part = await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/range?sheet=budget&range=C3:B2"));
        Assert.Equal("B2:C3", part.GetProperty("range").GetString());
        Assert.Equal("1200,2026-03-01\r\n300.5,2026-03-01T12:00:00Z\r\n", part.GetProperty("csv").GetString());
        Assert.Equal("what the hidden sheet holds\r\n", (await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/range?sheet=Hidden"))).GetProperty("csv").GetString());
        var nothing = await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/range?sheet=Empty"));
        Assert.Equal(JsonValueKind.Null, nothing.GetProperty("range").ValueKind);
        Assert.Equal("", nothing.GetProperty("csv").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.GetAsync(Url(id, "/range?sheet=Nope"))).StatusCode);
        foreach (var bad in new[] { "A0", "Sheet1!A1", "$A$1", "XFE1", "A1:B" })
            Assert.Equal(HttpStatusCode.BadRequest, (await ws.Client.GetAsync(Url(id, $"/range?range={Uri.EscapeDataString(bad)}"))).StatusCode);
        var tooBig = await ws.Client.GetAsync(Url(id, "/range?range=A1:Z60000"));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooBig.StatusCode);
        Assert.Equal("limit.size", await Kit.Code(tooBig));

        // The client's CSV import takes it as it stands: the guarded text comes back exactly.
        var database = await DatabaseTests.NewDatabase(ws, "Imported budget",
        [
            DatabaseTests.Prop("pNum0001", "number", "Amount"), DatabaseTests.Prop("pDat0001", "date", "When"),
            DatabaseTests.Prop("pChk0001", "checkbox", "Paid"), DatabaseTests.Prop("pTxt0001", "text", "Note"),
        ]);
        var csv = (await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/range?range=A1:E4"))).GetProperty("csv").GetString();
        var imported = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv, columns = new[] { "title", "pNum0001", "pDat0001", "pChk0001", "pTxt0001" }, header = true });
        Assert.True(imported.IsSuccessStatusCode, await imported.Content.ReadAsStringAsync());
        Assert.Equal(0, (await Kit.Json(imported)).GetProperty("problems").GetArrayLength());
        var rows = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows")).GetProperty("rows").EnumerateArray()
            .ToDictionary(r => r.GetProperty("title").GetString()!, r => r.GetProperty("values"));
        Assert.Equal(1200, rows["Rent"].GetProperty("pNum0001").GetDouble());
        Assert.Equal("2026-03-01", rows["Rent"].GetProperty("pDat0001").GetProperty("start").GetString());
        Assert.True(rows["Rent"].GetProperty("pChk0001").GetBoolean());
        Assert.Equal("=not a formula", rows["Rent"].GetProperty("pTxt0001").GetString());
        Assert.Equal("2026-03-01T12:00:00Z", rows["Travel, café"].GetProperty("pDat0001").GetProperty("start").GetString());
        Assert.Equal("a;b", rows["Travel, café"].GetProperty("pTxt0001").GetString());
        Assert.Equal(1500.5, rows["Total"].GetProperty("pNum0001").GetDouble());

        // No version: no sheets, and no range to read.
        var empty = (await Books.Create(ws, "Blank")).GetProperty("id").GetGuid();
        Assert.Empty((await ws.Client.GetFromJsonAsync<JsonElement>(Url(empty, "/sheets"))).GetProperty("sheets").EnumerateArray());
        Assert.Equal(HttpStatusCode.Conflict, (await ws.Client.GetAsync(Url(empty, "/range"))).StatusCode);
    }

    [Fact]
    public void Excel_dates_and_number_formats_read_as_the_vectors_say()
    {
        Assert.Equal("1900-01-01", Xlsx.SerialText(1));
        Assert.Equal("1900-02-28", Xlsx.SerialText(59));
        Assert.Null(Xlsx.SerialText(60));
        Assert.Equal("1900-03-01", Xlsx.SerialText(61));
        Assert.Equal("1970-01-01", Xlsx.SerialText(25569));
        Assert.Equal("2026-03-01T06:00:00Z", Xlsx.SerialText(46082.25));
        Assert.Equal("2026-03-02", Xlsx.SerialText(46082.9999999));
        Assert.Equal("1904-01-02", Xlsx.SerialText(1, date1904: true));
        foreach (var point in new[] { "1900-01-01", "1900-02-28", "1900-03-01", "2026-03-01", "2026-03-01T12:00:00Z", "9999-12-31" })
            Assert.Equal(point, Xlsx.SerialText(Xlsx.Serial(point)!.Value));
        Assert.Null(Xlsx.Serial("1899-12-31"));
        Assert.Equal(1, Xlsx.FormatKind("dd/mm/yyyy"));
        Assert.Equal(1, Xlsx.FormatKind("[$-409]mmmm d, yyyy;@"));
        Assert.Equal(2, Xlsx.FormatKind("[h]:mm:ss"));
        Assert.Equal(0, Xlsx.FormatKind("\"Due \"0.00"));
        Assert.Equal(0, Xlsx.FormatKind("[Red]#,##0.00_);(#,##0.00)"));
        Assert.Equal(0, Xlsx.FormatKind("0.00E+00"));
        Assert.True(CellRange.TryParse("XFD1048576", out var corner));
        Assert.Equal("XFD1048576", corner.ToString());
        Assert.False(CellRange.TryParse("A1048577", out _));
        Assert.Equal("abé", Xlsx.XmlText("a" + (char)1 + "b" + (char)0xD800 + "é"));
    }

    [Fact]
    public async Task A_view_exports_as_a_new_workbook_with_typed_cells_in_the_views_order()
    {
        var ws = await Ws.Create(server);
        var guest = await Kit.Join(server, ws, "guest");
        var database = await DatabaseTests.NewDatabase(ws, "Tasks",
        [
            DatabaseTests.Prop("pNum0001", "number", "Hours"), DatabaseTests.Prop("pDat0001", "date", "Due"),
            DatabaseTests.Prop("pChk0001", "checkbox", "Done"),
            DatabaseTests.Prop("pSel0001", "select", "Stage", new JsonObject { ["options"] = DatabaseTests.Options(("optA0001", "Open"), ("optB0001", "Closed")) }),
            DatabaseTests.Prop("pTxt0001", "text", "Notes"),
        ]);
        var csv = "Name,Hours,Due,Done,Stage,Notes\r\nAlpha,3,2026-03-01,true,Open,a\r\nBeta,1.5,2026-03-02T10:30:00Z,false,Closed,b\r\n=Gamma,7,,true,Open,c\r\nDelta,2,2026-01-01T09:15:00Z,false,Open,d\r\n";
        var imported = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv, columns = new[] { "title", "pNum0001", "pDat0001", "pChk0001", "pSel0001", "pTxt0001" }, header = true });
        Assert.True(imported.IsSuccessStatusCode, await imported.Content.ReadAsStringAsync());
        var view = Guid.CreateVersion7();
        await ws.Push(ws.Op("view.upsert", view, new
        {
            id = view, workspaceId = ws.Id, databaseId = database, name = "Open by hours", type = "table", orderKey = "a0", version = 1, createdAt = DateTimeOffset.UtcNow,
            config = new
            {
                filter = new { kind = "group", op = "and", children = new object[] { new { kind = "condition", propertyId = "pSel0001", @operator = "is", value = "optA0001" } } },
                sorts = new object[] { new { propertyId = "pNum0001", direction = "desc" } },
                group = (object?)null,
                properties = new { order = Array.Empty<string>(), hidden = new[] { "pTxt0001" }, widths = new { } },
            },
        }));

        var byGuest = await guest.Client.PostAsJsonAsync($"/api/v1/databases/{database}/workbooks", new { viewId = view, name = "No" });
        Assert.Equal(HttpStatusCode.NotFound, byGuest.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/workbooks", new { viewId = Guid.CreateVersion7(), name = "No view" })).StatusCode);
        var response = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/workbooks", new { viewId = view, name = "Open tasks" });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var book = await Kit.Json(response);
        Assert.Equal("Open tasks", book.GetProperty("name").GetString());
        Assert.Equal("full", book.GetProperty("access").GetString());
        Assert.NotEqual(JsonValueKind.Null, book.GetProperty("etag").ValueKind);
        var id = book.GetProperty("id").GetGuid();

        var content = await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/content"));
        var bytes = await Books.Download(content.GetProperty("readUrl").GetString()!);
        using (var document = SpreadsheetDocument.Open(new MemoryStream(bytes), false))
        {
            var part = document.WorkbookPart!;
            Assert.Equal("Open by hours", part.Workbook!.Sheets!.Elements<Sheet>().Single().Name?.Value);
            var strings = part.SharedStringTablePart!.SharedStringTable!.Elements<SharedStringItem>().Select(i => i.InnerText).ToList();
            var rows = part.WorksheetParts.Single().Worksheet!.Descendants<Row>().ToList();
            string Text(Cell c) => c.DataType?.Value == CellValues.SharedString ? strings[int.Parse(c.CellValue!.Text)] : c.CellValue!.Text;
            Assert.Equal(["Name", "Hours", "Due", "Done", "Stage"], rows[0].Elements<Cell>().Select(Text));
            Assert.Equal(["=Gamma", "Alpha", "Delta"], rows.Skip(1).Select(r => Text(r.Elements<Cell>().First())));
            var alpha = rows[2].Elements<Cell>().ToDictionary(c => c.CellReference!.Value![..1]);
            Assert.Null(alpha["B"].DataType);
            Assert.Equal("3", alpha["B"].CellValue!.Text);
            Assert.Equal("46082", alpha["C"].CellValue!.Text);
            Assert.Equal(1U, alpha["C"].StyleIndex!.Value);
            Assert.Equal(CellValues.Boolean, alpha["D"].DataType!.Value);
            Assert.Equal("1", alpha["D"].CellValue!.Text);
            Assert.Equal("Open", Text(alpha["E"]));
            var gamma = rows[1].Elements<Cell>().ToDictionary(c => c.CellReference!.Value![..1]);
            Assert.False(gamma.ContainsKey("C"));
            Assert.Equal(2U, rows[3].Elements<Cell>().Single(c => c.CellReference!.Value == "C4").StyleIndex!.Value);
        }
        // And the range import reads back what the export wrote.
        var range = await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/range"));
        Assert.Equal("Name,Hours,Due,Done,Stage\r\n'=Gamma,7,,true,Open\r\nAlpha,3,2026-03-01,true,Open\r\nDelta,2,2026-01-01T09:15:00Z,false,Open\r\n", range.GetProperty("csv").GetString());

        // A restricted database's export is restricted as it is: a member who cannot read the
        // database cannot read the workbook either.
        var member = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true);
        var secret = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/workbooks", new { name = "Secret export" }));
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync(Url(secret.GetProperty("id").GetGuid()))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync(Url(id))).StatusCode);
        await using var db = server.NewDb(ws.Id);
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "workbook.export" && a.TargetId == id));
    }

    [Fact]
    public async Task Trashed_workbooks_are_deleted_for_good_after_60_days_with_their_blobs()
    {
        var ws = await Ws.Create(server);
        var id = await Books.WithVersion(server, ws, "Old");
        var kept = await Books.WithVersion(server, ws, "Trashed recently");
        var content = await ws.Client.GetFromJsonAsync<JsonElement>(Url(id, "/content"));
        var versionId = content.GetProperty("versionId").GetGuid();
        var picture = new HttpRequestMessage(HttpMethod.Put, Url(id, $"/previews/{new string('c', 64)}")) { Content = new ByteArrayContent(Books.Png()) };
        picture.Content.Headers.ContentType = MediaTypeHeaderValue.Parse("image/png");
        picture.Headers.Add("X-Workbook-Version", versionId.ToString());
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.SendAsync(picture)).StatusCode);
        var token = await Books.Token(server, ws.Client, id);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync(Url(id))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync(Url(kept))).StatusCode);
        // In the trash, a session is told the workbook is gone.
        var trashed = await server.Anonymous().SendAsync(Books.Request(HttpMethod.Get, "/api/v1/sheet-sessions/workbook", token));
        Assert.Equal(HttpStatusCode.Gone, trashed.StatusCode);
        Assert.Equal("workbook.gone", await Kit.Code(trashed));
        await using (var db = server.NewDb(ws.Id))
            await db.Workbooks.Where(w => w.Id == id).ExecuteUpdateAsync(s => s.SetProperty(w => w.TrashedAt, DateTimeOffset.UtcNow.AddDays(-61)));

        var job = Kit.Job<WorkbookRetentionJob>(server);
        var purged = await Kit.InWorker(server, ws.Id, (services, db) => job.PurgeAsync(services, db, ws.Id, id, CancellationToken.None));
        Assert.True(purged);
        Assert.False(await Kit.InWorker(server, ws.Id, (services, db) => job.PurgeAsync(services, db, ws.Id, kept, CancellationToken.None)));
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.False(await db.Workbooks.AnyAsync(w => w.Id == id));
            Assert.False(await db.WorkbookVersions.AnyAsync(v => v.WorkbookId == id));
            Assert.False(await db.WorkbookPreviews.AnyAsync(p => p.WorkbookId == id));
            Assert.False(await db.FileSessions.AnyAsync(s => s.WorkbookId == id));
            Assert.True(await db.Workbooks.AnyAsync(w => w.Id == kept));
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "workbook.purgedByRetention" && a.TargetId == id));
        }
        var blob = server.Worker.GetRequiredService<Cgw.Core.Blob.BlobStore>();
        var left = new List<string>();
        await foreach (var (name, _) in blob.ListAsync(Cgw.Core.Blob.BlobStore.WorkbookPrefix(ws.Id, id))) left.Add(name);
        Assert.Empty(left);
        // Deleted for good: its sessions went with it, and the record is 404.
        var ended = await server.Anonymous().SendAsync(Books.Request(HttpMethod.Get, "/api/v1/sheet-sessions/workbook", token));
        Assert.Equal(HttpStatusCode.Unauthorized, ended.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.GetAsync(Url(id))).StatusCode);
    }
}
