using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.WebUtilities;

namespace Cgw.Api.Realtime;

/// <summary>A page a connection joined: its workspace, the level its last check found, its presence.</summary>
public sealed class JoinedPage(Guid pageId, Guid workspaceId, string level)
{
    public Guid PageId { get; } = pageId;
    public Guid WorkspaceId { get; } = workspaceId;
    public string Level { get; set; } = level;
    /// <summary>Random per connection and page, never the SignalR connection id.</summary>
    public string PresenceId { get; } = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(12));
    /// <summary>The last state the connection sent here (kept in memory only, for those who join after).</summary>
    public PresenceState? State { get; set; }
}

/// <summary>One hub connection: whose, which device, what it follows and has joined.</summary>
public sealed class RealtimeConnection(string id, Guid userId, Guid deviceId, HubCallerContext context, long order)
{
    public string Id { get; } = id;
    public Guid UserId { get; } = userId;
    public Guid DeviceId { get; } = deviceId;
    public HubCallerContext Context { get; } = context;
    /// <summary>When it connected, in the registry's order: the oldest goes first past a limit.</summary>
    public long Order { get; } = order;
    internal readonly HashSet<Guid> Workspaces = [];
    internal readonly Dictionary<Guid, JoinedPage> Pages = [];
    /// <summary>When its access was last checked (<see cref="Environment.TickCount64"/>).</summary>
    public long CheckedAt = Environment.TickCount64;
    /// <summary>Its access is to be checked again at once (a feed change, a device signed out).</summary>
    public volatile bool Due;
    internal long WindowStart;
    internal int WindowCount;
}

/// <summary>What the relay keeps per page: the epoch and head it last relayed.</summary>
public sealed record PageCursor(int Epoch, long Head);

/// <summary>What the relay keeps per workspace: the feed head it last saw and last told followers.</summary>
public sealed class WorkspaceCursor(long seq)
{
    public long Seen = seq;
    public long Told = seq;
    public long ToldAt;
}

/// <summary>
/// This node's hub connections and nothing else (Phase 6 contracts: no state but connections in
/// memory, so a recycle loses nothing): who follows which workspace, who joined which page, and the
/// relay's place in each. One lock for every change to who is where; reads take copies.
/// </summary>
public sealed class RealtimeRegistry
{
    private readonly object sync = new();
    private readonly Dictionary<string, RealtimeConnection> connections = [];
    private readonly Dictionary<Guid, HashSet<string>> byPage = [];
    private readonly Dictionary<Guid, HashSet<string>> byWorkspace = [];
    private long order;

    /// <summary>Pages whose set of people changed, to be told (at most every 500 ms a page).</summary>
    public ConcurrentDictionary<Guid, Guid> PresenceDirty { get; } = new();
    public ConcurrentDictionary<Guid, PageCursor> PageCursors { get; } = new();
    public ConcurrentDictionary<Guid, WorkspaceCursor> WorkspaceCursors { get; } = new();
    /// <summary>Levels found for telling who has a page open: (workspace, page, person) to level and when.</summary>
    public ConcurrentDictionary<(Guid Workspace, Guid Page, Guid User), (string Level, long At)> Levels { get; } = new();
    /// <summary>Wakes the access re-check.</summary>
    public SemaphoreSlim Recheck { get; } = new(0);

    public static string Group(Guid pageId) => "p:" + pageId.ToString("N");

    /// <summary>Adds a connection; returns those to close, the oldest past 20 a device or 200 a person.</summary>
    public List<RealtimeConnection> Add(string id, Guid userId, Guid deviceId, HubCallerContext context)
    {
        lock (sync)
        {
            var connection = new RealtimeConnection(id, userId, deviceId, context, ++order);
            connections[id] = connection;
            var evicted = new List<RealtimeConnection>();
            var device = connections.Values.Where(c => c.DeviceId == deviceId).OrderBy(c => c.Order).ToList();
            evicted.AddRange(device.Take(Math.Max(0, device.Count - RealtimeSettings.MaxConnectionsPerDevice)));
            var person = connections.Values.Where(c => c.UserId == userId && !evicted.Contains(c)).OrderBy(c => c.Order).ToList();
            evicted.AddRange(person.Take(Math.Max(0, person.Count - RealtimeSettings.MaxConnectionsPerPerson)));
            return evicted;
        }
    }

    public RealtimeConnection? Get(string id)
    {
        lock (sync) return connections.GetValueOrDefault(id);
    }

