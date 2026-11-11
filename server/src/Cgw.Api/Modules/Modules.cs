using Cgw.Core;
using Cgw.Core.Assets;
using Cgw.Core.Documents;
using Cgw.Core.Previews;
using Cgw.Core.Sync;
using Cgw.Core.Workspaces;

namespace Cgw.Api.Modules;

/// <summary>The feature modules' routes and services (ARCHITECTURE.md, The backend).</summary>
public static class Modules
{
    public static IServiceCollection AddCgwModules(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddScoped<Access>();
        services.AddScoped<ChangeLog>();
        services.AddScoped<OpsService>();
        services.AddScoped<FeedService>();
        services.AddScoped<WorkspaceService>();
        services.AddScoped<DocService>();
        services.AddScoped<AssetService>();
        services.AddScoped<LinkPreviews>();
        services.AddSingleton<SafeFetcher>();
        return services;
    }

    public static RouteGroupBuilder MapCgwModules(this RouteGroupBuilder api)
    {
        api.MapWorkspaces();
        api.MapDocs();
        api.MapAssets();
        return api;
    }
}
