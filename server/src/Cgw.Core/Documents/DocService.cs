using IsolationLevel = System.Data.IsolationLevel;
using System.IO.Compression;
using System.Security.Cryptography;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Caching.Memory;

namespace Cgw.Core.Documents;

public sealed record DocUpdateIn(Guid UpdateId, byte[] Data);
public sealed record PushRequest(int Epoch, int ClientSchemaVersion, IReadOnlyList<DocUpdateIn> Updates);
public sealed record DocAck(Guid UpdateId, long Seq);
public sealed record PushResponse(IReadOnlyList<DocAck> Acks, long HeadSeq);
public sealed record SnapshotRef(long UpToSeq, string Url);
public sealed record DocUpdateOut(long Seq, Guid UpdateId, byte[] Data);
public sealed record PullResponse(
    int Epoch,
    int SchemaVersion,
    /// <summary>Every update up to here is decided (validated or refused).</summary>
    long HeadSeq,
    /// <summary>What this answer covers: the client's next <c>after</c>.</summary>
    long Cursor,
    bool More,
    SnapshotRef? Snapshot,
    IReadOnlyList<DocUpdateOut> Updates,
    /// <summary>The caller's own updates the worker refused, so its device can tell the user.</summary>
    IReadOnlyList<Guid> Rejected);
public sealed record DocJsonResponse(long UpToSeq, int SchemaVersion, string Json);
/// <summary>The worker's state hash of the validated head; null until it has made it for this head.</summary>
public sealed record StateHashResponse(int Epoch, long UpToSeq, string? Hash);
/// <summary>A repair: the device's whole state as one update (to edit), or none (to read only).</summary>
public sealed record RepairRequest(int Epoch, int ClientSchemaVersion, DocUpdateIn? Update);
public sealed record RepairResponse(DocAck? Ack, PullResponse Pull);
public sealed record YjsClientsRequest(int? Issue, IReadOnlyList<long>? Register);
public sealed record YjsClientsResponse(IReadOnlyList<long> Issued, IReadOnlyList<long> Registered, IReadOnlyList<long> Refused);

/// <summary>
/// Documents in the cloud (SYNC_DESIGN.md, Channel 1). The API never decodes an update: a push
/// gives each its sequence under a lock on the page row, so numbers are gap-free and commit in
/// order (D15, S8); the worker validates them before any other client may pull them (Q20).
/// </summary>
public sealed class DocService(CgwDb db, BlobStore blob, IMemoryCache cache, TimeProvider clock)
{
    public const int MaxUpdateBytes = 1024 * 1024;
    public const int MaxRequestBytes = 4 * 1024 * 1024;
    public const int MaxPull = 1000;
    /// <summary>
    /// Updates per minute to one page, from everyone (SYNC_DESIGN.md, What the server checks): 20
    /// people at the per-person push budget (600 a minute). From Phase 6 an open page saves (and
    /// pushes) about once a key, so the Phase 2 figure of 1,200 stopped a page at four or five
    /// people typing at once (bench/phase6.mjs, 20 editors at five keys a second).
    /// </summary>
    public const int PerPagePerMinute = 12_000;

    /// <summary>
    /// The push both transports make (Phase 6 contracts, section 1): the HTTP route and the hub's
    /// <c>PushUpdates</c> each read the caller's level fresh (<see cref="PageGate"/>), then come here
    /// (the hub through <see cref="PushThroughGateAsync"/>, Phase 8), so a refusal is the same over
    /// either. The hub allows 1 MB of updates a call (the client sends anything larger over HTTP).
    /// </summary>
    public async Task<Result<PushResponse>> PushCheckedAsync(PageAccess access, PushRequest request, Guid? deviceId, long maxRequestBytes = MaxRequestBytes, CancellationToken ct = default)
    {
        if (!Levels.AtLeast(access.Level, Levels.Edit)) return Failure.Denied("This page is read-only for you");
        return await PushAsync(access.Member, access.Page, request, deviceId, maxRequestBytes, ct);
    }

    public async Task<Result<PushResponse>> PushAsync(Member member, Page page, PushRequest request, Guid? deviceId, CancellationToken ct = default) =>
        await PushAsync(member, page, request, deviceId, MaxRequestBytes, ct);

