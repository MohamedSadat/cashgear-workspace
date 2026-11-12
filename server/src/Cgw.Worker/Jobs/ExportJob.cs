using Cgw.Core;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Exports;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Workspace exports (M2.8): the zip of everything the requester may read, in the app's own
/// export format (<see cref="ExportBuilder"/>), written to a temporary file and then to Blob. Each
/// page's JSON is the worker's derived JSON, or the page's state when that is behind. A zip is
/// kept for <see cref="ExportService.Keep"/>, then deleted.
/// </summary>
public sealed class ExportJob(DocStates states, BlobStore blob, ILogger<ExportJob> logger, TimeProvider clock) : IJob
{
    public string Name => "export";
    public TimeSpan Interval => TimeSpan.FromSeconds(2);
    private const string EmptyDoc = """{"type":"doc","content":[]}""";

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        await ExpireAsync(db, ct);
        var next = await db.WorkspaceExports.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(e => e.Status == ExportStatus.Pending).OrderBy(e => e.CreatedAt)
            .Select(e => new { e.Id, e.WorkspaceId }).FirstOrDefaultAsync(ct);
        if (next is null) return false;
        db.ChangeTracker.Clear();
        db.Scope.Switch(next.WorkspaceId);
        try
        {
            await ExportAsync(db, next.Id, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "Export {Export} failed", next.Id);
            db.ChangeTracker.Clear();
            var error = e.Message.Length > 1000 ? e.Message[..1000] : e.Message;
            var at = clock.GetUtcNow();
            await db.WorkspaceExports.Where(x => x.Id == next.Id).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.Status, ExportStatus.Failed).SetProperty(x => x.Error, error).SetProperty(x => x.CompletedAt, at), ct);
        }
        return true;
    }

    private async Task ExpireAsync(CgwDb db, CancellationToken ct)
    {
        var old = clock.GetUtcNow() - ExportService.Keep;
        var expired = await db.WorkspaceExports.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(e => e.Status == ExportStatus.Ready && e.CreatedAt < old).OrderBy(e => e.CreatedAt).Take(100).ToListAsync(ct);
        foreach (var export in expired)
        {
            export.Status = ExportStatus.Expired;
            await db.SaveChangesAsync(ct);
            if (export.BlobKey is { } key) await blob.DeleteAsync(key, ct);
        }
    }

    public async Task ExportAsync(CgwDb db, Guid exportId, CancellationToken ct)
    {
        var export = await db.WorkspaceExports.FirstAsync(e => e.Id == exportId, ct);
        var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == export.WorkspaceId, ct);
        var access = new Access(db);
        var member = await access.MemberAsync(export.WorkspaceId, export.RequestedBy);
        if (workspace.DeletedAt is not null || member is null || !member.IsAdmin)
            throw new InvalidOperationException("The requester may no longer export this workspace");
        var locale = await db.Users.AsNoTracking().Where(u => u.Id == export.RequestedBy).Select(u => u.Locale).FirstOrDefaultAsync(ct);
        var levels = await access.AllLevelsAsync(member);
        var sections = (await db.Sections.AsNoTracking().ToListAsync(ct)).Where(s => Access.SeesSection(member, s)).ToList();
        // A database's rows are pages under it, with its level.
        var pages = (await db.Pages.AsNoTracking().Where(p => p.DeletedAt == null).ToListAsync(ct))
            .Where(p => Access.LevelIn(levels, p) != Levels.None).ToList();
        var assets = await db.Assets.AsNoTracking().Where(a => a.Status == AssetStatus.Ready).ToDictionaryAsync(a => a.Id, ct);
        // The databases the requester may read (their pages are among the pages), their views and
        // their rows' values, and people's names for the CSV files.
        var databasePages = pages.Where(p => p.Kind == PageKinds.Database).Select(p => p.Id).ToHashSet();
        var databases = new Dictionary<Guid, ExportBuilder.Database>();
        if (databasePages.Count > 0)
        {
            var records = (await db.Databases.AsNoTracking().ToListAsync(ct)).Where(d => databasePages.Contains(d.PageId)).ToList();
            var views = (await db.DatabaseViews.AsNoTracking().ToListAsync(ct)).Where(v => databasePages.Contains(v.DatabaseId)).ToLookup(v => v.DatabaseId);
            foreach (var record in records)
            {
                var rows = await db.DatabaseRows.AsNoTracking().Where(r => r.DatabaseId == record.PageId).ToDictionaryAsync(r => r.PageId, ct);
                databases[record.PageId] = new ExportBuilder.Database(record, views[record.PageId].ToList(), rows);
            }
        }
        var people = (await db.WorkspaceMembers.AsNoTracking().Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.DisplayName }).ToListAsync(ct))
            .ToDictionary(u => u.Id.ToString(), u => u.DisplayName, StringComparer.Ordinal);

        async Task<string> Content(Page page)
        {
            if (page.DocHeadSeq == 0) return EmptyDoc;
            var derived = await db.PageDocDerived.AsNoTracking().Where(d => d.PageId == page.Id)
                .Select(d => new { d.UpToSeq, d.Json }).FirstOrDefaultAsync(ct);
            if (derived is not null && derived.UpToSeq >= page.DocHeadSeq) return DocService.Gunzip(derived.Json);
            return Yjs.ToJson(await states.LoadAsync(db, page, ct));
        }

        var temp = Path.Combine(Path.GetTempPath(), $"cgw-export-{exportId:N}.zip");
        try
        {
            await using (var file = new FileStream(temp, FileMode.Create, FileAccess.ReadWrite, FileShare.None, 1 << 16, FileOptions.Asynchronous))
            {
                await ExportBuilder.WriteAsync(file, new ExportBuilder.Input(
                    workspace, sections, pages, assets, Content,
                    async asset => await blob.GetAsync(asset.BlobKey, ct),
                    ExportBuilder.Untitled(locale), clock.GetUtcNow(), databases, people), ct);
                await file.FlushAsync(ct);
                file.Position = 0;
                var key = BlobStore.ExportKey(export.WorkspaceId, export.Id);
                await blob.PutAsync(key, file, "application/zip", ct);
                export.BlobKey = key;
                export.SizeBytes = file.Length;
            }
            export.Status = ExportStatus.Ready;
            export.CompletedAt = clock.GetUtcNow();
            await db.SaveChangesAsync(ct);
        }
        finally
        {
            File.Delete(temp);
        }
    }
}
