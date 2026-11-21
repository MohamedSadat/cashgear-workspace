using System.Collections.Concurrent;
using System.Diagnostics;
using Cgw.Core.Ai;
using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Search;

/// <summary><c>GET /workspaces/{id}/search/meaning</c>'s answer: the same hits as <c>/search</c>'s, <c>score</c> the cosine similarity.</summary>
public sealed record MeaningResultDto(IReadOnlyList<SearchHitDto> Hits);

/// <summary>A page found by meaning, before the permission check: its best chunk's score and index.</summary>
public readonly record struct MeaningCandidate(Guid PageId, float Score, int Chunk);

/// <summary>
/// What one ranking cost: the copy loaded whole or brought up to date, and the scoring; Phase 13,
/// whether it was approximate and how many chunks it scored exactly (all of them when it was not).
/// </summary>
public sealed record MeaningTimings(bool Loaded, int PagesSynced, int Chunks, TimeSpan Sync, TimeSpan Score, bool Approximate = false, int Scored = 0);

/// <summary>
/// A ranking: the pages, best first; <c>Complete</c> when every chunk was scored exactly (else only the
/// nearest candidates by their sign bits were, and a wider ranking may find more).
/// </summary>
public sealed record MeaningRanking(List<MeaningCandidate> Ranked, MeaningTimings Timings, bool Complete);

/// <summary>A search's answer and what it took, apart from the provider's time to embed the question.</summary>
public sealed record MeaningOutcome(MeaningResultDto Result, TimeSpan ProviderTime, MeaningTimings Timings);

/// <summary>
/// The API process's copies of workspaces' vectors (Phase 10; decisions, 2026-11-18): per
/// workspace, the current model's int8 vectors in one array with each chunk's norm and page,
/// loaded on the workspace's first search by meaning and brought up to date on each search from
/// <c>EmbeddingChanges</c> after the copy's last sequence (pages changed read again, pages gone
/// dropped). A copy of another generation or model, or one not brought up to date for longer than
/// the changes are kept, loads whole. All copies together stay under <c>Ai__EmbeddingsCacheMb</c>:
/// the least recently used goes first. The vectors never leave this class but as scores.
/// <para>
/// Phase 13 (M13.4; decisions, 2026-11-21): each chunk's 1,024 sign bits (128 bytes) are kept beside
/// its int8 vector. Past <see cref="EmbeddingsOptions.ApproximateFrom"/> live chunks a search is
/// approximate: every chunk's bits are compared with the question's (a Hamming distance, a popcount of
/// 16 words), the nearest <c>candidates</c> are scored exactly, and only they rank; a caller wanting
/// more widens it until it is exact. Nothing is trained; the bits come and go with their vectors.
/// </para>
/// </summary>
public sealed class EmbeddingsCache(EmbeddingsOptions options, TimeProvider clock)
{
    /// <summary>Changes are kept a day (the worker's retention); a copy older than this loads whole.</summary>
    public static readonly TimeSpan Trusted = TimeSpan.FromHours(20);
    private const int Dimensions = EmbeddingsOptions.Dimensions;
    private const int Words = Dimensions / 64;

    private readonly ConcurrentDictionary<Guid, Copy> copies = new();
    private long total;

    public long Bytes => Interlocked.Read(ref total);

    public int Count => copies.Count;

    /// <summary>Forgets a workspace's copy (its embeddings turned off).</summary>
    public void Drop(Guid workspaceId)
    {
        if (copies.TryRemove(workspaceId, out var copy)) Interlocked.Add(ref total, -copy.Accounted);
    }

    /// <summary>Whether a copy of the workspace is held (for tests and the bench).</summary>
    public bool Holds(Guid workspaceId) => copies.ContainsKey(workspaceId);

    private sealed class Copy(Guid workspaceId)
    {
        public readonly Guid WorkspaceId = workspaceId;
        public readonly SemaphoreSlim Gate = new(1, 1);
        public bool Ready;
        public long Generation;
        public string Model = "";
        public long LastSeq;
        public DateTimeOffset SyncedAt;
        public long LastUsed;
        /// <summary>The bytes counted against the cap for this copy.</summary>
        public long Accounted;

