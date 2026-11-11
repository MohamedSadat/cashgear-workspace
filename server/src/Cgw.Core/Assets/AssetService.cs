using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Assets;

public sealed record NewAsset(Guid Id, string FileName, string ContentType, long SizeBytes);
public sealed record AssetTicketDto(Guid AssetId, string UploadUrl, Dictionary<string, string> Headers, DateTimeOffset ExpiresAt);
public sealed record AssetDto(Guid Id, string FileName, string ContentType, long SizeBytes, string Status, int? Width, int? Height, DateTimeOffset CreatedAt);
public sealed record AssetUrlDto(string Url, DateTimeOffset ExpiresAt, string ContentType, bool Inline);

/// <summary>What may be uploaded, and how each type is served (ARCHITECTURE.md, Upload safety).</summary>
public static class AssetTypes
{
    public const long MaxBytes = 25 * 1024 * 1024;

    /// <summary>Raster images: drawn inline, and only as images.</summary>
    public static readonly HashSet<string> Images = ["image/png", "image/jpeg", "image/gif", "image/webp"];

    /// <summary>Everything else allowed: always downloaded as an attachment. SVG is a file, never drawn inline.</summary>
    public static readonly HashSet<string> Files =
    [
        "application/pdf", "text/plain", "text/csv", "text/markdown", "application/json", "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "image/svg+xml", "audio/mpeg", "audio/wav", "video/mp4", "video/webm",
    ];

    public static bool Allowed(string type) => Images.Contains(type) || Files.Contains(type);
}

/// <summary>
/// Assets (M2.5): the client asks for a ticket, uploads straight to Blob Storage by a signed URL
/// for that one blob, and confirms; the worker then checks the bytes against the type and records
/// image dimensions. Reading needs read access to a page that shows the asset, or to be its
/// uploader, and is a signed URL of about five minutes (D17). Containers stay private.
/// </summary>
public sealed class AssetService(CgwDb db, BlobStore blob, Access access, TimeProvider clock)
{
    public async Task<Result<AssetTicketDto>> TicketAsync(Member member, NewAsset request, CancellationToken ct = default)
    {
        var type = request.ContentType?.Split(';')[0].Trim().ToLowerInvariant() ?? "";
        if (!AssetTypes.Allowed(type)) return new Failure(Codes.AssetTypeNotAllowed, 415, $"Files of type {type} cannot be uploaded");
        if (request.SizeBytes <= 0 || request.SizeBytes > AssetTypes.MaxBytes) return new Failure(Codes.LimitSize, 413, "Files are at most 25 MB");
        var name = CleanName(request.FileName);
        var existing = await db.Assets.IgnoreQueryFilters([CgwDb.Tenant]).FirstOrDefaultAsync(a => a.Id == request.Id, ct);
        if (existing is not null && (existing.WorkspaceId != member.WorkspaceId || existing.CreatedBy != member.UserId))
            return Failure.Conflict(Codes.Conflict, "That id is taken");
        if (existing is null)
        {
            existing = new Asset
            {
                Id = request.Id,
                WorkspaceId = member.WorkspaceId,
                BlobKey = BlobStore.AssetKey(member.WorkspaceId, request.Id),
                FileName = name,
                ContentType = type,
                SizeBytes = request.SizeBytes,
                Status = AssetStatus.Pending,
                CreatedBy = member.UserId,
                CreatedAt = clock.GetUtcNow(),
            };
            db.Assets.Add(existing);
            await db.SaveChangesAsync(ct);
        }
        else if (existing.Status != AssetStatus.Pending)
            return Failure.Conflict(Codes.Conflict, "The asset is already uploaded");
        var url = await blob.UploadUrlAsync(existing.BlobKey, ct: ct);
        return new AssetTicketDto(existing.Id, url.ToString(), new Dictionary<string, string>
        {
            ["x-ms-blob-type"] = "BlockBlob",
            ["Content-Type"] = existing.ContentType,
        }, clock.GetUtcNow() + BlobStore.UploadLifetime);
    }

    /// <summary>The upload is done: its size is checked now, its bytes by the worker.</summary>
    public async Task<Result<AssetDto>> CompleteAsync(Member member, Asset asset, CancellationToken ct = default)
    {
        if (asset.CreatedBy != member.UserId) return Failure.Denied("Only the uploader completes an upload");
        var size = await blob.SizeAsync(asset.BlobKey, ct);
        if (size is null) return Failure.Invalid("Nothing was uploaded");
        if (size > AssetTypes.MaxBytes)
        {
            await blob.DeleteAsync(asset.BlobKey, ct);
            return new Failure(Codes.LimitSize, 413, "Files are at most 25 MB");
        }
        asset.SizeBytes = size.Value;
        await db.SaveChangesAsync(ct);
        return Dto(asset);
    }

    /// <summary>Whether the caller may read the asset: its uploader, or a reader of a page that shows it.</summary>
    public async Task<bool> CanReadAsync(Member member, Asset asset, CancellationToken ct = default)
    {
        if (asset.CreatedBy == member.UserId) return true;
        var pages = await db.AssetRefs.Where(r => r.AssetId == asset.Id).Select(r => r.PageId)
            .Concat(db.Pages.Where(p => p.CoverAssetId == asset.Id && p.DeletedAt == null).Select(p => p.Id))
            .Distinct().Take(50).ToListAsync(ct);
        foreach (var page in pages)
            if (Levels.AtLeast(await access.PageLevelAsync(member, page), Levels.View)) return true;
        return await db.LinkPreviews.AnyAsync(p => p.ImageAssetId == asset.Id, ct);
    }

    public async Task<Result<AssetUrlDto>> ReadUrlAsync(Member member, Asset asset, CancellationToken ct = default)
    {
        if (asset.Status is AssetStatus.Quarantined or AssetStatus.Deleted) return Failure.NotFound("The file is not available");
        if (asset.Status == AssetStatus.Pending && asset.CreatedBy != member.UserId) return Failure.NotFound("The file is still being checked");
        if (!await CanReadAsync(member, asset, ct)) return Failure.NotFound("No such file");
        var inline = AssetTypes.Images.Contains(asset.ContentType);
        // Images only as images; everything else as a download with a type the browser will not run.
        var type = inline ? asset.ContentType : "application/octet-stream";
        var url = await blob.ReadUrlAsync(asset.BlobKey, type, inline ? null : asset.FileName, ct: ct);
        return new AssetUrlDto(url.ToString(), clock.GetUtcNow() + BlobStore.ReadLifetime, type, inline);
    }

    public static AssetDto Dto(Asset a) => new(a.Id, a.FileName, a.ContentType, a.SizeBytes, a.Status, a.Width, a.Height, a.CreatedAt);

    /// <summary>A file name with no path, no control characters, and a sane length.</summary>
    public static string CleanName(string? name)
    {
        var clean = new string((name ?? "").Where(c => !char.IsControl(c) && c is not ('/' or '\\')).ToArray()).Trim();
        if (clean.Length == 0) clean = "file";
        return clean.Length > 255 ? clean[..255] : clean;
    }
}
