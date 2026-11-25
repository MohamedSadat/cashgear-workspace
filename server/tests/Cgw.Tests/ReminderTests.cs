using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Automations;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 17, M17.2: reminders. A person's own reminder of a row's date reaches their inbox once its
/// moment comes (a day at 09:00 in the workspace's zone), once for each moment, and follows the date
/// when it moves; never for a row they can no longer read or one in the trash. A rule's notice marked
/// a reminder reaches the people it names as a reminder of the date reached. The moments are real
/// ones a few seconds ahead: the worker works every reminder's moment out again from its row now and
/// then, so a moment set by hand would not hold.
/// </summary>
public sealed class ReminderTests(ServerFixture server)
{
    private static readonly TimeSpan Ahead = TimeSpan.FromSeconds(5);

    private static string Day(int days) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, AutomationTimes.Zone("Asia/Riyadh")).DateTime).AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>The day's 09:00 in Riyadh (UTC+3, no daylight saving).</summary>
    private static DateTimeOffset NineOn(string day) =>
        new(DateTime.ParseExact(day, "yyyy-MM-dd", CultureInfo.InvariantCulture).AddHours(9), TimeSpan.FromHours(3));

    private static string Instant(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    /// <summary>A moment a few seconds ahead, to the second (as a date-time holds it).</summary>
    private static DateTimeOffset Soon() => DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.Add(Ahead).ToUnixTimeSeconds() + 1);

    private static async Task Until(DateTimeOffset at)
    {
        var wait = at - DateTimeOffset.UtcNow + TimeSpan.FromMilliseconds(200);
        if (wait > TimeSpan.Zero) await Task.Delay(wait);
    }

    private async Task<(Ws Ws, Guid Database)> Tasks()
    {
        var ws = await Ws.Create(server);
        await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/settings", new { timeZone = "Asia/Riyadh" });
        var props = AutomationTests.Properties.DeepClone().AsArray();
        props.Add(DatabaseTests.Prop("pWhen001", "date", "When", new JsonObject { ["date"] = new JsonObject { ["includeTime"] = true } }));
        return (ws, await DatabaseTests.NewDatabase(ws, "Tasks", props));
    }

    private async Task Send() => await server.RunJob<ReminderJob>(50);

    private static async Task<List<JsonElement>> Reminders(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/v1/account/notifications")).GetProperty("notifications").EnumerateArray()
            .Where(n => n.GetProperty("kind").GetString() == "reminder").ToList();

    private static async Task<JsonElement> Listed(HttpClient client, Guid database, Guid row) =>
        (await client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows/{row}/reminders")).GetProperty("reminders");

    [Fact]
    public async Task A_persons_reminder_reaches_their_inbox_once_at_its_time_and_follows_the_date()
    {
        var (ws, database) = await Tasks();
        var due = Day(2);
        var at = Soon();
        var row = (await DatabaseTests.NewRow(ws, database, "Pay the rent", new { pDate001 = new { start = due }, pWhen001 = new { start = Instant(at) } }))
            .GetProperty("id").GetGuid();

        // A day before Due: that day's 09:00 in the workspace's zone, less a day.
        var set = await ws.Client.PutAsJsonAsync($"/api/v1/databases/{database}/rows/{row}/reminders/pDate001", new { beforeMinutes = 1440 });
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        var reminder = Assert.Single((await Kit.Json(set)).GetProperty("reminders").EnumerateArray());
        Assert.Equal(("pDate001", 1440), (reminder.GetProperty("propertyId").GetString(), reminder.GetProperty("beforeMinutes").GetInt32()));
        Assert.Equal(NineOn(due).AddDays(-1), reminder.GetProperty("dueAt").GetDateTimeOffset());
        // At When's moment.
        set = await ws.Client.PutAsJsonAsync($"/api/v1/databases/{database}/rows/{row}/reminders/pWhen001", new { beforeMinutes = 0 });
        Assert.Equal(at, (await Kit.Json(set)).GetProperty("reminders").EnumerateArray().Single(r => r.GetProperty("propertyId").GetString() == "pWhen001")
            .GetProperty("dueAt").GetDateTimeOffset());

        // Not yet: nothing sent.
        await Send();
        Assert.Empty(await Reminders(ws.Client));
        // Its moment comes: one reminder, of When's date.
        await Until(at);
        await Send();
        var sent = Assert.Single(await Reminders(ws.Client));
        Assert.Equal((row, "Pay the rent"), (sent.GetProperty("pageId").GetGuid(), sent.GetProperty("pageTitle").GetString()));
        Assert.Equal(("pWhen001", "When", Instant(at)), (sent.GetProperty("reminder").GetProperty("propertyId").GetString(),
            sent.GetProperty("reminder").GetProperty("propertyName").GetString(), sent.GetProperty("reminder").GetProperty("start").GetString()));
        await Send();
        Assert.Single(await Reminders(ws.Client));

        // When moves on: its moment with it, and sent again when that comes.
        var later = Soon();
        await ws.Push(ws.Op("row.update", row, new { values = new { pWhen001 = new { start = Instant(later) } } }));
        Assert.Equal(later, (await Listed(ws.Client, database, row)).EnumerateArray().Single(r => r.GetProperty("propertyId").GetString() == "pWhen001")
            .GetProperty("dueAt").GetDateTimeOffset());
        await Until(later);
        await Send();
        Assert.Equal(2, (await Reminders(ws.Client)).Count);

        // A moment already past is no reminder; no date at all is none; deleted, it is gone.
        await ws.Push(ws.Op("row.update", row, new { values = new { pWhen001 = new { start = Instant(DateTimeOffset.UtcNow.AddHours(-1)) } } }));
        await Send();
        Assert.Equal(2, (await Reminders(ws.Client)).Count);
        await ws.Push(ws.Op("row.update", row, new { values = new { pWhen001 = (object?)null } }));
        Assert.Equal(JsonValueKind.Null, (await Listed(ws.Client, database, row)).EnumerateArray().Single(r => r.GetProperty("propertyId").GetString() == "pWhen001")
            .GetProperty("dueAt").ValueKind);
        var deleted = await ws.Client.DeleteAsync($"/api/v1/databases/{database}/rows/{row}/reminders/pWhen001");
        Assert.Equal("pDate001", Assert.Single((await Kit.Json(deleted)).GetProperty("reminders").EnumerateArray()).GetProperty("propertyId").GetString());
    }

    [Fact]
    public async Task A_reminder_is_of_a_date_at_a_choice_of_times_on_a_row_the_person_reads()
    {
        var (ws, database) = await Tasks();
        var at = Soon();
        var row = (await DatabaseTests.NewRow(ws, database, "Call the bank", new { pDate001 = new { start = Day(3) }, pWhen001 = new { start = Instant(at) } }))
            .GetProperty("id").GetGuid();
        async Task<(HttpStatusCode, string?)> Set(HttpClient client, string property, int before, Guid? on = null)
        {
            var response = await client.PutAsJsonAsync($"/api/v1/databases/{database}/rows/{on ?? row}/reminders/{property}", new { beforeMinutes = before });
            return (response.StatusCode, response.IsSuccessStatusCode ? null : (await Kit.Json(response)).GetProperty("code").GetString());
        }
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Set(ws.Client, "pDate001", 30));
        Assert.Equal((HttpStatusCode.BadRequest, "request.invalid"), await Set(ws.Client, "pText001", 0));
        Assert.Equal((HttpStatusCode.NotFound, "not.found"), await Set(ws.Client, "pDate001", 0, Guid.CreateVersion7()));
        foreach (var before in ReminderService.Befores) Assert.Equal((HttpStatusCode.OK, (string?)null), await Set(ws.Client, "pDate001", before));

        // A reader sets their own; someone who cannot see the database cannot.
        var reader = await Kit.Join(server, ws, "member");
        var outsider = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", reader.Id, "view"));
        Assert.Equal((HttpStatusCode.OK, (string?)null), await Set(reader.Client, "pWhen001", 0));
        Assert.Equal(HttpStatusCode.NotFound, (await Set(outsider.Client, "pWhen001", 0)).Item1);
        // Each reads only their own.
        Assert.Equal("pWhen001", Assert.Single((await Listed(reader.Client, database, row)).EnumerateArray()).GetProperty("propertyId").GetString());
        Assert.Equal(HttpStatusCode.OK, (await Set(ws.Client, "pWhen001", 0)).Item1);

        // The reader's access ends before its moment: nothing sent to them, the owner's still is.
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"));
        await Until(at);
        await Send();
        Assert.Empty(await Reminders(reader.Client));
        Assert.Single(await Reminders(ws.Client));

        // Nor for a row in the trash.
        var soon = Soon();
        var binned = (await DatabaseTests.NewRow(ws, database, "Binned", new { pWhen001 = new { start = Instant(soon) } })).GetProperty("id").GetGuid();
        Assert.Equal((HttpStatusCode.OK, (string?)null), await Set(ws.Client, "pWhen001", 0, binned));
        await ws.Push(ws.Op("page.trash", binned, new { }));
        Assert.Equal(JsonValueKind.Null, Assert.Single((await Listed(ws.Client, database, binned)).EnumerateArray()).GetProperty("dueAt").ValueKind);
        await Until(soon);
        await Send();
        Assert.DoesNotContain(await Reminders(ws.Client), n => n.GetProperty("pageId").GetGuid() == binned);
    }

    [Fact]
    public async Task A_rules_notice_marked_a_reminder_reaches_its_people_as_a_reminder()
    {
        var (ws, database) = await Tasks();
        var rule = Guid.CreateVersion7();
        var trigger = new JsonObject { ["kind"] = "date", ["propertyId"] = "pDate001", ["offsetMinutes"] = 0 };
        var steps = new JsonArray(new JsonObject
        {
            ["kind"] = "notify", ["personProperties"] = new JsonArray("pPers001"), ["message"] = "Due today", ["reminder"] = true,
        });
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, trigger, steps))));
        // Reached yesterday at 09:00 in the zone, since the rule was switched on two days ago.
        var row = (await DatabaseTests.NewRow(ws, database, "Renew the licence", new { pDate001 = new { start = Day(-1) }, pPers001 = new[] { ws.Account.Id } }))
            .GetProperty("id").GetGuid();
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.Automations.Where(a => a.Id == rule)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.ScannedUntil, DateTimeOffset.UtcNow.AddDays(-2))));
        Kit.Job<AutomationJob>(server).TimesNow();
        await server.RunJob<AutomationJob>(200);
        var sent = Assert.Single(await Reminders(ws.Client));
        Assert.Equal((row, "Due today", "Due", Day(-1)), (sent.GetProperty("pageId").GetGuid(), sent.GetProperty("excerpt").GetString(),
            sent.GetProperty("reminder").GetProperty("propertyName").GetString(), sent.GetProperty("reminder").GetProperty("start").GetString()));
        Assert.Equal(rule, sent.GetProperty("automationId").GetGuid());

        // Marked a reminder only under a date trigger.
        var refused = await AutomationTests.Save(ws, AutomationTests.Rule(ws, Guid.CreateVersion7(), database, AutomationTests.Added, steps.DeepClone().AsArray()));
        Assert.Equal("invalid", AutomationTests.Status(refused));
    }
}
