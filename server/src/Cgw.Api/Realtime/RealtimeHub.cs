using System.Text.Json;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Realtime;

/// <summary>
/// The real-time hub, <c>realtime.1</c> (Phase 6 contracts, section 1; SYNC_DESIGN.md, Real-time
/// collaboration). Every method decides on the server, for every call, and answers an
/// <see cref="Answer{T}"/> with the HTTP route's status and code. It holds no document state and
/// never decodes an update, an awareness state or a relative position: updates are stored by the
/// very push the HTTP route makes and relayed by <see cref="RealtimeRelay"/> only once the worker
/// has validated them (Q20). No ERP data or session ever passes through it.
/// </summary>
public sealed class RealtimeHub(
    RealtimeRegistry registry,
    PageGate gate,
    DocService docs,
    Access access,
    CgwDb db,
    HubPushBudget budget,
    RelayMetrics metrics,
    ILogger<RealtimeHub> logger) : Hub
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private Guid UserId => Context.User!.UserId()!.Value;

    public override async Task OnConnectedAsync()
    {
        // Only the ticket's identity: anything else reaching here is closed.
        var user = Context.User;
        if (user?.Identity?.AuthenticationType != RealtimeTicketHandler.SchemeName || user.UserId() is not { } userId || user.DeviceId() is not { } deviceId)
        {
            Context.Abort();
            return;
        }
        foreach (var old in registry.Add(Context.ConnectionId, userId, deviceId, Context)) old.Context.Abort();
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (registry.Remove(Context.ConnectionId) is { } gone)
            foreach (var page in gone.Pages)
                await Clients.GroupExcept(RealtimeRegistry.Group(page.PageId), [Context.ConnectionId])
                    .SendAsync(Events.Awareness, new PresenceMessage(page.PageId, page.PresenceId, gone.Connection.UserId, null));
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>Follows these workspaces (replacing the earlier set): those the caller is a member of, with their feed heads and who has which page open.</summary>
    public async Task<Answer<List<WorkspaceJoined>>> JoinWorkspaces(JsonElement? workspaceIds)
    {
        return await Guarded<List<WorkspaceJoined>>(async () =>
        {
            if (workspaceIds is not { ValueKind: JsonValueKind.Array } list || list.GetArrayLength() > RealtimeSettings.MaxWorkspacesPerCall)
                return Failure.Invalid($"workspaceIds is a list of at most {RealtimeSettings.MaxWorkspacesPerCall} ids");
            var ids = new List<Guid>();
            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String || !Guid.TryParse(item.GetString(), out var id)) return Failure.Invalid("workspaceIds holds ids");
                if (!ids.Contains(id)) ids.Add(id);
            }
            var joined = new List<WorkspaceJoined>();
            foreach (var id in ids)
            {
                // The feed's head before membership is read: any change after it, the relay sees.
                var seq = await db.Workspaces.AsNoTracking().Where(w => w.Id == id).Select(w => (long?)w.ChangeSeq).FirstOrDefaultAsync(Context.ConnectionAborted);
                if (seq is null || await access.MemberAsync(id, UserId) is not { } member) continue;
                List<PagePresenceEntry> presence = [];
                var open = registry.PagesIn(id);
                if (open.Count > 0)
                {
                    db.Scope.Switch(id);
                    var levels = await access.LevelsAsync(member, open, Context.ConnectionAborted);
                    presence = open.Where(p => Levels.AtLeast(levels.GetValueOrDefault(p, Levels.None), Levels.View))
                        .Select(p => new PagePresenceEntry(p, registry.UsersOn(p))).Where(p => p.UserIds.Count > 0).ToList();
                }
                registry.WorkspaceCursors.TryAdd(id, new WorkspaceCursor(seq.Value));
                joined.Add(new WorkspaceJoined(id, seq.Value, presence));
            }
            registry.Follow(Context.ConnectionId, joined.Select(j => j.WorkspaceId));
            return Answer<List<WorkspaceJoined>>.Of(joined);
        });
    }

    /// <summary>Joins a page, as a pull is checked: member, at least <c>view</c>; 404 otherwise, 410 for a page deleted for good.</summary>
    public async Task<Answer<PageJoined>> JoinPage(string? pageId)
    {
        return await Guarded<PageJoined>(async () =>
        {
            if (!Guid.TryParse(pageId, out var id)) return Failure.NotFound("No such page");
            var workspace = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(p => p.Id == id).Select(p => (Guid?)p.WorkspaceId).FirstOrDefaultAsync(Context.ConnectionAborted);
            if (workspace is null) return Failure.NotFound("No such page");
            var seq = await db.Workspaces.AsNoTracking().Where(w => w.Id == workspace).Select(w => w.ChangeSeq).FirstOrDefaultAsync(Context.ConnectionAborted);
            var opened = await gate.OpenAsync(UserId, id, Context.ConnectionAborted);
            if (!opened.Ok) return opened.Failure!;
            var page = opened.Value!.Page;
            // In the group before the others are read: nothing said after this is missed.
            await Groups.AddToGroupAsync(Context.ConnectionId, RealtimeRegistry.Group(id), Context.ConnectionAborted);
            if (registry.Join(Context.ConnectionId, id, page.WorkspaceId, opened.Value.Level) is null)
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, RealtimeRegistry.Group(id));
                return Failure.Invalid($"A connection joins at most {RealtimeSettings.MaxPagesPerConnection} pages");
            }
            registry.PageCursors.TryAdd(id, new PageCursor(page.DocEpoch, page.DocHeadSeq));
            registry.WorkspaceCursors.TryAdd(page.WorkspaceId, new WorkspaceCursor(seq));
            return Answer<PageJoined>.Of(new PageJoined(page.WorkspaceId, page.DocEpoch, page.DocHeadSeq, page.DocSchemaVersion, opened.Value.Level,
                registry.Others(id, Context.ConnectionId)));
        });
    }

    /// <summary>Leaves a page: always works.</summary>
    public async Task<Answer<Empty>> LeavePage(string? pageId)
    {
        return await Guarded<Empty>(async () =>
        {
            if (Guid.TryParse(pageId, out var id) && registry.Leave(Context.ConnectionId, id) is { } left)
            {
                var group = RealtimeRegistry.Group(id);
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, group);
                await Clients.Group(group).SendAsync(Events.Awareness, new PresenceMessage(id, left.PresenceId, UserId, null));
            }
            return Answer<Empty>.Of(Empty.Value);
        });
    }

    /// <summary>
    /// Exactly the HTTP push: the person's push budget, the page's check as the route's filter makes
    /// it, then the same checked push (level at least <c>edit</c> read fresh, the same transaction,
    /// sequence lock, epoch, version, size and per-page rate checks). At most 1 MB of updates a call.
    /// The page need not be joined.
    /// </summary>
    public async Task<Answer<PushResponse>> PushUpdates(string? pageId, JsonElement? request)
    {
        var started = RelayMetrics.Now();
        return await Guarded<PushResponse>(async () =>
        {
            if (budget.Take(UserId) is { } wait) return new Failure(Codes.LimitRate, 429, "Too many requests") { RetryAfter = wait };
            if (!Guid.TryParse(pageId, out var id)) return Failure.NotFound("No such page");
            PushRequest? body;
            try
            {
                body = request is { ValueKind: JsonValueKind.Object } json ? json.Deserialize<PushRequest>(Web) : null;
            }
            catch (JsonException)
            {
                body = null;
            }
            if (body is null) return Failure.Invalid("The push does not read as { epoch, clientSchemaVersion, updates }");
            var opened = await gate.OpenAsync(UserId, id, Context.ConnectionAborted);
            if (!opened.Ok) return opened.Failure!;
            var result = await docs.PushCheckedAsync(opened.Value!, body, Context.User!.DeviceId(), RealtimeSettings.MaxPushBytes, Context.ConnectionAborted);
            if (!result.Ok) return result.Failure!;
            metrics.Pushed(id, result.Value!.Acks, started);
            return Answer<PushResponse>.Of(result.Value);
        });
    }

    /// <summary>Relays the caller's presence on a page it joined to the page's other connections; never stored.</summary>
    public async Task<Answer<Empty>> Awareness(string? pageId, JsonElement? state)
    {
        return await Guarded<Empty>(async () =>
        {
            if (registry.TakeAwareness(Context.ConnectionId) is { } wait)
                return new Failure(Codes.LimitRate, 429, "Too many presence messages") { RetryAfter = wait };
            if (!Guid.TryParse(pageId, out var id)) return Failure.NotFound("Join the page first");
            var parsed = PresenceState.Parse(state);
            if (!parsed.Ok) return parsed.Failure!;
            if (registry.SetState(Context.ConnectionId, id, parsed.Value) is not { } joined) return Failure.NotFound("Join the page first");
            await Clients.OthersInGroup(RealtimeRegistry.Group(id))
                .SendAsync(Events.Awareness, new PresenceMessage(id, joined.PresenceId, UserId, parsed.Value));
            return Answer<Empty>.Of(Empty.Value);
        });
    }

    /// <summary>An unexpected failure is an answer too (500 <c>server.error</c>), and says nothing of the server's insides.</summary>
    private async Task<Answer<T>> Guarded<T>(Func<Task<Answer<T>>> call)
        where T : class
    {
        try
        {
            return await call();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "A hub call failed");
            return new Failure(Codes.ServerError, 500, "Something went wrong");
        }
    }
}