        public sbyte[] Data = [];
        /// <summary>Phase 13: each slot's sign bits, 16 words a slot (bit set where the value is above 0).</summary>
        public ulong[] Bits = [];
        public float[] InverseNorms = [];
        /// <summary>Each slot's page (an index into <see cref="Pages"/>), -1 once its page changed or went.</summary>
        public int[] SlotPage = [];
        public int[] SlotChunk = [];
        public int Count;
        public int Dead;
        public readonly List<Guid> Pages = [];
        public readonly Dictionary<Guid, int> PageIndex = [];
        public readonly Dictionary<int, (int Start, int Length)> PageSlots = [];

        public long Size => (long)Data.Length + Bits.Length * 8L + InverseNorms.Length * 4L + SlotPage.Length * 8L + Pages.Count * 64L;

        public void Clear()
        {
            Data = [];
            Bits = [];
            InverseNorms = [];
            SlotPage = [];
            SlotChunk = [];
            Count = 0;
            Dead = 0;
            Pages.Clear();
            PageIndex.Clear();
            PageSlots.Clear();
        }

        /// <summary>Room for <paramref name="more"/> slots past those used; grown by half again when it grows.</summary>
        public void Reserve(int more)
        {
            var need = Count + more;
            if (need <= SlotPage.Length) return;
            var capacity = SlotPage.Length == 0 ? Math.Max(need, 1024) : Math.Max(need, Math.Max(1024, SlotPage.Length + SlotPage.Length / 2));
            Array.Resize(ref Data, capacity * Dimensions);
            Array.Resize(ref Bits, capacity * Words);
            Array.Resize(ref InverseNorms, capacity);
            Array.Resize(ref SlotPage, capacity);
            Array.Resize(ref SlotChunk, capacity);
        }

        /// <summary>Takes out a page's chunks (its slots marked dead).</summary>
        public void Remove(Guid pageId)
        {
            if (!PageIndex.TryGetValue(pageId, out var index) || !PageSlots.Remove(index, out var slots)) return;
            for (var i = slots.Start; i < slots.Start + slots.Length; i++) SlotPage[i] = -1;
            Dead += slots.Length;
        }

        /// <summary>Adds a page's chunks, in chunk order, at the end.</summary>
        public void Add(Guid pageId, IReadOnlyList<(int Chunk, byte[] Vector)> chunks)
        {
            var usable = chunks.Where(c => c.Vector.Length == Dimensions).ToList();
            if (usable.Count == 0) return;
            if (!PageIndex.TryGetValue(pageId, out var index))
            {
                index = Pages.Count;
                Pages.Add(pageId);
                PageIndex[pageId] = index;
            }
            Reserve(usable.Count);
            var start = Count;
            foreach (var (chunk, vector) in usable)
            {
                var slot = Count++;
                var target = Data.AsSpan(slot * Dimensions, Dimensions);
                System.Runtime.InteropServices.MemoryMarshal.Cast<byte, sbyte>(vector).CopyTo(target);
                var norm = VectorMath.Norm(target);
                InverseNorms[slot] = norm > 0 ? 1 / norm : 0;
                VectorMath.SignBits(target, Bits.AsSpan(slot * Words, Words));
                SlotPage[slot] = index;
                SlotChunk[slot] = chunk;
            }
            PageSlots[index] = (start, usable.Count);
        }

        /// <summary>Packs the live slots together once a quarter of them are dead.</summary>
        public void CompactIfWorth()
        {
            if (Dead < 1024 || Dead * 4 < Count) return;
            var write = 0;
            var moved = new Dictionary<int, (int Start, int Length)>();
            for (var read = 0; read < Count;)
            {
                var page = SlotPage[read];
                if (page < 0)
                {
                    read++;
                    continue;
                }
                var length = PageSlots[page].Length;
                if (write != read)
                {
                    Data.AsSpan(read * Dimensions, length * Dimensions).CopyTo(Data.AsSpan(write * Dimensions));
                    Bits.AsSpan(read * Words, length * Words).CopyTo(Bits.AsSpan(write * Words));
                    Array.Copy(InverseNorms, read, InverseNorms, write, length);
                    Array.Copy(SlotPage, read, SlotPage, write, length);
                    Array.Copy(SlotChunk, read, SlotChunk, write, length);
                }
                moved[page] = (write, length);
                write += length;
                read += length;
            }
            Count = write;
            Dead = 0;
            PageSlots.Clear();
            foreach (var (page, slots) in moved) PageSlots[page] = slots;
        }
    }

