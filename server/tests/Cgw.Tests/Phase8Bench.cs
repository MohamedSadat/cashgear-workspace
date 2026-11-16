using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Documents;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Cgw.Ydoc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Cgw.Tests;

/// <summary>
/// Phase 8's server work per push (M8.1; PROGRESS.md, Phase 6: about 55 ms of the API's CPU and
/// 45 ms of the worker's a push on the reference machine). One person types into a page of about
/// 33 KB with a history (fixtures/make-typing.mjs), one key a push through the hub, paced at a key
/// every 35 ms as the Phase 6 measurement typed; another member has the page open. Each key's work
/// runs in the order the stack runs it, each step alone in this process so its CPU is its own: the
/// API's push, the worker's validation pass (and the empty pass the loop runs straight after one that
/// found work), the relay's pass that sends the frame (both connections receive it), then an idle
/// relay pass and an idle validation poll; the derive, compaction and state hash jobs at their
/// loops' intervals. The relay and the worker's loops do not run by themselves here (the relay of
/// <see cref="RealtimeKit.Manual"/>, the worker's jobs only when called). CPU is this process's
/// (cycles, scaled to time over the whole run) and LocalDB's when it can be read; SQL statements are
/// counted from SqlClient's diagnostics. The in-process client's own share (SignalR's client, the
/// frames it reads) is in the API's steps, the same before and after.
/// Runs only when PHASE8_BENCH is set; build with <c>-c Release</c>. PHASE8_LABEL names the run
/// (before, after) in bench/results/phase8-server.json; PHASE8_BLOCKS and PHASE8_KEYS size it, and
/// PHASE8_WARMUP is the keys not measured (40). A short run measures the JIT, not the code: the
/// figures compared before and after are of 900 keys after 450 (PHASE8_KEYS=900 PHASE8_WARMUP=450).
/// </summary>
[Collection(Phase2BenchCollection.Name)]
public sealed class Phase8Bench(ServerFixture server)
{
    private static readonly bool Asked = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PHASE8_BENCH"));
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    /// <summary>The Phase 6 measurement's typing: a key every 35 ms.</summary>
    private const int KeyMs = 35;
    private const int RelayMs = 20;
    private const int ValidateIdleMs = 25;

