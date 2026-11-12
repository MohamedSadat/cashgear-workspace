using System.Data;
using System.Text.Json;
using Cgw.Core.Assets;
using Cgw.Core.Data;
using Cgw.Core.Databases;
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
public sealed class OpsService(CgwDb db, Access access, AssetService assets, ChangeLog changes, Audit audit, DatabaseOps databases, TimeProvider clock)
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
        foreach (var name in new[] { "parentPageId", "sectionId", "databaseId" })
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
            databases.Reset();
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
                // The database rules' writes: rows computed again, stamped, in the feed.
                await databases.FlushAsync(ct);
                await db.SaveChangesAsync(ct);
                await changes.FlushAsync(ct);
                // Answers that carry a row or a database are made after the flush (computed values, counts).
                result = await AnswerAsync(member, op, result, ct);
            }
            catch (OpFailure failure)
            {
                await tx.RollbackAsync(ct);
                db.ChangeTracker.Clear();
                databases.Reset();
                var (type, entity) = await CurrentAsync(member, op);
                result = Rejected(op, failure.Code, failure.Message) with { EntityType = type, Entity = entity };
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

    /// <summary>The entity as the caller may see it now, sent with a refusal so the client can put it right.</summary>
    private async Task<(string? Type, EntityDto? Entity)> CurrentAsync(Member member, OperationDto op)
    {
        switch (op.Type.Split('.')[0])
        {
            case "page":
            case "row":
            {
                var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == op.EntityId && p.DeletedAt == null);
                var isRow = page?.Kind == PageKinds.Row || op.Type == "row.update"
                    || (op.Type == "page.create" && Text(op.Payload, "kind") == PageKinds.Row);
                if (page is null) return (isRow ? "row" : "page", null);
                var level = await access.PageLevelAsync(member, page.Id);
                if (level == Levels.None) return (isRow ? "row" : "page", null);
                if (page.Kind != PageKinds.Row) return ("page", new EntityDto(Page: PageDto.From(page, level)));
                var row = await db.DatabaseRows.AsNoTracking().FirstOrDefaultAsync(r => r.PageId == page.Id);
                return ("row", row is null ? null : new EntityDto(Row: RowDto.From(page, row, level)));
            }
            case "db":
            {
                var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == op.EntityId);
                if (record is null || await access.PageLevelAsync(member, record.PageId) == Levels.None) return ("database", null);
                return ("database", new EntityDto(Database: DatabaseDto.From(record)));
            }
            case "view":
            {
                var view = await db.DatabaseViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == op.EntityId);
                if (view is null || await access.PageLevelAsync(member, view.DatabaseId) == Levels.None) return ("view", null);
                return ("view", new EntityDto(View: ViewDto.From(view)));
            }
            case "section":
            {
                var section = await db.Sections.AsNoTracking().FirstOrDefaultAsync(s => s.Id == op.EntityId);
                return ("section", section is null || !Access.SeesSection(member, section) ? null : new EntityDto(Section: SectionDto.From(section)));
            }
            case "workspace":
            {
                var workspace = await db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Id == member.WorkspaceId);
                return ("workspace", workspace is null ? null : new EntityDto(Workspace: WorkspaceDto.From(workspace, member.Role)));
            }
            case "favourite":
                return ("favourite", null);
            case "visit":
                return ("visit", null);
            default:
                return (null, null);
        }
    }

    /// <summary>Stands for the entity of an answer made after the database rules have written (<see cref="AnswerAsync"/>).</summary>
    private static readonly EntityDto Pending = new();

    /// <summary>
    /// An applied answer naming a row or a database, made after the database rules have written:
    /// rows carry their computed values, databases their counts; a database page's create carries
    /// its database record beside its page.
    /// </summary>
    private async Task<OpResultDto> AnswerAsync(Member member, OperationDto op, OpResultDto result, CancellationToken ct)
    {
        if (result.Status != "applied") return result;
        if (ReferenceEquals(result.Entity, Pending))
        {
            if (result.EntityType == "row")
            {
                var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == op.EntityId && p.DeletedAt == null, ct);
                var row = page is null ? null : await databases.RowDtoAsync(member, page, ct);
                return result with { Entity = row is null ? null : new EntityDto(Row: row) };
            }
            var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == op.EntityId, ct);
            return result with { Entity = record is null ? null : new EntityDto(Database: DatabaseDto.From(record)) };
        }
        if (op.Type == "page.create" && result.Entity?.Page is { Kind: PageKinds.Database } created)
        {
            var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == created.Id, ct);
            return result with { Entity = result.Entity with { Database = record is null ? null : DatabaseDto.From(record) } };
        }
        return result;
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
                if (await ReadsTrashedAsync(page, ct)) throw new OpFailure("page.trashed", "The page is in the trash");
                var counted = Counts(page);
                var titleChanged = false;
                if (Str(payload, "title", out var title))
                {
                    titleChanged = page.Title != Title(title);
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
                if (page.Kind == PageKinds.Row)
                {
                    // A row's page is one of its cells (the title) and its count (a template is not counted).
                    await databases.TouchRowAsync(member, page, (Counts(page) ? 1 : 0) - (counted ? 1 : 0), titleChanged, false, ct);
                    return Applied(op, "row", Pending);
                }
                changes.Add("page", page.Id, "upsert", page.Version, member.UserId);
                return await AppliedPage(member, op, page);
            }
            case "page.move":
                return await MovePageAsync(member, op, now, ct);
            case "page.trash":
            {
                var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
                CheckBase(page, op);
                if (await ReadsTrashedAsync(page, ct)) throw new OpFailure("page.trashed", "The page is in the trash");
                if (page.Kind == PageKinds.Row)
                {
                    // A row is its own trash root; its database stays.
                    var counted = Counts(page);
                    page.TrashedAt = now;
                    page.TrashRootId = page.Id;
                    page.TrashedBy = member.UserId;
                    page.Version++;
                    await databases.TouchRowAsync(member, page, counted ? -1 : 0, false, true, ct);
                    return Applied(op, "row", Pending);
                }
                // The subtree goes as one unit; pages already trashed on their own keep their root.
                var subtree = await SubtreeAsync(page.Id, ct);
                foreach (var record in subtree)
                {
                    if (record.TrashedAt is not null) continue;
                    record.TrashedAt = now;
                    record.TrashRootId = page.Id;
                    record.TrashedBy = member.UserId;
                    record.Version++;
                    changes.Add("page", record.Id, "upsert", record.Version, member.UserId);
                }
                // And the rows of its databases with it (the subtree rule; rows are not in the closure table).
                await DatabaseTree.TrashAsync(db, changes, subtree, page.Id, member.UserId, now, ct);
                return await AppliedPage(member, op, page);
            }
            case "page.restore":
                return await RestorePageAsync(member, op, ct);
            case "page.delete":
            {
                var page = await PageFor(member, op.EntityId, Levels.Full, ct);
                if (!await ReadsTrashedAsync(page, ct)) throw new OpFailure("page.notTrashed", "Pages are deleted for good only from the trash");
                var subtree = await SubtreeAsync(page.Id, ct);
                var ids = subtree.Select(p => p.Id).ToList();
                // For good means every page of it, so it needs full access to every page of it
                // (a database's rows have its level: the database is among them).
                await NeedFullOnAllAsync(member, ids, "Deleting for good needs full access to every page under this one");
                await PageDeletion.TombstoneAsync(db, changes, subtree, member.UserId, now, ct);
                audit.Add(actor, "page.delete", member.WorkspaceId, "page", page.Id, new { pages = ids.Count });
                return Applied(op, page.Kind == PageKinds.Row ? "row" : "page", null);
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
            case "db.update":
            {
                var page = await LiveDatabaseAsync(member, op.EntityId, ct);
                await databases.UpdateDatabaseAsync(member, page, payload, ct);
                return Applied(op, "database", Pending);
            }
            case "view.upsert":
            {
                if (!Guid.TryParse(Text(payload, "id"), out var id) || id != op.EntityId) throw new OpFailure("invalid", "Id mismatch");
                if (!Guid.TryParse(Text(payload, "workspaceId"), out var ws) || ws != member.WorkspaceId) throw new OpFailure("invalid", "Id mismatch");
                if (!Guid.TryParse(Text(payload, "databaseId"), out var databaseId)) throw new OpFailure("invalid", "A view names its database");
                var page = await LiveDatabaseAsync(member, databaseId, ct);
                var record = await databases.DatabaseAsync(page.Id, ct) ?? throw new OpFailure("not.found", "Database not found");
                var view = await databases.UpsertViewAsync(member, id, payload, record, ct);
                return Applied(op, "view", new EntityDto(View: ViewDto.From(view)));
            }
            case "view.delete":
            {
                var view = await db.DatabaseViews.FirstOrDefaultAsync(v => v.Id == op.EntityId, ct) ?? throw new OpFailure("not.found", "View not found");
                await LiveDatabaseAsync(member, view.DatabaseId, ct);
                databases.DeleteView(member, view);
                return Applied(op, "view", null);
            }
            case "row.update":
            {
                var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
                if (page.Kind != PageKinds.Row) throw new OpFailure("invalid", "Not a row");
                if (await ReadsTrashedAsync(page, ct)) throw new OpFailure("page.trashed", "The row is in the trash");
                await databases.UpdateRowAsync(member, page, payload, ct);
                return Applied(op, "row", Pending);
            }
            default:
                throw new OpFailure("invalid", $"Unknown operation {op.Type}");
        }
    }

    /// <summary>A database page the caller may edit, not in the trash, for an operation on the database or its views.</summary>
    private async Task<Page> LiveDatabaseAsync(Member member, Guid id, CancellationToken ct)
    {
        var page = await PageFor(member, id, Levels.Edit, ct);
        if (page.Kind != PageKinds.Database) throw new OpFailure("invalid", "Not a database");
        if (page.TrashedAt is not null) throw new OpFailure("page.trashed", "The database is in the trash");
        return page;
    }

    /// <summary>A row counts towards its database's <c>rowCount</c> while it is neither trashed nor a template.</summary>
    private static bool Counts(Page page) => page.TrashedAt is null && !page.IsTemplate;

    /// <summary>A row reads as trashed when it or its database page is (ops.ts <c>readsTrashed</c>).</summary>
    private async Task<bool> ReadsTrashedAsync(Page page, CancellationToken ct)
    {
        if (page.TrashedAt is not null) return true;
        if (page.Kind != PageKinds.Row || page.ParentPageId is not { } database) return false;
        return await db.Pages.AnyAsync(p => p.Id == database && p.TrashedAt != null, ct);
    }

    private async Task<OpResultDto> CreatePageAsync(Member member, OperationDto op, DateTimeOffset now, CancellationToken ct)
    {
        var p = op.Payload;
        if (!Guid.TryParse(Text(p, "id"), out var id) || id != op.EntityId) throw new OpFailure("invalid", "Id mismatch");
        if (!Guid.TryParse(Text(p, "workspaceId"), out var ws) || ws != member.WorkspaceId) throw new OpFailure("invalid", "Id mismatch");
        if (await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AnyAsync(x => x.Id == id, ct)) throw new OpFailure("invalid", "Page exists");
        var kind = Text(p, "kind") ?? PageKinds.Page;
        if (kind is not (PageKinds.Page or PageKinds.Database or PageKinds.Row)) throw new OpFailure("invalid", $"Not a page kind: {kind}");
        if (!Guid.TryParse(Text(p, "sectionId"), out var sectionId)) throw new OpFailure("invalid", "No section");
        var section = await db.Sections.FirstOrDefaultAsync(s => s.Id == sectionId, ct) ?? throw new OpFailure("not.found", "Section not found");
        if (!Access.SeesSection(member, section)) throw new OpFailure("not.found", "Section not found");
        if (kind == PageKinds.Row) return await CreateRowAsync(member, op, section, now, ct);
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
            // Only rows sit under a database, and nothing under a row (contract section 1).
            if (parent is not null && parent.Kind != PageKinds.Page)
                throw new OpFailure("invalid", parent.Kind == PageKinds.Row ? "Nothing sits under a row" : "Only rows sit under a database");
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
        var page = NewPage(member, p, id, section.Id, parent?.Id, orderKey, kind, cover, now);
        db.Pages.Add(page);
        // Not under the parent it was made for: it keeps that parent's access, never the section's
        // default. With no trace of the parent, only its maker (and admins) may see it.
        var kept = fellBack && section.Visibility != "private";
        if (kept) await KeepAccessAsync(member, page, await AccessToKeepAsync(member, accessFrom), now, ct);
        await db.SaveChangesAsync(ct);
        await AddClosureAsync(page.Id, parent?.Id, ct);
        changes.Add("page", page.Id, "upsert", page.Version, member.UserId);
        if (kept) changes.Add("access", page.Id, "grant", page.Version, member.UserId);
        if (kind == PageKinds.Database) await databases.CreateDatabaseAsync(member, page, p, ct);
        return (await AppliedPage(member, op, page)) with { Notice = notice };
    }

    private Page NewPage(Member member, JsonElement p, Guid id, Guid sectionId, Guid? parentId, string orderKey, string kind, Guid? cover, DateTimeOffset now)
    {
        var title = Title(Text(p, "title") ?? "");
        return new Page
        {
            Id = id,
            WorkspaceId = member.WorkspaceId,
            SectionId = sectionId,
            ParentPageId = parentId,
            OrderKey = orderKey,
            Kind = kind,
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
    }

    /// <summary>
    /// A row is made in its database (same section, edit on the database), never in the closure
    /// table: its level is its database's. A row made offline in a database another device has
    /// since put in the trash goes to the trash with it, so nothing typed is lost.
    /// </summary>
    private async Task<OpResultDto> CreateRowAsync(Member member, OperationDto op, Section section, DateTimeOffset now, CancellationToken ct)
    {
        var p = op.Payload;
        if (OptionalId(p, "parentPageId") is not { } databaseId) throw new OpFailure("invalid", "A row is made in its database");
        var parent = await db.Pages.FirstOrDefaultAsync(x => x.Id == databaseId && x.DeletedAt == null, ct) ?? throw new OpFailure("not.found", "Database not found");
        await NeedLevelAsync(member, parent.Id, Levels.Edit);
        if (parent.Kind != PageKinds.Database) throw new OpFailure("invalid", "A row is made in its database");
        if (parent.SectionId != section.Id) throw new OpFailure("tree.section", "The database is in another section");
        var database = await databases.DatabaseAsync(parent.Id, ct) ?? throw new OpFailure("not.found", "Database not found");
        var cover = await CoverAsync(member, p, null, ct);
        var orderKey = await FreeRowKeyAsync(parent, Key(p), null, ct);
        var page = NewPage(member, p, op.EntityId, section.Id, parent.Id, orderKey, PageKinds.Row, cover, now);
        if (parent.TrashedAt is not null)
        {
            page.TrashedAt = parent.TrashedAt;
            page.TrashRootId = parent.TrashRootId;
            page.TrashedBy = member.UserId;
        }
        db.Pages.Add(page);
        await databases.CreateRowAsync(member, page, database, p, ct);
        return Applied(op, "row", Pending);
    }

    /// <summary>A row's order key among its database's rows: equal keys from two devices get a new one (rows are many: only the neighbours are read).</summary>
    private async Task<string> FreeRowKeyAsync(Page database, string key, Guid? except, CancellationToken ct)
    {
        var siblings = db.Pages.Where(x => x.SectionId == database.SectionId && x.ParentPageId == database.Id && x.DeletedAt == null && x.Id != except);
        if (!await siblings.AnyAsync(x => x.OrderKey == key, ct)) return key;
        var next = await siblings.Where(x => string.Compare(x.OrderKey, key) > 0).OrderBy(x => x.OrderKey).Select(x => x.OrderKey).FirstOrDefaultAsync(ct);
        return OrderKeys.Between(key, next);
    }

    private async Task<OpResultDto> MovePageAsync(Member member, OperationDto op, DateTimeOffset now, CancellationToken ct)
    {
        var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
        CheckBase(page, op);
        if (await ReadsTrashedAsync(page, ct)) throw new OpFailure("page.trashed", "The page is in the trash");
        var p = op.Payload;
        if (!Guid.TryParse(Text(p, "sectionId"), out var sectionId)) throw new OpFailure("invalid", "No section");
        var parentId = OptionalId(p, "parentPageId");
        if (page.Kind == PageKinds.Row)
        {
            // A row never leaves its database: a move only reorders it among the rows.
            if (sectionId != page.SectionId || parentId != page.ParentPageId) throw new OpFailure("invalid", "A row moves only among its database's rows");
            var database = await db.Pages.AsNoTracking().FirstAsync(x => x.Id == page.ParentPageId, ct);
            page.OrderKey = await FreeRowKeyAsync(database, Key(p), page.Id, ct);
            page.Version++;
            page.UpdatedAt = now;
            page.UpdatedBy = member.UserId;
            await databases.TouchRowAsync(member, page, 0, false, false, ct);
            return Applied(op, "row", Pending);
        }
        var section = await db.Sections.FirstOrDefaultAsync(s => s.Id == sectionId, ct) ?? throw new OpFailure("not.found", "Section not found");
        if (!Access.SeesSection(member, section)) throw new OpFailure("not.found", "Section not found");
        if (parentId is { } pid)
        {
            var parent = await db.Pages.FirstOrDefaultAsync(x => x.Id == pid && x.DeletedAt == null, ct) ?? throw new OpFailure("not.found", "Parent page not found");
            // The parent's level first: nothing else is said of a page the caller may not see.
            await NeedLevelAsync(member, pid, Levels.Edit);
            if (parent.TrashedAt is not null) throw new OpFailure("page.trashed", "The parent is in the trash");
            if (parent.SectionId != section.Id) throw new OpFailure("tree.section", "The parent is in another section");
            if (parent.Kind != PageKinds.Page)
                throw new OpFailure("invalid", parent.Kind == PageKinds.Row ? "Nothing sits under a row" : "Only rows sit under a database");
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
        // A database's rows are in its section: they move with it.
        if (sectionChanged) await DatabaseTree.MoveAsync(db, changes, subtree, section.Id, member.UserId, now, ct);
        // Clients fetch the subtree again whenever who sees it may have changed, or pages moved with it.
        if (crossing || kept is not null || ((parentChanged || sectionChanged) && subtree.Count > 1))
            changes.Add("access", page.Id, crossing && section.Visibility == "private" ? "revoke" : "grant", page.Version, member.UserId);
        return await AppliedPage(member, op, page);
    }

    private async Task<OpResultDto> RestorePageAsync(Member member, OperationDto op, CancellationToken ct)
    {
        var page = await PageFor(member, op.EntityId, Levels.Edit, ct);
        if (page.TrashRootId != page.Id) throw new OpFailure("page.notTrashed", "The page is not in the trash");
        var now = clock.GetUtcNow();
        if (page.Kind == PageKinds.Row)
        {
            // Back into its database, where it was.
            page.TrashedAt = null;
            page.TrashRootId = null;
            page.TrashedBy = null;
            page.Version++;
            await databases.TouchRowAsync(member, page, Counts(page) ? 1 : 0, false, true, ct);
            return Applied(op, "row", Pending);
        }
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
        if (kept is not null) await KeepAccessAsync(member, page, kept, now, ct);
        changes.Add("page", page.Id, "upsert", page.Version, member.UserId);
        var subtree = await SubtreeAsync(page.Id, ct);
        foreach (var record in subtree.Where(x => x.Id != page.Id && x.TrashRootId == page.Id))
        {
            record.TrashedAt = null;
            record.TrashRootId = null;
            record.TrashedBy = null;
            record.Version++;
            changes.Add("page", record.Id, "upsert", record.Version, member.UserId);
        }
        await db.SaveChangesAsync(ct);
        // The rows that went to the trash with it come back with it.
        await DatabaseTree.RestoreAsync(db, changes, subtree, page.Id, member.UserId, now, ct);
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

    private Task<List<Page>> SubtreeAsync(Guid pageId, CancellationToken ct) => PageDeletion.SubtreeAsync(db, pageId, ct);

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

/// <summary>
/// Deleting pages for good (DATA_MODEL.md, Tree rules: only from the trash, by a person or when
/// the trash's 60 days end), the same way either way.
/// </summary>
public static class PageDeletion
{
    /// <summary>The page and every page under it not deleted already, tracked.</summary>
    public static async Task<List<Page>> SubtreeAsync(CgwDb db, Guid pageId, CancellationToken ct)
    {
        var ids = await db.PageAncestors.Where(a => a.AncestorPageId == pageId).Select(a => a.PageId).ToListAsync(ct);
        if (!ids.Contains(pageId)) ids.Add(pageId);
        var pages = new List<Page>();
        foreach (var chunk in Chunked.Of(ids))
            pages.AddRange(await db.Pages.Where(p => chunk.Contains(p.Id) && p.DeletedAt == null).ToListAsync(ct));
        return pages;
    }

    /// <summary>
    /// Each page a tombstone (the title goes now; the document, versions and files go with the
    /// worker's purge), a feed <c>delete</c> for each, and its place in the tree, favourites and
    /// visits gone. Call under the workspace's lock; the caller writes its audit entry.
    /// </summary>
    public static async Task TombstoneAsync(CgwDb db, ChangeLog changes, List<Page> subtree, Guid? actor, DateTimeOffset now, CancellationToken ct)
    {
        foreach (var record in subtree)
        {
            record.DeletedAt = now;
            record.Title = "";
            record.SearchTitle = "";
            record.Version++;
            changes.Add("page", record.Id, "delete", record.Version, actor);
        }
        foreach (var chunk in Chunked.Of(subtree.Select(p => p.Id)))
        {
            await db.Favourites.Where(f => chunk.Contains(f.PageId)).ExecuteDeleteAsync(ct);
            await db.PageVisits.Where(v => chunk.Contains(v.PageId)).ExecuteDeleteAsync(ct);
            await db.PageAncestors.Where(a => chunk.Contains(a.PageId)).ExecuteDeleteAsync(ct);
        }
        // Rows are not in the closure table: a row deleted on its own, and every row of a database
        // deleted with its page (Phase 4 contracts, section 1).
        await DatabaseTree.DeleteRowsAsync(db, changes, subtree, actor, now, ct);
        await DatabaseTree.DeleteDatabasesAsync(db, changes, subtree, actor, now, ct);
    }
}
