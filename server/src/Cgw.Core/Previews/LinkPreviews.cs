using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace Cgw.Core.Previews;

public sealed record LinkPreviewDto(string Url, string Status, string? Title, string? Description, string? SiteName, Guid? ImageAssetId, DateTimeOffset FetchedAt);

/// <summary>
/// The SSRF guard (Q13; ARCHITECTURE.md, Link previews): only http and https on ports 80 and
/// 443; the host is resolved once and the connection goes to that checked address, so DNS cannot
/// change its answer between check and use; loopback, private, link-local, carrier-grade NAT,
/// multicast, reserved and metadata ranges are refused, in IPv4 and IPv6 (and IPv4 inside IPv6);
/// redirects are followed by hand, at most three, each checked again; time and size are capped.
/// </summary>
public sealed class SafeFetcher
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    private readonly HttpClient client;
    private readonly bool allowLoopback;

    public SafeFetcher(IConfiguration configuration, IHostEnvironment environment)
    {
        // Tests point previews at a local server; never in production.
        allowLoopback = configuration["Previews:AllowLoopback"] == "true" && !environment.IsProduction();
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            UseCookies = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(1),
            ConnectTimeout = Timeout,
            ConnectCallback = async (context, ct) =>
            {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct);
                var allowed = addresses.Where(a => Public(a) || (allowLoopback && IPAddress.IsLoopback(a))).ToList();
                if (allowed.Count == 0 || allowed.Count != addresses.Length) throw new HttpRequestException("The address is not public");
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(allowed[0], context.DnsEndPoint.Port), ct);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            },
        };
        client = new HttpClient(handler) { Timeout = Timeout };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("CashGearWorkspace-LinkPreview/1.0");
    }

    /// <summary>Public unicast only.</summary>
    public static bool Public(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)) return false;
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return !(b[0] == 0 || b[0] == 10 || b[0] == 127 || (b[0] == 100 && b[1] >= 64 && b[1] < 128) || (b[0] == 169 && b[1] == 254)
                || (b[0] == 172 && b[1] >= 16 && b[1] < 32) || (b[0] == 192 && b[1] == 168) || (b[0] == 192 && b[1] == 0 && b[2] is 0 or 2)
                || (b[0] == 198 && b[1] is 18 or 19) || (b[0] == 198 && b[1] == 51 && b[2] == 100) || (b[0] == 203 && b[1] == 0 && b[2] == 113)
                || b[0] >= 224);
        }
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var b = address.GetAddressBytes();
            if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast || address.IsIPv6UniqueLocal) return false;
            // 64:ff9b::/96 (NAT64) and 2001:db8::/32 (documentation); 6to4 and Teredo carry IPv4 inside.
            if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) return false;
            if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8) return false;
            if (b[0] == 0x20 && b[1] == 0x02) return false;
            if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x00 && b[3] == 0x00) return false;
            return (b[0] & 0xe0) == 0x20;
        }
        return false;
    }

    public static bool SafeUrl(Uri url) =>
        url.IsAbsoluteUri && url.Scheme is "http" or "https" && url.Port is 80 or 443 && string.IsNullOrEmpty(url.UserInfo) && url.Host.Length > 0;

    /// <summary>The body of a URL, at most <paramref name="maxBytes"/>, following redirects by hand.</summary>
    public async Task<(Uri Url, string ContentType, byte[] Body)?> GetAsync(Uri url, long maxBytes, CancellationToken ct)
    {
        for (var hop = 0; hop <= 3; hop++)
        {
            if (!SafeUrl(url) && !(allowLoopback && url.IsLoopback)) return null;
            using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is { } location)
            {
                url = new Uri(url, location);
                continue;
            }
            if (!response.IsSuccessStatusCode) return null;
            if (response.Content.Headers.ContentLength > maxBytes) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                if (buffer.Length + read > maxBytes) return null;
                buffer.Write(chunk, 0, read);
            }
            return (url, response.Content.Headers.ContentType?.MediaType ?? "", buffer.ToArray());
        }
        return null;
    }
}

/// <summary>Bookmark previews (Q13): fetched once per workspace and URL, kept for a week.</summary>
public sealed partial class LinkPreviews(CgwDb db, SafeFetcher fetcher, BlobStore blob, TimeProvider clock)
{
    public static readonly TimeSpan Fresh = TimeSpan.FromDays(7);
    private const long MaxPage = 1024 * 1024;
    private const long MaxImage = 1024 * 1024;

