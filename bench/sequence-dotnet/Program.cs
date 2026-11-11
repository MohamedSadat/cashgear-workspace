// Spike S8: does a gap-free per-page sequence, assigned under a lock on the page row, let a
// reader that pulls "updates after N" ever miss one? 50 writers push to one page while readers
// pull with no repair. Run under plain READ COMMITTED and under READ_COMMITTED_SNAPSHOT (Azure
// SQL's default), and against a control that takes numbers from an IDENTITY column without the
// lock, which the plan expects to lose updates (SYNC_DESIGN.md, D15).
//   dotnet run -- "Server=(localdb)\MSSQLLocalDB;Integrated Security=true" <results.json>
// It creates the scratch database cgw_spike_s8 and drops it at the end.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;

var server = args.Length > 0 ? args[0] : @"Server=(localdb)\MSSQLLocalDB;Integrated Security=true;TrustServerCertificate=true";
var output = args.Length > 1 ? args[1] : "s8.json";
const string Database = "cgw_spike_s8";
const int Writers = 50;
const int PushesPerWriter = 40;
const int Readers = 8;

async Task Exec(string connection, string sql)
{
    await using var c = new SqlConnection(connection);
    await c.OpenAsync();
    await using var cmd = new SqlCommand(sql, c) { CommandTimeout = 120 };
    await cmd.ExecuteNonQueryAsync();
}

await Exec(server, $"IF DB_ID('{Database}') IS NOT NULL BEGIN ALTER DATABASE [{Database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{Database}]; END; CREATE DATABASE [{Database}];");
var db = new SqlConnectionStringBuilder(server) { InitialCatalog = Database, MaxPoolSize = 200 }.ConnectionString;
var results = new JsonObject { ["sqlServer"] = await Scalar(db, "SELECT @@VERSION") };

async Task<string> Scalar(string connection, string sql)
{
    await using var c = new SqlConnection(connection);
    await c.OpenAsync();
    await using var cmd = new SqlCommand(sql, c);
    return (await cmd.ExecuteScalarAsync())?.ToString() ?? "";
}

