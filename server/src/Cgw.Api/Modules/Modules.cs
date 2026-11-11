namespace Cgw.Api.Modules;

/// <summary>The feature modules' routes and services (ARCHITECTURE.md, The backend).</summary>
public static class Modules
{
    public static IServiceCollection AddCgwModules(this IServiceCollection services, IConfiguration configuration) => services;

    public static RouteGroupBuilder MapCgwModules(this RouteGroupBuilder api) => api;
}