    /// <summary>
    /// The workspace's pages ranked by their best chunk's cosine similarity to the question, those
    /// under the floor left out; the copy first loaded or brought up to date (under the copy's own
    /// lock, so searches of one workspace take turns; others' do not wait). <paramref name="db"/>
    /// must be in the workspace's tenant scope. Phase 13: past the threshold, only the nearest
    /// <paramref name="candidates"/> chunks by their sign bits are scored (null: the options' number;
    /// at least the live chunks: exact).
    /// </summary>
    public async Task<MeaningRanking> RankAsync(
        CgwDb db, Guid workspaceId, long generation, string model, sbyte[] query, double floor, CancellationToken ct, int? candidates = null)
    {
        var copy = copies.GetOrAdd(workspaceId, id => new Copy(id));
        await copy.Gate.WaitAsync(ct);
        try
        {
            var watch = Stopwatch.StartNew();
            var now = clock.GetUtcNow();
            var loaded = false;
            var synced = 0;
            if (!copy.Ready || copy.Generation != generation || copy.Model != model || now - copy.SyncedAt > Trusted)
            {
                await LoadAsync(db, copy, generation, model, now, ct);
                loaded = true;
            }
            else synced = await SyncAsync(db, copy, now, ct);
            copy.LastUsed = Environment.TickCount64;
            Account(copy);
            var sync = watch.Elapsed;
            watch.Restart();
            var live = copy.Count - copy.Dead;
            var wanted = candidates ?? options.Candidates;
            if (live > options.ApproximateFrom && wanted < live)
            {
                var near = Approximate(copy, query, floor, wanted);
                return new MeaningRanking(near, new MeaningTimings(loaded, synced, live, sync, watch.Elapsed, true, wanted), false);
            }
            var ranked = Score(copy, query, floor);
            return new MeaningRanking(ranked, new MeaningTimings(loaded, synced, live, sync, watch.Elapsed, false, live), true);
        }
        catch
        {
            // A copy half loaded is never trusted.
            copy.Ready = false;
            throw;
        }
        finally
        {
            copy.Gate.Release();
        }
    }

    private static async Task LoadAsync(CgwDb db, Copy copy, long generation, string model, DateTimeOffset now, CancellationToken ct)
    {
        var ws = copy.WorkspaceId;
        copy.Ready = false;
        copy.Clear();
        // The sequence first: a change committed while the rows are read is read again next time.
        var last = await db.EmbeddingChanges.AsNoTracking().Where(c => c.WorkspaceId == ws).MaxAsync(c => (long?)c.Seq, ct) ?? 0;
        // Sized once to the rows there are (Phase 13: a million chunks grown by halves held half again).
        copy.Reserve(await db.PageEmbeddings.AsNoTracking().CountAsync(e => e.WorkspaceId == ws && e.Model == model, ct));
        var rows = db.PageEmbeddings.AsNoTracking().Where(e => e.WorkspaceId == ws && e.Model == model)
            .OrderBy(e => e.PageId).ThenBy(e => e.Chunk)
            .Select(e => new { e.PageId, e.Chunk, e.Vector })
            .AsAsyncEnumerable();
        Guid? page = null;
        var chunks = new List<(int, byte[])>();
        await foreach (var row in rows.WithCancellation(ct))
        {
            if (page != row.PageId)
            {
                if (page is { } done) copy.Add(done, chunks);
                chunks.Clear();
                page = row.PageId;
            }
            chunks.Add((row.Chunk, row.Vector));
        }
        if (page is { } final) copy.Add(final, chunks);
        copy.Generation = generation;
        copy.Model = model;
        copy.LastSeq = last;
        copy.SyncedAt = now;
        copy.Ready = true;
    }

