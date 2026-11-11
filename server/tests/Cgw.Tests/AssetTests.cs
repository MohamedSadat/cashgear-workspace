using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Previews;
using Cgw.Worker.Jobs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Cgw.Tests;

/// <summary>M2.5: assets by signed URL, checked by the worker; link previews behind the SSRF guard.</summary>
public sealed class AssetTests(ServerFixture server)
{
    /// <summary>A 3×2 PNG.</summary>
    public static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEUlEQVR4nGP4z8AARAwM/xkAH/oD/f8rP3QAAAAASUVORK5CYII=");

    private static readonly HttpClient Blob = new();

    public static async Task<Guid> Upload(Ws ws, byte[] bytes, string type, string name = "picture.png", HttpClient? client = null)
    {
        client ??= ws.Client;
        var id = Guid.CreateVersion7();
        var ticketResponse = await client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/assets", new { id, fileName = name, contentType = type, sizeBytes = bytes.Length });
        var ticket = await ticketResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(ticketResponse.IsSuccessStatusCode, ticket.ToString());
        var put = new HttpRequestMessage(HttpMethod.Put, ticket.GetProperty("uploadUrl").GetString()) { Content = new ByteArrayContent(bytes) };
        foreach (var header in ticket.GetProperty("headers").EnumerateObject())
            if (!put.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString()))
                put.Content.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
        Assert.True((await Blob.SendAsync(put)).IsSuccessStatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync($"/api/v1/assets/{id}/complete", null)).StatusCode);
        return id;
    }

    [Fact]
    public async Task An_image_uploads_by_signed_url_is_checked_and_reads_by_a_fresh_one()
    {
        var ws = await Ws.Create(server);
        var id = await Upload(ws, Png, "image/png");
        await server.RunJob<AssetCheckJob>();
        var asset = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/assets/{id}");
        Assert.Equal("ready", asset.GetProperty("status").GetString());
        Assert.Equal(3, asset.GetProperty("width").GetInt32());
        Assert.Equal(2, asset.GetProperty("height").GetInt32());
        var url = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/assets/{id}/url");
        Assert.True(url.GetProperty("inline").GetBoolean());
        var read = await Blob.GetAsync(url.GetProperty("url").GetString());
        Assert.Equal(Png, await read.Content.ReadAsByteArrayAsync());
        Assert.Equal("image/png", read.Content.Headers.ContentType?.MediaType);
        // The blob is unreachable without a signature: the container is private.
        var bare = new UriBuilder(url.GetProperty("url").GetString()!) { Query = "" }.Uri;
        Assert.False((await Blob.GetAsync(bare)).IsSuccessStatusCode);
    }

    [Fact]
    public async Task A_signed_url_stops_working_after_its_lifetime()
    {
        var ws = await Ws.Create(server);
        var id = await Upload(ws, Png, "image/png");
        var store = server.Worker.GetRequiredService<BlobStore>();
        var shortLived = await store.ReadUrlAsync(BlobStore.AssetKey(ws.Id, id), "image/png", lifetime: TimeSpan.FromSeconds(2));
        Assert.True((await Blob.GetAsync(shortLived)).IsSuccessStatusCode);
        await Task.Delay(TimeSpan.FromSeconds(4));
        Assert.Equal(HttpStatusCode.Forbidden, (await Blob.GetAsync(shortLived)).StatusCode);
    }

    [Fact]
    public async Task Files_download_as_attachments_and_types_off_the_list_or_too_big_are_refused()
    {
        var ws = await Ws.Create(server);
        var id = await Upload(ws, "%PDF-1.7 tiny"u8.ToArray(), "application/pdf", "تقرير \"Q3\".pdf");
        await server.RunJob<AssetCheckJob>();
        var url = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/assets/{id}/url");
        Assert.False(url.GetProperty("inline").GetBoolean());
        var read = await Blob.GetAsync(url.GetProperty("url").GetString());
        Assert.Equal("application/octet-stream", read.Content.Headers.ContentType?.MediaType);
        Assert.Equal("attachment", read.Content.Headers.ContentDisposition?.DispositionType);

        var exe = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/assets", new { id = Guid.CreateVersion7(), fileName = "x.exe", contentType = "application/x-msdownload", sizeBytes = 10 });
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, exe.StatusCode);
        Assert.Equal("asset.typeNotAllowed", (await exe.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        var big = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/assets", new { id = Guid.CreateVersion7(), fileName = "big.png", contentType = "image/png", sizeBytes = 26L * 1024 * 1024 });
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
    }

    [Fact]
    public async Task Bytes_that_are_not_their_type_are_quarantined_and_never_served()
    {
        var ws = await Ws.Create(server);
        var id = await Upload(ws, "<script>alert(1)</script>"u8.ToArray(), "image/png");
        await server.RunJob<AssetCheckJob>();
        Assert.Equal("quarantined", (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/assets/{id}")).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.GetAsync($"/api/v1/assets/{id}/url")).StatusCode);
    }

    [Fact]
    public async Task Others_read_an_asset_only_through_a_page_they_can_read()
    {
        var ws = await Ws.Create(server);
        var id = await Upload(ws, Png, "image/png");
        await server.RunJob<AssetCheckJob>();
        var member = await server.NewAccount();
        await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members", new { email = member.Email, role = "member" });
        var outsider = await server.NewAccount();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Client.GetAsync($"/api/v1/assets/{id}/url")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Client.GetAsync($"/api/v1/assets/{id}/url")).StatusCode);
        // A page the member can read shows it (as its cover): now they may.
        var page = await ws.NewPage("Cover");
        await ws.Push(ws.Op("page.update", page.GetProperty("id").GetGuid(), new { coverAssetId = id }));
        Assert.Equal(HttpStatusCode.OK, (await member.Client.GetAsync($"/api/v1/assets/{id}/url")).StatusCode);
        // Someone else's asset id cannot be taken for a ticket.
        var theirs = await Ws.Create(server, outsider);
        var taken = await outsider.Client.PostAsJsonAsync($"/api/v1/workspaces/{theirs.Id}/assets", new { id, fileName = "x.png", contentType = "image/png", sizeBytes = 3 });
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
    }

    [Theory]
    [InlineData("127.0.0.1", false)]
    [InlineData("10.1.2.3", false)]
    [InlineData("172.16.0.1", false)]
    [InlineData("192.168.1.1", false)]
    [InlineData("169.254.169.254", false)]
    [InlineData("100.64.0.1", false)]
    [InlineData("0.0.0.0", false)]
    [InlineData("224.0.0.1", false)]
    [InlineData("::1", false)]
    [InlineData("fe80::1", false)]
    [InlineData("fd00::1", false)]
    [InlineData("::ffff:10.0.0.1", false)]
    [InlineData("64:ff9b::a00:1", false)]
    [InlineData("2002:a00:1::", false)]
    [InlineData("93.184.215.14", true)]
    [InlineData("2606:2800:21f:cb07:6820:80da:af6b:8b2c", true)]
    public void The_ssrf_guard_allows_public_addresses_only(string address, bool allowed) =>
        Assert.Equal(allowed, SafeFetcher.Public(IPAddress.Parse(address)));

    /// <summary>A small HTTP server on loopback: path to (status, headers, body).</summary>
    private sealed class Site : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        public string Base { get; }

        public Site(Func<string, (int Status, string? Type, string? Location, byte[] Body)> handle)
        {
            listener.Start();
            Base = $"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}";
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    TcpClient client;
                    try
                    {
                        client = await listener.AcceptTcpClientAsync();
                    }
                    catch (Exception e) when (e is SocketException or ObjectDisposedException)
                    {
                        return;
                    }
                    _ = Task.Run(async () =>
                    {
                        using var _ = client;
                        var stream = client.GetStream();
                        var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
                        var line = await reader.ReadLineAsync() ?? "";
                        while (!string.IsNullOrEmpty(await reader.ReadLineAsync())) { }
                        var path = line.Split(' ').ElementAtOrDefault(1) ?? "/";
                        var (status, type, location, body) = handle(path);
                        const string crlf = "\r\n";
                        var head = $"HTTP/1.1 {status} X{crlf}Content-Length: {body.Length}{crlf}Connection: close{crlf}"
                            + (type is null ? "" : $"Content-Type: {type}{crlf}")
                            + (location is null ? "" : $"Location: {location}{crlf}") + crlf;
                        await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
                        await stream.WriteAsync(body);
                    });
                }
            });
        }

        public void Dispose() => listener.Stop();
    }

    [Fact]
    public async Task Previews_refuse_private_addresses_even_through_a_redirect()
    {
        using var server_ = new Site(_ => (200, "text/html", null, "<title>Inside</title>"u8.ToArray()));
        var site = server_.Base;
        var ws = await Ws.Create(server);
        // The real configuration: a loopback address is private.
        var preview = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{ws.Id}/link-preview?url={Uri.EscapeDataString(site + "/")}");
        Assert.Equal("unavailable", preview.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, preview.GetProperty("title").ValueKind);
        var fetcher = new SafeFetcher(new ConfigurationBuilder().Build(), new Env("Production"));
        async Task<bool> Refused(string url)
        {
            try
            {
                return await fetcher.GetAsync(new Uri(url), 1024, CancellationToken.None) is null;
            }
            catch (HttpRequestException)
            {
                return true;
            }
        }
        Assert.True(await Refused("http://169.254.169.254/latest/meta-data/"));
        Assert.True(await Refused("http://localhost/"));
        Assert.True(await Refused("http://[::1]/"));
        Assert.True(await Refused("file:///c:/windows/win.ini"));
        Assert.True(await Refused("http://example.com:8080/"));
    }

    [Fact]
    public async Task A_preview_reads_title_description_site_and_image_and_follows_safe_redirects()
    {
        using var server_ = new Site(path => path switch
        {
            "/old" => (302, null, "/article", []),
            "/article" => (200, "text/html; charset=utf-8", null, Encoding.UTF8.GetBytes(
                "<html><head><title>Fallback</title><meta property=\"og:title\" content=\"تقرير الربع &amp; more\">" +
                "<meta property=\"og:description\" content=\"Quarterly numbers\"><meta property=\"og:site_name\" content=\"Example\">" +
                "<meta property=\"og:image\" content=\"/pic.png\"></head><body>x</body></html>")),
            "/pic.png" => (200, "image/png", null, Png),
            _ => (404, null, null, []),
        });
        var site = server_.Base;
        var ws = await Ws.Create(server);
        await using var scope = server.Api.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        db.Scope.Enter(ws.Id);
        var fetcher = new SafeFetcher(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Previews:AllowLoopback"] = "true" }).Build(),
            new Env("Testing"));
        var previews = new LinkPreviews(db, fetcher, scope.ServiceProvider.GetRequiredService<BlobStore>(), TimeProvider.System);
        var member = new Cgw.Core.Member(ws.Id, ws.Account.Id, Roles.Owner);
        var result = await previews.GetAsync(member, site + "/old");
        Assert.True(result.Ok);
        Assert.Equal("ok", result.Value!.Status);
        Assert.Equal("تقرير الربع & more", result.Value.Title);
        Assert.Equal("Quarterly numbers", result.Value.Description);
        Assert.Equal("Example", result.Value.SiteName);
        Assert.NotNull(result.Value.ImageAssetId);
        // The image is a workspace asset like any other, read by signed URL.
        var url = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/assets/{result.Value.ImageAssetId}/url");
        Assert.Equal(Png, await Blob.GetByteArrayAsync(url.GetProperty("url").GetString()));
    }
}

internal sealed class Env(string name) : IHostEnvironment
{
    public string EnvironmentName { get; set; } = name;
    public string ApplicationName { get; set; } = "tests";
    public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
    public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
}

internal static class Extensions
{
    public static T Also<T>(this T value, Action<T> act)
    {
        act(value);
        return value;
    }
}
