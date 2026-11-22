using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using Cgw.Core.Data;
using Cgw.Core.Domains;
using Cgw.Core.Sync;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Cgw.Core.Sites;

/// <summary>The DNS record that proves a host name: its name and its value.</summary>
public sealed record SiteDomainRecordDto(string Name, string Value);

/// <summary>
/// A workspace's host name for its sites (Phase 14, M14.4), as owners and admins see it: proven or
/// not, the record that proves it, the site it is attached to, and its certificate's state.
/// </summary>
public sealed record SiteDomainDto(
    Guid Id,
    string Host,
    SiteDomainRecordDto Record,
    string Target,
    DateTimeOffset? VerifiedAt,
    Guid? PageId,
    string? PageTitle,
    string Certificate,
    DateTimeOffset? CertificateExpiresAt,
    string? CertificateError,
    long Version);

/// <summary>A proven host name as whoever may publish sees it: free, or which page's site it serves.</summary>
public sealed record SiteDomainChoiceDto(string Host, Guid? PageId);

public sealed record NewSiteDomain(string? Host);

/// <summary><c>PUT /pages/{id}/site/domain</c>: a proven host name of the workspace, or null for the slug's address alone.</summary>
public sealed record SiteDomainChoice(string? Host);

/// <summary>A certificate's state: none yet, being made, live, or failed (its reason in <c>CertificateError</c>).</summary>
public static class CertificateStates
{
    public const string None = "none";
    public const string Ordering = "ordering";
    public const string Live = "live";
    public const string Failed = "failed";
}

/// <summary>
/// The rules of a site's host name (decisions, 2026-11-22: Phase 14): lower-case ASCII after IDNA, 4
/// to 253 characters, two labels or more, no wildcard, port or address, never one of the server's own
/// hosts nor <c>localhost</c>; in development and the e2e stack also <c>*.localhost</c>. Proven by a
/// <c>TXT</c> record <c>cgw-verify=&lt;token&gt;</c> at <c>_cashgear-workspace.&lt;host&gt;</c>.
/// </summary>
public static class SiteHosts
{
    public const int MaxDomains = 20;

    /// <summary>The host as kept, or null when it may not name a site.</summary>
    public static string? Normalize(string? input, SitesOptions options)
    {
        if (DomainNames.Ascii(input) is not { } host || host.Length < 4) return null;
        if (host == "localhost") return null;
        if (host.EndsWith(".localhost", StringComparison.Ordinal) && !options.AllowLocalhost) return null;
        return options.OwnHosts.Contains(host) ? null : host;
    }

    public static string RecordName(string host) => "_cashgear-workspace." + host;

    public static string RecordValue(string token) => "cgw-verify=" + token;

    public static bool HasRecord(IEnumerable<string> records, string token) =>
        records.Any(r => string.Equals(r.Trim().Trim('"').Trim(), RecordValue(token), StringComparison.Ordinal));

    public static string NewToken() => AcmeClient.Base64Url(RandomNumberGenerator.GetBytes(16));
}

/// <summary><c>GET /workspaces/{id}/publishing/domains</c>.</summary>
/// <param name="Domains">Every host name, to owners and admins (none to anyone else).</param>
/// <param name="Choices">The proven names a site may be given, to everyone in the workspace.</param>
/// <param name="Target">The name a host name's <c>CNAME</c> points at (the sites' own).</param>
/// <param name="Certificates">Whether this server makes certificates (its ACME settings are set).</param>
public sealed record SiteDomainsDto(IReadOnlyList<SiteDomainDto> Domains, IReadOnlyList<SiteDomainChoiceDto> Choices, string Target, bool Certificates);

/// <summary>
/// A workspace's host names for its sites (Phase 14, M14.4; decisions, 2026-11-22): owners and admins
/// add one, prove it by its <c>TXT</c> record and remove it; whoever may publish a site gives it one
/// (<see cref="PublishingService.SetDomainAsync"/>). Every change takes the workspace's lock and
/// writes a <c>publishing</c> change, so Settings and an open share dialog read them again; each is
/// audited (<c>site.domain.add</c>, <c>.verify</c>, <c>.remove</c>). The worker makes and renews the
/// certificates (<c>SiteCertificateJob</c>); the Sites process serves a name once its certificate is live.
/// </summary>
public sealed class SiteDomainService(CgwDb db, IDomainDns dns, ChangeLog changes, Audit audit, SitesOptions sites, SiteCertificateOptions certificates, TimeProvider clock, ILogger<SiteDomainService> log)
{
    private static Failure? AdminsOnly(Member member) => member.IsAdmin ? null : Failure.Denied("Only an owner or admin manages the workspace's domains");

