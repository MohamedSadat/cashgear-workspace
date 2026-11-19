using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Previews;
using DnsClient;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Tokens;

namespace Cgw.Api.Identity;

/// <summary>
/// Phase 11 (M11.3): single sign-on's settings from configuration. A provider's addresses are
/// https in Production and may be http elsewhere (the mock provider of the tests and the e2e stack);
/// in Production its hosts must resolve to public addresses only. <c>Sso__DnsBaseUrl</c> (never in
/// Production, ProductionChecks) reads a domain's <c>TXT</c> record from the mock provider's DNS
/// stand-in instead of DNS.
/// </summary>
public sealed record SsoOptions(bool AllowHttp, bool PublicAddressesOnly, string? DnsBaseUrl)
{
    public const string DnsBaseUrlKey = "Sso:DnsBaseUrl";

    public static SsoOptions From(IConfiguration configuration, IHostEnvironment environment)
    {
        var production = environment.IsProduction();
        var dns = configuration[DnsBaseUrlKey] is { Length: > 0 } url && !production ? url.TrimEnd('/') : null;
        return new SsoOptions(!production, production, dns);
    }
}

/// <summary>Domains and addresses as single sign-on keeps and compares them.</summary>
public static class SsoText
{
    /// <summary>The <c>LoginProvider</c> of a workspace's provider in <c>UserLogins</c>.</summary>
    public static string LoginProvider(Guid workspaceId) => "sso:" + workspaceId.ToString("D");

    public const int MaxDomains = 50;

    /// <summary>
    /// A domain as kept: trimmed (and its final dot), an IDN as punycode, lower case, 3 to 253
    /// characters, at least one dot, labels of 1 to 63 letters, digits and hyphens (not at either
    /// end), a top-level label that is not all digits; no wildcard. Null for anything else.
    /// </summary>
    public static string? Domain(string? input)
    {
        if (input is null) return null;
        var text = input.Trim();
        if (text.EndsWith('.')) text = text[..^1];
        if (text.Length is 0 or > 253 || text.Contains('*') || text.Contains('@')) return null;
        string ascii;
        try
        {
            ascii = new IdnMapping { UseStd3AsciiRules = true }.GetAscii(text).ToLowerInvariant();
        }
        catch (ArgumentException)
        {
            return null;
        }
        if (ascii.Length is < 3 or > 253) return null;
        var labels = ascii.Split('.');
        if (labels.Length < 2) return null;
        foreach (var label in labels)
            if (label.Length is 0 or > 63 || label[0] == '-' || label[^1] == '-' || !label.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'))
                return null;
        return labels[^1].All(char.IsAsciiDigit) ? null : ascii;
    }

    /// <summary>The domain of an email address, as kept (<see cref="Domain"/>); null when it has none.</summary>
    public static string? EmailDomain(string? email)
    {
        if (email is null) return null;
        var at = email.LastIndexOf('@');
        return at <= 0 || at == email.Length - 1 ? null : Domain(email[(at + 1)..]);
    }

    /// <summary>An address with its domain as kept (an IDN as punycode), for an account; null when it has none.</summary>
    public static string? Email(string? email)
    {
        if (email is null || EmailDomain(email.Trim()) is not { } domain) return null;
        var trimmed = email.Trim();
        return trimmed[..trimmed.LastIndexOf('@')] + "@" + domain;
    }

    public static string RecordName(string domain) => "_cashgear-workspace." + domain;

    public static string RecordValue(string token) => "cgw-verify=" + token;

    /// <summary>Whether one of a name's <c>TXT</c> records is the domain's: exactly the value, any quotes and spaces around it aside.</summary>
    public static bool HasRecord(IEnumerable<string> records, string token) =>
        records.Any(r => string.Equals(r.Trim().Trim('"').Trim(), RecordValue(token), StringComparison.Ordinal));

    /// <summary>128 random bits, base64url, for a domain's record.</summary>
    public static string NewToken() => Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(16));
}

/// <summary>
/// A provider's client secret, kept as Data Protection's output (purpose <c>Cgw.Sso.ClientSecret.v1</c>,
/// bound to the workspace, so one workspace's cipher opens in no other), opened only for the token
/// exchange, as the AI keys are (<c>AiKeys</c>).
/// </summary>
public sealed class SsoSecrets(IDataProtectionProvider protection)
{
    public const string Purpose = "Cgw.Sso.ClientSecret.v1";

    private IDataProtector For(Guid workspaceId) => protection.CreateProtector(Purpose, workspaceId.ToString("N"));

    public string Protect(Guid workspaceId, string secret) => For(workspaceId).Protect(secret);

