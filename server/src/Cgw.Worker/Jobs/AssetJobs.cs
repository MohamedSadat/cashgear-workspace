using Cgw.Core.Assets;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker.Jobs;

/// <summary>A malware scan before an asset is served (ARCHITECTURE.md, Upload safety); none by default.</summary>
public interface IAssetScanner
{
    Task<bool> CleanAsync(Asset asset, byte[] head, CancellationToken ct);
}

public sealed class NoScanner : IAssetScanner
{
    public Task<bool> CleanAsync(Asset asset, byte[] head, CancellationToken ct) => Task.FromResult(true);
}

/// <summary>
/// Uploaded assets are checked before anyone but their uploader can read them: the bytes must be
/// the type they were uploaded as (an image only as an image), and images get their size. One
/// that fails is quarantined, never served. A ticket nobody used for a day is dropped.
/// </summary>
public sealed class AssetCheckJob(BlobStore blob, IAssetScanner scanner, TimeProvider clock) : IJob
{
    public string Name => "assets";
    public TimeSpan Interval => TimeSpan.FromSeconds(1);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var pending = await db.Assets.IgnoreQueryFilters([CgwDb.Tenant]).Where(a => a.Status == AssetStatus.Pending)
            .OrderBy(a => a.CreatedAt).Take(20).ToListAsync(ct);
        var done = 0;
        foreach (var asset in pending)
        {
            var head = await blob.HeadAsync(asset.BlobKey, AssetSniffer.HeadBytes, ct);
            if (head is null)
            {
                if (asset.CreatedAt < clock.GetUtcNow().AddDays(-1)) asset.Status = AssetStatus.Deleted;
                continue;
            }
            done++;
            if (!AssetSniffer.Fits(asset.ContentType, head))
            {
                asset.Status = AssetStatus.Quarantined;
                asset.Problem = $"The bytes are not {asset.ContentType}";
            }
            else if (!await scanner.CleanAsync(asset, head, ct))
            {
                asset.Status = AssetStatus.Quarantined;
                asset.Problem = "The scan refused it";
            }
            else
            {
                asset.Status = AssetStatus.Ready;
                if (AssetTypes.Images.Contains(asset.ContentType))
                    (asset.Width, asset.Height) = AssetSniffer.Dimensions(asset.ContentType, head);
                asset.SizeBytes = await blob.SizeAsync(asset.BlobKey, ct) ?? asset.SizeBytes;
            }
        }
        await db.SaveChangesAsync(ct);
        return done == 20;
    }
}

/// <summary>
/// The reference count and clean-up (DATA_MODEL.md, Assets): an asset no page shows (in its
/// content, as its cover, or as a link preview) for 30 days is deleted with its blob. Each
/// workspace's storage used is recorded (Q10: shown, not enforced).
/// </summary>
public sealed class AssetCleanupJob(BlobStore blob, TimeProvider clock) : IJob
{
    public string Name => "assetCleanup";
    public TimeSpan Interval => TimeSpan.FromHours(1);
    public static readonly TimeSpan Keep = TimeSpan.FromDays(30);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        var assets = db.Assets.IgnoreQueryFilters([CgwDb.Tenant]);
        var refs = db.AssetRefs.IgnoreQueryFilters([CgwDb.Tenant]);
        var pages = db.Pages.IgnoreQueryFilters([CgwDb.Tenant]);
        var previews = db.LinkPreviews.IgnoreQueryFilters([CgwDb.Tenant]);
        var referenced = assets.Where(a =>
            refs.Any(r => r.AssetId == a.Id)
            || pages.Any(p => p.CoverAssetId == a.Id && p.DeletedAt == null)
            || previews.Any(l => l.ImageAssetId == a.Id)
            || db.Users.Any(u => u.AvatarAssetId == a.Id));
        await referenced.Where(a => a.UnreferencedSince != null).ExecuteUpdateAsync(s => s.SetProperty(a => a.UnreferencedSince, (DateTimeOffset?)null), ct);
        await assets.Where(a => a.Status == AssetStatus.Ready && a.UnreferencedSince == null).Except(referenced)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.UnreferencedSince, now), ct);
        var expired = await assets.Where(a => a.Status != AssetStatus.Deleted && a.UnreferencedSince != null && a.UnreferencedSince < now - Keep)
            .Take(500).ToListAsync(ct);
        foreach (var asset in expired)
        {
            await blob.DeleteAsync(asset.BlobKey, ct);
            asset.Status = AssetStatus.Deleted;
        }
        await db.SaveChangesAsync(ct);
        var used = await assets.Where(a => a.Status == AssetStatus.Ready).GroupBy(a => a.WorkspaceId)
            .Select(g => new { g.Key, Bytes = g.Sum(a => a.SizeBytes) }).ToListAsync(ct);
        foreach (var row in used)
            await db.Workspaces.Where(w => w.Id == row.Key).ExecuteUpdateAsync(s => s.SetProperty(w => w.StorageUsedBytes, row.Bytes), ct);
        return expired.Count == 500;
    }
}
