using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using Cgw.Core;
using Cgw.Core.Ai;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Core.Plugins;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Worker.Jobs;

/// <summary>
/// Embeddings (Phase 10, M10.2; decisions, 2026-11-18): for each workspace with embeddings on, the
/// pages and rows not trashed or deleted whose title or derived text changed since their vectors were
/// written, and that have been unchanged for <c>Ai__EmbeddingsSettleSeconds</c> (30), are cut into
/// chunks (<see cref="EmbeddingText"/>) and embedded by the workspace's model with its own key, a
/// chunk whose text and model already have a vector keeping it (no call). Trashed and deleted pages'
/// vectors are removed; a restored page is embedded again; a model change (the generation) embeds
/// everything again, the old model's vectors going as the new ones land. Every insert or delete of
/// a page's vectors writes an <c>EmbeddingChanges</c> row in its transaction, under the settings
/// row's lock, after checking embeddings are still on at that generation. A provider failure backs
/// the workspace off for 1, 5, then 30 minutes. Metered (<c>embed</c>, no person), never audited.
/// Comments, workbooks and ERP data are never read. Phase 13 (M13.3): a row's property values are,
/// as <see cref="EmbeddingValues"/> chooses them, before its own text; its vectors are kept by its
/// database's version too, so a property renamed, added or removed embeds its rows again (a chunk
/// whose text did not change keeps its vector, with no call), and a formula's or rollup's result that
/// changes raises the row's version as any value does.
/// </summary>
public sealed class EmbedJob(IEmbeddingProvider provider, EmbeddingKeys keys, EmbeddingsOptions options, AiSubscriptionOptions subscription, TimeProvider clock, ILogger<EmbedJob> logger) : IJob
{
    public string Name => "embed";
    public TimeSpan Interval => TimeSpan.FromSeconds(2);
    public bool OwnLoop => true;