    public async Task<SiteDomainsDto> ListAsync(Member member, CancellationToken ct = default)
    {
        var rows = await db.SiteDomains.AsNoTracking().OrderBy(d => d.Host).ToListAsync(ct);
        var pages = await PagesAsync(rows.Where(r => r.SiteId is not null).Select(r => r.SiteId!.Value).ToList(), ct);
        var choices = rows.Where(r => r.VerifiedAt is not null)
            .Select(r => new SiteDomainChoiceDto(r.Host, r.SiteId is { } site ? pages.GetValueOrDefault(site).PageId : null)).ToList();
        return new SiteDomainsDto(member.IsAdmin ? rows.Select(r => Dto(r, pages)).ToList() : [], choices, sites.Host, certificates.Offered);
    }

    /// <summary>Each live site's page and title, by its id.</summary>
    private async Task<Dictionary<Guid, (Guid? PageId, string? Title)>> PagesAsync(List<Guid> siteIds, CancellationToken ct)
    {
        if (siteIds.Count == 0) return [];
        return await db.PublishedSites.AsNoTracking().Where(s => siteIds.Contains(s.Id) && s.UnpublishedAt == null)
            .Join(db.Pages, s => s.RootPageId, p => p.Id, (s, p) => new { s.Id, PageId = p.Id, p.Title })
            .ToDictionaryAsync(x => x.Id, x => ((Guid?)x.PageId, (string?)x.Title), ct);
    }

    private SiteDomainDto Dto(SiteDomain row, IReadOnlyDictionary<Guid, (Guid? PageId, string? Title)> pages)
    {
        var page = row.SiteId is { } site ? pages.GetValueOrDefault(site) : default;
        return new SiteDomainDto(row.Id, row.Host, new SiteDomainRecordDto(SiteHosts.RecordName(row.Host), SiteHosts.RecordValue(row.Token)), sites.Host,
            row.VerifiedAt, page.PageId, page.Title, row.Certificate, row.CertificateExpiresAt, row.CertificateError, row.Version);
    }

    private async Task<SiteDomainDto> DtoAsync(SiteDomain row, CancellationToken ct) =>
        Dto(row, await PagesAsync(row.SiteId is { } site ? [site] : [], ct));

    /// <summary>A verified row of another workspace that is not deleted.</summary>
    private IQueryable<SiteDomain> VerifiedElsewhere(Guid workspaceId, string host) =>
        db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(d => d.Host == host && d.VerifiedAt != null && d.WorkspaceId != workspaceId)
            .Where(d => db.Workspaces.Any(w => w.Id == d.WorkspaceId && w.DeletedAt == null));

