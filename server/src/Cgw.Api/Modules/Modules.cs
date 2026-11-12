using Cgw.Core;
using Cgw.Core.Assets;
using Cgw.Core.Databases;
using Cgw.Core.Documents;
using Cgw.Core.Exports;
using Cgw.Core.History;
using Cgw.Core.Previews;
using Cgw.Core.Search;
using Cgw.Core.Sharing;
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
        services.AddScoped<SharingService>();
        services.AddScoped<SharedReader>();
        services.AddSingleton<FullText>();
        services.AddScoped<SearchService>();
        services.AddScoped<VersionService>();
        services.AddScoped<ExportService>();
        services.AddScoped<DatabaseOps>();
        services.AddScoped<DatabaseService>();
        services.AddSingleton<DatabaseRowCache>();
        return services;
    }

    public static RouteGroupBuilder MapCgwModules(this RouteGroupBuilder api)
    {
        api.MapWorkspaces();
        api.MapDocs();
        api.MapAssets();
        api.MapSharing();
        api.MapHistory();
        api.MapDatabases();
        return api;
    }
}
