using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Cgw.Core.Assets;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Documents;
using Cgw.Core.Sharing;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sites;

/// <summary>
/// A live site as the Sites process holds it for a while: its record, its scope, and a hash of the
/// scope's names. Phase 14: <c>Base</c>, what its addresses start with (<c>/&lt;slug&gt;</c> on the
/// sites' host, empty at its own host name), and <c>Domain</c>, its host name once that serves it
/// (the slug's addresses then lead there).
/// </summary>
public sealed record SiteState(PublishedSite Site, PageScope Scope, string ScopeHash, IReadOnlyList<Guid> Databases)
{
    public string Base { get; init; } = "/" + Site.Slug;
    public string? Domain { get; init; }
}

/// <summary>A page answered once: its bytes and its strong entity tag.</summary>
public sealed record RenderedPage(byte[] Body, string ETag);

/// <summary>
/// The Sites process's memory (DECISIONS.md, 2026-11-17: caching): each slug's site and scope at
/// most <see cref="Lifetime"/> (so an unpublish, the switch going off, a page moved out of reach
/// holds within it), an unknown slug a few seconds, <c>robots.txt</c> the same 30 s, and pages
/// answered, by a key of everything they are drawn from, bounded by count and bytes.
/// </summary>
public sealed class SiteCache(TimeProvider clock)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan UnknownLifetime = TimeSpan.FromSeconds(5);
    public const int MaxPages = 512;
    public const long MaxBytes = 64L * 1024 * 1024;

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, SiteState? State)> states = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (long Used, RenderedPage Page)> pages = new(StringComparer.Ordinal);
    private (DateTimeOffset At, string Text)? robots;
    private long used;
    private long bytes;

    public DateTimeOffset Now => clock.GetUtcNow();

    public bool TryState(string slug, out SiteState? state)
    {
        state = null;
        if (!states.TryGetValue(slug, out var kept)) return false;
        if (Now - kept.At >= (kept.State is null ? UnknownLifetime : Lifetime))
        {
            states.TryRemove(slug, out _);
            return false;
        }
        state = kept.State;
        return true;
    }

    public void PutState(string slug, SiteState? state)
    {
        if (states.Count > 10_000) states.Clear();
        states[slug] = (Now, state);
    }

    public RenderedPage? Page(string key)
    {
        if (!pages.TryGetValue(key, out var kept)) return null;
        pages[key] = (Interlocked.Increment(ref used), kept.Page);
        return kept.Page;
    }

    public void PutPage(string key, RenderedPage page)
    {
        if (page.Body.Length > MaxBytes / 8) return;
        pages[key] = (Interlocked.Increment(ref used), page);
        var total = Interlocked.Add(ref bytes, page.Body.Length);
        if (pages.Count <= MaxPages && total <= MaxBytes) return;
        // The least recently used go first, until both bounds hold again.
        foreach (var (old, entry) in pages.OrderBy(p => p.Value.Used).ToList())
        {
            if (pages.Count <= MaxPages * 3 / 4 && Interlocked.Read(ref bytes) <= MaxBytes * 3 / 4) break;
            if (old == key) continue;
            if (pages.TryRemove(old, out _)) Interlocked.Add(ref bytes, -entry.Page.Body.Length);
        }
    }

    public string? Robots() => robots is { } kept && Now - kept.At < Lifetime ? kept.Text : null;

    public void PutRobots(string text) => robots = (Now, text);
}

/// <summary>
/// Reading a site for the Sites process (Phase 9): the slug's live site, in a workspace that is
/// not deleted and has publishing on, its root in reach, its scope by a share link's rules
/// (<see cref="SharedReader.ScopeAsync"/>); a page's key, made of everything it is drawn from (the
/// site's version, the page's derived sequence, the scope's names, every database's and view's
/// versions, today); and what drawing it needs, read once.
/// </summary>
public sealed class SiteReader(CgwDb db, SharedReader reader, SharedDatabases databases, SiteCache cache)
{
    /// <summary>The live site a slug names, or null; held at most 30 s.</summary>
    public async Task<SiteState?> StateAsync(string slug, CancellationToken ct = default)
    {
        if (SiteRules.SlugProblem(slug) is not null) return null;
        if (cache.TryState(slug, out var kept))
        {
            if (kept is not null) db.Scope.Enter(kept.Site.WorkspaceId);
            return kept;
        }
        var site = await db.PublishedSites.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .FirstOrDefaultAsync(s => s.Slug == slug && s.UnpublishedAt == null, ct);
        var state = site is null ? null : await ReadStateAsync(site, ct);
        if (state is not null)
            state = state with { Domain = await LiveDomainAsync(site!.Id, ct) };
        cache.PutState(slug, state);
        return state;
    }

