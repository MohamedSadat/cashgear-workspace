using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// M2.6's proofs: the authorisation matrix (role × the page's level, from its rows or its
/// restriction × each endpoint that acts on a page), and the tenant sweep over every route the
/// app maps with a route parameter, so a new route is covered the day it is added.
/// </summary>
public sealed partial class AuthorizationTests(ServerFixture server)
{
    private sealed record Setup(string Name, bool Restricted, string? Member, string? Guest, string? Workspace)
    {
        /// <summary>The level each role should end with (DATA_MODEL.md, Permissions).</summary>
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
        new("rows: view", false, "view", "view", null),
        new("rows: edit", false, "edit", "edit", null),
        new("rows: full", false, "full", "full", null),
        new("restricted", true, null, null, null),
        new("restricted, workspace view", true, null, null, "view"),
    ];

    private static readonly string[] Roles = ["owner", "admin", "member", "guest"];

    private static string Expect(string endpoint, string level, string role) => (endpoint, level) switch
    {
        (_, "none") when endpoint.StartsWith("op:", StringComparison.Ordinal) => "not.found",
        (_, "none") => "404",
        ("pull" or "permissions.get" or "asset.url", _) => "200",
        ("push", "view") => "403",
        ("push", _) => "200",
        ("permissions.put" or "shareLink.create", "full") => "200",
        ("permissions.put" or "shareLink.create", _) => "403",
        ("op:page.update" or "op:page.trash", "view") => "access.denied",
        ("op:page.update" or "op:page.trash", _) => "applied",
        // Guests put pages only under pages shared with them; this move is to the section's top.
        ("op:page.move", "view") => "access.denied",
        ("op:page.move", _) => role == "guest" ? "access.denied" : "applied",
        ("op:page.delete", "full") => "applied",
        ("op:page.delete", _) => "access.denied",
        _ => throw new ArgumentException(endpoint),
    };

    private static string Status(HttpResponseMessage response) => ((int)response.StatusCode).ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static async Task<string> Op(Ws ws, HttpClient client, string type, Guid page, object payload)
    {
        var result = (await ws.Push(client, ws.Op(type, page, payload)))[0];
        return result.GetProperty("status").GetString() == "applied" ? "applied" : result.GetProperty("error").GetProperty("code").GetString()!;
    }

