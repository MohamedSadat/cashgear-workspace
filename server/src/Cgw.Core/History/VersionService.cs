using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.History;

public sealed record VersionDto(Guid Id, string Kind, string? Name, long UpToSeq, string Status, DateTimeOffset CreatedAt, Guid? CreatedBy)
{
    public static VersionDto From(PageDocSnapshot s) => new(s.Id, s.Kind, s.Name, s.UpToSeq, s.Status, s.CreatedAt, s.CreatedBy);
}

public sealed record VersionDetailDto(Guid Id, string Kind, string? Name, long UpToSeq, string Status, DateTimeOffset CreatedAt, Guid? CreatedBy, string? Url);
public sealed record NewVersion(string? Name, string? Kind);
public sealed record RestoreRequest(string? Mode);
public sealed record RestoreDto(Guid Id, string Status);

public static class CommandStatus
{
    public const string Pending = "pending";
    public const string Done = "done";
    public const string Failed = "failed";
}

/// <summary>
/// Version history (D18; SYNC_DESIGN.md, Version history and restore). History snapshots are
/// full states kept for people: <c>auto</c> (one per hour of activity, made by the worker),
/// <c>named</c> and <c>preRestore</c> (asked for here, written by the worker from the page's
/// validated state). Viewing reads one by a signed URL. An ordinary restore is a forward edit
/// the client makes; the server does only the hard restore (owners and admins), which the worker
/// carries out with an epoch change.
/// </summary>
public sealed class VersionService(CgwDb db, BlobStore blob, Audit audit, TimeProvider clock)
{
    public static readonly string[] HistoryKinds = [SnapshotKinds.Auto, SnapshotKinds.Named, SnapshotKinds.PreRestore];

    public async Task<List<VersionDto>> ListAsync(Page page, CancellationToken ct = default) =>
        (await db.PageDocSnapshots.AsNoTracking()
            .Where(s => s.PageId == page.Id && HistoryKinds.Contains(s.Kind))
            .OrderByDescending(s => s.CreatedAt).ThenByDescending(s => s.Id)
            .ToListAsync(ct))
        .Select(VersionDto.From).ToList();

    public async Task<Result<VersionDto>> CreateAsync(Member member, Page page, NewVersion request, CancellationToken ct = default)
    {
        var kind = request.Kind ?? SnapshotKinds.Named;
        if (kind is not (SnapshotKinds.Named or SnapshotKinds.PreRestore)) return Failure.Invalid("kind is named or preRestore");
        var name = request.Name?.Trim();
        if (name is { Length: > 200 }) return Failure.Invalid("A name has at most 200 characters");
        if (name is { Length: 0 }) name = null;
        var snapshot = new PageDocSnapshot
        {
            Id = Guid.CreateVersion7(),
            PageId = page.Id,
            WorkspaceId = page.WorkspaceId,
            Epoch = page.DocEpoch,
            UpToSeq = page.DocHeadSeq,
            Kind = kind,
            Name = name,
            Status = "pending",
            CreatedBy = member.UserId,
            CreatedAt = clock.GetUtcNow(),
        };
        snapshot.BlobKey = BlobStore.SnapshotKey(page.WorkspaceId, page.Id, snapshot.Id);
        db.PageDocSnapshots.Add(snapshot);
        await db.SaveChangesAsync(ct);
        return VersionDto.From(snapshot);
    }

    private Task<PageDocSnapshot?> FindAsync(Page page, Guid versionId, CancellationToken ct) =>
        db.PageDocSnapshots.AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == versionId && s.PageId == page.Id && HistoryKinds.Contains(s.Kind), ct);

    public async Task<Result<VersionDetailDto>> GetAsync(Page page, Guid versionId, CancellationToken ct = default)
    {
        var s = await FindAsync(page, versionId, ct);
        if (s is null) return Failure.NotFound("No such version");
        var url = s.Status == "ready" ? (await blob.ReadUrlAsync(s.BlobKey, "application/octet-stream", ct: ct)).ToString() : null;
        return new VersionDetailDto(s.Id, s.Kind, s.Name, s.UpToSeq, s.Status, s.CreatedAt, s.CreatedBy, url);
    }

    /// <summary>A hard restore, carried out by the worker: the page's epoch rises and the version becomes its state.</summary>
    public async Task<Result<RestoreDto>> RestoreAsync(Member member, Actor actor, Page page, Guid versionId, RestoreRequest request, CancellationToken ct = default)
    {
        if (request.Mode != "hard") return Failure.Invalid("The server does only a hard restore (mode: hard); an ordinary restore is an edit made by the app");
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin does a hard restore");
        var s = await FindAsync(page, versionId, ct);
        if (s is null) return Failure.NotFound("No such version");
        if (s.Status != "ready") return Failure.Conflict(Codes.Conflict, "The version is still being written");
        if (await db.PageDocCommands.AnyAsync(c => c.PageId == page.Id && c.Status == CommandStatus.Pending, ct))
            return Failure.Conflict(Codes.Conflict, "A restore of this page is already waiting");
        var command = new PageDocCommand
        {
            Id = Guid.CreateVersion7(),
            PageId = page.Id,
            WorkspaceId = page.WorkspaceId,
            Kind = "hardRestore",
            SnapshotId = s.Id,
            RequestedBy = member.UserId,
            Status = CommandStatus.Pending,
            CreatedAt = clock.GetUtcNow(),
        };
        db.PageDocCommands.Add(command);
        audit.Add(actor, "version.restoreRequest", page.WorkspaceId, "page", page.Id, new { versionId, commandId = command.Id, mode = "hard" });
        await db.SaveChangesAsync(ct);
        return new RestoreDto(command.Id, command.Status);
    }
}
