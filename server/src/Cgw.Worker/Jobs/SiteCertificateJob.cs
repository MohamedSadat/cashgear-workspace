using System.Data;
using System.Net;
using System.Security.Cryptography;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Domains;
using Cgw.Core.Sites;
using Cgw.Core.Sync;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Phase 14 (M14.4; decisions, 2026-11-22): every proven host name that serves a site gets a
/// certificate by ACME (HTTP-01, the Sites process answering the challenge from the database) into
/// <c>Sites__CertificateStore</c>, where the IIS host's scheduled task binds it by name
/// (<c>deploy/iis/site-bindings.ps1</c>), renewed once a third of its lifetime is left, or at once
/// when it came from a directory other than <c>Sites__Acme__Directory</c> (after 0.18.0: a switch
/// from Let's Encrypt's staging to its production replaces every staging certificate). Before each
/// order, and once a day, the name's <c>TXT</c> record is read again: missing on two reads a day
/// apart, the name is taken off its site, stops serving and its certificate is deleted (audited
/// <c>site.domain</c>, reason <c>proof.lost</c>). A name must lead to the sites' own addresses before an
/// order is made. A failed order is tried again after 1 h, 6 h, then daily (or as the directory's
/// <c>Retry-After</c> says). The store's files of names no workspace holds are deleted. Each change of
/// state writes a <c>publishing</c> change. Without its settings (SiteCertificateOptions) it does nothing.
/// </summary>
public sealed class SiteCertificateJob(SiteCertificateOptions options, SitesOptions sites, IDomainDns dns, IDataProtectionProvider protection, TimeProvider clock, ILogger<SiteCertificateJob> log) : IJob
{
    public const string KeyPurpose = "Cgw.Sites.AcmeKey.v1";
    private const int Batch = 5;
    public static readonly TimeSpan ProofEvery = TimeSpan.FromDays(1);

    public string Name => "siteCertificates";
    public TimeSpan Interval => options.Interval;
    public bool OwnLoop => true;

    /// <summary>The HTTP client the ACME directory is asked through (a test's own handler, else a plain one).</summary>
    public HttpMessageHandler? Handler { get; init; }