    /// <summary>Pages looked at a workspace a pass.</summary>
    public const int PagesAPass = 40;
    private static readonly TimeSpan[] Backoff = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30)];

    private readonly ConcurrentDictionary<Guid, (DateTimeOffset Until, int Failures)> waiting = new();

    /// <summary>
    /// Every page of a workspace is looked at this often (and at once after its generation rises);
    /// between those passes, only pages changed, trashed or deleted since a while before the last
    /// pass, so a big workspace's every-2-seconds pass reads a few rows, not all of them.
    /// </summary>
    public static readonly TimeSpan FullEvery = TimeSpan.FromMinutes(5);

    private readonly ConcurrentDictionary<Guid, (long Generation, DateTimeOffset LastFull, DateTimeOffset LastPass)> marks = new();

    /// <summary>Whether a workspace is backed off after a provider failure (for tests).</summary>
    public bool BackedOff(Guid workspaceId) => waiting.TryGetValue(workspaceId, out var w) && w.Until > clock.GetUtcNow();

    /// <summary>Forgets a workspace's back-off (for tests).</summary>
    public void Forgive(Guid workspaceId) => waiting.TryRemove(workspaceId, out _);

    public Task<bool> RunAsync(IServiceProvider services, CancellationToken ct) => PassAsync(services.GetRequiredService<CgwDb>(), null, ct);

    /// <summary>One pass over every workspace with embeddings on (or one of them); true when more is due at once.</summary>
    public async Task<bool> PassAsync(CgwDb db, Guid? only, CancellationToken ct)
    {
        var models = options.Models;
        var local = LocalModelOptions.Model;
        var onSubscription = KeySources.Subscription;
        var due = await db.AiSettings.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(s => s.EmbeddingsEnabled && (s.EmbeddingsKeyCipher != null || s.EmbeddingsModel == local || s.EmbeddingsKeySource == onSubscription) && models.Contains(s.EmbeddingsModel))
            .Where(s => only == null || s.WorkspaceId == only)
            .Join(db.Workspaces.Where(w => w.DeletedAt == null), s => s.WorkspaceId, w => w.Id, (s, _) => new { s.WorkspaceId, s.EmbeddingsModel, s.EmbeddingsGeneration, s.EmbeddingsKeyCipher, s.EmbeddingsKeySource })
            .ToListAsync(ct);
        var more = false;
        var now = clock.GetUtcNow();
        foreach (var row in due)
        {
            if (waiting.TryGetValue(row.WorkspaceId, out var w) && w.Until > now) continue;
            db.ChangeTracker.Clear();
            db.Scope.Switch(row.WorkspaceId);
            var source = LocalModelOptions.IsLocal(row.EmbeddingsModel) ? KeySources.Own : row.EmbeddingsKeySource;
            // On the subscription only while this server offers it to the workspace.
            if (source == KeySources.Subscription && !subscription.OffersEmbeddings(row.WorkspaceId)) continue;
            more |= await RunWorkspaceAsync(db, new EmbedSettings(row.WorkspaceId, row.EmbeddingsModel, row.EmbeddingsGeneration, row.EmbeddingsKeyCipher) { KeySource = source }, ct);
        }
        return more;
    }

    /// <summary>One workspace's pass (in its tenant scope): vectors of pages gone removed, then up to 40 pages embedded. True when more is due at once.</summary>
    public async Task<bool> RunWorkspaceAsync(CgwDb db, EmbedSettings settings, CancellationToken ct)
    {
        var ws = settings.WorkspaceId;
        var started = clock.GetUtcNow();
        var mark = marks.TryGetValue(ws, out var m) && m.Generation == settings.Generation ? m : (Generation: settings.Generation, LastFull: DateTimeOffset.MinValue, LastPass: DateTimeOffset.MinValue);
        var full = started - mark.LastFull >= FullEvery;
        // Between full passes: what changed since the last pass began, less the settle time and a minute (clocks).
        DateTimeOffset? since = full ? null : mark.LastPass - options.Settle - TimeSpan.FromMinutes(1);
        var vectors = db.PageEmbeddings;
        var databases = db.Databases;

        // 1. Vectors of pages trashed, deleted or gone.
        const int GoneAPass = 500;
        List<Guid> gone;
        if (since is { } changedSince)
            gone = await db.Pages.AsNoTracking().Where(p => (p.TrashedAt >= changedSince || p.DeletedAt >= changedSince) && vectors.Any(e => e.PageId == p.Id))
                .Select(p => p.Id).OrderBy(id => id).Take(GoneAPass).ToListAsync(ct);
        else
        {
            var pages = db.Pages;
            gone = await vectors.AsNoTracking().Where(e => e.WorkspaceId == ws)
                .Where(e => !pages.Any(p => p.Id == e.PageId && p.TrashedAt == null && p.DeletedAt == null))
                .Select(e => e.PageId).Distinct().OrderBy(id => id).Take(GoneAPass).ToListAsync(ct);
        }
        if (gone.Count > 0 && !await WriteAsync(db, settings, gone.Select(id => new Planned(id, null, 0, 0, 0)).ToList(), ct)) return false;

        // 2. Pages whose vectors are missing or not of their current title and text, settled and derived.
        var settled = started - options.Settle;
        var model = settings.Model;
        var candidates = await (
                from p in db.Pages.AsNoTracking()
                where p.WorkspaceId == ws && p.TrashedAt == null && p.DeletedAt == null && p.UpdatedAt <= settled
                join d in db.PageDocDerived.AsNoTracking() on p.Id equals d.PageId into dj
                from d in dj.DefaultIfEmpty()
                // The derive has caught up (or the page has no document) and has been still for the settle time.
                where (p.DocHeadSeq == 0 && d == null) || (d != null && d.UpToSeq >= p.DocHeadSeq && d.UpdatedAt <= settled)
                // A row's database changed (its properties, or its results recomputed) since: its rows are looked at.
                where since == null || p.UpdatedAt >= since || (d != null && d.UpdatedAt >= since)
                    || (p.Kind == PageKinds.Row && databases.Any(x => x.PageId == p.ParentPageId && x.UpdatedAt >= since))
                let textVersion = d == null ? 0L : d.UpToSeq
                let schemaVersion = p.Kind == PageKinds.Row ? databases.Where(x => x.PageId == p.ParentPageId).Select(x => x.Version).FirstOrDefault() : 0L
                where !vectors.Any(e => e.PageId == p.Id && e.Model == model && e.Chunk == 0 && e.PageVersion == p.Version && e.TextVersion == textVersion && e.SchemaVersion == schemaVersion)
                orderby p.Id
                select new { p.Id, p.Title, p.Version, p.Kind, TextVersion = textVersion, SchemaVersion = schemaVersion })
            .Take(PagesAPass)
            .ToListAsync(ct);
        // A pass that saw everything due moves the mark on; one cut short goes again from the same mark.
        var complete = candidates.Count < PagesAPass && gone.Count < GoneAPass;
        void Done()
        {
            if (complete) marks[ws] = (settings.Generation, full ? started : mark.LastFull, started);
        }
        if (candidates.Count == 0)
        {
            Done();
            return !complete;
        }

        var ids = candidates.Select(c => c.Id).ToList();
        var texts = await db.PageDocDerived.AsNoTracking().Where(d => ids.Contains(d.PageId))
            .Select(d => new { d.PageId, d.PlainText }).ToDictionaryAsync(d => d.PageId, d => d.PlainText, ct);
        // Rows' values (Phase 13), read with the rows as they are now.
        var values = await EmbeddingValues.ForRowsAsync(db, candidates.Where(c => c.Kind == PageKinds.Row).Select(c => c.Id).ToList(), ct);
        var held = (await db.PageEmbeddings.AsNoTracking().Where(e => ids.Contains(e.PageId))
                .Select(e => new { e.PageId, e.Model, e.Chunk, e.TextHash, e.Vector }).ToListAsync(ct))
            .ToLookup(e => e.PageId);

        var plans = new List<Planned>();
        var needed = new List<(Planned Plan, int Chunk, string Text)>();
        foreach (var page in candidates)
        {
            var own = texts.GetValueOrDefault(page.Id);
            var body = page.Kind == PageKinds.Row && values.TryGetValue(page.Id, out var row) ? EmbeddingValues.Body(row.Text, own) : own;
            var chunks = EmbeddingText.Chunks(page.Title, body);
            var mine = held[page.Id].ToList();
            var known = mine.Where(e => e.Model == model && e.Vector.Length > 0)
                .GroupBy(e => Convert.ToHexString(e.TextHash)).ToDictionary(g => g.Key, g => g.First().Vector, StringComparer.Ordinal);
            var plan = new Planned(page.Id, [], page.Version, page.TextVersion, page.SchemaVersion);
            for (var i = 0; i < chunks.Count; i++)
            {
                var hash = EmbeddingText.Hash(chunks[i].Text);
                plan.Chunks!.Add(new PlannedChunk(i, hash, known.GetValueOrDefault(Convert.ToHexString(hash))));
                if (plan.Chunks[^1].Vector is null) needed.Add((plan, i, chunks[i].Text));
            }
            // Nothing to embed (no title, no text): one empty row says so.
            if (chunks.Count == 0) plan.Chunks!.Add(new PlannedChunk(0, EmbeddingText.Hash(""), []));
            // The same chunks, the same vectors, of this model only: only the versions move on.
            plan.Unchanged = mine.Count == plan.Chunks!.Count && mine.All(e => e.Model == model)
                && plan.Chunks.All(c => mine.Any(e => e.Chunk == c.Chunk && e.TextHash.AsSpan().SequenceEqual(c.Hash)));
            plans.Add(plan);
        }

        // 3. The provider, for the chunks that have no vector yet: at most 128 texts and 100,000 characters a call.
        if (needed.Count > 0)
        {
            // The local model (Phase 13) needs no key; a Voyage model the workspace's own, or Cash Gear's on the subscription.
            var onPlan = settings.KeySource == KeySources.Subscription;
            var key = LocalModelOptions.IsLocal(model) ? "" : onPlan ? subscription.VoyageKey : settings.Cipher is { } cipher ? keys.Unprotect(ws, cipher) : null;
            var allowance = new AiAllowance(db, subscription, clock);
            if (key is null)
            {
                Fail(ws, Codes.AiKeyInvalid);
                return false;
            }
            var batch = new List<(Planned Plan, int Chunk, string Text)>();
            var chars = 0;
            async Task<bool> SendAsync()
            {
                if (batch.Count == 0) return true;
                // On the subscription (Phase 13): the batch's tokens reserved first; past the allowance the
                // workspace waits for the next month.
                Guid? reservation = null;
                if (onPlan)
                {
                    var reserved = await allowance.ReserveAsync(ws, AiAllowance.Embeddings, AiAllowance.Estimate(batch.Sum(b => (long)b.Text.Length)), ct);
                    if (!reserved.Ok)
                    {
                        WaitForNextMonth(ws);
                        return false;
                    }
                    reservation = reserved.Value;
                }
                var watch = Stopwatch.StartNew();
                try
                {
                    var result = await provider.EmbedAsync(new EmbeddingCall(batch.Select(b => b.Text).ToList(), EmbeddingCall.Document, model, key), ct);
                    await MeterAsync(db, ws, model, "ok", result.Tokens, watch.Elapsed, ct, reservation, allowance);
                    for (var i = 0; i < batch.Count; i++)
                    {
                        var (plan, chunk, _) = batch[i];
                        plan.Chunks![chunk] = plan.Chunks[chunk] with { Vector = System.Runtime.InteropServices.MemoryMarshal.AsBytes(result.Vectors[i].AsSpan()).ToArray() };
                    }
                }
                catch (AiProviderException error)
                {
                    await MeterAsync(db, ws, model, error.Code, 0, watch.Elapsed, ct, reservation, allowance);
                    Fail(ws, error.Code);
                    return false;
                }
                batch.Clear();
                chars = 0;
                return true;
            }
            foreach (var item in needed)
            {
                var length = Math.Min(item.Text.Length, EmbeddingsOptions.MaxCallChars);
                if (batch.Count == EmbeddingsOptions.MaxInputs || (batch.Count > 0 && chars + length > EmbeddingsOptions.MaxCallChars))
                    if (!await SendAsync()) return false;
                batch.Add(item.Text.Length > EmbeddingsOptions.MaxCallChars ? (item.Plan, item.Chunk, item.Text[..EmbeddingsOptions.MaxCallChars]) : item);
                chars += length;
            }
            if (!await SendAsync()) return false;
        }
        waiting.TryRemove(ws, out _);

        // 4. Written, ten pages a short transaction, under the settings row's lock.
        foreach (var chunk in plans.Chunk(10))
            if (!await WriteAsync(db, settings, chunk.ToList(), ct)) return false;
        Done();
        return !complete;
    }

    /// <summary>Phase 13: a workspace past its subscription's allowance waits until the first of the next month (UTC).</summary>
    private void WaitForNextMonth(Guid workspaceId)
    {
        var (_, next) = AiAllowance.MonthOf(clock.GetUtcNow());
        waiting[workspaceId] = (next, 0);
        logger.LogWarning("A workspace's allowance of search by meaning on the subscription is used; embedding waits until {Next:yyyy-MM-dd}", next);
    }

    private void Fail(Guid workspaceId, string code)
    {
        var failures = waiting.TryGetValue(workspaceId, out var w) ? w.Failures + 1 : 1;
        var wait = Backoff[Math.Min(failures, Backoff.Length) - 1];
        waiting[workspaceId] = (clock.GetUtcNow() + wait, failures);
        logger.LogWarning("Embedding a workspace's pages failed ({Code}); trying again in {Minutes} minutes", code, wait.TotalMinutes);
    }

    private async Task MeterAsync(CgwDb db, Guid workspaceId, string model, string outcome, long tokens, TimeSpan took, CancellationToken ct, Guid? reservation = null, AiAllowance? allowance = null)
    {
        allowance?.Settle(reservation);
        db.AiUsage.Add(new AiUsage
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = workspaceId,
            UserId = null,
            Action = EmbeddingActions.Embed,
            Model = model,
            InputTokens = tokens,
            Outcome = outcome,
            DurationMs = (int)Math.Min(int.MaxValue, took.TotalMilliseconds),
            CreatedAt = clock.GetUtcNow(),
            Subscription = reservation is not null,
        });
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();
    }

    /// <summary>A chunk as planned: its index, its text's hash, and its vector once known (empty: nothing to embed).</summary>
    private sealed record PlannedChunk(int Chunk, byte[] Hash, byte[]? Vector);

    /// <summary>A page's vectors as they are to be: null chunks deletes them all. A row's <c>SchemaVersion</c> is its database's version (0 for a page).</summary>
    private sealed record Planned(Guid PageId, List<PlannedChunk>? Chunks, long PageVersion, long TextVersion, long SchemaVersion)
    {
        public bool Unchanged { get; set; }
    }

    /// <summary>
    /// Writes pages' vectors, under the settings row's lock, while embeddings are still on at the
    /// generation and model this pass began with; false (nothing written) once they are not.
    /// </summary>
    private async Task<bool> WriteAsync(CgwDb db, EmbedSettings settings, List<Planned> plans, CancellationToken ct)
    {
        var ws = settings.WorkspaceId;
        db.ChangeTracker.Clear();
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var wsParameter = new SqlParameter("@ws", SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(ws) };
        var current = await db.Database.SqlQueryRaw<LockedSettings>(
                "SELECT [EmbeddingsEnabled], [EmbeddingsGeneration], [EmbeddingsModel], [EmbeddingsKeySource], CAST(CASE WHEN [EmbeddingsKeyCipher] IS NULL THEN 0 ELSE 1 END AS bit) AS [HasKey] FROM [AiSettings] WITH (UPDLOCK, HOLDLOCK) WHERE [WorkspaceId] = @ws",
                wsParameter)
            .ToListAsync(ct);
        if (current is not [{ EmbeddingsEnabled: true } on] || on.EmbeddingsGeneration != settings.Generation || on.EmbeddingsModel != settings.Model
            || !(on.HasKey || LocalModelOptions.IsLocal(on.EmbeddingsModel) || on.EmbeddingsKeySource == KeySources.Subscription))
            return false;
        var now = clock.GetUtcNow();
        var touched = new List<Guid>();
        foreach (var plan in plans)
        {
            var id = plan.PageId;
            if (plan.Chunks is not null && plan.Unchanged)
            {
                var (pageVersion, textVersion, schemaVersion) = (plan.PageVersion, plan.TextVersion, plan.SchemaVersion);
                await db.PageEmbeddings.Where(e => e.PageId == id).ExecuteUpdateAsync(s => s
                    .SetProperty(e => e.PageVersion, pageVersion)
                    .SetProperty(e => e.TextVersion, textVersion)
                    .SetProperty(e => e.SchemaVersion, schemaVersion), ct);
                continue;
            }
            var deleted = await db.PageEmbeddings.Where(e => e.PageId == id).ExecuteDeleteAsync(ct);
            if (plan.Chunks is null)
            {
                if (deleted > 0) touched.Add(id);
                continue;
            }
            // A page trashed or deleted since it was read is left without vectors (the next pass sees it).
            if (!await db.Pages.AnyAsync(p => p.Id == id && p.TrashedAt == null && p.DeletedAt == null, ct))
            {
                if (deleted > 0) touched.Add(id);
                continue;
            }
            foreach (var chunk in plan.Chunks)
                db.PageEmbeddings.Add(new PageEmbedding
                {
                    WorkspaceId = ws,
                    PageId = id,
                    Chunk = chunk.Chunk,
                    Model = settings.Model,
                    TextHash = chunk.Hash,
                    Vector = chunk.Vector ?? [],
                    TextVersion = plan.TextVersion,
                    PageVersion = plan.PageVersion,
                    SchemaVersion = plan.SchemaVersion,
                    CreatedAt = now,
                });
            touched.Add(id);
        }
        foreach (var id in touched) db.EmbeddingChanges.Add(new EmbeddingChange { WorkspaceId = ws, PageId = id, CreatedAt = now });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        db.ChangeTracker.Clear();
        return true;
    }

    private sealed class LockedSettings
    {
        public bool EmbeddingsEnabled { get; set; }
        public long EmbeddingsGeneration { get; set; }
        public string EmbeddingsModel { get; set; } = "";
        public string EmbeddingsKeySource { get; set; } = KeySources.Own;
        public bool HasKey { get; set; }
    }
}