    /// <summary>Removes a connection; returns it, with the pages it had joined.</summary>
    public (RealtimeConnection Connection, List<JoinedPage> Pages)? Remove(string id)
    {
        lock (sync)
        {
            if (!connections.Remove(id, out var connection)) return null;
            var pages = connection.Pages.Values.ToList();
            foreach (var page in pages) Unjoin(connection, page.PageId);
            foreach (var workspace in connection.Workspaces.ToList()) Unfollow(connection, workspace);
            return (connection, pages);
        }
    }

    public int Count
    {
        get
        {
            lock (sync) return connections.Count;
        }
    }

    public int PageCount
    {
        get
        {
            lock (sync) return byPage.Count;
        }
    }

    /// <summary>The workspaces a connection follows from now on (replacing the earlier set).</summary>
    public void Follow(string id, IEnumerable<Guid> workspaces)
    {
        lock (sync)
        {
            if (!connections.TryGetValue(id, out var connection)) return;
            var wanted = workspaces.ToHashSet();
            foreach (var old in connection.Workspaces.Where(w => !wanted.Contains(w)).ToList()) Unfollow(connection, old);
            foreach (var workspace in wanted)
                if (connection.Workspaces.Add(workspace))
                    (byWorkspace.TryGetValue(workspace, out var set) ? set : byWorkspace[workspace] = []).Add(id);
        }
    }

    public void Unfollow(string id, Guid workspace)
    {
        lock (sync)
            if (connections.TryGetValue(id, out var connection)) Unfollow(connection, workspace);
    }

    private void Unfollow(RealtimeConnection connection, Guid workspace)
    {
        if (!connection.Workspaces.Remove(workspace)) return;
        if (byWorkspace.TryGetValue(workspace, out var set) && set.Remove(connection.Id) && set.Count == 0) byWorkspace.Remove(workspace);
    }

    /// <summary>Joins a page (or refreshes the level of one joined already); null past 50 pages.</summary>
    public JoinedPage? Join(string id, Guid pageId, Guid workspaceId, string level)
    {
        lock (sync)
        {
            if (!connections.TryGetValue(id, out var connection)) return null;
            if (connection.Pages.TryGetValue(pageId, out var joined))
            {
                joined.Level = level;
                return joined;
            }
            if (connection.Pages.Count >= RealtimeSettings.MaxPagesPerConnection) return null;
            var newPerson = !UsersOnLocked(pageId).Contains(connection.UserId);
            joined = new JoinedPage(pageId, workspaceId, level);
            connection.Pages[pageId] = joined;
            (byPage.TryGetValue(pageId, out var set) ? set : byPage[pageId] = []).Add(id);
            if (newPerson) PresenceDirty[pageId] = workspaceId;
            return joined;
        }
    }

    /// <summary>Leaves a page; the page as it was joined, or null when it was not.</summary>
    public JoinedPage? Leave(string id, Guid pageId)
    {
        lock (sync)
            return connections.TryGetValue(id, out var connection) ? Unjoin(connection, pageId) : null;
    }

    private JoinedPage? Unjoin(RealtimeConnection connection, Guid pageId)
    {
        if (!connection.Pages.Remove(pageId, out var joined)) return null;
        if (byPage.TryGetValue(pageId, out var set) && set.Remove(connection.Id) && set.Count == 0) byPage.Remove(pageId);
        if (!UsersOnLocked(pageId).Contains(connection.UserId)) PresenceDirty[pageId] = joined.WorkspaceId;
        return joined;
    }

    /// <summary>The level a re-check found, for a page still joined (never joins it again).</summary>
    public void Relevel(string id, Guid pageId, string level)
    {
        lock (sync)
            if (connections.TryGetValue(id, out var connection) && connection.Pages.TryGetValue(pageId, out var joined)) joined.Level = level;
    }

    /// <summary>Records a connection's state on a page it joined (at least <c>view</c>); null when it has not.</summary>
    public JoinedPage? SetState(string id, Guid pageId, PresenceState? state)
    {
        lock (sync)
        {
            if (!connections.TryGetValue(id, out var connection) || !connection.Pages.TryGetValue(pageId, out var joined)
                || !Cgw.Core.Data.Levels.AtLeast(joined.Level, Cgw.Core.Data.Levels.View))
                return null;
            joined.State = state;
            return joined;
        }
    }

