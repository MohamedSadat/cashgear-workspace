using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Cgw.Core.Data;

/// <summary>
/// The Workspace database (D13). The tenant filter is applied here, in one place: every entity
/// with a WorkspaceId sees only the scope's workspace, and none at all without one. A query that
/// must cross workspaces says so with <c>IgnoreQueryFilters([CgwDb.Tenant])</c>.
/// </summary>
public sealed class CgwDb(DbContextOptions<CgwDb> options, TenantScope tenant)
    : IdentityDbContext<User, IdentityRole<Guid>, Guid>(options), IDataProtectionKeyContext
{
    public const string Tenant = "tenant";

    /// <summary>Read by the filters each time a query runs.</summary>
    public Guid? TenantId => tenant.WorkspaceId;

    public TenantScope Scope => tenant;

    /// <summary>The Data Protection key ring (cookies, Identity tokens), shared by every API instance.</summary>
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<YjsClient> YjsClients => Set<YjsClient>();
    public DbSet<Workspace> Workspaces => Set<Workspace>();
    public DbSet<WorkspaceMember> WorkspaceMembers => Set<WorkspaceMember>();
    public DbSet<WorkspaceInvite> WorkspaceInvites => Set<WorkspaceInvite>();
    public DbSet<Section> Sections => Set<Section>();
    public DbSet<Page> Pages => Set<Page>();
    public DbSet<PageAncestor> PageAncestors => Set<PageAncestor>();
    public DbSet<Favourite> Favourites => Set<Favourite>();
    public DbSet<PageVisit> PageVisits => Set<PageVisit>();
    public DbSet<PageDocUpdate> PageDocUpdates => Set<PageDocUpdate>();
    public DbSet<PageDocSnapshot> PageDocSnapshots => Set<PageDocSnapshot>();
    public DbSet<PageDocDerived> PageDocDerived => Set<PageDocDerived>();
    public DbSet<PageDocCommand> PageDocCommands => Set<PageDocCommand>();
    public DbSet<PageLink> PageLinks => Set<PageLink>();
    public DbSet<Asset> Assets => Set<Asset>();
    public DbSet<AssetRef> AssetRefs => Set<AssetRef>();
    public DbSet<PagePermission> PagePermissions => Set<PagePermission>();
    public DbSet<ShareLink> ShareLinks => Set<ShareLink>();
    public DbSet<WorkspaceChange> WorkspaceChanges => Set<WorkspaceChange>();
    public DbSet<AppliedOp> AppliedOps => Set<AppliedOp>();
    public DbSet<AuditEntry> AuditLog => Set<AuditEntry>();
    public DbSet<LinkPreview> LinkPreviews => Set<LinkPreview>();
    public DbSet<WorkspaceExport> WorkspaceExports => Set<WorkspaceExport>();
    public DbSet<JobState> JobStates => Set<JobState>();

    /// <summary>Order keys compare byte by byte (D19): default collations ignore case.</summary>
    public const string BinaryCollation = "Latin1_General_100_BIN2";

    protected override void ConfigureConventions(ModelConfigurationBuilder builder)
    {
        builder.Properties<Guid>().HaveConversion<GuidBytesConverter>().HaveColumnType("binary(16)");
        builder.Properties<DateTimeOffset>().HaveColumnType("datetimeoffset(3)");
    }

    protected override void OnModelCreating(ModelBuilder b)
    {
        base.OnModelCreating(b);
        b.UseOpenIddict<Guid>();

        b.Entity<User>(e =>
        {
            e.ToTable("Users");
            e.Property(x => x.DisplayName).HasMaxLength(200);
            e.Property(x => x.Locale).HasMaxLength(10);
        });
        b.Entity<IdentityRole<Guid>>().ToTable("Roles");
        b.Entity<IdentityUserRole<Guid>>().ToTable("UserRoles");
        b.Entity<IdentityUserClaim<Guid>>().ToTable("UserClaims");
        b.Entity<IdentityUserLogin<Guid>>().ToTable("UserLogins");
        b.Entity<IdentityUserToken<Guid>>().ToTable("UserTokens");
        b.Entity<IdentityRoleClaim<Guid>>().ToTable("RoleClaims");

        b.Entity<Device>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.UserId);
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Platform).HasMaxLength(20);
        });
        b.Entity<YjsClient>(e =>
        {
            e.HasKey(x => new { x.WorkspaceId, x.ClientId });
            e.HasIndex(x => new { x.WorkspaceId, x.UserId });
            e.Property(x => x.Origin).HasMaxLength(20);
        });
        b.Entity<Workspace>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Icon).HasMaxLength(64);
        });
        b.Entity<WorkspaceMember>(e =>
        {
            e.HasKey(x => new { x.WorkspaceId, x.UserId });
            e.HasIndex(x => x.UserId);
            e.Property(x => x.Role).HasMaxLength(20);
        });
        b.Entity<WorkspaceInvite>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.WorkspaceId);
            e.Property(x => x.Email).HasMaxLength(256);
            e.Property(x => x.Role).HasMaxLength(20);
            e.Property(x => x.TokenHash).HasMaxLength(32);
        });
        b.Entity<Section>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.WorkspaceId);
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.OrderKey).HasMaxLength(200).UseCollation(BinaryCollation);
            e.Property(x => x.Visibility).HasMaxLength(20);
        });
        b.Entity<Page>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.WorkspaceId, x.SectionId, x.ParentPageId, x.OrderKey, x.Id });
            e.HasIndex(x => new { x.WorkspaceId, x.TrashedAt });
            e.Property(x => x.OrderKey).HasMaxLength(200).UseCollation(BinaryCollation);
            e.Property(x => x.Kind).HasMaxLength(20);
            e.Property(x => x.Title).HasMaxLength(1000);
            e.Property(x => x.SearchTitle).HasMaxLength(1000);
            e.Property(x => x.Icon).HasMaxLength(64);
        });
        b.Entity<PageAncestor>(e =>
        {
            e.HasKey(x => new { x.PageId, x.AncestorPageId });
            e.HasIndex(x => x.AncestorPageId);
        });
        b.Entity<Favourite>(e =>
        {
            e.HasKey(x => new { x.UserId, x.PageId });
            e.HasIndex(x => new { x.WorkspaceId, x.UserId });
            e.Property(x => x.OrderKey).HasMaxLength(200).UseCollation(BinaryCollation);
        });
        b.Entity<PageVisit>(e =>
        {
            e.HasKey(x => new { x.UserId, x.PageId });
            e.HasIndex(x => new { x.WorkspaceId, x.UserId });
        });
        b.Entity<PageDocUpdate>(e =>
        {
            e.HasKey(x => new { x.PageId, x.Seq });
            e.HasIndex(x => x.UpdateId).IsUnique();
            // The worker's queue: pending rows only.
            e.HasIndex(x => new { x.Status, x.PageId, x.Seq }).HasFilter("[Status] = 0");
            e.Property(x => x.Problem).HasMaxLength(2000);
        });
        b.Entity<PageDocSnapshot>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.PageId, x.Kind, x.UpToSeq });
            e.Property(x => x.BlobKey).HasMaxLength(300);
            e.Property(x => x.Kind).HasMaxLength(20);
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Status).HasMaxLength(20);
        });
        b.Entity<PageDocDerived>(e => e.HasKey(x => x.PageId));
        b.Entity<PageDocCommand>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.Status, x.CreatedAt });
            e.Property(x => x.Kind).HasMaxLength(30);
            e.Property(x => x.Status).HasMaxLength(20);
        });
        b.Entity<PageLink>(e =>
        {
            e.HasKey(x => new { x.FromPageId, x.ToPageId });
            e.HasIndex(x => x.ToPageId);
        });
        b.Entity<Asset>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.WorkspaceId, x.Status });
            e.Property(x => x.BlobKey).HasMaxLength(300);
            e.Property(x => x.FileName).HasMaxLength(255);
            e.Property(x => x.ContentType).HasMaxLength(100);
            e.Property(x => x.Sha256).HasMaxLength(64);
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.Problem).HasMaxLength(500);
        });
        b.Entity<AssetRef>(e =>
        {
            e.HasKey(x => new { x.AssetId, x.PageId });
            e.HasIndex(x => x.PageId);
        });
        b.Entity<PagePermission>(e =>
        {
            e.HasKey(x => new { x.PageId, x.PrincipalType, x.PrincipalId });
            e.HasIndex(x => new { x.WorkspaceId, x.PrincipalId });
            e.Property(x => x.PrincipalType).HasMaxLength(20);
            e.Property(x => x.Level).HasMaxLength(20);
        });
        b.Entity<ShareLink>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.PageId);
            e.Property(x => x.TokenHash).HasMaxLength(32);
            e.Property(x => x.Level).HasMaxLength(20);
        });
        b.Entity<WorkspaceChange>(e =>
        {
            e.HasKey(x => new { x.WorkspaceId, x.Seq });
            e.Property(x => x.EntityType).HasMaxLength(20);
            e.Property(x => x.Kind).HasMaxLength(20);
        });
        b.Entity<AppliedOp>(e =>
        {
            e.HasKey(x => x.OpId);
            e.HasIndex(x => new { x.WorkspaceId, x.CreatedAt });
        });
        b.Entity<AuditEntry>(e =>
        {
            e.ToTable("AuditLog");
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.WorkspaceId, x.CreatedAt });
            e.HasIndex(x => new { x.ActorUserId, x.CreatedAt });
            e.Property(x => x.Action).HasMaxLength(60);
            e.Property(x => x.TargetType).HasMaxLength(30);
            e.Property(x => x.Ip).HasMaxLength(64);
            e.Property(x => x.CorrelationId).HasMaxLength(64);
            // Account events have no workspace; workspace readers see only theirs.
            e.HasQueryFilter(Tenant, x => x.WorkspaceId == TenantId);
        });
        b.Entity<LinkPreview>(e =>
        {
            e.HasKey(x => new { x.WorkspaceId, x.UrlHash });
            e.Property(x => x.UrlHash).HasMaxLength(64);
            e.Property(x => x.Url).HasMaxLength(2048);
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.Title).HasMaxLength(500);
            e.Property(x => x.Description).HasMaxLength(1000);
            e.Property(x => x.SiteName).HasMaxLength(200);
        });
        b.Entity<WorkspaceExport>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.Status, x.CreatedAt });
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.BlobKey).HasMaxLength(300);
            e.Property(x => x.Error).HasMaxLength(1000);
        });
        b.Entity<JobState>(e =>
        {
            e.HasKey(x => x.Name);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.LastError).HasMaxLength(2000);
        });

        // The tenant filter, on every tenant-owned entity (a test checks none is missed).
        Filter<YjsClient>(b);
        Filter<WorkspaceMember>(b);
        Filter<WorkspaceInvite>(b);
        Filter<Section>(b);
        Filter<Page>(b);
        Filter<PageAncestor>(b);
        Filter<Favourite>(b);
        Filter<PageVisit>(b);
        Filter<PageDocUpdate>(b);
        Filter<PageDocSnapshot>(b);
        Filter<PageDocDerived>(b);
        Filter<PageDocCommand>(b);
        Filter<PageLink>(b);
        Filter<Asset>(b);
        Filter<AssetRef>(b);
        Filter<PagePermission>(b);
        Filter<ShareLink>(b);
        Filter<WorkspaceChange>(b);
        Filter<AppliedOp>(b);
        Filter<LinkPreview>(b);
        Filter<WorkspaceExport>(b);
    }

    private void Filter<T>(ModelBuilder b)
        where T : class, ITenantOwned =>
        b.Entity<T>().HasQueryFilter(Tenant, x => EF.Property<Guid>(x, nameof(ITenantOwned.WorkspaceId)) == TenantId);
}

/// <summary>For <c>dotnet ef</c>: migrations are made without a live database.</summary>
public sealed class CgwDbDesignFactory : IDesignTimeDbContextFactory<CgwDb>
{
    public CgwDb CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<CgwDb>()
            .UseSqlServer("Server=(localdb)\\MSSQLLocalDB;Database=cgw_design;Integrated Security=true")
            .Options;
        return new CgwDb(options, new TenantScope());
    }
}
