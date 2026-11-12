using Microsoft.AspNetCore.Identity;

namespace Cgw.Core.Data;

// The relational records of DATA_MODEL.md. Column lists follow it; every tenant-owned table has
// WorkspaceId and the tenant filter (CgwDb). Times are UTC.

public sealed class User : IdentityUser<Guid>
{
    public string DisplayName { get; set; } = "";
    public string Locale { get; set; } = "en";
    public Guid? AvatarAssetId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

/// <summary>A desktop install or a browser profile signed in to the account.</summary>
public sealed class Device
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    /// <summary><c>web</c> or <c>desktop</c>.</summary>
    public string Platform { get; set; } = "web";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    /// <summary>The desktop's OpenIddict authorization; revoking the device revokes it.</summary>
    public Guid? AuthorizationId { get; set; }
}

/// <summary>A Yjs client id the server issued to a device, or registered for it (Q9).</summary>
public sealed class YjsClient : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    /// <summary>A 32-bit unsigned Yjs client id.</summary>
    public long ClientId { get; set; }
    public Guid UserId { get; set; }
    public Guid? DeviceId { get; set; }
    /// <summary><c>issued</c> (from the pool) or <c>registered</c> (used locally first).</summary>
    public string Origin { get; set; } = "issued";
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class Workspace
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string? Icon { get; set; }
    public Guid OwnerUserId { get; set; }
    /// <summary>The head of the change feed.</summary>
    public long ChangeSeq { get; set; }
    /// <summary>The highest change the retention job removed: a cursor below it must fetch the tree again.</summary>
    public long ChangesPrunedSeq { get; set; }
    public long Version { get; set; } = 1;
    /// <summary>Recorded and shown, not enforced (Q10).</summary>
    public long? StorageQuotaBytes { get; set; }
    public long StorageUsedBytes { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }
}

public sealed class WorkspaceMember : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    public Guid UserId { get; set; }
    /// <summary><c>owner</c>, <c>admin</c>, <c>member</c> or <c>guest</c>.</summary>
    public string Role { get; set; } = Roles.Member;
    public DateTimeOffset CreatedAt { get; set; }
}

public static class Roles
{
    public const string Owner = "owner";
    public const string Admin = "admin";
    public const string Member = "member";
    public const string Guest = "guest";
    public static readonly string[] All = [Owner, Admin, Member, Guest];
    public static bool IsAdmin(string role) => role is Owner or Admin;
}

