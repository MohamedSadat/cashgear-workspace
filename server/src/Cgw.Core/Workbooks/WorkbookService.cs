using System.Data;
using System.Security.Cryptography;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sharing;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workbooks;

public sealed record UserRefDto(Guid Id, string Name);

/// <summary>
/// A workbook as the app sees it (Phase 5 contracts, section 6): <c>version</c> is the record's
/// (the <c>ETag</c> of its <c>GET</c>, the <c>If-Match</c> of its <c>PATCH</c>), <c>etag</c> the
/// content's (<c>"&lt;versionId&gt;"</c>, null with no version), <c>access</c> the caller's level.
/// </summary>
public sealed record WorkbookDto(
    Guid Id,
    Guid WorkspaceId,
    string Name,
    long Version,
    Guid? VersionId,
    string? Etag,
    long? Size,
    DateTimeOffset? SavedAt,
    UserRefDto? SavedBy,
    Guid CreatedBy,
    DateTimeOffset CreatedAt,
    DateTimeOffset? TrashedAt,
    string Access);

public sealed record WorkbookListDto(IReadOnlyList<WorkbookDto> Workbooks);
public sealed record NewWorkbook(Guid? Id, string? Name);
public sealed record WorkbookUpdate(string? Name, bool? Trashed);

/// <summary>A signed URL for exactly the current version's blob, about 5 minutes; all null with no version.</summary>
public sealed record WorkbookContentDto(string? ReadUrl, string? Etag, long? Size, Guid? VersionId, DateTimeOffset? ExpiresAt);

public sealed record WorkbookPreviewDto(string Url, Guid VersionId, string Etag, DateTimeOffset MadeAt, int Width, int Height, DateTimeOffset ExpiresAt);
public sealed record WorkbookSheetDto(string Name, string? UsedRange, bool Hidden);
public sealed record WorkbookSheetsDto(IReadOnlyList<WorkbookSheetDto> Sheets);
public sealed record WorkbookRangeDto(string Sheet, string? Range, string Csv);
public sealed record WorkbookExportRequest(Guid? ViewId, string? Name);

/// <summary>A save's condition: <c>If-Match</c>'s tags, or <c>If-None-Match</c> (only <c>*</c> passes).</summary>
public sealed record SavePrecondition(IReadOnlyList<string>? IfMatch, string? IfNoneMatch);

