using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Automations;
using Cgw.Core.Data;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>A webhook's receiver on loopback: every call it got, and what it answers.</summary>
public sealed class Receiver : IAsyncDisposable
{
    private readonly WebApplication app;
    public ConcurrentQueue<(string Path, Dictionary<string, string> Headers, string Body)> Calls { get; } = new();
    /// <summary>The status answered, or a redirect's target.</summary>
    public int Status { get; set; } = 200;
    public string? RedirectTo { get; set; }
    public string Url { get; }

    private Receiver(WebApplication app, string url)
    {
        this.app = app;
        Url = url;
    }

    public static async Task<Receiver> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        Receiver? self = null;
        app.Run(async context =>
        {
            using var reader = new StreamReader(context.Request.Body);
            var body = await reader.ReadToEndAsync();
            self!.Calls.Enqueue((context.Request.Path.Value ?? "", context.Request.Headers.ToDictionary(h => h.Key, h => h.Value.ToString(), StringComparer.OrdinalIgnoreCase), body));
            if (self.RedirectTo is { } to) context.Response.Redirect(to, false, true);
            else context.Response.StatusCode = self.Status;
        });
        await app.StartAsync();
        var url = app.Urls.First();
        self = new Receiver(app, url);
        return self;
    }

    public async ValueTask DisposeAsync() => await app.DisposeAsync();
}

/// <summary>
/// Phase 15, M15.2: the runner. A change from any device runs its rules once, in the order changes
/// reached the server, as each rule's author; a rule its author can no longer run stops and tells
/// them; rules that start each other stop at the depth limit; the rate limits; notices only to
/// those who can read the row; a new row from a template with its body; webhooks signed, retried,
/// and never inside the host's network; dates and schedules in the workspace's zone; a button's
/// press, once; no step near the ERP.
/// </summary>
public sealed class AutomationRunTests(ServerFixture server)
{
    private static JsonArray Set(object values) => [new JsonObject { ["kind"] = "set", ["values"] = JsonSerializer.SerializeToNode(values) }];

    private async Task Run() => await server.RunJob<AutomationJob>(200);

    private async Task<List<AutomationRun>> Runs(Ws ws, Guid rule) =>
        await Kit.InWorker(server, ws.Id, (_, db) => db.AutomationRuns.AsNoTracking().Where(r => r.AutomationId == rule).OrderBy(r => r.StartedAt).ThenBy(r => r.EventId).ToListAsync());

