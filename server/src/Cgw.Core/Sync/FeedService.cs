using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sync;

/// <summary>
/// The change feed and the tree (SYNC_DESIGN.md, Channel 2, Pull). Each change carries its entity
/// as the caller may see it now; one the caller may not see is a delete, so a client drops what it
/// lost access to. Several changes to one entity in a page of the feed are sent once, as the last.
/// </summary>
public sealed class FeedService(CgwDb db, Access access)
{
    public const int DefaultLimit = 500;
    public const int MaxLimit = 1000;

    public async Task<Result<ChangesDto>> ChangesAsync(Member member, long after, int limit, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, MaxLimit);
        after = Math.Max(0, after);
        var rows = await db.WorkspaceChanges.AsNoTracking().Where(c => c.Seq > after).OrderBy(c => c.Seq).Take(limit + 1).ToListAsync(ct);
        // Changes past the feed's 90 days are gone (FeedRetentionJob): a cursor before the last one
        // removed would skip what it never saw, so it is told to fetch the tree again. Read after the
        // rows, so a removal that committed meanwhile is seen; the next change being there is proof
        // enough (sequences have no gaps but these).
        if (rows.Count == 0 || rows[0].Seq != after + 1)
        {
            var pruned = await db.Workspaces.AsNoTracking().Where(w => w.Id == member.WorkspaceId).Select(w => w.ChangesPrunedSeq).FirstAsync(ct);
            if (after < pruned) return new Failure(Codes.FeedExpired, 410, "The change feed no longer goes back that far: fetch the tree again");
        }
        var more = rows.Count > limit;
        if (more) rows.RemoveAt(rows.Count - 1);
        var cursor = rows.Count > 0 ? rows[^1].Seq : after;

        var mine = rows.Where(r => r.UserId is null || r.UserId == member.UserId).ToList();
        // The last change per entity; access events are all kept.
        var latest = mine.Where(r => r.EntityType != "access").GroupBy(r => (r.EntityType, r.EntityId)).Select(g => g.Last())
            .Concat(mine.Where(r => r.EntityType == "access"))
            .OrderBy(r => r.Seq).ToList();

        var pageIds = latest.Where(r => r.EntityType is "page" or "favourite" or "visit").Select(r => r.EntityId).Distinct().ToList();
        var pages = new Dictionary<Guid, Page>();
        foreach (var chunk in Chunked.Of(pageIds))
            foreach (var page in await db.Pages.AsNoTracking().Where(p => chunk.Contains(p.Id)).ToListAsync(ct))
                pages[page.Id] = page;
        // Every page's level at once: a few queries, not a few per page (the feed is polled often).
        var all = pageIds.Count > 50 ? await access.AllLevelsAsync(member) : null;
        var levels = all ?? await access.LevelsAsync(member, pageIds, ct);
        string Level(Guid id) => levels.GetValueOrDefault(id, Levels.None);

        var sectionIds = latest.Where(r => r.EntityType == "section").Select(r => r.EntityId).ToList();
        var sections = await db.Sections.AsNoTracking().Where(s => sectionIds.Contains(s.Id)).ToDictionaryAsync(s => s.Id, ct);
        var guestSections = member.IsGuest && sectionIds.Count > 0 ? await GuestSectionsAsync(all ?? await access.AllLevelsAsync(member), ct) : null;
        var favourites = await db.Favourites.AsNoTracking().Where(f => f.UserId == member.UserId && pageIds.Contains(f.PageId)).ToDictionaryAsync(f => f.PageId, ct);
        var visits = await db.PageVisits.AsNoTracking().Where(v => v.UserId == member.UserId && pageIds.Contains(v.PageId)).ToDictionaryAsync(v => v.PageId, ct);

