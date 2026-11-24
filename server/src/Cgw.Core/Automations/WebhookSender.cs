using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Cgw.Core.Previews;

namespace Cgw.Core.Automations;

/// <summary>What a webhook's call came to: delivered (a 2xx), refused (any other answer), or not reached.</summary>
public sealed record WebhookOutcome(bool Delivered, int? Status, string? Error);

/// <summary>
/// A webhook's call (Phase 15; DECISIONS.md, 2026-11-24): POST only, to https on 443; the name is
/// resolved at every connect and the connection made only to the public address checked (the
/// SSRF guard of link previews, <see cref="SafeFetcher.Public"/>: no loopback, private, link-local,
/// CGNAT, metadata, multicast or reserved address, in IPv4 or IPv6), so neither DNS nor a redirect
/// can lead it inside the host's network; a redirect is an answer like any other, never followed;
/// 10 seconds. Signed: <c>X-Cgw-Signature: v1=&lt;hex HMAC-SHA256(secret, "&lt;timestamp&gt;.&lt;body&gt;")&gt;</c>.
/// In tests only (<see cref="WebhookOptions.AllowLoopback"/>), http to a loopback address.
/// </summary>
public sealed class WebhookSender
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);
    private readonly HttpClient client;
    private readonly WebhookOptions options;
    private readonly TimeProvider clock;

    public WebhookSender(WebhookOptions options, TimeProvider clock) : this(options, clock, null) { }

    /// <summary>With <paramref name="resolve"/> standing for DNS (tests: a name that points inside).</summary>
    public WebhookSender(WebhookOptions options, TimeProvider clock, Func<string, CancellationToken, Task<IPAddress[]>>? resolve)
    {
        this.options = options;
        this.clock = clock;
        resolve ??= Dns.GetHostAddressesAsync;
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            UseCookies = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(1),
            ConnectTimeout = Timeout,
            ConnectCallback = async (context, ct) =>
            {
                var addresses = await resolve(context.DnsEndPoint.Host, ct);
                var allowed = addresses.Where(a => SafeFetcher.Public(a) || (options.AllowLoopback && IPAddress.IsLoopback(a))).ToList();
                // Every address the name has must be public: a name pointing anywhere inside is refused whole.
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
        client.DefaultRequestHeaders.UserAgent.ParseAdd("CashGearWorkspace-Webhook/1.0");
    }

    /// <summary>The signature a receiver checks: HMAC-SHA256 of "<paramref name="timestamp"/>.<paramref name="body"/>" by the secret, as hex.</summary>
    public static string Signature(string secret, string timestamp, string body) =>
        "v1=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{timestamp}.{body}"))).ToLowerInvariant();

    public async Task<WebhookOutcome> SendAsync(string url, string secret, Guid webhookId, Guid deliveryId, string body, CancellationToken ct)
    {
        if (!options.Allowed(url)) return new WebhookOutcome(false, null, "The address is not one a webhook may call");
        var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add("X-Cgw-Webhook", webhookId.ToString());
        request.Headers.Add("X-Cgw-Delivery", deliveryId.ToString());
        request.Headers.Add("X-Cgw-Timestamp", timestamp);
        request.Headers.Add("X-Cgw-Signature", Signature(secret, timestamp, body));
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            var status = (int)response.StatusCode;
            return status is >= 200 and < 300 ? new WebhookOutcome(true, status, null) : new WebhookOutcome(false, status, $"Answered {status}");
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or SocketException)
        {
            if (ct.IsCancellationRequested) throw;
            var message = e is TaskCanceledException ? "No answer in 10 seconds" : e.Message;
            return new WebhookOutcome(false, null, message.Length > 400 ? message[..400] : message);
        }
    }
}
