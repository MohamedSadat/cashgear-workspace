using System.Data;
using System.Runtime.InteropServices;
using Cgw.Core.Data;
using Microsoft.Data.SqlClient;

namespace Cgw.Tests;

/// <summary>
/// Vectors for the approximate index's tests and Phase 13's bench: clustered as real embeddings are
/// (topics, each of subtopics, each chunk its subtopic's direction with noise of its own), quantised
/// as Voyage's int8 (scaled so the largest value is 127), and written straight into a workspace's
/// pages and <c>PageEmbeddings</c> (the worker would take hours of provider calls).
/// </summary>
public sealed class VectorKit(int seed, int topics, int subtopicsEach)
{
    public const int Dimensions = 1024;
    private readonly Random random = new(seed);
    private readonly float[][] subtopics = Make(new Random(seed + 1), topics, subtopicsEach);

    public int Subtopics => subtopics.Length;

    private static float[] Gaussian(Random random)
    {
        var v = new float[Dimensions];
        for (var i = 0; i < Dimensions; i += 2)
        {
            var u1 = 1.0 - random.NextDouble();
            var u2 = random.NextDouble();
            var r = Math.Sqrt(-2.0 * Math.Log(u1));
            v[i] = (float)(r * Math.Cos(2 * Math.PI * u2));
            v[i + 1] = (float)(r * Math.Sin(2 * Math.PI * u2));
        }
        return Normalised(v);
    }

    private static float[] Normalised(float[] v)
    {
        var norm = MathF.Sqrt(v.Sum(x => x * x));
        for (var i = 0; i < v.Length; i++) v[i] /= norm;
        return v;
    }

    private static float[] Mix(float[] a, float[] b, float weight)
    {
        var v = new float[Dimensions];
        for (var i = 0; i < Dimensions; i++) v[i] = a[i] + weight * b[i];
        return Normalised(v);
    }

    /// <summary>Each topic's subtopics: the topic's direction and one of their own, weighted alike.</summary>
    private static float[][] Make(Random random, int topics, int each)
    {
        var all = new List<float[]>();
        for (var t = 0; t < topics; t++)
        {
            var topic = Gaussian(random);
            for (var s = 0; s < each; s++) all.Add(Mix(topic, Gaussian(random), 0.9f));
        }
        return all.ToArray();
    }

    /// <summary>A vector as Voyage's int8: scaled so its largest value is 127.</summary>
    public static sbyte[] Int8(float[] v)
    {
        var max = v.Max(MathF.Abs);
        var q = new sbyte[Dimensions];
        for (var i = 0; i < Dimensions; i++) q[i] = (sbyte)Math.Clamp(MathF.Round(v[i] / max * 127), -127, 127);
        return q;
    }

    /// <summary>A chunk of a subtopic: its direction with noise of about its own weight.</summary>
    public sbyte[] Chunk(int subtopic) => Int8(Mix(subtopics[subtopic], Gaussian(random), 0.8f + 0.4f * (float)random.NextDouble()));

    /// <summary>A question near a subtopic.</summary>
    public sbyte[] Question(int subtopic) => Int8(Mix(subtopics[subtopic], Gaussian(random), 0.8f));

    public int NextSubtopic() => random.Next(subtopics.Length);

    /// <summary>
    /// Pages of the workspace's shared section with <paramref name="perPage"/> chunks each of one
    /// subtopic, model <paramref name="model"/>, written in batches; their ids in order.
    /// </summary>
    public async Task<List<Guid>> SeedAsync(ServerFixture server, Ws ws, int chunks, int perPage, string model = "voyage-4")
    {
        var pages = (chunks + perPage - 1) / perPage;
        var ids = Enumerable.Range(0, pages).Select(_ => Guid.CreateVersion7()).ToList();
        var now = DateTimeOffset.UtcNow;
        await using (var db = server.NewDb(ws.Id))
            foreach (var batch in ids.Select((id, i) => (id, i)).Chunk(2000))
            {
                db.Pages.AddRange(batch.Select(p => new Page
                {
                    Id = p.id,
                    WorkspaceId = ws.Id,
                    SectionId = ws.Shared,
                    OrderKey = "a" + p.i.ToString("D7", System.Globalization.CultureInfo.InvariantCulture),
                    Title = $"Vector page {p.i}",
                    SearchTitle = $"vector page {p.i}",
                    CreatedBy = ws.Account.Id,
                    UpdatedBy = ws.Account.Id,
                    CreatedAt = now,
                    UpdatedAt = now,
                }));
                await db.SaveChangesAsync();
                db.ChangeTracker.Clear();
            }
        var workspace = GuidBytes.ToBytes(ws.Id);
        var written = 0;
        var table = NewTable();
        async Task FlushAsync()
        {
            if (table.Rows.Count == 0) return;
            using var bulk = new SqlBulkCopy(server.SqlConnection) { DestinationTableName = "PageEmbeddings", BatchSize = 10_000, BulkCopyTimeout = 1200 };
            foreach (DataColumn column in table.Columns) bulk.ColumnMappings.Add(column.ColumnName, column.ColumnName);
            await bulk.WriteToServerAsync(table);
            table = NewTable();
        }
        foreach (var page in ids)
        {
            var subtopic = NextSubtopic();
            for (var c = 0; c < perPage && written < chunks; c++, written++)
                table.Rows.Add(workspace, GuidBytes.ToBytes(page), c, model, new byte[32], MemoryMarshal.AsBytes<sbyte>(Chunk(subtopic)).ToArray(), 1L, 1L, 0L, now);
            if (table.Rows.Count >= 50_000) await FlushAsync();
        }
        await FlushAsync();
        return ids;
    }

    private static DataTable NewTable()
    {
        var table = new DataTable();
        foreach (var (name, type) in new (string, Type)[] { ("WorkspaceId", typeof(byte[])), ("PageId", typeof(byte[])), ("Chunk", typeof(int)), ("Model", typeof(string)),
                     ("TextHash", typeof(byte[])), ("Vector", typeof(byte[])), ("TextVersion", typeof(long)), ("PageVersion", typeof(long)), ("SchemaVersion", typeof(long)), ("CreatedAt", typeof(DateTimeOffset)) })
            table.Columns.Add(name, type);
        return table;
    }

    /// <summary>How many of the exact ranking's first ten pages the other's first ten hold, of ten (or of fewer when exact has fewer).</summary>
    public static double Recall(IReadOnlyList<Guid> exact, IReadOnlyList<Guid> approximate)
    {
        var first = exact.Take(10).ToList();
        if (first.Count == 0) return 1;
        var found = approximate.Take(10).ToHashSet();
        return first.Count(found.Contains) / (double)first.Count;
    }
}
