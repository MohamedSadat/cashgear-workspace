using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Databases;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 17, M17.5: a unique id. A row's number is given when the server first stores it, in the
/// insert's transaction: rows sent at once from one device (an offline outbox) in the order they
/// reached it, a replay given none again, a template none, an import's rows in the file's order,
/// never two the same and never reused; rows stored before 0.17.0 numbered in the order they were
/// made; read, sorted, filtered and exported with the property's prefix; an older build keeps the
/// property and its prefix.
/// </summary>
public sealed class UniqueIdTests(ServerFixture server)
{
    private static readonly JsonArray Props = new(
        DatabaseTests.Prop("pUid0001", "uniqueId", "ID", new JsonObject { ["uniqueId"] = new JsonObject { ["prefix"] = "TASK" } }),
        DatabaseTests.Prop("pNum0001", "number", "Points"));

    private static async Task<List<JsonElement>> Rows(Ws ws, Guid database) =>
        (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=1000")).GetProperty("rows").EnumerateArray().ToList();

    private static long? Number(JsonElement row) => row.TryGetProperty("number", out var n) && n.ValueKind == JsonValueKind.Number ? n.GetInt64() : null;

    [Fact]
    public async Task A_row_is_numbered_when_the_server_first_stores_it_once_and_never_again()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", Props.DeepClone().AsArray());
        var first = await DatabaseTests.NewRow(ws, database, "First");
        Assert.Equal(1, Number(first));
        // Three rows made offline reach the server in one batch: numbered in that order.
        var tree = await ws.Tree();
        var section = tree.GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == database).GetProperty("sectionId").GetGuid();
        var made = Enumerable.Range(0, 3).Select(i =>
        {
            var id = Guid.CreateVersion7();
            var payload = DatabaseTests.PageJson(id, ws.Id, section, database, $"a{i + 5}", $"Offline {i}", "row");
            payload["row"] = new JsonObject { ["values"] = new JsonObject() };
            return ws.Op("page.create", id, payload);
        }).ToArray();
        Assert.All((await ws.Push(made)).EnumerateArray(), r => Assert.Equal("applied", r.GetProperty("status").GetString()));
        long? NumberOf(List<JsonElement> list, string title) => Number(list.Single(r => r.GetProperty("title").GetString() == title));
        var pushed = await Rows(ws, database);
        Assert.Equal([2L, 3L, 4L], new[] { "Offline 0", "Offline 1", "Offline 2" }.Select(t => NumberOf(pushed, t)!.Value));
        // The same batch sent again (its answer was lost): nothing numbered twice.
        await ws.Push(made);
        var offline = (await Rows(ws, database)).Where(r => r.GetProperty("title").GetString()!.StartsWith("Offline", StringComparison.Ordinal)).ToList();
        Assert.Equal([2L, 3L, 4L], offline.Select(r => Number(r)!.Value).Order());
        // A template is no row: no number.
        var templateId = Guid.CreateVersion7();
        var template = DatabaseTests.PageJson(templateId, ws.Id, section, database, "a8", "Template", "row");
        template["isTemplate"] = true;
        template["row"] = new JsonObject { ["values"] = new JsonObject() };
        Assert.Null(Number((await ws.Push(ws.Op("page.create", templateId, template)))[0].GetProperty("entity").GetProperty("row")));
        // A row trashed keeps its number, and the next row never takes it.
        Assert.Equal("applied", (await ws.Push(ws.Op("page.trash", first.GetProperty("id").GetGuid(), new { })))[0].GetProperty("status").GetString());
        Assert.Equal(5, Number(await DatabaseTests.NewRow(ws, database, "Fifth")));
        // An import's rows, in the file's order.
        var import = await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/import", new { csv = "Name\nSixth\nSeventh\n", columns = new[] { "title" }, header = true });
        Assert.Equal(HttpStatusCode.OK, import.StatusCode);
        var rows = await Rows(ws, database);
        Assert.Equal(6, Number(rows.Single(r => r.GetProperty("title").GetString() == "Sixth")));
        Assert.Equal(7, Number(rows.Single(r => r.GetProperty("title").GetString() == "Seventh")));
        var numbers = rows.Select(Number).OfType<long>().ToList();
        Assert.Equal(numbers.Count, numbers.Distinct().Count());
        // Sorted and filtered as a number by the server's query.
        var context = new { today = "2026-03-01", offsetMinutes = 0, me = (string?)null };
        var sorted = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/query",
            new { sorts = new[] { new { propertyId = "pUid0001", direction = "desc" } }, group = (object?)null, context }));
        Assert.Equal(["Seventh", "Sixth", "Fifth", "Offline 2", "Offline 1", "Offline 0"], sorted.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()));
        var filtered = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/databases/{database}/query",
            new { filter = new { kind = "group", op = "and", children = new[] { new { kind = "condition", propertyId = "pUid0001", @operator = "le", value = 3 } } }, sorts = Array.Empty<object>(), group = (object?)null, context }));
        Assert.Equal(["Offline 0", "Offline 1"], filtered.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("title").GetString()).Order());
        // Exported with its prefix.
        var csv = Encoding.UTF8.GetString(await (await ws.Client.GetAsync($"/api/v1/databases/{database}/export")).Content.ReadAsByteArrayAsync());
        Assert.Contains(",TASK-6,", csv, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Rows_stored_before_the_release_are_numbered_in_the_order_they_were_made()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Old rows", Props.DeepClone().AsArray());
        var ids = new List<Guid>();
        for (var i = 0; i < 4; i++) ids.Add((await DatabaseTests.NewRow(ws, database, $"Row {i}", null, $"a{4 - i}")).GetProperty("id").GetGuid());
        // As 0.16.0 left them: no numbers, the database's next 1; made in this order, whatever their order keys.
        await using (var db = server.NewDb())
        {
            await db.DatabaseRows.IgnoreQueryFilters().Where(r => r.DatabaseId == database).ExecuteUpdateAsync(s => s.SetProperty(r => r.Number, (long?)null));
            await db.Databases.IgnoreQueryFilters().Where(d => d.PageId == database).ExecuteUpdateAsync(s => s.SetProperty(d => d.NextNumber, 1L));
            for (var i = 0; i < ids.Count; i++)
            {
                var at = new DateTimeOffset(2026, 1, 1, 9, 0, 0, TimeSpan.Zero).AddMinutes(i);
                var id = ids[i];
                await db.Pages.IgnoreQueryFilters().Where(p => p.Id == id).ExecuteUpdateAsync(s => s.SetProperty(p => p.CreatedAt, at));
            }
            await db.Database.ExecuteSqlRawAsync(UniqueIds.BackfillSql);
        }
        var rows = (await Rows(ws, database)).ToDictionary(r => r.GetProperty("id").GetGuid());
        Assert.Equal([1L, 2L, 3L, 4L], ids.Select(id => Number(rows[id])!.Value));
        Assert.Equal(5, Number(await DatabaseTests.NewRow(ws, database, "After")));
    }

    [Fact]
    public async Task An_older_build_keeps_a_unique_id_and_its_prefix()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Kept", Props.DeepClone().AsArray());
        // 0.16.0 counts 21 types: a def of the unique id's id as text keeps the type and its prefix, its name taken.
        var payload = new JsonObject { ["properties"] = new JsonArray(DatabaseTests.Prop("pUid0001", "text", "Number")), ["propertyTypes"] = 21 };
        var result = (await ws.Push(ws.Op("db.update", database, payload)))[0];
        Assert.Equal("applied", result.GetProperty("status").GetString());
        var def = result.GetProperty("entity").GetProperty("database").GetProperty("properties").EnumerateArray().Single(p => p.GetProperty("id").GetString() == "pUid0001");
        Assert.Equal(("uniqueId", "Number", "TASK"), (def.GetProperty("type").GetString(), def.GetProperty("name").GetString(), def.GetProperty("uniqueId").GetProperty("prefix").GetString()));
        // A prefix longer than 20 characters is refused; /version counts the type.
        var tooLong = await DatabaseTests.DbUpdate(ws, database, [DatabaseTests.Prop("pUid0001", "uniqueId", "ID", new JsonObject { ["uniqueId"] = new JsonObject { ["prefix"] = new string('x', 21) } })]);
        Assert.NotEqual("applied", tooLong.GetProperty("status").GetString());
        Assert.Equal(22, (await server.Anonymous().GetFromJsonAsync<JsonElement>("/api/v1/version")).GetProperty("propertyTypes").GetInt32());
    }
}
