using System.Globalization;
using System.Net;
using System.Text.Json;
using DnsClient;

namespace Cgw.Core.Domains;

/// <summary>Domain names as the server keeps and compares them (Phase 11's single sign-on, Phase 14's sites).</summary>
public static class DomainNames
{
    /// <summary>
    /// A name as kept: trimmed (and its final dot), an IDN as punycode, lower case, 3 to 253
    /// characters, at least one dot, labels of 1 to 63 letters, digits and hyphens (not at either
    /// end), a top-level label that is not all digits; no wildcard, port or address. Null for anything else.
    /// </summary>
    public static string? Ascii(string? input)
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
}

/// <summary>
/// What the server asks of DNS (Phase 11: a name's <c>TXT</c> records, each record's strings joined,
/// RFC 7208 3.3; Phase 14: the addresses a name leads to, its <c>CNAME</c>s followed). The API and the
/// worker use it; a developer's machine and the e2e stack read the mock provider's stand-in.
/// </summary>
public interface IDomainDns
{
    /// <summary>The records; empty for a name with none. Throws <see cref="DomainDnsException"/> when DNS could not answer.</summary>
    Task<IReadOnlyList<string>> TxtAsync(string name, CancellationToken ct);

    /// <summary>Its <c>A</c> and <c>AAAA</c> addresses, through any <c>CNAME</c>s; empty for a name with none.</summary>
    Task<IReadOnlyList<IPAddress>> AddressesAsync(string name, CancellationToken ct);
}

public sealed class DomainDnsException(string message, Exception? inner = null) : Exception(message, inner);

public static class DomainDns
{
    /// <summary><c>Sso__DnsBaseUrl</c> (never in Production): the mock provider's DNS stand-in instead of DNS.</summary>
    public const string BaseUrlKey = "Sso:DnsBaseUrl";

    public static IDomainDns From(string? standIn) =>
        standIn is { Length: > 0 } url ? new HttpDomainDns(new HttpClient { Timeout = TimeSpan.FromSeconds(5) }, url.TrimEnd('/')) : new SystemDomainDns();
}

/// <summary>The host's own resolvers, through DnsClient (Apache-2.0), asked afresh each time (no cache).</summary>
public sealed class SystemDomainDns : IDomainDns
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
            throw new DomainDnsException("DNS did not answer", e);
        }
    }

    public async Task<IReadOnlyList<IPAddress>> AddressesAsync(string name, CancellationToken ct)
    {
        try
        {
            var found = new List<IPAddress>();
            foreach (var type in new[] { QueryType.A, QueryType.AAAA })
            {
                var answer = await client.QueryAsync(name, type, QueryClass.IN, ct);
                if (answer.HasError) continue;
                found.AddRange(answer.Answers.ARecords().Select(r => r.Address));
                found.AddRange(answer.Answers.AaaaRecords().Select(r => r.Address));
            }
            return found.Distinct().ToList();
        }
        catch (DnsResponseException e)
        {
            throw new DomainDnsException("DNS did not answer", e);
        }
    }
}

/// <summary>
/// A developer's machine and the e2e stack (<c>Sso__DnsBaseUrl</c>, refused in Production): the mock
/// provider's DNS stand-in, <c>GET {base}/__mock/dns?name=</c> → <c>{txt: string[], addresses: string[]}</c>.
/// </summary>
public sealed class HttpDomainDns(HttpClient http, string baseUrl) : IDomainDns
{
    private async Task<JsonElement> AskAsync(string name, CancellationToken ct)
    {
        try
        {
            using var response = await http.GetAsync($"{baseUrl}/__mock/dns?name={Uri.EscapeDataString(name)}", ct);
            if (!response.IsSuccessStatusCode) throw new DomainDnsException($"The DNS stand-in answered {(int)response.StatusCode}");
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            return json.RootElement.Clone();
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new DomainDnsException("The DNS stand-in did not answer", e);
        }
    }

    private static List<string> Strings(JsonElement answer, string name) =>
        answer.ValueKind == JsonValueKind.Object && answer.TryGetProperty(name, out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Where(t => t.ValueKind == JsonValueKind.String).Select(t => t.GetString()!).ToList()
            : [];

    public async Task<IReadOnlyList<string>> TxtAsync(string name, CancellationToken ct) => Strings(await AskAsync(name, ct), "txt");

    public async Task<IReadOnlyList<IPAddress>> AddressesAsync(string name, CancellationToken ct) =>
        Strings(await AskAsync(name, ct), "addresses").Select(a => IPAddress.TryParse(a, out var ip) ? ip : null).OfType<IPAddress>().ToList();
}
