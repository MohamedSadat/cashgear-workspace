using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 17, M17.1: rules that wait and decide. A run waits (a time, a date, conditions) with its
/// place in SQL and goes on once, after the worker restarts too; a branch takes the path its
/// conditions name; an approval goes on by the first answer, or every one of a group's, or by "no
/// answer" after its deadline; a waiting run finishes on the rule's version it started with, stops
/// when its rule is switched off, and reads its row and its author's access again before it goes on.
/// </summary>
public sealed class WorkflowTests(ServerFixture server)
{
    private static JsonObject Set(object values) => new() { ["kind"] = "set", ["values"] = JsonSerializer.SerializeToNode(values) };

    private static JsonObject Wait(object until) => new() { ["kind"] = "wait", ["until"] = JsonSerializer.SerializeToNode(until) };

    private static JsonObject Where(string property, string op, object value) => new()
    {
        ["kind"] = "group",
        ["op"] = "and",
        ["children"] = new JsonArray(new JsonObject { ["kind"] = "condition", ["propertyId"] = property, ["operator"] = op, ["value"] = JsonSerializer.SerializeToNode(value) }),
    };

    private static JsonObject Approval(string mode, Guid[] people, Guid[] groups, JsonArray approved, JsonArray rejected, JsonArray noAnswer, int deadline = 4320) => new()
    {
        ["kind"] = "approval",
        ["people"] = new JsonArray([.. people.Select(p => (JsonNode)p.ToString())]),
        ["groups"] = new JsonArray([.. groups.Select(g => (JsonNode)g.ToString())]),
        ["personProperties"] = new JsonArray(),
        ["mode"] = mode,
        ["message"] = "May it go out?",
        ["deadlineMinutes"] = deadline,
        ["approved"] = approved,
        ["rejected"] = rejected,
        ["noAnswer"] = noAnswer,
    };

    private async Task Run()
    {
        Kit.Job<AutomationJob>(server).WaitsNow();
        await server.RunJob<AutomationJob>(200);
    }

    private async Task<List<AutomationRun>> Runs(Ws ws, Guid rule) =>
        await Kit.InWorker(server, ws.Id, (_, db) => db.AutomationRuns.AsNoTracking().Where(r => r.AutomationId == rule).OrderBy(r => r.StartedAt).ThenBy(r => r.Id).ToListAsync());

