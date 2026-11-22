using System.Data;
using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Identity;

/// <summary>A domain's <c>TXT</c> record, as its owners add it at their DNS host.</summary>
public sealed record SsoRecordDto(string Name, string Value);
public sealed record SsoDomainDto(string Domain, SsoRecordDto Record, DateTimeOffset? VerifiedAt, bool Required);
/// <summary>The provider as owners see it: never its secret, only whether one is set.</summary>
public sealed record SsoProviderDto(string Issuer, string ClientId, bool HasSecret, bool JoinAsMember, int SessionHours, DateTimeOffset? TestedAt, long Version);
/// <param name="RedirectUri">What an owner registers at their provider: <c>{Api__PublicUrl}/account/sso/callback</c>.</param>
public sealed record SsoSettingsDto(IReadOnlyList<SsoDomainDto> Domains, SsoProviderDto? Provider, string RedirectUri);
public sealed record NewSsoDomain(string? Domain);
public sealed record SsoDomainUpdate(bool Required);

/// <summary>
/// <c>PUT …/sso/provider</c>'s body: <c>clientSecret</c> a string sets the secret, <c>null</c> removes
/// it, absent keeps it (as the AI keys); <c>joinAsMember</c> and <c>sessionHours</c> absent keep theirs
/// (or the defaults, true and 24, for a new provider).
/// </summary>
public sealed record SsoProviderUpdate
{
    public string? Issuer { get; init; }
    public string? ClientId { get; init; }
    public JsonElement ClientSecret { get; init; }
    public bool? JoinAsMember { get; init; }
    public int? SessionHours { get; init; }
}

/// <summary>
/// Phase 11 (M11.3): a workspace's single sign-on, set by its owners alone (admins and members are
/// refused, whatever the app shows): its email domains, each proven by a DNS <c>TXT</c> record and
/// then the workspace's alone, and its OpenID Connect provider (the issuer read by discovery before
/// it is saved; the client secret under Data Protection, never returned). Required sign-on for a
/// domain needs an owner's sign-in through the provider first, and ends that domain's sessions not
/// made through it, but its owners'. Removing the provider turns every domain's required off.
/// Audited, never with the secret.
/// </summary>
public sealed class SsoSettings(CgwDb db, SsoMetadata metadata, SsoSecrets secrets, Cgw.Core.Domains.IDomainDns dns, SsoOptions options, Devices devices, Audit audit, TimeProvider clock, ILogger<SsoSettings> log)
{
    public const int MaxSessionHours = 720;

    private static Failure? OwnersOnly(Member member) => member.Role == Roles.Owner ? null : Failure.Denied("Only an owner sets up single sign-on");

    private static SsoDomainDto Dto(SsoDomain d) =>
        new(d.Domain, new SsoRecordDto(SsoText.RecordName(d.Domain), SsoText.RecordValue(d.Token)), d.VerifiedAt, d.Required);

    private static SsoProviderDto Dto(SsoProvider p) =>
        new(p.Issuer, p.ClientId, p.SecretCipher is not null, p.JoinAsMember, p.SessionHours, p.TestedAt, p.Version);

    public async Task<Result<SsoSettingsDto>> GetAsync(Member member, string redirectUri, CancellationToken ct = default)
    {
        if (OwnersOnly(member) is { } denied) return denied;
        var domains = await db.SsoDomains.AsNoTracking().OrderBy(d => d.Domain).ToListAsync(ct);
        var provider = await db.SsoProviders.AsNoTracking().FirstOrDefaultAsync(ct);
        return new SsoSettingsDto(domains.Select(Dto).ToList(), provider is null ? null : Dto(provider), redirectUri);
    }

    private Task<SsoDomain?> DomainAsync(string domain, CancellationToken ct) => db.SsoDomains.FirstOrDefaultAsync(d => d.Domain == domain, ct);

    /// <summary>A verified row of another workspace that is not deleted (a deleted one's rows are freed when someone verifies).</summary>
    private IQueryable<SsoDomain> VerifiedElsewhere(Guid workspaceId, string domain) =>
        db.SsoDomains.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(d => d.Domain == domain && d.VerifiedAt != null && d.WorkspaceId != workspaceId)
            .Where(d => db.Workspaces.Any(w => w.Id == d.WorkspaceId && w.DeletedAt == null));

