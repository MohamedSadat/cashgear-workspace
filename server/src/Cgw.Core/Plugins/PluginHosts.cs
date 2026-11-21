using System.Text.RegularExpressions;

namespace Cgw.Core.Plugins;

/// <summary>What a plugin's manifest says it reaches (Phase 13): exact host names, with a port or not.</summary>
public sealed record PluginNetwork(IReadOnlyList<string> Hosts);

/// <summary>
/// A plugin's network hosts (Phase 13; decisions, 2026-11-21): at most 10 exact host names in its
/// manifest, each lower-case letters, digits and hyphens in two labels or more, with an optional port
/// (1 to 65535), no wildcard, no IP address (its last label is never only digits) and no Cash Gear
/// host (<c>cashgearerp.com</c> or under it). Outside Production also <c>localhost:&lt;port&gt;</c>
/// and <c>127.0.0.1:&lt;port&gt;</c>, the e2e stack's test host, reached over plain http. A host is
/// reached by the plugin only once an owner or admin approved it; the plugins origin's CSP names
/// exactly the hosts both the manifest and the approval hold.
/// </summary>
public static partial class PluginHosts
{
    public const int MaxHosts = 10;
    public const int MaxLength = 253 + 6;
    public const string CashGearDomain = "cashgearerp.com";

    [GeneratedRegex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::(?<port>[1-9][0-9]{0,4}))?$", RegexOptions.CultureInvariant)]
    private static partial Regex HostPattern();

    [GeneratedRegex("^(?:localhost|127\\.0\\.0\\.1):(?<port>[1-9][0-9]{0,4})$", RegexOptions.CultureInvariant)]
    private static partial Regex LoopbackPattern();

    /// <summary>A loopback host with a port (allowed outside Production only).</summary>
    public static bool Loopback(string host) => LoopbackPattern().Match(host) is { Success: true } m && int.Parse(m.Groups["port"].Value) <= 65535;

    /// <summary>Whether a manifest may name it (the shape alone; <see cref="Reserved"/> and Production are checked apart).</summary>
    public static bool Valid(string host)
    {
        if (host.Length is 0 or > MaxLength) return false;
        if (Loopback(host)) return true;
        var match = HostPattern().Match(host);
        if (!match.Success) return false;
        if (match.Groups["port"].Success && int.Parse(match.Groups["port"].Value) > 65535) return false;
        var name = match.Groups["port"].Success ? host[..host.LastIndexOf(':')] : host;
        if (name.Length > 253) return false;
        var last = name[(name.LastIndexOf('.') + 1)..];
        return !last.All(char.IsAsciiDigit);
    }

    /// <summary>A host's name without its port.</summary>
    public static string NameOf(string host) => host.LastIndexOf(':') is var colon and > 0 ? host[..colon] : host;

    /// <summary>
    /// Cash Gear's own: <c>cashgearerp.com</c> and every name under it, and this server's own origins
    /// (<paramref name="own"/>, as authorities: a name, with its port when not the scheme's). A loopback
    /// name is Cash Gear's only on the same port (a developer's machine runs the test host beside them).
    /// </summary>
    public static bool Reserved(string host, IEnumerable<string>? own = null)
    {
        var name = NameOf(host);
        if (name == CashGearDomain || name.EndsWith("." + CashGearDomain, StringComparison.Ordinal)) return true;
        if (own is null) return false;
        var loopback = Loopback(host);
        return own.Any(o => string.Equals(NameOf(o), name, StringComparison.OrdinalIgnoreCase)
            && (!loopback || string.Equals(o, host, StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>
    /// The manifest's <c>network</c>: absent or null is none; else an object whose <c>hosts</c> is 1 to
    /// 10 distinct hosts of the shape above. Null with <paramref name="reserved"/> set when a host is Cash
    /// Gear's (<c>host.reserved</c>); null otherwise for any other fault (<c>manifest.invalid</c>).
    /// </summary>
    public static PluginNetwork? Read(System.Text.Json.Nodes.JsonNode? node, out bool ok, out bool reserved)
    {
        ok = true;
        reserved = false;
        if (node is null) return null;
        ok = false;
        if (node is not System.Text.Json.Nodes.JsonObject network || network["hosts"] is not System.Text.Json.Nodes.JsonArray list) return null;
        if (list.Count is 0 or > MaxHosts) return null;
        var hosts = new List<string>();
        foreach (var item in list)
        {
            if (item is not System.Text.Json.Nodes.JsonValue value || !value.TryGetValue<string>(out var host) || !Valid(host) || hosts.Contains(host)) return null;
            if (Reserved(host))
            {
                reserved = true;
                return null;
            }
            hosts.Add(host);
        }
        ok = true;
        return new PluginNetwork(hosts);
    }

    /// <summary>
    /// The hosts a plugin reaches: those its manifest names that are approved, in the manifest's order;
    /// in Production never a loopback one.
    /// </summary>
    public static IReadOnlyList<string> Reached(PluginNetwork? network, IReadOnlyCollection<string> approved, bool production) =>
        network is null ? [] : network.Hosts.Where(h => approved.Contains(h) && !(production && Loopback(h))).ToList();

    /// <summary>The CSP sources of the hosts reached: <c>https://host</c>, or <c>http://</c> for a loopback one.</summary>
    public static string ConnectSources(IReadOnlyList<string> reached) =>
        reached.Count == 0 ? "'none'" : string.Join(' ', reached.Select(h => (Loopback(h) ? "http://" : "https://") + h));
}
