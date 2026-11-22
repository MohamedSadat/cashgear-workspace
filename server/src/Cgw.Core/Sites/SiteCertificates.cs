using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Sites;

/// <summary>
/// Where a site's certificates come from and go (Phase 14, M14.4; decisions, 2026-11-22):
/// <c>Sites__Acme__Directory</c> (Let's Encrypt's, or its staging's; https in Production),
/// <c>Sites__Acme__AgreeToTerms</c> (<c>true</c>, set by whoever runs the server, who has read the
/// directory's subscriber agreement: never by the code), <c>Sites__Acme__Email</c> (an optional
/// contact), <c>Sites__CertificateStore</c> (a folder, one <c>&lt;host&gt;.pfx</c> a name, which the
/// IIS host's scheduled task <c>deploy/iis/site-bindings.ps1</c> imports and binds by name) and
/// <c>Sites__CertificatePassword</c> (the files' private key password, from the environment only).
/// Without all of them no certificate is made, and Settings says so.
/// </summary>
public sealed record SiteCertificateOptions(Uri? Directory, bool AgreeToTerms, string? Email, string? Store, string? Password)
{
    /// <summary>How often the worker looks for names due (<c>Sites__Acme__IntervalSeconds</c>, 1 to 3,600; a minute by default).</summary>
    public TimeSpan Interval { get; init; } = TimeSpan.FromMinutes(1);

    public const string IntervalKey = "Sites:Acme:IntervalSeconds";
    public const string DirectoryKey = "Sites:Acme:Directory";
    public const string AgreeKey = "Sites:Acme:AgreeToTerms";
    public const string EmailKey = "Sites:Acme:Email";
    public const string StoreKey = "Sites:CertificateStore";
    public const string PasswordKey = "Sites:CertificatePassword";

    /// <summary>The worker's: it makes certificates (everything set, the password too).</summary>
    public bool Configured => Offered && Password is { Length: > 0 };

    /// <summary>The API's: whether this server makes certificates (it is never given the password).</summary>
    public bool Offered => Directory is not null && AgreeToTerms && Store is { Length: > 0 };

    /// <summary>The PFX of a host name in the store.</summary>
    public string FileOf(string host) => Path.Combine(Store!, host + ".pfx");

    // The password must not reach a log through the record's generated ToString.
    public override string ToString() => $"SiteCertificateOptions {{ Directory = {Directory}, Configured = {Configured} }}";

    public static SiteCertificateOptions From(IConfiguration configuration, bool production)
    {
        var directory = Uri.TryCreate(configuration[DirectoryKey]?.Trim(), UriKind.Absolute, out var uri) && (uri.Scheme == "https" || (!production && uri.Scheme == "http")) ? uri : null;
        var email = configuration[EmailKey]?.Trim();
        var store = configuration[StoreKey]?.Trim();
        var password = configuration[PasswordKey];
        var seconds = int.TryParse(configuration[IntervalKey], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var n) && n is >= 1 and <= 3600 ? n : 60;
        return new SiteCertificateOptions(directory, string.Equals(configuration[AgreeKey]?.Trim(), "true", StringComparison.OrdinalIgnoreCase),
            email is { Length: > 0 } ? email : null, store is { Length: > 0 } ? store : null, password is { Length: > 0 } ? password : null)
        {
            Interval = TimeSpan.FromSeconds(seconds),
        };
    }
}
