using System.Collections.Concurrent;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker;

/// <summary>
/// The element names each document schema version knows, the same lists as
/// <c>packages/doc/vectors/schema-elements.json</c> (a test compares them). A pushed update that
/// brings any other element is refused before other clients receive it (Q20, S7).
/// </summary>
public static class Schema
{
    public static readonly IReadOnlyDictionary<int, string[]> Elements = new Dictionary<int, string[]>
    {
        [1] = ["block", "bookmark", "childPage", "codeBlock", "divider", "file", "hardBreak", "image", "pageMention", "table", "tableCell", "tableRow", "textBody"],
    };

    /// <summary>A version this worker does not know allows nothing new: its updates wait for a newer worker.</summary>
    public static string[]? For(int version) => Elements.TryGetValue(version, out var list) ? list : null;

    public const int MaxDocumentBytes = 10 * 1024 * 1024;
}

/// <summary>
/// A page's current state as one Yjs update: the newest compaction snapshot and the valid updates
/// after it, up to the validated head. Kept for the pages the worker touched last, so validating a
/// busy page does not reload it each time.
/// </summary>
public sealed class DocStates(BlobStore blob)
{
    private readonly ConcurrentDictionary<Guid, (int Epoch, long Head, byte[] State)> cache = new();
    public static readonly byte[] Empty = [0, 0];

    public async Task<byte[]> LoadAsync(CgwDb db, Page page, CancellationToken ct)
    {
        if (cache.TryGetValue(page.Id, out var hit) && hit.Epoch == page.DocEpoch && hit.Head == page.DocHeadSeq) return hit.State;
        var parts = new List<byte[]>();
        var snapshot = await db.PageDocSnapshots.AsNoTracking()
            .Where(s => s.PageId == page.Id && s.Kind == SnapshotKinds.Compaction && s.Epoch == page.DocEpoch && s.Status == "ready")
            .OrderByDescending(s => s.UpToSeq).FirstOrDefaultAsync(ct);
        long from = 0;
        if (snapshot is not null)
        {
            var bytes = await blob.GetAsync(snapshot.BlobKey, ct)
                ?? throw new InvalidOperationException($"Snapshot {snapshot.Id} of page {page.Id} has no blob: run the reconcile job");
            parts.Add(bytes);
            from = snapshot.UpToSeq;
        }
        parts.AddRange(await db.PageDocUpdates.AsNoTracking()
            .Where(u => u.PageId == page.Id && u.Seq > from && u.Seq <= page.DocHeadSeq && u.Status == UpdateStatus.Valid)
            .OrderBy(u => u.Seq).Select(u => u.Data).ToListAsync(ct));
        var state = parts.Count switch
        {
            0 => Empty,
            1 => parts[0],
            _ => Yjs.Merge(parts),
        };
        Put(page.Id, page.DocEpoch, page.DocHeadSeq, state);
        return state;
    }

    public void Put(Guid pageId, int epoch, long head, byte[] state)
    {
        if (cache.Count > 64) cache.Clear();
        cache[pageId] = (epoch, head, state);
    }

    public void Forget(Guid pageId) => cache.TryRemove(pageId, out _);
}
