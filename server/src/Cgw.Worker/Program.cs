using Cgw.Core;

namespace Cgw.Worker;

// The worker process (ARCHITECTURE.md, The backend): validation of pushed updates, compaction,
// snapshots, derived JSON and text, asset checks and clean-up, retention, exports. It serves no
// requests. On Windows it runs as a service (docs/OPERATIONS.md).
public static class WorkerProgram
{
    public static void Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddWindowsService(o => o.ServiceName = "CashGearWorkspaceWorker");
        if (builder.Configuration["Logging:Format"] == "json")
        {
            builder.Logging.ClearProviders();
            builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
        }
        // A service's console goes nowhere: on a Windows host that asks for it (install.ps1
        // registers the source), warnings and errors also go to the Application event log.
        if (OperatingSystem.IsWindows() && builder.Configuration["Logging:EventLog:Enabled"] == "true")
        {
            builder.Logging.AddEventLog(s =>
            {
                if (OperatingSystem.IsWindows()) s.SourceName = "Cash Gear Workspace worker";
            });
            builder.Logging.AddFilter<Microsoft.Extensions.Logging.EventLog.EventLogLoggerProvider>(level => level >= LogLevel.Warning);
        }
        builder.Services.AddCgwCore(builder.Configuration);
        builder.Services.AddCgwWorker(builder.Configuration);
        builder.Build().Run();
    }
}
