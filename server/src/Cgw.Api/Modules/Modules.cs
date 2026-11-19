using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.Api.Realtime;
using Cgw.Core.Assets;
using Cgw.Core.Comments;
using Cgw.Core.Databases;
using Cgw.Core.Documents;
using Cgw.Core.Exports;
using Cgw.Core.History;
using Cgw.Core.Notifications;
using Cgw.Core.Plugins;
using Cgw.Core.Previews;
using Cgw.Core.Search;
using Cgw.Core.Sharing;
using Cgw.Core.Sites;
using Cgw.Core.Sync;
using Cgw.Core.Workbooks;
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
        // Phase 11: groups.
        services.AddScoped<GroupService>();
        services.AddScoped<DocService>();
        services.AddScoped<AssetService>();
        services.AddScoped<LinkPreviews>();
        services.AddSingleton<SafeFetcher>();
        services.AddScoped<SharingService>();
        services.AddScoped<SharedReader>();
        services.AddScoped<SharedDatabases>();
        // Phase 9: publishing (the sites themselves are the Sites process's).
        services.AddSingleton(sp => SitesOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddScoped<PublishingService>();
        services.AddSingleton<FullText>();
        services.AddScoped<SearchService>();
        services.AddScoped<VersionService>();
        services.AddScoped<ExportService>();
        services.AddScoped<DatabaseOps>();
        services.AddScoped<DatabaseService>();
        services.AddSingleton<DatabaseRowCache>();
        services.AddScoped<WorkbookAccess>();
        services.AddScoped<WorkbookService>();
        services.AddScoped<SheetSessions>();
        services.AddScoped<ErpLinkService>();
        services.AddScoped<PageGate>();
        services.AddScoped<CommentService>();
        services.AddScoped<NotificationService>();
        services.AddScoped<MailSettingsService>();
        services.AddScoped<ErpCommitService>();
        // Phase 7: AI. One client connection pool for the provider, renewed every few minutes.
        services.AddSingleton(sp => AiOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddSingleton<AiKeys>();
        services.AddScoped<AiService>();
        services.AddSingleton<IAiProvider>(sp => new AnthropicProvider(
            sp.GetRequiredService<AiOptions>(),
            new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) }) { Timeout = Timeout.InfiniteTimeSpan }));
        // Phase 10: embeddings (search by meaning) with the workspace's own Voyage key, and the
        // in-memory copies of the vectors (one set an API process).
        services.AddSingleton(sp => EmbeddingsOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddSingleton<EmbeddingKeys>();
        services.AddSingleton<EmbeddingsCache>();
        services.AddScoped<EmbeddingsService>();
        services.AddScoped<MeaningSearch>();
        services.AddSingleton<IEmbeddingProvider>(sp => new VoyageProvider(
            sp.GetRequiredService<EmbeddingsOptions>(),
            new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) }) { Timeout = Timeout.InfiniteTimeSpan }));
        // Phase 10: third-party plugins (served by the Sites process's second host).
        services.AddSingleton(sp => PluginsOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddScoped<PluginService>();
        return services;
    }

    public static RouteGroupBuilder MapCgwModules(this RouteGroupBuilder api)
    {
        api.MapWorkspaces();
        api.MapGroups();
        api.MapDocs();
        api.MapAssets();
        api.MapSharing();
        api.MapPublishing();
        api.MapHistory();
        api.MapDatabases();
        api.MapWorkbooks();
        api.MapSheetSessions();
        api.MapComments();
        api.MapRealtimeTickets();
        api.MapErpCommits();
        api.MapAi();
        api.MapPlugins();
        return api;
    }
}
