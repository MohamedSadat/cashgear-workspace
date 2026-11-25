using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.LocalModel;
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
        // Phase 12: the batch pull of documents.
        services.AddScoped<DocPulls>();
        services.AddScoped<AssetService>();
        services.AddScoped<LinkPreviews>();
        services.AddSingleton<SafeFetcher>();
        services.AddScoped<SharingService>();
        services.AddScoped<SharedReader>();
        services.AddScoped<SharedDatabases>();
        // Phase 9: publishing (the sites themselves are the Sites process's).
        services.AddSingleton(sp => SitesOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddScoped<PublishingService>();
        // Phase 14: a site's host names, and whether this server makes their certificates.
        services.AddSingleton(sp => SiteCertificateOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddScoped<SiteDomainService>();
        services.AddSingleton<FullText>();
        services.AddScoped<SearchService>();
        services.AddScoped<VersionService>();
        services.AddScoped<ExportService>();
        services.AddScoped<DatabaseOps>();
        // Phase 15: automations (the rules as records; the worker runs them).
        services.AddScoped<Cgw.Core.Automations.AutomationService>();
        services.AddScoped<Cgw.Core.Automations.AutomationQueries>();
        services.AddScoped<Cgw.Core.Automations.ApprovalService>();
        // Phase 17: people's own reminders of rows' dates (the worker sends them).
        services.AddScoped<Cgw.Core.Automations.ReminderService>();
        services.AddSingleton<Cgw.Core.Automations.WebhookKeys>();
        services.AddSingleton(sp => Cgw.Core.Automations.WebhookOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>()));
        // Phase 16: forms (a link's pages are the Sites process's; its answers are written here).
        services.AddSingleton<Cgw.Core.Forms.FormKeys>();
        services.AddSingleton(sp => Cgw.Core.Forms.FormLimits.From(configuration, sp.GetRequiredService<TimeProvider>()));
        services.AddScoped<Cgw.Core.Forms.FormService>();
        services.AddScoped<Cgw.Core.Forms.FormAnswers>();
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
        // Phase 13: Cash Gear's subscription (its keys from the host's environment only) and the allowances.
        services.AddSingleton(_ => AiSubscriptionOptions.From(configuration));
        services.AddScoped<AiAllowance>();
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
        // Phase 13: voyage-4-nano on this server beside Voyage's API, by the workspace's model.
        services.AddLocalModel(configuration);
        // Phase 10: third-party plugins (served by the Sites process's second host).
        services.AddSingleton(sp => PluginsOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddScoped<PluginService>();
        return services;
    }

    public static RouteGroupBuilder MapCgwModules(this RouteGroupBuilder api)
    {
        api.MapWorkspaces();
        api.MapGroups();
        // Phase 11: single sign-on's settings (owners only; the sign-in is the API's pages').
        api.MapSso();
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
        api.MapAutomations();
        api.MapForms();
        return api;
    }
}
