using Cgw.Core.Data;

namespace Cgw.Core.Sync;

// The records clients mirror, in the shapes of packages/workspace/src/types.ts, so a client can
// store what the server sends as it is.

public sealed record WorkspaceDto(
    Guid Id,
    string Name,
    string? Icon,
    DateTimeOffset CreatedAt,
    long Version,
    bool LocalOnly,
    DateTimeOffset? DeletedAt,
    string Role,
    long ChangeSeq,
    long? StorageQuotaBytes,
    long StorageUsedBytes)
{
    public static WorkspaceDto From(Workspace w, string role) =>
        new(w.Id, w.Name, w.Icon, w.CreatedAt, w.Version, false, w.DeletedAt, role, w.ChangeSeq, w.StorageQuotaBytes, w.StorageUsedBytes);
}

public sealed record SectionDto(Guid Id, Guid WorkspaceId, string Name, string OrderKey, string Visibility, long Version, DateTimeOffset CreatedAt)
{
    public static SectionDto From(Section s) => new(s.Id, s.WorkspaceId, s.Name, s.OrderKey, s.Visibility, s.Version, s.CreatedAt);
}

public sealed record PageDto(
    Guid Id,
    Guid WorkspaceId,
    Guid SectionId,
    Guid? ParentPageId,
    string OrderKey,
    string Kind,
    string Title,
    string? Icon,
    Guid? CoverAssetId,
    bool IsTemplate,
    Guid? TemplateOfPageId,
    long Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? TrashedAt,
    Guid? TrashRootId,
    bool Restricted,
    long DocHeadSeq,
    int DocEpoch,
    int DocSchemaVersion,
    /// <summary>The caller's level on this page.</summary>
    string Access)
{
    public static PageDto From(Page p, string access) =>
        new(p.Id, p.WorkspaceId, p.SectionId, p.ParentPageId, p.OrderKey, p.Kind, p.Title, p.Icon, p.CoverAssetId, p.IsTemplate,
            p.TemplateOfPageId, p.Version, p.CreatedAt, p.UpdatedAt, p.TrashedAt, p.TrashRootId, p.Restricted, p.DocHeadSeq,
            p.DocEpoch, p.DocSchemaVersion, access);
}

/// <summary>A database (db/types.ts <c>DatabaseRecord</c>); its properties are JSON, sent as they are stored.</summary>
public sealed record DatabaseDto(Guid Id, Guid WorkspaceId, System.Text.Json.JsonElement Properties, long Version, long RowCount, DateTimeOffset CreatedAt)
{
    public static DatabaseDto From(WorkspaceDatabase d) =>
        new(d.PageId, d.WorkspaceId, Json.Element(d.Properties, "[]"), d.Version, d.RowCount, d.CreatedAt);
}

/// <summary>A view of a database (db/types.ts <c>ViewRecord</c>).</summary>
public sealed record ViewDto(Guid Id, Guid WorkspaceId, Guid DatabaseId, string Name, string Type, string OrderKey, System.Text.Json.JsonElement Config, long Version, DateTimeOffset CreatedAt)
{
    public static ViewDto From(DatabaseView v) =>
        new(v.Id, v.WorkspaceId, v.DatabaseId, v.Name, v.Type, v.OrderKey, Json.Element(v.Config, "{}"), v.Version, v.CreatedAt);
}