    public async Task<Result<SiteDomainDto>> AddAsync(Member member, Actor actor, NewSiteDomain? body, CancellationToken ct = default)
    {
        if (AdminsOnly(member) is { } denied) return denied;
        if (SiteHosts.Normalize(body?.Host, sites) is not { } host)
            return Failure.Invalid("host is a host name of yours (4 to 253 characters, two labels or more, no wildcard, port or address, not one of this server's own)");
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        if (await VerifiedElsewhere(member.WorkspaceId, host).AnyAsync(ct))
            return Failure.Conflict(Codes.DomainTaken, "Another workspace has verified this host name");
        if (await db.SiteDomains.AnyAsync(d => d.Host == host, ct)) return Failure.Conflict(Codes.Conflict, "The workspace has this host name already");
        if (await db.SiteDomains.CountAsync(ct) >= SiteHosts.MaxDomains) return Failure.Invalid($"A workspace has at most {SiteHosts.MaxDomains} host names");
        var row = new SiteDomain
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            Host = host,
            Token = SiteHosts.NewToken(),
            CreatedBy = member.UserId,
            CreatedAt = clock.GetUtcNow(),
        };
        db.SiteDomains.Add(row);
        audit.Add(actor, "site.domain.add", member.WorkspaceId, "workspace", member.WorkspaceId, new { host });
        changes.Add(SiteRules.PublishingChange, member.WorkspaceId, "upsert", 1, member.UserId);
        try
        {
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is SqlException { Number: 2601 or 2627 })
        {
            return Failure.Conflict(Codes.Conflict, "The workspace has this host name already");
        }
        return await DtoAsync(row, ct);
    }

    /// <summary>The name's <c>TXT</c> record read now: <c>cgw-verify=&lt;token&gt;</c> at <c>_cashgear-workspace.&lt;host&gt;</c>.</summary>
    public async Task<Result<SiteDomainDto>> VerifyAsync(Member member, Actor actor, Guid id, CancellationToken ct = default)
    {
        if (AdminsOnly(member) is { } denied) return denied;
        var found = await db.SiteDomains.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id, ct);
        if (found is null) return Failure.NotFound("No such host name");
        if (found.VerifiedAt is not null) return await DtoAsync(found, ct);
        if (await VerifiedElsewhere(member.WorkspaceId, found.Host).AnyAsync(ct))
            return Failure.Conflict(Codes.DomainTaken, "Another workspace has verified this host name");
        IReadOnlyList<string> records;
        try
        {
            records = await dns.TxtAsync(SiteHosts.RecordName(found.Host), ct);
        }
        catch (DomainDnsException e)
        {
            log.LogWarning("A site's host name: DNS could not be read for {Host}: {Reason}", found.Host, e.Message);
            return new Failure(Codes.DomainDnsNotFound, 400, "DNS could not be read just now: try again in a minute");
        }
        if (!SiteHosts.HasRecord(records, found.Token))
            return new Failure(Codes.DomainDnsNotFound, 400,
                $"No TXT record {SiteHosts.RecordValue(found.Token)} at {SiteHosts.RecordName(found.Host)} yet (DNS can take a while to show a new record)");
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var row = await db.SiteDomains.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (row is null) return Failure.NotFound("No such host name");
        if (row.VerifiedAt is not null) return await DtoAsync(row, ct);
        // A deleted workspace's hold on the name ends here.
        await db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(d => d.Host == row.Host && d.VerifiedAt != null && d.WorkspaceId != member.WorkspaceId)
            .Where(d => db.Workspaces.Any(w => w.Id == d.WorkspaceId && w.DeletedAt != null))
            .ExecuteDeleteAsync(ct);
        var now = clock.GetUtcNow();
        row.VerifiedAt = now;
        row.VerifiedBy = member.UserId;
        row.ProofCheckedAt = now;
        row.Version++;
        audit.Add(actor, "site.domain.verify", member.WorkspaceId, "workspace", member.WorkspaceId, new { host = row.Host });
        changes.Add(SiteRules.PublishingChange, member.WorkspaceId, "upsert", 1, member.UserId);
        try
        {
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // Another workspace verified it at the same moment (the filtered unique index).
            return Failure.Conflict(Codes.DomainTaken, "Another workspace has verified this host name");
        }
        return await DtoAsync(row, ct);
    }

    /// <summary>Removed at once: the site it served goes back to its slug's address; the worker deletes its certificate.</summary>
    public async Task<Result<bool>> RemoveAsync(Member member, Actor actor, Guid id, CancellationToken ct = default)
    {
        if (AdminsOnly(member) is { } denied) return denied;
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var row = await db.SiteDomains.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (row is null) return Failure.NotFound("No such host name");
        db.SiteDomains.Remove(row);
        audit.Add(actor, "site.domain.remove", member.WorkspaceId, "workspace", member.WorkspaceId, new { host = row.Host, wasVerified = row.VerifiedAt is not null, siteId = row.SiteId });
        changes.Add(SiteRules.PublishingChange, member.WorkspaceId, "upsert", 1, member.UserId);
        if (row.SiteId is { } site && await db.PublishedSites.AsNoTracking().Where(s => s.Id == site).Select(s => (Guid?)s.RootPageId).FirstOrDefaultAsync(ct) is { } page)
            changes.Add(SiteRules.SiteChange, page, "upsert", 1, member.UserId);
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }
}