    [Fact]
    public async Task Every_role_and_page_level_gets_what_the_rules_say_on_every_page_endpoint()
    {
        var ws = await Ws.Create(server);
        var people = new Dictionary<string, Account> { ["owner"] = ws.Account };
        foreach (var role in Roles.Skip(1)) people[role] = await Kit.Join(server, ws, role);
        await Kit.Register(ws.Client, ws.Id);
        var failures = new List<string>();

        foreach (var setup in Setups)
        {
            var entries = new List<(string, Guid, string)>();
            if (setup.Member is { } m) entries.Add(("user", people["member"].Id, m));
            if (setup.Guest is { } g) entries.Add(("user", people["guest"].Id, g));
            if (setup.Workspace is { } w) entries.Add(("workspace", ws.Id, w));
            async Task<Guid> Page(string title)
            {
                var id = (await ws.NewPage($"{setup.Name}: {title}")).GetProperty("id").GetGuid();
                if (setup.Restricted || entries.Count > 0) await Kit.Share(ws, id, setup.Restricted, [.. entries]);
                return id;
            }
            var page = await Page("page");
            var asset = await AssetTests.Upload(ws, AssetTests.Png, "image/png");
            await ws.Push(ws.Op("page.update", page, new { coverAssetId = asset }));
            var trash = new Dictionary<string, Guid>();
            var delete = new Dictionary<string, Guid>();
            foreach (var role in Roles)
            {
                trash[role] = await Page($"trash by {role}");
                delete[role] = await Page($"delete by {role}");
                await ws.Push(ws.Op("page.trash", delete[role], new { }));
            }
            await server.RunJob<AssetCheckJob>();
            var body = Kit.Entries(setup.Restricted, [.. entries]);

            foreach (var role in Roles)
            {
                var client = people[role].Client;
                var level = setup.Level(role);
                void Check(string endpoint, string actual)
                {
                    var expected = Expect(endpoint, level, role);
                    if (expected != actual) failures.Add($"[{setup.Name}] {role} ({level}) {endpoint}: expected {expected}, got {actual}");
                }

                var permissions = await client.GetAsync($"/api/v1/pages/{page}/permissions");
                Check("permissions.get", Status(permissions));
                if (permissions.IsSuccessStatusCode && (await Kit.Json(permissions)).GetProperty("yourLevel").GetString() != level)
                    failures.Add($"[{setup.Name}] {role}: yourLevel is not {level}");
                Check("pull", Status(await client.GetAsync($"/api/v1/pages/{page}/doc?after=0")));
                Check("push", Status(await Kit.Push(client, page, Kit.Update("page"))));
                Check("permissions.put", Status(await client.PutAsJsonAsync($"/api/v1/pages/{page}/permissions", body)));
                Check("shareLink.create", Status(await client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { })));
                Check("asset.url", Status(await client.GetAsync($"/api/v1/assets/{asset}/url")));
                Check("op:page.update", await Op(ws, client, "page.update", page, new { title = $"{setup.Name}: renamed by {role}" }));
                Check("op:page.move", await Op(ws, client, "page.move", page, new { sectionId = ws.Shared, parentPageId = (Guid?)null, orderKey = "a" + Roles.ToList().IndexOf(role) + "V" }));
                Check("op:page.trash", await Op(ws, client, "page.trash", trash[role], new { }));
                Check("op:page.delete", await Op(ws, client, "page.delete", delete[role], new { }));
            }
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [GeneratedRegex(@"\{\*?([A-Za-z]+)(?::[^}]*)?\}")]
    private static partial Regex Parameter();

    /// <summary>
    /// Every route with a route parameter, called with ids from a workspace the caller is not in:
    /// 404 for a member of another workspace (as if the id did not exist), 401 for no session.
    /// The share-link reads take no session by design: without a link they are 404 too.
    /// </summary>
    [Fact]
    public async Task Every_route_with_an_id_is_404_to_another_workspace_and_401_without_a_session()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws, "Secret");
        var asset = await AssetTests.Upload(ws, AssetTests.Png, "image/png");
        await server.RunJob<AssetCheckJob>();
        await ws.Push(ws.Op("page.update", page, new { coverAssetId = asset }));
        var link = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { }));
        var version = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { name = "v1" }));
        var export = await Kit.Json(await ws.Client.PostAsync($"/api/v1/workspaces/{ws.Id}/exports", null));
        var invite = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/invites", new { email = "someone@example.test", role = "member" }));
        var me = await ws.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
        var values = new Dictionary<string, string>
        {
            ["workspaceId"] = ws.Id.ToString(),
            ["pageId"] = page.ToString(),
            ["assetId"] = asset.ToString(),
            ["linkId"] = link.GetProperty("id").GetString()!,
            ["versionId"] = version.GetProperty("id").GetString()!,
            ["exportId"] = export.GetProperty("id").GetString()!,
            ["inviteId"] = invite.GetProperty("id").GetString()!,
            ["userId"] = member.Id.ToString(),
            // Devices are the account's own: the owner's device.
            ["id"] = me.GetProperty("deviceId").GetString()!,
            // A token is the credential itself, not an id: a caller who does not hold it sends another.
            ["token"] = "not-the-invitation-token",
        };

        var outsider = await server.NewAccount();
        await Ws.Create(server, outsider);
        var anonymous = server.Anonymous();
        var routes = server.Api.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => e.RoutePattern.Parameters.Count > 0)
            .SelectMany(e => (e.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? ["GET"]).Select(method => (Endpoint: e, Method: method)))
            .ToList();
        Assert.True(routes.Count >= 30, $"Only {routes.Count} routes with an id were found");
        var failures = new List<string>();
        foreach (var (endpoint, method) in routes)
        {
            var template = endpoint.RoutePattern.RawText ?? "";
            var unknown = endpoint.RoutePattern.Parameters.Select(p => p.Name).Where(n => !values.ContainsKey(n)).ToList();
            if (unknown.Count > 0)
            {
                failures.Add($"{method} {template}: teach this test the route parameter {string.Join(", ", unknown)}");
                continue;
            }
            var path = "/" + Parameter().Replace(template, m => values[m.Groups[1].Value]).TrimStart('/');
            path += "?url=https%3A%2F%2Fexample.com%2F&q=secret&after=0";
            var shared = template.Contains("/shared/", StringComparison.Ordinal);
            foreach (var (client, who, expected) in new[] { (outsider.Client, "another workspace's member", HttpStatusCode.NotFound), (anonymous, "no session", shared ? HttpStatusCode.NotFound : HttpStatusCode.Unauthorized) })
            {
                var request = new HttpRequestMessage(new HttpMethod(method), path);
                if (method is not ("GET" or "DELETE" or "HEAD")) request.Content = JsonContent.Create(new { });
                var response = await client.SendAsync(request);
                if (response.StatusCode != expected)
                    failures.Add($"{method} {path} as {who}: expected {(int)expected}, got {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
            }
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));

        // And none of it touched the workspace.
        Assert.Equal("Secret", (await ws.Tree()).GetProperty("pages").EnumerateArray().Single(p => p.GetProperty("id").GetGuid() == page).GetProperty("title").GetString());
        Assert.Contains(member.Id, (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/members")).EnumerateArray().Select(m => m.GetProperty("userId").GetGuid()));
    }
}