    private async Task<Result<PushResponse>> PushAsync(Member member, Page page, PushRequest request, Guid? deviceId, long maxRequestBytes, CancellationToken ct)
    {
        if (request.Epoch != page.DocEpoch) return Failure.Conflict(Codes.DocEpochMismatch, $"The page's document is at epoch {page.DocEpoch}");
        if (request.ClientSchemaVersion < page.DocSchemaVersion) return new Failure(Codes.ClientTooOld, 426, "The document needs a newer version of the app");
        if (request.Updates is null || request.Updates.Count == 0) return Failure.Invalid("No updates");
        if (request.Updates.Any(u => u.Data is null || u.Data.Length == 0)) return Failure.Invalid("An update is empty");
        if (request.Updates.Any(u => u.Data.Length > MaxUpdateBytes)) return new Failure(Codes.LimitSize, 413, "An update is over 1 MB");
        if (request.Updates.Sum(u => (long)u.Data.Length) > maxRequestBytes)
            return new Failure(Codes.LimitSize, 413, $"The updates are over {maxRequestBytes / (1024 * 1024)} MB together");
        var second = clock.GetUtcNow().ToUnixTimeSeconds();
        var count = cache.GetOrCreate(("push", page.Id, second / 60), e =>
        {
            e.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2);
            return new StrongBox(0);
        })!;
        // The next minute's window is open to it.
        if (Interlocked.Add(ref count.Value, request.Updates.Count) > PerPagePerMinute)
            return new Failure(Codes.LimitRate, 429, "Too many updates to this page") { RetryAfter = TimeSpan.FromSeconds(60 - second % 60) };

