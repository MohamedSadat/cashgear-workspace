using Cgw.Core.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;

namespace Cgw.Api.Identity;

/// <summary>
/// Password reset links last an hour, from a token provider of their own (Identity's documented
/// way to give one kind of token its own lifetime). Confirmation links keep the default provider's
/// 24 hours.
/// </summary>
public sealed class ResetTokenProviderOptions : DataProtectionTokenProviderOptions
{
    public ResetTokenProviderOptions()
    {
        Name = ResetTokenProvider.ProviderName;
        TokenLifespan = TimeSpan.FromHours(1);
    }
}

public sealed class ResetTokenProvider(
    IDataProtectionProvider protection,
    IOptions<ResetTokenProviderOptions> options,
    ILogger<DataProtectorTokenProvider<User>> logger)
    : DataProtectorTokenProvider<User>(protection, options, logger)
{
    public const string ProviderName = "PasswordReset";
}
