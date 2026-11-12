using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Sync;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Validation before fan-out (Q20; SYNC_DESIGN.md, What the server checks). For each page with
/// pushed updates still pending, in sequence order: the update must decode; every struct in it
/// must be written as a Yjs client id registered to the pushing user; the document after it must
/// hold only the schema version's elements, well-formed block ids and safe link schemes, keep its
/// page id and schema version, and stay under 10 MB. A failing update is refused (its pusher sees
/// it in their next pull); the page's validated head then moves, so pulls serve what passed.
/// </summary>
public sealed class ValidateJob(DocStates states, ILogger<ValidateJob> logger) : IJob
{
    public string Name => "validate";
    public TimeSpan Interval => TimeSpan.FromMilliseconds(100);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var pages = await db.PageDocUpdates.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(u => u.Status == UpdateStatus.Pending)
            .GroupBy(u => new { u.PageId, u.WorkspaceId })
            .Select(g => new { g.Key.PageId, g.Key.WorkspaceId, First = g.Min(u => u.CreatedAt) })
            .OrderBy(g => g.First).Take(20).ToListAsync(ct);
        foreach (var page in pages)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(page.WorkspaceId);
            await ValidatePageAsync(services, db, page.PageId, ct);
        }
        return pages.Count == 20;
    }

    private async Task ValidatePageAsync(IServiceProvider services, CgwDb db, Guid pageId, CancellationToken ct)
    {
        var page = await db.Pages.AsNoTracking().FirstAsync(p => p.Id == pageId, ct);
        var rows = await db.PageDocUpdates.AsNoTracking().Where(u => u.PageId == pageId && u.Status == UpdateStatus.Pending)
            .OrderBy(u => u.Seq).Take(500).ToListAsync(ct);
        if (rows.Count == 0) return;
        var state = await states.LoadAsync(db, page, ct);
        var users = rows.Select(r => r.UserId).Distinct().ToList();
        var clients = (await db.YjsClients.AsNoTracking().Where(c => users.Contains(c.UserId)).ToListAsync(ct))
            .GroupBy(c => c.UserId).ToDictionary(g => g.Key, g => g.Select(c => (ulong)c.ClientId).ToHashSet());
        var elements = Schema.For(page.DocSchemaVersion);
        var verdicts = new Dictionary<long, List<string>>();
        var forged = new List<PageDocUpdate>();

        // Each update's own checks; then, if all pass, the whole batch in one merge.
        foreach (var row in rows)
        {
            var problems = verdicts[row.Seq] = [];
            if (page.DeletedAt is not null) problems.Add("the page was deleted");
            else if (elements is null) problems.Add($"schema version {page.DocSchemaVersion} is newer than this worker");
            else if (row.Epoch != page.DocEpoch) problems.Add($"epoch {row.Epoch}, the page is at {page.DocEpoch}");
            else
            {
                try
                {
                    var mine = clients.GetValueOrDefault(row.UserId) ?? [];
                    foreach (var range in Yjs.ClientRanges(row.Data).Ranges)
                        if (!mine.Contains(range.Client))
                            problems.Add($"writes as Yjs client {range.Client}, which is not registered to the pusher");
                    if (problems.Count > 0) forged.Add(row);
                }
                catch (YdocException e)
                {
                    problems.Add($"does not decode: {e.Message}");
                }
            }
        }
        var policy = new ValidationPolicy([], elements ?? [], DocService.MaxUpdateBytes, true);
        var passing = rows.Where(r => verdicts[r.Seq].Count == 0).ToList();
        var batchPassed = false;
        if (passing.Count == rows.Count && rows.Count > 1)
        {
            try
            {
                var combined = Yjs.Merge(rows.Select(r => r.Data).ToList());
                var merged = Yjs.Merge([state, combined]);
                if (Yjs.Validate(state, combined, policy with { MaxBytes = 0 }).Count == 0 && DocumentProblems(page, merged).Count == 0)
                {
                    state = merged;
                    batchPassed = true;
                }
            }
            catch (YdocException)
            {
                // One at a time, below, says which.
            }
        }
        if (!batchPassed)
            foreach (var row in passing)
            {
                var problems = verdicts[row.Seq];
                try
                {
                    problems.AddRange(Yjs.Validate(state, row.Data, policy));
                    if (problems.Count == 0)
                    {
                        var merged = Yjs.Merge([state, row.Data]);
                        problems.AddRange(DocumentProblems(page, merged));
                        if (problems.Count == 0) state = merged;
                    }
                }
                catch (YdocException e)
                {
                    problems.Add($"does not decode: {e.Message}");
                }
            }

        var head = rows[^1].Seq;
        var changes = services.GetRequiredService<ChangeLog>();
        var audit = services.GetRequiredService<Audit>();
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            // The workspace row first, then the page's: the order every writer takes them in.
            await changes.LockAsync(page.WorkspaceId, ct);
            foreach (var (seq, problems) in verdicts)
            {
                var status = problems.Count == 0 ? UpdateStatus.Valid : UpdateStatus.Rejected;
                var text = problems.Count == 0 ? null : Trim(string.Join("; ", problems));
                await db.PageDocUpdates.Where(u => u.PageId == pageId && u.Seq == seq && u.Status == UpdateStatus.Pending)
                    .ExecuteUpdateAsync(s => s.SetProperty(u => u.Status, status).SetProperty(u => u.Problem, text), ct);
            }
            await db.Pages.Where(p => p.Id == pageId && p.DocHeadSeq < head).ExecuteUpdateAsync(s => s.SetProperty(p => p.DocHeadSeq, head), ct);
            // Clients holding the page pull it when the feed says its head moved.
            changes.Add("page", pageId, "upsert", page.Version, null);
            foreach (var row in forged)
                audit.Add(new Actor(row.UserId, null, null), "doc.forgedClient", page.WorkspaceId, "page", pageId, new { row.Seq, row.UpdateId });
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        }
        states.Put(pageId, page.DocEpoch, head, state);
        var refused = verdicts.Count(v => v.Value.Count > 0);
        if (refused > 0) logger.LogWarning("Refused {Count} of {Total} updates to page {Page}", refused, rows.Count, pageId);
    }

    /// <summary>What the whole document must keep: its page, its schema version, its size.</summary>
    private static List<string> DocumentProblems(Page page, byte[] merged)
    {
        var problems = new List<string>();
        if (merged.Length > Schema.MaxDocumentBytes) problems.Add("the document would be over 10 MB");
        using var meta = JsonDocument.Parse(Yjs.Meta(merged));
        if (meta.RootElement.TryGetProperty("pageId", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() != page.Id.ToString())
            problems.Add("the document names another page");
        if (meta.RootElement.TryGetProperty("schemaVersion", out var version) && version.ValueKind == JsonValueKind.Number
            && version.GetDouble() > page.DocSchemaVersion)
            problems.Add("the document claims a newer schema version than the page has");
        return problems;
    }

    private static string Trim(string text) => text.Length > 2000 ? text[..2000] : text;
}