        // A live page's push (a few updates): its whole transaction in one round trip.
        if (request.Updates.Count <= OneBatchUpdates) return await PushInOneBatchAsync(member, page, request, deviceId, ct);
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async Task<Result<PushResponse>> () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            // The page's sequence lock, held to the commit: the next numbers are this push's alone,
            // and pushes commit in sequence order (D15, S8). Not the page row: the worker moves the
            // validated head on that row, and pushes now hold it only for their last statement.
            // With it, in the same round trip (Phase 8: a live page pushes about once a key), the
            // page's sequence and the ids already used.
            var ids = request.Updates.Select(u => u.UpdateId).Distinct().ToList();
            var (head, known) = await LockAndReadAsync(page, ids, ct);
            if (head.DocEpoch != request.Epoch) return Failure.Conflict(Codes.DocEpochMismatch, $"The page's document is at epoch {head.DocEpoch}");
            if (known.Any(k => k.PageId != page.Id)) return Failure.Invalid("An update id is already used for another page");
            var seqs = known.ToDictionary(k => k.UpdateId, k => k.Seq);
            var next = head.DocSeq;
            var now = clock.GetUtcNow();
            var rows = new List<PageDocUpdate>();
            foreach (var update in request.Updates)
            {
                // A repeat (a lost answer) is answered with the number it was given the first time.
                if (seqs.ContainsKey(update.UpdateId)) continue;
                seqs[update.UpdateId] = ++next;
                rows.Add(new PageDocUpdate
                {
                    PageId = page.Id,
                    Seq = next,
                    UpdateId = update.UpdateId,
                    WorkspaceId = page.WorkspaceId,
                    Epoch = request.Epoch,
                    UserId = member.UserId,
                    DeviceId = deviceId,
                    Data = update.Data,
                    ClientSchemaVersion = request.ClientSchemaVersion,
                    Status = UpdateStatus.Pending,
                    CreatedAt = now,
                });
            }
            if (rows.Count > 0) await InsertAsync(page, head.DocEpoch, next, rows, ct);
            await tx.CommitAsync(ct);
            return new PushResponse(request.Updates.Select(u => new DocAck(u.UpdateId, seqs[u.UpdateId])).DistinctBy(a => a.UpdateId).ToList(), head.DocHeadSeq);
        });
    }

    /// <summary>The updates a push may carry to go in one batch (two parameters each, under SQL Server's 2,100 a request).</summary>
    private const int OneBatchUpdates = 500;

    /// <summary>
    /// The push's transaction in one round trip (Phase 8; the other path takes four): the same steps
    /// in the same order, in T-SQL. The page's sequence lock; the page's sequence, head and epoch
    /// (exactly one row, in its workspace); the epoch; an id already used for another page refuses
    /// the push; each id's first occurrence not already stored becomes a row, numbered on from the
    /// sequence in the request's order, and the sequence moves to the last; then each id's number
    /// (a repeat answered with the number it was given before). Anything that fails rolls it all back.
    /// </summary>
    private async Task<Result<PushResponse>> PushInOneBatchAsync(Member member, Page page, PushRequest request, Guid? deviceId, CancellationToken ct)
    {
        var answer = await RunBatchAsync(page.Id, page.WorkspaceId, member.UserId, request, deviceId, ct);
        return Settle(answer, page.Id, request);
    }

    /// <summary>
    /// The hub's push (Phase 8): <see cref="PageGate.OpenAsync"/> then <see cref="PushCheckedAsync"/>,
    /// with the gate's read and the push's transaction in one round trip when the gate's read alone
    /// decides that the caller may edit (a live page, not a row, in a section found, and the caller
    /// the private section's owner, or in a shared one an owner or admin, or a member no page of the
    /// chain decides for: no restricted page and no row for them or the workspace) and nothing about
    /// the request alone would refuse it. Otherwise the gate decides on the row the batch read (no
    /// second read), then the push runs as before. The same checks in the same order, so the same
    /// answers and texts. The page's rate is counted before the batch and given back if the push is
    /// refused before its transaction.
    /// </summary>
    public async Task<Result<PushResponse>> PushThroughGateAsync(PageGate gate, Guid userId, Guid pageId, PushRequest request, Guid? deviceId,
        long maxRequestBytes, CancellationToken ct = default)
    {
        async Task<Result<PushResponse>> TwoSteps()
        {
            var opened = await gate.OpenAsync(userId, pageId, ct);
            return opened.Ok ? await PushCheckedAsync(opened.Value!, request, deviceId, maxRequestBytes, ct) : opened.Failure!;
        }
        // A request its own checks would refuse is answered in their order, after the page's.
        if (request.Updates is not { Count: > 0 and <= OneBatchUpdates } updates
            || updates.Any(u => u?.Data is not { Length: > 0 and <= MaxUpdateBytes })
            || updates.Sum(u => (long)u.Data.Length) > maxRequestBytes)
            return await TwoSteps();
        var second = clock.GetUtcNow().ToUnixTimeSeconds();
        var count = cache.GetOrCreate(("push", pageId, second / 60), e =>
        {
            e.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2);
            return new StrongBox(0);
        })!;
        void GiveBack() => Interlocked.Add(ref count.Value, -updates.Count);
        if (Interlocked.Add(ref count.Value, updates.Count) > PerPagePerMinute)
        {
            GiveBack();
            return await TwoSteps();
        }
        var answer = await RunBatchAsync(pageId, null, userId, request, deviceId, ct);
        switch (answer.Outcome)
        {
            case NoPage:
                GiveBack();
                return Failure.NotFound("No such page");
            case Undecided:
                GiveBack();
                var opened = await gate.DecideAsync(userId, answer.Gate);
                return opened.Ok ? await PushCheckedAsync(opened.Value!, request, deviceId, maxRequestBytes, ct) : opened.Failure!;
        }
        // Past the gate: as the gate does, the page's workspace is entered.
        gate.Enter(answer.Gate!.Page.WorkspaceId);
        switch (answer.Outcome)
        {
            case GateEpoch:
                GiveBack();
                return Failure.Conflict(Codes.DocEpochMismatch, $"The page's document is at epoch {answer.Value}");
            case GateVersion:
                GiveBack();
                return new Failure(Codes.ClientTooOld, 426, "The document needs a newer version of the app");
        }
        return Settle(answer, pageId, request);
    }

    /// <summary>The outcomes of a hub push's gate (the transaction's are 0 to 4).</summary>
    private const int Undecided = 10, NoPage = 11, GateEpoch = 13, GateVersion = 15;

    private sealed record BatchAnswer(int Outcome, long Value, long Head, Dictionary<Guid, long> Seqs, PageGate.GateRow? Gate);

    private static Result<PushResponse> Settle(BatchAnswer answer, Guid pageId, PushRequest request) => answer.Outcome switch
    {
        0 => new PushResponse(request.Updates.Select(u => new DocAck(u.UpdateId, answer.Seqs[u.UpdateId])).DistinctBy(a => a.UpdateId).ToList(), answer.Head),
        1 => throw new InvalidOperationException($"The sequence lock of page {pageId} was not granted ({answer.Value})"),
        // As SingleAsync of the page's row.
        2 => throw new InvalidOperationException(answer.Value == 0 ? "Sequence contains no elements" : "Sequence contains more than one element"),
        3 => Failure.Conflict(Codes.DocEpochMismatch, $"The page's document is at epoch {answer.Value}"),
        _ => Failure.Invalid("An update id is already used for another page"),
    };

    /// <summary>
    /// The push's batch. With no <paramref name="workspaceId"/>, the page gate's read comes first
    /// (the page in any workspace, the caller's role in its live workspace, the page's section in
    /// its workspace, as <see cref="PageGate"/> reads them) and the push runs only when that read
    /// decides the caller may edit (as <see cref="Access"/> decides it) and the page's epoch and
    /// schema version take the request (as <see cref="PushAsync(Member, Page, PushRequest, Guid?, CancellationToken)"/>
    /// checks them on the gate's row).
    /// </summary>
    private async Task<BatchAnswer> RunBatchAsync(Guid pageId, Guid? workspaceId, Guid userId, PushRequest request, Guid? deviceId, CancellationToken ct)
    {
        var gated = workspaceId is null;
        await db.Database.OpenConnectionAsync(ct);
        var connection = db.Database.GetDbConnection();
        try
        {
            await using var command = connection.CreateCommand();
            void Add(string name, System.Data.SqlDbType type, object? value, int size = 0) =>
                command.Parameters.Add(new SqlParameter(name, type, size) { Value = value ?? DBNull.Value });
            Add("@resource", System.Data.SqlDbType.NVarChar, PageLocks.Resource(pageId), 255);
            Add("@given", System.Data.SqlDbType.Binary, workspaceId is { } given ? GuidBytes.ToBytes(given) : null, 16);
            Add("@page", System.Data.SqlDbType.Binary, GuidBytes.ToBytes(pageId), 16);
            Add("@epoch", System.Data.SqlDbType.Int, request.Epoch);
            Add("@user", System.Data.SqlDbType.Binary, GuidBytes.ToBytes(userId), 16);
            Add("@device", System.Data.SqlDbType.Binary, deviceId is { } device ? GuidBytes.ToBytes(device) : null, 16);
            Add("@version", System.Data.SqlDbType.Int, request.ClientSchemaVersion);
            command.Parameters.Add(new SqlParameter("@now", System.Data.SqlDbType.DateTimeOffset) { Value = clock.GetUtcNow(), Scale = 3 });
            var values = new List<string>();
            for (var i = 0; i < request.Updates.Count; i++)
            {
                values.Add($"({i}, @u{i}, @d{i})");
                Add($"@u{i}", System.Data.SqlDbType.Binary, GuidBytes.ToBytes(request.Updates[i].UpdateId), 16);
                Add($"@d{i}", System.Data.SqlDbType.VarBinary, request.Updates[i].Data, -1);
            }
            const string bin = CgwDb.BinaryCollation;
            // The gate's read, and Access's decision where the read alone makes it (Full for the
            // private section's owner and for owners and admins in a shared one; a member's default,
            // Edit, when no page of the chain is restricted or has a row for them or the workspace).
            // Anything else is left to PageGate (Undecided), with what was read.
            var gate = gated
                ? $"""
                    DECLARE @found int = 0, @kind nvarchar(20), @section binary(16), @parent binary(16), @deleted datetimeoffset(3),
                        @rowEpoch int, @schema int, @role nvarchar(20), @visibility nvarchar(20), @owner binary(16);
                    SELECT @found = 1, @ws = [WorkspaceId], @kind = [Kind], @section = [SectionId], @parent = [ParentPageId], @deleted = [DeletedAt],
                        @rowEpoch = [DocEpoch], @schema = [DocSchemaVersion]
                    FROM [Pages] WHERE [Id] = @page;
                    IF @found = 1
                    BEGIN
                        SELECT TOP (1) @role = m.[Role] FROM [WorkspaceMembers] m
                        WHERE m.[WorkspaceId] = @ws AND m.[UserId] = @user
                            AND EXISTS (SELECT 1 FROM [Workspaces] w WHERE w.[Id] = m.[WorkspaceId] AND w.[DeletedAt] IS NULL);
                        SELECT TOP (1) @visibility = s.[Visibility], @owner = s.[OwnerUserId] FROM [Sections] s WHERE s.[Id] = @section AND s.[WorkspaceId] = @ws;
                    END
                    IF @found = 0 OR @role IS NULL SET @outcome = {NoPage};
                    ELSE IF NOT (@deleted IS NULL AND @kind COLLATE {bin} <> N'{PageKinds.Row}' AND @visibility IS NOT NULL AND (
                            (@visibility COLLATE {bin} = N'private' AND @owner = @user)
                            OR (@visibility COLLATE {bin} <> N'private' AND (
                                @role COLLATE {bin} IN (N'{Roles.Owner}', N'{Roles.Admin}')
                                OR (@role COLLATE {bin} <> N'{Roles.Guest}' AND NOT EXISTS (
                                    SELECT 1 FROM [PageAncestors] a
                                    JOIN [Pages] p ON p.[Id] = a.[AncestorPageId] AND p.[WorkspaceId] = @ws
                                    WHERE a.[PageId] = @page AND a.[WorkspaceId] = @ws AND (p.[Restricted] = 1 OR EXISTS (
                                        SELECT 1 FROM [PagePermissions] r
                                        WHERE r.[PageId] = p.[Id] AND r.[WorkspaceId] = @ws
                                            AND ((r.[PrincipalType] COLLATE {bin} = N'user' AND r.[PrincipalId] = @user)
                                                OR r.[PrincipalType] COLLATE {bin} = N'workspace')))))))))
                        SET @outcome = {Undecided};
                    ELSE IF @rowEpoch <> @epoch SELECT @outcome = {GateEpoch}, @value = @rowEpoch;
                    ELSE IF @version < @schema SET @outcome = {GateVersion};
                    """
                : "";
            var gateColumns = gated ? ", @ws, @kind, @section, @parent, @deleted, @rowEpoch, @schema, @role, @visibility, @owner" : "";
            // Only parameter names and constants are written into the text.
            command.CommandText = $"""
                DECLARE @outcome int = 0, @value bigint = 0, @seq bigint, @head bigint, @docEpoch int, @rows int, @r int, @ws binary(16) = @given;
                DECLARE @in TABLE ([Ordinal] int PRIMARY KEY, [UpdateId] binary(16) NOT NULL, [Data] varbinary(max) NOT NULL);
                {gate}
                IF @outcome = 0
                BEGIN
                    BEGIN TRY
                        BEGIN TRANSACTION;
                        EXEC @r = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 30000;
                        IF @r < 0 SELECT @outcome = 1, @value = @r;
                        IF @outcome = 0
                        BEGIN
                            SELECT @seq = [DocSeq], @head = [DocHeadSeq], @docEpoch = [DocEpoch] FROM [Pages] WHERE [WorkspaceId] = @ws AND [Id] = @page;
                            SET @rows = @@ROWCOUNT;
                            IF @rows <> 1 SELECT @outcome = 2, @value = @rows;
                            ELSE IF @docEpoch <> @epoch SELECT @outcome = 3, @value = @docEpoch;
                        END
                        IF @outcome = 0
                        BEGIN
                            INSERT INTO @in ([Ordinal], [UpdateId], [Data]) VALUES {string.Join(", ", values)};
                            IF EXISTS (SELECT 1 FROM [PageDocUpdates] u WHERE u.[UpdateId] IN (SELECT [UpdateId] FROM @in) AND u.[PageId] <> @page) SET @outcome = 4;
                        END
                        IF @outcome = 0
                        BEGIN
                            INSERT INTO [PageDocUpdates] ([PageId], [Seq], [UpdateId], [WorkspaceId], [Epoch], [UserId], [DeviceId], [Data], [ClientSchemaVersion], [Status], [Problem], [CreatedAt])
                            SELECT @page, @seq + ROW_NUMBER() OVER (ORDER BY n.[Ordinal]), n.[UpdateId], @ws, @epoch, @user, @device, n.[Data], @version, {UpdateStatus.Pending}, NULL, @now
                            FROM (
                                SELECT i.[Ordinal], i.[UpdateId], i.[Data], ROW_NUMBER() OVER (PARTITION BY i.[UpdateId] ORDER BY i.[Ordinal]) AS [Nth]
                                FROM @in i WHERE NOT EXISTS (SELECT 1 FROM [PageDocUpdates] u WHERE u.[UpdateId] = i.[UpdateId])
                            ) n
                            WHERE n.[Nth] = 1;
                            SET @rows = @@ROWCOUNT;
                            IF @rows > 0 UPDATE [Pages] SET [DocSeq] = @seq + @rows WHERE [WorkspaceId] = @ws AND [Id] = @page AND [DocEpoch] = @docEpoch;
                        END
                        IF @outcome = 0 COMMIT TRANSACTION; ELSE ROLLBACK TRANSACTION;
                    END TRY
                    BEGIN CATCH
                        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
                        THROW;
                    END CATCH
                END
                SELECT @outcome, @value, @head{gateColumns};
                IF @outcome = 0 SELECT u.[UpdateId], u.[Seq] FROM [PageDocUpdates] u WHERE u.[PageId] = @page AND u.[UpdateId] IN (SELECT [UpdateId] FROM @in);
                """;
            var seqs = new Dictionary<Guid, long>();
            await using var reader = await command.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) throw new InvalidOperationException("The push answered nothing");
            var outcome = reader.GetInt32(0);
            var value = reader.GetInt64(1);
            var head = reader.IsDBNull(2) ? 0 : reader.GetInt64(2);
            PageGate.GateRow? row = null;
            if (gated && !reader.IsDBNull(3))
            {
                Guid? Id(int column) => reader.IsDBNull(column) ? null : GuidBytes.FromBytes(reader.GetFieldValue<byte[]>(column));
                // What the gate and the push read of the page; the rest keep their defaults.
                var page = new Page
                {
                    Id = pageId,
                    WorkspaceId = Id(3)!.Value,
                    Kind = reader.GetString(4),
                    SectionId = Id(5)!.Value,
                    ParentPageId = Id(6),
                    DeletedAt = reader.IsDBNull(7) ? null : reader.GetFieldValue<DateTimeOffset>(7),
                    DocEpoch = reader.GetInt32(8),
                    DocSchemaVersion = reader.GetInt32(9),
                };
                row = new PageGate.GateRow(page, reader.IsDBNull(10) ? null : reader.GetString(10), reader.IsDBNull(11) ? null : reader.GetString(11), Id(12));
            }
            if (await reader.NextResultAsync(ct))
                while (await reader.ReadAsync(ct))
                    seqs[GuidBytes.FromBytes(reader.GetFieldValue<byte[]>(0))] = reader.GetInt64(1);
            return new BatchAnswer(outcome, value, head, seqs, row);
        }
        catch
        {
            // A batch cut short (its request cancelled) can leave its transaction open, and its lock
            // held, on a connection going back to the pool: end it here.
            try
            {
                await using var rollback = connection.CreateCommand();
                rollback.CommandText = "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;";
                await rollback.ExecuteNonQueryAsync(CancellationToken.None);
            }
            catch (Exception)
            {
                // A broken connection is not pooled again; the first failure is the one to report.
            }
            throw;
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    private sealed record Head(long DocSeq, long DocHeadSeq, int DocEpoch);
    private sealed record Known(Guid UpdateId, long Seq, Guid PageId);

    /// <summary>
    /// In the push's transaction, one batch: the page's sequence lock (<see cref="PageLocks.SequenceAsync"/>),
    /// then the page's sequence, head and epoch (in its workspace, as the tenant filter reads), then
    /// the pages these update ids were already given to (any workspace).
    /// </summary>
    private async Task<(Head Head, List<Known> Known)> LockAndReadAsync(Page page, List<Guid> ids, CancellationToken ct)
    {
        await using var command = db.Database.GetDbConnection().CreateCommand();
        command.Transaction = db.Database.CurrentTransaction!.GetDbTransaction();
        command.Parameters.Add(new SqlParameter("@resource", System.Data.SqlDbType.NVarChar, 255) { Value = PageLocks.Resource(page.Id) });
        command.Parameters.Add(new SqlParameter("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(page.WorkspaceId) });
        command.Parameters.Add(new SqlParameter("@page", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(page.Id) });
        // The ids as one parameter, however many (hex in JSON, as ChangeLog.AddPagesAsync passes them).
        command.Parameters.Add(new SqlParameter("@ids", System.Data.SqlDbType.NVarChar, -1)
        {
            Value = System.Text.Json.JsonSerializer.Serialize(ids.Select(id => Convert.ToHexString(GuidBytes.ToBytes(id)))),
        });
        command.CommandText = """
            DECLARE @r int; EXEC @r = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 30000;
            SELECT @r;
            IF @r >= 0
            BEGIN
                SELECT [DocSeq], [DocHeadSeq], [DocEpoch] FROM [Pages] WHERE [WorkspaceId] = @ws AND [Id] = @page;
                SELECT [UpdateId], [Seq], [PageId] FROM [PageDocUpdates] WHERE [UpdateId] IN (SELECT CONVERT(binary(16), [value], 2) FROM OPENJSON(@ids));
            END
            """;
        await using var reader = await command.ExecuteReaderAsync(ct);
        var granted = await reader.ReadAsync(ct) ? reader.GetInt32(0) : -999;
        if (granted < 0) throw new InvalidOperationException($"The sequence lock of page {page.Id} was not granted ({granted})");
        await reader.NextResultAsync(ct);
        Head? head = null;
        while (await reader.ReadAsync(ct))
        {
            // As SingleAsync: exactly one.
            if (head is not null) throw new InvalidOperationException("Sequence contains more than one element");
            head = new Head(reader.GetInt64(0), reader.GetInt64(1), reader.GetInt32(2));
        }
        if (head is null) throw new InvalidOperationException("Sequence contains no elements");
        await reader.NextResultAsync(ct);
        var known = new List<Known>();
        while (await reader.ReadAsync(ct))
            known.Add(new Known(GuidBytes.FromBytes(reader.GetFieldValue<byte[]>(0)), reader.GetInt64(1), GuidBytes.FromBytes(reader.GetFieldValue<byte[]>(2))));
        return (head, known);
    }

    /// <summary>
    /// The new rows and the page's sequence moved to the last of them, in one batch (0.7.0: the
    /// rows saved, then the sequence; the same columns).
    /// </summary>
    private async Task InsertAsync(Page page, int epoch, long next, List<PageDocUpdate> rows, CancellationToken ct)
    {
        // A request may hold many small updates: a batch of at most 200 rows (8 parameters each,
        // under SQL Server's 2,100 a request); the sequence moves with the last.
        var chunks = rows.Chunk(200).ToList();
        for (var c = 0; c < chunks.Count; c++)
        {
            var parameters = new List<SqlParameter>
            {
                new("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(page.WorkspaceId) },
                new("@page", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(page.Id) },
            };
            var values = new List<string>();
            for (var i = 0; i < chunks[c].Length; i++)
            {
                var row = chunks[c][i];
                values.Add($"(@page, @s{i}, @id{i}, @ws, @e{i}, @user{i}, @device{i}, @data{i}, @v{i}, {UpdateStatus.Pending}, NULL, @at{i})");
                parameters.Add(new SqlParameter($"@s{i}", System.Data.SqlDbType.BigInt) { Value = row.Seq });
                parameters.Add(new SqlParameter($"@id{i}", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(row.UpdateId) });
                parameters.Add(new SqlParameter($"@e{i}", System.Data.SqlDbType.Int) { Value = row.Epoch });
                parameters.Add(new SqlParameter($"@user{i}", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(row.UserId) });
                parameters.Add(new SqlParameter($"@device{i}", System.Data.SqlDbType.Binary, 16) { Value = row.DeviceId is { } device ? GuidBytes.ToBytes(device) : DBNull.Value });
                parameters.Add(new SqlParameter($"@data{i}", System.Data.SqlDbType.VarBinary, -1) { Value = row.Data });
                parameters.Add(new SqlParameter($"@v{i}", System.Data.SqlDbType.Int) { Value = row.ClientSchemaVersion });
                parameters.Add(new SqlParameter($"@at{i}", System.Data.SqlDbType.DateTimeOffset) { Value = row.CreatedAt, Scale = 3 });
            }
            var sql = $"""
                INSERT INTO [PageDocUpdates] ([PageId], [Seq], [UpdateId], [WorkspaceId], [Epoch], [UserId], [DeviceId], [Data], [ClientSchemaVersion], [Status], [Problem], [CreatedAt])
                VALUES {string.Join(", ", values)};
                """;
            if (c == chunks.Count - 1)
            {
                parameters.Add(new SqlParameter("@next", System.Data.SqlDbType.BigInt) { Value = next });
                parameters.Add(new SqlParameter("@epoch", System.Data.SqlDbType.Int) { Value = epoch });
                sql += "\nUPDATE [Pages] SET [DocSeq] = @next WHERE [WorkspaceId] = @ws AND [Id] = @page AND [DocEpoch] = @epoch;";
            }
            await db.Database.ExecuteSqlRawAsync(sql, parameters, ct);
        }
    }

    public Task<PullResponse> PullAsync(Member member, Page page, long after, CancellationToken ct = default) =>
        PullAsync(member.UserId, page, after, ct);

    /// <summary>
    /// A pull for a reader: a member (whose own refused updates are listed) or a share link's
    /// anonymous reader (<paramref name="userId"/> null, so nothing is listed as refused).
    /// </summary>
    public async Task<PullResponse> PullAsync(Guid? userId, Page page, long after, CancellationToken ct = default)
    {
        after = Math.Max(0, after);
        var compactions = db.PageDocSnapshots.AsNoTracking()
            .Where(s => s.PageId == page.Id && s.Kind == SnapshotKinds.Compaction && s.Epoch == page.DocEpoch && s.Status == "ready");
        SnapshotRef? reference;
        long start;
        List<DocUpdateOut> rows;
        for (var attempt = 1; ; attempt++)
        {
            var snapshot = await compactions.OrderByDescending(s => s.UpToSeq).FirstOrDefaultAsync(ct);
            reference = null;
            start = after;
            if (snapshot is not null && after < snapshot.UpToSeq)
            {
                reference = new SnapshotRef(snapshot.UpToSeq, (await blob.ReadUrlAsync(snapshot.BlobKey, "application/octet-stream", ct: ct)).ToString());
                start = snapshot.UpToSeq;
            }
            var from = start;
            rows = await db.PageDocUpdates.AsNoTracking()
                .Where(u => u.PageId == page.Id && u.Seq > from && u.Seq <= page.DocHeadSeq && u.Status == UpdateStatus.Valid)
                .OrderBy(u => u.Seq).Take(MaxPull + 1)
                .Select(u => new DocUpdateOut(u.Seq, u.UpdateId, u.Data)).ToListAsync(ct);
            // A compaction that committed meanwhile removed rows this answer would have skipped
            // silently: answer from its snapshot instead.
            var newest = await compactions.MaxAsync(s => (long?)s.UpToSeq, ct) ?? 0;
            if (newest <= start || attempt == 3) break;
        }
        var more = rows.Count > MaxPull;
        if (more) rows.RemoveAt(rows.Count - 1);
        List<Guid> rejected = userId is not { } pusher
            ? []
            : await db.PageDocUpdates.AsNoTracking()
                .Where(u => u.PageId == page.Id && u.Seq > after && u.Status == UpdateStatus.Rejected && u.UserId == pusher)
                .Select(u => u.UpdateId).ToListAsync(ct);
        var cursor = more ? rows[^1].Seq : Math.Max(page.DocHeadSeq, reference?.UpToSeq ?? 0);
        return new PullResponse(page.DocEpoch, page.DocSchemaVersion, page.DocHeadSeq, cursor, more, reference, rows, rejected);
    }

    /// <summary>
    /// The state hash the worker stored for the page's validated head (Phase 3 contracts, section 2);
    /// a device whose own hash differs at the same head and epoch asks for a repair. The API never
    /// decodes Yjs: it serves what the worker wrote.
    /// </summary>
    public static StateHashResponse StateHash(Page page) =>
        new(page.DocEpoch, page.DocHeadSeq, page.DocStateHashSeq == page.DocHeadSeq ? page.DocStateHash : null);

    /// <summary>
    /// The repair path (SYNC_DESIGN.md, Repair): the device's full state, when it may edit, is stored
    /// as one pending update like any push (same checks: epoch, schema version, size, rate; the
    /// worker validates it, and what it already holds merges away), and the page comes back from
    /// the start, so the device gets whatever it lacked. Without an update it is only the pull.
    /// </summary>
    public async Task<Result<RepairResponse>> RepairAsync(Member member, Page page, bool canEdit, RepairRequest request, Guid? deviceId, CancellationToken ct = default)
    {
        DocAck? ack = null;
        if (request.Update is { } update)
        {
            if (!canEdit) return Failure.Denied("This page is read-only for you");
            var pushed = await PushAsync(member, page, new PushRequest(request.Epoch, request.ClientSchemaVersion, [update]), deviceId, MaxRequestBytes, ct);
            if (!pushed.Ok) return pushed.Failure!;
            ack = pushed.Value!.Acks[0];
        }
        return new RepairResponse(ack, await PullAsync(member, page, 0, ct));
    }

    /// <summary>The worker's derived JSON: the read-only view for a client older than the document.</summary>
    public async Task<DocJsonResponse?> JsonAsync(Page page, CancellationToken ct = default)
    {
        var derived = await db.PageDocDerived.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == page.Id, ct);
        if (derived is null) return null;
        return new DocJsonResponse(derived.UpToSeq, page.DocSchemaVersion, Gunzip(derived.Json));
    }

    public static byte[] Gzip(string text)
    {
        using var output = new MemoryStream();
        using (var zip = new GZipStream(output, CompressionLevel.Fastest))
            zip.Write(System.Text.Encoding.UTF8.GetBytes(text));
        return output.ToArray();
    }

    public static string Gunzip(byte[] bytes)
    {
        using var zip = new GZipStream(new MemoryStream(bytes), CompressionMode.Decompress);
        using var reader = new StreamReader(zip, System.Text.Encoding.UTF8);
        return reader.ReadToEnd();
    }

    /// <summary>
    /// Yjs client ids (Q9): the server issues a pool to a device, so ids are unique in the
    /// workspace; ids a device used before it synced are registered to its user, unless another
    /// user holds them. The worker refuses structs from ids not registered to the pusher.
    /// </summary>
    public async Task<YjsClientsResponse> ClientsAsync(Member member, Guid? deviceId, YjsClientsRequest request, CancellationToken ct = default)
    {
        var issue = Math.Clamp(request.Issue ?? 0, 0, 64);
        var register = (request.Register ?? []).Where(id => id is > 0 and <= uint.MaxValue).Distinct().Take(1000).ToList();
        var now = clock.GetUtcNow();
        var registered = new List<long>();
        var refused = new List<long>();
        if (register.Count > 0)
        {
            var holders = await db.YjsClients.Where(c => register.Contains(c.ClientId)).ToDictionaryAsync(c => c.ClientId, c => c.UserId, ct);
            foreach (var id in register)
            {
                if (holders.TryGetValue(id, out var holder))
                {
                    (holder == member.UserId ? registered : refused).Add(id);
                    continue;
                }
                db.YjsClients.Add(new YjsClient { WorkspaceId = member.WorkspaceId, ClientId = id, UserId = member.UserId, DeviceId = deviceId, Origin = "registered", CreatedAt = now });
                registered.Add(id);
            }
        }
        var issued = new List<long>();
        while (issued.Count < issue)
        {
            var candidates = Enumerable.Range(0, issue - issued.Count).Select(_ => (long)(RandomNumberGenerator.GetInt32(1, int.MaxValue) * 2L + RandomNumberGenerator.GetInt32(0, 2))).Distinct().ToList();
            var taken = await db.YjsClients.Where(c => candidates.Contains(c.ClientId)).Select(c => c.ClientId).ToListAsync(ct);
            foreach (var id in candidates.Except(taken).Except(register))
            {
                db.YjsClients.Add(new YjsClient { WorkspaceId = member.WorkspaceId, ClientId = id, UserId = member.UserId, DeviceId = deviceId, Origin = "issued", CreatedAt = now });
                issued.Add(id);
            }
        }
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // Two devices raced for an id: ask again.
            db.ChangeTracker.Clear();
            return await ClientsAsync(member, deviceId, request, ct);
        }
        return new YjsClientsResponse(issued, registered, refused);
    }
}

/// <summary>
/// A page's document sequence lock (<c>sp_getapplock</c>, to the end of the transaction): every
/// writer of <c>Pages.DocSeq</c> takes it, so numbers are given out and committed in order.
/// </summary>
public static class PageLocks
{
    public static string Resource(Guid pageId) => $"docseq:{pageId:N}";

    public static async Task SequenceAsync(CgwDb db, Guid pageId, CancellationToken ct)
    {
        var resource = Resource(pageId);
        var result = await db.Database.SqlQuery<int>(
            $"DECLARE @r int; EXEC @r = sp_getapplock @Resource = {resource}, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 30000; SELECT @r AS Value").ToListAsync(ct);
        if (result.Count != 1 || result[0] < 0) throw new InvalidOperationException($"The sequence lock of page {pageId} was not granted ({(result.Count == 1 ? result[0] : 0)})");
    }
}

internal sealed class StrongBox(int value)
{
    public int Value = value;
}
