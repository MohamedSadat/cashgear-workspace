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
        // Version 1's and the table of contents (an atom body with no attributes).
        [2] = ["block", "bookmark", "childPage", "codeBlock", "divider", "file", "hardBreak", "image", "pageMention", "table", "tableCell", "tableOfContents", "tableRow", "textBody"],
        // Version 2's, a database view (an atom body: databaseId, viewId) and a date mention (an
        // inline atom: date, end) (Phase 4).
        [3] = ["block", "bookmark", "childPage", "codeBlock", "databaseView", "dateMention", "divider", "file", "hardBreak", "image", "pageMention", "table", "tableCell", "tableOfContents", "tableRow", "textBody"],
        // Version 3's, a workbook embed (an atom body: workbookId, sheet, range, chartId, height)
        // and an ERP view (an atom body: linkId, connectorId, filter, fields, sort, pageSize)
        // (Phase 5).
        [4] = ["block", "bookmark", "childPage", "codeBlock", "databaseView", "dateMention", "divider", "erpView", "file", "hardBreak", "image", "pageMention", "sheetEmbed", "table", "tableCell", "tableOfContents", "tableRow", "textBody"],
    };

    /// <summary>The highest version this worker knows: a document may rise to it, never past it.</summary>
    public static int Latest { get; } = Elements.Keys.Max();

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

    /// <summary>
    /// The page's validated state, up to its head or, with <paramref name=upTo/>, up to that
    /// sequence (a version as it was named). Rows a compaction has since removed are in its snapshot,
    /// so a state up to an earlier point is built from the latest compaction at or before it. A
    /// compaction that commits while the rows are read has removed some of them: the read starts
    /// again from its snapshot (the jobs run on more than one loop).
    /// </summary>
    public async Task<byte[]> LoadAsync(CgwDb db, Page page, CancellationToken ct, long? upTo = null)
    {
        var head = upTo is { } point ? Math.Min(point, page.DocHeadSeq) : page.DocHeadSeq;
        if (cache.TryGetValue(page.Id, out var hit) && hit.Epoch == page.DocEpoch && hit.Head == head) return hit.State;
        var compactions = db.PageDocSnapshots.AsNoTracking()
            .Where(s => s.PageId == page.Id && s.Kind == SnapshotKinds.Compaction && s.Epoch == page.DocEpoch && s.Status == "ready");
        for (var attempt = 1; ; attempt++)
        {
            var known = await compactions.OrderBy(s => s.UpToSeq).Select(s => new { s.Id, s.UpToSeq, s.BlobKey }).ToListAsync(ct);
            var snapshot = known.LastOrDefault(s => s.UpToSeq <= head)
                // Only a later compaction is left (its rows are gone): the nearest state there is.
                ?? known.FirstOrDefault();
            var parts = new List<byte[]>();
            long from = 0;
            if (snapshot is not null)
            {
                var bytes = await blob.GetAsync(snapshot.BlobKey, ct);
                // A compaction since replaced it and deleted its blob: from the new one.
                if (bytes is null && attempt < 5 && await compactions.AnyAsync(s => s.UpToSeq > snapshot.UpToSeq, ct)) continue;
                parts.Add(bytes ?? throw new InvalidOperationException($"Snapshot {snapshot.Id} of page {page.Id} has no blob: run the reconcile job"));
                from = snapshot.UpToSeq;
            }
            parts.AddRange(await db.PageDocUpdates.AsNoTracking()
                .Where(u => u.PageId == page.Id && u.Seq > from && u.Seq <= head && u.Status == UpdateStatus.Valid)
                .OrderBy(u => u.Seq).Select(u => u.Data).ToListAsync(ct));
            var newest = await compactions.MaxAsync(s => (long?)s.UpToSeq, ct) ?? 0;
            if (newest != (known.Count > 0 ? known[^1].UpToSeq : 0) && attempt < 5) continue;
            var state = parts.Count switch
            {
                0 => Empty,
                1 => parts[0],
                _ => Yjs.Merge(parts),
            };
            if (head == page.DocHeadSeq) Put(page.Id, page.DocEpoch, head, state);
            return state;
        }
    }

    public void Put(Guid pageId, int epoch, long head, byte[] state)
    {
        if (cache.Count > 64) cache.Clear();
        cache[pageId] = (epoch, head, state);
    }

    public void Forget(Guid pageId) => cache.TryRemove(pageId, out _);
}
