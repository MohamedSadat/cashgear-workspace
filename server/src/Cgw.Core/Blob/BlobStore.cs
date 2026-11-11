using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Sas;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Blob;

/// <summary>
/// Blob storage: one private container (D17). Reads and uploads by the client go through signed
/// URLs for one blob: about 5 minutes to read, 10 to upload. In production the signature is a
/// user-delegation SAS from an Azure AD credential; with a connection string (Azurite in
/// development and tests) it is a service SAS from the account key.
/// </summary>
public sealed class BlobStore
{
    private readonly BlobServiceClient service;
    private readonly bool delegation;
    private readonly SemaphoreSlim keyLock = new(1, 1);
    private UserDelegationKey? key;
    private DateTimeOffset keyExpires;

    public BlobContainerClient Container { get; }

    public static readonly TimeSpan ReadLifetime = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan UploadLifetime = TimeSpan.FromMinutes(10);

    public BlobStore(IConfiguration configuration)
    {
        var section = configuration.GetSection("Blob");
        var name = section["Container"] ?? "workspace";
        var connection = section["ConnectionString"];
        if (!string.IsNullOrEmpty(connection))
        {
            service = new BlobServiceClient(connection);
            delegation = false;
        }
        else
        {
            var uri = section["ServiceUri"] ?? "https://127.0.0.1:10000/devstoreaccount1";
            service = new BlobServiceClient(new Uri(uri), new DefaultAzureCredential());
            delegation = true;
        }
        Container = service.GetBlobContainerClient(name);
    }

    public async Task EnsureContainerAsync(CancellationToken ct = default) =>
        await Container.CreateIfNotExistsAsync(PublicAccessType.None, cancellationToken: ct);

    /// <summary>
    /// CORS rules for browsers that read and upload by signed URL. Production sets them on the
    /// storage account (docs/OPERATIONS.md); development and tests set them here.
    /// </summary>
    public async Task AllowOriginsAsync(IEnumerable<string> origins, CancellationToken ct = default)
    {
        var list = string.Join(",", origins);
        if (list.Length == 0) return;
        var properties = (await service.GetPropertiesAsync(ct)).Value;
        properties.Cors =
        [
            new BlobCorsRule
            {
                AllowedOrigins = list,
                AllowedMethods = "GET,HEAD,PUT,OPTIONS",
                AllowedHeaders = "*",
                ExposedHeaders = "*",
                MaxAgeInSeconds = 3600,
            },
        ];
        await service.SetPropertiesAsync(properties, ct);
    }

    public BlobClient Blob(string key) => Container.GetBlobClient(key);

