namespace Cgw.Core;

/// <summary>
/// The workspace a request (or a worker step) acts in. Set after the caller's membership is
/// checked; the database's tenant filter scopes every query to it (ARCHITECTURE.md, Tenancy).
/// With none set, tenant-owned rows are invisible.
/// </summary>
public sealed class TenantScope
{
    public Guid? WorkspaceId { get; private set; }

    public void Enter(Guid workspaceId)
    {
        if (WorkspaceId is { } current && current != workspaceId)
            throw new InvalidOperationException("A scope acts in one workspace.");
        WorkspaceId = workspaceId;
    }

    /// <summary>For the worker, which moves from one workspace to the next.</summary>
    public void Switch(Guid? workspaceId) => WorkspaceId = workspaceId;
}

/// <summary>Every tenant-owned row carries its workspace (DATA_MODEL.md).</summary>
public interface ITenantOwned
{
    Guid WorkspaceId { get; }
}