try
{
    foreach (var (name, rcsi, locked) in new[]
    {
        ("page-row lock, READ COMMITTED", false, true),
        ("page-row lock, READ_COMMITTED_SNAPSHOT", true, true),
        ("control: IDENTITY, no lock, READ_COMMITTED_SNAPSHOT", true, false),
    })
    {
        await Exec(server, $"ALTER DATABASE [{Database}] SET READ_COMMITTED_SNAPSHOT {(rcsi ? "ON" : "OFF")} WITH ROLLBACK IMMEDIATE;");
        await Exec(db, """
            IF OBJECT_ID('PageDocUpdates') IS NOT NULL DROP TABLE PageDocUpdates;
            IF OBJECT_ID('PageDocUpdatesIdentity') IS NOT NULL DROP TABLE PageDocUpdatesIdentity;
            IF OBJECT_ID('Pages') IS NOT NULL DROP TABLE Pages;
            CREATE TABLE Pages (PageId uniqueidentifier NOT NULL PRIMARY KEY, HeadSeq bigint NOT NULL);
            CREATE TABLE PageDocUpdates (
              PageId uniqueidentifier NOT NULL, Seq bigint NOT NULL, UpdateId uniqueidentifier NOT NULL UNIQUE,
              Data varbinary(max) NOT NULL, PRIMARY KEY (PageId, Seq));
            CREATE TABLE PageDocUpdatesIdentity (
              Seq bigint IDENTITY(1,1) NOT NULL PRIMARY KEY, PageId uniqueidentifier NOT NULL,
              UpdateId uniqueidentifier NOT NULL UNIQUE, Data varbinary(max) NOT NULL);
            """);
        var page = Guid.NewGuid();
        await Exec(db, $"INSERT INTO Pages VALUES ('{page}', 0)");
        var table = locked ? "PageDocUpdates" : "PageDocUpdatesIdentity";

        var done = false;
        var pushed = new ConcurrentBag<long>();
        var pushTimes = new ConcurrentBag<double>();
        var random = new Random(7);

        async Task Writer(int writer)
        {
            var rnd = new Random(writer);
            for (var i = 0; i < PushesPerWriter; i++)
            {
                var batch = rnd.Next(1, 4);
                var watch = Stopwatch.StartNew();
                await using var c = new SqlConnection(db);
                await c.OpenAsync();
                await using var tx = (SqlTransaction)await c.BeginTransactionAsync();
                if (locked)
                {
                    // SYNC_DESIGN.md, push step 6: lock the page row, take the next numbers.
                    await using var head = new SqlCommand("SELECT HeadSeq FROM Pages WITH (UPDLOCK, ROWLOCK) WHERE PageId = @p", c, tx);
                    head.Parameters.AddWithValue("@p", page);
                    var seq = (long)(await head.ExecuteScalarAsync())!;
                    for (var b = 0; b < batch; b++)
                    {
                        seq++;
                        await using var insert = new SqlCommand("INSERT INTO PageDocUpdates (PageId, Seq, UpdateId, Data) VALUES (@p, @s, @u, @d)", c, tx);
                        insert.Parameters.AddWithValue("@p", page);
                        insert.Parameters.AddWithValue("@s", seq);
                        insert.Parameters.AddWithValue("@u", Guid.NewGuid());
                        insert.Parameters.AddWithValue("@d", new byte[rnd.Next(20, 400)]);
                        await insert.ExecuteNonQueryAsync();
                        pushed.Add(seq);
                    }
                    // Hold the transaction open a little, as a real push does its other work.
                    await Task.Delay(rnd.Next(0, 4));
                    await using var move = new SqlCommand("UPDATE Pages SET HeadSeq = @s WHERE PageId = @p", c, tx);
                    move.Parameters.AddWithValue("@s", seq);
                    move.Parameters.AddWithValue("@p", page);
                    await move.ExecuteNonQueryAsync();
                }
                else
                {
                    for (var b = 0; b < batch; b++)
                    {
                        await using var insert = new SqlCommand("INSERT INTO PageDocUpdatesIdentity (PageId, UpdateId, Data) OUTPUT INSERTED.Seq VALUES (@p, @u, @d)", c, tx);
                        insert.Parameters.AddWithValue("@p", page);
                        insert.Parameters.AddWithValue("@u", Guid.NewGuid());
                        insert.Parameters.AddWithValue("@d", new byte[rnd.Next(20, 400)]);
                        pushed.Add((long)(await insert.ExecuteScalarAsync())!);
                    }
                    await Task.Delay(rnd.Next(0, 4));
                }
                await tx.CommitAsync();
                pushTimes.Add(watch.Elapsed.TotalMilliseconds);
            }
        }

        // A reader pulls "after N", moves N to the highest it received, and never repairs.
        async Task<(long seen, long missed, long pulls)> Reader(int reader)
        {
            var after = 0L;
            var seen = new HashSet<long>();
            var missed = 0L;
            var pulls = 0L;
            var finalPass = false;
            while (true)
            {
                var last = done;
                await using var c = new SqlConnection(db);
                await c.OpenAsync();
                await using var cmd = new SqlCommand($"SELECT Seq FROM {table} WHERE PageId = @p AND Seq > @a ORDER BY Seq", c);
                cmd.Parameters.AddWithValue("@p", page);
                cmd.Parameters.AddWithValue("@a", after);
                await using var r = await cmd.ExecuteReaderAsync();
                var expected = after + 1;
                while (await r.ReadAsync())
                {
                    var seq = r.GetInt64(0);
                    if (seq != expected) missed += seq - expected; // a gap below the new cursor: lost for good
                    seen.Add(seq);
                    after = seq;
                    expected = seq + 1;
                }
                pulls++;
                if (finalPass) break;
                if (last) finalPass = true;
            }
            return (seen.Count, missed, pulls);
        }

        var watchAll = Stopwatch.StartNew();
        var readers = Enumerable.Range(0, Readers).Select(Reader).ToArray();
        await Task.WhenAll(Enumerable.Range(0, Writers).Select(Writer));
        done = true;
        var readerResults = await Task.WhenAll(readers);
        var total = pushed.Count;
        // In the control, numbers skipped by rolled-back or still-open inserts are not losses;
        // a reader "misses" only numbers that do exist in the table.
        var existing = new HashSet<long>();
        await using (var c = new SqlConnection(db))
        {
            await c.OpenAsync();
            await using var cmd = new SqlCommand($"SELECT Seq FROM {table} WHERE PageId = @p", c);
            cmd.Parameters.AddWithValue("@p", page);
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync()) existing.Add(r.GetInt64(0));
        }
        var times = pushTimes.Order().ToList();
        results[name] = new JsonObject
        {
            ["writers"] = Writers,
            ["updates"] = total,
            ["rowsInTable"] = existing.Count,
            ["gapFree"] = existing.Count == total && existing.Max() == total,
            ["readers"] = Readers,
            ["readerSawAll"] = new JsonArray(readerResults.Select(r => (JsonNode)(r.seen == existing.Count)).ToArray()),
            ["readerMissed"] = new JsonArray(readerResults.Select(r => (JsonNode)(existing.Count - r.seen)).ToArray()),
            ["readerPulls"] = new JsonArray(readerResults.Select(r => (JsonNode)r.pulls).ToArray()),
            ["pushP50Ms"] = Math.Round(times[times.Count / 2], 1),
            ["pushP95Ms"] = Math.Round(times[(int)(times.Count * 0.95)], 1),
            ["seconds"] = Math.Round(watchAll.Elapsed.TotalSeconds, 1),
        };
        Console.WriteLine($"{name}: {results[name]!.ToJsonString()}");
    }
}
finally
{
    await Exec(server, $"IF DB_ID('{Database}') IS NOT NULL BEGIN ALTER DATABASE [{Database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{Database}]; END;");
    results["scratchDatabaseDropped"] = await Scalar(server, $"SELECT CASE WHEN DB_ID('{Database}') IS NULL THEN 'yes' ELSE 'no' END");
}
File.WriteAllText(output, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
var lockedRuns = new[] { "page-row lock, READ COMMITTED", "page-row lock, READ_COMMITTED_SNAPSHOT" };
var pass = lockedRuns.All(n => results[n]!["readerMissed"]!.AsArray().All(m => (long)m! == 0));
Console.WriteLine(pass ? "S8: no reader missed an update under the page-row lock." : "S8: a reader missed an update.");
return pass ? 0 : 1;
