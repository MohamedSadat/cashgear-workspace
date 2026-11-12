using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Exports;

public sealed record ExportDto(Guid Id, string Status, string? Url);

public static class ExportStatus
{
    public const string Pending = "pending";
    public const string Ready = "ready";
    public const string Failed = "failed";
    /// <summary>Its zip is deleted after <see cref="ExportService.Keep"/>.</summary>
    public const string Expired = "expired";
}

/// <summary>
/// Workspace export from the server (M2.8; DATA_MODEL.md, Data export): an owner or admin asks,
/// the worker writes the same zip the app's own export makes, and its requester reads it by a
/// signed URL.
/// </summary>
public sealed class ExportService(CgwDb db, BlobStore blob, Audit audit, TimeProvider clock)
{
    public static readonly TimeSpan Keep = TimeSpan.FromDays(7);

    public async Task<Result<ExportDto>> RequestAsync(Member member, Actor actor, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin exports the workspace");
        // One waiting export per person is enough: asking again answers with it.
        var waiting = await db.WorkspaceExports.AsNoTracking()
            .FirstOrDefaultAsync(e => e.RequestedBy == member.UserId && e.Status == ExportStatus.Pending, ct);
        if (waiting is not null) return new ExportDto(waiting.Id, waiting.Status, null);
        var export = new WorkspaceExport
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            RequestedBy = member.UserId,
            Status = ExportStatus.Pending,
            CreatedAt = clock.GetUtcNow(),
        };
        db.WorkspaceExports.Add(export);
        audit.Add(actor, "workspace.export", member.WorkspaceId, "export", export.Id);
        await db.SaveChangesAsync(ct);
        return new ExportDto(export.Id, export.Status, null);
    }

    public async Task<ExportDto> GetAsync(WorkspaceExport export, string workspaceName, CancellationToken ct = default)
    {
        string? url = null;
        if (export.Status == ExportStatus.Ready && export.BlobKey is { } key)
        {
            var name = $"{SafeNames.Name(workspaceName, "workspace")} {export.CreatedAt.UtcDateTime:yyyy-MM-dd}.zip";
            url = (await blob.ReadUrlAsync(key, "application/zip", name, ct: ct)).ToString();
        }
        return new ExportDto(export.Id, export.Status, url);
    }
}
