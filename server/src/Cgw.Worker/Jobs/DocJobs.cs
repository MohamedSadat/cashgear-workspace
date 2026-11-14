using System.Text.Json;
using Cgw.Core;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Notifications;
using Cgw.Core.Sync;
using Cgw.Ydoc;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;
using SqlDbType = System.Data.SqlDbType;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Validation before fan-out (Q20; SYNC_DESIGN.md, What the server checks). For each page with
/// pushed updates still pending, in sequence order: the update must decode; every struct it adds
/// to the page's state must be written as a Yjs client id registered to the pushing user (what the
/// server holds already, such as a repair's whole state, is nothing new); the document after it
/// must hold only its schema version's elements, well-formed block ids and safe link schemes, keep
/// its page id, claim no schema version past what its app and this worker know, and stay under 10 MB;
/// and its pusher must still be able to edit the page when it is decided, so a push that passed
/// the API's check just before access was taken away is not served. A failing update is refused
/// (its pusher sees it in their next pull); the page's validated head then moves, with its state
/// hash and schema version, so pulls serve what passed.
///
/// A pass reads what a workspace's pending pages need together (their rows, their updates, the
/// pushers' Yjs clients and access) and decides them with nothing locked; the workspace's lock is
/// held only to write the decisions: each page's head, a bulk status update, a feed change. Access
/// is read with the feed's head beside it; under the lock, if an access, member or workspace change
/// has committed since (every change to who may edit takes this lock and writes one), the pushers
/// are checked again, so the check stays exact while the lock stays short.
/// </summary>
public sealed class ValidateJob(DocStates states, ILogger<ValidateJob> logger) : IJob
{
    public string Name => "validate";
    /// <summary>Every 25 ms when idle (Phase 6): a push reaches the other editors well within 300 ms.</summary>
    public TimeSpan Interval => TimeSpan.FromMilliseconds(25);
    /// <summary>On a loop of its own: a long derive or export never holds an edit back from others.</summary>
    public bool OwnLoop => true;
    private const int Batch = 50;
    /// <summary>Pending updates read in one pass for a workspace's pages, and at most per page.</summary>
    private const int RowsPerPass = 5000;
    private const int RowsPerPage = 500;
    /// <summary>Pages written in one transaction, which holds their workspace's lock.</summary>
    public static int PagesPerCommit { get; set; } = 25;
    /// <summary>Workspaces validated at once.</summary>
    public static int Parallelism { get; set; } = 8;
    /// <summary>How long a workspace's remembered editors are used before they are read again whole.</summary>
    private const long EditorsKeptMs = 10 * 60 * 1000;
    /// <summary>Answers remembered for one workspace at most.</summary>
    private const int EditorsKeptMax = 50_000;

    /// <summary>
    /// Who may edit, per workspace, as last read: each page and pusher's answer, and the feed's head
    /// they hold at. Every change to who may edit writes an access, member or workspace change (the
    /// recheck under the lock rests on the same rule), so while none has committed since, the
    /// answers stand, and one query replaces the four that read them.
    /// </summary>
    private sealed class Editors
    {
        public long At;
        public long ReadAt;
        public readonly Dictionary<(Guid Page, Guid User), bool> Answers = [];
    }

    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, Editors> editors = new();

