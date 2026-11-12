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
        var count = cache.GetOrCreate(("push", page.Id, clock.GetUtcNow().ToUnixTimeSeconds() / 60), e =>
        {
            e.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2);
            return new StrongBox(0);
        })!;
        if (Interlocked.Add(ref count.Value, request.Updates.Count) > PerPagePerMinute) return new Failure(Codes.LimitRate, 429, "Too many updates to this page");

        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async Task<Result<PushResponse>> () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            // The page row's lock, held to the commit: the next numbers are this push's alone.
            await db.Pages.Where(p => p.Id == page.Id).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSeq, p => p.DocSeq), ct);
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
                    Status = UpdateStatus.Pending,
                    CreatedAt = now,
                });
            }
            if (next != head.DocSeq)
            {
                await db.SaveChangesAsync(ct);
                var value = next;
                await db.Pages.Where(p => p.Id == page.Id).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocSeq, value), ct);
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
        var snapshot = await db.PageDocSnapshots.AsNoTracking()
            .Where(s => s.PageId == page.Id && s.Kind == SnapshotKinds.Compaction && s.Epoch == page.DocEpoch && s.Status == "ready")
            .OrderByDescending(s => s.UpToSeq).FirstOrDefaultAsync(ct);
        SnapshotRef? reference = null;
        var start = after;
        if (snapshot is not null && after < snapshot.UpToSeq)
        {
            reference = new SnapshotRef(snapshot.UpToSeq, (await blob.ReadUrlAsync(snapshot.BlobKey, "application/octet-stream", ct: ct)).ToString());
            start = snapshot.UpToSeq;
        }
        var rows = await db.PageDocUpdates.AsNoTracking()
            .Where(u => u.PageId == page.Id && u.Seq > start && u.Seq <= page.DocHeadSeq && u.Status == UpdateStatus.Valid)
            .OrderBy(u => u.Seq).Take(MaxPull + 1)
            .Select(u => new DocUpdateOut(u.Seq, u.UpdateId, u.Data)).ToListAsync(ct);
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

internal sealed class StrongBox(int value)
{
    public int Value = value;
}