    public async Task<Result<SsoDomainDto>> AddDomainAsync(Member member, Actor actor, NewSsoDomain body, CancellationToken ct = default)
    {
        if (OwnersOnly(member) is { } denied) return denied;
        if (SsoText.Domain(body.Domain) is not { } domain)
            return Failure.Invalid("domain is a domain name (3 to 253 characters, at least one dot, no wildcard)");
        if (await VerifiedElsewhere(member.WorkspaceId, domain).AnyAsync(ct))
            return Failure.Conflict(Codes.SsoDomainTaken, "Another workspace has verified this domain");
        if (await DomainAsync(domain, ct) is not null) return Failure.Conflict(Codes.Conflict, "The workspace has this domain already");
        if (await db.SsoDomains.CountAsync(ct) >= SsoText.MaxDomains) return Failure.Invalid($"A workspace has at most {SsoText.MaxDomains} domains");
        var row = new SsoDomain
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            Domain = domain,
            Token = SsoText.NewToken(),
            CreatedBy = member.UserId,
            CreatedAt = clock.GetUtcNow(),
        };
        db.SsoDomains.Add(row);
        audit.Add(actor, "sso.domain.add", member.WorkspaceId, "workspace", member.WorkspaceId, new { domain });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is SqlException { Number: 2601 or 2627 })
        {
            return Failure.Conflict(Codes.Conflict, "The workspace has this domain already");
        }
        return Dto(row);
    }

    /// <summary>The domain's <c>TXT</c> record read now: <c>cgw-verify=&lt;token&gt;</c> at <c>_cashgear-workspace.&lt;domain&gt;</c>.</summary>
    public async Task<Result<SsoDomainDto>> VerifyAsync(Member member, Actor actor, string domainText, CancellationToken ct = default)
    {
        if (OwnersOnly(member) is { } denied) return denied;
        if (SsoText.Domain(domainText) is not { } domain || await DomainAsync(domain, ct) is not { } row) return Failure.NotFound("No such domain");
        if (row.VerifiedAt is not null) return Dto(row);
        if (await VerifiedElsewhere(member.WorkspaceId, domain).AnyAsync(ct))
            return Failure.Conflict(Codes.SsoDomainTaken, "Another workspace has verified this domain");
        IReadOnlyList<string> records;
        try
        {
            records = await dns.TxtAsync(SsoText.RecordName(domain), ct);
        }
        catch (Cgw.Core.Domains.DomainDnsException e)
        {
            log.LogWarning("Single sign-on: DNS could not be read for {Domain}: {Reason}", domain, e.Message);
            return new Failure(Codes.SsoDnsNotFound, 400, "DNS could not be read just now: try again in a minute");
        }
        if (!SsoText.HasRecord(records, row.Token))
            return new Failure(Codes.SsoDnsNotFound, 400, $"No TXT record {SsoText.RecordValue(row.Token)} at {SsoText.RecordName(domain)} yet (DNS can take a while to show a new record)");
        // A deleted workspace's hold on the domain ends here.
        await db.SsoDomains.IgnoreQueryFilters([CgwDb.Tenant])
            .Where(d => d.Domain == domain && d.VerifiedAt != null && d.WorkspaceId != member.WorkspaceId)
            .Where(d => db.Workspaces.Any(w => w.Id == d.WorkspaceId && w.DeletedAt != null))
            .ExecuteDeleteAsync(ct);
        row.VerifiedAt = clock.GetUtcNow();
        row.VerifiedBy = member.UserId;
        audit.Add(actor, "sso.domain.verify", member.WorkspaceId, "workspace", member.WorkspaceId, new { domain });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // Another workspace verified it at the same moment (the filtered unique index).
            return Failure.Conflict(Codes.SsoDomainTaken, "Another workspace has verified this domain");
        }
        return Dto(row);
    }

    /// <summary>
    /// Turns required sign-on on or off for a verified domain. On needs the provider tested (an
    /// owner's sign-in through it) and ends every session of the domain's accounts not made through
    /// the provider, but the workspace's owners': their devices are revoked, each audited.
    /// </summary>
    public async Task<Result<SsoDomainDto>> SetRequiredAsync(Member member, Actor actor, string domainText, SsoDomainUpdate body, CancellationToken ct = default)
    {
        if (OwnersOnly(member) is { } denied) return denied;
        if (SsoText.Domain(domainText) is not { } domain) return Failure.NotFound("No such domain");
        SsoDomain row;
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            // Under the provider's lock, which removing it takes too: required is never left on
            // with no provider to sign in through.
            await LockProviderAsync(member.WorkspaceId, ct);
            if (await DomainAsync(domain, ct) is not { } found) return Failure.NotFound("No such domain");
            row = found;
            if (row.Required == body.Required) return Dto(row);
            if (body.Required)
            {
                if (row.VerifiedAt is null) return Failure.Invalid("Verify the domain first");
                var provider = await db.SsoProviders.AsNoTracking().FirstOrDefaultAsync(ct);
                if (provider?.TestedAt is null)
                    return new Failure(Codes.SsoNotTested, 400, "An owner signs in through the provider first, so nobody is locked out by a provider that does not work");
            }
            var now = clock.GetUtcNow();
            row.Required = body.Required;
            row.RequiredAt = body.Required ? now : null;
            row.RequiredBy = body.Required ? member.UserId : null;
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        var ended = body.Required ? await EndOtherSessionsAsync(member.WorkspaceId, domain, actor, ct) : 0;
        audit.Add(actor, "sso.domain.require", member.WorkspaceId, "workspace", member.WorkspaceId, new { domain, required = body.Required, sessionsEnded = ended });
        await db.SaveChangesAsync(ct);
        return Dto(row);
    }

    /// <summary>The domain's accounts' sessions not made through this workspace's provider, but its owners': signed out.</summary>
    private async Task<int> EndOtherSessionsAsync(Guid workspaceId, string domain, Actor actor, CancellationToken ct)
    {
        var suffix = "@" + domain.ToUpperInvariant();
        var owners = db.WorkspaceMembers.Where(m => m.Role == Roles.Owner).Select(m => m.UserId);
        var sessions = await db.Devices.AsNoTracking()
            .Where(d => d.RevokedAt == null && (d.SsoWorkspaceId == null || d.SsoWorkspaceId != workspaceId))
            .Join(db.Users.Where(u => u.DeletedAt == null && u.NormalizedEmail!.EndsWith(suffix) && !owners.Contains(u.Id)), d => d.UserId, u => u.Id, (d, u) => new { d.Id, d.UserId })
            .ToListAsync(ct);
        foreach (var session in sessions)
            await devices.RevokeAsync(session.UserId, session.Id, actor);
        return sessions.Count;
    }

    public async Task<Result<bool>> RemoveDomainAsync(Member member, Actor actor, string domainText, CancellationToken ct = default)
    {
        if (OwnersOnly(member) is { } denied) return denied;
        if (SsoText.Domain(domainText) is not { } domain || await DomainAsync(domain, ct) is not { } row) return Failure.NotFound("No such domain");
        db.SsoDomains.Remove(row);
        audit.Add(actor, "sso.domain.remove", member.WorkspaceId, "workspace", member.WorkspaceId, new { domain, wasVerified = row.VerifiedAt is not null, wasRequired = row.Required });
        await db.SaveChangesAsync(ct);
        return true;
    }

    private async Task LockProviderAsync(Guid workspaceId, CancellationToken ct) =>
        await db.Database.ExecuteSqlRawAsync("SELECT 1 FROM [SsoProviders] WITH (UPDLOCK, HOLDLOCK) WHERE [WorkspaceId] = @ws",
            [new SqlParameter("@ws", SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(workspaceId) }], ct);

    /// <summary>
    /// Sets the provider: the issuer's discovery read and checked first (else
    /// <c>sso.discoveryFailed</c>, nothing saved). A changed issuer, client or secret is untested
    /// again. <paramref name="ifVersion"/>: the version the owner saw (a stale one is a conflict).
    /// </summary>
    public async Task<Result<SsoProviderDto>> SetProviderAsync(Member member, Actor actor, SsoProviderUpdate body, long? ifVersion, CancellationToken ct = default)
    {
        if (OwnersOnly(member) is { } denied) return denied;
        var issuer = body.Issuer?.Trim();
        if (!SsoUrls.Issuer(issuer, options.AllowHttp))
            return Failure.Invalid($"issuer is the provider's issuer, an {(options.AllowHttp ? "http or https" : "https")} address of at most 500 characters with no query");
        var clientId = body.ClientId?.Trim();
        if (clientId is not { Length: >= 1 and <= 256 } || !clientId.All(c => c is > ' ' and < '\u007f'))
            return Failure.Invalid("clientId is 1 to 256 visible characters");
        string? newSecret = null;
        var removeSecret = false;
        switch (body.ClientSecret.ValueKind)
        {
            case JsonValueKind.Undefined:
                break;
            case JsonValueKind.Null:
                removeSecret = true;
                break;
            case JsonValueKind.String when SsoSecrets.Plausible(body.ClientSecret.GetString()):
                newSecret = body.ClientSecret.GetString();
                break;
            default:
                return Failure.Invalid("clientSecret is 1 to 500 visible characters, or null to remove it");
        }
        if (body.SessionHours is { } hours && hours is < 1 or > MaxSessionHours) return Failure.Invalid($"sessionHours is 1 to {MaxSessionHours}");

        // Read before any lock: the provider's answer may take seconds.
        var discovery = await metadata.CheckAsync(issuer!, ct);
        if (!discovery.Ok) return discovery.Failure!;

        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await LockProviderAsync(member.WorkspaceId, ct);
        var row = await db.SsoProviders.FirstOrDefaultAsync(ct);
        if (ifVersion is { } expected && (row?.Version ?? 0) != expected)
            return Failure.Conflict(Codes.VersionConflict, "The provider changed meanwhile: read it again");
        // A provider with no secret is a public client: only when the provider takes one.
        var hasSecret = newSecret is not null || (!removeSecret && row?.SecretCipher is not null);
        if (!hasSecret && !discovery.Value!.TokenAuthMethods.Contains("none"))
            return Failure.Invalid("clientSecret is needed: the provider authenticates its clients by a secret");
        var now = clock.GetUtcNow();
        var created = row is null;
        if (row is null)
        {
            row = new SsoProvider { WorkspaceId = member.WorkspaceId, CreatedBy = member.UserId, CreatedAt = now, Version = 0 };
            db.SsoProviders.Add(row);
        }
        var before = created ? null : new { row.Issuer, row.ClientId, HasSecret = row.SecretCipher is not null, row.JoinAsMember, row.SessionHours };
        var secretCipher = newSecret is not null ? secrets.Protect(member.WorkspaceId, newSecret) : removeSecret ? null : row.SecretCipher;
        var changed = created || row.Issuer != issuer || row.ClientId != clientId || newSecret is not null || (removeSecret && row.SecretCipher is not null);
        row.Issuer = issuer!;
        row.ClientId = clientId;
        row.SecretCipher = secretCipher;
        if (body.JoinAsMember is { } join) row.JoinAsMember = join;
        if (body.SessionHours is { } sessionHours) row.SessionHours = sessionHours;
        if (changed)
        {
            // A provider not yet signed in through by an owner; required stays as it was (owners keep their password).
            row.TestedAt = null;
            row.TestedBy = null;
        }
        row.Version++;
        row.UpdatedAt = now;
        row.UpdatedBy = member.UserId;
        audit.Add(actor, "sso.provider.set", member.WorkspaceId, "workspace", member.WorkspaceId, new
        {
            issuer = row.Issuer,
            clientId = row.ClientId,
            secret = newSecret is not null ? "set" : removeSecret ? (before?.HasSecret == true ? "removed" : "none") : "kept",
            joinAsMember = row.JoinAsMember,
            sessionHours = row.SessionHours,
            was = before,
        });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Dto(row);
    }

    /// <summary>Removes the provider; every domain's required turns off at once (its people keep their accounts and may set a password by the reset mail).</summary>
    public async Task<Result<bool>> RemoveProviderAsync(Member member, Actor actor, CancellationToken ct = default)
    {
        if (OwnersOnly(member) is { } denied) return denied;
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await LockProviderAsync(member.WorkspaceId, ct);
        var row = await db.SsoProviders.FirstOrDefaultAsync(ct);
        if (row is null) return Failure.NotFound("No provider is set");
        var required = await db.SsoDomains.Where(d => d.Required).ToListAsync(ct);
        foreach (var domain in required)
        {
            domain.Required = false;
            domain.RequiredAt = null;
            domain.RequiredBy = null;
        }
        db.SsoProviders.Remove(row);
        audit.Add(actor, "sso.provider.remove", member.WorkspaceId, "workspace", member.WorkspaceId, new
        {
            issuer = row.Issuer,
            clientId = row.ClientId,
            requiredTurnedOff = required.Select(d => d.Domain).ToList(),
        });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }
}