/// <summary>A row (types.ts <c>RowRecord</c>): every field of its page, and its values.</summary>
public sealed record RowDto(
    Guid Id,
    Guid WorkspaceId,
    Guid SectionId,
    Guid? ParentPageId,
    string OrderKey,
    string Kind,
    string Title,
    string? Icon,
    Guid? CoverAssetId,
    bool IsTemplate,
    Guid? TemplateOfPageId,
    long Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? TrashedAt,
    Guid? TrashRootId,
    bool Restricted,
    long DocHeadSeq,
    int DocEpoch,
    int DocSchemaVersion,
    /// <summary>The caller's level: its database's.</summary>
    string Access,
    Guid DatabaseId,
    /// <summary>Stored values by property id.</summary>
    System.Text.Json.JsonElement Values,
    /// <summary>Per property id, the version of its value.</summary>
    System.Text.Json.JsonElement Versions,
    /// <summary>Formula and rollup results by property id.</summary>
    System.Text.Json.JsonElement Computed,
    long? ComputedVersion,
    Guid? CreatedBy,
    Guid? UpdatedBy)
{
    public static RowDto From(Page p, DatabaseRow r, string access) =>
        new(p.Id, p.WorkspaceId, p.SectionId, p.ParentPageId, p.OrderKey, "row", p.Title, p.Icon, p.CoverAssetId, p.IsTemplate,
            p.TemplateOfPageId, p.Version, p.CreatedAt, p.UpdatedAt, p.TrashedAt, p.TrashRootId, false, p.DocHeadSeq,
            p.DocEpoch, p.DocSchemaVersion, access, r.DatabaseId, Json.Element(r.Values, "{}"), Json.Element(r.PropertyVersions, "{}"),
            Json.Element(r.Computed, "{}"), r.ComputedVersion, p.CreatedBy == Guid.Empty ? null : p.CreatedBy, p.UpdatedBy == Guid.Empty ? null : p.UpdatedBy);
}

internal static class Json
{
    /// <summary>A JSON column as an element of the answer: objects and arrays, never strings.</summary>
    public static System.Text.Json.JsonElement Element(string? json, string fallback)
    {
        using var document = System.Text.Json.JsonDocument.Parse(string.IsNullOrEmpty(json) ? fallback : json);
        return document.RootElement.Clone();
    }
}

public sealed record FavouriteDto(Guid WorkspaceId, Guid PageId, string OrderKey);

public sealed record VisitDto(Guid WorkspaceId, Guid PageId, DateTimeOffset LastVisitedAt);

public sealed record MemberDto(Guid UserId, string DisplayName, string Email, string Role);

/// <summary>
/// One entity a change carries: the field <c>entityType</c> names is set. A database page's
/// create answers with its page and, beside it, its database record.
/// </summary>
public sealed record EntityDto(
    WorkspaceDto? Workspace = null,
    SectionDto? Section = null,
    PageDto? Page = null,
    FavouriteDto? Favourite = null,
    VisitDto? Visit = null,
    MemberDto? Member = null,
    DatabaseDto? Database = null,
    ViewDto? View = null,
    RowDto? Row = null);

public sealed record ChangeDto(long Seq, string EntityType, Guid EntityId, string Kind, EntityDto? Entity);

public sealed record ChangesDto(IReadOnlyList<ChangeDto> Changes, long Cursor, bool More);

public sealed record TreeDto(
    WorkspaceDto Workspace,
    IReadOnlyList<SectionDto> Sections,
    IReadOnlyList<PageDto> Pages,
    IReadOnlyList<FavouriteDto> Favourites,
    IReadOnlyList<VisitDto> Visits,
    /// <summary>The feed position this tree is at least as new as.</summary>
    long Cursor,
    /// <summary>The databases (and their views) whose page the caller may see; rows come by their own route.</summary>
    IReadOnlyList<DatabaseDto> Databases,
    IReadOnlyList<ViewDto> Views);

/// <summary>An operation as clients queue it (SYNC_DESIGN.md, Channel 2).</summary>
public sealed record OperationDto(
    Guid OpId,
    string Type,
    Guid WorkspaceId,
    Guid EntityId,
    long? BaseVersion,
    System.Text.Json.JsonElement Payload,
    string? CreatedAt);

public sealed record OpsRequest(Guid? DeviceId, IReadOnlyList<OperationDto> Ops);

public sealed record OpErrorDto(string Code, string Title);

public sealed record OpResultDto(Guid OpId, string Status, OpErrorDto? Error, string? EntityType, EntityDto? Entity, string? Notice);

public sealed record OpsResponse(IReadOnlyList<OpResultDto> Results);