/// <summary>Points where a test stops compaction, to prove a crash at each step loses nothing.</summary>
public interface ICompactionFaults
{
    void AfterBlobWritten(Guid pageId);
    void AfterCommit(Guid pageId);
}

public sealed class NoFaults : ICompactionFaults
{
    public void AfterBlobWritten(Guid pageId) { }
    public void AfterCommit(Guid pageId) { }
}

/// <summary>
/// Compaction snapshots (SYNC_DESIGN.md, Version history): after 200 decided updates, or once the
/// oldest is 10 minutes old. In an order a crash cannot break: write the new blob; then, in one
/// transaction, point the page at it and delete the update rows it covers; then delete the older
/// snapshot's blob. One compactor per page, under an application lock.
/// </summary>
public sealed class CompactJob(DocStates states, BlobStore blob, ICompactionFaults faults, TimeProvider clock) : IJob
{
    public string Name => "compact";
    public TimeSpan Interval => TimeSpan.FromSeconds(2);
    public static int AfterUpdates { get; set; } = 200;
    public static TimeSpan AfterAge { get; set; } = TimeSpan.FromMinutes(10);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var old = clock.GetUtcNow() - AfterAge;
        var due = await db.PageDocUpdates.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(u => u.Status != UpdateStatus.Pending)
            .GroupBy(u => new { u.PageId, u.WorkspaceId })
            .Select(g => new { g.Key.PageId, g.Key.WorkspaceId, Count = g.Count(), First = g.Min(u => u.CreatedAt) })
            .Where(g => g.Count > AfterUpdates || g.First < old)
            .Take(10).ToListAsync(ct);
        foreach (var page in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(page.WorkspaceId);
            await CompactAsync(db, page.PageId, ct);
        }
        return due.Count == 10;
    }

    public async Task CompactAsync(CgwDb db, Guid pageId, CancellationToken ct)
    {
        var page = await db.Pages.AsNoTracking().FirstAsync(p => p.Id == pageId, ct);
        if (page.DocHeadSeq == 0 || page.DeletedAt is not null) return;
        var state = Yjs.Compact(await states.LoadAsync(db, page, ct));
        var snapshot = new PageDocSnapshot
        {
            Id = Guid.CreateVersion7(),
            PageId = pageId,
            WorkspaceId = page.WorkspaceId,
            Epoch = page.DocEpoch,
            UpToSeq = page.DocHeadSeq,
            SizeBytes = state.Length,
            Kind = SnapshotKinds.Compaction,
            Status = "ready",
            CreatedAt = clock.GetUtcNow(),
        };
        snapshot.BlobKey = BlobStore.SnapshotKey(page.WorkspaceId, pageId, snapshot.Id);
        await blob.PutAsync(snapshot.BlobKey, state, "application/octet-stream", ct);
        faults.AfterBlobWritten(pageId);

        List<PageDocSnapshot> older;
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            // A hard restore holds the same lock; one that committed since the state was read moved
            // the epoch, and this snapshot of the old one must not replace the restored state.
            if (!await AppLock.TryAsync(db, $"compact:{pageId}", ct)
                || await db.Pages.Where(p => p.Id == pageId).Select(p => p.DocEpoch).SingleAsync(ct) != page.DocEpoch)
            {
                await tx.RollbackAsync(ct);
                await blob.DeleteAsync(snapshot.BlobKey, ct);
                return;
            }
            db.PageDocSnapshots.Add(snapshot);
            await db.SaveChangesAsync(ct);
            var upTo = snapshot.UpToSeq;
            await db.PageDocUpdates.Where(u => u.PageId == pageId && u.Seq <= upTo && u.Status != UpdateStatus.Pending).ExecuteDeleteAsync(ct);
            older = await db.PageDocSnapshots.Where(s => s.PageId == pageId && s.Kind == SnapshotKinds.Compaction && s.Id != snapshot.Id && s.UpToSeq <= upTo).ToListAsync(ct);
            db.PageDocSnapshots.RemoveRange(older);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        faults.AfterCommit(pageId);
        foreach (var previous in older) await blob.DeleteAsync(previous.BlobKey, ct);
        states.Put(pageId, page.DocEpoch, page.DocHeadSeq, state);
    }
}