    /// <summary>Whether one more awareness message this second fits (20 a second a connection); else the wait.</summary>
    public TimeSpan? TakeAwareness(string id)
    {
        lock (sync)
        {
            if (!connections.TryGetValue(id, out var connection)) return null;
            var now = Environment.TickCount64;
            if (now - connection.WindowStart >= 1000)
            {
                connection.WindowStart = now;
                connection.WindowCount = 0;
            }
            if (connection.WindowCount >= RealtimeSettings.AwarenessPerSecond) return TimeSpan.FromMilliseconds(1000 - (now - connection.WindowStart));
            connection.WindowCount++;
            return null;
        }
    }

    /// <summary>Everyone else's presence on a page: for a connection that joins it.</summary>
    public List<PresenceMessage> Others(Guid pageId, string exceptId)
    {
        lock (sync)
        {
            if (!byPage.TryGetValue(pageId, out var set)) return [];
            return set.Where(c => c != exceptId).Select(c => connections[c]).Select(c => (c, c.Pages[pageId]))
                .Select(x => new PresenceMessage(pageId, x.Item2.PresenceId, x.c.UserId, x.Item2.State)).ToList();
        }
    }

    /// <summary>The people who have a page open on this node, in id order.</summary>
    public List<Guid> UsersOn(Guid pageId)
    {
        lock (sync) return UsersOnLocked(pageId);
    }

    private List<Guid> UsersOnLocked(Guid pageId) =>
        byPage.TryGetValue(pageId, out var set) ? set.Select(c => connections[c].UserId).Distinct().Order().ToList() : [];

    /// <summary>The pages of a workspace someone has open on this node.</summary>
    public List<Guid> PagesIn(Guid workspaceId)
    {
        lock (sync)
            return byPage.Where(p => p.Value.Any(c => connections[c].Pages.TryGetValue(p.Key, out var j) && j.WorkspaceId == workspaceId))
                .Select(p => p.Key).ToList();
    }

    /// <summary>Every joined page, its workspace and its connections.</summary>
    public Dictionary<Guid, (Guid Workspace, List<string> Connections)> JoinedPages()
    {
        lock (sync)
            return byPage.ToDictionary(p => p.Key, p => (connections[p.Value.First()].Pages[p.Key].WorkspaceId, p.Value.ToList()));
    }

    /// <summary>Workspaces with a follower or a joined page on this node, and their followers.</summary>
    public Dictionary<Guid, List<string>> Workspaces()
    {
        lock (sync)
        {
            var result = byWorkspace.ToDictionary(w => w.Key, w => w.Value.ToList());
            foreach (var connection in connections.Values)
                foreach (var page in connection.Pages.Values)
                    result.TryAdd(page.WorkspaceId, []);
            return result;
        }
    }

    public List<RealtimeConnection> Followers(Guid workspaceId)
    {
        lock (sync) return byWorkspace.TryGetValue(workspaceId, out var set) ? set.Select(c => connections[c]).ToList() : [];
    }

    /// <summary>Connections that follow the workspace or have one of its pages open.</summary>
    public List<RealtimeConnection> In(Guid workspaceId)
    {
        lock (sync)
            return connections.Values.Where(c => c.Workspaces.Contains(workspaceId) || c.Pages.Values.Any(p => p.WorkspaceId == workspaceId)).ToList();
    }

    public List<RealtimeConnection> All()
    {
        lock (sync) return connections.Values.ToList();
    }

    /// <summary>What a connection follows and has open, as of now.</summary>
    public (List<Guid> Workspaces, List<JoinedPage> Pages) Snapshot(RealtimeConnection connection)
    {
        lock (sync) return (connection.Workspaces.ToList(), connection.Pages.Values.ToList());
    }

    /// <summary>Marks these connections' access for checking at once, and wakes the check.</summary>
    public void CheckNow(IEnumerable<RealtimeConnection> due)
    {
        var any = false;
        foreach (var connection in due)
        {
            connection.Due = true;
            any = true;
        }
        if (any) Recheck.Release();
    }

    /// <summary>A device signed out: its connections are checked (and closed) at once.</summary>
    public void DeviceEnded(Guid deviceId)
    {
        List<RealtimeConnection> due;
        lock (sync) due = connections.Values.Where(c => c.DeviceId == deviceId).ToList();
        CheckNow(due);
    }

    /// <summary>Forgets the levels found in a workspace (its access changed).</summary>
    public void ForgetLevels(Guid workspaceId)
    {
        foreach (var key in Levels.Keys.Where(k => k.Workspace == workspaceId).ToList()) Levels.TryRemove(key, out _);
    }
}
