using Cgw.Core.Assets;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sharing;

public sealed record SharedPageDto(Guid Id, string Title, string? Icon);
/// <summary>A page of a share link's tree; <c>Kind</c> (Phase 9) is <c>page</c> or <c>database</c> (rows are never in it).</summary>
public sealed record SharedTreePageDto(Guid Id, string Title, string? Icon, Guid? ParentPageId, string OrderKey, string Kind);
public sealed record SharedTreeDto(SharedPageDto Page, IReadOnlyList<SharedTreePageDto> Pages);

/// <summary>
/// What may be read of a page without an account: the page and the pages of its subtree a reader
/// may see, parents first (a share link's, and from Phase 9 a published site's). <see cref="LeftOut"/>
/// counts the live pages of the subtree that are not in it (restricted, hidden, or under either).
/// </summary>
public record PageScope(Page Root, IReadOnlyList<Page> Pages)
{
    private HashSet<Guid>? ids;
    public IReadOnlySet<Guid> Ids => ids ??= Pages.Select(p => p.Id).ToHashSet();
    public bool Holds(Guid pageId) => Ids.Contains(pageId);
    public int LeftOut { get; init; }
}

/// <summary>What one valid link opens: its page and the pages of the subtree a reader may see.</summary>
public sealed record SharedScope(ShareLink Link, Page Root, IReadOnlyList<Page> Pages) : PageScope(Root, Pages);

/// <summary>
/// Reading by share link, with no account (M2.6). The token arrives in a header and is compared by
/// its SHA-256; a link that is unknown, revoked or expired, or whose page is trashed, deleted or in
/// a private section, opens nothing, and every such answer is the same 404. A link opens its page
/// and the pages under it, except a page hidden from the workspace (restricted, or with a
/// workspace row of none) and what is under it, and only these reads: the tree, a page's document
/// as the worker's JSON (never the Yjs updates, which still hold recently deleted text), the files
/// those pages show, and (Phase 9, <see cref="SharedDatabases"/>) the databases among them through
/// their views. A published site's scope is decided by the same rules (<see cref="ScopeAsync"/>).
/// </summary>
public sealed class SharedReader(CgwDb db, DocService docs, AssetService assets, TimeProvider clock)
{
    public const string Header = "X-Share-Token";
    public const string EmptyDoc = """{"type":"doc","content":[]}""";

