using Cgw.Core.Ai;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Cgw.LocalModel;

/// <summary>
/// The embeddings provider the API and the worker call (Phase 13): a call of the local model
/// (voyage-4-nano) goes to <see cref="LocalEmbeddingProvider"/> on this server, and nowhere else;
/// any other model to Voyage's API.
/// </summary>
public sealed class EmbeddingRouter(VoyageProvider voyage, LocalEmbeddingProvider local) : IEmbeddingProvider
{
    public string Id => "router";

    public Task<EmbeddingResult> EmbedAsync(EmbeddingCall call, CancellationToken ct) =>
        LocalModelOptions.IsLocal(call.Model) ? local.EmbedAsync(call, ct) : voyage.EmbedAsync(call, ct);
}

public static class LocalModelServices
{
    /// <summary>Voyage's provider, the local model's and the router as <see cref="IEmbeddingProvider"/>.</summary>
    public static IServiceCollection AddLocalModel(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton(sp => LocalModelOptions.From(configuration, sp.GetRequiredService<IHostEnvironment>().IsProduction()));
        services.AddSingleton(sp => new LocalEmbeddingProvider(sp.GetRequiredService<LocalModelOptions>(), sp.GetRequiredService<ILogger<LocalEmbeddingProvider>>()));
        services.AddSingleton(sp => new VoyageProvider(
            sp.GetRequiredService<EmbeddingsOptions>(),
            new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) }) { Timeout = Timeout.InfiniteTimeSpan }));
        services.AddSingleton<IEmbeddingProvider, EmbeddingRouter>();
        return services;
    }
}
