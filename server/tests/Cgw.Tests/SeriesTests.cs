using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Automations;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 17, M17.2: repeating rows. A series by its days makes its row once and on time in the
/// workspace's zone, its day in the date property, never twice from a worker that stopped; a series
/// by the last done makes the next once the last is done; switched off it makes nothing; its
/// template must be one of the database's.
/// </summary>
public sealed class SeriesTests(ServerFixture server)
{
    private static readonly TimeZoneInfo Riyadh = AutomationTimes.Zone("Asia/Riyadh");

    private static string Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Riyadh).DateTime).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    private static string Plus(string day, int days) => DateOnly.ParseExact(day, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture).AddDays(days).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    private async Task Run()
    {
        Kit.Job<AutomationJob>(server).WaitsNow();
        await server.RunJob<AutomationJob>(200);
    }

    private async Task<Automation> Rule(Ws ws, Guid rule) =>
        await Kit.InWorker(server, ws.Id, (_, db) => db.Automations.AsNoTracking().SingleAsync(a => a.Id == rule));

    private async Task<List<AutomationRun>> Runs(Ws ws, Guid rule) =>
        await Kit.InWorker(server, ws.Id, (_, db) => db.AutomationRuns.AsNoTracking().Where(r => r.AutomationId == rule).OrderBy(r => r.StartedAt).ToListAsync());

    private static async Task<List<JsonElement>> Made(Ws ws, Guid database) =>
        (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=100")).GetProperty("rows").EnumerateArray()
            .Where(r => !r.GetProperty("isTemplate").GetBoolean()).ToList();

    /// <summary>A template of the database, holding a value of its own.</summary>
    internal static async Task<Guid> Template(Ws ws, Guid database, string title)
    {
        var section = (await ws.Tree()).GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == database).GetProperty("sectionId").GetGuid();
        var template = Guid.CreateVersion7();
        var payload = DatabaseTests.PageJson(template, ws.Id, section, database, "a5", title, "row");
        payload["isTemplate"] = true;
        payload["row"] = new JsonObject { ["values"] = new JsonObject { ["pText001"] = "from the template", ["pStat001"] = "sTodo001" } };
        Assert.Equal("applied", (await ws.Push(ws.Op("page.create", template, payload)))[0].GetProperty("status").GetString());
        return template;
    }

    internal static JsonObject Series(Guid template, string start, object rule, string mode = "date", string? at = null, string? dateProperty = "pDate001", string? done = null) => new()
    {
        ["kind"] = "recurring",
        ["templateId"] = template.ToString(),
        ["start"] = start,
        ["rule"] = JsonSerializer.SerializeToNode(rule),
        ["mode"] = mode,
        ["at"] = at,
        ["dateProperty"] = dateProperty,
        ["doneProperty"] = done,
    };

    private async Task<(Ws Ws, Guid Database, Guid Template)> Tasks()
    {
        var ws = await Ws.Create(server);
        await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/settings", new { timeZone = "Asia/Riyadh" });
        var database = await DatabaseTests.NewDatabase(ws, "Chores", AutomationTests.Properties.DeepClone().AsArray());
        return (ws, database, await Template(ws, database, "Water the plants"));
    }

    [Fact]
    public async Task A_series_by_its_days_makes_its_row_once_and_on_time_never_twice_from_a_restart()
    {
        var (ws, database, template) = await Tasks();
        var rule = Guid.CreateVersion7();
        // Every day at 23:59 in Riyadh (UTC+3, no daylight saving), from today.
        var saved = await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, Series(template, Today, new { frequency = "daily" }, at: "23:59"), []));
        Assert.Equal("applied", AutomationTests.Status(saved));
        var placed = await Rule(ws, rule);
        Assert.NotNull(placed.SeriesNext);
        Assert.Equal(new DateTimeOffset(DateTime.ParseExact(placed.SeriesNext!, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture).AddHours(23).AddMinutes(59), TimeSpan.FromHours(3)), placed.NextAt);
        Assert.Null(placed.SeriesDay);

        // Not yet: nothing made.
        await Run();
        Assert.Empty(await Made(ws, database));
        // Its moment comes: one row, from the template, its day in Due.
        var day = placed.SeriesNext!;
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.Automations.Where(a => a.Id == rule).ExecuteUpdateAsync(s => s.SetProperty(a => a.NextAt, DateTimeOffset.UtcNow.AddSeconds(-1))));
        await Run();
        var row = Assert.Single(await Made(ws, database));
        Assert.Equal(("Water the plants", "from the template", day), (row.GetProperty("title").GetString(),
            row.GetProperty("values").GetProperty("pText001").GetString(), row.GetProperty("values").GetProperty("pDate001").GetProperty("start").GetString()));
        Assert.Equal(template, row.GetProperty("templateOfPageId").GetGuid());
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal((RunStatuses.Done, "recurring", $"recur:{day}", row.GetProperty("id").GetGuid()), (run.Status, run.Trigger, run.DueKey, run.RowId!.Value));
        var moved = await Rule(ws, rule);
        Assert.Equal((day, row.GetProperty("id").GetGuid()), (moved.SeriesDay, moved.SeriesRowId!.Value));
        Assert.Equal(Plus(day, 1), moved.SeriesNext);
        Assert.True(moved.NextAt > DateTimeOffset.UtcNow);

        // A worker that stopped after making the row and before moving the series on: nothing twice.
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.Automations.Where(a => a.Id == rule).ExecuteUpdateAsync(s => s
            .SetProperty(a => a.SeriesNext, day).SetProperty(a => a.SeriesDay, (string?)null).SetProperty(a => a.NextAt, DateTimeOffset.UtcNow.AddSeconds(-1))));
        await Run();
        Assert.Single(await Made(ws, database));
        Assert.Single(await Runs(ws, rule));
        Assert.Equal(Plus(day, 1), (await Rule(ws, rule)).SeriesNext);
    }

    [Fact]
    public async Task A_series_whose_worker_was_stopped_makes_the_latest_day_only()
    {
        var (ws, database, template) = await Tasks();
        var rule = Guid.CreateVersion7();
        var start = Plus(Today, -10);
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database,
            Series(template, start, new { frequency = "daily" }, at: "00:00"), []))));
        // Placed on a day ten days ago, as if the worker had been stopped since.
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.Automations.Where(a => a.Id == rule).ExecuteUpdateAsync(s => s
            .SetProperty(a => a.SeriesNext, start).SetProperty(a => a.NextAt, DateTimeOffset.UtcNow.AddDays(-10))));
        await Run();
        var row = Assert.Single(await Made(ws, database));
        Assert.Equal(Today, row.GetProperty("values").GetProperty("pDate001").GetProperty("start").GetString());
        Assert.Equal(Plus(Today, 1), (await Rule(ws, rule)).SeriesNext);
    }

    [Fact]
    public async Task A_series_by_the_last_done_makes_the_next_once_the_last_is_done()
    {
        var (ws, database, template) = await Tasks();
        var rule = Guid.CreateVersion7();
        // Every week on its start's weekday; the next once Status is complete.
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database,
            Series(template, Today, new { frequency = "weekly" }, mode: "done", done: "pStat001"), []))));
        // The first at once, on the first day.
        Assert.Equal(Today, (await Rule(ws, rule)).SeriesNext);
        await Run();
        var first = Assert.Single(await Made(ws, database));
        Assert.Equal(Today, first.GetProperty("values").GetProperty("pDate001").GetProperty("start").GetString());
        var placed = await Rule(ws, rule);
        Assert.Equal(((string?)null, (DateTimeOffset?)null, first.GetProperty("id").GetGuid()), (placed.SeriesNext, placed.NextAt, placed.SeriesRowId!.Value));

        // Another change of it makes nothing; its status complete makes the next, a week on.
        var id = first.GetProperty("id").GetGuid();
        await ws.Push(ws.Op("row.update", id, new { values = new { pText001 = "half done" } }));
        await Run();
        await Run();
        Assert.Single(await Made(ws, database));
        await ws.Push(ws.Op("row.update", id, new { values = new { pStat001 = "sDone001" } }));
        await Run();
        await Run();
        var rows = await Made(ws, database);
        Assert.Equal(2, rows.Count);
        var second = rows.Single(r => r.GetProperty("id").GetGuid() != id);
        Assert.Equal(Plus(Today, 7), second.GetProperty("values").GetProperty("pDate001").GetProperty("start").GetString());
        Assert.Equal(second.GetProperty("id").GetGuid(), (await Rule(ws, rule)).SeriesRowId);

        // The first undone and done again is not the last: nothing more.
        await ws.Push(ws.Op("row.update", id, new { values = new { pStat001 = "sTodo001" } }));
        await ws.Push(ws.Op("row.update", id, new { values = new { pStat001 = "sDone001" } }));
        await Run();
        await Run();
        Assert.Equal(2, (await Made(ws, database)).Count);
    }

    [Fact]
    public async Task A_series_switched_off_makes_nothing_and_names_a_template_of_its_own_database()
    {
        var (ws, database, template) = await Tasks();
        var rule = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database,
            Series(template, Today, new { frequency = "daily" }), [], enabled: false))));
        var off = await Rule(ws, rule);
        Assert.Equal(((string?)null, (DateTimeOffset?)null), (off.SeriesNext, off.NextAt));
        // Switched on from Settings: placed.
        var on = await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/{rule}/enabled", new { enabled = true });
        on.EnsureSuccessStatusCode();
        Assert.NotNull((await Rule(ws, rule)).SeriesNext);

        // A row that is no template, and a template of another database, are refused.
        var plain = (await DatabaseTests.NewRow(ws, database, "Just a row")).GetProperty("id").GetGuid();
        Assert.Equal("invalid", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, Guid.CreateVersion7(), database,
            Series(plain, Today, new { frequency = "daily" }), []))));
        var other = await DatabaseTests.NewDatabase(ws, "Other", AutomationTests.Properties.DeepClone().AsArray());
        var foreign = await Template(ws, other, "Elsewhere");
        Assert.Equal("invalid", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, Guid.CreateVersion7(), database,
            Series(foreign, Today, new { frequency = "daily" }), []))));

        // Its template gone: the run stops, saying so, and makes no row.
        await ws.Push(ws.Op("page.trash", template, new { }));
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.Automations.Where(a => a.Id == rule).ExecuteUpdateAsync(s => s.SetProperty(a => a.NextAt, DateTimeOffset.UtcNow.AddSeconds(-1))));
        await Run();
        Assert.Equal(plain, Assert.Single(await Made(ws, database)).GetProperty("id").GetGuid());
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal((RunStatuses.Stopped, "template.gone"), (run.Status, run.Reason));
    }
}