    /// <summary>Pages changed since the copy's last sequence, read again; returns how many.</summary>
    private static async Task<int> SyncAsync(CgwDb db, Copy copy, DateTimeOffset now, CancellationToken ct)
    {
        var ws = copy.WorkspaceId;
        var after = copy.LastSeq;
        var changes = await db.EmbeddingChanges.AsNoTracking().Where(c => c.WorkspaceId == ws && c.Seq > after)
            .OrderBy(c => c.Seq).Select(c => new { c.Seq, c.PageId }).Take(50_001).ToListAsync(ct);
        if (changes.Count > 50_000)
        {
            await LoadAsync(db, copy, copy.Generation, copy.Model, now, ct);
            return copy.Pages.Count;
        }
        copy.SyncedAt = now;
        if (changes.Count == 0) return 0;
        var pages = changes.Select(c => c.PageId).Distinct().ToList();
        var model = copy.Model;
        var fresh = new Dictionary<Guid, List<(int, byte[])>>();
        foreach (var chunk in pages.Chunk(1000))
        {
            var ids = chunk.ToList();
            foreach (var row in await db.PageEmbeddings.AsNoTracking().Where(e => e.WorkspaceId == ws && e.Model == model && ids.Contains(e.PageId))
                         .OrderBy(e => e.PageId).ThenBy(e => e.Chunk).Select(e => new { e.PageId, e.Chunk, e.Vector }).ToListAsync(ct))
            {
                if (!fresh.TryGetValue(row.PageId, out var list)) fresh[row.PageId] = list = [];
                list.Add((row.Chunk, row.Vector));
            }
        }
        foreach (var id in pages)
        {
            copy.Remove(id);
            if (fresh.TryGetValue(id, out var list)) copy.Add(id, list);
        }
        copy.CompactIfWorth();
        copy.LastSeq = changes[^1].Seq;
        return pages.Count;
    }

    /// <summary>Counts the copy's size against the cap, and lets the least recently used others go while over it.</summary>
    private void Account(Copy copy)
    {
        // A copy let go meanwhile (another workspace's search needed the room) is counted no more.
        if (!copies.TryGetValue(copy.WorkspaceId, out var held) || held != copy) return;
        var size = copy.Size;
        Interlocked.Add(ref total, size - copy.Accounted);
        copy.Accounted = size;
        while (Interlocked.Read(ref total) > options.CacheBytes)
        {
            var oldest = copies.Values.Where(c => c != copy).OrderBy(c => c.LastUsed).FirstOrDefault();
            if (oldest is null) break;
            if (copies.TryRemove(oldest.WorkspaceId, out var gone)) Interlocked.Add(ref total, -gone.Accounted);
        }
    }

    /// <summary>
    /// The nearest <paramref name="wanted"/> live chunks by the Hamming distance of their sign bits to
    /// the question's, scored exactly, the best chunk a page, pages best first. Distances (0 to 1,024)
    /// are counted into a histogram, so the cut is found in one pass with no sort.
    /// </summary>
    private static List<MeaningCandidate> Approximate(Copy copy, sbyte[] query, double floor, int wanted)
    {
        var count = copy.Count;
        Span<ulong> mine = stackalloc ulong[Words];
        VectorMath.SignBits(query, mine);
        var q = mine.ToArray();
        var distances = System.Buffers.ArrayPool<ushort>.Shared.Rent(count);
        try
        {
            var parts = count >= 65_536 ? Math.Min(Environment.ProcessorCount, 16) : 1;
            var size = (count + parts - 1) / parts;
            var histograms = new int[parts][];
            Parallel.For(0, parts, p =>
            {
                var histogram = histograms[p] = new int[Dimensions + 2];
                var bits = copy.Bits;
                for (int i = p * size, end = Math.Min(count, (p + 1) * size); i < end; i++)
                {
                    if (copy.SlotPage[i] < 0)
                    {
                        distances[i] = ushort.MaxValue;
                        continue;
                    }
                    var d = VectorMath.Hamming(q, bits.AsSpan(i * Words, Words));
                    distances[i] = (ushort)d;
                    histogram[d]++;
                }
            });
            // The cut: the smallest distance at which the nearest reach `wanted`.
            var cut = Dimensions;
            var below = 0;
            for (var d = 0; d <= Dimensions; d++)
            {
                var here = histograms.Sum(h => h[d]);
                if (below + here >= wanted)
                {
                    cut = d;
                    break;
                }
                below += here;
            }
            var atCut = wanted - below;
            var chosen = new List<int>(wanted);
            for (var i = 0; i < count; i++)
            {
                var d = distances[i];
                if (d < cut) chosen.Add(i);
                else if (d == cut && atCut > 0)
                {
                    chosen.Add(i);
                    atCut--;
                }
            }
            var queryNorm = VectorMath.Norm(query);
            var inverseQuery = queryNorm > 0 ? 1 / queryNorm : 0;
            var best = new Dictionary<int, (float Score, int Chunk)>();
            foreach (var i in chosen)
            {
                var score = VectorMath.Dot(query, copy.Data.AsSpan(i * Dimensions, Dimensions)) * inverseQuery * copy.InverseNorms[i];
                if (score < floor) continue;
                var page = copy.SlotPage[i];
                if (!best.TryGetValue(page, out var seen) || score > seen.Score) best[page] = (score, copy.SlotChunk[i]);
            }
            return best.Select(b => new MeaningCandidate(copy.Pages[b.Key], Math.Clamp(b.Value.Score, 0, 1), b.Value.Chunk))
                .OrderByDescending(c => c.Score).ThenBy(c => c.PageId).ToList();
        }
        finally
        {
            System.Buffers.ArrayPool<ushort>.Shared.Return(distances);
        }
    }

