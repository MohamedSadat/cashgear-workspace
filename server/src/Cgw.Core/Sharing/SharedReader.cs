using Cgw.Core.Assets;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sharing;

public sealed record SharedPageDto(Guid Id, string Title, string? Icon);
public sealed record SharedTreePageDto(Guid Id, string Title, string? Icon, Guid? ParentPageId, string OrderKey);
public sealed record SharedTreeDto(SharedPageDto Page, IReadOnlyList<SharedTreePageDto> Pages);

/// <summary>What one valid link opens: its page and the pages of the subtree a reader may see.</summary>
public sealed record SharedScope(ShareLink Link, Page Root, IReadOnlyList<Page> Pages)
{
    public bool Holds(Guid pageId) => Pages.Any(p => p.Id == pageId);
}

/// <summary>
/// Reading by share link, with no account (M2.6). The token arrives in a header and is compared by
/// its SHA-256; a link that is unknown, revoked or expired, or whose page is trashed, deleted or in
/// a private section, opens nothing, and every such answer is the same 404. A link opens its page
/// and the pages under it, except a page hidden from the workspace (restricted, or with a
/// workspace row of none) and what is under it, and only three reads: the tree, a page's document
/// as the worker's JSON (never the Yjs updates, which still hold recently deleted text) and the
/// files those pages show.
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
        var root = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == link.PageId && p.DeletedAt == null && p.TrashedAt == null, ct);
        if (root is null) return null;
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
        return new SharedScope(link, root, pages);

        void Push(Guid parent)
        {
            foreach (var child in children[parent].Where(c => !c.Restricted && !hidden.Contains(c.Id))
                         .OrderByDescending(c => c.OrderKey, StringComparer.Ordinal).ThenByDescending(c => c.Id.ToString(), StringComparer.Ordinal))
                stack.Push(child);
        }
    }

    public static SharedTreeDto Tree(SharedScope scope) => new(
        new SharedPageDto(scope.Root.Id, scope.Root.Title, scope.Root.Icon),
        scope.Pages.Select(p => new SharedTreePageDto(p.Id, p.Title, p.Icon, p.Id == scope.Root.Id ? null : p.ParentPageId, p.OrderKey)).ToList());

    /// <summary>
    /// A page of the subtree as the worker's derived JSON; an empty document for a page never
    /// written; null outside the subtree or while the worker has not derived it yet.
    /// </summary>
    public async Task<DocJsonResponse?> JsonAsync(SharedScope scope, Guid pageId, CancellationToken ct = default)
    {
        var page = scope.Pages.FirstOrDefault(p => p.Id == pageId);
        if (page is null) return null;
        if (page.DocHeadSeq == 0) return new DocJsonResponse(0, page.DocSchemaVersion, EmptyDoc);
        return await docs.JsonAsync(page, ct);
    }

    /// <summary>A file that a page of the subtree shows, in its content or as its cover.</summary>
    public async Task<AssetUrlDto?> AssetUrlAsync(SharedScope scope, Guid assetId, CancellationToken ct = default)
    {
        var asset = await db.Assets.AsNoTracking().FirstOrDefaultAsync(a => a.Id == assetId && a.Status == AssetStatus.Ready, ct);
        if (asset is null) return null;
        var ids = scope.Pages.Select(p => p.Id).ToHashSet();
        var shown = scope.Pages.Any(p => p.CoverAssetId == assetId);
        if (!shown)
        {
            var referencing = await db.AssetRefs.AsNoTracking().Where(r => r.AssetId == assetId).Select(r => r.PageId).ToListAsync(ct);
            shown = referencing.Any(ids.Contains);
        }
        return shown ? await assets.SignedUrlAsync(asset, ct) : null;
    }
}
