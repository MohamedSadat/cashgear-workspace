using System.Text.Json;
using System.Text.Json.Serialization;
using Cgw.Api;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

// The API process (ARCHITECTURE.md, The backend): authentication, authorisation, operations, the
// change feed, document push and pull, asset tickets, search, sharing, versions. It never loads a
// Yjs library; the worker does that.
var builder = WebApplication.CreateBuilder(args);

if (builder.Configuration["Logging:Format"] == "json")
{
    builder.Logging.ClearProviders();
    builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
}
// Under IIS the console goes nowhere: on a Windows host that asks for it (install.ps1 registers the
// source), warnings and errors also go to the Application event log, and each mail sent or not sent.
if (OperatingSystem.IsWindows() && builder.Configuration["Logging:EventLog:Enabled"] == "true")
{
    builder.Logging.AddEventLog(s =>
    {
        if (OperatingSystem.IsWindows()) s.SourceName = "Cash Gear Workspace API";
    });
    builder.Logging.AddFilter<Microsoft.Extensions.Logging.EventLog.EventLogLoggerProvider>(level => level >= LogLevel.Warning);
    builder.Logging.AddFilter<Microsoft.Extensions.Logging.EventLog.EventLogLoggerProvider>(typeof(MailSender).FullName, LogLevel.Information);
}

builder.Services.AddCgwCore(builder.Configuration);
builder.Services.AddCgwProblems();
builder.Services.AddCgwRateLimits(builder.Configuration);
builder.Services.AddCgwApi(builder.Configuration, builder.Environment);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
});
builder.Services.AddOpenApi("v1", options =>
{
    options.AddDocumentTransformer((document, _, _) =>
    {
        document.Info.Title = "Cash Gear Workspace API";
        document.Info.Version = "v1";
        document.Info.Description = "Generated from the code and checked in (server/openapi/v1.json); @cgw/api is generated from it.";
        return Task.CompletedTask;
    });
    options.AddOperationTransformer<RouteParameters>();
    options.AddOperationTransformer<DocumentedBodies>();
    options.AddSchemaTransformer<NullableItems>();
});
builder.Services.AddHealthChecks()
    .AddCheck<SqlHealth>("sql", tags: ["ready"])
    .AddCheck<BlobHealth>("blob", tags: ["ready"])
    .AddCheck<WorkerHealth>("worker", tags: ["ready"]);

var app = builder.Build();
await StartupTasks.MigrateIfAskedAsync(app.Services, app.Configuration);

app.UseCorrelation();
app.UseRetryAfter();
app.UseCgwExceptions();
app.UseStatusCodePages();
if (!app.Environment.IsDevelopment() && !app.Environment.IsEnvironment("Testing")) app.UseHsts();
app.UseCgwSecurityHeaders();
app.UseCors(ApiServices.CorsPolicy);
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
app.UseAntiforgery();

if (app.Environment.IsDevelopment()) app.MapOpenApi("/openapi/{documentName}.json");
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });
app.MapCgwApi();

app.Run();

/// <summary>The entry point, for WebApplicationFactory in the tests.</summary>
public partial class Program;
