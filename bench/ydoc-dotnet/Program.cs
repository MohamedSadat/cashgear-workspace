// Spike S3, step 2: the .NET side of cgw-ydoc. For every document in the corpus it merges the
// updates, compacts, reads JSON and text, lists client ranges and diffs against half the
// history, all by P/Invoke, and writes the results for Yjs 13 to check (s3-verify.test.ts). Then
// it feeds the library malformed input and times compaction of a 1 MB history.
//   dotnet run -- <path to cgw_ydoc.dll> <bench/results/s3>
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: S3Harness <cgw_ydoc.dll> <bench/results/s3>");
    return 2;
}
var library = Path.GetFullPath(args[0]);
var root = Path.GetFullPath(args[1]);
NativeLibrary.SetDllImportResolver(typeof(Native).Assembly, (name, _, _) =>
    name == "cgw_ydoc" ? NativeLibrary.Load(library) : IntPtr.Zero);

Console.WriteLine($"cgw-ydoc {Ydoc.Text(Native.cgw_version)} from {library}");
var corpus = Directory.GetFiles(Path.Combine(root, "corpus"), "*.json").Order().ToArray();
var outDir = Path.Combine(root, "out");
Directory.CreateDirectory(outDir);

var timings = new Dictionary<string, List<double>>();
void Time(string name, double ms) => (timings.TryGetValue(name, out var list) ? list : timings[name] = []).Add(ms);
var failures = new List<string>();

foreach (var file in corpus)
{
    var doc = JsonNode.Parse(File.ReadAllText(file))!;
    var updates = doc["updates"]!.AsArray().Select(u => Convert.FromBase64String(u!.GetValue<string>())).ToArray();
    try
    {
        var watch = Stopwatch.StartNew();
        var merged = Ydoc.Merge(updates);
        Time("merge", watch.Elapsed.TotalMilliseconds);
        watch.Restart();
        var compacted = Ydoc.Bytes(Native.cgw_compact, merged);
        Time("compact", watch.Elapsed.TotalMilliseconds);
        watch.Restart();
        var json = Ydoc.Text(Native.cgw_to_json, compacted);
        Time("toJson", watch.Elapsed.TotalMilliseconds);
        var text = Ydoc.Text(Native.cgw_to_text, compacted);
        var ranges = Ydoc.Text(Native.cgw_client_ranges, merged);
        var meta = Ydoc.Text(Native.cgw_meta, compacted);
        // Half the history, then what the whole has that the half lacks.
        var half = Ydoc.Merge(updates.Take(updates.Length / 2).ToArray());
        var halfVector = Ydoc.Bytes(Native.cgw_state_vector, half);
        var missing = Ydoc.Diff(merged, halfVector);
        File.WriteAllText(Path.Combine(outDir, Path.GetFileName(file)), new JsonObject
        {
            ["merged"] = Convert.ToBase64String(merged),
            ["compacted"] = Convert.ToBase64String(compacted),
            ["half"] = Convert.ToBase64String(half),
            ["missing"] = Convert.ToBase64String(missing),
            ["json"] = json,
            ["text"] = text,
            ["ranges"] = JsonNode.Parse(ranges),
            ["meta"] = JsonNode.Parse(meta),
        }.ToJsonString());
    }
    catch (YdocException error)
    {
        failures.Add($"{Path.GetFileName(file)}: {error.Message}");
    }
}

// Malformed input: every call must return an error, and the process must live.
var random = new Random(7);
var malformed = new List<byte[]>
{
    Array.Empty<byte>(),
    new byte[] { 0xff },
    Enumerable.Repeat((byte)0xff, 11).ToArray(),
    Encoding.UTF8.GetBytes("<script>alert(1)</script>"),
};
for (var i = 0; i < 300; i++)
{
    var bytes = new byte[random.Next(1, 400)];
    random.NextBytes(bytes);
    malformed.Add(bytes);
}
// Truncated and bit-flipped copies of real updates.
var sample = corpus.Take(100).Select(f => Convert.FromBase64String(JsonNode.Parse(File.ReadAllText(f))!["updates"]![0]!.GetValue<string>())).ToArray();
foreach (var real in sample)
{
    if (real.Length > 2) malformed.Add(real[..(real.Length / 2)]);
    var flipped = (byte[])real.Clone();
    flipped[random.Next(flipped.Length)] ^= (byte)(1 << random.Next(8));
    malformed.Add(flipped);
}
var calls = 0;
var refused = 0;
var accepted = 0;
var panics = 0;
var watchMalformed = Stopwatch.StartNew();
foreach (var bytes in malformed)
{
    foreach (var call in new Func<byte[], int>[]
    {
        b => Ydoc.Status(Native.cgw_compact, b),
        b => Ydoc.Status(Native.cgw_to_json, b),
        b => Ydoc.Status(Native.cgw_state_vector, b),
        b => Ydoc.Status(Native.cgw_client_ranges, b),
        b => Ydoc.MergeStatus(b),
    })
    {
        calls++;
        var status = call(bytes);
        if (status == 0) accepted++;
        else refused++;
        if (status == 5) panics++;
    }
}
Time("malformedAll", watchMalformed.Elapsed.TotalMilliseconds);

// Compaction of a long history of about 1 MB, timed.
var big = File.ReadAllBytes(Path.Combine(root, "big.bin"));
var bigCompacted = Array.Empty<byte>();
for (var i = 0; i < 21; i++)
{
    var watch = Stopwatch.StartNew();
    bigCompacted = Ydoc.Bytes(Native.cgw_compact, big);
    if (i > 0) Time("compactBig", watch.Elapsed.TotalMilliseconds);
}
File.WriteAllBytes(Path.Combine(root, "big-compacted.bin"), bigCompacted);

