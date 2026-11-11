using Cgw.Core.Data;
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
}

public static class WorkerServices
{
    public static IServiceCollection AddCgwWorker(this IServiceCollection services, IConfiguration configuration)
    {
        Yjs.Configure(configuration["Ydoc:Library"]);
        services.AddHostedService<JobLoop>();
        return services;
    }
}

/// <summary>Runs each job on its interval, records its last run, and never lets one failure stop the others.</summary>
public sealed class JobLoop(IServiceProvider services, IEnumerable<IJob> jobs, ILogger<JobLoop> logger, TimeProvider clock) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        logger.LogInformation("Worker started with cgw-ydoc {Version}", Yjs.Version());
        var due = jobs.ToDictionary(j => j.Name, _ => DateTimeOffset.MinValue);
        while (!ct.IsCancellationRequested)
        {
            foreach (var job in jobs)
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
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        var state = await db.JobStates.FirstOrDefaultAsync(j => j.Name == job.Name, ct);
        if (state is null) db.JobStates.Add(state = new JobState { Name = job.Name });
        state.LastRunAt = clock.GetUtcNow();
        state.Runs++;
        var more = false;
        try
        {
            more = await job.RunAsync(scope.ServiceProvider, ct);
            state.LastOkAt = clock.GetUtcNow();
            state.LastError = null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "Job {Job} failed", job.Name);
            state.LastError = e.Message.Length > 2000 ? e.Message[..2000] : e.Message;
        }
        db.ChangeTracker.Clear();
        db.JobStates.Update(state);
        await db.SaveChangesAsync(CancellationToken.None);
        return more;
    }
}