    public static string Hash(string url) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))).ToLowerInvariant();

    public async Task<Result<LinkPreviewDto>> GetAsync(Member member, string url, CancellationToken ct = default)
    {
        if (url.Length > 2048 || !Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme is not ("http" or "https"))
            return Failure.Invalid("Previews are for http and https links");
        var hash = Hash(url);
        var cached = await db.LinkPreviews.FirstOrDefaultAsync(p => p.UrlHash == hash, ct);
        if (cached is not null && cached.FetchedAt > clock.GetUtcNow() - Fresh) return Dto(cached);

        string? title = null, description = null, site = null;
        Guid? image = null;
        var status = "unavailable";
        try
        {
            var page = await fetcher.GetAsync(parsed, MaxPage, ct);
            if (page is { } got && got.ContentType is "text/html" or "application/xhtml+xml")
            {
                var html = Encoding.UTF8.GetString(got.Body);
                title = Meta(html, "og:title") ?? Title(html);
                description = Meta(html, "og:description") ?? MetaName(html, "description");
                site = Meta(html, "og:site_name") ?? got.Url.Host;
                status = "ok";
                if (Meta(html, "og:image") is { } src && Uri.TryCreate(got.Url, src, out var imageUrl))
                    image = await ImageAsync(member, imageUrl, ct);
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or SocketException)
        {
            status = "unavailable";
        }
        cached ??= db.LinkPreviews.Add(new LinkPreview { WorkspaceId = member.WorkspaceId, UrlHash = hash }).Entity;
        cached.Url = url;
        cached.Status = status;
        cached.Title = Clip(title, 500);
        cached.Description = Clip(description, 1000);
        cached.SiteName = Clip(site, 200);
        cached.ImageAssetId = image;
        cached.FetchedAt = clock.GetUtcNow();
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // Fetched twice at once; either answer is fine.
        }
        return Dto(cached);
    }

    private async Task<Guid?> ImageAsync(Member member, Uri url, CancellationToken ct)
    {
        var got = await fetcher.GetAsync(url, MaxImage, ct);
        if (got is not { } image) return null;
        var type = Assets.AssetSniffer.Sniff(image.Body);
        if (type is null || !Assets.AssetTypes.Images.Contains(type)) return null;
        var (width, height) = Assets.AssetSniffer.Dimensions(type, image.Body);
        var id = Guid.CreateVersion7();
        var key = BlobStore.AssetKey(member.WorkspaceId, id);
        await blob.PutAsync(key, image.Body, type, ct);
        db.Assets.Add(new Asset
        {
            Id = id,
            WorkspaceId = member.WorkspaceId,
            BlobKey = key,
            FileName = "preview",
            ContentType = type,
            SizeBytes = image.Body.Length,
            Status = AssetStatus.Ready,
            Width = width,
            Height = height,
            CreatedBy = member.UserId,
            CreatedAt = clock.GetUtcNow(),
        });
        return id;
    }

    private static LinkPreviewDto Dto(LinkPreview p) => new(p.Url, p.Status, p.Title, p.Description, p.SiteName, p.ImageAssetId, p.FetchedAt);

    private static string? Clip(string? text, int max)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        text = WebUtility.HtmlDecode(Spaces().Replace(text, " ")).Trim();
        return text.Length > max ? text[..max] : text;
    }

    private static string? Meta(string html, string property)
    {
        foreach (Match tag in MetaTag().Matches(html))
        {
            var attrs = tag.Value;
            if (Attr(attrs, "property") == property || Attr(attrs, "name") == property) return Attr(attrs, "content");
        }
        return null;
    }

    private static string? MetaName(string html, string name) => Meta(html, name);

    private static string? Attr(string tag, string name)
    {
        var match = Regex.Match(tag, $@"\b{name}\s*=\s*(""([^""]*)""|'([^']*)')", RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(100));
        return match.Success ? (match.Groups[2].Success ? match.Groups[2].Value : match.Groups[3].Value) : null;
    }

    private static string? Title(string html)
    {
        var match = TitleTag().Match(html);
        return match.Success ? match.Groups[1].Value : null;
    }

    [GeneratedRegex(@"<meta\b[^>]*>", RegexOptions.IgnoreCase, 200)]
    private static partial Regex MetaTag();

    [GeneratedRegex(@"<title[^>]*>([^<]*)</title>", RegexOptions.IgnoreCase, 200)]
    private static partial Regex TitleTag();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();
}
