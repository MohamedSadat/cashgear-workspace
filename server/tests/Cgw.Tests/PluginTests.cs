using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Blob;
using Cgw.Core.Plugins;
using Cgw.Worker.Jobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>Bundles for the plugin tests: zips made here, hostile ones too.</summary>
public static class PluginKit
{
    public static byte[] Zip(params (string Name, byte[] Bytes)[] files)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, bytes) in files)
            {
                var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                using var stream = entry.Open();
                stream.Write(bytes);
            }
        return buffer.ToArray();
    }

    public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    public static JsonObject Manifest(string type, int version = 1) => new()
    {
        ["contract"] = "plugin-frame.1",
        ["type"] = type,
        ["version"] = version,
        ["name"] = new JsonObject { ["en"] = "Counter", ["ar"] = "عداد" },
        ["description"] = new JsonObject { ["en"] = "Counts clicks", ["ar"] = "يعد النقرات" },
        ["reads"] = new JsonObject { ["rows"] = true },
        ["height"] = 320,
        ["keywords"] = new JsonArray("count", "clicks"),
        ["somethingElse"] = "dropped",
    };

    public const string Html = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body><script type=\"module\" src=\"app.js\"></script></body></html>";
    public const string Script = "window.parent.postMessage({ type: 'ready', contracts: ['plugin-frame.1'] }, '*');";

    public static byte[] Bundle(string type, int version = 1, JsonObject? manifest = null, params (string Name, byte[] Bytes)[] more) =>
        Zip([
            ("manifest.json", Utf8((manifest ?? Manifest(type, version)).ToJsonString())),
            ("index.html", Utf8(Html)),
            ("app.js", Utf8(Script + $" // {version}")),
            ("style.css", Utf8("body { margin: 0 }")),
            ("img/logo.svg", Utf8("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")),
            .. more,
        ]);

    public static async Task<HttpResponseMessage> Add(HttpClient client, Guid workspace, byte[] zip)
    {
        var content = new ByteArrayContent(zip);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        return await client.PostAsync($"/api/v1/workspaces/{workspace}/plugins", content);
    }

    public static async Task<JsonElement> AddOk(HttpClient client, Guid workspace, byte[] zip, HttpStatusCode expected = HttpStatusCode.Created)
    {
        var response = await Add(client, workspace, zip);
        Assert.True(response.StatusCode == expected, $"{response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return await Kit.Json(response);
    }

    public static async Task<HttpResponseMessage> Frame(HttpClient client, Guid workspace, Guid plugin) =>
        await client.PostAsync($"/api/v1/workspaces/{workspace}/plugins/{plugin}/frames", null);

    /// <summary>A frame's address, as the API gives it to a member.</summary>
    public static async Task<Uri> FrameUrl(HttpClient client, Guid workspace, Guid plugin)
    {
        var response = await Frame(client, workspace, plugin);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return new Uri((await Kit.Json(response)).GetProperty("url").GetString()!);
    }

    /// <summary>The refusal's codes, and the paths they name.</summary>
    public static async Task<List<(string Code, string? Path)>> Problems(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await Kit.Json(response);
        Assert.Equal("plugin.invalid", body.GetProperty("code").GetString());
        return body.GetProperty("errors").EnumerateArray()
            .Select(e => (e.GetProperty("code").GetString()!, e.TryGetProperty("path", out var p) ? p.GetString() : null)).ToList();
    }
}

/// <summary>
/// Phase 10, third-party plugins on the server (M10.4, M10.5): the routes by role, every refusal of
/// a bundle (a hostile zip: traversal, a bomb, too many files, a reserved type, and the rest), the
/// frame ticket (expired, another workspace's, another bundle's, a plugin removed or turned off),
/// the plugins host's headers and its 404s, the pages host refusing <c>/f/</c>, audit and clean-up.
/// </summary>
public sealed class PluginTests(ServerFixture server)
{
    private static string NewType() => "acme.p" + Guid.NewGuid().ToString("N")[..10];

    [Fact]
    public async Task Owners_and_admins_add_update_turn_off_and_remove_a_plugin_and_every_member_reads_the_list()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var member = await Kit.Join(server, ws, "member");
        var guest = await Kit.Join(server, ws, "guest");
        var type = NewType();
        var zip = PluginKit.Bundle(type);

