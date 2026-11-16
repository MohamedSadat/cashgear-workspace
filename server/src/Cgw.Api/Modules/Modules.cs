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
using Cgw.Core.Previews;
using Cgw.Core.Search;
using Cgw.Core.Sharing;
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
        api.MapWorkbooks();
        api.MapSheetSessions();
        api.MapComments();
        api.MapRealtimeTickets();
        api.MapErpCommits();
        api.MapAi();
        return api;
    }
}
