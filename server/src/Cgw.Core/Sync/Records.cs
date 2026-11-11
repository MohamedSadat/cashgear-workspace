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

public sealed record FavouriteDto(Guid WorkspaceId, Guid PageId, string OrderKey);

public sealed record VisitDto(Guid WorkspaceId, Guid PageId, DateTimeOffset LastVisitedAt);

public sealed record MemberDto(Guid UserId, string DisplayName, string Email, string Role);

/// <summary>One entity a change carries; exactly one field is set, by <c>entityType</c>.</summary>
public sealed record EntityDto(
    WorkspaceDto? Workspace = null,
    SectionDto? Section = null,
    PageDto? Page = null,
    FavouriteDto? Favourite = null,
    VisitDto? Visit = null,
    MemberDto? Member = null);

public sealed record ChangeDto(long Seq, string EntityType, Guid EntityId, string Kind, EntityDto? Entity);

public sealed record ChangesDto(IReadOnlyList<ChangeDto> Changes, long Cursor, bool More);

public sealed record TreeDto(
    WorkspaceDto Workspace,
    IReadOnlyList<SectionDto> Sections,
    IReadOnlyList<PageDto> Pages,
    IReadOnlyList<FavouriteDto> Favourites,
    IReadOnlyList<VisitDto> Visits,
    /// <summary>The feed position this tree is at least as new as.</summary>
    long Cursor);

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
