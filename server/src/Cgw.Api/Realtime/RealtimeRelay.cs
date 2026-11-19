using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Sync;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Api.Realtime;

/// <summary>
/// The relay (Phase 6 contracts, section 1, The relay), in the API's process. Every
/// <c>Realtime__RelayMs</c> (20 ms) it reads the validated heads of the pages this node's
/// connections joined and the feed heads of the workspaces they follow. A page whose head moved past
/// what was last relayed gets one frame for (last, head]: its valid rows and refused ids, read once,
/// sent to this node's connections of that page (never to a SignalR group, so a second node relays
/// only to its own and nothing goes out twice). Updates are relayed only once the worker has passed
/// them (Q20); the API never decodes them. A workspace whose feed moved tells its followers (at most
/// every <c>Realtime__ChangesMs</c>), and an access, member or workspace change in it has its
/// connections' access checked again at once.
///
/// Beside it, the access re-check: each connection at most every <c>Realtime__RecheckSeconds</c>
/// (60), found by a sweep every <c>Realtime__SweepSeconds</c> (10), or at once when the feed or a
/// sign-out says so. What is lost is left (<c>AccessRevoked</c>; the others told the presence went);
/// a device signed out or an account removed closes the connection.
/// </summary>
public sealed class RealtimeRelay(
    RealtimeRegistry registry,
    IHubContext<RealtimeHub> hub,
    IServiceScopeFactory scopes,
    RealtimeSettings settings,
    RelayMetrics metrics,
    ILogger<RealtimeRelay> logger) : BackgroundService
{
    /// <summary>A pass waits at most this long on slow connections before the next one.</summary>
    private static readonly TimeSpan SendWait = TimeSpan.FromMilliseconds(250);
    private readonly SemaphoreSlim passing = new(1, 1);
    private readonly Dictionary<Guid, (List<Guid> Users, long At)> presenceSent = [];
    /// <summary>
    /// The relay's own connection for its heads read, kept open (Phase 8: the read runs every 20 ms,
    /// and most passes need nothing else from the database); made again after any failure.
    /// </summary>
    private Microsoft.Data.SqlClient.SqlConnection? headsConnection;
    private string? connectionString;

    /// <summary>A pass's database, made only when the pass needs more than the heads.</summary>
    private sealed class PassDb(IServiceScopeFactory scopes) : IAsyncDisposable
    {
        private AsyncServiceScope? scope;
        private CgwDb? db;

        public CgwDb Get()
        {
            if (db is not null) return db;
            scope = scopes.CreateAsyncScope();
            return db = scope.Value.ServiceProvider.GetRequiredService<CgwDb>();
        }

        public async ValueTask DisposeAsync()
        {
            if (scope is { } made) await made.DisposeAsync();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (StartupTasks.GeneratingDocument) return;
        try
        {
            await Task.WhenAll(Task.Run(() => RelayLoopAsync(ct), ct), Task.Run(() => RecheckLoopAsync(ct), ct));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
    }

    private async Task RelayLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(settings.Relay);
        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                await PassAsync(ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogError(e, "A relay pass failed");
            }
        }
    }

    /// <summary>One pass of the relay: frames, feed heads, who has which page open.</summary>
    public async Task PassAsync(CancellationToken ct = default)
    {
        await passing.WaitAsync(ct);
        try
        {
            var pages = registry.JoinedPages();
            foreach (var gone in registry.PageCursors.Keys.Where(k => !pages.ContainsKey(k)).ToList()) registry.PageCursors.TryRemove(gone, out _);
            var workspaces = registry.Workspaces();
            foreach (var gone in registry.WorkspaceCursors.Keys.Where(k => !workspaces.ContainsKey(k)).ToList()) registry.WorkspaceCursors.TryRemove(gone, out _);
            if (pages.Count == 0 && workspaces.Count == 0 && registry.PresenceDirty.IsEmpty) return;
            await using var db = new PassDb(scopes);
            if (pages.Count > 0 || workspaces.Count > 0)
            {
                // Every head this pass needs in one round trip (Phase 8: the relay reads them every 20 ms).
                var (pageHeads, workspaceHeads) = await HeadsAsync(db, pages.Keys, workspaces.Keys, ct);
                if (pages.Count > 0) await RelayPagesAsync(db, pages, pageHeads, ct);
                if (workspaces.Count > 0) await WatchWorkspacesAsync(db, workspaces, workspaceHeads, ct);
            }
            if (!registry.PresenceDirty.IsEmpty) await PresenceAsync(db.Get(), ct);
        }
        finally
        {
            passing.Release();
        }
    }

    /// <summary>
    /// The validated heads of these pages (any workspace), and the feed heads of these workspaces
    /// with whether an access, member or workspace change came after what this node last saw of each
    /// (as <see cref="ChangeLog.AccessChangedAsync"/> asks): 0.7.0's reads, in one batch.
    /// </summary>
    private async Task<(List<(Guid Id, long Head, int Epoch)> Pages, List<(Guid Id, long Seq, bool AccessChanged, long Asked)> Workspaces)> HeadsAsync(
        PassDb db, IEnumerable<Guid> pageIds, IEnumerable<Guid> workspaceIds, CancellationToken ct)
    {
        static string Hex(Guid id) => Convert.ToHexString(GuidBytes.ToBytes(id));
        var pagesJson = System.Text.Json.JsonSerializer.Serialize(pageIds.Select(Hex));
        // A workspace first seen here has no cursor yet: nothing to ask of it.
        var asked = workspaceIds.ToDictionary(id => id, id => registry.WorkspaceCursors.TryGetValue(id, out var cursor) ? cursor.Seen : long.MaxValue);
        var workspacesJson = System.Text.Json.JsonSerializer.Serialize(asked.Select(a => new { id = Hex(a.Key), seen = a.Value }));
        connectionString ??= db.Get().Database.GetConnectionString();
        if (headsConnection is null)
        {
            headsConnection = new Microsoft.Data.SqlClient.SqlConnection(connectionString);
            await headsConnection.OpenAsync(ct);
        }
        try
        {
            await using var command = headsConnection.CreateCommand();
            command.Parameters.Add(new Microsoft.Data.SqlClient.SqlParameter("@pages", System.Data.SqlDbType.NVarChar, -1) { Value = pagesJson });
            command.Parameters.Add(new Microsoft.Data.SqlClient.SqlParameter("@workspaces", System.Data.SqlDbType.NVarChar, -1) { Value = workspacesJson });
            command.CommandText = """
                SELECT p.[Id], p.[DocHeadSeq], p.[DocEpoch] FROM [Pages] p
                WHERE p.[Id] IN (SELECT CONVERT(binary(16), [value], 2) FROM OPENJSON(@pages));
                SELECT w.[Id], w.[ChangeSeq],
                    CASE WHEN w.[ChangeSeq] > j.[seen] AND EXISTS (SELECT 1 FROM [WorkspaceChanges] c WHERE c.[WorkspaceId] = w.[Id] AND c.[Seq] > j.[seen]
                        AND c.[EntityType] IN (N'access', N'member', N'workspace')) THEN 1 ELSE 0 END
                FROM OPENJSON(@workspaces) WITH ([id] char(32), [seen] bigint) j
                INNER JOIN [Workspaces] w ON w.[Id] = CONVERT(binary(16), j.[id], 2);
                """;
            await using var reader = await command.ExecuteReaderAsync(ct);
            var pages = new List<(Guid, long, int)>();
            while (await reader.ReadAsync(ct))
                pages.Add((GuidBytes.FromBytes(reader.GetFieldValue<byte[]>(0)), reader.GetInt64(1), reader.GetInt32(2)));
            await reader.NextResultAsync(ct);
            var workspaces = new List<(Guid, long, bool, long)>();
            while (await reader.ReadAsync(ct))
            {
                var id = GuidBytes.FromBytes(reader.GetFieldValue<byte[]>(0));
                workspaces.Add((id, reader.GetInt64(1), reader.GetInt32(2) == 1, asked[id]));
            }
            return (pages, workspaces);
        }
        catch
        {
            // Opened again on the next pass.
            await headsConnection.DisposeAsync();
            headsConnection = null;
            throw;
        }
    }

    /// <summary>
    /// <see cref="FrameAsync"/> of one row (a push a key), on the relay's own connection: the same
    /// read as its one-row path, so the same frame, without a scope or EF for it.
    /// </summary>
    private async Task<RealtimeFrame> OneRowFrameAsync(Guid pageId, int epoch, long after, long head, CancellationToken ct)
    {
        var connection = headsConnection ?? throw new InvalidOperationException("The heads were not read");
        try
        {
            await using var command = connection.CreateCommand();
            command.Parameters.Add(new Microsoft.Data.SqlClient.SqlParameter("@page", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(pageId) });
            command.Parameters.Add(new Microsoft.Data.SqlClient.SqlParameter("@epoch", System.Data.SqlDbType.Int) { Value = epoch });
            command.Parameters.Add(new Microsoft.Data.SqlClient.SqlParameter("@after", System.Data.SqlDbType.BigInt) { Value = after });
            command.Parameters.Add(new Microsoft.Data.SqlClient.SqlParameter("@head", System.Data.SqlDbType.BigInt) { Value = head });
            command.CommandText = $"""
                SELECT [Seq], [UpdateId], [Status], CAST(ISNULL(DATALENGTH([Data]), 0) AS bigint), CASE WHEN [Status] = {UpdateStatus.Valid} THEN [Data] END
                FROM [PageDocUpdates]
                WHERE [PageId] = @page AND [Epoch] = @epoch AND [Seq] > @after AND [Seq] <= @head AND [Status] <> {UpdateStatus.Pending}
                """;
            var rows = new List<(long Seq, Guid UpdateId, byte Status, long Size, byte[]? Data)>();
            await using (var reader = await command.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct))
                    rows.Add((reader.GetInt64(0), GuidBytes.FromBytes(reader.GetFieldValue<byte[]>(1)), reader.GetByte(2), reader.GetInt64(3),
                        reader.IsDBNull(4) ? null : reader.GetFieldValue<byte[]>(4)));
            RealtimeFrame Incomplete() => new(pageId, epoch, after, head, head, [], [], false);
            if (rows.Count != 1) return Incomplete();
            var row = rows[0];
            if (row.Status != UpdateStatus.Valid) return new RealtimeFrame(pageId, epoch, after, head, head, [], [row.UpdateId], true);
            if (row.Size > RealtimeSettings.MaxFrameBytes) return Incomplete();
            return new RealtimeFrame(pageId, epoch, after, head, head, [new FrameUpdate(row.Seq, row.UpdateId, row.Data!)], [], true);
        }
        catch
        {
            await connection.DisposeAsync();
            headsConnection = null;
            throw;
        }
    }

    public override void Dispose()
    {
        headsConnection?.Dispose();
        base.Dispose();
    }

    private async Task RelayPagesAsync(PassDb db, Dictionary<Guid, (Guid Workspace, List<string> Connections)> pages, List<(Guid Id, long Head, int Epoch)> heads,
        CancellationToken ct)
    {
        var sends = new List<Task>();
        foreach (var (id, head, epoch) in heads)
        {
            // A page first seen here starts where it is: whoever joined it pulled up to its head.
            if (!registry.PageCursors.TryGetValue(id, out var cursor))
            {
                registry.PageCursors[id] = new PageCursor(epoch, head);
                continue;
            }
            if (cursor.Epoch == epoch && head <= cursor.Head) continue;
            // Another epoch (a hard restore): the client pulls the page anew.
            var frame = cursor.Epoch != epoch
                ? new RealtimeFrame(id, epoch, 0, head, head, [], [], false)
                : head - cursor.Head == 1
                    ? await OneRowFrameAsync(id, epoch, cursor.Head, head, ct)
                    : await FrameAsync(db.Get(), id, epoch, cursor.Head, head, ct);
            registry.PageCursors[id] = new PageCursor(epoch, head);
            sends.Add(SendFrameAsync(pages[id].Connections, frame, ct));
        }
        if (sends.Count > 0) await WaitAsync(sends);
    }

    /// <summary>
    /// The frame for (after, head]: valid rows in order and refused ids, or <c>complete: false</c>
    /// (and nothing else) when rows are gone (a compaction) or there are too many to carry.
    /// </summary>
    public static async Task<RealtimeFrame> FrameAsync(CgwDb db, Guid pageId, int epoch, long after, long head, CancellationToken ct)
    {
        RealtimeFrame Incomplete() => new(pageId, epoch, after, head, head, [], [], false);
        if (head - after > RealtimeSettings.MaxFrameRows) return Incomplete();
        var rows = db.PageDocUpdates.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(u => u.PageId == pageId && u.Epoch == epoch && u.Seq > after && u.Seq <= head && u.Status != UpdateStatus.Pending);
        if (head - after == 1)
        {
            // One row, a push a key (Phase 8): its data read with it, one round trip; the same frame.
            var one = await rows.Select(u => new { u.Seq, u.UpdateId, u.Status, Size = EF.Functions.DataLength(u.Data) ?? 0, Data = u.Status == UpdateStatus.Valid ? u.Data : null })
                .ToListAsync(ct);
            if (one.Count != 1) return Incomplete();
            var row = one[0];
            if (row.Status != UpdateStatus.Valid) return new RealtimeFrame(pageId, epoch, after, head, head, [], [row.UpdateId], true);
            if (row.Size > RealtimeSettings.MaxFrameBytes) return Incomplete();
            return new RealtimeFrame(pageId, epoch, after, head, head, [new FrameUpdate(row.Seq, row.UpdateId, row.Data!)], [], true);
        }
        var decided = await rows.OrderBy(u => u.Seq)
            .Select(u => new { u.Seq, u.UpdateId, u.Status, Size = EF.Functions.DataLength(u.Data) ?? 0 }).ToListAsync(ct);
        if (decided.Count != head - after) return Incomplete();
        var valid = decided.Where(d => d.Status == UpdateStatus.Valid).ToList();
        if (valid.Sum(v => (long)v.Size) > RealtimeSettings.MaxFrameBytes) return Incomplete();
        var updates = valid.Count == 0
            ? []
            : await rows.Where(u => u.Status == UpdateStatus.Valid).OrderBy(u => u.Seq)
                .Select(u => new FrameUpdate(u.Seq, u.UpdateId, u.Data)).ToListAsync(ct);
        // A compaction between the two reads removed some.
        if (updates.Count != valid.Count) return Incomplete();
        var rejected = decided.Where(d => d.Status == UpdateStatus.Rejected).Select(d => d.UpdateId).ToList();
        return new RealtimeFrame(pageId, epoch, after, head, head, updates, rejected, true);
    }

    private async Task SendFrameAsync(List<string> connections, RealtimeFrame frame, CancellationToken ct)
    {
        try
        {
            await hub.Clients.Clients(connections).SendAsync(Events.Updates, frame, ct);
            metrics.Relayed(frame.PageId, frame.Updates.Select(u => u.Seq));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning(e, "A frame for page {Page} was not sent", frame.PageId);
        }
    }

    /// <summary>Waits for sends, but not on a slow connection past a moment: frames may come in any order.</summary>
    private static async Task WaitAsync(List<Task> sends)
    {
        try
        {
            await Task.WhenAll(sends).WaitAsync(SendWait);
        }
        catch (TimeoutException)
        {
        }
    }

    private async Task WatchWorkspacesAsync(PassDb db, Dictionary<Guid, List<string>> workspaces, List<(Guid Id, long Seq, bool AccessChanged, long Asked)> heads,
        CancellationToken ct)
    {
        var now = Environment.TickCount64;
        var sends = new List<Task>();
        foreach (var (id, seq, accessChanged, asked) in heads)
        {
            if (!registry.WorkspaceCursors.TryGetValue(id, out var cursor))
            {
                registry.WorkspaceCursors[id] = new WorkspaceCursor(seq);
                continue;
            }
            if (seq > cursor.Seen)
            {
                // Who may do what changed: this node's connections there are checked again at once.
                // Asked with the heads (Phase 8), past the cursor as it was then; a cursor made since
                // (a JoinWorkspaces meanwhile) is asked alone, as before.
                if (asked == cursor.Seen ? accessChanged : await ChangeLog.AccessChangedAsync(db.Get(), id, cursor.Seen, ct))
                {
                    registry.ForgetLevels(id);
                    registry.CheckNow(registry.In(id));
                }
                cursor.Seen = seq;
            }
            var followers = workspaces[id];
            if (cursor.Told < cursor.Seen && followers.Count > 0 && now - cursor.ToldAt >= (long)settings.ChangesEvery.TotalMilliseconds)
            {
                cursor.Told = cursor.Seen;
                cursor.ToldAt = now;
                sends.Add(hub.Clients.Clients(followers).SendAsync(Events.ChangesAvailable, new ChangesAvailable(id, cursor.Seen), ct));
            }
        }
        if (sends.Count > 0) await WaitAsync(sends);
    }

    /// <summary>
    /// Who has a page open, to the workspace's followers here who can read the page, when it
    /// changes, at most every 500 ms a page. Sent to this node's connections, as frames are: a group
    /// cannot leave out those who may not read the page.
    /// </summary>
    private async Task PresenceAsync(CgwDb db, CancellationToken ct)
    {
        var now = Environment.TickCount64;
        var every = (long)RealtimeSettings.PresenceEvery.TotalMilliseconds;
        var sends = new List<Task>();
        foreach (var (pageId, workspaceId) in registry.PresenceDirty.ToList())
        {
            if (presenceSent.TryGetValue(pageId, out var last) && now - last.At < every) continue;
            registry.PresenceDirty.TryRemove(pageId, out _);
            var users = registry.UsersOn(pageId);
            if (last.Users is not null && last.Users.SequenceEqual(users)) continue;
            var followers = registry.Followers(workspaceId);
            if (followers.Count > 0)
            {
                var readers = await ReadersAsync(db, workspaceId, pageId, followers.Select(f => f.UserId).Distinct().ToList(), ct);
                var targets = followers.Where(f => readers.Contains(f.UserId)).Select(f => f.Id).ToList();
                if (targets.Count > 0) sends.Add(hub.Clients.Clients(targets).SendAsync(Events.PagePresence, new PagePresence(workspaceId, pageId, users), ct));
            }
            if (users.Count == 0) presenceSent.Remove(pageId);
            else presenceSent[pageId] = (users, now);
        }
        foreach (var gone in presenceSent.Keys.Where(p => !registry.PresenceDirty.ContainsKey(p) && registry.UsersOn(p).Count == 0).ToList()) presenceSent.Remove(gone);
        if (sends.Count > 0) await WaitAsync(sends);
    }

    /// <summary>Who of these can read the page, from the levels found (no older than a re-check) or read now.</summary>
    private async Task<HashSet<Guid>> ReadersAsync(CgwDb db, Guid workspaceId, Guid pageId, List<Guid> users, CancellationToken ct)
    {
        var now = Environment.TickCount64;
        var fresh = (long)settings.Recheck.TotalMilliseconds;
        var missing = users.Where(u => !registry.Levels.TryGetValue((workspaceId, pageId, u), out var known) || now - known.At > fresh).ToList();
        if (missing.Count > 0)
        {
            db.Scope.Switch(workspaceId);
            try
            {
                foreach (var (user, level) in await new Access(db).LevelsOfAsync(workspaceId, pageId, missing, ct))
                    registry.Levels[(workspaceId, pageId, user)] = (level, now);
            }
            finally
            {
                db.Scope.Switch(null);
            }
        }
        return users.Where(u => registry.Levels.TryGetValue((workspaceId, pageId, u), out var known) && Levels.AtLeast(known.Level, Levels.View)).ToHashSet();
    }

    private async Task RecheckLoopAsync(CancellationToken ct)
    {
        var sweep = (long)settings.Sweep.TotalMilliseconds;
        var recheck = (long)settings.Recheck.TotalMilliseconds;
        var next = Environment.TickCount64 + sweep;
        while (!ct.IsCancellationRequested)
        {
            var wait = Math.Max(0, next - Environment.TickCount64);
            await registry.Recheck.WaitAsync(TimeSpan.FromMilliseconds(wait), ct);
            var now = Environment.TickCount64;
            if (now >= next)
            {
                foreach (var connection in registry.All().Where(c => now - c.CheckedAt >= recheck)) connection.Due = true;
                next = now + sweep;
            }
            try
            {
                await RecheckDueAsync(ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogError(e, "An access re-check failed");
            }
        }
    }

    /// <summary>Checks the access of every connection that is due.</summary>
    public async Task RecheckDueAsync(CancellationToken ct = default)
    {
        var due = registry.All().Where(c => c.Due).ToList();
        if (due.Count == 0) return;
        await Parallel.ForEachAsync(due, new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = ct }, async (connection, token) =>
        {
            try
            {
                await RecheckAsync(connection, token);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogWarning(e, "The access of connection {Connection} was not checked", connection.Id);
                connection.Due = true;
            }
        });
    }

    /// <summary>
    /// One connection's access, as of now: its device and account, its membership in each workspace
    /// it follows or has a page open in, each joined page at least <c>view</c>.
    /// </summary>
    public async Task RecheckAsync(RealtimeConnection connection, CancellationToken ct = default)
    {
        connection.Due = false;
        connection.CheckedAt = Environment.TickCount64;
        if (registry.Get(connection.Id) is null) return;
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        var (workspaces, pages) = registry.Snapshot(connection);
        var all = workspaces.Concat(pages.Select(p => p.WorkspaceId)).Distinct().ToList();
        // Phase 11: a session of single sign-on ends at its device's EndsAt, as a revoked one does.
        var now = scope.ServiceProvider.GetRequiredService<TimeProvider>().GetUtcNow();
        var active = await db.Devices.AsNoTracking().AnyAsync(d => d.Id == connection.DeviceId && d.RevokedAt == null && (d.EndsAt == null || d.EndsAt > now), ct)
            && await db.Users.AsNoTracking().AnyAsync(u => u.Id == connection.UserId && u.DeletedAt == null, ct);
        if (!active)
        {
            await EndAsync(connection, all, pages);
            return;
        }
        var access = scope.ServiceProvider.GetRequiredService<Access>();
        var gone = new HashSet<Guid>();
        foreach (var workspace in all)
        {
            if (await access.MemberAsync(workspace, connection.UserId) is not null) continue;
            gone.Add(workspace);
            registry.Unfollow(connection.Id, workspace);
            foreach (var page in pages.Where(p => p.WorkspaceId == workspace)) await LeaveAsync(connection, page.PageId);
            await TellAsync(connection, new AccessRevoked(workspace, null, RevokeReasons.MemberRemoved));
        }
        foreach (var page in pages.Where(p => !gone.Contains(p.WorkspaceId)))
        {
            // A scope of its own: the gate enters the page's workspace.
            await using var pageScope = scopes.CreateAsyncScope();
            var opened = await pageScope.ServiceProvider.GetRequiredService<PageGate>().OpenAsync(connection.UserId, page.PageId, ct);
            if (opened.Ok)
            {
                registry.Relevel(connection.Id, page.PageId, opened.Value!.Level);
                registry.Levels[(page.WorkspaceId, page.PageId, connection.UserId)] = (opened.Value.Level, Environment.TickCount64);
                continue;
            }
            await LeaveAsync(connection, page.PageId);
            await TellAsync(connection, new AccessRevoked(page.WorkspaceId, page.PageId, RevokeReasons.AccessDenied));
        }
    }

    /// <summary>A device signed out or an account removed: told, its presence withdrawn, closed.</summary>
    private async Task EndAsync(RealtimeConnection connection, List<Guid> workspaces, List<JoinedPage> pages)
    {
        foreach (var page in pages) await LeaveAsync(connection, page.PageId);
        foreach (var workspace in workspaces.Count > 0 ? workspaces : [Guid.Empty])
            await TellAsync(connection, new AccessRevoked(workspace, null, RevokeReasons.SessionEnded));
        logger.LogInformation("Closing hub connection {Connection}: its session ended", connection.Id);
        connection.Context.Abort();
    }

    private async Task LeaveAsync(RealtimeConnection connection, Guid pageId)
    {
        if (registry.Leave(connection.Id, pageId) is not { } left) return;
        var group = RealtimeRegistry.Group(pageId);
        await hub.Groups.RemoveFromGroupAsync(connection.Id, group);
        await hub.Clients.GroupExcept(group, [connection.Id]).SendAsync(Events.Awareness, new PresenceMessage(pageId, left.PresenceId, connection.UserId, null));
    }

    private async Task TellAsync(RealtimeConnection connection, AccessRevoked revoked)
    {
        try
        {
            await hub.Clients.Client(connection.Id).SendAsync(Events.AccessRevoked, revoked).WaitAsync(SendWait);
        }
        catch (Exception e) when (e is TimeoutException or IOException)
        {
            // A connection that cannot be told is closing anyway, or is left without the page.
        }
    }
}
