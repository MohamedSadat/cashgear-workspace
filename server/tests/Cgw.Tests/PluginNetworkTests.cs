using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Plugins;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>
/// Phase 13, M13.1 and M13.2 on the server: a plugin's network (the hosts its manifest names, approved
/// by an owner or admin, and the plugins origin's CSP per bundle), and every plugin change in the feed.
/// </summary>
public sealed class PluginNetworkTests(ServerFixture server)
{
    private static string NewType() => "acme.n" + Guid.NewGuid().ToString("N")[..10];

    private static JsonObject Networked(string type, int version, params string[] hosts)
    {
        var manifest = PluginKit.Manifest(type, version);
        manifest["network"] = new JsonObject { ["hosts"] = new JsonArray(hosts.Select(h => (JsonNode)JsonValue.Create(h)!).ToArray()) };
        return manifest;
    }

    private static byte[] Bundle(string type, int version, params string[] hosts) => PluginKit.Bundle(type, version, Networked(type, version, hosts));

    private static async Task<JsonElement> AddApproving(HttpClient client, Guid workspace, byte[] zip, string approve, HttpStatusCode expected)
    {
        var content = new ByteArrayContent(zip);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/zip");
        var response = await client.PostAsync($"/api/v1/workspaces/{workspace}/plugins?approve={Uri.EscapeDataString(approve)}", content);
        Assert.True(response.StatusCode == expected, $"{response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return await Kit.Json(response);
    }

    private static void Network(JsonElement plugin, string[] hosts, string[] approved)
    {
        var (named, allowed) = NetworkOf(plugin);
        Assert.Equal(hosts, named);
        Assert.Equal(approved, allowed);
    }

    private static (string[] Hosts, string[] Approved) NetworkOf(JsonElement plugin)
    {
        var network = plugin.GetProperty("network");
        return (network.GetProperty("hosts").EnumerateArray().Select(h => h.GetString()!).ToArray(),
            network.GetProperty("approved").EnumerateArray().Select(h => h.GetString()!).ToArray());
    }

    private static string ConnectOf(HttpResponseMessage answer)
    {
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var csp = string.Join("", answer.Headers.GetValues("Content-Security-Policy"));
        return csp.Split(';').Select(d => d.Trim()).Single(d => d.StartsWith("connect-src ", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_plugin_reaches_only_the_hosts_approved_and_a_host_an_update_adds_waits_for_approval()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var member = await Kit.Join(server, ws, "member");
        var type = NewType();
        var sites = ServerFixture.PluginClient(server.NewSites(_ => { }));
        async Task<string> Connect(Guid plugin) => ConnectOf(await sites.GetAsync((await PluginKit.FrameUrl(member.Client, ws.Id, plugin)).PathAndQuery));

        // Added by an older build, or without allowing them: named, none approved, no network.
        var added = await PluginKit.AddOk(admin.Client, ws.Id, Bundle(type, 1, "api.example.com", "cdn.example.org:8443", "localhost:4288"));
        var id = added.GetProperty("id").GetGuid();
        Network(added, ["api.example.com", "cdn.example.org:8443", "localhost:4288"], []);
        Assert.Equal("connect-src 'none'", await Connect(id));

        // Approved in Settings: its CSP names exactly those, in the manifest's order, the loopback one by http.
        var patched = await Kit.Json(await admin.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { approvedHosts = new[] { "localhost:4288", "api.example.com" } }));
        Network(patched, ["api.example.com", "cdn.example.org:8443", "localhost:4288"], ["api.example.com", "localhost:4288"]);
        Assert.True(patched.GetProperty("enabled").GetBoolean());
        // The same host the API made the ticket for at once, though this host read the plugin a moment ago.
        Assert.Equal("connect-src https://api.example.com http://localhost:4288", await Connect(id));

        // Only owners and admins approve; only hosts its manifest names; at most 10, none twice.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { approvedHosts = new[] { "api.example.com" } })).StatusCode);
        foreach (var bad in new object[] { new[] { "evil.example.com" }, new[] { "api.example.com", "api.example.com" }, new[] { "API.example.com" } })
        {
            var refused = await admin.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { approvedHosts = bad });
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("request.invalid", await Kit.Code(refused));
        }

        // An update naming a new host: the hosts already approved are kept, the new one waits.
        var updated = await PluginKit.AddOk(ws.Client, ws.Id, Bundle(type, 2, "api.example.com", "new.example.net", "localhost:4288"), HttpStatusCode.OK);
        Network(updated, ["api.example.com", "new.example.net", "localhost:4288"], ["api.example.com", "localhost:4288"]);
        Assert.Equal("connect-src https://api.example.com http://localhost:4288", await Connect(id));
        // Approved with the next upload (the update dialog), or in Settings.
        var again = await AddApproving(admin.Client, ws.Id, Bundle(type, 3, "api.example.com", "new.example.net", "localhost:4288"), "new.example.net", HttpStatusCode.OK);
        Assert.Equal(["api.example.com", "new.example.net", "localhost:4288"], NetworkOf(again).Approved);
        Assert.Equal("connect-src https://api.example.com https://new.example.net http://localhost:4288", await Connect(id));
        // A version that no longer names a host drops its approval.
        var fewer = await PluginKit.AddOk(admin.Client, ws.Id, Bundle(type, 4, "new.example.net"), HttpStatusCode.OK);
        Network(fewer, ["new.example.net"], ["new.example.net"]);
        // Every approval withdrawn: no network again.
        await admin.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { approvedHosts = Array.Empty<string>() });
        Assert.Equal("connect-src 'none'", await Connect(id));

        // A plugin approved when it is added, as the add dialog does; a plugin with no network has no `network`.
        var other = NewType();
        var direct = await AddApproving(admin.Client, ws.Id, Bundle(other, 1, "api.example.com", "two.example.com"), "two.example.com,api.example.com,unnamed.example.com", HttpStatusCode.Created);
        Assert.Equal(["api.example.com", "two.example.com"], NetworkOf(direct).Approved);
        var plain = await PluginKit.AddOk(admin.Client, ws.Id, PluginKit.Bundle(NewType()));
        Assert.False(plain.TryGetProperty("network", out _));
        Assert.Equal("connect-src 'none'", await Connect(plain.GetProperty("id").GetGuid()));

        await using var db = server.NewDb(ws.Id);
        var audits = await db.AuditLog.Where(a => a.Action == "plugin.network" && a.TargetId == id).OrderBy(a => a.CreatedAt).ToListAsync();
        Assert.Equal(2, audits.Count);
        Assert.Contains("\"approved\":[\"api.example.com\",\"localhost:4288\"]", audits[0].Detail, StringComparison.Ordinal);
        Assert.Contains("\"was\":[]", audits[0].Detail, StringComparison.Ordinal);
        var row = await db.WorkspacePlugins.SingleAsync(p => p.Id == id);
        Assert.Equal("[]", row.ApprovedHosts);
        var addAudit = await db.AuditLog.SingleAsync(a => a.Action == "plugin.add" && a.TargetId == direct.GetProperty("id").GetGuid());
        Assert.Contains("\"network\":{\"hosts\":[\"api.example.com\",\"two.example.com\"],\"approved\":[\"api.example.com\",\"two.example.com\"]}", addAudit.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_manifests_hosts_are_exact_names_and_never_cash_gears()
    {
        var ws = await Ws.Create(server);
        async Task Refused(string code, params string[] hosts)
        {
            var problems = await PluginKit.Problems(await PluginKit.Add(ws.Client, ws.Id, Bundle(NewType(), 1, hosts)));
            Assert.Equal([(code, "manifest.json")], problems);
        }
        await Refused("host.reserved", "workspace-api.cashgearerp.com");
        await Refused("host.reserved", "cashgearerp.com");
        await Refused("host.reserved", "pages.cashgearerp.com:8443");
        // This server's own origins (the e2e stack's app and plugins origin): on their own ports only.
        await Refused("host.reserved", "localhost:5291");
        foreach (var bad in new[] { "1.2.3.4", "[::1]", "*.example.com", "API.example.com", "example", "https://api.example.com", "api.example.com/x", "api.example.com:0", "api.example.com:65536", "-a.example.com", "a..example.com", "localhost", "exa mple.com", "" })
            await Refused("manifest.invalid", bad);
        await Refused("manifest.invalid");
        await Refused("manifest.invalid", Enumerable.Range(1, 11).Select(i => $"h{i}.example.com").ToArray());
        await Refused("manifest.invalid", "a.example.com", "a.example.com");
        var hosts = new JsonObject { ["hosts"] = "a.example.com" };
        var manifest = PluginKit.Manifest(NewType());
        manifest["network"] = hosts;
        Assert.Equal([("manifest.invalid", "manifest.json")], await PluginKit.Problems(await PluginKit.Add(ws.Client, ws.Id, PluginKit.Bundle(manifest["type"]!.GetValue<string>(), 1, manifest))));

        // Ten hosts, ports, a null network: taken.
        await PluginKit.AddOk(ws.Client, ws.Id, Bundle(NewType(), 1, Enumerable.Range(1, 10).Select(i => $"h{i}.example.com").ToArray()));
        await PluginKit.AddOk(ws.Client, ws.Id, Bundle(NewType(), 1, "xn--mgbh0fb.example", "a-b.c-d.example.org:443", "127.0.0.1:4288"));
        var none = PluginKit.Manifest(NewType());
        none["network"] = null;
        var added = await PluginKit.AddOk(ws.Client, ws.Id, PluginKit.Bundle(none["type"]!.GetValue<string>(), 1, none));
        Assert.False(added.TryGetProperty("network", out _));
    }

    [Fact]
    public void Hosts_read_as_the_contract_says()
    {
        Assert.True(PluginHosts.Valid("api.example.com"));
        Assert.True(PluginHosts.Valid("a.b.c.example.co.uk:65535"));
        Assert.True(PluginHosts.Valid("localhost:1"));
        Assert.False(PluginHosts.Valid("localhost:0"));
        Assert.False(PluginHosts.Valid("10.0.0.1:80"));
        Assert.False(PluginHosts.Valid("api.example.123"));
        Assert.False(PluginHosts.Valid(new string('a', 64) + ".example.com"));
        Assert.True(PluginHosts.Valid(new string('a', 63) + ".example.com"));
        Assert.True(PluginHosts.Reserved("x.cashgearerp.com"));
        Assert.False(PluginHosts.Reserved("cashgearerp.com.example.com"));
        Assert.False(PluginHosts.Reserved("notcashgearerp.com"));
        Assert.True(PluginHosts.Reserved("app.example.com:8443", ["app.example.com"]));
        Assert.False(PluginHosts.Reserved("localhost:4288", ["localhost:5273"]));
        Assert.True(PluginHosts.Reserved("localhost:5273", ["localhost:5273"]));
        var network = new PluginNetwork(["a.example.com", "localhost:4288", "b.example.com"]);
        Assert.Equal(["a.example.com", "localhost:4288"], PluginHosts.Reached(network, ["localhost:4288", "a.example.com"], production: false));
        Assert.Equal(["a.example.com"], PluginHosts.Reached(network, ["localhost:4288", "a.example.com"], production: true));
        Assert.Equal("https://a.example.com http://localhost:4288", PluginHosts.ConnectSources(["a.example.com", "localhost:4288"]));
        Assert.Equal("'none'", PluginHosts.ConnectSources([]));
    }

    [Fact]
    public async Task Every_add_update_switch_approval_and_removal_is_a_plugin_change_in_the_feed_for_every_member()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        async Task<long> Cursor() => (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/changes?after=0&limit=1000")).GetProperty("cursor").GetInt64();
        async Task<List<(string Type, Guid Id, string Kind, bool Entity)>> Since(Account who, long after)
        {
            var page = await who.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/changes?after={after}&limit=1000");
            return page.GetProperty("changes").EnumerateArray()
                .Select(c => (c.GetProperty("entityType").GetString()!, c.GetProperty("entityId").GetGuid(), c.GetProperty("kind").GetString()!,
                    c.TryGetProperty("entity", out var e) && e.ValueKind != JsonValueKind.Null))
                .ToList();
        }
        var type = NewType();
        var start = await Cursor();
        var id = (await PluginKit.AddOk(ws.Client, ws.Id, Bundle(type, 1, "api.example.com"))).GetProperty("id").GetGuid();
        foreach (var who in new[] { member, guest })
            Assert.Equal([("plugin", id, "upsert", false)], await Since(who, start));

        // Each later write is one more change; the feed keeps the last per plugin, so each is read on its own.
        async Task Writes(Func<Task> write, string kind)
        {
            var before = await Cursor();
            await write();
            Assert.Equal([("plugin", id, kind, false)], await Since(member, before));
        }
        await Writes(async () => await PluginKit.AddOk(ws.Client, ws.Id, Bundle(type, 2, "api.example.com"), HttpStatusCode.OK), "upsert");
        await Writes(async () => (await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { enabled = false })).EnsureSuccessStatusCode(), "upsert");
        await Writes(async () => (await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { enabled = true })).EnsureSuccessStatusCode(), "upsert");
        await Writes(async () => (await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { approvedHosts = new[] { "api.example.com" } })).EnsureSuccessStatusCode(), "upsert");
        await Writes(async () => (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}")).EnsureSuccessStatusCode(), "delete");

        // A write that changes nothing writes no change.
        var quiet = await Cursor();
        var other = (await PluginKit.AddOk(ws.Client, ws.Id, PluginKit.Bundle(NewType()))).GetProperty("id").GetGuid();
        var afterAdd = await Cursor();
        (await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{other}", new { enabled = true })).EnsureSuccessStatusCode();
        Assert.Equal(afterAdd, await Cursor());
        Assert.Equal(quiet + 1, afterAdd);
        // A refused write writes none either.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{other}", new { enabled = false })).StatusCode);
        Assert.Equal(afterAdd, await Cursor());
    }
}