    /// <summary>Every live chunk scored by its integer dot product with the question, the best chunk a page, pages best first.</summary>
    private static List<MeaningCandidate> Score(Copy copy, sbyte[] query, double floor)
    {
        var count = copy.Count;
        var scores = new float[count];
        var queryNorm = VectorMath.Norm(query);
        var inverseQuery = queryNorm > 0 ? 1 / queryNorm : 0;
        void Range(int from, int to)
        {
            var data = copy.Data;
            for (var i = from; i < to; i++)
                scores[i] = copy.SlotPage[i] < 0
                    ? float.NegativeInfinity
                    : VectorMath.Dot(query, data.AsSpan(i * Dimensions, Dimensions)) * inverseQuery * copy.InverseNorms[i];
        }
        if (count >= 16_384)
        {
            var parts = Math.Min(Environment.ProcessorCount, 16);
            var size = (count + parts - 1) / parts;
            Parallel.For(0, parts, p => Range(p * size, Math.Min(count, (p + 1) * size)));
        }
        else Range(0, count);

        var best = new Dictionary<int, (float Score, int Chunk)>();
        for (var i = 0; i < count; i++)
        {
            var page = copy.SlotPage[i];
            if (page < 0 || scores[i] < floor) continue;
            if (!best.TryGetValue(page, out var seen) || scores[i] > seen.Score) best[page] = (scores[i], copy.SlotChunk[i]);
        }
        return best.Select(b => new MeaningCandidate(copy.Pages[b.Key], Math.Clamp(b.Value.Score, 0, 1), b.Value.Chunk))
            .OrderByDescending(c => c.Score).ThenBy(c => c.PageId).ToList();
    }
}

/// <summary>
/// Search by meaning (Phase 10, M10.3): the question embedded by the workspace's embeddings model
/// (one metered call, <c>search</c>), every chunk of the workspace scored exactly in the API's copy,
/// then the permission check at query time exactly as <see cref="SearchService"/>'s: the person's
/// levels (<see cref="Access.AllLevelsAsync"/>, a row by its database's), and trashed or deleted
/// pages left out by the current <c>Pages</c> rows, never the vectors, walking down the ranked pages
/// until <c>limit</c> pass. A page restricted or trashed stops counting at once. No vector is answered.
/// </summary>
public sealed class MeaningSearch(CgwDb db, Access access, EmbeddingsService embeddings, EmbeddingsCache cache, IEmbeddingProvider provider, EmbeddingsOptions options, TimeProvider clock)
{
    public const int DefaultLimit = 10;
    public const int MaxLimit = 20;

