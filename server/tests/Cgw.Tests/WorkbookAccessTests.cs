using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Cgw.Tests;

/// <summary>
/// Workbook access by the pages' rules (DECISIONS.md, 2026-11-14: Phase 5): owners and admins
/// full, members edit, guests nothing unless named; rows by person or for the whole workspace;
/// restricted to the list. Every role against every kind of list on every Workspace route of a
/// workbook; and nothing from another workspace, without a session, or by a share link.
/// </summary>
public sealed class WorkbookAccessTests(ServerFixture server)
{
    private sealed record Setup(string Name, bool Restricted, string? Member, string? Guest, string? Workspace)
    {
        public string Level(string role) => role switch
        {
            "owner" or "admin" => "full",
            "member" => Member ?? Workspace ?? (Restricted ? "none" : "edit"),
            _ => Guest ?? "none",
        };
    }

    private static readonly Setup[] Setups =
    [
        new("plain", false, null, null, null),
        new("named view", false, "view", "view", null),
        new("named full", false, "full", "full", null),
        new("named comment", false, "comment", "comment", null),
        new("restricted", true, null, null, null),
        new("restricted, workspace view", true, null, null, "view"),
        new("workspace none", false, null, "edit", "none"),
    ];

    private static readonly string[] Roles = ["owner", "admin", "member", "guest"];

    private static string Expect(string endpoint, string level) => (endpoint, level) switch
    {
        (_, "none") => "404",
        ("get" or "permissions.get" or "content" or "sheets" or "launch" or "preview.get", _) => "200",
        ("rename" or "preview.put", "view" or "comment") => "403",
        ("rename", _) => "200",
        ("preview.put", _) => "204",
        ("permissions.put", "full") => "200",
        ("permissions.put", _) => "403",
        ("delete", "full") => "204",
        ("delete", _) => "403",
        _ => throw new ArgumentException(endpoint),
    };

    private static string Status(HttpResponseMessage response) => ((int)response.StatusCode).ToString(System.Globalization.CultureInfo.InvariantCulture);