    private static int Setting(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

    private sealed record Corpus(List<long> Clients, long Client, string Base, int BaseBytes, int Blocks, int History, List<string> Edits, int FinalBytes);

    [Fact]
    public async Task Cpu_per_push_of_the_API_and_the_worker()
    {
        Assert.SkipWhen(!Asked, "Set PHASE8_BENCH=1");
        var blocks = Setting("PHASE8_BLOCKS", 100);
        var keys = Setting("PHASE8_KEYS", 300);
        var warmup = Math.Min(Setting("PHASE8_WARMUP", 40), keys / 2);
        var corpus = MakeCorpus(blocks, keys);
        var edits = corpus.Edits.Select(Convert.FromBase64String).ToList();

        // The page: its base written and validated over HTTP, then derived.
        var ws = await Ws.Create(server);
        var reader = await Kit.Join(server, ws, "member");
        var page = (await ws.NewPage("Typed into")).GetProperty("id").GetGuid();
        await Kit.Register(ws.Client, ws.Id, [.. corpus.Clients, corpus.Client]);
        await Kit.PushOk(ws.Client, page, Convert.FromBase64String(corpus.Base));
        await server.RunJob<ValidateJob>();
        await Kit.Derive(server, ws.Id, page);

        await using var api = RealtimeKit.Manual(server);
        var relay = RealtimeKit.Relay(api);
        await using var typist = await HubClient.Connect(api, await RealtimeKit.SignedIn(api, ws.Account));
        await using var other = await HubClient.Connect(api, await RealtimeKit.SignedIn(api, reader));
        foreach (var hub in new[] { typist, other })
        {
            await hub.Ok("JoinWorkspaces", new[] { ws.Id });
            await hub.Ok("JoinPage", page.ToString());
        }
        await relay.PassAsync();

        var logger = server.Worker.GetRequiredService<ILoggerFactory>().CreateLogger("bench");
        var validate = Kit.Job<ValidateJob>(server);
        var derive = Kit.Job<DeriveJob>(server);
        var compact = Kit.Job<CompactJob>(server);
        var hash = Kit.Job<StateHashJob>(server);
        var records = new[] { validate, (IJob)derive, compact, hash }.ToDictionary(j => j.Name, _ => new JobLoop.JobRecord());
        async Task<bool> Run(IJob job) =>
            await JobLoop.RunOnceAsync(server.Worker, job, logger, TimeProvider.System, CancellationToken.None, records[job.Name]);

        using var meter = new Meter();
        var paced = Stopwatch.StartNew();
        for (var i = 0; i < keys; i++)
        {
            var wait = TimeSpan.FromMilliseconds(KeyMs * (long)i) - paced.Elapsed;
            if (wait > TimeSpan.Zero) await Task.Delay(wait);
            meter.Counting = i >= warmup;
            var push = RealtimeKit.Push(0, 1, (Guid.CreateVersion7(), edits[i]));
            await meter.Step("push", () => typist.Ok("PushUpdates", page.ToString(), push));
            // The loop goes again at once after a pass that found work, and that pass finds none.
            await meter.Step("validate", async () =>
            {
                while (await Run(validate)) { }
            });
            await meter.Step("relay", async () =>
            {
                await relay.PassAsync();
                foreach (var hub in new[] { typist, other })
                    await HubClient.Next(hub.Updates, f => f.GetProperty("cursor").GetInt64() == i + 2);
            });
            await meter.Step("relayIdle", () => relay.PassAsync());
            await meter.Step("validateIdle", () => Run(validate));
            // Not in the model: a hub call that reads nothing (a page never joined left), the floor
            // under the push's own figure (this process's SignalR client and server, the JSON).
            var nowhere = Guid.NewGuid().ToString();
            await meter.Step("hubFloor", () => typist.Ok("LeavePage", nowhere));
            // The shared loop's jobs at their intervals: derive every 500 ms, compaction every 2 s,
            // the state hash every 5 s (in keys at 35 ms).
            if (i % (500 / KeyMs) == 0) await meter.Step("derive", () => Run(derive));
            if (i % (2000 / KeyMs) == 0) await meter.Step("compact", () => Run(compact));
            if (i % (5000 / KeyMs) == 0) await meter.Step("stateHash", () => Run(hash));
        }
        var measured = keys - warmup;
        var stages = meter.Report(measured);

        // Per push, by the loops' timing: the relay polls every 20 ms and the validation loop every
        // 25 ms when idle, at a key every 35 ms.
        double PerKey(string name) => meter.Total(name).CpuMs / measured;
        double SqlPerKey(string name) => meter.Total(name).SqlMs / measured;
        double CommandsPerKey(string name) => (double)meter.Total(name).Commands / measured;
        var relayIdle = (double)KeyMs / RelayMs - 1;
        var validateIdle = Math.Max(0, (double)KeyMs / ValidateIdleMs - 1);
        var apiCpu = PerKey("push") + PerKey("relay") + relayIdle * PerKey("relayIdle");
        var workerCpu = PerKey("validate") + validateIdle * PerKey("validateIdle") + PerKey("derive") + PerKey("compact") + PerKey("stateHash");
        var sql = SqlPerKey("push") + SqlPerKey("relay") + relayIdle * SqlPerKey("relayIdle")
            + SqlPerKey("validate") + validateIdle * SqlPerKey("validateIdle") + SqlPerKey("derive") + SqlPerKey("compact") + SqlPerKey("stateHash");

        var result = new JsonObject
        {
            ["corpus"] = new JsonObject
            {
                ["blocks"] = corpus.Blocks,
                ["history"] = corpus.History,
                ["baseBytes"] = corpus.BaseBytes,
                ["finalBytes"] = corpus.FinalBytes,
                ["keys"] = keys,
                ["measured"] = measured,
                ["keyMs"] = KeyMs,
            },
            ["perPush"] = new JsonObject
            {
                ["apiCpuMs"] = Math.Round(apiCpu, 2),
                ["workerCpuMs"] = Math.Round(workerCpu, 2),
                ["sqlServerCpuMs"] = meter.SqlReadable ? Math.Round(sql, 2) : null,
                ["apiSqlStatements"] = Math.Round(CommandsPerKey("push") + CommandsPerKey("relay") + relayIdle * CommandsPerKey("relayIdle"), 2),
                ["workerSqlStatements"] = Math.Round(CommandsPerKey("validate") + validateIdle * CommandsPerKey("validateIdle")
                    + CommandsPerKey("derive") + CommandsPerKey("compact") + CommandsPerKey("stateHash"), 2),
                ["model"] = $"api: push + relay + {relayIdle:0.##} x relayIdle; worker: validate + {validateIdle:0.##} x validateIdle + derive, compact and stateHash at their intervals",
                // The API's figure less one hub call that reads nothing: closer to what the API
                // process alone spends, with the in-process client's share of the push taken out.
                ["apiCpuMsLessHubFloor"] = Math.Round(apiCpu - PerKey("hubFloor"), 2),
            },
            ["stages"] = stages,
            ["yjsOfOnePass"] = YjsOfOnePass(Convert.FromBase64String(corpus.Base), edits, warmup),
            ["cpuScale"] = meter.Scale(),
        };
        Record(Environment.GetEnvironmentVariable("PHASE8_LABEL") is { Length: > 0 } label ? label : "run", result);

        // Nothing it decided was refused, and the reader has every key.
        await using var db = server.NewDb(ws.Id);
        Assert.Equal(keys + 1, db.PageDocUpdates.Count(u => u.PageId == page && u.Status == Cgw.Core.Data.UpdateStatus.Valid)
            + db.PageDocSnapshots.Where(s => s.PageId == page).Select(s => (long?)s.UpToSeq).Max().GetValueOrDefault());
    }

    /// <summary>
    /// The Yjs calls 0.7.0's validation pass makes for one key on this page, alone (no SQL, no EF):
    /// what share of a pass the document's loads are; and Phase 8's (with a build that has them).
    /// </summary>
    private static JsonObject YjsOfOnePass(byte[] baseState, List<byte[]> edits, int at)
    {
        var state = Yjs.Merge([baseState, .. edits.Take(at)]);
        var update = edits[at];
        var policy = new ValidationPolicy([], Schema.For(1)!, DocService.MaxUpdateBytes, true);
        var calls = new Dictionary<string, Func<object>>
        {
            ["stateVector"] = () => Yjs.StateVector(state),
            ["diff"] = () => Yjs.Diff(update, Yjs.StateVector(state)),
            ["merge"] = () => Yjs.Merge([state, update]),
            ["meta"] = () => Yjs.Meta(Yjs.Merge([state, update])),
            ["validate"] = () => Yjs.Validate(state, update, policy),
            ["stateHash"] = () => Yjs.StateHash(Yjs.Merge([state, update])),
        };
        var merged = Yjs.Merge([state, update]);
        var pass = new Func<object>(() =>
        {
            var added = Yjs.Diff(update, Yjs.StateVector(state));
            _ = Yjs.ClientRanges(added);
            var next = Yjs.Merge([state, update]);
            _ = Yjs.Meta(next);
            _ = Yjs.Validate(state, update, policy);
            return Yjs.StateHash(next);
        });
        var result = new JsonObject { ["stateBytes"] = state.Length };
        double Time(Func<object> call)
        {
            for (var i = 0; i < 20; i++) call();
            var runs = 200;
            var started = Stopwatch.GetTimestamp();
            for (var i = 0; i < runs; i++) call();
            return Stopwatch.GetElapsedTime(started).TotalMilliseconds / runs;
        }
        foreach (var (name, call) in calls) result[name + "Ms"] = Math.Round(Time(call), 3);
        result["passMs"] = Math.Round(Time(pass), 3);
        // Phase 8's pass for the same key: the vector kept from the last pass, one merge, one load
        // for the meta, the tree and the state hash.
        var vector = Yjs.StateVector(state);
        var now = new Func<object>(() =>
        {
            var added = Yjs.Diff(update, vector);
            _ = Yjs.ClientRanges(added);
            var next = Yjs.Merge([state, update]);
            using var document = YDocument.Load(next);
            _ = document.Meta();
            _ = document.Check(policy);
            return document.StateHash();
        });
        result["phase8PassMs"] = Math.Round(Time(now), 3);
        GC.KeepAlive(merged);
        return result;
    }

    private Corpus MakeCorpus(int blocks, int keys)
    {
        var file = Path.Combine(Path.GetTempPath(), $"cgw-phase8-{Guid.NewGuid():N}.json");
        var script = Path.Combine(AppContext.BaseDirectory, "fixtures", "make-typing.mjs");
        using var node = Process.Start(new ProcessStartInfo("node", [script, file, blocks.ToString(), keys.ToString()])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        }) ?? throw new InvalidOperationException("node did not start");
        var error = node.StandardError.ReadToEndAsync();
        node.StandardOutput.ReadToEnd();
        node.WaitForExit();
        Assert.True(node.ExitCode == 0, error.Result);
        try
        {
            return JsonSerializer.Deserialize<Corpus>(File.ReadAllText(file), Web)!;
        }
        finally
        {
            File.Delete(file);
        }
    }

