using Cgw.Core.Data;
using Cgw.Core.Sync;
using Cgw.Worker.Jobs;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker;

/// <summary>One step of the worker's work, run on its own interval.</summary>
public interface IJob
{
    string Name { get; }
    TimeSpan Interval { get; }
    /// <summary>Does what is due; returns whether there may be more right away.</summary>
    Task<bool> RunAsync(IServiceProvider services, CancellationToken ct);
    /// <summary>Runs on a loop of its own, so no other job's long pass delays it.</summary>
    bool OwnLoop => false;
}

public static class WorkerServices
{
    public static IServiceCollection AddCgwWorker(this IServiceCollection services, IConfiguration configuration)
    {
        Yjs.Configure(configuration["Ydoc:Library"]);
        services.AddScoped<ChangeLog>();
        services.AddSingleton<DocStates>();
        services.AddSingleton<ICompactionFaults, NoFaults>();
        services.AddSingleton<IJob, ValidateJob>();
        services.AddSingleton<IJob, CompactJob>();
        services.AddSingleton<IJob, DeriveJob>();
        services.AddSingleton<IJob, StateHashJob>();
        services.AddSingleton<IAssetScanner, NoScanner>();
        services.AddSingleton<IJob, AssetCheckJob>();
        services.AddSingleton<IJob, AssetCleanupJob>();
        services.AddSingleton<IJob, SnapshotJob>();
        services.AddSingleton<IJob, HistoryJob>();
        services.AddSingleton<IJob, HardRestoreJob>();
        services.AddSingleton<IJob, ExportJob>();
        services.AddSingleton<IJob, PagePurgeJob>();
        services.AddSingleton<IJob, WorkspacePurgeJob>();
        services.AddSingleton<IJob, FeedRetentionJob>();
        services.AddSingleton<IJob, TrashRetentionJob>();
        services.AddSingleton<IJob, ReconcileJob>();
        services.AddHostedService<JobLoop>();
        return services;
    }
}

/// <summary>
/// Runs each job on its interval, records its last run, and never lets one failure stop the others.
/// The jobs share one loop, except those that ask for their own (validation: an edit reaches others
/// only once it has passed, so a long derive, history or export pass must not hold it back).
/// </summary>
public sealed class JobLoop(IServiceProvider services, IEnumerable<IJob> jobs, ILogger<JobLoop> logger, TimeProvider clock) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        logger.LogInformation("Worker started with cgw-ydoc {Version}", Yjs.Version());
        var all = jobs.ToList();
        var loops = all.Where(j => j.OwnLoop).Select(j => Task.Run(() => LoopAsync([j], ct), ct)).ToList();
        loops.Add(LoopAsync(all.Where(j => !j.OwnLoop).ToList(), ct));
        await Task.WhenAll(loops);
    }

    private async Task LoopAsync(IReadOnlyList<IJob> list, CancellationToken ct)
    {
        var due = list.ToDictionary(j => j.Name, _ => DateTimeOffset.MinValue);
        while (!ct.IsCancellationRequested)
        {
            foreach (var job in list)
            {
                if (clock.GetUtcNow() < due[job.Name]) continue;
                var more = await RunOnceAsync(services, job, logger, clock, ct);
                due[job.Name] = more ? DateTimeOffset.MinValue : clock.GetUtcNow() + job.Interval;
            }
            await Task.Delay(TimeSpan.FromMilliseconds(50), ct);
        }
    }

    public static async Task<bool> RunOnceAsync(IServiceProvider services, IJob job, ILogger logger, TimeProvider clock, CancellationToken ct)
    {
        await using var scope = services.CreateAsyncScope();
        var started = clock.GetUtcNow();
        var more = false;
        string? error = null;
        try
        {
            more = await job.RunAsync(scope.ServiceProvider, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "Job {Job} failed", job.Name);
            error = e.Message.Length > 2000 ? e.Message[..2000] : e.Message;
        }
        await RecordAsync(scope.ServiceProvider.GetRequiredService<CgwDb>(), job.Name, started, error, clock);
        return more;
    }

    /// <summary>The job's last run and last success, for its lag and the API's health check.</summary>
    private static async Task RecordAsync(CgwDb db, string name, DateTimeOffset ran, string? error, TimeProvider clock)
    {
        db.ChangeTracker.Clear();
        var ok = error is null ? clock.GetUtcNow() : (DateTimeOffset?)null;
        var changed = await db.JobStates.Where(j => j.Name == name).ExecuteUpdateAsync(s => s
            .SetProperty(j => j.LastRunAt, ran)
            .SetProperty(j => j.Runs, j => j.Runs + 1)
            .SetProperty(j => j.LastError, error)
            .SetProperty(j => j.LastOkAt, j => ok ?? j.LastOkAt));
        if (changed > 0) return;
        try
        {
            db.JobStates.Add(new JobState { Name = name, LastRunAt = ran, LastOkAt = ok, LastError = error, Runs = 1 });
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            // Another run recorded it first.
        }
    }
}
