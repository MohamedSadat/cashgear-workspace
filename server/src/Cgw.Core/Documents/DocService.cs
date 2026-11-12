using IsolationLevel = System.Data.IsolationLevel;
using System.IO.Compression;
using System.Security.Cryptography;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;
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
    /// <summary>Updates per minute to one page, from everyone (SYNC_DESIGN.md, What the server checks).</summary>
    public const int PerPagePerMinute = 1200;

    public async Task<Result<PushResponse>> PushAsync(Member member, Page page, PushRequest request, Guid? deviceId, CancellationToken ct = default)
    {
        if (request.Epoch != page.DocEpoch) return Failure.Conflict(Codes.DocEpochMismatch, $"The page's document is at epoch {page.DocEpoch}");
        if (request.ClientSchemaVersion < page.DocSchemaVersion) return new Failure(Codes.ClientTooOld, 426, "The document needs a newer version of the app");
        if (request.Updates is null || request.Updates.Count == 0) return Failure.Invalid("No updates");
        if (request.Updates.Any(u => u.Data is null || u.Data.Length == 0)) return Failure.Invalid("An update is empty");
        if (request.Updates.Any(u => u.Data.Length > MaxUpdateBytes)) return new Failure(Codes.LimitSize, 413, "An update is over 1 MB");
        if (request.Updates.Sum(u => (long)u.Data.Length) > MaxRequestBytes) return new Failure(Codes.LimitSize, 413, "The updates are over 4 MB together");
        var second = clock.GetUtcNow().ToUnixTimeSeconds();
        var count = cache.GetOrCreate(("push", page.Id, second / 60), e =>
        {
            e.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2);
            return new StrongBox(0);
        })!;
        // The next minute's window is open to it.
        if (Interlocked.Add(ref count.Value, request.Updates.Count) > PerPagePerMinute)
            return new Failure(Codes.LimitRate, 429, "Too many updates to this page") { RetryAfter = TimeSpan.FromSeconds(60 - second % 60) };

        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async Task<Result<PushResponse>> () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            // The page's sequence lock, held to the commit: the next numbers are this push's alone,
            // and pushes commit in sequence order (D15, S8). Not the page row: the worker moves the
            // validated head on that row, and pushes now hold it only for their last statement.
            await PageLocks.SequenceAsync(db, page.Id, ct);
            var head = await db.Pages.Where(p => p.Id == page.Id).Select(p => new { p.DocSeq, p.DocHeadSeq, p.DocEpoch }).SingleAsync(ct);
            if (head.DocEpoch != request.Epoch) return Failure.Conflict(Codes.DocEpochMismatch, $"The page's document is at epoch {head.DocEpoch}");
            var ids = request.Updates.Select(u => u.UpdateId).Distinct().ToList();
            var known = await db.PageDocUpdates.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .Where(u => ids.Contains(u.UpdateId)).Select(u => new { u.UpdateId, u.Seq, u.PageId }).ToListAsync(ct);
            if (known.Any(k => k.PageId != page.Id)) return Failure.Invalid("An update id is already used for another page");
            var seqs = known.ToDictionary(k => k.UpdateId, k => k.Seq);
            var next = head.DocSeq;
            var now = clock.GetUtcNow();
            foreach (var update in request.Updates)
            {
                // A repeat (a lost answer) is answered with the number it was given the first time.
                if (seqs.ContainsKey(update.UpdateId)) continue;
                seqs[update.UpdateId] = ++next;
                db.PageDocUpdates.Add(new PageDocUpdate
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
            if (next != head.DocSeq)
            {
                await db.SaveChangesAsync(ct);
                var (value, epoch) = (next, head.DocEpoch);
                await db.Pages.Where(p => p.Id == page.Id && p.DocEpoch == epoch).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSeq, value), ct);
            }
            await tx.CommitAsync(ct);
            return new PushResponse(request.Updates.Select(u => new DocAck(u.UpdateId, seqs[u.UpdateId])).DistinctBy(a => a.UpdateId).ToList(), head.DocHeadSeq);
        });
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
            var pushed = await PushAsync(member, page, new PushRequest(request.Epoch, request.ClientSchemaVersion, [update]), deviceId, ct);
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
    public static async Task SequenceAsync(CgwDb db, Guid pageId, CancellationToken ct)
    {
        var resource = $"docseq:{pageId:N}";
        var result = await db.Database.SqlQuery<int>(
            $"DECLARE @r int; EXEC @r = sp_getapplock @Resource = {resource}, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 30000; SELECT @r AS Value").ToListAsync(ct);
        if (result.Count != 1 || result[0] < 0) throw new InvalidOperationException($"The sequence lock of page {pageId} was not granted ({(result.Count == 1 ? result[0] : 0)})");
    }
}

internal sealed class StrongBox(int value)
{
    public int Value = value;
}