/// <summary>A workspace's embeddings settings as a pass runs with them: its model, generation and key's cipher (none for the local model), and (Phase 13) the key's source.</summary>
public sealed record EmbedSettings(Guid WorkspaceId, string Model, long Generation, string? Cipher)
{
    public string KeySource { get; init; } = KeySources.Own;
}

/// <summary>
/// Phase 10's clean-up, hourly: <c>EmbeddingChanges</c> older than a day (the API's copies older
/// than that load whole); plugin frame tickets a day after they expired; removed plugins' files a day
/// after their removal (their rows stay for the audit); and a live plugin's files of bundles it no
/// longer serves, left by an update a crash cut short, once a day old.
/// </summary>
public sealed class Phase10CleanupJob(BlobStore blob, TimeProvider clock) : IJob
{
    public string Name => "embeddingsAndPluginsCleanup";
    public TimeSpan Interval => TimeSpan.FromHours(1);
    public static TimeSpan Keep { get; set; } = TimeSpan.FromDays(1);

    public async Task<bool> RunAsync(IServiceProvider services, CancellationToken ct)
    {
        var db = services.GetRequiredService<CgwDb>();
        var before = clock.GetUtcNow() - Keep;
        await db.EmbeddingChanges.IgnoreQueryFilters([CgwDb.Tenant]).Where(c => c.CreatedAt < before).ExecuteDeleteAsync(ct);
        await db.PluginFrameTickets.IgnoreQueryFilters([CgwDb.Tenant]).Where(t => t.ExpiresAt < before).ExecuteDeleteAsync(ct);

        var removed = await db.WorkspacePlugins.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.RemovedAt != null && p.BlobsDeletedAt == null && p.RemovedAt < before)
            .Select(p => new { p.Id, p.WorkspaceId }).Take(50).ToListAsync(ct);
        foreach (var plugin in removed)
        {
            await foreach (var (name, _) in blob.ListAsync(PluginService.PluginPrefix(plugin.WorkspaceId, plugin.Id), ct))
                await blob.DeleteAsync(name, ct);
            var at = clock.GetUtcNow();
            var id = plugin.Id;
            await db.WorkspacePlugins.IgnoreQueryFilters([CgwDb.Tenant]).Where(p => p.Id == id)
                .ExecuteUpdateAsync(s => s.SetProperty(p => p.BlobsDeletedAt, at), ct);
        }

        var live = await db.WorkspacePlugins.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
            .Where(p => p.RemovedAt == null).Select(p => new { p.Id, p.WorkspaceId, p.BlobPrefix }).ToListAsync(ct);
        foreach (var plugin in live)
            await foreach (var (name, created) in blob.ListAsync(PluginService.PluginPrefix(plugin.WorkspaceId, plugin.Id), ct))
                if (!name.StartsWith(plugin.BlobPrefix, StringComparison.Ordinal) && created is { } made && made < before)
                    await blob.DeleteAsync(name, ct);
        return removed.Count == 50;
    }
}