    public async Task PutAsync(string key, byte[] bytes, string contentType, CancellationToken ct = default) =>
        await Blob(key).UploadAsync(
            new BinaryData(bytes),
            new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = contentType } },
            ct);

    public async Task<byte[]?> GetAsync(string key, CancellationToken ct = default)
    {
        try
        {
            var result = await Blob(key).DownloadContentAsync(ct);
            return result.Value.Content.ToArray();
        }
        catch (RequestFailedException e) when (e.Status == 404)
        {
            return null;
        }
    }

    /// <summary>The first bytes of a blob, for checking its type against its content.</summary>
    public async Task<byte[]?> HeadAsync(string key, int count, CancellationToken ct = default)
    {
        try
        {
            var result = await Blob(key).DownloadStreamingAsync(
                new BlobDownloadOptions { Range = new HttpRange(0, count) }, ct);
            using var buffer = new MemoryStream();
            await result.Value.Content.CopyToAsync(buffer, ct);
            return buffer.ToArray();
        }
        catch (RequestFailedException e) when (e.Status is 404 or 416)
        {
            return null;
        }
    }

    public async Task<long?> SizeAsync(string key, CancellationToken ct = default)
    {
        try
        {
            return (await Blob(key).GetPropertiesAsync(cancellationToken: ct)).Value.ContentLength;
        }
        catch (RequestFailedException e) when (e.Status == 404)
        {
            return null;
        }
    }

    public async Task<bool> ExistsAsync(string key, CancellationToken ct = default) =>
        (await Blob(key).ExistsAsync(ct)).Value;

    public async Task DeleteAsync(string key, CancellationToken ct = default) =>
        await Blob(key).DeleteIfExistsAsync(DeleteSnapshotsOption.IncludeSnapshots, cancellationToken: ct);

    /// <summary>Brings back a soft-deleted blob, if the account keeps them (the reconcile job).</summary>
    public async Task<bool> UndeleteAsync(string key, CancellationToken ct = default)
    {
        try
        {
            await Blob(key).UndeleteAsync(ct);
            return await ExistsAsync(key, ct);
        }
        catch (RequestFailedException)
        {
            return false;
        }
    }

    public async IAsyncEnumerable<(string Name, DateTimeOffset? Created)> ListAsync(
        string prefix,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        await foreach (var item in Container.GetBlobsAsync(BlobTraits.None, BlobStates.None, prefix, ct))
            yield return (item.Name, item.Properties.CreatedOn);
    }

    /// <summary>A URL that reads one blob for a few minutes. Non-images download as attachments.</summary>
    public async Task<Uri> ReadUrlAsync(
        string key,
        string? contentType = null,
        string? attachmentName = null,
        TimeSpan? lifetime = null,
        CancellationToken ct = default)
    {
        var sas = new BlobSasBuilder
        {
            BlobContainerName = Container.Name,
            BlobName = key,
            Resource = "b",
            StartsOn = DateTimeOffset.UtcNow.AddMinutes(-5),
            ExpiresOn = DateTimeOffset.UtcNow.Add(lifetime ?? ReadLifetime),
            ContentType = contentType,
            ContentDisposition = attachmentName is null ? null : Disposition(attachmentName),
        };
        sas.SetPermissions(BlobSasPermissions.Read);
        return await SignAsync(key, sas, ct);
    }

    /// <summary>A URL that creates one blob, once, for a few minutes.</summary>
    public async Task<Uri> UploadUrlAsync(string key, TimeSpan? lifetime = null, CancellationToken ct = default)
    {
        var sas = new BlobSasBuilder
        {
            BlobContainerName = Container.Name,
            BlobName = key,
            Resource = "b",
            StartsOn = DateTimeOffset.UtcNow.AddMinutes(-5),
            ExpiresOn = DateTimeOffset.UtcNow.Add(lifetime ?? UploadLifetime),
        };
        sas.SetPermissions(BlobSasPermissions.Create | BlobSasPermissions.Write);
        return await SignAsync(key, sas, ct);
    }

    private async Task<Uri> SignAsync(string key, BlobSasBuilder sas, CancellationToken ct)
    {
        var blob = Blob(key);
        if (!delegation) return blob.GenerateSasUri(sas);
        var delegationKey = await DelegationKeyAsync(ct);
        var query = sas.ToSasQueryParameters(delegationKey, service.AccountName);
        return new UriBuilder(blob.Uri) { Query = query.ToString() }.Uri;
    }

    private async Task<UserDelegationKey> DelegationKeyAsync(CancellationToken ct)
    {
        await keyLock.WaitAsync(ct);
        try
        {
            if (key is null || keyExpires < DateTimeOffset.UtcNow.AddMinutes(30))
            {
                var expires = DateTimeOffset.UtcNow.AddHours(6);
                key = (await service.GetUserDelegationKeyAsync(DateTimeOffset.UtcNow.AddMinutes(-5), expires, ct)).Value;
                keyExpires = expires;
            }
            return key;
        }
        finally
        {
            keyLock.Release();
        }
    }

    /// <summary>
    /// <c>attachment</c> with the name in RFC 5987 form; nothing from the name reaches the
    /// header unescaped.
    /// </summary>
    public static string Disposition(string fileName)
    {
        var ascii = new string(fileName.Select(c => c is >= ' ' and < (char)127 and not '"' and not '\\' and not ';' ? c : '_').ToArray());
        return $"attachment; filename=\"{ascii}\"; filename*=UTF-8''{Uri.EscapeDataString(fileName)}";
    }

    public static string AssetKey(Guid workspaceId, Guid assetId) => $"workspaces/{workspaceId}/assets/{assetId}";

    public static string SnapshotKey(Guid workspaceId, Guid pageId, Guid snapshotId) =>
        $"workspaces/{workspaceId}/pages/{pageId}/snapshots/{snapshotId}";

    public static string ExportKey(Guid workspaceId, Guid exportId) => $"workspaces/{workspaceId}/exports/{exportId}.zip";
}