    /// <summary>A test's own names: only these are seen (other tests' names beside them are left alone).</summary>
    public IReadOnlyCollection<string>? Only { get; init; }

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        if (!options.Configured) return false;
        var db = services.GetRequiredService<CgwDb>();
        var now = clock.GetUtcNow();
        var directory = options.Directory!.ToString();
        var domains = db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.VerifiedAt != null && db.Workspaces.Any(w => w.Id == d.WorkspaceId && w.DeletedAt == null));
        if (Only is { } only) domains = domains.Where(d => only.Contains(d.Host));
        // Due: no live certificate, a third of its life left, or one from another directory (a switch
        // from staging to production); one ordered before the directory was kept waits for its renewal.
        var due = await domains
            .Where(d => d.SiteId != null && (d.CertificateNextAttemptAt == null || d.CertificateNextAttemptAt <= now)
                && (d.Certificate != CertificateStates.Live || d.CertificateRenewAt <= now
                    || (d.CertificateDirectory != null && d.CertificateDirectory != directory)))
            .OrderBy(d => d.CertificateNextAttemptAt).Take(Batch).Select(d => d.Id).ToListAsync(ct);
        foreach (var id in due) await OrderAsync(db, id, ct);
        // A name that serves a site keeps its proof: read again once a day.
        var stale = now - ProofEvery;
        var proofs = await domains.Where(d => d.SiteId != null && (d.ProofCheckedAt == null || d.ProofCheckedAt < stale))
            .OrderBy(d => d.ProofCheckedAt).Take(Batch).Select(d => d.Id).ToListAsync(ct);
        foreach (var id in proofs.Except(due)) await ProofAsync(db, id, ct);
        if (Only is null) CleanStore(await db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.VerifiedAt != null && d.Certificate == CertificateStates.Live).Select(d => d.Host).ToListAsync(ct));
        return due.Count == Batch;
    }

    /// <summary>The row, tracked, in its workspace's scope.</summary>
    private static async Task<SiteDomain?> RowAsync(CgwDb db, Guid id, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        var row = await db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant]).FirstOrDefaultAsync(d => d.Id == id, ct);
        if (row is not null) db.Scope.Switch(row.WorkspaceId);
        return row;
    }

    /// <summary>Saves the row with a <c>publishing</c> change, under the workspace's lock.</summary>
    private async Task SaveAsync(CgwDb db, SiteDomain row, CancellationToken ct, Action<Audit>? audit = null)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var changes = new ChangeLog(db, clock);
        await changes.LockAsync(row.WorkspaceId, ct);
        row.Version++;
        audit?.Invoke(new Audit(db));
        changes.Add(SiteRules.PublishingChange, row.WorkspaceId, "upsert", 1, null);
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>
    /// The proof read again: present, its time noted; missing, noted, and on the second read a day or
    /// more after the first the name leaves its site and its certificate goes. False when it is gone.
    /// </summary>
    private async Task<bool> ProofAsync(CgwDb db, Guid id, CancellationToken ct)
    {
        if (await RowAsync(db, id, ct) is not { } row) return false;
        var now = clock.GetUtcNow();
        bool held;
        try
        {
            held = SiteHosts.HasRecord(await dns.TxtAsync(SiteHosts.RecordName(row.Host), ct), row.Token);
        }
        catch (DomainDnsException e)
        {
            // DNS that does not answer proves nothing either way: asked again at the next pass.
            log.LogWarning("A site's host name: DNS could not be read for {Host}: {Reason}", row.Host, e.Message);
            return true;
        }
        row.ProofCheckedAt = now;
        if (held)
        {
            row.ProofMissingSince = null;
            await SaveAsync(db, row, ct);
            return true;
        }
        row.ProofMissingSince ??= now;
        if (now - row.ProofMissingSince < ProofEvery)
        {
            await SaveAsync(db, row, ct);
            return true;
        }
        var host = row.Host;
        var site = row.SiteId;
        row.SiteId = null;
        row.AttachedBy = null;
        row.AttachedAt = null;
        row.VerifiedAt = null;
        row.VerifiedBy = null;
        row.Certificate = CertificateStates.None;
        row.CertificateExpiresAt = null;
        row.CertificateRenewAt = null;
        row.CertificateThumbprint = null;
        row.CertificateDirectory = null;
        await SaveAsync(db, row, ct, audit => audit.Add(Actor.System, "site.domain", row.WorkspaceId, "workspace", row.WorkspaceId, new { host, siteId = site, reason = "proof.lost" }));
        Delete(host);
        return false;
    }

    /// <summary>Whether the name leads to the sites' own addresses (any one of them), so ACME's validator reaches this host.</summary>
    private async Task<bool> PointedAsync(string host, CancellationToken ct)
    {
        if (sites.AllowLocalhost && host.EndsWith(".localhost", StringComparison.Ordinal)) return true;
        var ours = await dns.AddressesAsync(sites.Host, ct);
        if (ours.Count == 0 && sites.AllowLocalhost) ours = [IPAddress.Loopback, IPAddress.IPv6Loopback];
        var theirs = await dns.AddressesAsync(host, ct);
        return theirs.Any(ours.Contains);
    }

    private async Task OrderAsync(CgwDb db, Guid id, CancellationToken ct)
    {
        if (!await ProofAsync(db, id, ct)) return;
        if (await RowAsync(db, id, ct) is not { } row) return;
        try
        {
            if (!await PointedAsync(row.Host, ct))
            {
                await FailAsync(db, row, "notPointed", null, ct);
                return;
            }
        }
        catch (DomainDnsException)
        {
            await FailAsync(db, row, "dns", null, ct);
            return;
        }
        if (row.Certificate != CertificateStates.Live)
        {
            row.Certificate = CertificateStates.Ordering;
            await SaveAsync(db, row, ct);
        }
        var host = row.Host;
        var directory = options.Directory!.ToString();
        if (row.Certificate == CertificateStates.Live && row.CertificateDirectory is { } from && from != directory)
            log.LogInformation("A site's host name: {Host}'s live certificate came from {From}: ordered anew from {Directory}", host, from, directory);
        try
        {
            using var http = Handler is null ? new HttpClient() : new HttpClient(Handler, disposeHandler: false);
            http.Timeout = TimeSpan.FromSeconds(30);
            using var key = await AccountKeyAsync(db, ct);
            var client = new AcmeClient(http, options.Directory!, key.Key, clock) { AccountUrl = key.Url };
            if (client.AccountUrl is null) await NewAccountAsync(db, client, key.Key, ct);
            var made = await client.CertificateAsync(host, options.Password!,
                (token, answer) => ChallengeAsync(db, id, token, answer, ct),
                () => ChallengeAsync(db, id, null, null, CancellationToken.None), ct);
            Write(host, made.Pfx);
            if (await RowAsync(db, id, ct) is not { } done) return;
            done.Certificate = CertificateStates.Live;
            done.CertificateExpiresAt = made.NotAfter;
            done.CertificateRenewAt = made.NotBefore + (made.NotAfter - made.NotBefore) * 2 / 3;
            done.CertificateNextAttemptAt = null;
            done.CertificateAttempts = 0;
            done.CertificateError = null;
            done.CertificateThumbprint = made.Thumbprint;
            done.CertificateDirectory = directory;
            await SaveAsync(db, done, ct, audit => audit.Add(Actor.System, "site.domain.certificate", done.WorkspaceId, "workspace", done.WorkspaceId,
                new { host, expires = made.NotAfter, thumbprint = made.Thumbprint, directory }));
            log.LogInformation("A site's host name: a certificate for {Host} until {Expires}", host, made.NotAfter);
        }
        catch (AcmeException e)
        {
            log.LogWarning("A site's host name: no certificate for {Host}: {Type} {Detail}", host, e.Type, e.Message);
            if (await RowAsync(db, id, ct) is { } failed) await FailAsync(db, failed, Code(e.Type), e.RetryAfter, ct);
        }
    }

    /// <summary>The error a person is shown, from ACME's problem type.</summary>
    public static string Code(string type) => type switch
    {
        "unreachable" => "unreachable",
        "rateLimited" => "rateLimited",
        "incorrectResponse" or "connection" or "unauthorized" or "dns" or "tls" or "caa" => "challenge",
        "rejectedIdentifier" => "rejected",
        "userActionRequired" => "terms",
        _ => "failed",
    };

    private async Task FailAsync(CgwDb db, SiteDomain row, string code, TimeSpan? retryAfter, CancellationToken ct)
    {
        row.CertificateAttempts++;
        var wait = row.CertificateAttempts switch { 1 => TimeSpan.FromHours(1), 2 => TimeSpan.FromHours(6), _ => TimeSpan.FromDays(1) };
        if (retryAfter is { } after && after > wait) wait = after;
        row.CertificateNextAttemptAt = clock.GetUtcNow() + wait;
        row.CertificateError = code;
        // A live certificate stays live while its renewal fails; it serves until it ends.
        if (row.Certificate != CertificateStates.Live) row.Certificate = CertificateStates.Failed;
        row.ChallengeToken = null;
        row.ChallengeAnswer = null;
        await SaveAsync(db, row, ct);
    }

    /// <summary>The token and answer the Sites process gives ACME's validator, set while an order lasts (null to clear).</summary>
    private static async Task ChallengeAsync(CgwDb db, Guid id, string? token, string? answer, CancellationToken ct)
    {
        await db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant]).Where(d => d.Id == id)
            .ExecuteUpdateAsync(u => u.SetProperty(d => d.ChallengeToken, token).SetProperty(d => d.ChallengeAnswer, answer), ct);
    }

    private sealed record AccountKey(ECDsa Key, string? Url) : IDisposable
    {
        public void Dispose() => Key.Dispose();
    }

    /// <summary>The directory's account key: kept as Data Protection's output, made on first use.</summary>
    private async Task<AccountKey> AccountKeyAsync(CgwDb db, CancellationToken ct)
    {
        var directory = options.Directory!.ToString();
        var row = await db.AcmeAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.Directory == directory, ct);
        var key = ECDsa.Create();
        if (row is null)
        {
            key.Dispose();
            return new AccountKey(AcmeClient.NewAccountKey(), null);
        }
        key.ImportPkcs8PrivateKey(Convert.FromBase64String(protection.CreateProtector(KeyPurpose).Unprotect(row.KeyCipher)), out _);
        return new AccountKey(key, row.AccountUrl);
    }

    /// <summary>The account made at the directory (its terms agreed by whoever set AgreeToTerms) and kept.</summary>
    private async Task NewAccountAsync(CgwDb db, AcmeClient client, ECDsa key, CancellationToken ct)
    {
        var url = await client.AccountAsync(options.Email, ct);
        db.ChangeTracker.Clear();
        db.AcmeAccounts.Add(new AcmeAccount
        {
            Directory = options.Directory!.ToString(),
            KeyCipher = protection.CreateProtector(KeyPurpose).Protect(Convert.ToBase64String(key.ExportPkcs8PrivateKey())),
            AccountUrl = url,
            CreatedAt = clock.GetUtcNow(),
        });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The PFX written whole (a temporary file moved over the old), so IIS never reads half of one.</summary>
    private void Write(string host, byte[] pfx)
    {
        Directory.CreateDirectory(options.Store!);
        var path = options.FileOf(host);
        var temporary = path + ".tmp";
        File.WriteAllBytes(temporary, pfx);
        File.Move(temporary, path, overwrite: true);
    }

    private void Delete(string host)
    {
        try
        {
            File.Delete(options.FileOf(host));
        }
        catch (IOException e)
        {
            log.LogWarning("A site's host name: the certificate of {Host} was not deleted: {Reason}", host, e.Message);
        }
    }

    /// <summary>The store's certificates of names no workspace holds with a live certificate: deleted.</summary>
    private void CleanStore(IReadOnlyCollection<string> live)
    {
        if (!Directory.Exists(options.Store)) return;
        var keep = new HashSet<string>(live, StringComparer.OrdinalIgnoreCase);
        foreach (var file in Directory.EnumerateFiles(options.Store!, "*.pfx"))
            if (!keep.Contains(Path.GetFileNameWithoutExtension(file))) Delete(Path.GetFileNameWithoutExtension(file));
    }
}