    /// <summary>The route's search, in the contract's order of checks; the caller is a member in the workspace's scope.</summary>
    public async Task<Result<MeaningOutcome>> SearchAsync(Member member, string? q, int? limit, CancellationToken ct = default)
    {
        if (member.IsGuest) return Failure.Denied("Guests do not search the workspace by meaning");
        var row = await db.AiSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        if (!embeddings.On(row)) return new Failure(Codes.AiDisabled, 403, "Search by meaning is off for this workspace");
        var question = (q ?? "").Trim();
        if (question.Length is 0 or > EmbeddingsOptions.MaxQuestion) return Failure.Invalid("q is 1 to 1,000 characters");
        if (limit is < 1 or > MaxLimit) return Failure.Invalid("limit is 1 to 20");
        var embedded = await EmbedQuestionAsync(member, row!, question, ct);
        if (!embedded.Ok) return embedded.Failure!;
        var (vector, took) = embedded.Value;
        var (hits, timings) = await RankedHitsAsync(member, row!, vector, limit ?? DefaultLimit, ct);
        return new MeaningOutcome(new MeaningResultDto(hits), took, timings);
    }

    /// <summary>
    /// The ranked pages the person may read, at most <paramref name="limit"/>. An approximate ranking
    /// whose pages the permission check turned away, leaving too few, is asked again eight times as
    /// wide, until the pages are enough or the ranking is exact (Phase 13: over-fetching for the
    /// permission filter). One that found too few above the floor is not: the nearest chunks by their
    /// bits are where pages above it are.
    /// </summary>
    private async Task<(List<SearchHitDto> Hits, MeaningTimings Timings)> RankedHitsAsync(Member member, AiSettings row, sbyte[] vector, int limit, CancellationToken ct)
    {
        var model = embeddings.ModelOf(row);
        int? candidates = null;
        while (true)
        {
            var ranking = await cache.RankAsync(db, member.WorkspaceId, row.EmbeddingsGeneration, model, vector, options.FloorOf(model), ct, candidates);
            var hits = await HitsAsync(member, ranking.Ranked, limit, ct);
            if (hits.Count >= limit || ranking.Complete || hits.Count == ranking.Ranked.Count) return (hits, ranking.Timings);
            candidates = (int)Math.Min(int.MaxValue / 2, (long)ranking.Timings.Scored * 8);
        }
    }

    /// <summary>
    /// <c>ask</c>'s pages by meaning (decisions, 2026-11-18: when completions and embeddings are both
    /// on), best first, at most <paramref name="limit"/>, each one the person can read; empty when
    /// embeddings are off or the provider fails (the word search's pages still go).
    /// </summary>
    public async Task<IReadOnlyList<SearchHitDto>> ForAskAsync(Member member, string question, int limit, CancellationToken ct = default)
    {
        var row = await db.AiSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        if (member.IsGuest || !embeddings.On(row)) return [];
        var text = question.Trim();
        if (text.Length is 0 or > EmbeddingsOptions.MaxQuestion) return [];
        var embedded = await EmbedQuestionAsync(member, row!, text, ct);
        if (!embedded.Ok) return [];
        return (await RankedHitsAsync(member, row!, embedded.Value.Vector, limit, ct)).Hits;
    }

    /// <summary>One provider call for the question (input type <c>query</c>), metered however it ends.</summary>
    private async Task<Result<(sbyte[] Vector, TimeSpan Took)>> EmbedQuestionAsync(Member member, AiSettings row, string question, CancellationToken ct)
    {
        if (embeddings.KeyFor(member.WorkspaceId, row) is not { } key)
            return new Failure(Codes.AiKeyInvalid, 502, "The workspace's embeddings key could not be read: enter it again");
        var model = embeddings.ModelOf(row);
        var watch = Stopwatch.StartNew();
        try
        {
            var result = await provider.EmbedAsync(new EmbeddingCall([question], EmbeddingCall.Query, model, key), ct);
            await MeterAsync(member, model, "ok", result.Tokens, watch.Elapsed);
            return (result.Vectors[0], result.Took);
        }
        catch (AiProviderException error)
        {
            await MeterAsync(member, model, error.Code, 0, watch.Elapsed);
            return new Failure(error.Code, error.Code == Codes.AiLimit ? 503 : 502, error.Code switch
            {
                Codes.AiKeyInvalid => "The embeddings provider refused the workspace's key",
                Codes.AiLimit => "The embeddings provider is busy; try again later",
                _ => "The embeddings provider failed",
            });
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            await MeterAsync(member, model, "cancelled", 0, watch.Elapsed);
            throw;
        }
    }