        var changes = new List<ChangeDto>();
        foreach (var row in latest)
        {
            switch (row.EntityType)
            {
                case "page":
                {
                    var page = pages.GetValueOrDefault(row.EntityId);
                    var level = page is null || page.DeletedAt is not null ? Levels.None : Level(page.Id);
                    changes.Add(level == Levels.None
                        ? new ChangeDto(row.Seq, "page", row.EntityId, "delete", null)
                        : new ChangeDto(row.Seq, "page", row.EntityId, "upsert", new EntityDto(Page: PageDto.From(page!, level))));
                    break;
                }
                case "section":
                {
                    var section = sections.GetValueOrDefault(row.EntityId);
                    changes.Add(section is null || !Access.SeesSection(member, section) || guestSections?.Contains(section.Id) == false
                        ? new ChangeDto(row.Seq, "section", row.EntityId, "delete", null)
                        : new ChangeDto(row.Seq, "section", row.EntityId, "upsert", new EntityDto(Section: SectionDto.From(section))));
                    break;
                }
                case "favourite":
                    changes.Add(favourites.TryGetValue(row.EntityId, out var favourite)
                        ? new ChangeDto(row.Seq, "favourite", row.EntityId, "upsert", new EntityDto(Favourite: new FavouriteDto(favourite.WorkspaceId, favourite.PageId, favourite.OrderKey)))
                        : new ChangeDto(row.Seq, "favourite", row.EntityId, "delete", null));
                    break;
                case "visit":
                    if (visits.TryGetValue(row.EntityId, out var visit))
                        changes.Add(new ChangeDto(row.Seq, "visit", row.EntityId, "upsert", new EntityDto(Visit: new VisitDto(visit.WorkspaceId, visit.PageId, visit.LastVisitedAt))));
                    else changes.Add(new ChangeDto(row.Seq, "visit", row.EntityId, "delete", null));
                    break;
                case "workspace":
                {
                    var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId, ct);
                    changes.Add(new ChangeDto(row.Seq, "workspace", row.EntityId, workspace.DeletedAt is null ? "upsert" : "delete",
                        new EntityDto(Workspace: WorkspaceDto.From(workspace, member.Role))));
                    break;
                }
                case "member":
                    // A guest is told of themselves, never of who else joins or leaves.
                    if (!member.IsGuest || row.EntityId == member.UserId)
                        changes.Add(new ChangeDto(row.Seq, "member", row.EntityId, row.Kind, null));
                    break;
                case "access":
                    // A grant or revoke naming the root of what changed: the client refetches it.
                    changes.Add(new ChangeDto(row.Seq, "access", row.EntityId, row.Kind, null));
                    break;
            }
        }
        return new ChangesDto(changes, cursor, more);
    }

    /// <summary>
    /// What the caller sees of the workspace, or of one subtree: the first sync, and the scoped
    /// resync after a grant. The cursor is read first, so nothing committed after it is missed;
    /// what the tree already holds the feed sends again, harmlessly.
    /// </summary>
    public async Task<TreeDto> TreeAsync(Member member, Guid? root, CancellationToken ct = default)
    {
        var workspace = await db.Workspaces.AsNoTracking().FirstAsync(w => w.Id == member.WorkspaceId, ct);
        var cursor = workspace.ChangeSeq;
        var levels = await access.AllLevelsAsync(member);
        var query = db.Pages.AsNoTracking().Where(p => p.DeletedAt == null);
        if (root is { } r) query = query.Where(p => db.PageAncestors.Any(a => a.PageId == p.Id && a.AncestorPageId == r));
        var pages = (await query.ToListAsync(ct))
            .Where(p => levels.GetValueOrDefault(p.Id, Levels.None) != Levels.None)
            .Select(p => PageDto.From(p, levels[p.Id]))
            .ToList();
        var guestSections = member.IsGuest ? await GuestSectionsAsync(levels, ct) : null;
        var sections = (await db.Sections.AsNoTracking().ToListAsync(ct))
            .Where(s => Access.SeesSection(member, s) && guestSections?.Contains(s.Id) != false)
            .Select(SectionDto.From).ToList();
        var visible = pages.Select(p => p.Id).ToHashSet();
        var favourites = (await db.Favourites.AsNoTracking().Where(f => f.UserId == member.UserId).ToListAsync(ct))
            .Where(f => visible.Contains(f.PageId)).Select(f => new FavouriteDto(f.WorkspaceId, f.PageId, f.OrderKey)).ToList();
        var visits = (await db.PageVisits.AsNoTracking().Where(v => v.UserId == member.UserId).ToListAsync(ct))
            .Where(v => visible.Contains(v.PageId)).Select(v => new VisitDto(v.WorkspaceId, v.PageId, v.LastVisitedAt)).ToList();
        return new TreeDto(WorkspaceDto.From(workspace, member.Role), sections, pages, favourites, visits, cursor);
    }

    /// <summary>The sections a guest sees: those holding a page they may open, anywhere in the workspace.</summary>
    private async Task<HashSet<Guid>> GuestSectionsAsync(Dictionary<Guid, string> levels, CancellationToken ct) =>
        (await db.Pages.AsNoTracking().Where(p => p.DeletedAt == null).Select(p => new { p.Id, p.SectionId }).ToListAsync(ct))
            .Where(p => levels.GetValueOrDefault(p.Id, Levels.None) != Levels.None)
            .Select(p => p.SectionId).ToHashSet();
}
