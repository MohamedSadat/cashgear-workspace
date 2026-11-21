using System.Text.Json.Nodes;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using static Cgw.Tests.DatabaseTests;

namespace Cgw.Tests;

/// <summary>
/// Phase 13, M13.3: a row's property values by meaning. The worker embeds a row's text, number,
/// select, status, date, checkbox, URL and email values and its formulas and rollups, never a
/// person's or anything read from one, and embeds the row again when they change; a question finds
/// the row by a value its text does not hold.
/// </summary>
public sealed class PropertyValueEmbeddingTests(ServerFixture server)
{
    private static JsonObject Formula(string expression) => new() { ["formula"] = new JsonObject { ["expression"] = expression } };

    private static JsonObject Rollup(string relation, string target, string fn) =>
        new() { ["rollup"] = new JsonObject { ["relationPropertyId"] = relation, ["targetPropertyId"] = target, ["fn"] = fn } };

    private async Task<Dictionary<Guid, (string Text, long SchemaVersion)>> ValuesOf(Guid workspace, params Guid[] rows)
    {
        await using var db = server.NewDb(workspace);
        return await EmbeddingValues.ForRowsAsync(db, rows, CancellationToken.None);
    }

    [Fact]
    public async Task A_question_finds_a_row_by_a_property_value_its_text_does_not_hold_and_never_by_a_persons()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var people = await NewDatabase(ws, "People", [Prop("pName001", "text", "Desk"), Prop("pWho0001", "person", "Lead")]);
        var tickets = await NewDatabase(ws, "Tickets", [
            Prop("pCat0001", "select", "Category", new JsonObject { ["options"] = Options(("optR0001", "Refund request"), ("optS0001", "Shipping delay")) }),
            Prop("pStat001", "status", "Stage", new JsonObject { ["options"] = Options(("optO0001", "Open"), ("optC0001", "Closed")) }),
            Prop("pNum0001", "number", "Amount"),
            Prop("pDone001", "checkbox", "Done"),
            Prop("pDue0001", "date", "Due"),
            Prop("pUrl0001", "url", "Link"),
            Prop("pMail001", "email", "Contact"),
            Prop("pNote001", "text", "Note"),
            Prop("pOwn0001", "person", "Owner"),
            Prop("pTags001", "multiSelect", "Tags", new JsonObject { ["options"] = Options(("optV0001", "Vacation")) }),
            Prop("pTel0001", "phone", "Phone"),
            Prop("pFOwn001", "formula", "Owner again", Formula("prop(\"pOwn0001\")")),
            Prop("pFAmt001", "formula", "Doubled", Formula("prop(\"pNum0001\") * 2")),
            Prop("pRelP001", "relation", "Desk", new JsonObject { ["relation"] = new JsonObject { ["databaseId"] = people.ToString(), ["reversePropertyId"] = "pRevT001" } }),
            Prop("pRolD001", "rollup", "Desk name", Rollup("pRelP001", "pName001", "showOriginal")),
            Prop("pRolW001", "rollup", "Desk lead", Rollup("pRelP001", "pWho0001", "showOriginal")),
        ]);
        var desk = (await NewRow(ws, people, "Desk 1", new { pName001 = "Warehouse desk", pWho0001 = new[] { member.Id } })).GetProperty("id").GetGuid();
        // The search's row: a category and a stage (the mock provider is a word count, so a row of
        // many values reads as less of each: the full set is checked by its text, on another row).
        var refund = (await NewRow(ws, tickets, "Ticket 100", new { pCat0001 = "optR0001", pStat001 = "optO0001", pOwn0001 = new[] { member.Id } }, "a2")).GetProperty("id").GetGuid();
        var full = (await NewRow(ws, tickets, "Ticket 101", new
        {
            pCat0001 = "optR0001",
            pStat001 = "optO0001",
            pNum0001 = 42.5,
            pDone001 = true,
            pDue0001 = new { start = "2026-11-21" },
            pUrl0001 = "https://example.com/t/101",
            pMail001 = "desk@example.com",
            pNote001 = "Line one\nline two",
            pOwn0001 = new[] { member.Id },
            pTags001 = new[] { "optV0001" },
            pTel0001 = "+20 100 000 0000",
            pRelP001 = new[] { desk },
        })).GetProperty("id").GetGuid();
        // A row whose only value a question about holidays could match is a multi-select's or a person's.
        var vacation = (await NewRow(ws, tickets, "Ticket 102", new { pTags001 = new[] { "optV0001" }, pOwn0001 = new[] { member.Id } }, "a1")).GetProperty("id").GetGuid();