    /// <summary>What was decided for one page, to be written under the lock.</summary>
    private sealed class Decision(Page page, List<PageDocUpdate> rows, HashSet<Guid> editors)
    {
        public Page Page { get; } = page;
        public List<PageDocUpdate> Rows { get; } = rows;
        public long Head => Rows[^1].Seq;
        public HashSet<Guid> Users { get; } = rows.Select(r => r.UserId).ToHashSet();
        public HashSet<Guid> Editors { get; } = editors;
        public Dictionary<long, List<string>> Verdicts { get; } = [];
        public List<PageDocUpdate> Forged { get; } = [];
        public List<PageDocUpdate> Denied { get; } = [];
        public byte[] State { get; set; } = DocStates.Empty;
        public int SchemaVersion { get; set; }
        public string? Hash { get; set; }
    }

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var pages = await db.PageDocUpdates.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(u => u.Status == UpdateStatus.Pending)
            .GroupBy(u => new { u.PageId, u.WorkspaceId })
            .Select(g => new { g.Key.PageId, g.Key.WorkspaceId, First = g.Min(u => u.CreatedAt) })
            .OrderBy(g => g.First).Take(Batch).ToListAsync(ct);
        // Workspaces side by side, each in a scope of its own; a workspace's pages a few at a time
        // (their writes take its lock in turn).
        var work = pages.GroupBy(p => p.WorkspaceId)
            .Select(w => (Workspace: w.Key, Chunks: w.Chunk(PagesPerCommit).Select(c => c.Select(p => p.PageId).ToList()).ToList()))
            .ToList();
        var scopes = services.GetRequiredService<IServiceScopeFactory>();
        var again = false;
        await Parallel.ForEachAsync(work, new ParallelOptions { MaxDegreeOfParallelism = Parallelism, CancellationToken = ct }, async (workspace, token) =>
        {
            await using var scope = scopes.CreateAsyncScope();
            var own = scope.ServiceProvider.GetRequiredService<CgwDb>();
            foreach (var chunk in workspace.Chunks)
            {
                own.ChangeTracker.Clear();
                own.Scope.Switch(workspace.Workspace);
                // A page left for later (decided elsewhere meanwhile, or access changed) is due now.
                if (!await ValidateAsync(scope.ServiceProvider, own, workspace.Workspace, chunk, token)) again = true;
            }
        });
        // Pushes that came while this pass ran are due now: under load the passes run back to back.
        return pages.Count > 0 || again;
    }

    /// <summary>Decides and writes these pages; false when one was left for the next pass.</summary>
    private async Task<bool> ValidateAsync(IServiceProvider services, CgwDb db, Guid workspaceId, List<Guid> pageIds, CancellationToken ct)
    {
        // The feed's head before access is read: whatever changes access after it has a higher number.
        var seen = await db.Workspaces.AsNoTracking().Where(w => w.Id == workspaceId).Select(w => (long?)w.ChangeSeq).FirstOrDefaultAsync(ct);
        if (seen is null) return true;
        var pages = await db.Pages.AsNoTracking().Where(p => pageIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, ct);
        // A prefix of each page's pending updates, by sequence: in one read, or one a page when a
        // backlog is too long for that (so no page waits behind another's).
        var all = await db.PageDocUpdates.AsNoTracking().Where(u => pageIds.Contains(u.PageId) && u.Status == UpdateStatus.Pending)
            .OrderBy(u => u.PageId).ThenBy(u => u.Seq).Take(RowsPerPass + 1).ToListAsync(ct);
        if (all.Count > RowsPerPass)
        {
            all.Clear();
            foreach (var pageId in pageIds)
                all.AddRange(await db.PageDocUpdates.AsNoTracking().Where(u => u.PageId == pageId && u.Status == UpdateStatus.Pending)
                    .OrderBy(u => u.Seq).Take(RowsPerPage).ToListAsync(ct));
        }
        var pending = all.GroupBy(u => u.PageId).Where(g => pages.ContainsKey(g.Key))
            .ToDictionary(g => g.Key, g => g.Take(RowsPerPage).ToList());
        if (pending.Count == 0) return true;
        var users = pending.Values.SelectMany(rows => rows.Select(r => r.UserId)).Distinct().ToList();
        var clients = (await db.YjsClients.AsNoTracking().Where(c => users.Contains(c.UserId)).ToListAsync(ct))
            .GroupBy(c => c.UserId).ToDictionary(g => g.Key, g => g.Select(c => (ulong)c.ClientId).ToHashSet());
        var access = new Access(db);
        var pushers = Pushers(pending.Where(p => pages[p.Key].DeletedAt is null).Select(p => (p.Key, p.Value)));
        var editors = await EditorsAsync(db, access, workspaceId, seen.Value, pushers, ct);
        var decisions = new List<Decision>();
        foreach (var (pageId, rows) in pending)
            decisions.Add(await DecideAsync(db, new Decision(pages[pageId], rows, editors.GetValueOrDefault(pageId) ?? []), clients, ct));

        var changes = services.GetRequiredService<ChangeLog>();
        var audit = services.GetRequiredService<Audit>();
        var written = new List<Decision>();
        await using (var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct))
        {
            // The workspace row first, then the pages': the order every writer takes them in.
            await changes.LockAsync(workspaceId, ct);
            // Access changed since it was read: the pushers again, now that no change can land
            // before the commit; a page whose answer differs is decided again on the next pass.
            var recheck = await changes.AccessChangedSinceAsync(seen.Value, ct)
                ? await access.EditorsAsync(workspaceId, Pushers(decisions.Where(d => d.Page.DeletedAt is null).Select(d => (d.Page.Id, d.Rows))), ct)
                : null;
            // What was remembered is out of date: read again whole on the next pass.
            if (recheck is not null) Forget(workspaceId);
            // The pages as they are now: a hard restore or a delete for good since they were read
            // (each under this lock) leaves the page to the next pass.
            var ids = decisions.Select(d => d.Page.Id).ToList();
            var current = await db.Pages.AsNoTracking().Where(p => ids.Contains(p.Id))
                .Select(p => new { p.Id, p.DocEpoch, p.DocHeadSeq, Live = p.DeletedAt == null }).ToDictionaryAsync(p => p.Id, ct);
            foreach (var decision in decisions)
            {
                var page = decision.Page;
                if (!current.TryGetValue(page.Id, out var now) || now.DocEpoch != page.DocEpoch || now.DocHeadSeq != page.DocHeadSeq
                    || now.Live != (page.DeletedAt is null))
                    continue;
                if (recheck is not null && page.DeletedAt is null && !(recheck.GetValueOrDefault(page.Id) ?? []).SetEquals(decision.Editors)) continue;
                written.Add(decision);
                // Clients holding the page pull it when the feed says its head moved.
                changes.Add("page", page.Id, "upsert", page.Version, null);
                foreach (var row in decision.Forged)
                    audit.Add(new Actor(row.UserId, null, null), "doc.forgedClient", workspaceId, "page", page.Id, new { row.Seq, row.UpdateId });
                foreach (var row in decision.Denied)
                    audit.Add(new Actor(row.UserId, null, null), "doc.accessDenied", workspaceId, "page", page.Id, new { row.Seq, row.UpdateId });
            }
            if (written.Count > 0)
            {
                await RejectAsync(db, written, ct);
                await db.SaveChangesAsync(ct);
                await changes.FlushAsync(ct);
                // The rows' statuses and then the pages' heads in one batch: the pages' rows last,
                // held only to the commit, so pushes to them wait on nothing else.
                await WriteAsync(db, written, ct);
            }
            await tx.CommitAsync(ct);
        }
        foreach (var decision in written)
        {
            states.Put(decision.Page.Id, decision.Page.DocEpoch, decision.Head, decision.State);
            var refused = decision.Verdicts.Count(v => v.Value.Count > 0);
            if (refused > 0) logger.LogWarning("Refused {Count} of {Total} updates to page {Page}", refused, decision.Rows.Count, decision.Page.Id);
        }
        return written.Count == decisions.Count;
    }

    /// <summary>
    /// Who of these pushers may edit each page, as of <paramref name="seen"/> (read before this):
    /// the answers remembered for the workspace when no change to who may edit has committed since
    /// they were read, else read again; only pairs not asked before are read.
    /// </summary>
    private async Task<Dictionary<Guid, HashSet<Guid>>> EditorsAsync(CgwDb db, Access access, Guid workspaceId, long seen,
        Dictionary<Guid, HashSet<Guid>> pushers, CancellationToken ct)
    {
        var kept = editors.GetOrAdd(workspaceId, _ => new Editors());
        long at;
        lock (kept) at = kept.At;
        var now = Environment.TickCount64;
        // A change committed after the answers were read (seen was read before this asks, so any
        // change up to it is visible here, and one after it the recheck under the lock catches).
        var stale = at == 0 || now - kept.ReadAt > EditorsKeptMs || await ChangeLog.AccessChangedAsync(db, workspaceId, at, ct);
        Dictionary<Guid, HashSet<Guid>> missing;
        lock (kept)
        {
            if (stale || kept.Answers.Count > EditorsKeptMax)
            {
                kept.Answers.Clear();
                kept.ReadAt = now;
            }
            missing = pushers.Select(p => (Page: p.Key, Users: p.Value.Where(u => !kept.Answers.ContainsKey((p.Key, u))).ToHashSet()))
                .Where(p => p.Users.Count > 0).ToDictionary(p => p.Page, p => p.Users);
        }
        var read = missing.Count > 0 ? await access.EditorsAsync(workspaceId, missing, ct) : [];
        lock (kept)
        {
            foreach (var (page, users) in missing)
                foreach (var user in users)
                    kept.Answers[(page, user)] = read.GetValueOrDefault(page)?.Contains(user) == true;
            kept.At = seen;
            return pushers.ToDictionary(p => p.Key, p => p.Value.Where(u => kept.Answers.GetValueOrDefault((p.Key, u))).ToHashSet());
        }
    }

    private void Forget(Guid workspaceId)
    {
        if (editors.TryGetValue(workspaceId, out var kept))
            lock (kept)
            {
                kept.At = 0;
                kept.Answers.Clear();
            }
    }

    private static Dictionary<Guid, HashSet<Guid>> Pushers(IEnumerable<(Guid Page, List<PageDocUpdate> Rows)> pages) =>
        pages.ToDictionary(p => p.Page, p => p.Rows.Select(r => r.UserId).ToHashSet());

    /// <summary>Each refused row, with its problem (rare: one statement each).</summary>
    private static async Task RejectAsync(CgwDb db, List<Decision> decisions, CancellationToken ct)
    {
        foreach (var decision in decisions)
            foreach (var (seq, problems) in decision.Verdicts.Where(v => v.Value.Count > 0))
            {
                var (id, text) = (decision.Page.Id, Trim(string.Join("; ", problems)));
                await db.PageDocUpdates.Where(u => u.PageId == id && u.Seq == seq && u.Status == UpdateStatus.Pending)
                    .ExecuteUpdateAsync(s => s.SetProperty(u => u.Status, UpdateStatus.Rejected).SetProperty(u => u.Problem, text), ct);
            }
    }

    /// <summary>
    /// In one batch: the rest of each page's run valid, then each page's validated head, its state
    /// hash and its schema version. Every head must move, or the batch throws and nothing commits.
    /// </summary>
    private static async Task WriteAsync(CgwDb db, List<Decision> decisions, CancellationToken ct)
    {
        var parameters = new List<SqlParameter>();
        var runs = new List<string>();
        var heads = new List<string>();
        foreach (var decision in decisions)
        {
            var n = runs.Count;
            runs.Add($"(@p{n}, @f{n}, @h{n})");
            heads.Add($"(@p{n}, @h{n}, @v{n}, @s{n})");
            parameters.Add(new SqlParameter($"@p{n}", SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(decision.Page.Id) });
            parameters.Add(new SqlParameter($"@f{n}", SqlDbType.BigInt) { Value = decision.Rows[0].Seq });
            parameters.Add(new SqlParameter($"@h{n}", SqlDbType.BigInt) { Value = decision.Head });
            parameters.Add(new SqlParameter($"@v{n}", SqlDbType.Int) { Value = decision.SchemaVersion });
            parameters.Add(new SqlParameter($"@s{n}", SqlDbType.VarChar, 64) { Value = (object?)decision.Hash ?? DBNull.Value });
        }
        // Only parameter names and constants are written into the text. A seek on each page's run,
        // so rows pushes are still writing past it are never read. The heads were checked under the
        // lock just before, and nothing else moves a head without it.
        var sql = $"""
            UPDATE u SET u.[Status] = {UpdateStatus.Valid}
            FROM (VALUES {string.Join(", ", runs)}) AS v([PageId], [First], [Head])
            INNER LOOP JOIN [PageDocUpdates] u WITH (FORCESEEK) ON u.[PageId] = v.[PageId] AND u.[Seq] BETWEEN v.[First] AND v.[Head]
            WHERE u.[Status] = {UpdateStatus.Pending};
            UPDATE p SET p.[DocHeadSeq] = v.[Head], p.[DocSchemaVersion] = v.[Version], p.[DocStateHash] = v.[Hash], p.[DocStateHashSeq] = v.[Head]
            FROM (VALUES {string.Join(", ", heads)}) AS v([Id], [Head], [Version], [Hash])
            INNER LOOP JOIN [Pages] p WITH (FORCESEEK) ON p.[Id] = v.[Id];
            IF @@ROWCOUNT <> {decisions.Count} THROW 51000, N'Fewer pages'' heads moved than were decided', 1;
            """;
        await db.Database.ExecuteSqlRawAsync(sql, parameters, ct);
    }

    /// <summary>One page's pending updates judged, in sequence order, with nothing locked.</summary>
    private async Task<Decision> DecideAsync(CgwDb db, Decision decision, Dictionary<Guid, HashSet<ulong>> clients, CancellationToken ct)
    {
        var page = decision.Page;
        var rows = decision.Rows;
        var state = await states.LoadAsync(db, page, ct);
        var version = page.DocSchemaVersion;
        var known = Schema.For(version);
        byte[]? vector = null;

        // Each update's own checks; then, if all pass, the whole batch in one merge.
        foreach (var row in rows)
        {
            var problems = decision.Verdicts[row.Seq] = [];
            if (page.DeletedAt is not null) problems.Add("the page was deleted");
            else if (known is null) problems.Add($"schema version {version} is newer than this worker");
            else if (row.Epoch != page.DocEpoch) problems.Add($"epoch {row.Epoch}, the page is at {page.DocEpoch}");
            else if (!decision.Editors.Contains(row.UserId))
            {
                problems.Add($"{Codes.AccessDenied}: the pusher may no longer edit the page");
                decision.Denied.Add(row);
            }
            else
            {
                try
                {
                    var mine = clients.GetValueOrDefault(row.UserId) ?? [];
                    // Only what the update adds to the page: structs the server holds already (a
                    // repair's whole state, an update sent again) are nobody's forgery; new ones
                    // written as someone else's client still are.
                    var added = Yjs.Diff(row.Data, vector ??= Yjs.StateVector(state));
                    foreach (var range in Yjs.ClientRanges(added).Ranges)
                        if (!mine.Contains(range.Client))
                            problems.Add($"writes as Yjs client {range.Client}, which is not registered to the pusher");
                    if (problems.Count > 0) decision.Forged.Add(row);
                }
                catch (YdocException e)
                {
                    problems.Add($"does not decode: {e.Message}");
                }
            }
        }
        var policy = new ValidationPolicy([], known ?? [], DocService.MaxUpdateBytes, true);
        var passing = rows.Where(r => decision.Verdicts[r.Seq].Count == 0).ToList();
        var before = state;
        var batchPassed = false;
        if (passing.Count == rows.Count && rows.Count > 1)
        {
            try
            {
                var combined = Yjs.Merge(rows.Select(r => r.Data).ToList());
                var merged = Yjs.Merge([state, combined]);
                // A batch never raises the schema version: a migration is decided one update at a time.
                var problems = new List<string>();
                DocumentCheck(page, merged, version, version, problems);
                if (problems.Count == 0 && Yjs.Validate(state, combined, policy with { MaxBytes = 0 }).Count == 0)
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
                var problems = decision.Verdicts[row.Seq];
                try
                {
                    var merged = Yjs.Merge([state, row.Data]);
                    var next = DocumentCheck(page, merged, version, Math.Min(row.ClientSchemaVersion, Schema.Latest), problems);
                    if (problems.Count == 0) problems.AddRange(Yjs.Validate(state, row.Data, policy with { Elements = Schema.For(next)! }));
                    if (problems.Count == 0)
                    {
                        state = merged;
                        version = next;
                    }
                }
                catch (YdocException e)
                {
                    problems.Add($"does not decode: {e.Message}");
                }
            }
        decision.State = state;
        decision.SchemaVersion = version;
        // Nothing passed and the hash is the head's: it stays.
        decision.Hash = ReferenceEquals(state, before) && page.DocStateHashSeq == page.DocHeadSeq ? page.DocStateHash : Hash(state);
        return decision;
    }

    /// <summary>The state hash, or none when it cannot be made (the head still moves; the hash job tries again).</summary>
    internal static string? Hash(byte[] state)
    {
        try
        {
            return Yjs.StateHash(state);
        }
        catch (YdocException)
        {
            return null;
        }
    }

    /// <summary>
    /// What the whole document must keep: its page and its size; and the schema version it claims,
    /// which may rise above the page's <paramref name="current"/> only as far as
    /// <paramref name="allowed"/> (what the pushing app and this worker both know). Returns the
    /// version the document is at.
    /// </summary>
    private static int DocumentCheck(Page page, byte[] merged, int current, int allowed, List<string> problems)
    {
        if (merged.Length > Schema.MaxDocumentBytes) problems.Add("the document would be over 10 MB");
        using var meta = JsonDocument.Parse(Yjs.Meta(merged));
        if (meta.RootElement.TryGetProperty("pageId", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() != page.Id.ToString())
            problems.Add("the document names another page");
        if (meta.RootElement.TryGetProperty("schemaVersion", out var claimed) && claimed.ValueKind == JsonValueKind.Number
            && claimed.GetDouble() > current)
        {
            var value = claimed.GetDouble();
            if (value != Math.Floor(value) || value > allowed)
                problems.Add(value > Schema.Latest
                    ? $"the document claims schema version {value}, newer than this worker knows"
                    : $"the document claims schema version {value}, newer than the app that pushed it knows");
            else return (int)value;
        }
        return current;
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
        // A row's files are shown by its page too: they stay referenced (and readable) by it.
        if (page.Kind == PageKinds.Row) assets.AddRange((await RowFilesAsync(db, pageId, ct)).Except(assets));
        var derived = await db.PageDocDerived.FirstOrDefaultAsync(d => d.PageId == pageId, ct);
        // The mention pass (Phase 6): the pairs the last derive saw, against these.
        var before = Mentions.Parse(derived?.Mentions);
        var mentioned = Mentions.InDocument(json);
        var since = derived?.UpToSeq ?? 0;
        if (derived is null) db.PageDocDerived.Add(derived = new PageDocDerived { PageId = pageId, WorkspaceId = page.WorkspaceId });
        derived.UpToSeq = page.DocHeadSeq;
        derived.Json = DocService.Gzip(json);
        derived.PlainText = text.Length > 1_000_000 ? text[..1_000_000] : text;
        derived.SearchText = TextNormaliser.Normalise(derived.PlainText);
        derived.Outgoing = JsonSerializer.Serialize(new { pages, assets });
        derived.Mentions = Mentions.Serialize(mentioned);
        derived.UpdatedAt = clock.GetUtcNow();
        var fresh = mentioned.Where(m => !before.Contains((m.BlockId, m.UserId))).ToList();
        var notices = fresh.Count > 0 ? await MentionNoticesAsync(db, page, fresh, since, ct) : [];
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        if (notices.Count > 0)
        {
            // The workspace's lock first, as every writer takes it: a notification's feed change, and
            // its once-only check, are exact under it.
            var changes = new ChangeLog(db, clock);
            await changes.LockAsync(page.WorkspaceId, ct);
            await NotificationService.AddAsync(db, changes, notices, ct);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
        }
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

    /// <summary>
    /// A notification for each person newly mentioned in a block (Phase 6 contracts, section 5): a
    /// member who can read the page, and not the actor, the pusher of the newest update in the range
    /// this derive covers. Once per person, page and block (<see cref="NotificationService.MentionKey"/>).
    /// </summary>
    private async Task<List<Notification>> MentionNoticesAsync(CgwDb db, Page page, List<BlockMention> fresh, long since, CancellationToken ct)
    {
        var (id, head) = (page.Id, page.DocHeadSeq);
        var valid = db.PageDocUpdates.AsNoTracking().Where(u => u.PageId == id && u.Seq <= head && u.Status == UpdateStatus.Valid);
        // The newest valid update this derive covers; the newest before it when a compaction removed
        // those rows; the page's last editor when none is left.
        var actor = await valid.Where(u => u.Seq > since).OrderByDescending(u => u.Seq).Select(u => (Guid?)u.UserId).FirstOrDefaultAsync(ct)
            ?? await valid.OrderByDescending(u => u.Seq).Select(u => (Guid?)u.UserId).FirstOrDefaultAsync(ct)
            ?? page.UpdatedBy;
        var readers = await new Access(db).ReadersAsync(page.WorkspaceId, page.Id, fresh.Select(m => m.UserId).Where(u => u != actor), ct);
        var now = clock.GetUtcNow();
        return fresh.Where(m => m.UserId != actor && readers.Contains(m.UserId)).Select(m => new Notification
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = page.WorkspaceId,
            UserId = m.UserId,
            Kind = NotificationKinds.Mention,
            PageId = page.Id,
            BlockId = m.BlockId,
            ActorUserId = actor,
            Excerpt = m.Excerpt,
            DedupeKey = NotificationService.MentionKey(page.Id, m.BlockId),
            CreatedAt = now,
        }).ToList();
    }

    /// <summary>The assets a row's files properties hold.</summary>
    public static async Task<List<Guid>> RowFilesAsync(CgwDb db, Guid rowId, CancellationToken ct)
    {
        var row = await db.DatabaseRows.AsNoTracking().FirstOrDefaultAsync(r => r.PageId == rowId, ct);
        if (row is null) return [];
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == row.DatabaseId, ct);
        if (record is null) return [];
        var schema = Cgw.Core.Databases.Schema.Parse(record.PageId, record.Version, record.Properties);
        var values = Cgw.Core.Databases.ValueJson.ReadMap(row.Values);
        return schema.Properties.Where(p => p.Type == Cgw.Core.Databases.PropertyTypes.Files)
            .SelectMany(p => values.GetValueOrDefault(p.Id) as string[] ?? [])
            .Select(id => Guid.TryParse(id, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).Distinct().ToList();
    }

    /// <summary>The ids a document holds: pages it links to (child pages, mentions, the databases its views show) and assets it shows (DATA_MODEL.md, D6).</summary>
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
                // A database view shows a database, which is a page: its backlink, as a child page's.
                if (type == "databaseView" && attrs.TryGetProperty("databaseId", out var d) && d.ValueKind == JsonValueKind.String && Guid.TryParse(d.GetString(), out var databaseId))
                    pages.Add(databaseId);
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

/// <summary>
/// The state hash of pages whose head has none (the repair check, Phase 3 contracts, section 2):
/// pages last edited before the worker wrote hashes, or whose hash could not be made when their head
/// moved. The validation job writes it with every head it moves; this one only fills gaps, and a
/// page it cannot hash is marked as tried at that head, so it never blocks the rest.
/// </summary>
public sealed class StateHashJob(DocStates states, ILogger<StateHashJob> logger) : IJob
{
    public string Name => "stateHash";
    public TimeSpan Interval => TimeSpan.FromSeconds(5);
    private const int Batch = 20;

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var due = await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.DocStateHash == null && p.DeletedAt == null && p.DocHeadSeq > 0 && p.DocStateHashSeq != p.DocHeadSeq)
            .Select(p => new { p.Id, p.WorkspaceId }).Take(Batch).ToListAsync(ct);
        foreach (var row in due)
        {
            db.ChangeTracker.Clear();
            db.Scope.Switch(row.WorkspaceId);
            await HashAsync(db, row.Id, ct);
        }
        return due.Count == Batch;
    }

    public async Task HashAsync(CgwDb db, Guid pageId, CancellationToken ct)
    {
        var page = await db.Pages.AsNoTracking().FirstAsync(p => p.Id == pageId, ct);
        string? hash = null;
        try
        {
            hash = ValidateJob.Hash(await states.LoadAsync(db, page, ct));
        }
        catch (InvalidOperationException e)
        {
            logger.LogWarning(e, "No state hash for page {Page}", pageId);
        }
        var (head, epoch) = (page.DocHeadSeq, page.DocEpoch);
        // Only for the head it was made at: a head that moved since has its own from the validation.
        await db.Pages.Where(p => p.Id == pageId && p.DocHeadSeq == head && p.DocEpoch == epoch && p.DocStateHash == null)
            .ExecuteUpdateAsync(s => s.SetProperty(p => p.DocStateHash, hash).SetProperty(p => p.DocStateHashSeq, head), ct);
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