/// <summary>
/// Workbooks (M5.2; INTEGRATIONS.md, Workbooks as their own documents): the record, its own access
/// list by the pages' rules (<see cref="WorkbookAccess"/>), its versions as blobs (a save is a new
/// version, never an overwrite; the newest <see cref="KeepVersions"/> are kept), its pictures, and
/// reading a range for import. Never reachable outside its workspace, never by a share link; not in
/// the change feed and not in search.
/// </summary>
public sealed class WorkbookService(
    CgwDb db,
    BlobStore blob,
    WorkbookAccess levels,
    Access access,
    ChangeLog changes,
    Audit audit,
    TimeProvider clock,
    Integrations settings,
    DatabaseService databases)
{
    public const int MaxName = 200;
    public const int MaxList = 1000;
    public const int MaxEntries = 500;
    /// <summary>Versions kept per workbook: the newest; older ones go with their pictures.</summary>
    public const int KeepVersions = 10;
    /// <summary>Views pictured per workbook; the oldest picture goes past it.</summary>
    public const int MaxPreviews = 100;

    public static string Etag(Guid versionId) => $"\"{versionId}\"";

    public static Failure Gone() => new(Codes.WorkbookGone, 410, "The workbook was deleted");

    public static string Sha256Hex(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    /// <summary>A name with no control characters, trimmed, at most 200 characters; null when nothing is left.</summary>
    public static string? CleanName(string? name)
    {
        var clean = new string((name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (clean.Length > MaxName) clean = clean[..(char.IsHighSurrogate(clean[MaxName - 1]) ? MaxName - 1 : MaxName)].TrimEnd();
        return clean.Length == 0 ? null : clean;
    }

    // Reading -----------------------------------------------------------------------------------------

    /// <summary>The workbooks the caller can read: live ones, or the trash; <paramref name="q"/> by name. The most recently changed first.</summary>
    public async Task<WorkbookListDto> ListAsync(Member member, bool trashed, string? q, CancellationToken ct = default)
    {
        var query = db.Workbooks.AsNoTracking();
        query = trashed ? query.Where(w => w.TrashedAt != null) : query.Where(w => w.TrashedAt == null);
        if (TextNormaliser.Normalise(q ?? "") is { Length: > 0 } term) query = query.Where(w => w.SearchName.Contains(term));
        // A guest reads only what names them.
        if (member.IsGuest)
            query = query.Where(w => db.WorkbookPermissions.Any(r => r.WorkbookId == w.Id && r.PrincipalType == Principals.User && r.PrincipalId == member.UserId));
        var books = await query.OrderByDescending(w => w.UpdatedAt).ThenBy(w => w.Id).Take(MaxList).ToListAsync(ct);
        var found = await levels.LevelsAsync(member, books, ct);
        var readable = books.Where(b => found[b.Id] != Levels.None).ToList();
        return new WorkbookListDto(await DtosAsync(readable, found, ct));
    }

    public async Task<WorkbookDto> DtoAsync(Workbook book, string level, CancellationToken ct = default) =>
        (await DtosAsync([book], new Dictionary<Guid, string> { [book.Id] = level }, ct))[0];

    private async Task<List<WorkbookDto>> DtosAsync(IReadOnlyList<Workbook> books, IReadOnlyDictionary<Guid, string> found, CancellationToken ct)
    {
        var ids = books.Where(b => b.CurrentVersionId is not null).Select(b => b.CurrentVersionId!.Value).ToList();
        var versions = new Dictionary<Guid, WorkbookVersion>();
        foreach (var chunk in ids.Chunk(1000).Select(c => c.ToList()))
            foreach (var v in await db.WorkbookVersions.AsNoTracking().Where(v => chunk.Contains(v.Id)).ToListAsync(ct))
                versions[v.Id] = v;
        var names = await NamesAsync(versions.Values.Select(v => v.SavedBy), ct);
        return books.Select(b =>
        {
            var v = b.CurrentVersionId is { } id ? versions.GetValueOrDefault(id) : null;
            return new WorkbookDto(b.Id, b.WorkspaceId, b.Name, b.Version, v?.Id, v is null ? null : Etag(v.Id), v?.SizeBytes, v?.SavedAt,
                v is null ? null : new UserRefDto(v.SavedBy, names.GetValueOrDefault(v.SavedBy) ?? "Someone"), b.CreatedBy, b.CreatedAt, b.TrashedAt, found[b.Id]);
        }).ToList();
    }

    /// <summary>People's names as others are shown them; never empty.</summary>
    public async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid> userIds, CancellationToken ct = default)
    {
        var ids = userIds.Distinct().ToList();
        var result = new Dictionary<Guid, string>();
        foreach (var chunk in ids.Chunk(1000).Select(c => c.ToList()))
            foreach (var u in await db.Users.AsNoTracking().Where(u => chunk.Contains(u.Id)).Select(u => new { u.Id, u.DisplayName, u.DeletedAt }).ToListAsync(ct))
                result[u.Id] = u.DeletedAt is not null ? "Deleted user" : u.DisplayName is { Length: > 0 } name ? name : "Someone";
        return result;
    }

    public async Task<WorkbookVersion?> CurrentAsync(Guid workbookId, CancellationToken ct = default)
    {
        var id = await db.Workbooks.AsNoTracking().Where(w => w.Id == workbookId).Select(w => w.CurrentVersionId).FirstOrDefaultAsync(ct);
        return id is { } v ? await db.WorkbookVersions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == v, ct) : null;
    }

    /// <summary>The current version's bytes by signed URL (about 5 minutes, that one blob).</summary>
    public async Task<Result<WorkbookContentDto>> ContentAsync(Workbook book, CancellationToken ct = default)
    {
        if (book.TrashedAt is not null) return Gone();
        if (await CurrentAsync(book.Id, ct) is not { } version) return new WorkbookContentDto(null, null, null, null, null);
        var url = await blob.ReadUrlAsync(version.BlobKey, ct: ct);
        return new WorkbookContentDto(url.ToString(), Etag(version.Id), version.SizeBytes, version.Id, clock.GetUtcNow() + BlobStore.ReadLifetime);
    }

    private async Task<Result<byte[]>> BytesAsync(Workbook book, CancellationToken ct)
    {
        if (book.TrashedAt is not null) return Gone();
        if (await CurrentAsync(book.Id, ct) is not { } version) return Failure.Conflict(Codes.Conflict, "The workbook has no saved version yet");
        if (await blob.GetAsync(version.BlobKey, ct) is { } bytes) return bytes;
        return new Failure(Codes.ServerError, 503, "The workbook's file is not available") { RetryAfter = TimeSpan.FromSeconds(30) };
    }

    /// <summary>The sheets of the current version, each with the cells that hold values; none with no version.</summary>
    public async Task<Result<WorkbookSheetsDto>> SheetsAsync(Workbook book, CancellationToken ct = default)
    {
        if (book.TrashedAt is not null) return Gone();
        if (book.CurrentVersionId is null) return new WorkbookSheetsDto([]);
        var bytes = await BytesAsync(book, ct);
        if (!bytes.Ok) return bytes.Failure!;
        try
        {
            return new WorkbookSheetsDto(Xlsx.Sheets(bytes.Value!).Select(s => new WorkbookSheetDto(s.Name, s.UsedRange, s.Hidden)).ToList());
        }
        catch (XlsxUnreadableException)
        {
            return Failure.Conflict(Codes.Conflict, "The workbook's current version cannot be read as an xlsx");
        }
    }

    /// <summary>A range as CSV in canonical text, for the client's CSV import (contract section 6).</summary>
    public async Task<Result<WorkbookRangeDto>> RangeAsync(Workbook book, string? sheet, string? range, CancellationToken ct = default)
    {
        if (sheet is { Length: 0 or > 31 }) return Failure.Invalid("sheet is a sheet's name, 1 to 31 characters");
        CellRange? cells = null;
        if (!string.IsNullOrEmpty(range))
        {
            if (!CellRange.TryParse(range, out var parsed)) return Failure.Invalid("range is A1 notation without a sheet or $: A1 or A1:D20");
            cells = parsed;
        }
        var bytes = await BytesAsync(book, ct);
        if (!bytes.Ok) return bytes.Failure!;
        try
        {
            var (name, used, csv) = Xlsx.Range(bytes.Value!, sheet, cells);
            return new WorkbookRangeDto(name, used, csv);
        }
        catch (KeyNotFoundException)
        {
            return Failure.NotFound("No such sheet in the workbook");
        }
        catch (XlsxLimitException e)
        {
            return new Failure(Codes.LimitSize, 413, e.Message);
        }
        catch (XlsxUnreadableException)
        {
            return Failure.Conflict(Codes.Conflict, "The workbook's current version cannot be read as an xlsx");
        }
    }

    // The record -------------------------------------------------------------------------------------

    /// <summary>A new workbook with no version: Sheet opens it blank and the first save makes version 1 (<c>If-None-Match: *</c>).</summary>
    public async Task<Result<WorkbookDto>> CreateAsync(Member member, Actor actor, NewWorkbook request, CancellationToken ct = default)
    {
        if (member.IsGuest) return Failure.Denied("Guests do not create workbooks");
        if (CleanName(request.Name) is not { } name) return Failure.Invalid("name is required");
        var id = request.Id ?? Guid.CreateVersion7();
        if (id == Guid.Empty) return Failure.Invalid("id is a UUID");
        var existing = await db.Workbooks.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(w => w.Id == id, ct);
        if (existing is not null)
        {
            // A retry of the same create answers as the first did.
            if (existing.WorkspaceId != member.WorkspaceId || existing.CreatedBy != member.UserId) return Failure.Conflict(Codes.Conflict, "That id is taken");
            return await DtoAsync(existing, await levels.LevelAsync(member, existing, ct), ct);
        }
        var now = clock.GetUtcNow();
        var book = new Workbook
        {
            Id = id,
            WorkspaceId = member.WorkspaceId,
            Name = name,
            SearchName = Search(name),
            CreatedBy = member.UserId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Workbooks.Add(book);
        audit.Add(actor, "workbook.create", member.WorkspaceId, "workbook", id, new { name });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            return Failure.Conflict(Codes.Conflict, "That id is taken");
        }
        return await DtoAsync(book, await levels.LevelAsync(member, book, ct), ct);
    }

    private static string Search(string name)
    {
        var normal = TextNormaliser.Normalise(name);
        return normal.Length > MaxName ? normal[..MaxName] : normal;
    }

    /// <summary>A rename, a trash or a restore (edit); <paramref name="ifVersion"/> an optional <c>If-Match</c> on the record's version.</summary>
    public async Task<Result<WorkbookDto>> UpdateAsync(Member member, Actor actor, Workbook book, string level, WorkbookUpdate request, long? ifVersion, CancellationToken ct = default)
    {
        if (!Levels.AtLeast(level, Levels.Edit)) return Failure.Denied("Changing this workbook needs edit access");
        if (request.Name is null && request.Trashed is null) return Failure.Invalid("Send name, trashed or both");
        string? name = null;
        if (request.Name is not null && (name = CleanName(request.Name)) is null) return Failure.Invalid("name is required");
        return await ChangeAsync(member, actor, book.Id, level, ifVersion, current =>
        {
            var trashed = request.Trashed ?? current.TrashedAt is not null;
            if (name is not null && name != current.Name && trashed && current.TrashedAt is not null)
                return Failure.Conflict(Codes.Conflict, "The workbook is in the trash");
            var changed = false;
            if (name is not null && name != current.Name)
            {
                audit.Add(actor, "workbook.rename", member.WorkspaceId, "workbook", current.Id, new { from = current.Name, to = name });
                current.Name = name;
                current.SearchName = Search(name);
                changed = true;
            }
            if (trashed != (current.TrashedAt is not null))
            {
                current.TrashedAt = trashed ? clock.GetUtcNow() : null;
                current.TrashedBy = trashed ? member.UserId : null;
                audit.Add(actor, trashed ? "workbook.trash" : "workbook.restore", member.WorkspaceId, "workbook", current.Id);
                changed = true;
            }
            return changed;
        }, ct);
    }

    /// <summary><c>DELETE</c>: to the trash, with full access (the worker deletes it for good after 60 days).</summary>
    public async Task<Result<WorkbookDto>> TrashAsync(Member member, Actor actor, Workbook book, string level, CancellationToken ct = default)
    {
        if (level != Levels.Full) return Failure.Denied("Deleting this workbook needs full access");
        return await ChangeAsync(member, actor, book.Id, level, null, current =>
        {
            if (current.TrashedAt is not null) return false;
            current.TrashedAt = clock.GetUtcNow();
            current.TrashedBy = member.UserId;
            audit.Add(actor, "workbook.trash", member.WorkspaceId, "workbook", current.Id);
            return true;
        }, ct);
    }

    /// <summary>
    /// One change to the record: read it, check the version, apply, and raise the version when
    /// something changed. The version is a concurrency token: a change that raced this one makes it
    /// a conflict, not a lost update.
    /// </summary>
    private async Task<Result<WorkbookDto>> ChangeAsync(Member member, Actor actor, Guid id, string level, long? ifVersion, Func<Workbook, Result<bool>> apply, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        var current = await db.Workbooks.FirstOrDefaultAsync(w => w.Id == id, ct);
        if (current is null) return Failure.NotFound("No such workbook");
        if (ifVersion is { } expected && expected != current.Version)
            return Failure.Conflict(Codes.VersionConflict, $"The workbook is at version {current.Version}");
        var outcome = apply(current);
        if (!outcome.Ok) return outcome.Failure!;
        if (outcome.Value)
        {
            current.Version++;
            current.UpdatedAt = clock.GetUtcNow();
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateConcurrencyException)
            {
                return Failure.Conflict(Codes.VersionConflict, "The workbook changed meanwhile");
            }
        }
        return await DtoAsync(current, level, ct);
    }

    // The access list ---------------------------------------------------------------------------------

    /// <summary>The list, to those who may change it (full); everyone else learns whether it is restricted and their own level.</summary>
    public async Task<PermissionsDto> PermissionsAsync(Workbook book, string yourLevel, CancellationToken ct = default)
    {
        if (yourLevel != Levels.Full) return new PermissionsDto(book.Restricted, yourLevel, []);
        var rows = await db.WorkbookPermissions.AsNoTracking().Where(r => r.WorkbookId == book.Id).ToListAsync(ct);
        var userIds = rows.Where(r => r.PrincipalType == Principals.User).Select(r => r.PrincipalId).ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.Email, u.DeletedAt }).ToDictionaryAsync(u => u.Id, ct);
        var workspace = await db.Workspaces.AsNoTracking().Where(w => w.Id == book.WorkspaceId).Select(w => w.Name).FirstAsync(ct);
        var entries = rows
            .Select(r =>
            {
                if (r.PrincipalType == Principals.Workspace) return new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, workspace, null);
                var user = users.GetValueOrDefault(r.PrincipalId);
                return user is null || user.DeletedAt is not null
                    ? new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, "Deleted user", null)
                    : new PermissionEntryDto(r.PrincipalType, r.PrincipalId, r.Level, user.DisplayName, user.Email);
            })
            .OrderBy(e => e.PrincipalType == Principals.Workspace ? 0 : 1)
            .ThenBy(e => e.DisplayName, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(e => e.PrincipalId)
            .ToList();
        return new PermissionsDto(book.Restricted, yourLevel, entries);
    }

    /// <summary>
    /// Replaces the list (full access), as a page's: people of the workspace and the workspace
    /// itself at the five levels, and whether the workbook is restricted to its list. The version
    /// rises and the change is audited. Every open file session sees it on its next request.
    /// </summary>
    public async Task<Result<PermissionsDto>> SetPermissionsAsync(Member member, Actor actor, Workbook book, string level, PermissionsUpdate request, long? ifVersion, CancellationToken ct = default)
    {
        if (level != Levels.Full) return Failure.Denied("Sharing this workbook needs full access");
        var entries = request.Entries ?? [];
        if (entries.Count > MaxEntries) return Failure.Invalid($"A workbook has at most {MaxEntries} entries");
        foreach (var entry in entries)
        {
            if (entry is null) return Failure.Invalid("An entry is empty");
            if (entry.PrincipalType is not (Principals.User or Principals.Workspace)) return Failure.Invalid("principalType is user or workspace");
            if (!Levels.All.Contains(entry.Level)) return Failure.Invalid("level is full, edit, comment, view or none");
            if (entry.PrincipalType == Principals.Workspace && entry.PrincipalId != member.WorkspaceId)
                return Failure.Invalid("A workspace entry names this workspace");
        }
        if (entries.GroupBy(e => (e.PrincipalType, e.PrincipalId)).Any(g => g.Count() > 1)) return Failure.Invalid("Each principal appears once");
        var named = entries.Where(e => e.PrincipalType == Principals.User).Select(e => e.PrincipalId).Distinct().ToList();
        var members = await db.WorkspaceMembers.AsNoTracking().Where(m => named.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        var stranger = named.Except(members).FirstOrDefault();
        if (stranger != Guid.Empty) return Failure.Invalid($"{stranger} is not a member of the workspace");

        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        // Under the workspace's lock, as a removal of a member is: no row for someone just removed.
        await changes.LockAsync(member.WorkspaceId, ct);
        var current = await db.Workbooks.FirstOrDefaultAsync(w => w.Id == book.Id, ct);
        if (current is null) return Failure.NotFound("No such workbook");
        if (current.TrashedAt is not null) return Failure.Conflict(Codes.Conflict, "The workbook is in the trash");
        if (ifVersion is { } expected && expected != current.Version)
            return Failure.Conflict(Codes.VersionConflict, $"The workbook is at version {current.Version}");
        var before = await db.WorkbookPermissions.AsNoTracking().Where(r => r.WorkbookId == book.Id).ToListAsync(ct);
        var same = current.Restricted == request.Restricted
            && before.Count == entries.Count
            && entries.All(e => before.Any(b => b.PrincipalType == e.PrincipalType && b.PrincipalId == e.PrincipalId && b.Level == e.Level));
        if (!same)
        {
            var wasRestricted = current.Restricted;
            await db.WorkbookPermissions.Where(r => r.WorkbookId == book.Id).ExecuteDeleteAsync(ct);
            var now = clock.GetUtcNow();
            foreach (var entry in entries)
                db.WorkbookPermissions.Add(new WorkbookPermission
                {
                    WorkbookId = book.Id,
                    PrincipalType = entry.PrincipalType,
                    PrincipalId = entry.PrincipalId,
                    Level = entry.Level,
                    WorkspaceId = member.WorkspaceId,
                    CreatedBy = member.UserId,
                    CreatedAt = now,
                });
            current.Restricted = request.Restricted;
            current.Version++;
            current.UpdatedAt = now;
            audit.Add(actor, "workbook.permissions", member.WorkspaceId, "workbook", book.Id, new
            {
                restricted = request.Restricted,
                entries = entries.Select(e => new { e.PrincipalType, e.PrincipalId, e.Level }),
                before = new { restricted = wasRestricted, entries = before.Select(b => new { b.PrincipalType, b.PrincipalId, b.Level }) },
            });
            await db.SaveChangesAsync(ct);
        }
        await tx.CommitAsync(ct);
        return await PermissionsAsync(current, await levels.LevelAsync(member, current, ct), ct);
    }

    // Pictures ----------------------------------------------------------------------------------------

    public static bool IsViewHash(string? hash) => hash is { Length: 64 } && hash.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    /// <summary>The newest picture of a view (of any version: <c>versionId</c> and <c>etag</c> say which), by signed URL.</summary>
    public async Task<Result<WorkbookPreviewDto>> PreviewAsync(Workbook book, string viewHash, CancellationToken ct = default)
    {
        if (!IsViewHash(viewHash)) return Failure.Invalid("viewHash is 64 lower-case hex characters");
        if (book.TrashedAt is not null) return Gone();
        var preview = await db.WorkbookPreviews.AsNoTracking().Where(p => p.WorkbookId == book.Id && p.ViewHash == viewHash)
            .OrderByDescending(p => p.MadeAt).FirstOrDefaultAsync(ct);
        if (preview is null) return Failure.NotFound("No picture of this view");
        var url = await blob.ReadUrlAsync(preview.BlobKey, Png.ContentType, ct: ct);
        return new WorkbookPreviewDto(url.ToString(), preview.VersionId, Etag(preview.VersionId), preview.MadeAt, preview.Width, preview.Height, clock.GetUtcNow() + BlobStore.ReadLifetime);
    }

    /// <summary>
    /// A picture of a view of the current version (edit): a PNG whose header says at most 4,096 px a
    /// side, at most 2 MB (the route caps the body). It replaces the view's older pictures.
    /// </summary>
    public async Task<Result<bool>> PutPreviewAsync(Member member, Workbook book, string level, string viewHash, string? versionHeader, string? contentType, byte[] bytes, CancellationToken ct = default)
    {
        if (!Levels.AtLeast(level, Levels.Edit)) return Failure.Denied("Only someone who may edit the workbook sends its pictures");
        if (!IsViewHash(viewHash)) return Failure.Invalid("viewHash is 64 lower-case hex characters");
        if (book.TrashedAt is not null) return Gone();
        if ((contentType ?? "").Split(';')[0].Trim().ToLowerInvariant() != Png.ContentType) return Failure.Invalid("The picture is sent as image/png");
        if (string.IsNullOrWhiteSpace(versionHeader)) return new Failure(Codes.VersionRequired, 428, "Send X-Workbook-Version: the version the picture shows");
        if (!Guid.TryParse(versionHeader.Trim().Trim('"'), out var versionId)) return Failure.Invalid("X-Workbook-Version is the picture's versionId");
        if (bytes.Length > Png.MaxBytes)
            return new Failure(Codes.LimitSize, 413, "A picture is at most 2 MB") { Extensions = new Dictionary<string, object?> { ["limit"] = Png.MaxBytes } };
        if (Png.Dimensions(bytes) is not { } size) return Failure.Invalid("The picture is not a PNG");
        if (size.Width > Png.MaxSide || size.Height > Png.MaxSide) return Failure.Invalid($"A picture is at most {Png.MaxSide} px a side");
        var current = await db.Workbooks.AsNoTracking().Where(w => w.Id == book.Id).Select(w => w.CurrentVersionId).FirstOrDefaultAsync(ct);
        if (current is null) return Failure.Conflict(Codes.Conflict, "The workbook has no saved version to picture");
        if (current != versionId) return Failure.Conflict(Codes.VersionConflict, "The picture is of a version that is no longer the current one");

        var key = BlobStore.WorkbookPreviewKey(member.WorkspaceId, book.Id, versionId, viewHash);
        await blob.PutAsync(key, bytes, Png.ContentType, ct);
        var now = clock.GetUtcNow();
        var stale = await db.WorkbookPreviews.Where(p => p.WorkbookId == book.Id && p.ViewHash == viewHash && p.VersionId != versionId).ToListAsync(ct);
        var row = await db.WorkbookPreviews.FirstOrDefaultAsync(p => p.WorkbookId == book.Id && p.VersionId == versionId && p.ViewHash == viewHash, ct);
        if (row is null)
        {
            row = new WorkbookPreview { WorkbookId = book.Id, VersionId = versionId, ViewHash = viewHash, WorkspaceId = member.WorkspaceId, BlobKey = key };
            db.WorkbookPreviews.Add(row);
        }
        row.Width = size.Width;
        row.Height = size.Height;
        row.SizeBytes = bytes.Length;
        row.MadeBy = member.UserId;
        row.MadeAt = now;
        db.WorkbookPreviews.RemoveRange(stale);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // Two pictures of the same view at once: the other one stands.
            return true;
        }
        foreach (var old in stale) await blob.DeleteAsync(old.BlobKey, ct);
        // At most so many views pictured: the oldest pictures go.
        var extra = await db.WorkbookPreviews.AsNoTracking().Where(p => p.WorkbookId == book.Id)
            .OrderByDescending(p => p.MadeAt).Skip(MaxPreviews).ToListAsync(ct);
        if (extra.Count > 0)
        {
            foreach (var old in extra)
                await db.WorkbookPreviews.Where(p => p.WorkbookId == old.WorkbookId && p.VersionId == old.VersionId && p.ViewHash == old.ViewHash).ExecuteDeleteAsync(ct);
            foreach (var old in extra) await blob.DeleteAsync(old.BlobKey, ct);
        }
        return true;
    }

    // Versions ----------------------------------------------------------------------------------------

    /// <summary>The body of a 412: the current version, so Sheet can tell whether its own lost save landed (<c>sha256</c>).</summary>
    public async Task<Failure> ConflictAsync(Guid workbookId, CancellationToken ct = default)
    {
        var version = await CurrentAsync(workbookId, ct);
        object? current = null;
        if (version is not null)
        {
            var names = await NamesAsync([version.SavedBy], ct);
            current = new Dictionary<string, object?>
            {
                ["versionId"] = version.Id,
                ["etag"] = Etag(version.Id),
                ["sha256"] = version.Sha256,
                ["savedBy"] = new Dictionary<string, object?> { ["id"] = version.SavedBy, ["name"] = names.GetValueOrDefault(version.SavedBy) ?? "Someone" },
                ["savedAt"] = version.SavedAt,
            };
        }
        return new Failure(Codes.VersionConflict, 412, "A newer version was saved") { Extensions = new Dictionary<string, object?> { ["current"] = current } };
    }

    /// <summary>
    /// A new current version, if the condition holds when it lands: <c>If-Match</c> with the
    /// current version's ETag (or <c>*</c> when there is one), or <c>If-None-Match: *</c> while
    /// there is none. The bytes go to their own blob first; the record moves only if the version
    /// it was checked against is still the current one, so two saves on one ETag cannot both land.
    /// </summary>
    public async Task<Result<WorkbookVersion>> SaveAsync(Actor actor, Guid workbookId, Guid userId, byte[] bytes, SavePrecondition condition, CancellationToken ct = default)
    {
        var book = await db.Workbooks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == workbookId, ct);
        if (book is null || book.TrashedAt is not null) return Gone();
        Guid? expected;
        if (condition.IfMatch is { } tags)
        {
            if (book.CurrentVersionId is not { } current) return await ConflictAsync(workbookId, ct);
            if (!tags.Contains("*") && !tags.Contains(Etag(current))) return await ConflictAsync(workbookId, ct);
            expected = current;
        }
        else
        {
            if (condition.IfNoneMatch?.Trim() != "*" || book.CurrentVersionId is not null) return await ConflictAsync(workbookId, ct);
            expected = null;
        }

        var versionId = Guid.CreateVersion7();
        var key = BlobStore.WorkbookVersionKey(book.WorkspaceId, workbookId, versionId);
        await blob.PutAsync(key, bytes, Xlsx.ContentType, ct);
        var now = clock.GetUtcNow();
        var version = new WorkbookVersion
        {
            Id = versionId,
            WorkspaceId = book.WorkspaceId,
            WorkbookId = workbookId,
            BlobKey = key,
            SizeBytes = bytes.Length,
            Sha256 = Sha256Hex(bytes),
            SavedBy = userId,
            SavedAt = now,
        };
        var landed = false;
        try
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            var moved = await db.Workbooks.Where(w => w.Id == workbookId && w.TrashedAt == null && w.CurrentVersionId == expected)
                .ExecuteUpdateAsync(s => s.SetProperty(w => w.CurrentVersionId, versionId).SetProperty(w => w.UpdatedAt, now), ct);
            if (moved == 1)
            {
                db.WorkbookVersions.Add(version);
                audit.Add(actor, "workbook.save", book.WorkspaceId, "workbook", workbookId, new { versionId, size = bytes.Length, sha256 = version.Sha256 });
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                landed = true;
            }
        }
        finally
        {
            if (!landed) await blob.DeleteAsync(key, CancellationToken.None);
        }
        if (!landed)
        {
            var now2 = await db.Workbooks.AsNoTracking().Where(w => w.Id == workbookId).Select(w => new { w.TrashedAt }).FirstOrDefaultAsync(ct);
            return now2 is null || now2.TrashedAt is not null ? Gone() : await ConflictAsync(workbookId, ct);
        }
        await PruneAsync(workbookId, versionId, ct);
        return version;
    }

    /// <summary>Versions past the newest <see cref="KeepVersions"/>, with their pictures: rows, then blobs.</summary>
    private async Task PruneAsync(Guid workbookId, Guid current, CancellationToken ct)
    {
        var old = await db.WorkbookVersions.AsNoTracking().Where(v => v.WorkbookId == workbookId && v.Id != current)
            .OrderByDescending(v => v.SavedAt).ThenByDescending(v => v.Id).Skip(KeepVersions - 1)
            .Select(v => new { v.Id, v.BlobKey }).ToListAsync(ct);
        if (old.Count == 0) return;
        var ids = old.Select(v => v.Id).ToList();
        var pictures = await db.WorkbookPreviews.AsNoTracking().Where(p => p.WorkbookId == workbookId && ids.Contains(p.VersionId)).Select(p => p.BlobKey).ToListAsync(ct);
        await db.WorkbookPreviews.Where(p => p.WorkbookId == workbookId && ids.Contains(p.VersionId)).ExecuteDeleteAsync(ct);
        await db.WorkbookVersions.Where(v => ids.Contains(v.Id)).ExecuteDeleteAsync(ct);
        foreach (var key in pictures.Concat(old.Select(v => v.BlobKey))) await blob.DeleteAsync(key, ct);
    }

    /// <summary>
    /// A new workbook whose version 1 is <paramref name="bytes"/>, with this access list: an export
    /// of a database view, or Sheet's "save a copy". The blob first, then the rows in one
    /// transaction (a blob left by a failure is deleted).
    /// </summary>
    private async Task<(Workbook Book, WorkbookVersion Version)> CreateWithVersionAsync(Member member, Actor actor, string name, byte[] bytes, bool restricted, IReadOnlyList<AccessRow> rows, string action, object detail, CancellationToken ct)
    {
        var id = Guid.CreateVersion7();
        var versionId = Guid.CreateVersion7();
        var key = BlobStore.WorkbookVersionKey(member.WorkspaceId, id, versionId);
        await blob.PutAsync(key, bytes, Xlsx.ContentType, ct);
        var now = clock.GetUtcNow();
        var book = new Workbook
        {
            Id = id,
            WorkspaceId = member.WorkspaceId,
            Name = name,
            SearchName = Search(name),
            CurrentVersionId = versionId,
            Restricted = restricted,
            CreatedBy = member.UserId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        var version = new WorkbookVersion
        {
            Id = versionId,
            WorkspaceId = member.WorkspaceId,
            WorkbookId = id,
            BlobKey = key,
            SizeBytes = bytes.Length,
            Sha256 = Sha256Hex(bytes),
            SavedBy = member.UserId,
            SavedAt = now,
        };
        db.Workbooks.Add(book);
        db.WorkbookVersions.Add(version);
        foreach (var row in rows)
            db.WorkbookPermissions.Add(new WorkbookPermission
            {
                WorkbookId = id,
                PrincipalType = row.PrincipalType,
                PrincipalId = row.PrincipalId,
                Level = row.Level,
                WorkspaceId = member.WorkspaceId,
                CreatedBy = member.UserId,
                CreatedAt = now,
            });
        audit.Add(actor, action, member.WorkspaceId, "workbook", id, detail);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch
        {
            await blob.DeleteAsync(key, CancellationToken.None);
            throw;
        }
        return (book, version);
    }

    /// <summary>The rows that give everyone what <paramref name="rows"/> gives them, and the maker at least edit.</summary>
    private static List<AccessRow> WithMaker(Member member, bool restricted, IEnumerable<AccessRow> rows)
    {
        var list = rows.ToList();
        if (!Levels.AtLeast(WorkbookAccess.Decide(member, restricted, list), Levels.Edit))
        {
            list.RemoveAll(r => r.PrincipalType == Principals.User && r.PrincipalId == member.UserId);
            list.Add(new AccessRow(Principals.User, member.UserId, Levels.Edit));
        }
        return list;
    }

    /// <summary>
    /// Sheet's "save a copy": a new workbook beside the original, named "<c>name</c> (copy)" (in
    /// Arabic "<c>name</c> (نسخة)"), keeping the original's access list so a copy is never seen by
    /// more people than the original, and its maker able to edit it.
    /// </summary>
    public async Task<Result<(Workbook Book, WorkbookVersion Version, string Level)>> CopyAsync(Member member, Actor actor, Workbook original, string language, byte[] bytes, CancellationToken ct = default)
    {
        if (member.IsGuest) return Failure.Denied("Guests do not create workbooks");
        var suffix = language == "ar" ? " (نسخة)" : " (copy)";
        var stem = original.Name;
        if (stem.Length + suffix.Length > MaxName)
        {
            var cut = MaxName - suffix.Length;
            stem = stem[..(char.IsHighSurrogate(stem[cut - 1]) ? cut - 1 : cut)].TrimEnd();
        }
        var rows = (await db.WorkbookPermissions.AsNoTracking().Where(r => r.WorkbookId == original.Id).ToListAsync(ct))
            .Select(r => new AccessRow(r.PrincipalType, r.PrincipalId, r.Level));
        var list = WithMaker(member, original.Restricted, rows);
        var (book, version) = await CreateWithVersionAsync(member, actor, stem + suffix, bytes, original.Restricted, list, "workbook.copy", new { from = original.Id, size = bytes.Length }, ct);
        return (book, version, WorkbookAccess.Decide(member, book.Restricted, list));
    }

    // Export ------------------------------------------------------------------------------------------

    /// <summary>
    /// A database view as a new workbook (contract section 6): version 1 written here, its rows in
    /// the view's filter and sort order, its shown properties, a header row and typed cells. The
    /// workbook takes the database's access (a restricted database's export is restricted the same
    /// way), and its maker can edit it.
    /// </summary>
    public async Task<Result<WorkbookDto>> ExportAsync(Member member, Actor actor, Page database, WorkbookExportRequest request, CancellationToken ct = default)
    {
        if (member.IsGuest) return Failure.Denied("Guests do not create workbooks");
        if (CleanName(request.Name) is not { } name) return Failure.Invalid("name is required");
        var view = await databases.ViewRowsAsync(member, database, request.ViewId, null, ct);
        if (!view.Ok) return view.Failure!;
        var export = view.Value!;
        byte[] bytes;
        try
        {
            bytes = Xlsx.Write(export.ViewName ?? database.Title, export.Shown.Select(d => d.Name).ToList(),
                export.Rows.Select(row => (IReadOnlyList<XValue>)export.Shown.Select(def => Cell(def, row, export.Lookups)).ToList()));
        }
        catch (XlsxLimitException e)
        {
            return new Failure(Codes.LimitSize, 413, e.Message);
        }
        if (bytes.Length > settings.MaxSaveBytes)
            return new Failure(Codes.LimitSize, 413, "The workbook would be larger than a version may be") { Extensions = new Dictionary<string, object?> { ["limit"] = settings.MaxSaveBytes } };
        var (restricted, rows) = await DatabaseAccessAsync(member, database, ct);
        var list = WithMaker(member, restricted, rows);
        var (book, _) = await CreateWithVersionAsync(member, actor, name, bytes, restricted, list, "workbook.export",
            new { databaseId = database.Id, viewId = request.ViewId, rows = export.Rows.Count }, ct);
        return await DtoAsync(book, WorkbookAccess.Decide(member, restricted, list), ct);
    }

    /// <summary>What the database's place in the tree gives everyone, as a workbook's list says it.</summary>
    private async Task<(bool Restricted, List<AccessRow> Rows)> DatabaseAccessAsync(Member member, Page database, CancellationToken ct)
    {
        var section = await db.Sections.AsNoTracking().FirstOrDefaultAsync(s => s.Id == database.SectionId, ct);
        // A private section's database is its owner's only.
        if (section is null || section.Visibility == "private") return (true, []);
        if (await access.DecidingPageAsync(database.Id) is not { } deciding) return (false, []);
        return (true, await access.EffectiveRowsAsync(member.WorkspaceId, deciding));
    }

    /// <summary>A database cell as a typed xlsx cell: numbers, booleans and dates as such, everything else as its canonical text.</summary>
    public static XValue Cell(PropertyDef def, RowData row, CsvLookups lookups)
    {
        switch (def.Type)
        {
            case PropertyTypes.Checkbox:
                return XValue.Of(Cells.Read(def, row) is true);
            case PropertyTypes.Person or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy or PropertyTypes.Relation or PropertyTypes.Files
                or PropertyTypes.Select or PropertyTypes.Status or PropertyTypes.MultiSelect:
                return Text(Csv.CellText(def, row, lookups));
        }
        var cell = Cells.Read(def, row);
        if (cell is null || Raw.IsError(cell)) return XValue.Empty;
        switch (cell)
        {
            case double d:
                return double.IsFinite(d) ? XValue.Of(d) : XValue.Of(JsNumber.ToString(d));
            case bool b:
                return XValue.Of(b);
            case string s:
                return Text(s);
            case DateValue { End: null or "" } date:
                return Xlsx.Serial(date.Start) is { } serial
                    ? DbDates.IsDateOnly(date.Start) ? XValue.Day(serial) : XValue.Instant(serial)
                    : Text(date.Start);
        }
        return Text(Csv.CellText(def, row, lookups));
    }

    private static XValue Text(string text) => text.Length == 0 ? XValue.Empty : XValue.Of(text);
}