    [Fact]
    public async Task Every_role_and_list_gets_what_the_rules_say_on_every_workbook_route()
    {
        var ws = await Ws.Create(server);
        var people = new Dictionary<string, Account> { ["owner"] = ws.Account };
        foreach (var role in Roles.Skip(1)) people[role] = await Kit.Join(server, ws, role);
        var hash = new string('d', 64);
        var failures = new List<string>();

        foreach (var setup in Setups)
        {
            var entries = new List<(string, Guid, string)>();
            if (setup.Member is { } m) entries.Add(("user", people["member"].Id, m));
            if (setup.Guest is { } g) entries.Add(("user", people["guest"].Id, g));
            if (setup.Workspace is { } w) entries.Add(("workspace", ws.Id, w));
            async Task<Guid> Book(string title)
            {
                var id = await Books.WithVersion(server, ws, $"{setup.Name}: {title}");
                var shared = await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{id}/permissions", Kit.Entries(setup.Restricted, [.. entries]));
                Assert.True(shared.IsSuccessStatusCode, await shared.Content.ReadAsStringAsync());
                return id;
            }
            var book = await Book("book");
            var version = (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workbooks/{book}")).GetProperty("versionId").GetString()!;
            await PutPicture(ws.Client, book, hash, version);
            var deletes = new Dictionary<string, Guid>();
            foreach (var role in Roles) deletes[role] = await Book($"delete by {role}");
            var body = Kit.Entries(setup.Restricted, [.. entries]);

            foreach (var role in Roles)
            {
                var client = people[role].Client;
                var level = setup.Level(role);
                void Check(string endpoint, string actual)
                {
                    var expected = Expect(endpoint, level);
                    if (expected != actual) failures.Add($"[{setup.Name}] {role} ({level}) {endpoint}: expected {expected}, got {actual}");
                }

                var got = await client.GetAsync($"/api/v1/workbooks/{book}");
                Check("get", Status(got));
                if (got.IsSuccessStatusCode && (await Kit.Json(got)).GetProperty("access").GetString() != level)
                    failures.Add($"[{setup.Name}] {role}: access is not {level}");
                var listed = (await client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/workbooks")).GetProperty("workbooks")
                    .EnumerateArray().Any(b => b.GetProperty("id").GetGuid() == book);
                if (listed != (level != "none")) failures.Add($"[{setup.Name}] {role} ({level}): listed is {listed}");
                var permissions = await client.GetAsync($"/api/v1/workbooks/{book}/permissions");
                Check("permissions.get", Status(permissions));
                if (permissions.IsSuccessStatusCode && (await Kit.Json(permissions)).GetProperty("entries").GetArrayLength() != (level == "full" ? entries.Count : 0))
                    failures.Add($"[{setup.Name}] {role} ({level}): entries shown to the wrong people");
                Check("content", Status(await client.GetAsync($"/api/v1/workbooks/{book}/content")));
                Check("sheets", Status(await client.GetAsync($"/api/v1/workbooks/{book}/sheets")));
                Check("launch", Status(await Books.Launch(client, book)));
                Check("preview.get", Status(await client.GetAsync($"/api/v1/workbooks/{book}/previews/{hash}")));
                Check("preview.put", Status(await PutPicture(client, book, hash, version, check: false)));
                var rename = new HttpRequestMessage(HttpMethod.Patch, $"/api/v1/workbooks/{book}") { Content = JsonContent.Create(new { name = $"{setup.Name}: book by {role}" }) };
                Check("rename", Status(await client.SendAsync(rename)));
                Check("permissions.put", Status(await client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", body)));
                Check("delete", Status(await client.DeleteAsync($"/api/v1/workbooks/{deletes[role]}")));
            }
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    private static async Task<HttpResponseMessage> PutPicture(HttpClient client, Guid book, string hash, string version, bool check = true)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/workbooks/{book}/previews/{hash}") { Content = new ByteArrayContent(Books.Png()) };
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse("image/png");
        request.Headers.Add("X-Workbook-Version", version);
        var response = await client.SendAsync(request);
        if (check) Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        return response;
    }

    [Fact]
    public async Task A_workbook_is_never_reachable_from_another_workspace_without_a_session_or_by_a_share_link()
    {
        var ws = await Ws.Create(server);
        var book = await Books.WithVersion(server, ws, "Ours");
        var outsider = await server.NewAccount();
        var theirs = await Ws.Create(server, outsider);
        var page = (await ws.NewPage("Page with the book")).GetProperty("id").GetGuid();
        var link = (await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { }))).GetProperty("token").GetString()!;
        var reader = server.Anonymous();
        reader.DefaultRequestHeaders.Add("X-Share-Token", link);

        foreach (var path in new[] { "", "/content", "/permissions", "/sheets", "/range", $"/previews/{new string('e', 64)}" })
        {
            var asOutsider = await outsider.Client.GetAsync($"/api/v1/workbooks/{book}{path}");
            Assert.Equal(HttpStatusCode.NotFound, asOutsider.StatusCode);
            Assert.Equal("not.found", await Kit.Code(asOutsider));
            var bySharedLink = await reader.GetAsync($"/api/v1/workbooks/{book}{path}");
            Assert.Equal(HttpStatusCode.Unauthorized, bySharedLink.StatusCode);
            Assert.Equal("auth.required", await Kit.Code(bySharedLink));
        }
        Assert.Equal(HttpStatusCode.NotFound, (await Books.Launch(outsider.Client, book)).StatusCode);
        // Not in the other workspace's list, nor in the list of a workspace the caller is not in.
        Assert.Empty((await outsider.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{theirs.Id}/workbooks")).GetProperty("workbooks").EnumerateArray());
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/workbooks")).StatusCode);
        // A workbook from another workspace cannot be named as an entry's workspace.
        var foreign = await ws.Client.PutAsJsonAsync($"/api/v1/workbooks/{book}/permissions", Kit.Entries(false, ("workspace", theirs.Id, "view")));
        Assert.Equal(HttpStatusCode.BadRequest, foreign.StatusCode);
    }
}
