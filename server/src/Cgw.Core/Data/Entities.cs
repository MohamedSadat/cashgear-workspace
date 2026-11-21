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
    /// <summary>
    /// Phase 11: the workspace whose provider signed this session in (single sign-on), or the one
    /// whose provider signed in the browser that confirmed a desktop; null for any other sign-in.
    /// </summary>
    public Guid? SsoWorkspaceId { get; set; }
    /// <summary>
    /// Phase 11: when the session ends whatever it does, for a sign-in through a workspace's
    /// provider (its <see cref="SsoProvider.SessionHours"/> after that sign-in); null for no end.
    /// </summary>
    public DateTimeOffset? EndsAt { get; set; }
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
    /// <summary>
    /// Phase 9: whether pages of the workspace may be published as sites (on unless an owner or
    /// admin turns it off; turning it off unpublishes every live site at once).
    /// </summary>
    public bool PublishingEnabled { get; set; } = true;
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

/// <summary>
/// <c>Pages.Kind</c>: a page; a database (a page drawn as its views; only rows sit under it); a
/// row of a database (never in the tree, its level its database's).
/// </summary>
public static class PageKinds
{
    public const string Page = "page";
    public const string Database = "database";
    public const string Row = "row";
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
    /// <summary>
    /// JSON: the <c>[blockId, userId]</c> pairs of the <c>userMention</c>s in <see cref="Json"/>
    /// (Phase 6), so the next derive writes a notification for a new pair only; null before the
    /// first derive that read them.
    /// </summary>
    public string? Mentions { get; set; }
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
    /// <summary><c>user</c>, <c>workspace</c> or (Phase 11) <c>group</c>.</summary>
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

/// <summary>
/// A workspace database (DATA_MODEL.md, Databases): a page of kind <c>database</c> and its
/// properties. The JSON columns hold what packages/workspace/src/db/types.ts defines.
/// </summary>
public sealed class WorkspaceDatabase : ITenantOwned
{
    /// <summary>The database's page.</summary>
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    /// <summary>JSON: the <c>PropertyDef</c>s in display order, trashed ones included.</summary>
    public string Properties { get; set; } = "[]";
    /// <summary>Rises on every change to the properties.</summary>
    public long Version { get; set; } = 1;
    /// <summary>Rows not trashed and not templates.</summary>
    public long RowCount { get; set; }
    /// <summary>Rises on every write to one of its rows; each row keeps the value it was last written at (<see cref="DatabaseRow.Seq"/>).</summary>
    public long RowsVersion { get; set; }
    /// <summary>Some rows' computed values are older than <see cref="Version"/>: the worker recomputes them.</summary>
    public bool ComputePending { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class DatabaseView : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid DatabaseId { get; set; }
    public string Name { get; set; } = "";
    /// <summary><c>table</c>, <c>board</c>, <c>list</c>, <c>calendar</c>, <c>gallery</c>, (Phase 9) <c>timeline</c> or (Phase 12) <c>chart</c>.</summary>
    public string Type { get; set; } = "table";
    public string OrderKey { get; set; } = "";
    /// <summary>JSON: the <c>ViewConfig</c>.</summary>
    public string Config { get; set; } = "{}";
    public long Version { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A row of a database: a page of kind <c>row</c> and its values.</summary>
public sealed class DatabaseRow : ITenantOwned
{
    public Guid PageId { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid DatabaseId { get; set; }
    /// <summary>JSON: stored values by property id; an empty value is absent.</summary>
    public string Values { get; set; } = "{}";
    /// <summary>JSON: per property id, the version of its value (the last write to reach the server wins).</summary>
    public string PropertyVersions { get; set; } = "{}";
    /// <summary>JSON: formula and rollup results by property id.</summary>
    public string Computed { get; set; } = "{}";
    /// <summary>The database version <see cref="Computed"/> was made for; null until made.</summary>
    public long? ComputedVersion { get; set; }
    /// <summary>The database's <see cref="WorkspaceDatabase.RowsVersion"/> when this row was last written: the query cache reads rows newer than it holds.</summary>
    public long Seq { get; set; }
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

/// <summary>
/// A cloud workbook (DATA_MODEL.md, Workbooks; Phase 5): a document of its own, not owned by any
/// page, with its own access list. Its content is <see cref="WorkbookVersion"/>s; the current one
/// is the content's ETag (<c>"&lt;versionId&gt;"</c>). Not in the change feed, not in search.
/// </summary>
public sealed class Workbook : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public string Name { get; set; } = "";
    /// <summary>The name normalised as search normalises text, for the list's <c>?q=</c>.</summary>
    public string SearchName { get; set; } = "";
    /// <summary>Null until the first save.</summary>
    public Guid? CurrentVersionId { get; set; }
    /// <summary>Access comes from the workbook's own list only (members get nothing unless named or a workspace row says so).</summary>
    public bool Restricted { get; set; }
    /// <summary>The record's version: rises on a rename, trash, restore and a change to its list (the <c>ETag</c> of <c>GET /workbooks/{id}</c>).</summary>
    public long Version { get; set; } = 1;
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>Any change, a save included.</summary>
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? TrashedAt { get; set; }
    public Guid? TrashedBy { get; set; }
}

/// <summary>One saved xlsx: its blob, size and SHA-256 (lower-case hex, over the stored bytes).</summary>
public sealed class WorkbookVersion : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid WorkbookId { get; set; }
    public string BlobKey { get; set; } = "";
    public long SizeBytes { get; set; }
    public string Sha256 { get; set; } = "";
    public Guid SavedBy { get; set; }
    public DateTimeOffset SavedAt { get; set; }
}

/// <summary>A workbook's own access list: people, groups (Phase 11) and the whole workspace, at the five levels.</summary>
public sealed class WorkbookPermission : ITenantOwned
{
    public Guid WorkbookId { get; set; }
    /// <summary><c>user</c>, <c>workspace</c> or (Phase 11) <c>group</c>.</summary>
    public string PrincipalType { get; set; } = "user";
    public Guid PrincipalId { get; set; }
    public string Level { get; set; } = Levels.View;
    public Guid WorkspaceId { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A picture of one view of one version (a range or a chart, in the file's own colours), PNG, as a blob beside the workbook.</summary>
public sealed class WorkbookPreview : ITenantOwned
{
    public Guid WorkbookId { get; set; }
    public Guid VersionId { get; set; }
    /// <summary>Workspace's own hash of the view (<c>viewHash</c>): lower-case hex SHA-256.</summary>
    public string ViewHash { get; set; } = "";
    public Guid WorkspaceId { get; set; }
    public string BlobKey { get; set; } = "";
    public int Width { get; set; }
    public int Height { get; set; }
    public long SizeBytes { get; set; }
    public Guid MadeBy { get; set; }
    public DateTimeOffset MadeAt { get; set; }
}

/// <summary>
/// A one-time ticket to open a workbook in Sheet (sheet-session.1): 256 random bits, kept only as
/// their SHA-256, 120 seconds, one use, bound to the person, the workbook and the access.
/// </summary>
public sealed class WorkbookTicket : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid WorkbookId { get; set; }
    public Guid UserId { get; set; }
    /// <summary><c>edit</c> or <c>view</c>.</summary>
    public string Access { get; set; } = "view";
    /// <summary>
    /// Phase 9: <c>web</c> (Sheet's web app) or <c>desktop</c> (Sheet's desktop app by its deep
    /// link): which origins may redeem it.
    /// </summary>
    public string Target { get; set; } = "web";
    public byte[] TokenHash { get; set; } = [];
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// A page published as a site (Phase 9, DATA_MODEL.md, Published sites): its root page and slug,
/// whether search engines may index it, the language of the site's own words. What the site shows
/// is decided when it is read, by a share link's rules (<c>SharedReader</c>). <see cref="Version"/>
/// rises on every change; a site unpublished keeps its row for the audit, and its slug is free again.
/// </summary>
public sealed class PublishedSite : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid RootPageId { get; set; }
    /// <summary>3 to 63 of <c>a-z</c>, <c>0-9</c> and <c>-</c>; unique among live sites of every workspace.</summary>
    public string Slug { get; set; } = "";
    public bool Indexing { get; set; }
    /// <summary><c>en</c> or <c>ar</c>: the site's own words, and its <c>lang</c> and <c>dir</c>.</summary>
    public string Language { get; set; } = "en";
    public long Version { get; set; } = 1;
    public Guid PublishedBy { get; set; }
    public DateTimeOffset PublishedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    /// <summary>Null while the site is live.</summary>
    public DateTimeOffset? UnpublishedAt { get; set; }
    public Guid? UnpublishedBy { get; set; }
    /// <summary><c>person</c> or <c>publishing.off</c>.</summary>
    public string? UnpublishReason { get; set; }
}

/// <summary>
/// Sheet's file session, redeemed from a ticket: an opaque token kept only as its SHA-256, 30
/// minutes idle and 10 hours at most, scoped to one workbook (or to the copy it saved). Access is
/// checked again on every request.
/// </summary>
public sealed class FileSession : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid UserId { get; set; }
    public Guid WorkbookId { get; set; }
    /// <summary><c>edit</c> or <c>view</c>: at most what the ticket carried.</summary>
    public string Access { get; set; } = "view";
    public byte[] TokenHash { get; set; } = [];
    /// <summary><c>en</c> or <c>ar</c>: the person's, for Sheet's texts and a copy's name.</summary>
    public string Language { get; set; } = "en";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset IdleExpiresAt { get; set; }
    public DateTimeOffset MaxExpiresAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public int Renews { get; set; }
}

/// <summary>
/// Which ERP company a workspace is linked to (DATA_MODEL.md, ERP links): where to ask and the
/// ERP's own link id. No key, token or session is stored; the ERP checks its link on every session.
/// </summary>
public sealed class ErpLink : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    /// <summary>The ERP's id for the link.</summary>
    public string ErpLinkId { get; set; } = "";
    /// <summary>Always the API's <c>Erp__ApiBase</c> when it was made.</summary>
    public string ErpBaseUrl { get; set; } = "";
    public string Company { get; set; } = "";
    public string CompanyName { get; set; } = "";
    public Guid LinkedBy { get; set; }
    public DateTimeOffset LinkedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public Guid? RevokedBy { get; set; }
}

/// <summary>
/// A one-time ticket to open the real-time hub (Phase 6 contracts, section 1): 32 random bytes kept
/// only as their SHA-256, 60 seconds, one use. The connection's person and device come from it alone.
/// Not tenant-owned: a connection follows any of its person's workspaces.
/// </summary>
public sealed class RealtimeTicket
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid? DeviceId { get; set; }
    public byte[] TokenHash { get; set; } = [];
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// A comment thread on a block of a page (DATA_MODEL.md, Comments; Phase 6): anchored on the block
/// id, narrowed by two Yjs relative positions the server never decodes, with the quoted text as the
/// fallback. Its id is the client's (UUIDv7).
/// </summary>
public sealed class CommentThread : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid PageId { get; set; }
    /// <summary>12 base-62 characters (the block-id plugin's).</summary>
    public string BlockId { get; set; } = "";
    /// <summary>A Yjs relative position, as the client encoded it; null for the whole block.</summary>
    public byte[]? AnchorStart { get; set; }
    public byte[]? AnchorEnd { get; set; }
    /// <summary>The text the comment was made on, at most 1,000 characters; empty for a whole block.</summary>
    public string Quote { get; set; } = "";
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ResolvedAt { get; set; }
    public Guid? ResolvedBy { get; set; }
    /// <summary>Rises on every change to the thread or its comments.</summary>
    public long Version { get; set; } = 1;
    /// <summary>Set when its first comment is deleted: the thread goes with it.</summary>
    public DateTimeOffset? DeletedAt { get; set; }
}

/// <summary>A comment in a thread; its body is the document's inline nodes as ProseMirror JSON (a strict subset).</summary>
public sealed class Comment : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid ThreadId { get; set; }
    public Guid PageId { get; set; }
    public Guid AuthorUserId { get; set; }
    /// <summary>JSON: the body as the server wrote it back after checking it.</summary>
    public string Body { get; set; } = "[]";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? EditedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

public static class NotificationKinds
{
    /// <summary>The person was mentioned in a page (the worker's mention pass).</summary>
    public const string Mention = "mention";
    public const string CommentMention = "commentMention";
    public const string Reply = "reply";
}

/// <summary>
/// An entry in a person's inbox (Phase 6 contracts, section 5). <see cref="DedupeKey"/> is unique per
/// recipient: a mention is written once per page, block and person, a comment's once per comment.
/// </summary>
public sealed class Notification : ITenantOwned
{
    public Guid Id { get; set; }
    /// <summary>The inbox's order and cursor (an identity column).</summary>
    public long Seq { get; set; }
    public Guid WorkspaceId { get; set; }
    /// <summary>The recipient.</summary>
    public Guid UserId { get; set; }
    public string Kind { get; set; } = NotificationKinds.Mention;
    public Guid PageId { get; set; }
    public string? BlockId { get; set; }
    public Guid? ThreadId { get; set; }
    public Guid? CommentId { get; set; }
    public Guid ActorUserId { get; set; }
    /// <summary>The block's or the comment's plain text, at most 200 characters.</summary>
    public string Excerpt { get; set; } = "";
    public string DedupeKey { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ReadAt { get; set; }
    /// <summary>Phase 8: the mail that told the person of it, once sent.</summary>
    public DateTimeOffset? EmailedAt { get; set; }
    /// <summary>Phase 8: the queued mail (<see cref="MailOutbox"/>) that is to carry it; set once, so it is never queued twice.</summary>
    public Guid? MailId { get; set; }
}

public static class MailModes
{
    /// <summary>Mentions and replies still unread after the delay, at most one mail in each delay (the default).</summary>
    public const string On = "on";
    /// <summary>The same, at most one mail a day.</summary>
    public const string Digest = "digest";
    public const string Off = "off";

    public static bool Known(string? mode) => mode is On or Digest or Off;
}

/// <summary>
/// A person's mail choices (Phase 8, M8.5), one row an account, made on its first change or its
/// first mail; no row reads as <see cref="MailModes.On"/>. <see cref="Stamp"/> is in every
/// unsubscribe token: a new one voids the tokens of every mail sent before it.
/// </summary>
public sealed class MailSettings
{
    public Guid UserId { get; set; }
    public string Mode { get; set; } = MailModes.On;
    public Guid Stamp { get; set; }
    /// <summary>When mail was last turned on again after being off: nothing made before it is mailed.</summary>
    public DateTimeOffset? OnSince { get; set; }
    /// <summary>When the last mail for the person was queued: the next waits a delay (or a day for the digest).</summary>
    public DateTimeOffset? LastMailAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public static class MailOutcomes
{
    public const string Sent = "sent";
    /// <summary>Nothing left to say when its turn came: read in the app, or no longer readable.</summary>
    public const string Skipped = "skipped";
    /// <summary>Mail was turned off, or the account deleted, before it went.</summary>
    public const string Off = "off";
    /// <summary>Its retries were spent.</summary>
    public const string Failed = "failed";
}

/// <summary>
/// The mail queue (Phase 8): a mail to one person, made when it is sent from the notifications that
/// name it (<see cref="Notification.MailId"/>), so access and whether each is still unread are
/// checked again then; nothing of its content, and not the address, is stored. Sent with retries
/// under a daily cap; kept a week after it ends.
/// </summary>
public sealed class MailOutbox
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    /// <summary><see cref="MailModes.On"/> (mentions and replies) or <see cref="MailModes.Digest"/>.</summary>
    public string Kind { get; set; } = MailModes.On;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset? SentAt { get; set; }
    /// <summary>Null while it waits; then one of <see cref="MailOutcomes"/>.</summary>
    public string? Outcome { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    /// <summary>The last failure's kind (an exception's type, an SMTP status), never its message.</summary>
    public string? LastError { get; set; }
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

/// <summary>
/// A workspace's AI settings (Phase 7, INTEGRATIONS.md, AI): bring your own key, off until an owner
/// or admin turns it on. The key is kept only as Data Protection's output (purpose
/// <c>Cgw.Ai.Key.v1</c>, bound to the workspace), never returned to any client.
/// </summary>
public sealed class AiSettings : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    public bool Enabled { get; set; }
    public string Provider { get; set; } = "anthropic";
    public string Model { get; set; } = "claude-opus-5-5";
    /// <summary>The key, protected; null with none.</summary>
    public string? KeyCipher { get; set; }
    public DateTimeOffset? KeySetAt { get; set; }
    public Guid? KeySetBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }

    // Phase 10: embeddings (search by meaning), a switch and a key of their own, beside completions'.

    /// <summary>Off until an owner or admin turns it on with a key; off deletes every <see cref="PageEmbedding"/> of the workspace.</summary>
    public bool EmbeddingsEnabled { get; set; }
    public string EmbeddingsProvider { get; set; } = "voyage";
    public string EmbeddingsModel { get; set; } = "voyage-4";
    /// <summary>The workspace's Voyage key as Data Protection's output (purpose <c>Cgw.Ai.EmbeddingsKey.v1</c>, bound to the workspace); null with none.</summary>
    public string? EmbeddingsKeyCipher { get; set; }
    public DateTimeOffset? EmbeddingsKeySetAt { get; set; }
    public Guid? EmbeddingsKeySetBy { get; set; }
    /// <summary>Rises when embeddings are turned on again or the model changes: a copy of the vectors of another generation is loaded whole.</summary>
    public long EmbeddingsGeneration { get; set; }
}

/// <summary>One AI provider call, for metering (Phase 7): who, what, which model, the tokens, how it ended. Never its content.</summary>
public sealed class AiUsage : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    /// <summary>Null for the worker's own calls (Phase 10: <c>embed</c>).</summary>
    public Guid? UserId { get; set; }
    public string Action { get; set; } = "";
    public string Model { get; set; } = "";
    public Guid? PageId { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    /// <summary><c>ok</c>, <c>length</c>, <c>refused</c>, <c>cancelled</c>, or the error code it ended with.</summary>
    public string Outcome { get; set; } = "";
    public int DurationMs { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// One chunk of a page's (or a row's) title and derived text as a vector (Phase 10, M10.2): 1,024
/// int8 values from the workspace's embeddings model, never sent to any client. Written and deleted
/// by the worker's <c>embed</c> job only, each change with an <see cref="EmbeddingChange"/> in the
/// same transaction; deleted with the page's purge, the workspace's, and all at once when the
/// workspace turns embeddings off. A page with nothing to embed (no title and no text) holds one
/// row with an empty vector, so it is known to be done.
/// </summary>
public sealed class PageEmbedding : ITenantOwned
{
    public long Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid PageId { get; set; }
    /// <summary>0-based, in the text's order.</summary>
    public int Chunk { get; set; }
    public string Model { get; set; } = "";
    /// <summary>SHA-256 of the chunk's text: a chunk whose text and model already have a vector keeps it.</summary>
    public byte[] TextHash { get; set; } = [];
    /// <summary>1,024 int8 values; empty for a page with nothing to embed.</summary>
    public byte[] Vector { get; set; } = [];
    /// <summary>The derived text's version embedded (<see cref="PageDocDerived.UpToSeq"/>, 0 with none).</summary>
    public long TextVersion { get; set; }
    /// <summary>The page's metadata version embedded (<see cref="Page.Version"/>: its title's changes raise it).</summary>
    public long PageVersion { get; set; }
    /// <summary>Phase 13: a row's database's version when its values were embedded (0 for a page): a property renamed, added or removed embeds its rows again.</summary>
    public long SchemaVersion { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// That a page's <see cref="PageEmbedding"/> rows changed (Phase 10): written in the same
/// transaction as any insert or delete of them, one row a page touched, kept a day. The API's
/// in-memory copy of a workspace's vectors reads the ones after its last <see cref="Seq"/>.
/// </summary>
public sealed class EmbeddingChange : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    /// <summary>An identity column: the order the API reads them in.</summary>
    public long Seq { get; set; }
    public Guid PageId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// A third-party plugin added to a workspace (Phase 10, M10.5): its manifest as validated, its
/// bundle's files (each a private blob under <see cref="BlobPrefix"/>), on or off. One live row a
/// type a workspace; a removed row stays for the audit, and the worker deletes its blobs a day later.
/// </summary>
public sealed class WorkspacePlugin : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    /// <summary>Dotted lower-case words, at most 64; never <c>cashgear.*</c>.</summary>
    public string Type { get; set; } = "";
    /// <summary>A whole number from 1; an update keeps it or raises it.</summary>
    public int Version { get; set; }
    /// <summary>The manifest as validated, JSON, at most 16 KB.</summary>
    public string Manifest { get; set; } = "{}";
    /// <summary>JSON: <c>[{path, contentType, size, sha256}]</c>.</summary>
    public string Files { get; set; } = "[]";
    /// <summary>SHA-256 hex (lower case) of the zip as uploaded.</summary>
    public string BundleHash { get; set; } = "";
    /// <summary><c>workspaces/{workspaceId}/plugins/{id}/{bundleHash}/</c>.</summary>
    public string BlobPrefix { get; set; } = "";
    /// <summary>The files' unpacked sizes together.</summary>
    public long SizeBytes { get; set; }
    public bool Enabled { get; set; } = true;
    public Guid AddedBy { get; set; }
    public DateTimeOffset AddedAt { get; set; }
    public Guid UpdatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? RemovedAt { get; set; }
    public Guid? RemovedBy { get; set; }
    /// <summary>When the worker deleted a removed plugin's blobs.</summary>
    public DateTimeOffset? BlobsDeletedAt { get; set; }
    /// <summary>
    /// Phase 13: JSON, the hosts of its manifest's <c>network</c> an owner or admin approved (a host an
    /// update adds waits until approved); the plugins origin's CSP names those the manifest still names.
    /// </summary>
    public string ApprovedHosts { get; set; } = "[]";
    public DateTimeOffset? HostsApprovedAt { get; set; }
    public Guid? HostsApprovedBy { get; set; }
}

/// <summary>
/// A plugin frame's ticket (Phase 10): 32 random bytes kept only as their SHA-256, 10 minutes, bound
/// to the workspace, the plugin and the bundle it was made for. Not one use: the bundle's own files
/// are fetched under it while it lasts. The Sites process's plugins host finds it by its hash, as
/// the hub finds its ticket (<see cref="RealtimeTicket"/>); deleted a day after it expires.
/// </summary>
public sealed class PluginFrameTicket : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid PluginId { get; set; }
    public string BundleHash { get; set; } = "";
    public byte[] TokenHash { get; set; } = [];
    public DateTimeOffset ExpiresAt { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// A group of a workspace's people (Phase 11, M11.1): given access to pages and workbooks as a
/// person is (a <c>group</c> row in <see cref="PagePermission"/> or <see cref="WorkbookPermission"/>).
/// Owners and admins make and manage groups; members, admins and owners may be in one, never guests.
/// Deleting a group deletes its row, its people and its access rows (no tombstone).
/// </summary>
public sealed class WorkspaceGroup : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    /// <summary>1 to 100 characters, trimmed.</summary>
    public string Name { get; set; } = "";
    /// <summary>The name as search normalises it: unique among the workspace's groups.</summary>
    public string SearchName { get; set; } = "";
    /// <summary>Rises on every change (its name, its people): the <c>If-Match</c> of a change.</summary>
    public long Version { get; set; } = 1;
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public Guid UpdatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// A passkey ceremony's challenge, written when a ceremony that used it succeeds (Phase 11, M11.2):
/// Identity keeps a ceremony's state in a cookie, which a copied request would carry again, so a
/// challenge seen here is refused. Kept until the state could no longer be read.
/// </summary>
public sealed class PasskeyChallenge
{
    /// <summary>SHA-256 of the challenge as the client data names it (base64url).</summary>
    public byte[] Hash { get; set; } = [];
    public DateTimeOffset ExpiresAt { get; set; }
}

/// <summary>One person in a group (Phase 11): a member, admin or owner of the group's workspace.</summary>
public sealed class WorkspaceGroupMember : ITenantOwned
{
    public Guid GroupId { get; set; }
    public Guid UserId { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid AddedBy { get; set; }
    public DateTimeOffset AddedAt { get; set; }
}

/// <summary>
/// An email domain a workspace's owners add for single sign-on (Phase 11, M11.3), proven by a DNS
/// <c>TXT</c> record <c>cgw-verify=&lt;Token&gt;</c> at <c>_cashgear-workspace.&lt;Domain&gt;</c>. Once
/// verified it belongs to that workspace alone (one verified row a domain, across workspaces): its
/// people sign in through the workspace's provider, and with <see cref="Required"/> only that way,
/// except the workspace's owners. Removing it deletes the row.
/// </summary>
public sealed class SsoDomain : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    /// <summary>Lower case, an IDN as punycode, 3 to 253 characters, at least one dot, no wildcard.</summary>
    public string Domain { get; set; } = "";
    /// <summary>128 random bits, base64url: shown to owners, the record's value.</summary>
    public string Token { get; set; } = "";
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? VerifiedAt { get; set; }
    public Guid? VerifiedBy { get; set; }
    /// <summary>Password and passkey sign-ins, resets and sign-ups of the domain refused, except the workspace's owners'.</summary>
    public bool Required { get; set; }
    public DateTimeOffset? RequiredAt { get; set; }
    public Guid? RequiredBy { get; set; }
}

/// <summary>
/// A workspace's OpenID Connect provider (Phase 11, M11.3), one at most, set by its owners. The
/// client secret is kept only as Data Protection's output (purpose <c>Cgw.Sso.ClientSecret.v1</c>,
/// bound to the workspace), never returned or logged. <see cref="TestedAt"/> is an owner's sign-in
/// through it, which turning sign-on on as required needs; changing the issuer, client or secret
/// clears it.
/// </summary>
public sealed class SsoProvider : ITenantOwned
{
    public Guid WorkspaceId { get; set; }
    /// <summary>The issuer, exactly as its discovery document names it.</summary>
    public string Issuer { get; set; } = "";
    public string ClientId { get; set; } = "";
    /// <summary>The client secret, protected; null with none (a public client, PKCE only).</summary>
    public string? SecretCipher { get; set; }
    /// <summary>A person of a verified domain signing in for the first time joins the workspace as a member.</summary>
    public bool JoinAsMember { get; set; } = true;
    /// <summary>How long a session made through the provider lasts, 1 to 720 hours, from its sign-in.</summary>
    public int SessionHours { get; set; } = 24;
    public DateTimeOffset? TestedAt { get; set; }
    public Guid? TestedBy { get; set; }
    /// <summary>Rises on every change: the <c>If-Match</c> of a change.</summary>
    public long Version { get; set; } = 1;
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public Guid UpdatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