        foreach (var other in new[] { member, guest })
        {
            var refused = await PluginKit.Add(other.Client, ws.Id, zip);
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("access.denied", await Kit.Code(refused));
        }
        var added = await PluginKit.AddOk(admin.Client, ws.Id, zip);
        var id = added.GetProperty("id").GetGuid();
        Assert.Equal(type, added.GetProperty("type").GetString());
        Assert.Equal(1, added.GetProperty("version").GetInt32());
        Assert.Equal(("Counter", "عداد"), (added.GetProperty("name").GetProperty("en").GetString(), added.GetProperty("name").GetProperty("ar").GetString()));
        Assert.Equal("Counts clicks", added.GetProperty("description").GetProperty("en").GetString());
        Assert.True(added.GetProperty("reads").GetProperty("rows").GetBoolean());
        Assert.Equal(320, added.GetProperty("height").GetInt32());
        Assert.Equal(["count", "clicks"], added.GetProperty("keywords").EnumerateArray().Select(k => k.GetString()));
        Assert.True(added.GetProperty("enabled").GetBoolean());
        Assert.True(added.GetProperty("sizeBytes").GetInt64() > 0);
        Assert.Equal(admin.Id, added.GetProperty("addedBy").GetProperty("id").GetGuid());
        Assert.Equal(["addedAt", "addedBy", "description", "enabled", "height", "id", "keywords", "name", "reads", "sizeBytes", "type", "updatedAt", "version"],
            added.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal));

        foreach (var reader in new[] { ws.Account, admin, member, guest })
        {
            var list = await reader.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/plugins");
            Assert.Equal(id, Assert.Single(list.GetProperty("plugins").EnumerateArray()).GetProperty("id").GetGuid());
        }
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/workspaces/{ws.Id}/plugins")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await PluginKit.Frame(outsider.Client, ws.Id, id)).StatusCode);

        // Any member, a guest too, asks for a frame.
        var frame = await Kit.Json(await PluginKit.Frame(guest.Client, ws.Id, id));
        Assert.StartsWith($"{ServerFixture.PluginsUrl}/f/", frame.GetProperty("url").GetString(), StringComparison.Ordinal);
        Assert.EndsWith("/index.html", frame.GetProperty("url").GetString(), StringComparison.Ordinal);
        Assert.InRange(frame.GetProperty("expiresAt").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddMinutes(9), DateTimeOffset.UtcNow.AddMinutes(11));

        // An update: the same type, a higher version; a lower one is refused; the same one is taken.
        var updated = await PluginKit.AddOk(ws.Client, ws.Id, PluginKit.Bundle(type, 2), HttpStatusCode.OK);
        Assert.Equal((id, 2), (updated.GetProperty("id").GetGuid(), updated.GetProperty("version").GetInt32()));
        var older = await PluginKit.Add(ws.Client, ws.Id, PluginKit.Bundle(type, 1));
        Assert.Equal(HttpStatusCode.BadRequest, older.StatusCode);
        Assert.Equal("plugin.older", await Kit.Code(older));
        Assert.Equal(HttpStatusCode.OK, (await PluginKit.Add(ws.Client, ws.Id, PluginKit.Bundle(type, 2, more: ("extra.txt", PluginKit.Utf8("x"))))).StatusCode);

        // On and off, by owners and admins only.
        foreach (var other in new[] { member, guest })
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await other.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { enabled = false })).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await other.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}")).StatusCode);
        }
        var off = await Kit.Json(await admin.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { enabled = false }));
        Assert.False(off.GetProperty("enabled").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await PluginKit.Frame(member.Client, ws.Id, id)).StatusCode);
        Assert.True((await admin.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { enabled = true })).IsSuccessStatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{Guid.CreateVersion7()}", new { enabled = true })).StatusCode);

        // Removed: gone from the list, no frame; the type may be added again, as a new plugin.
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}")).StatusCode);
        Assert.Empty((await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/plugins")).GetProperty("plugins").EnumerateArray());
        Assert.Equal(HttpStatusCode.NotFound, (await PluginKit.Frame(member.Client, ws.Id, id)).StatusCode);
        var again = await PluginKit.AddOk(ws.Client, ws.Id, PluginKit.Bundle(type, 1));
        Assert.NotEqual(id, again.GetProperty("id").GetGuid());

        await using var db = server.NewDb(ws.Id);
        var audits = await db.AuditLog.Where(a => a.Action.StartsWith("plugin.")).OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).ToListAsync();
        Assert.Equal(["plugin.add", "plugin.update", "plugin.update", "plugin.disable", "plugin.enable", "plugin.remove", "plugin.add"], audits.Select(a => a.Action));
        Assert.All(audits, a => Assert.Contains($"\"type\":\"{type}\"", a.Detail));
        Assert.All(audits, a => Assert.Contains("\"bundleHash\":\"", a.Detail));
        Assert.Equal(admin.Id, audits[0].ActorUserId);
        var removed = await db.WorkspacePlugins.SingleAsync(p => p.Id == id);
        Assert.NotNull(removed.RemovedAt);
        Assert.Equal(ws.Account.Id, removed.RemovedBy);
        Assert.DoesNotContain("somethingElse", removed.Manifest);
    }

    [Fact]
    public async Task Every_hostile_or_broken_bundle_is_refused_with_its_reason()
    {
        var ws = await Ws.Create(server);
        async Task Refused(byte[] zip, string code, string? path = null)
        {
            var problems = await PluginKit.Problems(await PluginKit.Add(ws.Client, ws.Id, zip));
            Assert.True(problems.Any(p => p.Code == code && (path is null || p.Path == path)), $"{code} {path}: {string.Join(", ", problems)}");
        }
        var type = NewType();
        var manifest = PluginKit.Utf8(PluginKit.Manifest(type).ToJsonString());
        (string, byte[]) Good(string name) => (name, PluginKit.Utf8("x"));

        // Names: traversal, absolute, a backslash, a control character, an empty part, repeated (also by case).
        await Refused(PluginKit.Bundle(type, more: ("../evil.js", PluginKit.Utf8("x"))), "file.name", "../evil.js");
        await Refused(PluginKit.Bundle(type, more: ("a/../../evil.js", PluginKit.Utf8("x"))), "file.name");
        await Refused(PluginKit.Bundle(type, more: ("/etc/passwd.txt", PluginKit.Utf8("x"))), "file.name");
        await Refused(PluginKit.Bundle(type, more: ("C:/boot.ini.txt", PluginKit.Utf8("x"))), "file.name");
        await Refused(PluginKit.Bundle(type, more: ("dir\\evil.js", PluginKit.Utf8("x"))), "file.name");
        await Refused(PluginKit.Bundle(type, more: ("bad\u0001name.js", PluginKit.Utf8("x"))), "file.name");
        await Refused(PluginKit.Bundle(type, more: ("a//b.js", PluginKit.Utf8("x"))), "file.name");
        await Refused(PluginKit.Bundle(type, more: ("app.js", PluginKit.Utf8("again"))), "file.name", "app.js");
        await Refused(PluginKit.Bundle(type, more: ("APP.JS", PluginKit.Utf8("again"))), "file.name");
        await Refused(PluginKit.Bundle(type, more: (new string('n', 201) + ".js", PluginKit.Utf8("x"))), "file.name");
        // Types not allowed.
        await Refused(PluginKit.Bundle(type, more: ("tool.exe", PluginKit.Utf8("MZ"))), "file.type", "tool.exe");
        await Refused(PluginKit.Bundle(type, more: ("noextension", PluginKit.Utf8("x"))), "file.type");
        await Refused(PluginKit.Bundle(type, more: ("page.php", PluginKit.Utf8("<?php"))), "file.type");
        // Too many files, too large, a bomb.
        await Refused(PluginKit.Zip([("manifest.json", manifest), ("index.html", PluginKit.Utf8("x")), .. Enumerable.Range(0, 199).Select(i => Good($"f{i}.txt"))]), "bundle.tooLarge");
        await Refused(PluginKit.Bundle(type, more: ("zeros.txt", new byte[3 * 1024 * 1024])), "bundle.tooLarge", "zeros.txt");
        // Over 20 MB unpacked in all, each file within its own limits (a random block repeated: about 60 times).
        var block = new byte[16 * 1024];
        Random.Shared.NextBytes(block);
        var large = Enumerable.Repeat(block, 288).SelectMany(b => b).ToArray();
        await Refused(PluginKit.Zip([("manifest.json", manifest), ("index.html", PluginKit.Utf8("x")), .. Enumerable.Range(0, 5).Select(i => ($"part{i}.png", large))]), "bundle.tooLarge");
        // Not a zip; an archive whose central directory says less than its entry holds.
        await Refused(PluginKit.Utf8("PK not really a zip at all"), "bundle.zip");
        var liar = Liar();
        var lied = await PluginKit.Problems(await PluginKit.Add(ws.Client, ws.Id, liar));
        Assert.Contains(lied, p => p.Code is "bundle.tooLarge" or "bundle.zip");
        // The manifest: missing, not JSON, wrong contract or fields, a reserved type, a missing entry.
        await Refused(PluginKit.Zip(("index.html", PluginKit.Utf8("x"))), "manifest.missing");
        await Refused(PluginKit.Zip(("manifest.json", PluginKit.Utf8("{not json")), ("index.html", PluginKit.Utf8("x"))), "manifest.invalid", "manifest.json");
        await Refused(PluginKit.Zip(("sub/manifest.json", manifest), ("index.html", PluginKit.Utf8("x"))), "manifest.missing");
        JsonObject With(Action<JsonObject> change)
        {
            var m = PluginKit.Manifest(type);
            change(m);
            return m;
        }
        foreach (var bad in new[]
                 {
                     With(m => m["contract"] = "plugin-frame.2"),
                     With(m => m["type"] = "Acme.Counter"),
                     With(m => m["type"] = "counter"),
                     With(m => m["type"] = "acme." + new string('a', 60)),
                     With(m => m["version"] = 0),
                     With(m => m["version"] = 1.5),
                     With(m => m["version"] = "1"),
                     With(m => m["name"] = new JsonObject { ["en"] = "Only English" }),
                     With(m => m["name"] = new JsonObject { ["en"] = new string('n', 81), ["ar"] = "ن" }),
                     With(m => m["name"] = new JsonObject { ["en"] = "  ", ["ar"] = "ن" }),
                     With(m => m["description"] = new JsonObject { ["en"] = new string('d', 301), ["ar"] = "" }),
                     With(m => m["height"] = 47),
                     With(m => m["height"] = 1201),
                     With(m => m["reads"] = new JsonObject { ["rows"] = "yes" }),
                     With(m => m["keywords"] = new JsonArray(Enumerable.Range(0, 11).Select(i => (JsonNode?)JsonValue.Create($"k{i}")).ToArray())),
                     With(m => m["keywords"] = new JsonArray(new string('k', 31))),
                     With(m => m["entry"] = "app.js"),
                     With(m => m["entry"] = "../index.html"),
                 })
            await Refused(PluginKit.Bundle(type, manifest: bad), "manifest.invalid", "manifest.json");
        await Refused(PluginKit.Bundle("cashgear.chart"), "type.reserved");
        await Refused(PluginKit.Bundle("cashgear.anything"), "type.reserved");
        await Refused(PluginKit.Bundle(type, manifest: With(m => m["entry"] = "main.html")), "entry.missing", "main.html");
        await Refused(PluginKit.Bundle(type, manifest: With(m => m["manifestPadding"] = new string(' ', 17 * 1024))), "manifest.invalid");

        // Over 5 MB: 413 before anything is read.
        var huge = new byte[5 * 1024 * 1024 + 1];
        Random.Shared.NextBytes(huge);
        var tooBig = await PluginKit.Add(ws.Client, ws.Id, huge);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooBig.StatusCode);
        Assert.Equal("limit.size", await Kit.Code(tooBig));

        // Nothing was kept of any of them: no row, no blob.
        await using var db = server.NewDb(ws.Id);
        Assert.Empty(await db.WorkspacePlugins.ToListAsync());
        var blob = server.Api.Services.GetRequiredService<BlobStore>();
        Assert.Empty(await blob.ListAsync(BlobStore.WorkspacePrefix(ws.Id) + "plugins/").ToListAsync());

        // A good one, with an entry of its own, a folder entry and a manifest's optional fields left out.
        var minimal = new JsonObject { ["contract"] = "plugin-frame.1", ["type"] = type, ["version"] = 3, ["name"] = new JsonObject { ["en"] = "M", ["ar"] = "م" }, ["entry"] = "app/main.html" };
        var ok = await PluginKit.AddOk(ws.Client, ws.Id, PluginKit.Zip(("manifest.json", PluginKit.Utf8(minimal.ToJsonString())), ("app/", []), ("app/main.html", PluginKit.Utf8("<p>hi</p>"))));
        Assert.Equal((240, false, JsonValueKind.Null), (ok.GetProperty("height").GetInt32(), ok.GetProperty("reads").GetProperty("rows").GetBoolean(), ok.GetProperty("description").ValueKind));
        Assert.EndsWith("/app/main.html", (await Kit.Json(await PluginKit.Frame(ws.Client, ws.Id, ok.GetProperty("id").GetGuid()))).GetProperty("url").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_sites_process_serves_sites_and_plugins_as_a_reader_denied_the_key_rings_table()
    {
        // The installed Sites identity: db_datareader, and SELECT on DataProtectionKeys denied
        // (deploy/iis/install.ps1). Here a user without a login, taken on at every connection.
        await using (var db = server.NewDb())
            await db.Database.ExecuteSqlRawAsync("""
                IF USER_ID(N'cgw_sites_reader') IS NULL CREATE USER [cgw_sites_reader] WITHOUT LOGIN;
                ALTER ROLE db_datareader ADD MEMBER [cgw_sites_reader];
                DENY SELECT ON [dbo].[DataProtectionKeys] TO [cgw_sites_reader];
                """);
        var reader = new SitesReader();
        var factory = server.NewSites(b =>
        {
            b.UseSetting("ConnectionStrings:Sql", server.SqlConnection + ";Pooling=false");
            b.ConfigureTestServices(s => s.ConfigureDbContext<Cgw.Core.Data.CgwDb>(o => o.AddInterceptors(reader)));
        });
        // The process holds no Data Protection at all.
        Assert.Null(factory.Services.GetService<Microsoft.AspNetCore.DataProtection.IDataProtectionProvider>());

        var ws = await Ws.Create(server);
        var page = await Kit.PageWithText(server, ws, "Reader page");
        var slug = $"reader-{Guid.NewGuid():N}"[..20];
        Assert.True((await ws.Client.PutAsJsonAsync($"/api/v1/pages/{page}/site", new { slug, indexing = false, language = "en" })).IsSuccessStatusCode);
        var id = (await PluginKit.AddOk(ws.Client, ws.Id, PluginKit.Bundle(NewType()))).GetProperty("id").GetGuid();
        var url = await PluginKit.FrameUrl(ws.Client, ws.Id, id);

        var site = await ServerFixture.SiteClient(factory).GetAsync($"/{slug}");
        Assert.True(site.StatusCode == HttpStatusCode.OK, await site.Content.ReadAsStringAsync());
        Assert.Contains("Reader page", await site.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.OK, (await ServerFixture.PluginClient(factory).GetAsync(url.PathAndQuery)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ServerFixture.SiteClient(factory).GetAsync("/no-such-site-here")).StatusCode);
        Assert.True(reader.Opened > 0);
        Assert.DoesNotContain(reader.Commands, c => c.Contains("DataProtectionKeys", StringComparison.OrdinalIgnoreCase));

        // And the denial holds: as that user, the key ring cannot be read.
        await using var check = new Microsoft.Data.SqlClient.SqlConnection(server.SqlConnection + ";Pooling=false");
        await check.OpenAsync();
        await using var command = new Microsoft.Data.SqlClient.SqlCommand("EXECUTE AS USER = N'cgw_sites_reader'; SELECT COUNT(*) FROM [dbo].[DataProtectionKeys];", check);
        var denied = await Assert.ThrowsAsync<Microsoft.Data.SqlClient.SqlException>(() => command.ExecuteScalarAsync());
        Assert.Equal(229, denied.Number);
    }

    /// <summary>Every connection of the Sites process taken on as the reader user, and every command recorded.</summary>
    private sealed class SitesReader : Microsoft.EntityFrameworkCore.Diagnostics.DbConnectionInterceptor, Microsoft.EntityFrameworkCore.Diagnostics.IDbCommandInterceptor
    {
        public int Opened;
        public System.Collections.Concurrent.ConcurrentQueue<string> Commands { get; } = new();

        public override async Task ConnectionOpenedAsync(System.Data.Common.DbConnection connection, Microsoft.EntityFrameworkCore.Diagnostics.ConnectionEndEventData eventData, CancellationToken ct = default)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "EXECUTE AS USER = N'cgw_sites_reader';";
            await command.ExecuteNonQueryAsync(ct);
            Interlocked.Increment(ref Opened);
        }

        public override void ConnectionOpened(System.Data.Common.DbConnection connection, Microsoft.EntityFrameworkCore.Diagnostics.ConnectionEndEventData eventData)
        {
            using var command = connection.CreateCommand();
            command.CommandText = "EXECUTE AS USER = N'cgw_sites_reader';";
            command.ExecuteNonQuery();
            Interlocked.Increment(ref Opened);
        }

        public System.Data.Common.DbCommand CommandInitialized(Microsoft.EntityFrameworkCore.Diagnostics.CommandEndEventData eventData, System.Data.Common.DbCommand result)
        {
            Commands.Enqueue(result.CommandText);
            return result;
        }
    }

    /// <summary>A stored entry of 11 bytes whose central directory and local header both say 5.</summary>
    private static byte[] Liar()
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in new[] { ("manifest.json", PluginKit.Manifest(NewType()).ToJsonString()), ("index.html", "hello world") })
            {
                var entry = zip.CreateEntry(name, CompressionLevel.NoCompression);
                using var stream = entry.Open();
                stream.Write(PluginKit.Utf8(text));
            }
        }
        var bytes = buffer.ToArray();
        var name8 = PluginKit.Utf8("index.html");
        for (var i = 0; i + 46 < bytes.Length; i++)
        {
            var central = bytes[i] == 0x50 && bytes[i + 1] == 0x4b && bytes[i + 2] == 0x01 && bytes[i + 3] == 0x02;
            var local = bytes[i] == 0x50 && bytes[i + 1] == 0x4b && bytes[i + 2] == 0x03 && bytes[i + 3] == 0x04;
            if (central && bytes.AsSpan(i + 46, name8.Length).SequenceEqual(name8)) BitConverter.TryWriteBytes(bytes.AsSpan(i + 24, 4), 5);
            if (local && bytes.AsSpan(i + 30, name8.Length).SequenceEqual(name8)) BitConverter.TryWriteBytes(bytes.AsSpan(i + 22, 4), 5);
        }
        return bytes;
    }

    [Fact]
    public async Task The_plugins_host_serves_a_bundle_under_its_ticket_with_a_sandboxing_policy_and_nothing_else()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var type = NewType();
        var id = (await PluginKit.AddOk(ws.Client, ws.Id, PluginKit.Bundle(type))).GetProperty("id").GetGuid();
        var url = await PluginKit.FrameUrl(member.Client, ws.Id, id);
        var ticket = url.AbsolutePath.Split('/')[2];
        var factory = server.NewSites(_ => { });
        var plugins = ServerFixture.PluginClient(factory);

        var entry = await plugins.GetAsync(url.PathAndQuery);
        Assert.Equal(HttpStatusCode.OK, entry.StatusCode);
        Assert.Equal(PluginKit.Html, await entry.Content.ReadAsStringAsync());
        Assert.Equal("text/html", entry.Content.Headers.ContentType?.MediaType);
        var csp = string.Join("", entry.Headers.GetValues("Content-Security-Policy"));
        Assert.Equal("sandbox allow-scripts; default-src 'none'; script-src http://localhost:5291; style-src http://localhost:5291 'unsafe-inline'; "
            + "img-src http://localhost:5291 data: blob:; font-src http://localhost:5291; media-src http://localhost:5291; connect-src 'none'; frame-src 'none'; "
            + "worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors http://localhost:5273 http://tauri.localhost", csp);
        Assert.Equal("nosniff", string.Join("", entry.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal("no-referrer", string.Join("", entry.Headers.GetValues("Referrer-Policy")));
        Assert.True(entry.Headers.CacheControl is { Private: true, MaxAge.TotalSeconds: 600, NoStore: false, Public: false });
        Assert.Equal("*", string.Join("", entry.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.False(entry.Headers.Contains("Set-Cookie"));
        Assert.False(entry.Headers.Contains("X-Frame-Options"));

        // Each file by its own type; a HEAD has the headers alone.
        var script = await plugins.GetAsync($"/f/{ticket}/app.js");
        Assert.Equal("text/javascript", script.Content.Headers.ContentType?.MediaType);
        Assert.StartsWith(PluginKit.Script, await script.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal("text/css", (await plugins.GetAsync($"/f/{ticket}/style.css")).Content.Headers.ContentType?.MediaType);
        Assert.Equal("image/svg+xml", (await plugins.GetAsync($"/f/{ticket}/img/logo.svg")).Content.Headers.ContentType?.MediaType);
        using (var head = new HttpRequestMessage(HttpMethod.Head, $"/f/{ticket}/app.js"))
        {
            var answer = await plugins.SendAsync(head);
            Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
            Assert.Empty(await answer.Content.ReadAsByteArrayAsync());
        }

        // Anything else on the plugins host is the 404 page.
        async Task Missing(HttpClient client, HttpMethod method, string path)
        {
            using var request = new HttpRequestMessage(method, path);
            var answer = await client.SendAsync(request);
            Assert.True(answer.StatusCode == HttpStatusCode.NotFound, $"{method} {path}: {answer.StatusCode}");
            Assert.False(answer.Headers.Contains("Set-Cookie"));
            Assert.Contains("frame-ancestors 'none'", string.Join("", answer.Headers.GetValues("Content-Security-Policy")));
        }
        foreach (var path in new[] { "/", "/health/live", "/robots.txt", "/f/", $"/f/{ticket}", $"/f/{ticket}/", $"/f/{ticket}/missing.js", $"/f/{ticket}/APP.JS", $"/f/x{ticket}/index.html", "/f/not-a-ticket/index.html", $"/f/{ticket[..^4]}/index.html" })
            await Missing(plugins, HttpMethod.Get, path);
        await Missing(plugins, HttpMethod.Post, $"/f/{ticket}/index.html");
        await Missing(plugins, HttpMethod.Put, $"/f/{ticket}/index.html");
        // The pages host never serves /f/.
        var site = ServerFixture.SiteClient(factory);
        await Missing(site, HttpMethod.Get, url.PathAndQuery);
        await Missing(site, HttpMethod.Get, "/f");

        // The ticket is kept only as its hash, for 10 minutes, naming the workspace, the plugin and its bundle.
        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.WorkspacePlugins.SingleAsync(p => p.Id == id);
            var hash = System.Security.Cryptography.SHA256.HashData(Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlDecode(ticket));
            var stored = await db.PluginFrameTickets.SingleAsync(t => t.TokenHash == hash);
            Assert.Equal((id, row.BundleHash, member.Id), (stored.PluginId, stored.BundleHash, stored.CreatedBy));
            Assert.InRange(stored.ExpiresAt - stored.CreatedAt, TimeSpan.FromMinutes(10) - TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(10) + TimeSpan.FromSeconds(1));
            Assert.Empty(await db.PluginFrameTickets.Where(t => t.TokenHash == Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlDecode(ticket)).ToListAsync());
        }

        // Tickets expired, of another workspace, of another bundle, or unknown: refused.
        string Path(string t) => $"/f/{t}/index.html";
        async Task<string> Ticket(Guid workspace, string bundleHash, TimeSpan expiresIn)
        {
            var (token, row) = PluginTickets.New(workspace, id, bundleHash, ws.Account.Id, DateTimeOffset.UtcNow);
            row.ExpiresAt = DateTimeOffset.UtcNow + expiresIn;
            await using var db = server.NewDb(workspace);
            db.PluginFrameTickets.Add(row);
            await db.SaveChangesAsync();
            return token;
        }
        string current;
        await using (var db = server.NewDb(ws.Id))
            current = (await db.WorkspacePlugins.SingleAsync(p => p.Id == id)).BundleHash;
        var plain = ServerFixture.PluginClient(server.NewSites(_ => { }));
        Assert.Equal(HttpStatusCode.OK, (await plain.GetAsync(Path(await Ticket(ws.Id, current, TimeSpan.FromMinutes(1))))).StatusCode);
        await Missing(plain, HttpMethod.Get, Path(await Ticket(ws.Id, current, TimeSpan.FromSeconds(-1))));
        await Missing(plain, HttpMethod.Get, Path(await Ticket(Guid.CreateVersion7(), current, TimeSpan.FromMinutes(1))));
        await Missing(plain, HttpMethod.Get, Path(await Ticket(ws.Id, new string('a', 64), TimeSpan.FromMinutes(1))));
        await Missing(plain, HttpMethod.Get, Path(Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlEncode(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32))));
        // A ticket's expiry holds on a host that saw it before: its 30 s of memory never outlast it.
        var expiring = await Ticket(ws.Id, current, TimeSpan.FromSeconds(2));
        Assert.Equal(HttpStatusCode.OK, (await plain.GetAsync(Path(expiring))).StatusCode);
        await Task.Delay(TimeSpan.FromSeconds(2.5));
        await Missing(plain, HttpMethod.Get, Path(expiring));

        // An update: the old bundle's tickets open nothing (its files are gone), the new one's do.
        Assert.Equal(HttpStatusCode.OK, (await PluginKit.Add(ws.Client, ws.Id, PluginKit.Bundle(type, 2))).StatusCode);
        var fresh = ServerFixture.PluginClient(server.NewSites(_ => { }));
        await Missing(fresh, HttpMethod.Get, url.PathAndQuery);
        var second = await PluginKit.FrameUrl(member.Client, ws.Id, id);
        var hashOfSecond = PluginTickets.HashOf(second.AbsolutePath.Split('/')[2])!;
        Assert.EndsWith("// 2", await (await fresh.GetAsync(second.PathAndQuery.Replace("index.html", "app.js", StringComparison.Ordinal))).Content.ReadAsStringAsync(), StringComparison.Ordinal);
        var blob = server.Api.Services.GetRequiredService<BlobStore>();
        await using (var db = server.NewDb(ws.Id))
        {
            var row = await db.WorkspacePlugins.SingleAsync(p => p.Id == id);
            var held = await blob.ListAsync(PluginService.PluginPrefix(ws.Id, id)).Select(b => b.Name).ToListAsync();
            Assert.NotEmpty(held);
            Assert.All(held, name => Assert.StartsWith(row.BlobPrefix, name, StringComparison.Ordinal));
        }

        // Turned off, then removed: within the host's 30 s, its tickets open nothing.
        var clock = new MovableClock();
        var timed = server.NewSites(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var host = ServerFixture.PluginClient(timed);
        Assert.Equal(HttpStatusCode.OK, (await host.GetAsync(second.PathAndQuery)).StatusCode);
        Assert.True((await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { enabled = false })).IsSuccessStatusCode);
        clock.Advance(TimeSpan.FromSeconds(31));
        await Missing(host, HttpMethod.Get, second.PathAndQuery);
        Assert.True((await ws.Client.PatchAsJsonAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}", new { enabled = true })).IsSuccessStatusCode);
        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(HttpStatusCode.OK, (await host.GetAsync(second.PathAndQuery)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}/plugins/{id}")).StatusCode);
        clock.Advance(TimeSpan.FromSeconds(31));
        await Missing(host, HttpMethod.Get, second.PathAndQuery);

        // A day after its removal, the worker deletes its files; the row stays for the audit. Tickets
        // go a day after they expired.
        Assert.NotEmpty(await blob.ListAsync(PluginService.PluginPrefix(ws.Id, id)).ToListAsync());
        var old = await Ticket(ws.Id, current, TimeSpan.FromDays(-2));
        await using (var db = server.NewDb(ws.Id))
            await db.WorkspacePlugins.Where(p => p.Id == id).ExecuteUpdateAsync(s => s.SetProperty(p => p.RemovedAt, DateTimeOffset.UtcNow.AddDays(-2)));
        await server.RunJob<Phase10CleanupJob>();
        Assert.Empty(await blob.ListAsync(PluginService.PluginPrefix(ws.Id, id)).ToListAsync());
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.NotNull((await db.WorkspacePlugins.SingleAsync(p => p.Id == id)).BlobsDeletedAt);
            var oldHash = PluginTickets.HashOf(old)!;
            Assert.False(await db.PluginFrameTickets.AnyAsync(t => t.TokenHash == oldHash));
            Assert.True(await db.PluginFrameTickets.AnyAsync(t => t.TokenHash == hashOfSecond));
        }
    }
}