    private static async Task<JsonElement> RowOf(Ws ws, Guid database, Guid row, HttpClient? client = null) =>
        (await (client ?? ws.Client).GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=1000")).GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("id").GetGuid() == row);

    private async Task<(Ws Ws, Guid Database, Guid Rule)> WithRule(JsonObject trigger, JsonArray steps, JsonArray? properties = null)
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", properties ?? AutomationTests.Properties.DeepClone().AsArray());
        var rule = Guid.CreateVersion7();
        var saved = await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, trigger, steps));
        Assert.True(AutomationTests.Status(saved) == "applied", saved.ToString());
        return (ws, database, rule);
    }

    [Fact]
    public async Task A_change_from_any_device_runs_its_rule_once_as_its_author()
    {
        var (ws, database, rule) = await WithRule(
            AutomationTests.Changed("pStat001", new JsonObject { ["operator"] = "is", ["value"] = "sDone001" }),
            Set(new { pText001 = "closed", pPers001 = new { dynamic = "actor" } }));
        var editor = await Kit.Join(server, ws, "member");
        var row = (await DatabaseTests.NewRow(ws, database, "Report")).GetProperty("id").GetGuid();
        Assert.Equal("applied", (await DatabaseTests.RowUpdate(ws, row, new { pStat001 = "sDone001" }, editor.Client)).GetProperty("status").GetString());
        await Run();

        var after = await RowOf(ws, database, row);
        Assert.Equal("closed", after.GetProperty("values").GetProperty("pText001").GetString());
        Assert.Equal(editor.Id, after.GetProperty("values").GetProperty("pPers001")[0].GetGuid());
        // The row's editor is the rule's author.
        Assert.Equal(ws.Account.Id, after.GetProperty("updatedBy").GetGuid());
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal(RunStatuses.Done, run.Status);
        Assert.Equal((1, editor.Id, ws.Account.Id, row), (run.Depth, run.ActorId!.Value, run.AuthorId, run.RowId!.Value));
        Assert.Equal("done", JsonNode.Parse(run.Steps)![0]!["status"]!.GetValue<string>());

        // Taken again (a worker that stopped before marking it done): no second run, nothing written twice.
        var version = after.GetProperty("version").GetInt64();
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.AutomationEvents.Where(e => e.RowId == row).ExecuteUpdateAsync(s => s.SetProperty(e => e.DoneAt, (DateTimeOffset?)null).SetProperty(e => e.TakenAt, (DateTimeOffset?)null)));
        await Run();
        Assert.Single(await Runs(ws, rule));
        // A run left running is gone on with, its steps applied once (their operations' ids are the run's).
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.AutomationRuns.Where(r => r.AutomationId == rule).ExecuteUpdateAsync(s => s.SetProperty(r => r.Status, RunStatuses.Running)));
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.AutomationEvents.Where(e => e.RowId == row).ExecuteUpdateAsync(s => s.SetProperty(e => e.DoneAt, (DateTimeOffset?)null).SetProperty(e => e.TakenAt, (DateTimeOffset?)null)));
        await Run();
        Assert.Equal(RunStatuses.Done, Assert.Single(await Runs(ws, rule)).Status);
        Assert.Equal(version, (await RowOf(ws, database, row)).GetProperty("version").GetInt64());
        // The rule's run log and the row's.
        var log = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/automations/{rule}/runs");
        Assert.Equal("Report", log.GetProperty("runs")[0].GetProperty("rowTitle").GetString());
        var rowLog = await editor.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows/{row}/runs");
        Assert.Equal("Rule", rowLog.GetProperty("runs")[0].GetProperty("automationName").GetString());
        // Its rule log is for full access; the editor reads the row's.
        Assert.Equal(HttpStatusCode.Forbidden, (await editor.Client.GetAsync($"/api/v1/databases/{database}/automations/{rule}/runs")).StatusCode);
    }

    [Fact]
    public async Task Changes_made_offline_run_their_rules_in_the_order_they_reached_the_server()
    {
        var (ws, database, rule) = await WithRule(AutomationTests.Changed("pNum0001"), Set(new { pText001 = "seen" }));
        var rows = new List<Guid>();
        for (var i = 0; i < 3; i++) rows.Add((await DatabaseTests.NewRow(ws, database, $"Row {i}")).GetProperty("id").GetGuid());
        // One device's outbox, sent at once when it comes back: three changes in one batch.
        var results = await ws.Push(rows.Select((row, i) => ws.Op("row.update", row, new { values = new { pNum0001 = i + 1 } })).ToArray());
        Assert.All(results.EnumerateArray(), r => Assert.Equal("applied", r.GetProperty("status").GetString()));
        await Run();
        var runs = await Runs(ws, rule);
        Assert.Equal(rows, runs.Select(r => r.RowId!.Value));
        Assert.True(runs.Zip(runs.Skip(1)).All(p => p.First.EventId < p.Second.EventId && p.First.StartedAt <= p.Second.StartedAt));
    }

    [Fact]
    public async Task A_rule_whose_author_lost_access_stops_says_why_and_tells_them()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", AutomationTests.Properties.DeepClone().AsArray());
        var author = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", author.Id, "full"));
        var rule = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, AutomationTests.Added, Set(new { pText001 = "x" })), author.Client)));
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", author.Id, "edit"));
        var row = (await DatabaseTests.NewRow(ws, database, "Row")).GetProperty("id").GetGuid();
        await Run();
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal((RunStatuses.Stopped, "author.access"), (run.Status, run.Reason));
        Assert.False((await RowOf(ws, database, row)).GetProperty("values").TryGetProperty("pText001", out _));
        var inbox = await author.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/notifications");
        var notice = inbox.GetProperty("notifications").EnumerateArray().Single(n => n.GetProperty("kind").GetString() == "automation");
        Assert.Equal("author.access", notice.GetProperty("reason").GetString());
        Assert.Equal("Rule", notice.GetProperty("automationName").GetString());
    }

    [Fact]
    public async Task Rules_that_start_each_other_stop_at_the_depth_limit_the_row_as_the_last_run_left_it()
    {
        var props = AutomationTests.Properties.DeepClone().AsArray();
        props.Add(DatabaseTests.Prop("pTick001", "checkbox", "Done?"));
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", props);
        var off = Guid.CreateVersion7();
        var on = Guid.CreateVersion7();
        await AutomationTests.Save(ws, AutomationTests.Rule(ws, off, database, AutomationTests.Changed("pTick001", new JsonObject { ["operator"] = "is", ["value"] = true }), Set(new { pTick001 = false })));
        await AutomationTests.Save(ws, AutomationTests.Rule(ws, on, database, AutomationTests.Changed("pTick001", new JsonObject { ["operator"] = "is", ["value"] = false }), Set(new { pTick001 = true })));
        var row = (await DatabaseTests.NewRow(ws, database, "Row")).GetProperty("id").GetGuid();
        await DatabaseTests.RowUpdate(ws, row, new { pTick001 = true });
        for (var i = 0; i < 6; i++) await Run();
        var runs = (await Runs(ws, off)).Concat(await Runs(ws, on)).OrderBy(r => r.Depth).ToList();
        Assert.Equal(new[] { 1, 2, 3, 4 }, runs.Select(r => r.Depth));
        Assert.All(runs.Take(3), r => Assert.Equal(RunStatuses.Done, r.Status));
        Assert.Equal((RunStatuses.Stopped, "depth"), (runs[3].Status, runs[3].Reason));
        // Depth 3 (the "off" rule) left it unticked.
        Assert.Equal(off, runs[2].AutomationId);
        Assert.False((await RowOf(ws, database, row)).GetProperty("values").TryGetProperty("pTick001", out _));
    }

    [Fact]
    public async Task A_rule_runs_at_most_a_hundred_times_a_minute()
    {
        var (ws, database, rule) = await WithRule(AutomationTests.Changed("pNum0001"), Set(new { pText001 = "seen" }));
        var row = (await DatabaseTests.NewRow(ws, database, "Row")).GetProperty("id").GetGuid();
        // 101 changes as the flush writes them.
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            for (var i = 0; i < 101; i++)
                db.AutomationEvents.Add(new AutomationEvent { WorkspaceId = ws.Id, DatabaseId = database, RowId = row, Kind = EventKinds.Changed, Changed = "[\"pNum0001\"]", ActorId = ws.Account.Id, CreatedAt = DateTimeOffset.UtcNow });
            return await db.SaveChangesAsync();
        });
        await Run();
        var runs = await Runs(ws, rule);
        Assert.Equal(101, runs.Count);
        Assert.Equal(100, runs.Count(r => r.Status == RunStatuses.Done));
        Assert.Equal("limit.rule", runs.Single(r => r.Status == RunStatuses.Skipped).Reason);
    }

    [Fact]
    public async Task A_notice_reaches_only_those_who_can_read_the_row()
    {
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", AutomationTests.Properties.DeepClone().AsArray());
        var reader = await Kit.Join(server, ws, "member");
        var outsider = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", reader.Id, "view"));
        var rule = Guid.CreateVersion7();
        var steps = new JsonArray(new JsonObject { ["kind"] = "notify", ["people"] = new JsonArray(reader.Id.ToString(), outsider.Id.ToString()), ["personProperties"] = new JsonArray("pPers001"), ["message"] = "Please look at it" });
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, AutomationTests.Added, steps, name: "Tell them"))));
        await DatabaseTests.NewRow(ws, database, "Secret row", new { pPers001 = new[] { outsider.Id.ToString() } });
        await Run();
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal(1, JsonNode.Parse(run.Steps)![0]!["count"]!.GetValue<int>());
        var notice = (await reader.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/notifications")).GetProperty("notifications").EnumerateArray().Single();
        Assert.Equal(("automation", "Secret row", "Please look at it", "Tell them"),
            (notice.GetProperty("kind").GetString(), notice.GetProperty("pageTitle").GetString(), notice.GetProperty("excerpt").GetString(), notice.GetProperty("automationName").GetString()));
        Assert.Equal(ws.Account.Id, notice.GetProperty("actor").GetProperty("id").GetGuid());
        Assert.Empty((await outsider.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/notifications")).GetProperty("notifications").EnumerateArray());
    }

    [Fact]
    public async Task A_new_row_is_added_from_a_template_its_values_and_its_body_copied()
    {
        var ws = await Ws.Create(server);
        var tasks = await DatabaseTests.NewDatabase(ws, "Tasks", AutomationTests.Properties.DeepClone().AsArray());
        var followUps = await DatabaseTests.NewDatabase(ws, "Follow-ups", new JsonArray(
            DatabaseTests.Prop("pText001", "text", "Notes"),
            DatabaseTests.Prop("pFrom001", "relation", "From", new JsonObject { ["relation"] = new JsonObject { ["databaseId"] = tasks.ToString(), ["reversePropertyId"] = null } })));
        var section = (await ws.Tree()).GetProperty("pages").EnumerateArray().First(p => p.GetProperty("id").GetGuid() == followUps).GetProperty("sectionId").GetGuid();
        var template = Guid.CreateVersion7();
        var payload = DatabaseTests.PageJson(template, ws.Id, section, followUps, "a1", "Follow up", "row");
        payload["isTemplate"] = true;
        payload["icon"] = "📌";
        payload["row"] = new JsonObject { ["values"] = new JsonObject { ["pText001"] = "from the template" } };
        Assert.Equal("applied", (await ws.Push(ws.Op("page.create", template, payload)))[0].GetProperty("status").GetString());
        await Kit.Register(ws.Client, ws.Id);
        await Kit.PushOk(ws.Client, template, Kit.Update("page"));
        await Kit.PushOk(ws.Client, template, Kit.Update("edit"));
        await server.RunJob<ValidateJob>();
        await Kit.Derive(server, ws.Id, template);
        async Task<string> Content(Guid page) => (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/pages/{page}/doc/json")).GetProperty("json").GetString()!;
        var templateJson = await Content(template);

        var rule = Guid.CreateVersion7();
        var steps = new JsonArray(new JsonObject
        {
            ["kind"] = "addRow", ["databaseId"] = followUps.ToString(), ["templateId"] = template.ToString(),
            ["values"] = new JsonObject { ["title"] = "Call back", ["pFrom001"] = new JsonObject { ["dynamic"] = "row" } },
        });
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, tasks, AutomationTests.Added, steps))));
        var source = (await DatabaseTests.NewRow(ws, tasks, "Customer called")).GetProperty("id").GetGuid();
        await Run();
        Assert.Equal(RunStatuses.Done, Assert.Single(await Runs(ws, rule)).Status);
        var made = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{followUps}/rows?limit=100")).GetProperty("rows").EnumerateArray()
            .Single(r => !r.GetProperty("isTemplate").GetBoolean());
        Assert.Equal(("Call back", "📌", template), (made.GetProperty("title").GetString(), made.GetProperty("icon").GetString(), made.GetProperty("templateOfPageId").GetGuid()));
        Assert.Equal("from the template", made.GetProperty("values").GetProperty("pText001").GetString());
        Assert.Equal(source, made.GetProperty("values").GetProperty("pFrom001")[0].GetGuid());
        Assert.Equal(1, made.GetProperty("docHeadSeq").GetInt64());
        var id = made.GetProperty("id").GetGuid();
        await Kit.Derive(server, ws.Id, id);
        var copied = await Content(id);
        static string WithoutIds(string json) => System.Text.RegularExpressions.Regex.Replace(json, "\"id\":\"[0-9A-Za-z]{12}\"", "\"id\":\"x\"");
        Assert.Equal(WithoutIds(templateJson), WithoutIds(copied));
        Assert.NotEqual(templateJson, copied);
        // The template's own document is as it was.
        Assert.Equal(templateJson, await Content(template));
    }

    [Fact]
    public async Task A_webhook_is_called_signed_retried_and_its_receiver_can_check_it()
    {
        await using var receiver = await Receiver.StartAsync();
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Tasks", AutomationTests.Properties.DeepClone().AsArray());
        var made = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/webhooks", new { name = "Receiver", url = receiver.Url + "/in" }));
        var secret = made.GetProperty("secret").GetString()!;
        var steps = new JsonArray(new JsonObject { ["kind"] = "webhook", ["webhookId"] = made.GetProperty("webhook").GetProperty("id").GetString(), ["properties"] = new JsonArray("title", "pStat001", "pPers001", "pNum0001") });
        var rule = Guid.CreateVersion7();
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, AutomationTests.Added, steps, name: "Tell the shop"))));
        receiver.Status = 500;
        var row = (await DatabaseTests.NewRow(ws, database, "Order 7", new { pStat001 = "sDone001", pPers001 = new[] { ws.Account.Id.ToString() }, pNum0001 = 3 })).GetProperty("id").GetGuid();
        await Run();
        await server.RunJob<WebhookJob>();
        // Refused once: tried again after a minute, the step still queued.
        var delivery = await Kit.InWorker(server, ws.Id, (_, db) => db.WebhookDeliveries.AsNoTracking().SingleAsync(d => d.RunId == db.AutomationRuns.Single(r => r.AutomationId == rule).Id));
        Assert.Equal((DeliveryStatuses.Pending, 1, 500), (delivery.Status, delivery.Attempts, delivery.LastStatus!.Value));
        Assert.InRange(delivery.NextAt - DateTimeOffset.UtcNow, TimeSpan.FromSeconds(50), TimeSpan.FromSeconds(61));
        receiver.Status = 204;
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.WebhookDeliveries.Where(d => d.Id == delivery.Id).ExecuteUpdateAsync(s => s.SetProperty(d => d.NextAt, DateTimeOffset.UtcNow.AddSeconds(-1))));
        await server.RunJob<WebhookJob>();
        Assert.Equal(2, receiver.Calls.Count);
        var (path, headers, body) = receiver.Calls.Last();
        Assert.Equal("/in", path);
        // The receiver checks it: HMAC-SHA256 of "<timestamp>.<body>" by the secret it was shown once.
        var timestamp = headers["X-Cgw-Timestamp"];
        var expected = "v1=" + Convert.ToHexString(System.Security.Cryptography.HMACSHA256.HashData(System.Text.Encoding.UTF8.GetBytes(secret), System.Text.Encoding.UTF8.GetBytes($"{timestamp}.{body}"))).ToLowerInvariant();
        Assert.Equal(expected, headers["X-Cgw-Signature"]);
        Assert.Equal(delivery.Id.ToString(), headers["X-Cgw-Delivery"]);
        var json = JsonNode.Parse(body)!;
        Assert.Equal("Tell the shop", (string)json["automation"]!["name"]!);
        Assert.Equal("Order 7", (string)json["row"]!["title"]!);
        Assert.Equal("Done", (string)json["properties"]!["pStat001"]!["value"]!);
        Assert.Equal(3, (double)json["properties"]!["pNum0001"]!["value"]!);
        // A person by their name, never their email.
        Assert.DoesNotContain(ws.Account.Email, body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("@", body, StringComparison.Ordinal);
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal("delivered", JsonNode.Parse(run.Steps)![0]!["status"]!.GetValue<string>());

        // Five failures in all: given up, the step failed with the answer's status.
        receiver.Status = 503;
        var again = (await DatabaseTests.NewRow(ws, database, "Order 8")).GetProperty("id").GetGuid();
        await Run();
        for (var i = 0; i < 5; i++)
        {
            await Kit.InWorker(server, ws.Id, async (_, db) => await db.WebhookDeliveries.Where(d => d.Status == DeliveryStatuses.Pending && d.WorkspaceId == ws.Id).ExecuteUpdateAsync(s => s.SetProperty(d => d.NextAt, DateTimeOffset.UtcNow.AddSeconds(-1))));
            await server.RunJob<WebhookJob>();
        }
        var failed = (await Runs(ws, rule)).Single(r => r.RowId == again);
        Assert.Equal(("failed", "http.503", 5), ((string)JsonNode.Parse(failed.Steps)![0]!["status"]!, (string)JsonNode.Parse(failed.Steps)![0]!["code"]!, (int)JsonNode.Parse(failed.Steps)![0]!["count"]!));
        _ = row;
    }

    [Fact]
    public async Task A_webhook_never_reaches_an_address_inside_by_its_name_or_a_redirect()
    {
        await using var receiver = await Receiver.StartAsync();
        var port = new Uri(receiver.Url).Port;
        // As in production: no loopback allowed.
        var strict = new WebhookOptions(allowLoopback: false);
        foreach (var url in new[] { $"http://127.0.0.1:{port}/in", "https://127.0.0.1/in", "https://[::1]/in", "https://10.1.2.3/in", "https://169.254.169.254/latest", "https://localhost/in", "https://app.localhost/in", "https://[::ffff:192.168.0.1]/in", "https://2130706433/in" })
            Assert.False(strict.Allowed(url), url);
        Assert.True(strict.Allowed("https://hooks.example.com/in"));
        // A name whose address is inside, however it is spelled: refused at the connect, nothing sent.
        foreach (var inside in new[] { "127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fd00::1", "100.64.0.1" })
        {
            var sender = new WebhookSender(strict, TimeProvider.System, (_, _) => Task.FromResult(new[] { IPAddress.Parse(inside) }));
            var outcome = await sender.SendAsync("https://hooks.example.com/in", "secret", Guid.NewGuid(), Guid.NewGuid(), "{}", CancellationToken.None);
            Assert.False(outcome.Delivered, inside);
            Assert.Null(outcome.Status);
        }
        // One public address and one inside: refused whole.
        var mixed = new WebhookSender(strict, TimeProvider.System, (_, _) => Task.FromResult(new[] { IPAddress.Parse("93.184.215.14"), IPAddress.Parse("10.0.0.5") }));
        Assert.Contains("not public", (await mixed.SendAsync("https://hooks.example.com/in", "s", Guid.NewGuid(), Guid.NewGuid(), "{}", CancellationToken.None)).Error);
        Assert.Empty(receiver.Calls);
        // A redirect is an answer, never followed: the second address is never asked.
        receiver.RedirectTo = $"http://127.0.0.1:{port}/inside";
        var tests = new WebhookSender(new WebhookOptions(allowLoopback: true), TimeProvider.System);
        var redirected = await tests.SendAsync(receiver.Url + "/in", "s", Guid.NewGuid(), Guid.NewGuid(), "{}", CancellationToken.None);
        Assert.False(redirected.Delivered);
        Assert.Equal(307, redirected.Status);
        Assert.Equal(new[] { "/in" }, receiver.Calls.Select(c => c.Path));
    }

    [Fact]
    public async Task A_date_reached_runs_its_rule_once_for_each_row_in_the_workspaces_zone()
    {
        var props = AutomationTests.Properties.DeepClone().AsArray();
        props.Add(DatabaseTests.Prop("pWhen001", "date", "When", new JsonObject { ["date"] = new JsonObject { ["includeTime"] = true } }));
        var (ws, database, rule) = await WithRule(new JsonObject { ["kind"] = "date", ["propertyId"] = "pWhen001", ["offsetMinutes"] = -30 }, Set(new { pText001 = "reminded" }), props);
        var now = DateTimeOffset.UtcNow;
        string At(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ");
        var soon = (await DatabaseTests.NewRow(ws, database, "Soon", new { pWhen001 = new { start = At(now.AddMinutes(10)) } })).GetProperty("id").GetGuid();
        var later = (await DatabaseTests.NewRow(ws, database, "Later", new { pWhen001 = new { start = At(now.AddHours(3)) } })).GetProperty("id").GetGuid();
        var long_ago = (await DatabaseTests.NewRow(ws, database, "Long ago", new { pWhen001 = new { start = At(now.AddHours(-5)) } })).GetProperty("id").GetGuid();
        // The rule was switched on an hour ago: what came due since then runs, nothing before.
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.Automations.Where(a => a.Id == rule).ExecuteUpdateAsync(s => s.SetProperty(a => a.ScannedUntil, now.AddHours(-1))));
        Kit.Job<AutomationJob>(server).TimesNow();
        await Run();
        var runs = await Runs(ws, rule);
        Assert.Equal(new[] { soon }, runs.Select(r => r.RowId!.Value));
        Assert.Equal("reminded", (await RowOf(ws, database, soon)).GetProperty("values").GetProperty("pText001").GetString());
        Kit.Job<AutomationJob>(server).TimesNow();
        await Run();
        Assert.Single(await Runs(ws, rule));
        _ = (later, long_ago);

        // A day with no time is reached at 09:00 in the workspace's zone.
        var zone = AutomationTimes.Zone("Asia/Riyadh");
        Assert.Equal(new DateTimeOffset(2026, 12, 1, 6, 0, 0, TimeSpan.Zero), AutomationTimes.Due("2026-12-01", 0, null, zone));
        Assert.Equal(new DateTimeOffset(2026, 11, 30, 20, 0, 0, TimeSpan.Zero), AutomationTimes.Due("2026-12-01", -600, null, zone));
        Assert.Equal(new DateTimeOffset(2026, 12, 1, 14, 30, 0, TimeSpan.Zero), AutomationTimes.Due("2026-12-01", 0, "17:30", zone));
        // A clock moved forward: the first minute after the gap; moved back: its first.
        var newYork = AutomationTimes.Zone("America/New_York");
        Assert.Equal(new DateTimeOffset(2026, 3, 8, 7, 0, 0, TimeSpan.Zero), AutomationTimes.Due("2026-03-08", 0, "02:30", newYork));
        Assert.Equal(new DateTimeOffset(2026, 11, 1, 5, 30, 0, TimeSpan.Zero), AutomationTimes.Due("2026-11-01", 0, "01:30", newYork));
    }

    [Fact]
    public async Task A_schedule_runs_when_due_and_next_by_the_workspaces_zone()
    {
        var steps = new JsonArray(new JsonObject { ["kind"] = "addRow", ["templateId"] = null, ["values"] = new JsonObject { ["title"] = "Weekly review", ["pDate001"] = new JsonObject { ["dynamic"] = "now" } } });
        var ws = await Ws.Create(server);
        var database = await DatabaseTests.NewDatabase(ws, "Reviews", AutomationTests.Properties.DeepClone().AsArray());
        ((JsonObject)steps[0]!)["databaseId"] = database.ToString();
        await ws.Client.PutAsJsonAsync($"/api/v1/workspaces/{ws.Id}/automations/settings", new { timeZone = "Asia/Riyadh" });
        var rule = Guid.CreateVersion7();
        var trigger = new JsonObject { ["kind"] = "schedule", ["every"] = "week", ["at"] = "09:00", ["weekday"] = 1 };
        Assert.Equal("applied", AutomationTests.Status(await AutomationTests.Save(ws, AutomationTests.Rule(ws, rule, database, trigger, steps))));
        var next = await Kit.InWorker(server, ws.Id, (_, db) => db.Automations.Where(a => a.Id == rule).Select(a => a.NextAt).SingleAsync());
        // A Monday at 09:00 in Riyadh: 06:00 UTC.
        Assert.Equal((DayOfWeek.Monday, 6, 0), (next!.Value.UtcDateTime.DayOfWeek, next.Value.UtcDateTime.Hour, next.Value.UtcDateTime.Minute));
        // It comes: a row added, dated today in the zone; the next one a week on.
        var due = DateTimeOffset.UtcNow.AddMinutes(-1);
        await Kit.InWorker(server, ws.Id, async (_, db) => await db.Automations.Where(a => a.Id == rule).ExecuteUpdateAsync(s => s.SetProperty(a => a.NextAt, due)));
        Kit.Job<AutomationJob>(server).TimesNow();
        await Run();
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal((RunStatuses.Done, (Guid?)null), (run.Status, run.RowId));
        var rows = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/databases/{database}/rows?limit=10")).GetProperty("rows").EnumerateArray().ToList();
        var review = Assert.Single(rows);
        Assert.Equal("Weekly review", review.GetProperty("title").GetString());
        Assert.Equal(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, AutomationTimes.Zone("Asia/Riyadh")).ToString("yyyy-MM-dd"), review.GetProperty("values").GetProperty("pDate001").GetProperty("start").GetString());
        var after = await Kit.InWorker(server, ws.Id, (_, db) => db.Automations.Where(a => a.Id == rule).Select(a => a.NextAt).SingleAsync());
        Assert.True(after > DateTimeOffset.UtcNow);
        Assert.Equal(DayOfWeek.Monday, after!.Value.UtcDateTime.DayOfWeek);
    }

    [Fact]
    public async Task A_button_runs_its_rule_once_per_press_as_its_author()
    {
        var (ws, database, rule) = await WithRule(new JsonObject { ["kind"] = "button", ["propertyId"] = "pBtn0001" }, Set(new { pStat001 = "sDone001", pPers001 = new { dynamic = "actor" } }));
        var editor = await Kit.Join(server, ws, "member");
        var reader = await Kit.Join(server, ws, "member");
        await Kit.Share(ws, database, true, ("user", ws.Account.Id, "full"), ("user", editor.Id, "edit"), ("user", reader.Id, "view"));
        var row = (await DatabaseTests.NewRow(ws, database, "Invoice")).GetProperty("id").GetGuid();
        var press = Guid.CreateVersion7();
        var first = await editor.Client.PostAsJsonAsync($"/api/v1/databases/{database}/rows/{row}/press", new { propertyId = "pBtn0001", pressId = press });
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        Assert.Equal(new[] { "Rule" }, (await Kit.Json(first)).GetProperty("automations").EnumerateArray().Select(a => a.GetString()));
        // Sent again (a lost answer): the same press.
        var again = await editor.Client.PostAsJsonAsync($"/api/v1/databases/{database}/rows/{row}/press", new { propertyId = "pBtn0001", pressId = press });
        Assert.Equal((await Kit.Json(first)).GetProperty("eventId").GetInt64(), (await Kit.Json(again)).GetProperty("eventId").GetInt64());
        // A reader cannot press it.
        Assert.Equal(HttpStatusCode.Forbidden, (await reader.Client.PostAsJsonAsync($"/api/v1/databases/{database}/rows/{row}/press", new { propertyId = "pBtn0001", pressId = Guid.CreateVersion7() })).StatusCode);
        await Run();
        var run = Assert.Single(await Runs(ws, rule));
        Assert.Equal((RunStatuses.Done, editor.Id, ws.Account.Id), (run.Status, run.ActorId!.Value, run.AuthorId));
        var after = await RowOf(ws, database, row);
        Assert.Equal("sDone001", after.GetProperty("values").GetProperty("pStat001").GetString());
        Assert.Equal(editor.Id, after.GetProperty("values").GetProperty("pPers001")[0].GetGuid());
    }

    [Fact]
    public void No_step_reaches_the_erp()
    {
        // The steps are these four, and the rules' and runner's code names nothing of the ERP: the
        // server holds no ERP session or key (ARCHITECTURE.md), so there is nothing one could use.
        Assert.Equal(new[] { "set", "addRow", "notify", "webhook" }, File.ReadAllText(Path.Combine(server.Root, "packages", "workspace", "src", "db", "automations.ts"))
            .Split("export const STEP_KINDS: readonly StepKind[] = [")[1].Split("]")[0].Split(',').Select(s => s.Trim().Trim('\'')).Where(s => s.Length > 0));
        foreach (var file in new[]
        {
            Path.Combine(server.Root, "server", "src", "Cgw.Worker", "Jobs", "AutomationJobs.cs"),
            Path.Combine(server.Root, "server", "src", "Cgw.Worker", "Jobs", "WebhookJobs.cs"),
            Path.Combine(server.Root, "server", "src", "Cgw.Core", "Automations", "AutomationRules.cs"),
            Path.Combine(server.Root, "server", "src", "Cgw.Core", "Automations", "AutomationService.cs"),
        })
        {
            var text = File.ReadAllText(file);
            // Any identifier of the ERP's (ErpLink, ErpSessions, Workbooks.Erp…), or the erp-connect contract.
            Assert.DoesNotMatch(@"\bErp\w*|\berp\w*|erp-connect", text);
        }
    }
}