    private static async Task<JsonElement> RowOf(Ws ws, Guid database, Guid row) =>
        (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=1000")).GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("id").GetGuid() == row);

    private static string? Notes(JsonElement row) => row.GetProperty("values").TryGetProperty("pText001", out var v) ? v.GetString() : null;

    private async Task<(Ws Ws, Guid Database, Guid Rule)> WithRule(params JsonObject[] steps)
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", AutomationTests.Properties.DeepClone().AsArray());
        var rule = Guid.CreateVersion7();
        var saved = await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, AutomationTests.Added, new JsonArray([.. steps])));
        Assert.True(AutomationTests.Status(saved) == "applied", saved.ToString());
        return (ws, database, rule);
    }

    /// <summary>Time passed for a waiting run: its wait began <paramref name="ago"/> earlier and it is due now (its approvals' deadline too, with <paramref name="deadline"/>).</summary>
    private async Task Passed(Ws ws, Guid rule, TimeSpan ago, bool deadline = false)
    {
        var now = DateTimeOffset.UtcNow;
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            foreach (var run in await db.AutomationRuns.Where(r => r.AutomationId == rule && r.Status == RunStatuses.Waiting).ToListAsync())
            {
                run.WaitedAt = (run.WaitedAt ?? now) - ago;
                run.WaitUntil = now.AddSeconds(-1);
            }
            if (deadline)
                await db.AutomationApprovals.Where(a => a.AutomationId == rule).ExecuteUpdateAsync(s => s.SetProperty(a => a.DeadlineAt, now.AddSeconds(-1)));
            await db.SaveChangesAsync();
            return 0;
        });
    }

    [Fact]
    public async Task A_run_waits_a_day_and_goes_on_once_after_the_worker_restarts()
    {
        var (ws, database, rule) = await WithRule(Set(new { pText001 = "asked" }), Wait(new { kind = "time", minutes = 1440 }), Set(new { pText001 = "a day on" }));
        var row = (await DatabaseTests.NewRow(ws, database, "Follow up")).GetProperty("id").GetGuid();
        await Run();
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal((RunStatuses.Waiting, "1", WaitKinds.Time), (run.Status, run.Place, run.WaitKind));
        Assert.InRange(run.WaitUntil!.Value, DateTimeOffset.UtcNow.AddHours(23.9), DateTimeOffset.UtcNow.AddHours(24.1));
        Assert.NotNull(run.Definition);
        Assert.Null(run.EndedAt);
        Assert.Equal("asked", Notes(await RowOf(ws, database, row)));
        // Not yet: the worker leaves it.
        await Run();
        Assert.Equal(RunStatuses.Waiting, Assert.Single(await Runs(ws, rule)).Status);
        // The run log says it waits, and until when.
        var log = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/automations/{rule}/runs");
        Assert.Equal("waiting", log.GetProperty("runs")[0].GetProperty("status").GetString());
        Assert.Equal("waiting", log.GetProperty("runs")[0].GetProperty("steps")[1].GetProperty("status").GetString());
        Assert.Equal("1", log.GetProperty("runs")[0].GetProperty("steps")[1].GetProperty("path").GetString());

        // A day passes; a worker takes it and stops before putting it down: taken again once stale.
        await Passed(ws, rule, TimeSpan.FromDays(1));
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.AutomationRuns.Where(r => r.AutomationId == rule).ExecuteUpdateAsync(s => s.SetProperty(r => r.TakenAt, DateTimeOffset.UtcNow.AddMinutes(-1))));
        await Run();
        Assert.Equal(RunStatuses.Waiting, Assert.Single(await Runs(ws, rule)).Status);
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.AutomationRuns.Where(r => r.AutomationId == rule).ExecuteUpdateAsync(s => s.SetProperty(r => r.TakenAt, DateTimeOffset.UtcNow.AddMinutes(-10))));
        await Run();
        run = Assert.Single(await Runs(ws, rule));
        Assert.Equal((RunStatuses.Done, (string?)null), (run.Status, run.Place));
        var after = await RowOf(ws, database, row);
        Assert.Equal("a day on", Notes(after));
        var version = after.GetProperty("version").GetInt64();

        // Gone on again from the same place (the worker stopped before recording it): nothing twice.
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.AutomationRuns.Where(r => r.AutomationId == rule).ExecuteUpdateAsync(s => s
            .SetProperty(r => r.Status, RunStatuses.Waiting).SetProperty(r => r.Place, "1").SetProperty(r => r.WaitUntil, DateTimeOffset.UtcNow.AddSeconds(-1))
            .SetProperty(r => r.WaitedAt, DateTimeOffset.UtcNow.AddDays(-1).AddMinutes(-1))));
        await Run();
        Assert.Equal(RunStatuses.Done, Assert.Single(await Runs(ws, rule)).Status);
        Assert.Equal(version, (await RowOf(ws, database, row)).GetProperty("version").GetInt64());
    }

    [Fact]
    public async Task A_branch_takes_the_path_its_conditions_name()
    {
        var branch = new JsonObject
        {
            ["kind"] = "branch",
            ["branches"] = new JsonArray(
                new JsonObject { ["when"] = Where("pNum0001", "gt", 5), ["steps"] = new JsonArray(Set(new { pText001 = "big" })) },
                new JsonObject { ["when"] = Where("pNum0001", "gt", 2), ["steps"] = new JsonArray(Set(new { pText001 = "medium" })) }),
            ["otherwise"] = new JsonArray(Set(new { pText001 = "small" })),
        };
        var (ws, database, rule) = await WithRule(branch, Set(new { pStat001 = "sDone001" }));
        var rows = new Dictionary<int, Guid>();
        foreach (var points in new[] { 7, 3, 1 })
            rows[points] = (await DatabaseTests.NewRow(ws, database, $"Points {points}", new { pNum0001 = points })).GetProperty("id").GetGuid();
        await Run();
        Assert.Equal("big", Notes(await RowOf(ws, database, rows[7])));
        Assert.Equal("medium", Notes(await RowOf(ws, database, rows[3])));
        Assert.Equal("small", Notes(await RowOf(ws, database, rows[1])));
        // After the branch, the rule goes on.
        Assert.Equal("sDone001", (await RowOf(ws, database, rows[1])).GetProperty("values").GetProperty("pStat001").GetString());
        var runs = await Runs(ws, rule);
        Assert.All(runs, r => Assert.Equal(RunStatuses.Done, r.Status));
        var steps = runs.ToDictionary(r => r.RowId!.Value, r => JsonNode.Parse(r.Steps)!.AsArray());
        Assert.Equal("path:0", (string?)steps[rows[7]][0]!["detail"]);
        Assert.Equal("0/0/0", (string?)steps[rows[7]][1]!["path"]);
        Assert.Equal("otherwise", (string?)steps[rows[1]][0]!["detail"]);
        Assert.Equal("0/2/0", (string?)steps[rows[1]][1]!["path"]);
    }

    [Fact]
    public async Task A_wait_for_conditions_or_a_date_goes_on_when_its_row_says_so_and_stops_at_its_limit()
    {
        var (ws, database, rule) = await WithRule(
            Wait(new { kind = "match", conditions = Where("pStat001", "is", "sDone001"), minutes = 10080 }),
            Set(new { pText001 = "closed" }));
        var row = (await DatabaseTests.NewRow(ws, database, "Ticket")).GetProperty("id").GetGuid();
        var other = (await DatabaseTests.NewRow(ws, database, "Old ticket")).GetProperty("id").GetGuid();
        await Run();
        var waiting = await Runs(ws, rule);
        Assert.All(waiting, r => Assert.Equal((RunStatuses.Waiting, WaitKinds.Match), (r.Status, r.WaitKind)));
        // Looked at again within the hour whatever wakes it; a change of the row wakes it at once.
        Assert.All(waiting, r => Assert.True(r.WaitUntil <= DateTimeOffset.UtcNow.AddHours(1).AddMinutes(1)));
        await DatabaseTests.RowUpdate(ws, row, new { pNum0001 = 1 });
        await Run();
        Assert.Null(Notes(await RowOf(ws, database, row)));
        await DatabaseTests.RowUpdate(ws, row, new { pStat001 = "sDone001" });
        await Run();
        Assert.Equal("closed", Notes(await RowOf(ws, database, row)));
        // The other waits its week out, then stops, recorded.
        await Passed(ws, rule, TimeSpan.FromDays(8));
        await Run();
        var runs = (await Runs(ws, rule)).ToDictionary(r => r.RowId!.Value);
        Assert.Equal(RunStatuses.Done, runs[row].Status);
        Assert.Equal((RunStatuses.Stopped, "wait.expired"), (runs[other].Status, runs[other].Reason));
        Assert.Null(Notes(await RowOf(ws, database, other)));

        // Until a date: it follows the row's date as it changes; none, or one past, goes on at once.
        var (ws2, database2, dated) = await WithRule(Wait(new { kind = "date", propertyId = "pDate001", offsetMinutes = 0, at = "08:00" }), Set(new { pText001 = "due" }));
        var later = DateTimeOffset.UtcNow.AddDays(3).ToString("yyyy-MM-dd");
        var due = (await DatabaseTests.NewRow(ws2, database2, "Due later", new { pDate001 = new { start = later } })).GetProperty("id").GetGuid();
        var undated = (await DatabaseTests.NewRow(ws2, database2, "No date")).GetProperty("id").GetGuid();
        await Run();
        Assert.Equal("due", Notes(await RowOf(ws2, database2, undated)));
        Assert.Null(Notes(await RowOf(ws2, database2, due)));
        await DatabaseTests.RowUpdate(ws2, due, new { pDate001 = new { start = DateTimeOffset.UtcNow.AddDays(-1).ToString("yyyy-MM-dd") } });
        await Run();
        Assert.Equal("due", Notes(await RowOf(ws2, database2, due)));
        Assert.All(await Runs(ws2, dated), r => Assert.Equal(RunStatuses.Done, r.Status));
    }

    private static async Task<JsonElement> Inbox(Account account) =>
        await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/notifications");

    private static JsonElement ApprovalItem(JsonElement inbox) =>
        inbox.GetProperty("notifications").EnumerateArray().Single(n => n.GetProperty("kind").GetString() == "approval");

    private static Task<HttpResponseMessage> Answer(Account account, Guid approval, string answer, string? comment = null) =>
        account.Client.PostAsJsonAsync($"/api/v1/account/approvals/{approval}", new { answer, comment });

    [Fact]
    public async Task An_approval_goes_on_by_the_first_answer_or_all_of_a_group_or_no_answer_after_its_deadline()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Requests", AutomationTests.Properties.DeepClone().AsArray());
        var anna = await Kit.Join(server, ws, "member");
        var ben = await Kit.Join(server, ws, "member");
        var carl = await Kit.Join(server, ws, "member");
        var outsider = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", anna.Id, "edit"), ("user", ben.Id, "edit"), ("user", carl.Id, "view"));
        JsonArray Answered() => new(Set(new { pPers001 = new { dynamic = "approver" }, pText001 = new { dynamic = "comment" } }));
        JsonArray Then(string text) => new(Set(new { pText001 = text }));

        // Any one of two: the first answer decides; the other's comes too late. The outsider, who
        // cannot read the row, is never asked.
        var any = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, any, database, AutomationTests.Added,
            new JsonArray(Approval("any", [anna.Id, ben.Id, outsider.Id], [], Answered(), Then("rejected"), Then("no answer"))), name: "Any"))));
        var row = (await DatabaseTests.NewRow(ws, database, "Laptop")).GetProperty("id").GetGuid();
        await Run();
        var run = Assert.Single(await Runs(ws, any));
        Assert.Equal((RunStatuses.Waiting, WaitKinds.Approval, "0"), (run.Status, run.WaitKind, run.Place));
        var item = ApprovalItem(await Inbox(anna));
        Assert.Equal(("open", "any", 3 - 1), (item.GetProperty("approval").GetProperty("state").GetString(), item.GetProperty("approval").GetProperty("mode").GetString(),
            item.GetProperty("approval").GetProperty("asked").GetInt32()));
        Assert.Equal(row, item.GetProperty("pageId").GetGuid());
        Assert.Equal("May it go out?", item.GetProperty("excerpt").GetString());
        Assert.DoesNotContain((await Inbox(outsider)).GetProperty("notifications").EnumerateArray(), n => n.GetProperty("kind").GetString() == "approval");
        var annaAsked = item.GetProperty("approval").GetProperty("id").GetGuid();
        var benAsked = ApprovalItem(await Inbox(ben)).GetProperty("approval").GetProperty("id").GetGuid();
        // Nobody answers another's.
        Assert.Equal(HttpStatusCode.NotFound, (await Answer(ben, annaAsked, "approve")).StatusCode);
        var yes = await Answer(anna, annaAsked, "approve", "Fine by me");
        Assert.Equal(HttpStatusCode.OK, yes.StatusCode);
        Assert.Equal("approve", (await Kit.Json(yes)).GetProperty("answer").GetString());
        var twice = await Answer(anna, annaAsked, "reject");
        Assert.Equal(HttpStatusCode.Conflict, twice.StatusCode);
        Assert.Equal("approval.answered", (await Kit.Json(twice)).GetProperty("code").GetString());
        await Run();
        var after = await RowOf(ws, database, row);
        Assert.Equal("Fine by me", Notes(after));
        Assert.Equal(anna.Id, after.GetProperty("values").GetProperty("pPers001")[0].GetGuid());
        Assert.Equal(RunStatuses.Done, Assert.Single(await Runs(ws, any)).Status);
        Assert.Equal("approved", ApprovalItem(await Inbox(ben)).GetProperty("approval").GetProperty("state").GetString());
        var late = await Answer(ben, benAsked, "reject");
        Assert.Equal(HttpStatusCode.Conflict, late.StatusCode);
        Assert.Equal("approval.closed", (await Kit.Json(late)).GetProperty("code").GetString());
        await AutomationTests.Save(ws, AutomationTests.Rule(ws, any, database, AutomationTests.Added, new JsonArray(Set(new { pNum0001 = 1 })), enabled: false, name: "Any"));

        // All of a group: one approval is not enough; the last one decides.
        var group = await GroupKit.New(ws, "Approvers", anna.Id, ben.Id);
        var all = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, all, database, AutomationTests.Added,
            new JsonArray(Approval("all", [], [group], Answered(), Then("rejected"), Then("no answer"))), name: "All"))));
        var desk = (await DatabaseTests.NewRow(ws, database, "Desk")).GetProperty("id").GetGuid();
        var chair = (await DatabaseTests.NewRow(ws, database, "Chair")).GetProperty("id").GetGuid();
        var lamp = (await DatabaseTests.NewRow(ws, database, "Lamp")).GetProperty("id").GetGuid();
        await Run();
        Guid Asked(JsonElement inbox, Guid page) => inbox.GetProperty("notifications").EnumerateArray()
            .Single(n => n.GetProperty("kind").GetString() == "approval" && n.GetProperty("pageId").GetGuid() == page).GetProperty("approval").GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await Answer(anna, Asked(await Inbox(anna), desk), "approve")).StatusCode);
        await Run();
        Assert.Null(Notes(await RowOf(ws, database, desk)));
        Assert.Equal(HttpStatusCode.OK, (await Answer(ben, Asked(await Inbox(ben), desk), "approve", "Yes")).StatusCode);
        await Run();
        Assert.Equal("Yes", Notes(await RowOf(ws, database, desk)));
        // One rejection decides at once.
        Assert.Equal(HttpStatusCode.OK, (await Answer(ben, Asked(await Inbox(ben), chair), "reject")).StatusCode);
        await Run();
        Assert.Equal("rejected", Notes(await RowOf(ws, database, chair)));
        // Nobody answers by the deadline: "no answer".
        await Passed(ws, all, TimeSpan.FromDays(3), deadline: true);
        await Run();
        Assert.Equal("no answer", Notes(await RowOf(ws, database, lamp)));
        var runs = (await Runs(ws, all)).ToDictionary(r => r.RowId!.Value);
        Assert.All(runs.Values, r => Assert.Equal(RunStatuses.Done, r.Status));
        Assert.Equal("noAnswer", (string?)JsonNode.Parse(runs[lamp].Steps)![0]!["status"]);
        var lampItem = (await Inbox(anna)).GetProperty("notifications").EnumerateArray()
            .Single(n => n.GetProperty("kind").GetString() == "approval" && n.GetProperty("pageId").GetGuid() == lamp);
        Assert.Equal("noAnswer", lampItem.GetProperty("approval").GetProperty("state").GetString());
    }

    [Fact]
    public async Task A_waiting_run_finishes_on_the_version_it_started_with_and_stops_when_its_rule_is_off()
    {
        var (ws, database, rule) = await WithRule(Wait(new { kind = "time", minutes = 60 }), Set(new { pText001 = "first version" }));
        var row = (await DatabaseTests.NewRow(ws, database, "Kept")).GetProperty("id").GetGuid();
        await Run();
        // The rule changes while it waits: the run goes on by what it started with.
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, AutomationTests.Added,
            new JsonArray(Wait(new { kind = "time", minutes = 60 }), Set(new { pText001 = "second version" }))))));
        await Passed(ws, rule, TimeSpan.FromHours(1));
        await Run();
        Assert.Equal("first version", Notes(await RowOf(ws, database, row)));

        // Switched off: its waiting runs stop, recorded; switched on again, nothing comes back.
        var next = (await DatabaseTests.NewRow(ws, database, "Stopped")).GetProperty("id").GetGuid();
        await Run();
        var off = await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/{rule}/enabled", new { enabled = false });
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/{rule}/enabled", new { enabled = true });
        await Passed(ws, rule, TimeSpan.FromHours(1));
        await Run();
        var stopped = (await Runs(ws, rule)).Single(r => r.RowId == next);
        Assert.Equal((RunStatuses.Stopped, "rule.off"), (stopped.Status, stopped.Reason));
        Assert.Null(Notes(await RowOf(ws, database, next)));
    }

    [Fact]
    public async Task A_waiting_run_reads_its_row_and_its_authors_access_again_before_it_goes_on()
    {
        var ws = await Ws.Create(server);
        var author = await Kit.Join(server, ws, "member");
        var database = await DatabaseTests.NewDatabase(ws, "Orders", AutomationTests.Properties.DeepClone().AsArray());
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", author.Id, "full"));
        var rule = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, AutomationTests.Added,
            new JsonArray(Wait(new { kind = "time", minutes = 30 }), Set(new { pText001 = "acted" }))), author.Client)));
        var kept = (await DatabaseTests.NewRow(ws, database, "Kept")).GetProperty("id").GetGuid();
        var trashed = (await DatabaseTests.NewRow(ws, database, "Trashed")).GetProperty("id").GetGuid();
        await Run();
        Assert.Equal(2, (await Runs(ws, rule)).Count(r => r.Status == RunStatuses.Waiting));
        // The row goes to the trash while its run waits.
        var trash = await ws.Push(ws.Op("page.trash", trashed, new { }));
        Assert.Equal("applied", trash[0].GetProperty("status").GetString());
        // The author keeps only edit access.
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", author.Id, "edit"));
        await Passed(ws, rule, TimeSpan.FromMinutes(30));
        await Run();
        var runs = (await Runs(ws, rule)).ToDictionary(r => r.RowId!.Value);
        Assert.Equal((RunStatuses.Stopped, "author.access"), (runs[kept].Status, runs[kept].Reason));
        Assert.Equal(RunStatuses.Stopped, runs[trashed].Status);
        Assert.Null(Notes(await RowOf(ws, database, kept)));
        // The author is told.
        Assert.Contains((await Inbox(author)).GetProperty("notifications").EnumerateArray(), n => n.GetProperty("kind").GetString() == "automation"
            && n.TryGetProperty("reason", out var why) && why.GetString() == "author.access");
    }
}
