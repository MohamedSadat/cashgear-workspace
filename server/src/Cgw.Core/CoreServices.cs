using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Mail;
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
        return services;
    }
}