// A page of about 1 MB of content (1,607 blocks) with an ordinary history, timed the same way.
var contentPath = Path.Combine(root, "content.bin");
if (File.Exists(contentPath))
{
    var content = File.ReadAllBytes(contentPath);
    for (var i = 0; i < 21; i++)
    {
        var watch = Stopwatch.StartNew();
        Ydoc.Bytes(Native.cgw_compact, content);
        if (i > 0) Time("compactContent1MB", watch.Elapsed.TotalMilliseconds);
    }
}

static double Percentile(List<double> values, double p)
{
    var sorted = values.Order().ToList();
    return sorted[Math.Min(sorted.Count - 1, (int)Math.Ceiling(p * sorted.Count) - 1)];
}
var summary = new JsonObject
{
    ["runtime"] = RuntimeInformation.FrameworkDescription,
    ["os"] = RuntimeInformation.OSDescription,
    ["arch"] = RuntimeInformation.ProcessArchitecture.ToString(),
    ["documents"] = corpus.Length,
    ["failures"] = new JsonArray(failures.Select(f => (JsonNode)f).ToArray()),
    ["malformed"] = new JsonObject
    {
        ["inputs"] = malformed.Count,
        ["calls"] = calls,
        ["refused"] = refused,
        ["acceptedAsValid"] = accepted,
        ["panicsCaught"] = panics,
    },
    ["bigBytes"] = big.Length,
    ["bigCompactedBytes"] = bigCompacted.Length,
    ["ms"] = new JsonObject(timings.Select(t => KeyValuePair.Create<string, JsonNode?>(t.Key, new JsonObject
    {
        ["count"] = t.Value.Count,
        ["median"] = Math.Round(Percentile(t.Value, 0.5), 3),
        ["p95"] = Math.Round(Percentile(t.Value, 0.95), 3),
        ["max"] = Math.Round(t.Value.Max(), 3),
    }))),
};
File.WriteAllText(Path.Combine(root, "dotnet-summary.json"), summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
return failures.Count == 0 && panics == 0 ? 0 : 1;

[StructLayout(LayoutKind.Sequential)]
struct CgwBuffer
{
    public IntPtr Ptr;
    public UIntPtr Len;
}

[StructLayout(LayoutKind.Sequential)]
struct CgwSlice
{
    public IntPtr Ptr;
    public UIntPtr Len;
}

delegate int OneInput(CgwSlice input, out CgwBuffer output);

static class Native
{
    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void cgw_buffer_free(CgwBuffer buffer);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern unsafe int cgw_merge(CgwSlice* updates, UIntPtr count, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_state_vector(CgwSlice update, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_diff(CgwSlice update, CgwSlice stateVector, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_compact(CgwSlice update, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_to_json(CgwSlice update, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_to_text(CgwSlice update, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_client_ranges(CgwSlice update, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_meta(CgwSlice update, out CgwBuffer output);

    [DllImport("cgw_ydoc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_version(out CgwBuffer output);
}

sealed class YdocException(int status, string message) : Exception($"status {status}: {message}")
{
    public int Status { get; } = status;
}

static class Ydoc
{
    static byte[] Take(int status, CgwBuffer buffer)
    {
        try
        {
            var bytes = new byte[(int)buffer.Len];
            if (bytes.Length > 0) Marshal.Copy(buffer.Ptr, bytes, 0, bytes.Length);
            if (status != 0) throw new YdocException(status, Encoding.UTF8.GetString(bytes));
            return bytes;
        }
        finally
        {
            Native.cgw_buffer_free(buffer);
        }
    }

    public static unsafe byte[] Bytes(OneInput call, byte[] input)
    {
        fixed (byte* p = input)
        {
            var status = call(new CgwSlice { Ptr = (IntPtr)p, Len = (UIntPtr)input.Length }, out var output);
            return Take(status, output);
        }
    }

    public static string Text(OneInput call, byte[] input) => Encoding.UTF8.GetString(Bytes(call, input));

    public delegate int NoInput(out CgwBuffer output);

    public static string Text(NoInput call)
    {
        var status = call(out var output);
        return Encoding.UTF8.GetString(Take(status, output));
    }

    public static int Status(OneInput call, byte[] input)
    {
        try
        {
            Bytes(call, input);
            return 0;
        }
        catch (YdocException error)
        {
            return error.Status;
        }
    }

    public static unsafe byte[] Merge(byte[][] updates)
    {
        var handles = updates.Select(u => GCHandle.Alloc(u, GCHandleType.Pinned)).ToArray();
        try
        {
            var slices = new CgwSlice[updates.Length];
            for (var i = 0; i < updates.Length; i++)
                slices[i] = new CgwSlice { Ptr = handles[i].AddrOfPinnedObject(), Len = (UIntPtr)updates[i].Length };
            fixed (CgwSlice* p = slices)
            {
                var status = Native.cgw_merge(p, (UIntPtr)slices.Length, out var output);
                return Take(status, output);
            }
        }
        finally
        {
            foreach (var handle in handles) handle.Free();
        }
    }

    public static int MergeStatus(byte[] update)
    {
        try
        {
            Merge([update]);
            return 0;
        }
        catch (YdocException error)
        {
            return error.Status;
        }
    }

    public static unsafe byte[] Diff(byte[] update, byte[] stateVector)
    {
        fixed (byte* u = update)
        fixed (byte* s = stateVector)
        {
            var status = Native.cgw_diff(
                new CgwSlice { Ptr = (IntPtr)u, Len = (UIntPtr)update.Length },
                new CgwSlice { Ptr = (IntPtr)s, Len = (UIntPtr)stateVector.Length },
                out var output);
            return Take(status, output);
        }
    }
}
