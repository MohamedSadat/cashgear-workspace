using System.Data;
using Cgw.Core.Data;
using Cgw.Core.Sharing;
using Cgw.Core.Sync;
using Cgw.Core.Workbooks;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sites;

/// <summary>A live site (the streams contract's <c>SiteDto</c>): its address, its settings, who published it and when.</summary>
public sealed record SiteDto(
    Guid Id,
    Guid PageId,
    string Slug,
    string Url,
    bool Indexing,
    string Language,
    long Version,
    DateTimeOffset PublishedAt,
    UserRefDto PublishedBy,
    DateTimeOffset UpdatedAt);

/// <summary>A page that is (or would be) published: parents first, the root's parent null.</summary>
public sealed record SitePageDto(Guid Id, string Title, string? Icon, Guid? ParentPageId);

/// <summary>
/// <c>GET /pages/{id}/site</c>: the page's live site (or null), whether it may be published now and
/// why not (<c>private</c>, <c>off</c>, <c>trashed</c>; a client says <c>local</c> itself), what
/// is (or would be) published, and how many pages of the subtree are left out (never their titles).
/// </summary>
public sealed record PageSiteDto(SiteDto? Site, bool Publishable, string? Reason, IReadOnlyList<SitePageDto> Pages, int LeftOut);

/// <summary><c>PUT /pages/{id}/site</c>: publish, or change a live site's slug, indexing or language.</summary>
public sealed record SiteRequest(string Slug, bool Indexing, string Language);

/// <summary>A live site in the workspace's list, with its page's title and icon.</summary>
public sealed record WorkspaceSiteDto(
    Guid Id,
    Guid PageId,
    string Slug,
    string Url,
    bool Indexing,
    string Language,
    long Version,
    DateTimeOffset PublishedAt,
    UserRefDto PublishedBy,
    DateTimeOffset UpdatedAt,
    string PageTitle,
    string? PageIcon);

/// <summary><c>GET</c> and <c>PUT /workspaces/{id}/publishing</c>: the switch, and (to owners and admins) every live site.</summary>
public sealed record PublishingDto(bool Enabled, IReadOnlyList<WorkspaceSiteDto> Sites);

public sealed record PublishingUpdate(bool Enabled);

/// <summary>
/// Publishing (Phase 9, M9.1; DECISIONS.md, 2026-11-17): someone with <c>full</c> on a page in a
/// shared section publishes it and its subtree as a site, while the workspace's switch is on; a
/// row is never a site's root. What a site shows is decided when it is read (the Sites process,
/// by a share link's rules); this keeps the record: one live site a page, a live slug unique across
/// every workspace, every change raising its version, each publish, change and unpublish audited
/// (<c>site.publish</c>, <c>site.update</c>, <c>site.unpublish</c> with its reason). The switch
/// (<c>workspace.publishing</c>) turned off unpublishes every live site of the workspace at once;
/// turned on again it brings none back. Every write takes the workspace's lock, so a publish never
/// lands after the switch went off.
/// </summary>
public sealed class PublishingService(CgwDb db, SharedReader reader, ChangeLog changes, Audit audit, SitesOptions sites, TimeProvider clock)
{
    public static string Etag(long version) => $"\"{version}\"";

    private static Failure Off() => new(Codes.PublishingOff, 403, "Publishing is turned off for this workspace");

    public async Task<PublishedSite?> LiveAsync(Guid pageId, CancellationToken ct = default) =>
        await db.PublishedSites.AsNoTracking().FirstOrDefaultAsync(s => s.RootPageId == pageId && s.UnpublishedAt == null, ct);

    private async Task<SiteDto> DtoAsync(PublishedSite site, CancellationToken ct)
    {
        var people = await People.RefsAsync(db, [site.PublishedBy], ct);
        var by = People.Of(people, site.PublishedBy);
        return new SiteDto(site.Id, site.RootPageId, site.Slug, sites.SiteUrl(site.Slug), site.Indexing, site.Language, site.Version, site.PublishedAt,
            new UserRefDto(by.Id, by.Name), site.UpdatedAt);
    }

    /// <summary>What may and would be published of a page (full on it; the route checks).</summary>
    public async Task<Result<PageSiteDto>> PageAsync(Page page, CancellationToken ct = default)
    {
        if (page.Kind == PageKinds.Row) return Failure.Invalid("A row has its database's access; publish the database or a page that holds it");
        var site = await LiveAsync(page.Id, ct);
        var section = await db.Sections.AsNoTracking().FirstOrDefaultAsync(s => s.Id == page.SectionId, ct);
        var enabled = await db.Workspaces.AsNoTracking().Where(w => w.Id == page.WorkspaceId).Select(w => w.PublishingEnabled).FirstAsync(ct);
        string? reason = section is null || section.Visibility == "private" ? "private"
            : page.TrashedAt is not null ? "trashed"
            : !enabled ? "off"
            : null;
        var scope = reason is "private" or "trashed" ? null : await reader.ScopeAsync(page.Id, ct);
        var pages = scope?.Pages.Select(p => new SitePageDto(p.Id, p.Title, p.Icon, p.Id == scope.Root.Id ? null : p.ParentPageId)).ToList() ?? [];
        return new PageSiteDto(site is null ? null : await DtoAsync(site, ct), reason is null, reason, pages, scope?.LeftOut ?? 0);
    }

