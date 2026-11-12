using System.Data;
using System.Text.Json;
using Cgw.Core.Assets;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Sync;

/// <summary>Why an operation was refused; the codes are the client planner's (OpErrorCode).</summary>
public sealed class OpFailure(string code, string title) : Exception(title)
{
    public string Code { get; } = code;
}

/// <summary>
/// The operations endpoint (SYNC_DESIGN.md, Channel 2, Push). Each operation, in order, in its own
/// transaction: answered from AppliedOps if seen before; else its permission and its type's rules
/// are checked (the same rules as packages/workspace/src/ops.ts), then it is applied, versions
/// rise, the change feed and the closure table are written, and the result is stored, together.
/// A rejected operation does not stop the batch, except that operations on a rejected create are
/// rejected too. "Last" always means the order the server received them; no clock is compared.
/// The tree never changes who may see a page behind anyone's back: a page that leaves the page
/// deciding its access keeps that access as its own rows, and the feed says to fetch the subtree.
/// </summary>
public sealed class OpsService(CgwDb db, Access access, AssetService assets, ChangeLog changes, Audit audit, TimeProvider clock)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<OpsResponse> ApplyAsync(Member member, Actor actor, OpsRequest request, CancellationToken ct = default)
    {
        var results = new List<OpResultDto>();
        var rejectedCreates = new HashSet<Guid>();
        foreach (var op in request.Ops)
        {
            db.ChangeTracker.Clear();
            if (op.WorkspaceId != member.WorkspaceId)
            {
                results.Add(Rejected(op, Codes.RequestInvalid, "The operation is for another workspace"));
                continue;
            }
            if (rejectedCreates.Contains(op.EntityId) || DependsOn(op, rejectedCreates))
            {
                results.Add(Rejected(op, "not.found", "It depends on a create that was refused"));
                continue;
            }
            var result = await ApplyOneAsync(member, actor, op, ct);
            if (result.Status == "rejected" && op.Type.EndsWith(".create", StringComparison.Ordinal)) rejectedCreates.Add(op.EntityId);
            results.Add(result);
        }
        return new OpsResponse(results);
    }

    private static bool DependsOn(OperationDto op, HashSet<Guid> rejected)
    {
        if (rejected.Count == 0 || op.Payload.ValueKind != JsonValueKind.Object) return false;
        foreach (var name in new[] { "parentPageId", "sectionId" })
            if (op.Payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                && Guid.TryParse(value.GetString(), out var id) && rejected.Contains(id))
                return true;
        return false;
    }

    private static OpResultDto Rejected(OperationDto op, string code, string title) =>
        new(op.OpId, "rejected", new OpErrorDto(code, title), null, null, null);

    private async Task<OpResultDto> ApplyOneAsync(Member member, Actor actor, OperationDto op, CancellationToken ct)
    {
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(member.WorkspaceId, ct);
            var seen = await db.AppliedOps.AsNoTracking().FirstOrDefaultAsync(a => a.OpId == op.OpId, ct);
            if (seen is not null)
            {
                await tx.RollbackAsync(ct);
                return JsonSerializer.Deserialize<OpResultDto>(seen.Result, Json)!;
            }
            OpResultDto result;
            try
            {
                result = await ApplyTypeAsync(member, actor, op, ct);
                await db.SaveChangesAsync(ct);
                await changes.FlushAsync(ct);
            }
            catch (OpFailure failure)
            {
                await tx.RollbackAsync(ct);
                db.ChangeTracker.Clear();
                result = Rejected(op, failure.Code, failure.Message) with { EntityType = EntityTypeOf(op), Entity = await CurrentAsync(member, op) };
                // Kept, so a repeat of the same operation gets the same answer.
                db.AppliedOps.Add(new AppliedOp { OpId = op.OpId, WorkspaceId = member.WorkspaceId, UserId = member.UserId, Result = JsonSerializer.Serialize(result, Json), CreatedAt = clock.GetUtcNow() });
                await db.SaveChangesAsync(ct);
                return result;
            }
            db.AppliedOps.Add(new AppliedOp { OpId = op.OpId, WorkspaceId = member.WorkspaceId, UserId = member.UserId, Result = JsonSerializer.Serialize(result, Json), CreatedAt = clock.GetUtcNow() });
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return result;
        });
    }

    private static string? EntityTypeOf(OperationDto op) => op.Type.Split('.')[0] switch
    {
        "workspace" => "workspace",
        "section" => "section",
        "page" => "page",
        "favourite" => "favourite",
        "visit" => "visit",
        _ => null,
    };

    /// <summary>The entity as the caller may see it now, sent with a refusal so the client can put it right.</summary>
    private async Task<EntityDto?> CurrentAsync(Member member, OperationDto op)
    {
        switch (EntityTypeOf(op))
        {
            case "page":
            {
                var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == op.EntityId && p.DeletedAt == null);
                if (page is null) return null;
                var level = await access.PageLevelAsync(member, page.Id);
                return level == Levels.None ? null : new EntityDto(Page: PageDto.From(page, level));
            }
            case "section":
            {
                var section = await db.Sections.AsNoTracking().FirstOrDefaultAsync(s => s.Id == op.EntityId);
                return section is null || !Access.SeesSection(member, section) ? null : new EntityDto(Section: SectionDto.From(section));
            }
            case "workspace":
            {
                var workspace = await db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Id == member.WorkspaceId);
                return workspace is null ? null : new EntityDto(Workspace: WorkspaceDto.From(workspace, member.Role));
            }
            default:
                return null;
        }
    }

    // ------------------------------------------------------------------------------------------

    private async Task<OpResultDto> ApplyTypeAsync(Member member, Actor actor, OperationDto op, CancellationToken ct)
    {
        var payload = op.Payload;
        var now = clock.GetUtcNow();
        switch (op.Type)
        {
            case "workspace.create":
            {
                // A local workspace's first operation, replayed from an old outbox: the workspace
                // was made by POST /workspaces.
                var workspace = await db.Workspaces.FirstOrDefaultAsync(w => w.Id == op.EntityId, ct) ?? throw new OpFailure("invalid", "Use POST /workspaces");
                return Applied(op, "workspace", new EntityDto(Workspace: WorkspaceDto.From(workspace, member.Role)));
            }
            case "workspace.update":
            {
                if (!member.IsAdmin) throw new OpFailure(Codes.AccessDenied, "Only an owner or admin renames the workspace");
                var workspace = await db.Workspaces.FirstAsync(w => w.Id == member.WorkspaceId, ct);
                if (Str(payload, "name", out var name)) workspace.Name = Name(name);
                if (Has(payload, "icon")) workspace.Icon = Icon(payload);
                workspace.Version++;
                changes.Add("workspace", workspace.Id, "upsert", workspace.Version, member.UserId);
                return Applied(op, "workspace", new EntityDto(Workspace: WorkspaceDto.From(workspace, member.Role)));
            }
            case "section.create":
            {
                if (member.IsGuest) throw new OpFailure(Codes.AccessDenied, "Guests do not make sections");
                if (await db.Sections.AnyAsync(s => s.Id == op.EntityId, ct)) throw new OpFailure("invalid", "Section exists");
                if (!Guid.TryParse(Text(payload, "id"), out var id) || id != op.EntityId) throw new OpFailure("invalid", "Id mismatch");
                var visibility = Text(payload, "visibility") == "private" ? "private" : "workspace";
                var orderKey = Key(payload);
                var section = new Section
                {
                    Id = id,
                    WorkspaceId = member.WorkspaceId,
                    Name = Name(Text(payload, "name") ?? ""),
                    OrderKey = orderKey,
                    Visibility = visibility,
                    OwnerUserId = visibility == "private" ? member.UserId : null,
                    Version = 1,
                    CreatedAt = now,
                };
                db.Sections.Add(section);
                changes.Add("section", section.Id, "upsert", 1, member.UserId);
                return Applied(op, "section", new EntityDto(Section: SectionDto.From(section)));
            }
            case "section.update":
            {
                var section = await SectionFor(member, op.EntityId, ct);
                if (Str(payload, "name", out var name)) section.Name = Name(name);
                if (Str(payload, "orderKey", out var key)) section.OrderKey = OrderKeys.IsValid(key) ? key : throw new OpFailure("invalid", "Not an order key");
                section.Version++;
                changes.Add("section", section.Id, "upsert", section.Version, member.UserId);
                return Applied(op, "section", new EntityDto(Section: SectionDto.From(section)));
            }
            case "section.delete":
            {
                var section = await SectionFor(member, op.EntityId, ct);
                if (await db.Pages.AnyAsync(p => p.SectionId == section.Id && p.DeletedAt == null, ct))
                    throw new OpFailure("section.notEmpty", "The section still holds pages");
                db.Sections.Remove(section);
                changes.Add("section", section.Id, "delete", section.Version + 1, member.UserId);
                return Applied(op, "section", null);
            }
            case "page.create":
                return await CreatePageAsync(member, op, now, ct);
            case "page.update":
            {
                var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
                if (page.TrashedAt is not null) throw new OpFailure("page.trashed", "The page is in the trash");
                if (Str(payload, "title", out var title))
                {
                    page.Title = Title(title);
                    page.SearchTitle = TextNormaliser.Normalise(page.Title);
                }
                if (Has(payload, "icon")) page.Icon = Icon(payload);
                if (Has(payload, "coverAssetId")) page.CoverAssetId = await CoverAsync(member, payload, page.CoverAssetId, ct);
                if (payload.TryGetProperty("isTemplate", out var template) && template.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    page.IsTemplate = template.GetBoolean();
                if (Has(payload, "templateOfPageId")) page.TemplateOfPageId = OptionalId(payload, "templateOfPageId");
                page.Version++;
                page.UpdatedAt = now;
                page.UpdatedBy = member.UserId;
                changes.Add("page", page.Id, "upsert", page.Version, member.UserId);
                return await AppliedPage(member, op, page);
            }
            case "page.move":
                return await MovePageAsync(member, op, now, ct);
            case "page.trash":
            {
                var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
                CheckBase(page, op);
                if (page.TrashedAt is not null) throw new OpFailure("page.trashed", "The page is in the trash");
                // The subtree goes as one unit; pages already trashed on their own keep their root.
                foreach (var record in await SubtreeAsync(page.Id, ct))
                {
                    if (record.TrashedAt is not null) continue;
                    record.TrashedAt = now;
                    record.TrashRootId = page.Id;
                    record.TrashedBy = member.UserId;
                    record.Version++;
                    changes.Add("page", record.Id, "upsert", record.Version, member.UserId);
                }
                return await AppliedPage(member, op, page);
            }
            case "page.restore":
                return await RestorePageAsync(member, op, ct);
            case "page.delete":
            {
                var page = await PageFor(member, op.EntityId, Levels.Full, ct);
                if (page.TrashedAt is null) throw new OpFailure("page.notTrashed", "Pages are deleted for good only from the trash");
                var subtree = await SubtreeAsync(page.Id, ct);
                var ids = subtree.Select(p => p.Id).ToList();
                // For good means every page of it, so it needs full access to every page of it.
                await NeedFullOnAllAsync(member, ids, "Deleting for good needs full access to every page under this one");
                foreach (var record in subtree)
                {
                    // A tombstone: the title goes now; the document goes with the worker's purge.
                    record.DeletedAt = now;
                    record.Title = "";
                    record.SearchTitle = "";
                    record.Version++;
                    changes.Add("page", record.Id, "delete", record.Version, member.UserId);
                }
                foreach (var chunk in Chunked.Of(ids))
                {
                    await db.Favourites.Where(f => chunk.Contains(f.PageId)).ExecuteDeleteAsync(ct);
                    await db.PageVisits.Where(v => chunk.Contains(v.PageId)).ExecuteDeleteAsync(ct);
                    await db.PageAncestors.Where(a => chunk.Contains(a.PageId)).ExecuteDeleteAsync(ct);
                }
                audit.Add(actor, "page.delete", member.WorkspaceId, "page", page.Id, new { pages = ids.Count });
                return Applied(op, "page", null);
            }
            case "favourite.set":
            {
                var page = await PageFor(member, op.EntityId, Levels.View, ct);
                var favourite = payload.TryGetProperty("favourite", out var f) && f.ValueKind == JsonValueKind.True;
                var row = await db.Favourites.FirstOrDefaultAsync(x => x.UserId == member.UserId && x.PageId == page.Id, ct);
                if (favourite)
                {
                    var key = Str(payload, "orderKey", out var k) && OrderKeys.IsValid(k) ? k : OrderKeys.Between(null, null);
                    if (row is null) db.Favourites.Add(row = new Favourite { UserId = member.UserId, PageId = page.Id, WorkspaceId = member.WorkspaceId, OrderKey = key, CreatedAt = now });
                    else row.OrderKey = key;
                }
                else if (row is not null) db.Favourites.Remove(row);
                changes.Add("favourite", page.Id, favourite ? "upsert" : "delete", 1, member.UserId, member.UserId);
                return Applied(op, "favourite", favourite ? new EntityDto(Favourite: new FavouriteDto(member.WorkspaceId, page.Id, row!.OrderKey)) : null);
            }
            case "visit.record":
            {
                var page = await PageFor(member, op.EntityId, Levels.View, ct);
                var at = payload.TryGetProperty("at", out var a) && a.TryGetDateTimeOffset(out var t) && t < now.AddMinutes(5) ? t : now;
                var row = await db.PageVisits.FirstOrDefaultAsync(x => x.UserId == member.UserId && x.PageId == page.Id, ct);
                if (row is null) db.PageVisits.Add(new PageVisit { UserId = member.UserId, PageId = page.Id, WorkspaceId = member.WorkspaceId, LastVisitedAt = at });
                else row.LastVisitedAt = at;
                // Recent pages are capped per user.
                var old = await db.PageVisits.Where(v => v.UserId == member.UserId).OrderByDescending(v => v.LastVisitedAt).Skip(50).Select(v => v.PageId).ToListAsync(ct);
                if (old.Count > 0) await db.PageVisits.Where(v => v.UserId == member.UserId && old.Contains(v.PageId)).ExecuteDeleteAsync(ct);
                changes.Add("visit", page.Id, "upsert", 1, member.UserId, member.UserId);
                return Applied(op, "visit", new EntityDto(Visit: new VisitDto(member.WorkspaceId, page.Id, at)));
            }
            default:
                throw new OpFailure("invalid", $"Unknown operation {op.Type}");
        }
    }

    private async Task<OpResultDto> CreatePageAsync(Member member, OperationDto op, DateTimeOffset now, CancellationToken ct)
    {
        var p = op.Payload;
        if (!Guid.TryParse(Text(p, "id"), out var id) || id != op.EntityId) throw new OpFailure("invalid", "Id mismatch");
        if (!Guid.TryParse(Text(p, "workspaceId"), out var ws) || ws != member.WorkspaceId) throw new OpFailure("invalid", "Id mismatch");
        if (await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AnyAsync(x => x.Id == id, ct)) throw new OpFailure("invalid", "Page exists");
        if (!Guid.TryParse(Text(p, "sectionId"), out var sectionId)) throw new OpFailure("invalid", "No section");
        var section = await db.Sections.FirstOrDefaultAsync(s => s.Id == sectionId, ct) ?? throw new OpFailure("not.found", "Section not found");
        if (!Access.SeesSection(member, section)) throw new OpFailure("not.found", "Section not found");
        var parentId = OptionalId(p, "parentPageId");
        string? notice = null;
        Page? parent = null;
        var fellBack = false;
        Guid? accessFrom = null;
        if (parentId is { } pid)
        {
            parent = await db.Pages.FirstOrDefaultAsync(x => x.Id == pid && x.DeletedAt == null, ct);
            // The parent's level first: nothing else is said of a page the caller may not see.
            if (parent is not null) await NeedLevelAsync(member, parent.Id, Levels.Edit);
            if (parent is not null && parent.SectionId != section.Id) throw new OpFailure("tree.section", "The parent is in another section");
            if (parent is null || parent.TrashedAt is not null)
            {
                // SYNC_DESIGN.md, Metadata: made at the top of its section, and the user is told.
                accessFrom = parent?.Id;
                parent = null;
                notice = Codes.TreeParentMissing;
                fellBack = true;
            }
        }
        if (parent is null && member.IsGuest && section.Visibility != "private")
            throw new OpFailure(Codes.AccessDenied, "Guests add pages only under pages shared with them");
        var cover = await CoverAsync(member, p, null, ct);

        var orderKey = Key(p);
        if (notice is not null) orderKey = OrderKeys.Between(await LastTopKeyAsync(section.Id, null, ct), null);
        orderKey = await FreeKeyAsync(section.Id, parent?.Id, orderKey, null, ct);
        var title = Title(Text(p, "title") ?? "");
        var page = new Page
        {
            Id = id,
            WorkspaceId = member.WorkspaceId,
            SectionId = section.Id,
            ParentPageId = parent?.Id,
            OrderKey = orderKey,
            Kind = "page",
            Title = title,
            SearchTitle = TextNormaliser.Normalise(title),
            Icon = Icon(p),
            CoverAssetId = cover,
            IsTemplate = p.TryGetProperty("isTemplate", out var t) && t.ValueKind == JsonValueKind.True,
            TemplateOfPageId = OptionalId(p, "templateOfPageId"),
            Version = 1,
            CreatedBy = member.UserId,
            UpdatedBy = member.UserId,
            CreatedAt = p.TryGetProperty("createdAt", out var c) && c.TryGetDateTimeOffset(out var created) && created <= now.AddMinutes(5) ? created : now,
            UpdatedAt = now,
        };
        db.Pages.Add(page);
        // Not under the parent it was made for: it keeps that parent's access, never the section's
        // default. With no trace of the parent, only its maker (and admins) may see it.
        var kept = fellBack && section.Visibility != "private";
        if (kept) await KeepAccessAsync(member, page, await AccessToKeepAsync(member, accessFrom), now, ct);
        await db.SaveChangesAsync(ct);
        await AddClosureAsync(page.Id, parent?.Id, ct);
        changes.Add("page", page.Id, "upsert", page.Version, member.UserId);
        if (kept) changes.Add("access", page.Id, "grant", page.Version, member.UserId);
        return (await AppliedPage(member, op, page)) with { Notice = notice };
    }

    private async Task<OpResultDto> MovePageAsync(Member member, OperationDto op, DateTimeOffset now, CancellationToken ct)
    {
        var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
        CheckBase(page, op);
        if (page.TrashedAt is not null) throw new OpFailure("page.trashed", "The page is in the trash");
        var p = op.Payload;
        if (!Guid.TryParse(Text(p, "sectionId"), out var sectionId)) throw new OpFailure("invalid", "No section");
        var section = await db.Sections.FirstOrDefaultAsync(s => s.Id == sectionId, ct) ?? throw new OpFailure("not.found", "Section not found");
        if (!Access.SeesSection(member, section)) throw new OpFailure("not.found", "Section not found");
        var parentId = OptionalId(p, "parentPageId");
        if (parentId is { } pid)
        {
            var parent = await db.Pages.FirstOrDefaultAsync(x => x.Id == pid && x.DeletedAt == null, ct) ?? throw new OpFailure("not.found", "Parent page not found");
            // The parent's level first: nothing else is said of a page the caller may not see.
            await NeedLevelAsync(member, pid, Levels.Edit);
            if (parent.TrashedAt is not null) throw new OpFailure("page.trashed", "The parent is in the trash");
            if (parent.SectionId != section.Id) throw new OpFailure("tree.section", "The parent is in another section");
            // No cycles: the new parent may not be the page or anything under it.
            if (pid == page.Id || await db.PageAncestors.AnyAsync(a => a.PageId == pid && a.AncestorPageId == page.Id, ct))
                throw new OpFailure(Codes.TreeCycle, "A page cannot move under itself");
        }
        else if (member.IsGuest && section.Visibility != "private") throw new OpFailure(Codes.AccessDenied, "Guests move pages only under pages shared with them");

        var sectionChanged = section.Id != page.SectionId;
        var parentChanged = parentId != page.ParentPageId;
        var from = await db.Sections.AsNoTracking().FirstAsync(s => s.Id == page.SectionId, ct);
        var subtree = await SubtreeAsync(page.Id, ct);
        // Between a shared and a private section, everyone else loses or gains the whole subtree:
        // only someone holding every page of it may move it.
        var crossing = from.Visibility != section.Visibility;
        if (crossing)
            await NeedFullOnAllAsync(member, subtree.Select(x => x.Id).ToList(), "Moving pages between a shared and a private section needs full access to every page moved");
        // Leaving the page that decides who sees it would hand it the section's default: only full
        // access moves it so, and it keeps what it had as its own rows.
        List<AccessRow>? kept = null;
        if (!crossing && section.Visibility != "private" && !page.Restricted && parentChanged
            && await access.DecidingPageAsync(page.ParentPageId) != await access.DecidingPageAsync(parentId))
        {
            await NeedLevelAsync(member, page.Id, Levels.Full);
            kept = await access.EffectiveRowsAsync(member.WorkspaceId, page.Id);
        }

        var orderKey = await FreeKeyAsync(section.Id, parentId, Key(p), page.Id, ct);
        page.SectionId = section.Id;
        page.ParentPageId = parentId;
        page.OrderKey = orderKey;
        page.Version++;
        page.UpdatedAt = now;
        page.UpdatedBy = member.UserId;
        if (kept is not null) await KeepAccessAsync(member, page, kept, now, ct);
        changes.Add("page", page.Id, "upsert", page.Version, member.UserId);
        if (sectionChanged)
            foreach (var child in subtree.Where(x => x.Id != page.Id))
            {
                child.SectionId = section.Id;
                child.Version++;
                changes.Add("page", child.Id, "upsert", child.Version, member.UserId);
            }
        await db.SaveChangesAsync(ct);
        if (parentChanged) await MoveClosureAsync(page.Id, parentId, ct);
        // Clients fetch the subtree again whenever who sees it may have changed, or pages moved with it.
        if (crossing || kept is not null || ((parentChanged || sectionChanged) && subtree.Count > 1))
            changes.Add("access", page.Id, crossing && section.Visibility == "private" ? "revoke" : "grant", page.Version, member.UserId);
        return await AppliedPage(member, op, page);
    }

    private async Task<OpResultDto> RestorePageAsync(Member member, OperationDto op, CancellationToken ct)
    {
        var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
        if (page.TrashRootId != page.Id) throw new OpFailure("page.notTrashed", "The page is not in the trash");
        var parent = page.ParentPageId is { } pid ? await db.Pages.FirstOrDefaultAsync(x => x.Id == pid && x.DeletedAt == null, ct) : null;
        var moved = false;
        List<AccessRow>? kept = null;
        if (page.ParentPageId is not null && (parent is null || parent.TrashedAt is not null))
        {
            // The old parent is gone: back to the top of its section, keeping the access it had
            // under that parent (read before the closure table forgets the parent).
            var section = await db.Sections.AsNoTracking().FirstAsync(s => s.Id == page.SectionId, ct);
            if (section.Visibility != "private" && !page.Restricted) kept = await AccessToKeepAsync(member, page.Id);
            page.ParentPageId = null;
            page.OrderKey = OrderKeys.Between(await LastTopKeyAsync(page.SectionId, page.Id, ct), null);
            moved = true;
        }
        page.TrashedAt = null;
        page.TrashRootId = null;
        page.TrashedBy = null;
        page.Version++;
        if (kept is not null) await KeepAccessAsync(member, page, kept, clock.GetUtcNow(), ct);
        changes.Add("page", page.Id, "upsert", page.Version, member.UserId);
        foreach (var record in (await SubtreeAsync(page.Id, ct)).Where(x => x.Id != page.Id && x.TrashRootId == page.Id))
        {
            record.TrashedAt = null;
            record.TrashRootId = null;
            record.TrashedBy = null;
            record.Version++;
            changes.Add("page", record.Id, "upsert", record.Version, member.UserId);
        }
        await db.SaveChangesAsync(ct);
        if (moved)
        {
            await MoveClosureAsync(page.Id, null, ct);
            changes.Add("access", page.Id, "grant", page.Version, member.UserId);
        }
        return await AppliedPage(member, op, page);
    }

    /// <summary>
    /// The rows a page falling back to the top of its section keeps: what the chain from
    /// <paramref name="from"/> gave it, and the actor's own full row when that gives them nothing.
    /// </summary>
    private async Task<List<AccessRow>> AccessToKeepAsync(Member member, Guid? from)
    {
        var rows = await access.EffectiveRowsAsync(member.WorkspaceId, from);
        if (Access.LevelUnder(member, rows) == Levels.None) rows.Add(new AccessRow("user", member.UserId, Levels.Full));
        return rows;
    }

    /// <summary>Makes the page restricted to <paramref name="rows"/>: its access no longer depends on where it is.</summary>
    private async Task KeepAccessAsync(Member member, Page page, IReadOnlyList<AccessRow> rows, DateTimeOffset now, CancellationToken ct)
    {
        // Deleted in the database, not tracked: a row can come back with the same key and a new level.
        await db.PagePermissions.Where(r => r.PageId == page.Id).ExecuteDeleteAsync(ct);
        foreach (var row in rows)
            db.PagePermissions.Add(new PagePermission
            {
                PageId = page.Id,
                PrincipalType = row.PrincipalType,
                PrincipalId = row.PrincipalId,
                Level = row.Level,
                WorkspaceId = member.WorkspaceId,
                CreatedBy = member.UserId,
                CreatedAt = now,
            });
        page.Restricted = true;
    }

    /// <summary>A cover is taken only from a file the actor may read: knowing its id is not enough.</summary>
    private async Task<Guid?> CoverAsync(Member member, JsonElement payload, Guid? current, CancellationToken ct)
    {
        var cover = OptionalId(payload, "coverAssetId");
        if (cover is not { } id || id == current) return cover;
        var asset = await db.Assets.AsNoTracking().FirstOrDefaultAsync(a => a.Id == id, ct);
        if (asset is null || !await assets.CanReadAsync(member, asset, ct))
            throw new OpFailure(Codes.AccessDenied, "The cover is a file you may not read");
        return cover;
    }

    private async Task NeedFullOnAllAsync(Member member, List<Guid> ids, string why)
    {
        var levels = ids.Count > 1 ? await access.AllLevelsAsync(member) : null;
        foreach (var id in ids)
        {
            var level = levels is not null ? levels.GetValueOrDefault(id, Levels.None) : await access.PageLevelAsync(member, id);
            if (level != Levels.Full) throw new OpFailure(Codes.AccessDenied, why);
        }
    }

    // ------------------------------------------------------------------------------------------

    private async Task<Section> SectionFor(Member member, Guid id, CancellationToken ct)
    {
        var section = await db.Sections.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (section is null || !Access.SeesSection(member, section)) throw new OpFailure("not.found", "Section not found");
        if (section.Visibility == "workspace" && member.IsGuest) throw new OpFailure(Codes.AccessDenied, "Guests do not change sections");
        return section;
    }

    private async Task<Page> PageFor(Member member, Guid id, string level, CancellationToken ct)
    {
        var page = await db.Pages.FirstOrDefaultAsync(p => p.Id == id && p.DeletedAt == null, ct) ?? throw new OpFailure("not.found", "Page not found");
        await NeedLevelAsync(member, page.Id, level);
        return page;
    }

    private async Task NeedLevelAsync(Member member, Guid pageId, string wanted)
    {
        var level = await access.PageLevelAsync(member, pageId);
        if (level == Levels.None) throw new OpFailure("not.found", "Page not found");
        if (!Levels.AtLeast(level, wanted)) throw new OpFailure(Codes.AccessDenied, $"This needs {wanted} access");
    }

    private static void CheckBase(Page page, OperationDto op)
    {
        if (op.BaseVersion is { } baseVersion && baseVersion != page.Version)
            throw new OpFailure(Codes.VersionConflict, $"{op.Type} on version {baseVersion}, now {page.Version}");
    }

    private async Task<List<Page>> SubtreeAsync(Guid pageId, CancellationToken ct)
    {
        var ids = await db.PageAncestors.Where(a => a.AncestorPageId == pageId).Select(a => a.PageId).ToListAsync(ct);
        if (!ids.Contains(pageId)) ids.Add(pageId);
        var pages = new List<Page>();
        foreach (var chunk in Chunked.Of(ids))
            pages.AddRange(await db.Pages.Where(p => chunk.Contains(p.Id) && p.DeletedAt == null).ToListAsync(ct));
        return pages;
    }

    private async Task AddClosureAsync(Guid pageId, Guid? parentId, CancellationToken ct)
    {
        db.PageAncestors.Add(new PageAncestor { PageId = pageId, AncestorPageId = pageId, Depth = 0, WorkspaceId = db.TenantId!.Value });
        if (parentId is { } parent)
        {
            var above = await db.PageAncestors.AsNoTracking().Where(a => a.PageId == parent).ToListAsync(ct);
            foreach (var row in above)
                db.PageAncestors.Add(new PageAncestor { PageId = pageId, AncestorPageId = row.AncestorPageId, Depth = row.Depth + 1, WorkspaceId = row.WorkspaceId });
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The closure table after a move: the subtree loses its old ancestors and gains the new parent's.</summary>
    private async Task MoveClosureAsync(Guid pageId, Guid? newParentId, CancellationToken ct)
    {
        var subtree = await db.PageAncestors.AsNoTracking().Where(a => a.AncestorPageId == pageId).ToListAsync(ct);
        var oldAbove = await db.PageAncestors.AsNoTracking().Where(a => a.PageId == pageId && a.Depth > 0).Select(a => a.AncestorPageId).ToListAsync(ct);
        var ids = subtree.Select(s => s.PageId).Distinct().ToList();
        foreach (var chunk in Chunked.Of(ids))
            foreach (var above in Chunked.Of(oldAbove))
                await db.PageAncestors.Where(a => chunk.Contains(a.PageId) && above.Contains(a.AncestorPageId)).ExecuteDeleteAsync(ct);
        if (newParentId is { } parent)
        {
            var newAbove = await db.PageAncestors.AsNoTracking().Where(a => a.PageId == parent).ToListAsync(ct);
            foreach (var below in subtree)
                foreach (var row in newAbove)
                    db.PageAncestors.Add(new PageAncestor { PageId = below.PageId, AncestorPageId = row.AncestorPageId, Depth = below.Depth + row.Depth + 1, WorkspaceId = row.WorkspaceId });
            await db.SaveChangesAsync(ct);
        }
    }

    private async Task<string?> LastTopKeyAsync(Guid sectionId, Guid? except, CancellationToken ct)
    {
        var keys = await db.Pages.Where(p => p.SectionId == sectionId && p.ParentPageId == null && p.TrashedAt == null && p.DeletedAt == null && p.Id != except)
            .Select(p => p.OrderKey).ToListAsync(ct);
        return keys.OrderBy(k => k, StringComparer.Ordinal).LastOrDefault();
    }

    /// <summary>Two offline clients can pick the same key between the same neighbours: the later one gets a new one.</summary>
    private async Task<string> FreeKeyAsync(Guid sectionId, Guid? parentId, string key, Guid? except, CancellationToken ct)
    {
        var siblings = (await db.Pages.Where(p => p.SectionId == sectionId && p.ParentPageId == parentId && p.DeletedAt == null && p.Id != except)
                .Select(p => p.OrderKey).ToListAsync(ct))
            .OrderBy(k => k, StringComparer.Ordinal).ToList();
        if (!siblings.Contains(key, StringComparer.Ordinal)) return key;
        var next = siblings.FirstOrDefault(k => string.CompareOrdinal(k, key) > 0);
        return OrderKeys.Between(key, next);
    }

    private async Task<OpResultDto> AppliedPage(Member member, OperationDto op, Page page) =>
        Applied(op, "page", new EntityDto(Page: PageDto.From(page, await access.PageLevelAsync(member, page.Id))));

    private static OpResultDto Applied(OperationDto op, string entityType, EntityDto? entity) =>
        new(op.OpId, "applied", null, entityType, entity, null);

    // Payload fields ------------------------------------------------------------------------------

    private static bool Has(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out _);

    private static string? Text(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool Str(JsonElement payload, string name, out string value)
    {
        value = Text(payload, name)!;
        return value is not null;
    }

    private static Guid? OptionalId(JsonElement payload, string name) =>
        Guid.TryParse(Text(payload, name), out var id) ? id : null;

    private static string Key(JsonElement payload) =>
        Text(payload, "orderKey") is { } key && OrderKeys.IsValid(key) ? key : throw new OpFailure("invalid", "Not an order key");

    private static string Name(string name)
    {
        name = name.Trim();
        return name.Length is > 0 and <= 200 ? name : throw new OpFailure("invalid", "A name of 1 to 200 characters is needed");
    }

    private static string Title(string title) => title.Length <= 1000 ? title : throw new OpFailure("invalid", "The title is longer than 1,000 characters");

    private static string? Icon(JsonElement payload)
    {
        var icon = Text(payload, "icon");
        return icon is null ? null : icon.Length <= 64 ? icon : throw new OpFailure("invalid", "The icon is too long");
    }
}
