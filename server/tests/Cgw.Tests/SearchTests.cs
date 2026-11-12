using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>M2.7: server search, in Arabic and English, filtered by access at query time.</summary>
public sealed class SearchTests(ServerFixture server)
{
    private async Task<bool> FullTextAsync()
    {
        await using var scope = server.Api.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<FullText>().AvailableAsync(scope.ServiceProvider.GetRequiredService<CgwDb>());
    }

    /// <summary>The derived text the worker would write, put straight in: search reads only these columns.</summary>
    private async Task Text(Guid workspace, Guid page, string text)
    {
        await using var db = server.NewDb(workspace);
        db.PageDocDerived.Add(new PageDocDerived
        {
            PageId = page,
            WorkspaceId = workspace,
            UpToSeq = 1,
            Json = Cgw.Core.Documents.DocService.Gzip("""{"type":"doc","content":[]}"""),
            PlainText = text,
            SearchText = TextNormaliser.Normalise(text),
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync();
    }

    private static async Task<JsonElement> Search(HttpClient client, Guid workspace, string q, int? limit = null, string? cursor = null)
    {
        var url = $"/api/v1/workspaces/{workspace}/search?q={Uri.EscapeDataString(q)}"
            + (limit is null ? "" : $"&limit={limit}") + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
        var response = await client.GetAsync(url);
        var body = await Kit.Json(response);
        Assert.True(response.IsSuccessStatusCode, body.ToString());
        return body;
    }

    private static List<Guid> Ids(JsonElement result) =>
        result.GetProperty("hits").EnumerateArray().Select(h => h.GetProperty("pageId").GetGuid()).ToList();

    /// <summary>Full-text populates its index in its own time; LIKE answers at once.</summary>
    private async Task<JsonElement> Found(HttpClient client, Guid workspace, string q, int count) =>
        await Kit.Eventually(() => Search(client, workspace, q), r => r.GetProperty("hits").GetArrayLength() >= count,
            await FullTextAsync() ? TimeSpan.FromSeconds(60) : TimeSpan.Zero);

    [Fact]
    public async Task Full_text_is_used_where_the_server_has_it()
    {
        var available = await FullTextAsync();
        if (Environment.GetEnvironmentVariable("CGW_TEST_FULLTEXT") == "required")
            Assert.True(available, "CGW_TEST_FULLTEXT=required, but search is not using full-text");
        await using var db = server.NewDb();
        var installed = (await db.Database.SqlQueryRaw<int>("SELECT CAST(FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') AS int) AS Value").ToListAsync()).Single() == 1;
        // The migration makes the index wherever full-text is installed, and search then uses it.
        Assert.Equal(installed, available);
    }

    [Fact]
    public async Task Words_are_found_by_their_start_in_titles_and_text_in_arabic_and_english()
    {
        var ws = await Ws.Create(server);
        var report = (await ws.NewPage("Quarterly Report")).GetProperty("id").GetGuid();
        var arabic = (await ws.NewPage("تقرير المبيعات السنوي")).GetProperty("id").GetGuid();
        var notes = (await ws.NewPage("Notes")).GetProperty("id").GetGuid();
        var mixed = (await ws.NewPage("Meeting")).GetProperty("id").GetGuid();
        await Text(ws.Id, notes, "The sales figures for the year, with a short report.\nNext line.");
        await Text(ws.Id, mixed, "ناقشنا أرقام المبيعات (sales) للربع الثالث.");

        Assert.Equal([report, notes], Ids(await Found(ws.Client, ws.Id, "repo", 2)));
        Assert.Equal([report], Ids(await Search(ws.Client, ws.Id, "QUARTERLY rep")));
        Assert.Equal([arabic], Ids(await Search(ws.Client, ws.Id, "تقري")));
        // Normalised as the clients do (D25): ta marbuta, alef forms and diacritics.
        Assert.Equal([arabic], Ids(await Search(ws.Client, ws.Id, "تَقرير السنوى")));
        Assert.Equal([mixed], Ids(await Found(ws.Client, ws.Id, "الثا", 1)));
        Assert.Equal(new[] { notes, mixed }.Order(), Ids(await Found(ws.Client, ws.Id, "sales", 2)).Order());
        // Every term must start a word somewhere: "ales" starts none.
        Assert.Empty(Ids(await Search(ws.Client, ws.Id, "ales")));
        Assert.Empty(Ids(await Search(ws.Client, ws.Id, "sales nowhere")));
        Assert.Empty(Ids(await Search(ws.Client, ws.Id, "  ...  ")));

        // Titles rank first, and a hit says where it matched.
        var hits = (await Found(ws.Client, ws.Id, "report", 2)).GetProperty("hits").EnumerateArray().ToList();
        Assert.Equal(report, hits[0].GetProperty("pageId").GetGuid());
        Assert.True(hits[0].GetProperty("score").GetDouble() > hits[1].GetProperty("score").GetDouble());
        Assert.Equal("Quarterly Report", hits[0].GetProperty("title").GetString());
        Assert.Contains("short report.", hits[1].GetProperty("snippet").GetString());
    }

    [Fact]
    public async Task Search_returns_only_pages_the_caller_may_read()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var open = (await ws.NewPage("Roadmap open")).GetProperty("id").GetGuid();
        var restricted = (await ws.NewPage("Roadmap restricted")).GetProperty("id").GetGuid();
        await Kit.Share(ws, restricted, true, ("user", guest.Id, "view"));
        var mine = (await ws.NewPage("Roadmap private", section: ws.Personal)).GetProperty("id").GetGuid();
        var binned = (await ws.NewPage("Roadmap binned")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", binned, new { }));
        var gone = (await ws.NewPage("Roadmap deleted")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", gone, new { }));
        await ws.Push(ws.Op("page.delete", gone, new { }));
        var hidden = (await ws.NewPage("Hidden")).GetProperty("id").GetGuid();
        await Kit.Share(ws, hidden, true);
        await Text(ws.Id, hidden, "roadmap in the text of a restricted page");

        Assert.Equal(new[] { open, restricted, mine, hidden }.Order(), Ids(await Found(ws.Client, ws.Id, "roadmap", 4)).Order());
        Assert.Equal([open], Ids(await Search(member.Client, ws.Id, "roadmap")));
        Assert.Equal([restricted], Ids(await Search(guest.Client, ws.Id, "roadmap")));
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/search?q=roadmap")).StatusCode);
    }

    [Fact]
    public async Task Results_page_with_an_opaque_cursor()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var all = new List<Guid>();
        for (var i = 0; i < 7; i++) all.Add((await ws.NewPage($"Invoice {i}", orderKey: "a" + i)).GetProperty("id").GetGuid());
        // Some the member cannot read, between the others: the pages still fill.
        var closed = new List<Guid>();
        for (var i = 0; i < 4; i++)
        {
            var id = (await ws.NewPage($"Invoice closed {i}")).GetProperty("id").GetGuid();
            await Kit.Share(ws, id, true);
            closed.Add(id);
        }
        var seen = new List<Guid>();
        string? cursor = null;
        var pages = 0;
        do
        {
            var result = await Search(member.Client, ws.Id, "invoice", 3, cursor);
            var ids = Ids(result);
            Assert.True(ids.Count <= 3);
            seen.AddRange(ids);
            cursor = result.GetProperty("cursor").ValueKind == JsonValueKind.String ? result.GetProperty("cursor").GetString() : null;
            pages++;
        }
        while (cursor is not null && pages < 10);
        Assert.Null(cursor);
        Assert.Equal(all.Order(), seen.Order());
        Assert.Equal(seen.Count, seen.Distinct().Count());
        Assert.Equal(11, Ids(await Search(ws.Client, ws.Id, "invoice", 50)).Count);

        var bad = await ws.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/search?q=invoice&cursor=not-a-cursor");
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("request.invalid", await Kit.Code(bad));
    }

    [Fact]
    public async Task A_document_edited_through_the_real_path_is_found_by_its_text()
    {
        var ws = await Ws.Create(server);
        var page = await Kit.PageWithText(server, ws, "Greeting");
        var result = await Found(ws.Client, ws.Id, "hello wor", 1);
        var hit = Assert.Single(result.GetProperty("hits").EnumerateArray());
        Assert.Equal(page, hit.GetProperty("pageId").GetGuid());
        Assert.Equal("Hello world", hit.GetProperty("snippet").GetString());
    }
}