        // What a row embeds: its values in the database's order, never a person's or read from one.
        var values = await ValuesOf(ws.Id, full, refund, vacation);
        Assert.Equal(string.Join('\n', [
            "Category: Refund request",
            "Stage: Open",
            "Amount: 42.5",
            "Done: true",
            "Due: 2026-11-21",
            "Link: https://example.com/t/101",
            "Contact: desk@example.com",
            "Note: Line one line two",
            "Doubled: 85",
            "Desk name: Warehouse desk",
        ]), values[full].Text);
        Assert.StartsWith("Category: Refund request\nStage: Open\nDone: false", values[refund].Text, StringComparison.Ordinal);
        Assert.StartsWith("Done: false", values[vacation].Text, StringComparison.Ordinal);
        Assert.DoesNotContain("Vacation", values[vacation].Text, StringComparison.Ordinal);
        Assert.DoesNotContain(member.Id.ToString(), values[vacation].Text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(member.Id.ToString(), values[full].Text, StringComparison.OrdinalIgnoreCase);

        // Embedded: a question sharing none of the row's title or text finds it by its category.
        await EmbedKit.TurnOn(ws);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        var hits = await EmbedKit.Hits(member.Client, ws.Id, EmbedKit.RefundQuestion);
        var hit = Assert.Single(hits, h => h.GetProperty("pageId").GetGuid() == refund);
        Assert.Equal("row", hit.GetProperty("kind").GetString());
        Assert.Equal(tickets, hit.GetProperty("databaseId").GetGuid());
        Assert.StartsWith("Category: Refund request Stage: Open", hit.GetProperty("snippet").GetString(), StringComparison.Ordinal);
        // Never by a person's value nor a multi-select's: a question about holidays finds neither row.
        Assert.DoesNotContain(EmbedKit.Ids(await EmbedKit.Hits(member.Client, ws.Id, "When is the vacation leave?")), id => id == vacation || id == refund || id == full);
        var vectors = await EmbedKit.Vectors(server, ws.Id, refund);
        await using (var db = server.NewDb(ws.Id))
        {
            var version = (await db.Databases.SingleAsync(d => d.PageId == tickets)).Version;
            Assert.All(vectors, v => Assert.Equal(version, v.SchemaVersion));
        }

        // A value changed: embedded again, found by its new meaning and no longer by its old.
        await RowUpdate(ws, refund, new { pCat0001 = "optS0001" });
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        Assert.DoesNotContain(refund, EmbedKit.Ids(await EmbedKit.Hits(member.Client, ws.Id, EmbedKit.RefundQuestion)));
        Assert.Contains(refund, EmbedKit.Ids(await EmbedKit.Hits(member.Client, ws.Id, "Where is the courier with my delivery?")));
    }

    [Fact]
    public async Task A_property_renamed_or_a_rollups_result_changed_embeds_the_rows_again()
    {
        var ws = await Ws.Create(server);
        var projects = await NewDatabase(ws, "Projects", [Prop("pKind001", "text", "Kind")]);
        var tasks = await NewDatabase(ws, "Tasks", [
            Prop("pNote001", "text", "Note"),
            Prop("pRel0001", "relation", "Project", new JsonObject { ["relation"] = new JsonObject { ["databaseId"] = projects.ToString(), ["reversePropertyId"] = "pRev0001" } }),
            Prop("pRol0001", "rollup", "Project kind", Rollup("pRel0001", "pKind001", "showOriginal")),
        ]);
        var project = (await NewRow(ws, projects, "P1", new { pKind001 = "budget forecast" })).GetProperty("id").GetGuid();
        var task = (await NewRow(ws, tasks, "T1", new { pNote001 = "plain words", pRel0001 = new[] { project } })).GetProperty("id").GetGuid();
        var key = await EmbedKit.TurnOn(ws);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        var before = await EmbedKit.Vectors(server, ws.Id, task);
        Assert.Contains(task, EmbedKit.Ids(await EmbedKit.Hits(ws.Client, ws.Id, "What is our spending plan?")));
        var calls = (await EmbedKit.Calls(server, key)).Count;

        // Renamed: the database's version rises, its rows' text changes, and they are embedded again.
        await DbUpdate(ws, tasks, [Prop("pNote001", "text", "Remark")]);
        Assert.True(await EmbedKit.Embed(server, ws.Id));
        var renamed = await EmbedKit.Vectors(server, ws.Id, task);
        Assert.True(renamed[0].SchemaVersion > before[0].SchemaVersion);
        Assert.NotEqual(Convert.ToHexString(before[0].TextHash), Convert.ToHexString(renamed[0].TextHash));
        Assert.Contains("Remark: plain words", (await ValuesOf(ws.Id, task))[task].Text, StringComparison.Ordinal);
        Assert.True((await EmbedKit.Calls(server, key)).Count > calls);

        // The related project's kind changed: the rollup's result changes, and the row is embedded again
        // by the next full pass (every 5 minutes; a fresh job's first pass is one).
        await RowUpdate(ws, project, new { pKind001 = "courier delivery" });
        Assert.Contains("Project kind: courier delivery", (await ValuesOf(ws.Id, task))[task].Text, StringComparison.Ordinal);
        await using (var scope = server.Worker.CreateAsyncScope())
        {
            var provider = scope.ServiceProvider;
            var fresh = new EmbedJob(provider.GetRequiredService<IEmbeddingProvider>(), provider.GetRequiredService<EmbeddingKeys>(),
                provider.GetRequiredService<EmbeddingsOptions>(), provider.GetRequiredService<AiSubscriptionOptions>(), TimeProvider.System, NullLogger<EmbedJob>.Instance);
            for (var round = 0; round < 20; round++)
                if (!await Kit.InWorker(server, ws.Id, (_, db) => fresh.PassAsync(db, ws.Id, CancellationToken.None))) break;
        }
        Assert.Contains(task, EmbedKit.Ids(await EmbedKit.Hits(ws.Client, ws.Id, "Where is the shipment?")));
        Assert.DoesNotContain(task, EmbedKit.Ids(await EmbedKit.Hits(ws.Client, ws.Id, "What is our spending plan?")));
    }