    /// <summary>
    /// Phase 14: the live site a host name serves: proven, attached, its certificate live; null for any
    /// other name. Held as long as a slug's.
    /// </summary>
    public async Task<SiteState?> StateByHostAsync(string host, CancellationToken ct = default)
    {
        var key = "host:" + host;
        if (cache.TryState(key, out var kept))
        {
            if (kept is not null) db.Scope.Enter(kept.Site.WorkspaceId);
            return kept;
        }
        var domain = await db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.Host == host && d.VerifiedAt != null && d.SiteId != null && d.Certificate == CertificateStates.Live)
            .Select(d => new { d.SiteId, d.WorkspaceId }).FirstOrDefaultAsync(ct);
        var site = domain is null ? null : await db.PublishedSites.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == domain.SiteId && s.WorkspaceId == domain.WorkspaceId && s.UnpublishedAt == null, ct);
        var state = site is null ? null : await ReadStateAsync(site, ct);
        if (state is not null) state = state with { Base = "", Domain = host };
        cache.PutState(key, state);
        return state;
    }

    /// <summary>The host name that serves this site now, if any.</summary>
    private Task<string?> LiveDomainAsync(Guid siteId, CancellationToken ct) =>
        db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => d.SiteId == siteId && d.VerifiedAt != null && d.Certificate == CertificateStates.Live)
            .Select(d => d.Host).FirstOrDefaultAsync(ct);

    /// <summary>
    /// Phase 14: ACME's HTTP-01 answer for a token of a proven name's order under way (RFC 8555, 8.3),
    /// or null. Never cached: the validator asks a few times while the order lasts. Without a host
    /// (the sites' own host, where the IIS host's port 80 sends ACME's path of a name it does not bind
    /// yet), by the token alone: a token is the CA's random value of at least 128 bits, and its answer
    /// is what the order publishes anyway.
    /// </summary>
    public Task<string?> ChallengeAsync(string? host, string token, CancellationToken ct = default) =>
        db.SiteDomains.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(d => (host == null || d.Host == host) && d.VerifiedAt != null && d.ChallengeToken == token)
            .Select(d => d.ChallengeAnswer).FirstOrDefaultAsync(ct);

    private async Task<SiteState?> ReadStateAsync(PublishedSite site, CancellationToken ct)
    {
        if (!await db.Workspaces.AnyAsync(w => w.Id == site.WorkspaceId && w.DeletedAt == null && w.PublishingEnabled, ct)) return null;
        db.Scope.Enter(site.WorkspaceId);
        var scope = await reader.ScopeAsync(site.RootPageId, ct);
        if (scope is null) return null;
        var names = new StringBuilder();
        foreach (var p in scope.Pages)
            names.Append(p.Id).Append('\u001f').Append(p.ParentPageId).Append('\u001f').Append(p.OrderKey).Append('\u001f').Append(p.Kind).Append('\u001f')
                .Append(p.Title).Append('\u001f').Append(p.Icon).Append('\u001f').Append(p.CoverAssetId).Append('\u001e');
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(names.ToString())));
        return new SiteState(site, scope, hash, scope.Pages.Where(p => p.Kind == PageKinds.Database).Select(p => p.Id).ToList());
    }

    /// <summary>
    /// The key a page's answer is kept by: if any part of what it is drawn from changes, the key does.
    /// A few small reads: the page's derived sequence and the versions of the site's databases and views.
    /// </summary>
    public async Task<string> KeyAsync(SiteState state, Page page, int pageNumber, CancellationToken ct = default)
    {
        var seq = page.Kind == PageKinds.Database
            ? 0
            : await db.PageDocDerived.AsNoTracking().Where(d => d.PageId == page.Id).Select(d => (long?)d.UpToSeq).FirstOrDefaultAsync(ct) ?? -1;
        var versions = new StringBuilder();
        if (state.Databases.Count > 0)
        {
            var ids = state.Databases.ToList();
            foreach (var d in await db.Databases.AsNoTracking().Where(d => ids.Contains(d.PageId)).OrderBy(d => d.PageId)
                         .Select(d => new { d.PageId, d.Version, d.RowsVersion }).ToListAsync(ct))
                versions.Append(d.PageId).Append(':').Append(d.Version).Append(':').Append(d.RowsVersion).Append(';');
            foreach (var v in await db.DatabaseViews.AsNoTracking().Where(v => ids.Contains(v.DatabaseId)).OrderBy(v => v.Id)
                         .Select(v => new { v.Id, v.Version }).ToListAsync(ct))
                versions.Append(v.Id).Append(':').Append(v.Version).Append(';');
        }
        var today = databases.Context(null).Today;
        var dbHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(versions.ToString())));
        return string.Join('|', state.Site.Id, state.Site.Version, state.Base, page.Id, seq, state.ScopeHash, dbHash, today, pageNumber);
    }

    /// <summary>Everything a page is drawn from, read now.</summary>
    public async Task<SitePage> LoadAsync(SiteState state, Page page, int pageNumber, CancellationToken ct = default)
    {
        var ctx = databases.Context(null);
        string? json = null;
        var views = new Dictionary<string, SiteViewData>(StringComparer.Ordinal);
        SiteViewData? full = null;
        var files = new HashSet<Guid>();
        if (page.Kind == PageKinds.Database)
        {
            var opened = await databases.OpenViewAsync(state.Scope, page.Id, null, ctx, ct: ct);
            if (opened.Ok)
            {
                var number = Math.Max(1, pageNumber);
                full = await DataAsync(opened.Value!, ctx, opened.Value!.Rows.Skip((number - 1) * SiteRenderer.PageRows).Take(SiteRenderer.PageRows).ToList(), files, ct);
            }
        }
        else
        {
            json = (await reader.JsonAsync(state.Scope, page.Id, ct))?.Json;
            var needs = SiteRenderer.Needs(json);
            files.UnionWith(needs.Assets);
            foreach (var need in needs.Views.DistinctBy(n => SiteRenderer.ViewKey(n.DatabaseId, n.ViewId, n.GroupBy)))
            {
                var groupBy = need.GroupBy;
                if (groupBy == SiteDatabaseHtml.FirstOptions) groupBy = await FirstOptionsAsync(state, need.DatabaseId, ct);
                if (need.GroupBy == SiteDatabaseHtml.FirstOptions && groupBy is null) continue;
                var opened = await databases.OpenViewAsync(state.Scope, need.DatabaseId, need.ViewId, ctx, null, null, null, groupBy, ct);
                if (!opened.Ok) continue;
                views[SiteRenderer.ViewKey(need.DatabaseId, need.ViewId, need.GroupBy)] =
                    await DataAsync(opened.Value!, ctx, opened.Value!.Rows.Take(SiteRenderer.BlockRows).ToList(), files, ct);
            }
        }
        var known = new Dictionary<Guid, Asset>();
        var wanted = files.ToList();
        foreach (var chunk in wanted.Chunk(1000).Select(c => c.ToList()))
            foreach (var asset in await db.Assets.AsNoTracking().Where(a => chunk.Contains(a.Id) && a.Status == AssetStatus.Ready).ToListAsync(ct))
                known[asset.Id] = asset;
        return new SitePage
        {
            Site = state.Site,
            Base = state.Base,
            Scope = state.Scope,
            Page = page,
            Json = json,
            Assets = known,
            Views = views,
            Database = full,
            PageNumber = pageNumber,
        };
    }

    /// <summary>A board's default columns: the database's first select or status property.</summary>
    private async Task<string?> FirstOptionsAsync(SiteState state, Guid databaseId, CancellationToken ct)
    {
        if (!state.Databases.Contains(databaseId)) return null;
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == databaseId, ct);
        return record is null ? null : DatabaseService.SchemaOf(record).Properties
            .FirstOrDefault(p => !p.Trashed && p.Type is PropertyTypes.Select or PropertyTypes.Status)?.Id;
    }

    /// <summary>A view's titles of related rows and rows' covers for the rows it will show, and the files their visible cells name.</summary>
    private async Task<SiteViewData> DataAsync(ScopedView view, QueryContext ctx, List<RowData> shown, HashSet<Guid> files, CancellationToken ct)
    {
        var titles = await databases.RelatedTitlesAsync(view, shown, ct);
        foreach (var def in view.Visible.Select(view.Schema.Live).OfType<PropertyDef>().Where(d => d.Type == PropertyTypes.Files))
            foreach (var row in shown)
                foreach (var id in row.Values.GetValueOrDefault(def.Id) as string[] ?? [])
                    if (Guid.TryParse(id, out var asset)) files.Add(asset);
        var covers = new Dictionary<Guid, Guid>();
        if (view.Type == "gallery")
        {
            var ids = shown.Select(r => r.Id).ToList();
            foreach (var chunk in ids.Chunk(1000).Select(c => c.ToList()))
                foreach (var p in await db.Pages.AsNoTracking().Where(p => chunk.Contains(p.Id) && p.CoverAssetId != null).Select(p => new { p.Id, p.CoverAssetId }).ToListAsync(ct))
                    covers[p.Id] = p.CoverAssetId!.Value;
        }
        return new SiteViewData { View = view, Titles = titles, Context = ctx, Covers = covers };
    }

    /// <summary>A file the site shows, checked now: a signed URL of a few minutes, or null.</summary>
    public async Task<AssetUrlDto?> FileAsync(SiteState state, Guid assetId, CancellationToken ct = default) =>
        await reader.AssetUrlAsync(state.Scope, assetId, databases, ct);

    /// <summary>
    /// <c>robots.txt</c>: every live site whose publisher turned indexing on, in a workspace with
    /// publishing on, is allowed; everything else is not.
    /// </summary>
    public async Task<string> RobotsAsync(CancellationToken ct = default)
    {
        if (cache.Robots() is { } kept) return kept;
        var slugs = await db.PublishedSites.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(s => s.UnpublishedAt == null && s.Indexing
                && db.Workspaces.Any(w => w.Id == s.WorkspaceId && w.DeletedAt == null && w.PublishingEnabled))
            .OrderBy(s => s.Slug).Select(s => s.Slug).Take(50_000).ToListAsync(ct);
        var text = new StringBuilder("User-agent: *\n");
        foreach (var slug in slugs) text.Append("Allow: /").Append(slug).Append("$\nAllow: /").Append(slug).Append("/\n");
        text.Append("Disallow: /\n");
        var result = text.ToString();
        cache.PutRobots(result);
        return result;
    }
}