    public async Task<SharedScope?> OpenAsync(string? token, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 100) return null;
        var hash = WorkspaceService.Hash(token);
        var link = await db.ShareLinks.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(l => l.TokenHash == hash, ct);
        var now = clock.GetUtcNow();
        if (link is null || link.RevokedAt is not null || link.ExpiresAt is { } expires && expires <= now) return null;
        if (!await db.Workspaces.AnyAsync(w => w.Id == link.WorkspaceId && w.DeletedAt == null, ct)) return null;
        db.Scope.Enter(link.WorkspaceId);
        var scope = await ScopeAsync(link.PageId, ct);
        return scope is null ? null : new SharedScope(link, scope.Root, scope.Pages) { LeftOut = scope.LeftOut };
    }

    /// <summary>
    /// The scope of a page, in the workspace the scope has entered: null when the page is not a
    /// page or database (a row has its database's access and no scope of its own), or is trashed,
    /// deleted, or in a private section. Decided from the current state each time it is asked.
    /// </summary>
    public async Task<PageScope?> ScopeAsync(Guid rootId, CancellationToken ct = default)
    {
        var root = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == rootId && p.DeletedAt == null && p.TrashedAt == null, ct);
        if (root is null || root.Kind == PageKinds.Row) return null;
        var section = await db.Sections.AsNoTracking().FirstOrDefaultAsync(s => s.Id == root.SectionId, ct);
        if (section is null || section.Visibility == "private") return null;

        var under = await db.Pages.AsNoTracking()
            .Where(p => p.DeletedAt == null && p.TrashedAt == null && p.Id != root.Id
                && db.PageAncestors.Any(a => a.PageId == p.Id && a.AncestorPageId == root.Id))
            .ToListAsync(ct);
        // Pages of the subtree the whole workspace may not open, by a row of none: hidden from a link too.
        var hidden = (await db.PagePermissions.AsNoTracking()
                .Where(r => r.PrincipalType == "workspace" && r.Level == Levels.None
                    && db.PageAncestors.Any(a => a.PageId == r.PageId && a.AncestorPageId == root.Id && a.Depth > 0))
                .Select(r => r.PageId).ToListAsync(ct))
            .ToHashSet();
        var children = under.ToLookup(p => p.ParentPageId);
        var pages = new List<Page> { root };
        // Parents before children, siblings in drawn order; a hidden page stops the walk.
        var stack = new Stack<Page>();
        Push(root.Id);
        while (stack.TryPop(out var page))
        {
            pages.Add(page);
            Push(page.Id);
        }
        return new PageScope(root, pages) { LeftOut = under.Count - (pages.Count - 1) };

        void Push(Guid parent)
        {
            foreach (var child in children[parent].Where(c => !c.Restricted && !hidden.Contains(c.Id))
                         .OrderByDescending(c => c.OrderKey, StringComparer.Ordinal).ThenByDescending(c => c.Id.ToString(), StringComparer.Ordinal))
                stack.Push(child);
        }
    }

    public static SharedTreeDto Tree(PageScope scope) => new(
        new SharedPageDto(scope.Root.Id, scope.Root.Title, scope.Root.Icon),
        scope.Pages.Select(p => new SharedTreePageDto(p.Id, p.Title, p.Icon, p.Id == scope.Root.Id ? null : p.ParentPageId, p.OrderKey, p.Kind)).ToList());

    /// <summary>
    /// A page of the subtree as the worker's derived JSON; an empty document for a page never
    /// written; null outside the subtree or while the worker has not derived it yet.
    /// </summary>
    public async Task<DocJsonResponse?> JsonAsync(PageScope scope, Guid pageId, CancellationToken ct = default)
    {
        var page = scope.Pages.FirstOrDefault(p => p.Id == pageId);
        if (page is null) return null;
        if (page.DocHeadSeq == 0) return new DocJsonResponse(0, page.DocSchemaVersion, EmptyDoc);
        return await docs.JsonAsync(page, ct);
    }

    /// <summary>
    /// A file that a page of the subtree shows, in its content or as its cover; from Phase 9 also
    /// a file in a shown file cell, or a row's cover, of a database among them
    /// (<see cref="SharedDatabases.ShowsFileAsync"/>).
    /// </summary>
    public async Task<AssetUrlDto?> AssetUrlAsync(PageScope scope, Guid assetId, SharedDatabases? databases = null, CancellationToken ct = default)
    {
        var asset = await db.Assets.AsNoTracking().FirstOrDefaultAsync(a => a.Id == assetId && a.Status == AssetStatus.Ready, ct);
        if (asset is null) return null;
        return await ShowsAsync(scope, assetId, databases, ct) ? await assets.SignedUrlAsync(asset, ct) : null;
    }

    /// <summary>Whether the scope shows the asset: a page's content or cover, or (with <paramref name="databases"/>) a database's shown cell.</summary>
    public async Task<bool> ShowsAsync(PageScope scope, Guid assetId, SharedDatabases? databases = null, CancellationToken ct = default)
    {
        if (scope.Pages.Any(p => p.CoverAssetId == assetId)) return true;
        var referencing = await db.AssetRefs.AsNoTracking().Where(r => r.AssetId == assetId).Select(r => r.PageId).ToListAsync(ct);
        if (referencing.Any(scope.Holds)) return true;
        return databases is not null && await databases.ShowsFileAsync(scope, assetId, ct);
    }
}