    [Fact]
    public async Task Which_properties_a_row_embeds()
    {
        var other = Guid.CreateVersion7();
        var otherSchema = Schema.Parse(other, 1, new JsonArray(
            Prop("title", "title", "Name"),
            Prop("pWho0001", "person", "Who"),
            Prop("pTxt0001", "text", "Text"),
            Prop("pFWho001", "formula", "Who again", Formula("prop(\"pWho0001\")")),
            Prop("pFTxt001", "formula", "Text again", Formula("prop(\"pTxt0001\")")),
            Prop("pRel0002", "relation", "Back", new JsonObject { ["relation"] = new JsonObject { ["databaseId"] = Guid.CreateVersion7().ToString() } }),
            Prop("pFile001", "files", "Files")).ToJsonString());
        var schema = Schema.Parse(Guid.CreateVersion7(), 1, new JsonArray(
            Prop("title", "title", "Name"),
            Prop("pTxt0001", "text", "Text"),
            Prop("pCre0001", "createdBy", "Made by"),
            Prop("pEdi0001", "lastEditedBy", "Edited by"),
            Prop("pCtm0001", "createdTime", "Made"),
            Prop("pMul0001", "multiSelect", "Tags"),
            Prop("pPho0001", "phone", "Phone"),
            Prop("pFil0001", "files", "Files"),
            Prop("pRel0001", "relation", "Other", new JsonObject { ["relation"] = new JsonObject { ["databaseId"] = other.ToString() } }),
            Prop("pRTit001", "rollup", "Their names", Rollup("pRel0001", "title", "showOriginal")),
            Prop("pRCnt001", "rollup", "How many", Rollup("pRel0001", "pTxt0001", "count")),
            Prop("pRWho001", "rollup", "Their people", Rollup("pRel0001", "pWho0001", "count")),
            Prop("pRFWh001", "rollup", "Their people again", Rollup("pRel0001", "pFWho001", "showOriginal")),
            Prop("pRFTx001", "rollup", "Their texts", Rollup("pRel0001", "pFTxt001", "showOriginal")),
            Prop("pRRel001", "rollup", "Their links", Rollup("pRel0001", "pRel0002", "showOriginal")),
            Prop("pRFil001", "rollup", "Their files", Rollup("pRel0001", "pFile001", "showOriginal")),
            Prop("pRGone01", "rollup", "Gone", Rollup("pRel0001", "pMissing", "showOriginal")),
            Prop("pFCre001", "formula", "Maker", Formula("prop(\"pCre0001\")")),
            Prop("pFTxt001", "formula", "Upper", Formula("upper(prop(\"pTxt0001\"))")),
            Prop("pFLoop01", "formula", "Loop", Formula("prop(\"pFLoop02\")")),
            Prop("pFLoop02", "formula", "Loop back", Formula("prop(\"pFLoop01\")")),
            Prop("pTrash01", "text", "Trashed", new JsonObject { ["trashedAt"] = "2026-11-20T00:00:00Z" })).ToJsonString());
        var chosen = await EmbeddingValues.PropertiesAsync(schema, id => Task.FromResult(id == other ? otherSchema : null));
        Assert.Equal(["pTxt0001", "pRTit001", "pRCnt001", "pRFTx001", "pFTxt001"], chosen.Select(p => p.Id));
        Assert.Equal("Name: x", EmbeddingValues.Body("Name: x", "  "));
        Assert.Equal("Name: x\n\nBody", EmbeddingValues.Body("Name: x", "Body"));
        Assert.Equal("Body", EmbeddingValues.Body("", "Body"));
    }
}