public sealed class WorkspaceInvite : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public string Email { get; set; } = "";
    public string Role { get; set; } = Roles.Member;
    /// <summary>SHA-256 of the token; the token itself is only in the mail.</summary>
    public byte[] TokenHash { get; set; } = [];
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? AcceptedAt { get; set; }
    public Guid? AcceptedBy { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class Section : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public string Name { get; set; } = "";
    public string OrderKey { get; set; } = "";
    /// <summary><c>workspace</c> or <c>private</c>.</summary>
    public string Visibility { get; set; } = "workspace";
    /// <summary>Who sees a private section.</summary>
    public Guid? OwnerUserId { get; set; }
    public long Version { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class Page : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid SectionId { get; set; }
    public Guid? ParentPageId { get; set; }
    public string OrderKey { get; set; } = "";
    public string Kind { get; set; } = "page";
    public string Title { get; set; } = "";
    /// <summary>The title normalised for search (D25).</summary>
    public string SearchTitle { get; set; } = "";
    public string? Icon { get; set; }
    public Guid? CoverAssetId { get; set; }
    public bool IsTemplate { get; set; }
    public Guid? TemplateOfPageId { get; set; }
    /// <summary>Rises on every metadata change.</summary>
    public long Version { get; set; } = 1;
    /// <summary>The last document sequence given out, validated or not.</summary>
    public long DocSeq { get; set; }
    /// <summary>Every update up to here is decided; pulls serve the valid ones (Q20).</summary>
    public long DocHeadSeq { get; set; }
    public int DocSchemaVersion { get; set; } = 1;
    public int DocEpoch { get; set; }
    /// <summary>The state hash of the validated state at <see cref="DocStateHashSeq"/> (the repair check).</summary>
    public string? DocStateHash { get; set; }
    public long DocStateHashSeq { get; set; }
    /// <summary>Access comes from this page's own list, not from its ancestors.</summary>
    public bool Restricted { get; set; }
    public Guid CreatedBy { get; set; }
    public Guid UpdatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? TrashedAt { get; set; }
    public Guid? TrashedBy { get; set; }
    /// <summary>The page the user trashed; every page of the subtree names it.</summary>
    public Guid? TrashRootId { get; set; }
    /// <summary>Deleted for good: the row stays as a tombstone so a push gets 410.</summary>
    public DateTimeOffset? DeletedAt { get; set; }
    /// <summary>When the worker removed a deleted page's document, history, links and grants.</summary>
    public DateTimeOffset? PurgedAt { get; set; }
}

/// <summary>The closure table, depth 0 included (a page is its own ancestor).</summary>
public sealed class PageAncestor : ITenantOwned
{
    public Guid PageId { get; set; }
    public Guid AncestorPageId { get; set; }
    public int Depth { get; set; }
    public Guid WorkspaceId { get; set; }
}

public sealed class Favourite : ITenantOwned
{
    public Guid UserId { get; set; }
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    public string OrderKey { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class PageVisit : ITenantOwned
{
    public Guid UserId { get; set; }
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    public DateTimeOffset LastVisitedAt { get; set; }
}

public static class UpdateStatus
{
    public const byte Pending = 0;
    public const byte Valid = 1;
    public const byte Rejected = 2;
}

public sealed class PageDocUpdate : ITenantOwned
{
    public Guid PageId { get; set; }
    public long Seq { get; set; }
    public Guid UpdateId { get; set; }
    public Guid WorkspaceId { get; set; }
    public int Epoch { get; set; }
    public Guid UserId { get; set; }
    public Guid? DeviceId { get; set; }
    public byte[] Data { get; set; } = [];
    /// <summary>The schema version the pushing app knows: how far this update may raise the page's.</summary>
    public int ClientSchemaVersion { get; set; } = 1;
    /// <summary>Pending until the worker validates it (Q20).</summary>
    public byte Status { get; set; }
    public string? Problem { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public static class SnapshotKinds
{
    public const string Compaction = "compaction";
    public const string Auto = "auto";
    public const string Named = "named";
    /// <summary>The state just before a restore, kept so the restore can be looked back on.</summary>
    public const string PreRestore = "preRestore";
}

public sealed class PageDocSnapshot : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    public int Epoch { get; set; }
    public long UpToSeq { get; set; }
    public string BlobKey { get; set; } = "";
    public long SizeBytes { get; set; }
    public string Kind { get; set; } = SnapshotKinds.Compaction;
    public string? Name { get; set; }
    /// <summary><c>pending</c> until the worker has written the blob, then <c>ready</c>.</summary>
    public string Status { get; set; } = "ready";
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class PageDocDerived : ITenantOwned
{
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    public long UpToSeq { get; set; }
    /// <summary>The ProseMirror JSON, gzip.</summary>
    public byte[] Json { get; set; } = [];
    public string PlainText { get; set; } = "";
    /// <summary>The normalised text the full-text index reads.</summary>
    public string SearchText { get; set; } = "";
    /// <summary>JSON: <c>{"pages":[...],"assets":[...]}</c>.</summary>
    public string Outgoing { get; set; } = "{}";
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class PageLink : ITenantOwned
{
    public Guid FromPageId { get; set; }
    public Guid ToPageId { get; set; }
    public Guid WorkspaceId { get; set; }
}

/// <summary>A request the worker carries out on a page's document (a hard restore).</summary>
public sealed class PageDocCommand : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    public string Kind { get; set; } = "hardRestore";
    public Guid? SnapshotId { get; set; }
    public Guid RequestedBy { get; set; }
    public string Status { get; set; } = "pending";
    public string? Error { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}

public static class AssetStatus
{
    public const string Pending = "pending";
    public const string Ready = "ready";
    public const string Quarantined = "quarantined";
    public const string Deleted = "deleted";
}

public sealed class Asset : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public string BlobKey { get; set; } = "";
    public string FileName { get; set; } = "";
    public string ContentType { get; set; } = "";
    public long SizeBytes { get; set; }
    public string? Sha256 { get; set; }
    public string Status { get; set; } = AssetStatus.Pending;
    public string? Problem { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>Since when no page refers to it; deleted after 30 days.</summary>
    public DateTimeOffset? UnreferencedSince { get; set; }
}

public sealed class AssetRef : ITenantOwned
{
    public Guid AssetId { get; set; }
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
}

public static class Levels
{
    public const string Full = "full";
    public const string Edit = "edit";
    public const string Comment = "comment";
    public const string View = "view";
    public const string None = "none";
    public static readonly string[] All = [Full, Edit, Comment, View, None];

    public static int Rank(string level) => level switch
    {
        Full => 4,
        Edit => 3,
        Comment => 2,
        View => 1,
        _ => 0,
    };

    public static bool AtLeast(string level, string wanted) => Rank(level) >= Rank(wanted);
}

public sealed class PagePermission : ITenantOwned
{
    public Guid PageId { get; set; }
    /// <summary><c>user</c> or <c>workspace</c>.</summary>
    public string PrincipalType { get; set; } = "user";
    public Guid PrincipalId { get; set; }
    public string Level { get; set; } = Levels.View;
    public Guid WorkspaceId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class ShareLink : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    public byte[] TokenHash { get; set; } = [];
    public string Level { get; set; } = Levels.View;
    public DateTimeOffset? ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class WorkspaceChange : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    public long Seq { get; set; }
    /// <summary><c>workspace</c>, <c>section</c>, <c>page</c>, <c>favourite</c>, <c>member</c>, <c>access</c>.</summary>
    public string EntityType { get; set; } = "";
    public Guid EntityId { get; set; }
    /// <summary><c>upsert</c>, <c>delete</c>, <c>grant</c> or <c>revoke</c>.</summary>
    public string Kind { get; set; } = "upsert";
    public long Version { get; set; }
    public Guid? ActorUserId { get; set; }
    /// <summary>For per-user rows (favourites, a grant to one person); null means everyone.</summary>
    public Guid? UserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class AppliedOp : ITenantOwned
{
    public Guid OpId { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid UserId { get; set; }
    public string Result { get; set; } = "{}";
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>Append-only (ARCHITECTURE.md, Audit). Account events have no workspace.</summary>
public sealed class AuditEntry
{
    public Guid Id { get; set; }
    public Guid? WorkspaceId { get; set; }
    public Guid? ActorUserId { get; set; }
    public string Action { get; set; } = "";
    public string? TargetType { get; set; }
    public Guid? TargetId { get; set; }
    public string? Detail { get; set; }
    public string? Ip { get; set; }
    public string? CorrelationId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class LinkPreview : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    /// <summary>SHA-256 of the URL, hex.</summary>
    public string UrlHash { get; set; } = "";
    public string Url { get; set; } = "";
    public string Status { get; set; } = "ok";
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? SiteName { get; set; }
    public Guid? ImageAssetId { get; set; }
    public DateTimeOffset FetchedAt { get; set; }
}

public sealed class WorkspaceExport : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid RequestedBy { get; set; }
    public string Status { get; set; } = "pending";
    public string? BlobKey { get; set; }
    public long? SizeBytes { get; set; }
    public string? Error { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}

/// <summary>Each worker job's last run, for its lag and the health check.</summary>
public sealed class JobState
{
    public string Name { get; set; } = "";
    public DateTimeOffset? LastRunAt { get; set; }
    public DateTimeOffset? LastOkAt { get; set; }
    public string? LastError { get; set; }
    public long Runs { get; set; }
}