    /// <summary>
    /// Publishes the page, or changes its live site. <paramref name="ifVersion"/> is an optional
    /// <c>If-Match</c> on the live site's version (a conflict when it is stale, or when there is no
    /// live site to match).
    /// </summary>
    public async Task<Result<SiteDto>> PutAsync(Member member, Actor actor, Page page, string level, SiteRequest? request, long? ifVersion, CancellationToken ct = default)
    {
        if (level != Levels.Full) return Failure.Denied("Publishing this page needs full access");
        if (page.Kind == PageKinds.Row) return Failure.Invalid("A row has its database's access; publish the database or a page that holds it");
        if (request is null) return Failure.Invalid("Send slug, indexing and language");
        if (SiteRules.SlugProblem(request.Slug) is { } problem) return Failure.Invalid(problem);
        if (!SiteRules.IsLanguage(request.Language)) return Failure.Invalid("language is en or ar");
        var section = await db.Sections.AsNoTracking().FirstOrDefaultAsync(s => s.Id == page.SectionId, ct);
        if (section is null || section.Visibility == "private") return Failure.Invalid("Pages in a private section are not published; move the page to a shared section first");

        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId, ct);
        if (!workspace.PublishingEnabled) return Off();
        var current = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == page.Id && p.DeletedAt == null, ct);
        if (current is null) return Failure.NotFound("No such page");
        if (current.TrashedAt is not null) return Failure.Conflict(Codes.Conflict, "The page is in the trash");
        var site = await db.PublishedSites.FirstOrDefaultAsync(s => s.RootPageId == page.Id && s.UnpublishedAt == null, ct);
        if (ifVersion is { } expected && expected != site?.Version)
            return Failure.Conflict(Codes.VersionConflict, site is null ? "The page has no live site" : $"The site is at version {site.Version}");
        var taken = await db.PublishedSites.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .AnyAsync(s => s.Slug == request.Slug && s.UnpublishedAt == null && s.RootPageId != page.Id, ct);
        if (taken) return SlugTaken();
        var now = clock.GetUtcNow();
        if (site is null)
        {
            site = new PublishedSite
            {
                Id = Guid.CreateVersion7(),
                WorkspaceId = member.WorkspaceId,
                RootPageId = page.Id,
                Slug = request.Slug,
                Indexing = request.Indexing,
                Language = request.Language,
                Version = 1,
                PublishedBy = member.UserId,
                PublishedAt = now,
                UpdatedAt = now,
            };
            db.PublishedSites.Add(site);
            audit.Add(actor, "site.publish", member.WorkspaceId, "page", page.Id, new { siteId = site.Id, site.Slug, site.Indexing, site.Language });
        }
        else
        {
            if (site.Slug == request.Slug && site.Indexing == request.Indexing && site.Language == request.Language)
            {
                await tx.RollbackAsync(ct);
                return await DtoAsync(site, ct);
            }
            audit.Add(actor, "site.update", member.WorkspaceId, "page", page.Id, new
            {
                siteId = site.Id,
                from = new { site.Slug, site.Indexing, site.Language },
                to = new { request.Slug, request.Indexing, request.Language },
            });
            site.Slug = request.Slug;
            site.Indexing = request.Indexing;
            site.Language = request.Language;
            site.Version++;
            site.UpdatedAt = now;
        }
        changes.Add(SiteRules.SiteChange, page.Id, "upsert", site.Version, member.UserId);
        try
        {
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is SqlException { Number: 2601 or 2627 } sql)
        {
            // The filtered unique indexes: a slug another site took meanwhile, or a second live site
            // for the page from a publish that raced this one.
            return sql.Message.Contains("IX_PublishedSites_LiveSlug", StringComparison.Ordinal)
                ? SlugTaken()
                : Failure.Conflict(Codes.VersionConflict, "The page was published meanwhile");
        }
        catch (DbUpdateConcurrencyException)
        {
            return Failure.Conflict(Codes.VersionConflict, "The site changed meanwhile");
        }
        return await DtoAsync(site, ct);
    }

    private static Failure SlugTaken() => new(Codes.SlugTaken, 409, "Another site has this address");

    /// <summary>Unpublishes the page's live site at once (full on the page); 404 when none is live.</summary>
    public async Task<Result<bool>> DeleteAsync(Member member, Actor actor, Page page, string level, CancellationToken ct = default)
    {
        if (level != Levels.Full) return Failure.Denied("Unpublishing this page needs full access");
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await changes.LockAsync(member.WorkspaceId, ct);
        var site = await db.PublishedSites.FirstOrDefaultAsync(s => s.RootPageId == page.Id && s.UnpublishedAt == null, ct);
        if (site is null) return Failure.NotFound("The page is not published");
        Unpublish(site, member.UserId, SiteRules.ReasonPerson);
        audit.Add(actor, "site.unpublish", member.WorkspaceId, "page", page.Id, new { siteId = site.Id, site.Slug, reason = SiteRules.ReasonPerson });
        changes.Add(SiteRules.SiteChange, page.Id, "delete", site.Version, member.UserId);
        await db.SaveChangesAsync(ct);
        await changes.FlushAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }

    private void Unpublish(PublishedSite site, Guid? by, string reason)
    {
        var now = clock.GetUtcNow();
        site.UnpublishedAt = now;
        site.UnpublishedBy = by;
        site.UnpublishReason = reason;
        site.Version++;
        site.UpdatedAt = now;
    }

    // The workspace's switch -----------------------------------------------------------------------------

    /// <summary>The switch, and every live site to an owner or admin (nothing else to anyone else).</summary>
    public async Task<PublishingDto> WorkspaceAsync(Member member, CancellationToken ct = default)
    {
        var enabled = await db.Workspaces.AsNoTracking().Where(w => w.Id == member.WorkspaceId).Select(w => w.PublishingEnabled).FirstAsync(ct);
        if (!member.IsAdmin) return new PublishingDto(enabled, []);
        var live = await db.PublishedSites.AsNoTracking().Where(s => s.UnpublishedAt == null)
            .Join(db.Pages, s => s.RootPageId, p => p.Id, (s, p) => new { Site = s, p.Title, p.Icon })
            .ToListAsync(ct);
        var people = await People.RefsAsync(db, live.Select(l => l.Site.PublishedBy), ct);
        return new PublishingDto(enabled, live
            .OrderBy(l => l.Site.Slug, StringComparer.Ordinal)
            .Select(l =>
            {
                var by = People.Of(people, l.Site.PublishedBy);
                return new WorkspaceSiteDto(l.Site.Id, l.Site.RootPageId, l.Site.Slug, sites.SiteUrl(l.Site.Slug), l.Site.Indexing, l.Site.Language, l.Site.Version,
                    l.Site.PublishedAt, new UserRefDto(by.Id, by.Name), l.Site.UpdatedAt, l.Title, l.Icon);
            }).ToList());
    }

    /// <summary>
    /// Turns the switch (owners and admins). Off: every live site of the workspace is unpublished
    /// in the same transaction, each audited with reason <c>publishing.off</c>. On: none comes back.
    /// </summary>
    public async Task<Result<PublishingDto>> SetAsync(Member member, Actor actor, PublishingUpdate? request, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin turns publishing on or off");
        if (request is null) return Failure.Invalid("Send enabled");
        db.ChangeTracker.Clear();
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            await changes.LockAsync(member.WorkspaceId, ct);
            var workspace = await db.Workspaces.FirstAsync(w => w.Id == member.WorkspaceId, ct);
            if (workspace.PublishingEnabled != request.Enabled)
            {
                workspace.PublishingEnabled = request.Enabled;
                var taken = 0;
                if (!request.Enabled)
                    foreach (var site in await db.PublishedSites.Where(s => s.UnpublishedAt == null).ToListAsync(ct))
                    {
                        Unpublish(site, member.UserId, SiteRules.ReasonPublishingOff);
                        audit.Add(actor, "site.unpublish", member.WorkspaceId, "page", site.RootPageId, new { siteId = site.Id, site.Slug, reason = SiteRules.ReasonPublishingOff });
                        changes.Add(SiteRules.SiteChange, site.RootPageId, "delete", site.Version, member.UserId);
                        taken++;
                    }
                audit.Add(actor, "workspace.publishing", member.WorkspaceId, "workspace", member.WorkspaceId, new { enabled = request.Enabled, unpublished = taken });
                changes.Add(SiteRules.PublishingChange, member.WorkspaceId, "upsert", 1, member.UserId);
                await db.SaveChangesAsync(ct);
                await changes.FlushAsync(ct);
            }
            await tx.CommitAsync(ct);
        }
        return await WorkspaceAsync(member, ct);
    }

    /// <summary>
    /// The worker's purge of a page deleted for good: its live site (no one can reach the page to
    /// unpublish it any more) is unpublished, so its slug is free again. Call in the purge's transaction.
    /// </summary>
    public static async Task UnpublishDeletedAsync(CgwDb db, Guid pageId, DateTimeOffset now, CancellationToken ct)
    {
        foreach (var site in await db.PublishedSites.Where(s => s.RootPageId == pageId && s.UnpublishedAt == null).ToListAsync(ct))
        {
            site.UnpublishedAt = now;
            site.UnpublishReason = SiteRules.ReasonPageDeleted;
            site.Version++;
            site.UpdatedAt = now;
            new Audit(db).Add(Actor.System, "site.unpublish", site.WorkspaceId, "page", pageId, new { siteId = site.Id, site.Slug, reason = SiteRules.ReasonPageDeleted });
        }
        await db.SaveChangesAsync(ct);
    }
}