    private void Record(string label, JsonNode value)
    {
        var file = Path.Combine(server.Root, "bench", "results", "phase8-server.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var results = File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file))!.AsObject() : new JsonObject();
        results["environment"] = new JsonObject
        {
            ["os"] = RuntimeInformation.OSDescription,
            ["cores"] = Environment.ProcessorCount,
            ["sql"] = Environment.GetEnvironmentVariable("CGW_TEST_SQL") is { Length: > 0 } ? "CGW_TEST_SQL" : "LocalDB",
#if DEBUG
            ["build"] = "Debug",
#else
            ["build"] = "Release",
#endif
        };
        value["at"] = DateTimeOffset.UtcNow.ToString("O");
        results[label] = value;
        File.WriteAllText(file, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }

    /// <summary>CPU (this process's cycles and time, LocalDB's) and SQL statements, per named step.</summary>
    private sealed class Meter : IDisposable, IObserver<DiagnosticListener>, IObserver<KeyValuePair<string, object?>>
    {
        public sealed class Totals
        {
            public double CpuMs;
            public double SqlMs;
            public long Commands;
            public int Calls;
            public readonly List<double> Wall = [];
            public ulong Cycles;
        }

        private readonly Dictionary<string, Totals> totals = [];
        private readonly IDisposable subscription;
        private readonly List<IDisposable> listeners = [];
        private readonly Process self = Process.GetCurrentProcess();
        private readonly Process[] sql;
        private long commands;
        private readonly ulong startCycles;
        private readonly TimeSpan startCpu;
        public bool Counting { get; set; }
        public bool SqlReadable { get; }

        public Meter()
        {
            subscription = DiagnosticListener.AllListeners.Subscribe(this);
            // LocalDB runs as this user; a SQL Server service of another account cannot be read.
            sql = Environment.GetEnvironmentVariable("CGW_TEST_SQL") is { Length: > 0 } ? [] : Process.GetProcessesByName("sqlservr").Where(Readable).ToArray();
            SqlReadable = sql.Length > 0;
            startCycles = Cycles();
            startCpu = Cpu();
        }

        private static bool Readable(Process process)
        {
            try
            {
                _ = process.TotalProcessorTime;
                return true;
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException)
            {
                process.Dispose();
                return false;
            }
        }

        private TimeSpan Cpu()
        {
            self.Refresh();
            return self.TotalProcessorTime;
        }

        private TimeSpan SqlCpu()
        {
            var total = TimeSpan.Zero;
            foreach (var process in sql)
            {
                process.Refresh();
                total += process.TotalProcessorTime;
            }
            return total;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryProcessCycleTime(IntPtr process, out ulong cycles);

        private ulong Cycles() => OperatingSystem.IsWindows() && QueryProcessCycleTime(self.Handle, out var cycles) ? cycles : 0;

        /// <summary>Milliseconds of CPU a cycle is, over the whole run so far.</summary>
        public JsonObject Scale()
        {
            var cycles = Cycles() - startCycles;
            var ms = (Cpu() - startCpu).TotalMilliseconds;
            return new JsonObject { ["cycles"] = cycles, ["processCpuMs"] = Math.Round(ms, 1), ["msPerGigacycle"] = cycles == 0 ? null : Math.Round(ms / (cycles / 1e9), 2) };
        }

        public async Task Step(string name, Func<Task> act)
        {
            var c0 = Interlocked.Read(ref commands);
            var s0 = SqlReadable ? SqlCpu() : TimeSpan.Zero;
            var t0 = Cpu();
            var y0 = Cycles();
            var w0 = Stopwatch.GetTimestamp();
            await act();
            var wall = Stopwatch.GetElapsedTime(w0).TotalMilliseconds;
            var y1 = Cycles();
            var t1 = Cpu();
            var s1 = SqlReadable ? SqlCpu() : TimeSpan.Zero;
            var c1 = Interlocked.Read(ref commands);
            if (!Counting) return;
            if (!totals.TryGetValue(name, out var total)) totals[name] = total = new Totals();
            total.Calls++;
            total.Cycles += y1 - y0;
            total.CpuMs += (t1 - t0).TotalMilliseconds;
            total.SqlMs += (s1 - s0).TotalMilliseconds;
            total.Commands += c1 - c0;
            total.Wall.Add(wall);
        }

        public Task Step(string name, Func<Task<JsonElement>> act) => Step(name, async () => { await act(); });

        public Task Step(string name, Func<Task<bool>> act) => Step(name, async () => { await act(); });

        /// <summary>A step's totals, its CPU from cycles where they are counted (time is counted in 15.6 ms ticks).</summary>
        public Totals Total(string name)
        {
            if (!totals.TryGetValue(name, out var total)) return new Totals();
            var scale = Scale()["msPerGigacycle"]?.GetValue<double>();
            if (scale is { } perGigacycle && total.Cycles > 0)
                return new Totals { CpuMs = total.Cycles / 1e9 * perGigacycle, SqlMs = total.SqlMs, Commands = total.Commands, Calls = total.Calls, Cycles = total.Cycles };
            return total;
        }

        public JsonObject Report(int keys)
        {
            var report = new JsonObject();
            foreach (var name in totals.Keys)
            {
                var total = Total(name);
                var wall = totals[name].Wall.Order().ToArray();
                report[name] = new JsonObject
                {
                    ["calls"] = total.Calls,
                    ["cpuMsPerCall"] = Math.Round(total.CpuMs / total.Calls, 3),
                    ["cpuMsPerKey"] = Math.Round(total.CpuMs / keys, 3),
                    ["sqlServerCpuMsPerCall"] = SqlReadable ? Math.Round(total.SqlMs / total.Calls, 3) : null,
                    ["sqlStatementsPerCall"] = Math.Round((double)total.Commands / total.Calls, 2),
                    ["wallP50Ms"] = Math.Round(wall[wall.Length / 2], 2),
                    ["wallP95Ms"] = Math.Round(wall[Math.Min(wall.Length - 1, (int)Math.Ceiling(0.95 * wall.Length) - 1)], 2),
                };
            }
            return report;
        }

        public void OnNext(DiagnosticListener listener)
        {
            if (listener.Name == "SqlClientDiagnosticListener") lock (listeners) listeners.Add(listener.Subscribe(this));
        }

        public void OnNext(KeyValuePair<string, object?> value)
        {
            if (value.Key.EndsWith("CommandBefore", StringComparison.Ordinal)) Interlocked.Increment(ref commands);
        }

        public void OnCompleted() { }

        public void OnError(Exception error) { }

        public void Dispose()
        {
            subscription.Dispose();
            lock (listeners) foreach (var listener in listeners) listener.Dispose();
            self.Dispose();
            foreach (var process in sql) process.Dispose();
        }
    }
}
