using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Mail;
using Cgw.Core.Notifications;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Core;

public static class CoreServices
{
    /// <summary>What both processes need: the database, the tenant scope, blob storage, mail.</summary>
    public static IServiceCollection AddCgwCore(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddScoped<TenantScope>();
        services.AddDbContext<CgwDb>(options =>
        {
            options.UseSqlServer(
                configuration.GetConnectionString("Sql") ?? "Server=(localdb)\\MSSQLLocalDB;Database=cgw_dev;Integrated Security=true;TrustServerCertificate=true",
                sql => sql.CommandTimeout(60));
            options.UseOpenIddict<Guid>();
        });
        services.AddSingleton<BlobStore>();
        services.AddSingleton<Mailer>();
        services.AddSingleton(TimeProvider.System);
        services.AddScoped<Audit>();
        // Phase 8: notification mail's settings, timing and unsubscribe tokens (both processes).
        services.AddSingleton<MailSettingsOptions>();
        services.AddSingleton<MailTokens>();
        return services;
    }

    /// <summary>
    /// The Data Protection key ring both processes share (cookies and Identity tokens in the API; from
    /// Phase 8 the unsubscribe tokens the worker writes into mails and the API reads): application
    /// <c>cgw</c>, the keys in the database, encrypted with the machine's DPAPI when
    /// <c>DataProtection__Dpapi</c> is <c>true</c>.
    /// </summary>
    public static IDataProtectionBuilder AddCgwDataProtection(this IServiceCollection services, IConfiguration configuration, bool persist = true)
    {
        var protection = services.AddDataProtection().SetApplicationName("cgw");
        if (persist) protection.PersistKeysToDbContext<CgwDb>();
        if (configuration["DataProtection:Dpapi"] == "true" && OperatingSystem.IsWindows()) protection.ProtectKeysWithDpapi(protectToLocalMachine: true);
        return protection;
    }
}