/// <summary>
/// The derived JSON and text of every page (DATA_MODEL.md, PageDocDerived): the read-only view,
/// server search's normalised text, backlinks and asset references, kept within seconds of edits.
/// </summary>
public sealed class DeriveJob(DocStates states, TimeProvider clock) : IJob
{
    public string Name => "derive";
    public TimeSpan Interval => TimeSpan.FromMilliseconds(500);
    public static TimeSpan Settle { get; set; } = TimeSpan.FromSeconds(2);
    private static readonly string[] Filters = [CgwDb.Tenant];

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var settled = clock.GetUtcNow() - Settle;
        var derived = db.PageDocDerived.IgnoreQueryFilters(Filters);
        var due = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.DocHeadSeq > 0 && p.DeletedAt == null)
            .Where(p => !derived.Any(d => d.PageId == p.Id && (d.UpToSeq >= p.DocHeadSeq || d.UpdatedAt > settled)))
            .Select(p => new { p.Id, p.WorkspaceId }).Take(20).ToListAsync(ct);
        foreach (var page in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(page.WorkspaceId);
            await DeriveAsync(db, page.Id, ct);
        }
        return due.Count == 20;
    }

    public async Task DeriveAsync(CgwDb db, Guid pageId, CancellationToken ct)
    {
        var page = await db.Pages.AsNoTracking().FirstAsync(p => p.Id == pageId, ct);
        var state = await states.LoadAsync(db, page, ct);
        var json = Yjs.ToJson(state);
        var text = Yjs.ToText(state);
        var (pages, assets) = Outgoing(json);
        var derived = await db.PageDocDerived.FirstOrDefaultAsync(d => d.PageId == pageId, ct);
        if (derived is null) db.PageDocDerived.Add(derived = new PageDocDerived { PageId = pageId, WorkspaceId = page.WorkspaceId });
        derived.UpToSeq = page.DocHeadSeq;
        derived.Json = DocService.Gzip(json);
        derived.PlainText = text.Length > 1_000_000 ? text[..1_000_000] : text;
        derived.SearchText = TextNormaliser.Normalise(derived.PlainText);
        derived.Outgoing = JsonSerializer.Serialize(new { pages, assets });
        derived.UpdatedAt = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await db.SaveChangesAsync(ct);
        await db.PageLinks.Where(l => l.FromPageId == pageId).ExecuteDeleteAsync(ct);
        db.PageLinks.AddRange(pages.Where(id => id != pageId).Select(id => new PageLink { FromPageId = pageId, ToPageId = id, WorkspaceId = page.WorkspaceId }));
        var held = await db.AssetRefs.Where(r => r.PageId == pageId).Select(r => r.AssetId).ToListAsync(ct);
        var known = await db.Assets.Where(a => assets.Contains(a.Id)).Select(a => a.Id).ToListAsync(ct);
        await db.AssetRefs.Where(r => r.PageId == pageId && !known.Contains(r.AssetId)).ExecuteDeleteAsync(ct);
        db.AssetRefs.AddRange(known.Except(held).Select(id => new AssetRef { AssetId = id, PageId = pageId, WorkspaceId = page.WorkspaceId }));
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>The ids a document holds: pages it links to and assets it shows (DATA_MODEL.md, D6).</summary>
    public static (List<Guid> Pages, List<Guid> Assets) Outgoing(string json)
    {
        var pages = new HashSet<Guid>();
        var assets = new HashSet<Guid>();
        void Walk(JsonElement node, int depth)
        {
            if (depth > 250 || node.ValueKind != JsonValueKind.Object) return;
            var type = node.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (node.TryGetProperty("attrs", out var attrs) && attrs.ValueKind == JsonValueKind.Object)
            {
                if (type is "childPage" or "pageMention" && attrs.TryGetProperty("pageId", out var p) && Guid.TryParse(p.GetString(), out var pageId))
                    pages.Add(pageId);
                if (type is "image" or "file" && attrs.TryGetProperty("assetId", out var a) && Guid.TryParse(a.GetString(), out var assetId))
                    assets.Add(assetId);
            }
            if (node.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                foreach (var child in content.EnumerateArray()) Walk(child, depth + 1);
        }
        using var document = JsonDocument.Parse(json);
        Walk(document.RootElement, 0);
        return (pages.ToList(), assets.ToList());
    }
}

/// <summary><c>sp_getapplock</c> for the current transaction: one holder at a time, no waiting.</summary>
public static class AppLock
{
    public static async Task<bool> TryAsync(CgwDb db, string resource, CancellationToken ct)
    {
        var result = await db.Database.SqlQuery<int>(
            $"DECLARE @r int; EXEC @r = sp_getapplock @Resource = {resource}, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0; SELECT @r AS Value").ToListAsync(ct);
        return result.Count == 1 && result[0] >= 0;
    }
}