    private async Task MeterAsync(Member member, string model, string outcome, long tokens, TimeSpan took)
    {
        db.AiUsage.Add(new AiUsage
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            UserId = member.UserId,
            Action = EmbeddingActions.Search,
            Model = model,
            InputTokens = tokens,
            Outcome = outcome,
            DurationMs = (int)Math.Min(int.MaxValue, took.TotalMilliseconds),
            CreatedAt = clock.GetUtcNow(),
        });
        await db.SaveChangesAsync(CancellationToken.None);
    }

    private sealed record Live(Guid Id, string Title, string Kind, Guid? ParentPageId);

    /// <summary>The ranked pages the person may read now, best first, until <paramref name="limit"/> pass, each with its best chunk's own text.</summary>
    private async Task<List<SearchHitDto>> HitsAsync(Member member, List<MeaningCandidate> ranked, int limit, CancellationToken ct)
    {
        if (ranked.Count == 0) return [];
        var levels = await access.AllLevelsAsync(member);
        // Rows are not in it: a row found has its database's (its parent's) level.
        string Level(Live page) =>
            page.Kind == PageKinds.Row
                ? page.ParentPageId is { } d ? levels.GetValueOrDefault(d, Levels.None) : Levels.None
                : levels.GetValueOrDefault(page.Id, Levels.None);
        var passed = new List<(MeaningCandidate Candidate, Live Page)>();
        var batch = Math.Max(limit * 3, 60);
        for (var at = 0; at < ranked.Count && passed.Count < limit; at += batch)
        {
            var slice = ranked.Skip(at).Take(batch).ToList();
            var ids = slice.Select(c => c.PageId).ToList();
            var pages = await db.Pages.AsNoTracking().Where(p => ids.Contains(p.Id) && p.TrashedAt == null && p.DeletedAt == null)
                .Select(p => new Live(p.Id, p.Title, p.Kind, p.ParentPageId)).ToDictionaryAsync(p => p.Id, ct);
            foreach (var candidate in slice)
            {
                if (!pages.TryGetValue(candidate.PageId, out var page) || Level(page) == Levels.None) continue;
                passed.Add((candidate, page));
                if (passed.Count == limit) break;
            }
        }
        if (passed.Count == 0) return [];
        // The best chunk's own text: the page's text cut as the worker cuts it (a chunk depends only
        // on the text before it and 2,000 characters after, so a prefix is enough); a row's values
        // first, as the worker embeds them (Phase 13).
        var hitIds = passed.Select(p => p.Page.Id).ToList();
        var length = (passed.Max(p => p.Candidate.Chunk) + 2) * EmbeddingText.Target;
        var texts = await db.PageDocDerived.AsNoTracking().Where(d => hitIds.Contains(d.PageId))
            .Select(d => new { d.PageId, Text = d.PlainText.Substring(0, length) })
            .ToDictionaryAsync(d => d.PageId, d => d.Text, ct);
        var values = await EmbeddingValues.ForRowsAsync(db, passed.Where(p => p.Page.Kind == PageKinds.Row).Select(p => p.Page.Id).ToList(), ct);
        return passed.Select(p =>
        {
            var text = texts.GetValueOrDefault(p.Page.Id);
            if (values.TryGetValue(p.Page.Id, out var row)) text = EmbeddingValues.Body(row.Text, text);
            var chunks = EmbeddingText.Chunks(p.Page.Title, text);
            var own = chunks.Count == 0 ? "" : chunks[Math.Min(p.Candidate.Chunk, chunks.Count - 1)].Own;
            Guid? databaseId = p.Page.Kind == PageKinds.Row ? p.Page.ParentPageId : null;
            return new SearchHitDto(p.Page.Id, p.Page.Title, EmbeddingText.Snippet(own), p.Candidate.Score, p.Page.Kind, databaseId);
        }).ToList();
    }
}