    /// <summary>The secret, or null when the cipher no longer opens (a lost key ring, another workspace's).</summary>
    public string? Unprotect(Guid workspaceId, string cipher)
    {
        try
        {
            return For(workspaceId).Unprotect(cipher);
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    /// <summary>A secret as typed: 1 to 500 visible ASCII characters, no spaces.</summary>
    public static bool Plausible(string? secret) => secret is { Length: >= 1 and <= 500 } && secret.All(c => c is > ' ' and < '\u007f');
}

/// <summary>A name's <c>TXT</c> records, each record's strings joined (RFC 7208, 3.3).</summary>
public interface ISsoDns
{
    /// <summary>The records; empty for a name with none. Throws <see cref="SsoDnsException"/> when DNS could not answer.</summary>
    Task<IReadOnlyList<string>> TxtAsync(string name, CancellationToken ct);
}

public sealed class SsoDnsException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>The host's own resolvers, through DnsClient (Apache-2.0), asked afresh each time (no cache).</summary>
public sealed class SystemSsoDns : ISsoDns
{
    private readonly LookupClient client = new(new LookupClientOptions
    {
        UseCache = false,
        Timeout = TimeSpan.FromSeconds(5),
        Retries = 2,
        ThrowDnsErrors = false,
        UseTcpFallback = true,
    });

    public async Task<IReadOnlyList<string>> TxtAsync(string name, CancellationToken ct)
    {
        try
        {
            var answer = await client.QueryAsync(name, QueryType.TXT, QueryClass.IN, ct);
            return answer.HasError ? [] : answer.Answers.TxtRecords().Select(r => string.Concat(r.Text)).ToList();
        }
        catch (DnsResponseException e)
        {
            throw new SsoDnsException("DNS did not answer", e);
        }
    }
}

/// <summary>
/// A developer's machine and the e2e stack (<c>Sso__DnsBaseUrl</c>, refused in Production): the mock
/// provider's DNS stand-in, <c>GET {base}/__mock/dns?name=</c> → <c>{txt: string[]}</c>.
/// </summary>
public sealed class HttpSsoDns(HttpClient http, string baseUrl) : ISsoDns
{
    public async Task<IReadOnlyList<string>> TxtAsync(string name, CancellationToken ct)
    {
        try
        {
            using var response = await http.GetAsync($"{baseUrl}/__mock/dns?name={Uri.EscapeDataString(name)}", ct);
            if (!response.IsSuccessStatusCode) throw new SsoDnsException($"The DNS stand-in answered {(int)response.StatusCode}");
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            return json.RootElement.TryGetProperty("txt", out var txt) && txt.ValueKind == JsonValueKind.Array
                ? txt.EnumerateArray().Where(t => t.ValueKind == JsonValueKind.String).Select(t => t.GetString()!).ToList()
                : [];
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new SsoDnsException("The DNS stand-in did not answer", e);
        }
    }
}

/// <summary>
/// What the server uses of a provider's discovery document (OpenID Connect Discovery 1.0) and its
/// keys. Read by <see cref="SsoMetadata"/>.
/// </summary>
public sealed class SsoDiscovery
{
    public required string Issuer { get; init; }
    public required string AuthorizationEndpoint { get; init; }
    public required string TokenEndpoint { get; init; }
    public required string JwksUri { get; init; }
    /// <summary>As advertised; <c>client_secret_basic</c> alone when the document names none (the specification's default).</summary>
    public required IReadOnlyList<string> TokenAuthMethods { get; init; }
    /// <summary>Whether the provider sends <c>iss</c> back with the code (RFC 9207): then the callback requires it.</summary>
    public bool IssParameterSupported { get; init; }
    public required IReadOnlyList<SecurityKey> SigningKeys { get; init; }
}

public sealed class SsoDiscoveryException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Reads and checks a provider's discovery document, then its keys (<c>jwks_uri</c>).</summary>
internal sealed class SsoDiscoveryRetriever(string issuer, bool allowHttp) : IConfigurationRetriever<SsoDiscovery>
{
    public async Task<SsoDiscovery> GetConfigurationAsync(string address, IDocumentRetriever retriever, CancellationToken cancel)
    {
        var discovery = Read(await retriever.GetDocumentAsync(address, cancel), issuer, allowHttp);
        JsonWebKeySet set;
        try
        {
            set = new JsonWebKeySet(await retriever.GetDocumentAsync(discovery.JwksUri, cancel));
        }
        catch (ArgumentException e)
        {
            throw new SsoDiscoveryException("The provider's keys (jwks_uri) are not a JSON Web Key Set", e);
        }
        var keys = set.GetSigningKeys();
        if (keys.Count == 0) throw new SsoDiscoveryException("The provider publishes no signing key");
        return new SsoDiscovery
        {
            Issuer = discovery.Issuer,
            AuthorizationEndpoint = discovery.AuthorizationEndpoint,
            TokenEndpoint = discovery.TokenEndpoint,
            JwksUri = discovery.JwksUri,
            TokenAuthMethods = discovery.TokenAuthMethods,
            IssParameterSupported = discovery.IssParameterSupported,
            SigningKeys = [.. keys],
        };
    }

    /// <summary>The document, checked: its issuer exactly the one asked for, the endpoints the code flow needs, the code response type.</summary>
    public static SsoDiscovery Read(string json, string issuer, bool allowHttp)
    {
        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(json);
            root = document.RootElement.Clone();
        }
        catch (JsonException e)
        {
            throw new SsoDiscoveryException("The discovery document is not JSON", e);
        }
        if (root.ValueKind != JsonValueKind.Object) throw new SsoDiscoveryException("The discovery document is not a JSON object");
        string? Text(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        List<string>? List(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList()
            : null;
        string Address(string name)
        {
            var value = Text(name) ?? throw new SsoDiscoveryException($"The discovery document has no {name}");
            if (!SsoUrls.Allowed(value, allowHttp, out _)) throw new SsoDiscoveryException($"{name} is not an address the server may use ({(allowHttp ? "http or https" : "https")})");
            return value;
        }
        // OpenID Connect Discovery 1.0, 4.3: the issuer is exactly the one the document was asked for.
        if (!string.Equals(Text("issuer"), issuer, StringComparison.Ordinal))
            throw new SsoDiscoveryException($"The discovery document names the issuer {Text("issuer") ?? "(none)"}, not {issuer}");
        if (List("response_types_supported") is { } types && !types.Contains("code"))
            throw new SsoDiscoveryException("The provider does not offer the authorisation code flow");
        if (List("code_challenge_methods_supported") is { } methods && !methods.Contains("S256"))
            throw new SsoDiscoveryException("The provider does not offer PKCE with S256");
        var auth = List("token_endpoint_auth_methods_supported") ?? ["client_secret_basic"];
        if (!auth.Any(m => m is "client_secret_basic" or "client_secret_post" or "none"))
            throw new SsoDiscoveryException("The provider offers no way for a client to authenticate that the server uses (client_secret_basic, client_secret_post)");
        return new SsoDiscovery
        {
            Issuer = issuer,
            AuthorizationEndpoint = Address("authorization_endpoint"),
            TokenEndpoint = Address("token_endpoint"),
            JwksUri = Address("jwks_uri"),
            TokenAuthMethods = auth,
            IssParameterSupported = root.TryGetProperty("authorization_response_iss_parameter_supported", out var iss) && iss.ValueKind == JsonValueKind.True,
            SigningKeys = [],
        };
    }
}

/// <summary>The addresses a provider may give: absolute, https (http where allowed), no user info, no fragment.</summary>
public static class SsoUrls
{
    public static bool Allowed(string? value, bool allowHttp, out Uri? uri)
    {
        uri = null;
        if (value is null || value.Length > 2000 || !Uri.TryCreate(value, UriKind.Absolute, out var parsed)) return false;
        if (!(parsed.Scheme == Uri.UriSchemeHttps || (allowHttp && parsed.Scheme == Uri.UriSchemeHttp))) return false;
        if (!string.IsNullOrEmpty(parsed.UserInfo) || !string.IsNullOrEmpty(parsed.Fragment) || parsed.Host.Length == 0) return false;
        uri = parsed;
        return true;
    }

    /// <summary>An issuer as an owner may enter it: an allowed address, at most 500 characters, ASCII, no query.</summary>
    public static bool Issuer(string? value, bool allowHttp) =>
        value is { Length: > 0 and <= 500 } && value.All(c => c is > ' ' and < '\u007f') && Allowed(value, allowHttp, out var uri) && string.IsNullOrEmpty(uri!.Query);

    public static string Discovery(string issuer) => issuer.TrimEnd('/') + "/.well-known/openid-configuration";
}

/// <summary>
/// Each issuer's discovery document and keys, through Microsoft.IdentityModel's
/// <see cref="ConfigurationManager{T}"/> (refreshed hourly, and at once, at most every 30 seconds,
/// when a token names a key it does not hold). One HTTP client for discovery, keys and the token
/// exchange: 10 seconds, 1 MB, no redirects, no proxy; in Production public addresses only (the
/// link previews' guard, <see cref="SafeFetcher.Public"/>).
/// </summary>
public sealed class SsoMetadata
{
    private readonly ConcurrentDictionary<string, (ConfigurationManager<SsoDiscovery> Manager, DateTimeOffset MadeAt)> managers = new(StringComparer.Ordinal);
    private readonly SsoOptions options;
    private readonly ILogger<SsoMetadata> log;

    public HttpClient Http { get; }

    public SsoMetadata(SsoOptions options, ILogger<SsoMetadata> log)
    {
        this.options = options;
        this.log = log;
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            UseCookies = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(10),
        };
        if (options.PublicAddressesOnly)
            handler.ConnectCallback = async (context, ct) =>
            {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct);
                if (addresses.Length == 0 || !addresses.All(SafeFetcher.Public)) throw new HttpRequestException("The provider's address is not public");
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(addresses[0], context.DnsEndPoint.Port), ct);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            };
        Http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10), MaxResponseContentBufferSize = 1024 * 1024 };
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("CashGearWorkspace-SignOn/1.0");
    }

    private ConfigurationManager<SsoDiscovery> Make(string issuer) =>
        new(SsoUrls.Discovery(issuer), new SsoDiscoveryRetriever(issuer, options.AllowHttp), new HttpDocumentRetriever(Http) { RequireHttps = !options.AllowHttp })
        {
            AutomaticRefreshInterval = TimeSpan.FromHours(1),
            RefreshInterval = TimeSpan.FromSeconds(30),
        };

    /// <summary>
    /// Read afresh (an owner saving the provider): the new manager replaces any held for the issuer.
    /// The failure says why in words, for the owner.
    /// </summary>
    public async Task<Result<SsoDiscovery>> CheckAsync(string issuer, CancellationToken ct)
    {
        var manager = Make(issuer);
        try
        {
            var discovery = await manager.GetConfigurationAsync(ct);
            managers[issuer] = (manager, DateTimeOffset.UtcNow);
            return discovery;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            var reason = Reason(e);
            log.LogWarning("Single sign-on: the discovery of {Issuer} failed: {Reason}", issuer, reason);
            return new Failure(Codes.SsoDiscoveryFailed, 400, $"The provider's discovery document could not be used: {reason}");
        }
    }

    /// <summary>The issuer's document and keys as held (read on first use); null when they cannot be read.</summary>
    public async Task<SsoDiscovery?> GetAsync(string issuer, CancellationToken ct)
    {
        var (manager, _) = managers.GetOrAdd(issuer, i => (Make(i), DateTimeOffset.UtcNow));
        try
        {
            return await manager.GetConfigurationAsync(ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            log.LogWarning("Single sign-on: the discovery of {Issuer} failed: {Reason}", issuer, Reason(e));
            // The next sign-in tries again.
            managers.TryRemove(issuer, out _);
            return null;
        }
    }

    /// <summary>The keys again, at once, for a token naming one not held (the provider rolled its keys); at most every 30 seconds an issuer.</summary>
    public async Task<SsoDiscovery?> RefreshAsync(string issuer, CancellationToken ct)
    {
        if (managers.TryGetValue(issuer, out var held) && DateTimeOffset.UtcNow - held.MadeAt < TimeSpan.FromSeconds(30)) return null;
        managers.TryRemove(issuer, out _);
        return await GetAsync(issuer, ct);
    }

    /// <summary>The innermost reason we wrote ourselves, else the transport's, without addresses' secrets (there are none in them).</summary>
    private static string Reason(Exception e)
    {
        for (var inner = e; inner is not null; inner = inner.InnerException)
            if (inner is SsoDiscoveryException) return inner.Message;
        for (var inner = e; inner is not null; inner = inner.InnerException)
            if (inner is HttpRequestException or IOException or TaskCanceledException) return "it could not be reached";
        return "it could not be read";
    }
}

/// <summary>
/// Whether a domain requires its workspace's provider (Phase 11): a verified domain with
/// <c>Required</c>, of a workspace not deleted, refuses every other way in for its addresses
/// (password and passkey sign-ins, reset mails, sign-ups), except for that workspace's owners.
/// </summary>
public sealed class SsoPolicy(CgwDb db)
{
    /// <summary>The workspace that requires sign-on for <paramref name="email"/>, unless <paramref name="userId"/> is one of its owners; null when none does.</summary>
    public async Task<Guid?> RequiredForAsync(string? email, Guid? userId, CancellationToken ct = default)
    {
        if (SsoText.EmailDomain(email?.Trim()) is not { } domain) return null;
        var workspace = await db.SsoDomains.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.Domain == domain && d.VerifiedAt != null && d.Required)
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), d => d.WorkspaceId, w => w.Id, (d, _) => (Guid?)d.WorkspaceId)
            .FirstOrDefaultAsync(ct);
        if (workspace is not { } id) return null;
        if (userId is { } user && await db.WorkspaceMembers.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .AnyAsync(m => m.WorkspaceId == id && m.UserId == user && m.Role == Roles.Owner, ct))
            return null;
        return id;
    }
}
