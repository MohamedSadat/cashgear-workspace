using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Cgw.Ydoc;

// The worker's Yjs functions: crates/cgw-ydoc over its C ABI (D14, spike S3). Bytes in, bytes out;
// every call returns a status and a buffer the library owns until cgw_buffer_free. The API process
// never references this assembly.

[StructLayout(LayoutKind.Sequential)]
internal struct CgwBuffer
{
    public IntPtr Ptr;
    public UIntPtr Len;
}

[StructLayout(LayoutKind.Sequential)]
internal struct CgwSlice
{
    public IntPtr Ptr;
    public UIntPtr Len;
}

internal static class Native
{
    public const string Library = "cgw_ydoc";

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern void cgw_buffer_free(CgwBuffer buffer);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern unsafe int cgw_merge(CgwSlice* updates, UIntPtr count, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_state_vector(CgwSlice update, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_diff(CgwSlice update, CgwSlice stateVector, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_compact(CgwSlice update, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_to_json(CgwSlice update, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_to_text(CgwSlice update, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_client_ranges(CgwSlice update, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_meta(CgwSlice update, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_version(out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_validate(CgwSlice state, CgwSlice update, CgwSlice policy, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_state_hash(CgwSlice update, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_doc_load(CgwSlice update, out IntPtr doc, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern void cgw_doc_free(IntPtr doc);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_doc_meta(DocHandle doc, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_doc_check(DocHandle doc, CgwSlice policy, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_doc_state_hash(DocHandle doc, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_doc_to_json(DocHandle doc, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_doc_to_text(DocHandle doc, out CgwBuffer output);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    public static extern int cgw_copy_body(CgwSlice update, CgwSlice pageId, ulong clientId, CgwSlice seed, out CgwBuffer output);
}

/// A document the library loaded and keeps until it is freed.
internal sealed class DocHandle() : SafeHandle(IntPtr.Zero, ownsHandle: true)
{
    public DocHandle(IntPtr handle) : this() => SetHandle(handle);

    public override bool IsInvalid => handle == IntPtr.Zero;

    protected override bool ReleaseHandle()
    {
        Native.cgw_doc_free(handle);
        return true;
    }
}

/// <summary>
/// A state loaded into a document once (Phase 8): its meta, its tree checked against a policy, its
/// state hash, its JSON and text, each the answer <see cref="Yjs"/>'s function of the same name gives
/// for the bytes it was loaded from, without loading them again. Loading fails, with the same
/// <see cref="YdocException"/>, where <see cref="Yjs.Meta"/> fails.
/// </summary>
public sealed class YDocument : IDisposable
{
    private readonly DocHandle handle;

    private YDocument(DocHandle handle, byte[] stateVector)
    {
        this.handle = handle;
        StateVector = stateVector;
    }

    /// <summary>What <see cref="Yjs.StateVector"/> gives for the bytes it was loaded from.</summary>
    public byte[] StateVector { get; }

    public static unsafe YDocument Load(ReadOnlySpan<byte> update)
    {
        Yjs.Counted();
        fixed (byte* p = update)
        {
            var status = Native.cgw_doc_load(new CgwSlice { Ptr = (IntPtr)p, Len = (UIntPtr)update.Length }, out var doc, out var output);
            var vector = Yjs.Take(status, output);
            return new YDocument(new DocHandle(doc), vector);
        }
    }

    private delegate int Call(DocHandle doc, out CgwBuffer output);

    private byte[] Run(Call call)
    {
        ObjectDisposedException.ThrowIf(handle.IsClosed, this);
        var status = call(handle, out var output);
        return Yjs.Take(status, output);
    }

    public string Meta() => Encoding.UTF8.GetString(Run(Native.cgw_doc_meta));

    public string StateHash() => Encoding.UTF8.GetString(Run(Native.cgw_doc_state_hash));

    public string ToJson() => Encoding.UTF8.GetString(Run(Native.cgw_doc_to_json));

    public string ToText() => Encoding.UTF8.GetString(Run(Native.cgw_doc_to_text));

    /// <summary>
    /// The tree's problems against the policy's elements and block ids: what
    /// <see cref="Yjs.Validate"/> finds past its size and client checks.
    /// </summary>
    public unsafe IReadOnlyList<string> Check(ValidationPolicy policy)
    {
        ObjectDisposedException.ThrowIf(handle.IsClosed, this);
        var policyBytes = JsonSerializer.SerializeToUtf8Bytes(new { elements = policy.Elements, blockIds = policy.BlockIds });
        fixed (byte* p = policyBytes)
        {
            var status = Native.cgw_doc_check(handle, new CgwSlice { Ptr = (IntPtr)p, Len = (UIntPtr)policyBytes.Length }, out var output);
            using var json = JsonDocument.Parse(Yjs.Take(status, output));
            return json.RootElement.GetProperty("problems").EnumerateArray().Select(x => x.GetString() ?? "").ToList();
        }
    }

    public void Dispose() => handle.Dispose();
}

public sealed class YdocException(int status, string message) : Exception($"cgw-ydoc status {status}: {message}")
{
    public int Status { get; } = status;
}

public sealed record ClientRange(ulong Client, uint Start, uint End);

/// <summary>What a pushed update may contain (cgw_validate's policy).</summary>
public sealed record ValidationPolicy(IReadOnlyCollection<ulong> Clients, IReadOnlyCollection<string> Elements, int MaxBytes, bool BlockIds = true);

public static class Yjs
{
    private static int configured;
    private static readonly AsyncLocal<LoadCount?> counting = new();

    /// <summary>
    /// The documents loaded (built from bytes, not only decoded) in this async flow from now until
    /// the count is disposed: <see cref="Meta"/>, <see cref="Validate"/>, <see cref="StateHash"/>,
    /// <see cref="ToJson"/>, <see cref="ToText"/>, <see cref="Compact"/> and
    /// <see cref="YDocument.Load"/> each load one. For the test that a validation pass loads a
    /// document once.
    /// </summary>
    public static LoadCount CountLoads() => counting.Value = new LoadCount(counting.Value);

    internal static void Counted()
    {
        if (counting.Value is { } count) count.Add();
    }

    public sealed class LoadCount(LoadCount? outer) : IDisposable
    {
        private int loads;
        public int Loads => Volatile.Read(ref loads);

        internal void Add()
        {
            Interlocked.Increment(ref loads);
            outer?.Add();
        }

        public void Dispose() => counting.Value = outer;
    }

    /// <summary>
    /// Points the loader at the native library: a path from configuration, else the library
    /// beside this assembly (a published worker), else the repo's <c>target/ffi</c> build.
    /// </summary>
    public static void Configure(string? path)
    {
        if (Interlocked.Exchange(ref configured, 1) == 1) return;
        NativeLibrary.SetDllImportResolver(typeof(Yjs).Assembly, (name, assembly, search) =>
        {
            if (name != Native.Library) return IntPtr.Zero;
            foreach (var candidate in Candidates(path))
                if (File.Exists(candidate)) return NativeLibrary.Load(candidate);
            return NativeLibrary.Load(name, assembly, search);
        });
    }

    private static IEnumerable<string> Candidates(string? path)
    {
        var file = OperatingSystem.IsWindows() ? "cgw_ydoc.dll" : OperatingSystem.IsMacOS() ? "libcgw_ydoc.dylib" : "libcgw_ydoc.so";
        if (!string.IsNullOrEmpty(path)) yield return Path.GetFullPath(path);
        var env = Environment.GetEnvironmentVariable("CGW_YDOC_LIBRARY");
        if (!string.IsNullOrEmpty(env)) yield return Path.GetFullPath(env);
        yield return Path.Combine(AppContext.BaseDirectory, file);
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var built = Path.Combine(dir.FullName, "target", "ffi", file);
            if (File.Exists(built)) yield return built;
        }
    }

    internal static byte[] Take(int status, CgwBuffer buffer)
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

    private delegate int OneInput(CgwSlice input, out CgwBuffer output);

    private static unsafe byte[] One(OneInput call, ReadOnlySpan<byte> input)
    {
        fixed (byte* p = input)
        {
            var status = call(new CgwSlice { Ptr = (IntPtr)p, Len = (UIntPtr)input.Length }, out var output);
            return Take(status, output);
        }
    }

    public static string Version()
    {
        var status = Native.cgw_version(out var output);
        return Encoding.UTF8.GetString(Take(status, output));
    }

    public static unsafe byte[] Merge(IReadOnlyList<byte[]> updates)
    {
        var handles = new GCHandle[updates.Count];
        var slices = new CgwSlice[updates.Count];
        try
        {
            for (var i = 0; i < updates.Count; i++)
            {
                handles[i] = GCHandle.Alloc(updates[i], GCHandleType.Pinned);
                slices[i] = new CgwSlice { Ptr = handles[i].AddrOfPinnedObject(), Len = (UIntPtr)updates[i].Length };
            }
            fixed (CgwSlice* p = slices)
            {
                var status = Native.cgw_merge(p, (UIntPtr)slices.Length, out var output);
                return Take(status, output);
            }
        }
        finally
        {
            foreach (var handle in handles)
                if (handle.IsAllocated) handle.Free();
        }
    }

    public static byte[] StateVector(ReadOnlySpan<byte> update) => One(Native.cgw_state_vector, update);

    public static unsafe byte[] Diff(ReadOnlySpan<byte> update, ReadOnlySpan<byte> stateVector)
    {
        fixed (byte* u = update)
        fixed (byte* v = stateVector)
        {
            var status = Native.cgw_diff(
                new CgwSlice { Ptr = (IntPtr)u, Len = (UIntPtr)update.Length },
                new CgwSlice { Ptr = (IntPtr)v, Len = (UIntPtr)stateVector.Length },
                out var output);
            return Take(status, output);
        }
    }

    /// <summary>
    /// Phase 15: a template's body (its whole state) as a new page's first update, written as
    /// <paramref name="clientId"/>, every block given a new id made from <paramref name="seed"/>
    /// (crates/cgw-ydoc/src/copy.rs).
    /// </summary>
    public static unsafe byte[] CopyBody(ReadOnlySpan<byte> template, Guid pageId, ulong clientId, ReadOnlySpan<byte> seed)
    {
        Counted();
        var page = Encoding.UTF8.GetBytes(pageId.ToString());
        fixed (byte* u = template)
        fixed (byte* p = page)
        fixed (byte* s = seed)
        {
            var status = Native.cgw_copy_body(
                new CgwSlice { Ptr = (IntPtr)u, Len = (UIntPtr)template.Length },
                new CgwSlice { Ptr = (IntPtr)p, Len = (UIntPtr)page.Length },
                clientId,
                new CgwSlice { Ptr = (IntPtr)s, Len = (UIntPtr)seed.Length },
                out var output);
            return Take(status, output);
        }
    }

    /// <summary>The whole state as one update, garbage collected.</summary>
    public static byte[] Compact(ReadOnlySpan<byte> update)
    {
        Counted();
        return One(Native.cgw_compact, update);
    }

    public static string ToJson(ReadOnlySpan<byte> update)
    {
        Counted();
        return Encoding.UTF8.GetString(One(Native.cgw_to_json, update));
    }

    public static string ToText(ReadOnlySpan<byte> update)
    {
        Counted();
        return Encoding.UTF8.GetString(One(Native.cgw_to_text, update));
    }

    public static string Meta(ReadOnlySpan<byte> update)
    {
        Counted();
        return Encoding.UTF8.GetString(One(Native.cgw_meta, update));
    }

    /// <summary>
    /// The state hash of the document the update makes (Phase 3 contracts, section 2): lowercase hex
    /// SHA-256 of <c>v1;sv=...;ds=...</c>, the same as the doc layer's <c>stateHash</c>, so a device
    /// can tell it holds what the server holds without sending it.
    /// </summary>
    public static string StateHash(ReadOnlySpan<byte> update)
    {
        Counted();
        return Encoding.UTF8.GetString(One(Native.cgw_state_hash, update));
    }

    public static (IReadOnlyList<ClientRange> Ranges, IReadOnlyList<ulong> Deletes) ClientRanges(ReadOnlySpan<byte> update)
    {
        using var json = JsonDocument.Parse(One(Native.cgw_client_ranges, update));
        var ranges = json.RootElement.GetProperty("ranges").EnumerateArray()
            .Select(r => new ClientRange(r.GetProperty("client").GetUInt64(), r.GetProperty("start").GetUInt32(), r.GetProperty("end").GetUInt32()))
            .ToList();
        var deletes = json.RootElement.GetProperty("deletes").EnumerateArray().Select(d => d.GetUInt64()).ToList();
        return (ranges, deletes);
    }

    /// <summary>The problems with <paramref name="update"/> on top of <paramref name="state"/>; empty when it may be kept.</summary>
    public static unsafe IReadOnlyList<string> Validate(ReadOnlySpan<byte> state, ReadOnlySpan<byte> update, ValidationPolicy policy)
    {
        Counted();
        var policyBytes = JsonSerializer.SerializeToUtf8Bytes(new { clients = policy.Clients, elements = policy.Elements, maxBytes = policy.MaxBytes, blockIds = policy.BlockIds });
        fixed (byte* s = state)
        fixed (byte* u = update)
        fixed (byte* p = policyBytes)
        {
            var status = Native.cgw_validate(
                new CgwSlice { Ptr = (IntPtr)s, Len = (UIntPtr)state.Length },
                new CgwSlice { Ptr = (IntPtr)u, Len = (UIntPtr)update.Length },
                new CgwSlice { Ptr = (IntPtr)p, Len = (UIntPtr)policyBytes.Length },
                out var output);
            using var json = JsonDocument.Parse(Take(status, output));
            return json.RootElement.GetProperty("problems").EnumerateArray().Select(x => x.GetString() ?? "").ToList();
        }
    }

    /// <summary>The assembly a test checks the API never loads.</summary>
    public static Assembly Assembly => typeof(Yjs).Assembly;
}
