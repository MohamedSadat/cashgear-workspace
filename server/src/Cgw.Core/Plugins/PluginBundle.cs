using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Cgw.Core.Plugins;

/// <summary>A plugin's names, descriptions: English and Arabic.</summary>
public sealed record PluginText(string En, string Ar);

/// <summary>What a plugin asks to read: a database view's rows, when its block names one.</summary>
public sealed record PluginReads(bool Rows);

/// <summary>
/// <c>manifest.json</c> as validated (decisions, 2026-11-18; <c>plugin-frame.1</c>), defaults filled
/// in: <c>entry</c> <c>index.html</c>, <c>reads</c> none, <c>height</c> 240, <c>keywords</c> none.
/// </summary>
public sealed record PluginManifest(
    string Contract,
    string Type,
    int Version,
    PluginText Name,
    PluginText? Description,
    string Entry,
    PluginReads Reads,
    int Height,
    IReadOnlyList<string> Keywords);

/// <summary>One file of a bundle as stored: its path in the zip, its type (by extension), size and SHA-256 (hex).</summary>
public sealed record PluginFile(string Path, string ContentType, long Size, string Sha256);

/// <summary>A refusal's reason, and the file it is about.</summary>
public sealed record PluginProblem(string Code, string? Path);

/// <summary>A bundle that passed: its manifest, its files and their bytes, the zip's hash and the files' size.</summary>
public sealed record PluginBundleRead(PluginManifest Manifest, IReadOnlyList<(PluginFile File, byte[] Bytes)> Files, string Hash, long Size);

/// <summary>
/// A plugin's bundle, read as a hostile archive (decisions, 2026-11-18): a zip of at most 5 MB, at
/// most 200 files, each at most 5 MB unpacked and 20 MB in all, no entry unpacking to over 100 times
/// its compressed size (read from the central directory before anything unpacks, then counted while
/// unpacking), names of at most 200 characters with no <c>..</c>, absolute path, backslash, control
/// character or repeated name, files of the listed extensions only (typed by extension), and a
/// valid <c>manifest.json</c> at the root whose entry is one of them.
/// </summary>
public static partial class PluginBundle
{
    public const string Contract = "plugin-frame.1";
    public const string ManifestPath = "manifest.json";
    public const long MaxZip = 5 * 1024 * 1024;
    public const int MaxFiles = 200;
    public const long MaxFile = 5 * 1024 * 1024;
    public const long MaxTotal = 20 * 1024 * 1024;
    public const long MaxRatio = 100;
    public const int MaxName = 200;
    public const int MaxManifest = 16 * 1024;
    public const int MaxType = 64;
    public const int DefaultHeight = 240;
    public const int MinHeight = 48;
    public const int MaxHeight = 1200;

    // The refusals' codes (400 plugin.invalid, errors[].code).
    public const string ManifestMissing = "manifest.missing";
    public const string ManifestInvalid = "manifest.invalid";
    public const string TypeReserved = "type.reserved";
    public const string EntryMissing = "entry.missing";
    public const string FileType = "file.type";
    public const string FileName = "file.name";
    public const string TooLarge = "bundle.tooLarge";
    public const string NotZip = "bundle.zip";

    /// <summary>The types a file may be, by its extension: what the plugins origin answers it as.</summary>
    public static readonly IReadOnlyDictionary<string, string> Types = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [".html"] = "text/html; charset=utf-8",
        [".htm"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".map"] = "application/json; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".ico"] = "image/x-icon",
        [".woff"] = "font/woff",
        [".woff2"] = "font/woff2",
        [".txt"] = "text/plain; charset=utf-8",
    };

    /// <summary>Types are lower-case words joined by dots (as <c>@cgw/plugins</c>' registry has them), at most 64.</summary>
    [GeneratedRegex("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$", RegexOptions.CultureInvariant)]
    private static partial Regex TypePattern();

    public static bool Reserved(string type) => type == "cashgear" || type.StartsWith("cashgear.", StringComparison.Ordinal);

    /// <summary>The file's type by its extension (lower-cased), or null when it is not one a bundle may hold.</summary>
    public static string? TypeOf(string path)
    {
        var slash = path.LastIndexOf('/');
        var dot = path.LastIndexOf('.');
        if (dot <= slash) return null;
        return Types.GetValueOrDefault(path[dot..].ToLowerInvariant());
    }

    /// <summary>Whether a name may be a file's path: 1 to 200 characters, relative, forward slashes, no empty, <c>.</c> or <c>..</c> part, no control character.</summary>
    public static bool NameOk(string name)
    {
        if (name.Length is 0 or > MaxName) return false;
        if (name[0] == '/' || name.Contains('\\') || name.Contains(':')) return false;
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsControl(c) || c is '\u2028' or '\u2029') return false;
            // A lone surrogate is no character at all.
            if (char.IsHighSurrogate(c) && (i + 1 >= name.Length || !char.IsLowSurrogate(name[++i]))) return false;
            if (char.IsLowSurrogate(c)) return false;
        }
        foreach (var part in name.Split('/'))
            if (part is "" or "." or "..") return false;
        return true;
    }

    /// <summary>Reads a bundle; on any refusal, the problems (the first structural one alone).</summary>
    public static (PluginBundleRead? Bundle, List<PluginProblem> Problems) Read(byte[] zip)
    {
        var problems = new List<PluginProblem>();
        if (zip.LongLength > MaxZip) return (null, [new(TooLarge, null)]);
        ZipArchive archive;
        try
        {
            archive = new ZipArchive(new MemoryStream(zip, writable: false), ZipArchiveMode.Read);
        }
        catch (Exception e) when (e is InvalidDataException or ArgumentException or IOException or NotSupportedException)
        {
            return (null, [new(NotZip, null)]);
        }
        using (archive)
        {
            List<ZipArchiveEntry> entries;
            try
            {
                entries = archive.Entries.ToList();
            }
            catch (Exception e) when (e is InvalidDataException or IOException or NotSupportedException)
            {
                return (null, [new(NotZip, null)]);
            }
            // Folders are not files; everything else is counted from the central directory first.
            var files = entries.Where(e => !(e.FullName.EndsWith('/') && e.Length == 0)).ToList();
            if (files.Count > MaxFiles) return (null, [new(TooLarge, null)]);
            long declared = 0;
            foreach (var entry in files)
            {
                if (entry.Length > MaxFile || entry.Length < 0) return (null, [new(TooLarge, Shown(entry.FullName))]);
                if (entry.Length > 0 && (entry.CompressedLength <= 0 || entry.Length > entry.CompressedLength * MaxRatio))
                    return (null, [new(TooLarge, Shown(entry.FullName))]);
                declared += entry.Length;
            }
            if (declared > MaxTotal) return (null, [new(TooLarge, null)]);

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in files)
            {
                var name = entry.FullName;
                if (!NameOk(name) || !seen.Add(name)) problems.Add(new(FileName, Shown(name)));
                else if (TypeOf(name) is null) problems.Add(new(FileType, Shown(name)));
            }
            // A name that differs only in case from another, or a folder entry named like a file, is refused above.
            if (problems.Count > 0) return (null, problems.Take(50).ToList());

            var read = new List<(PluginFile, byte[])>();
            long total = 0;
            foreach (var entry in files)
            {
                byte[] bytes;
                try
                {
                    bytes = Unpack(entry);
                }
                catch (Exception e) when (e is InvalidDataException or IOException or NotSupportedException)
                {
                    return (null, [new(NotZip, Shown(entry.FullName))]);
                }
                catch (BombException)
                {
                    return (null, [new(TooLarge, Shown(entry.FullName))]);
                }
                total += bytes.LongLength;
                if (total > MaxTotal) return (null, [new(TooLarge, null)]);
                read.Add((new PluginFile(entry.FullName, TypeOf(entry.FullName)!, bytes.LongLength, Convert.ToHexStringLower(SHA256.HashData(bytes))), bytes));
            }

            var manifestFile = read.FirstOrDefault(f => f.Item1.Path == ManifestPath);
            if (manifestFile.Item2 is null) return (null, [new(ManifestMissing, ManifestPath)]);
            if (manifestFile.Item2.Length > MaxManifest) return (null, [new(ManifestInvalid, ManifestPath)]);
            var manifest = ReadManifest(manifestFile.Item2, out var code);
            if (manifest is null) return (null, [new(code!, ManifestPath)]);
            if (!read.Any(f => f.Item1.Path == manifest.Entry)) return (null, [new(EntryMissing, Shown(manifest.Entry))]);
            return (new PluginBundleRead(manifest, read, Convert.ToHexStringLower(SHA256.HashData(zip)), total), []);
        }
    }

    private sealed class BombException : Exception;

    /// <summary>An entry's bytes, never more than its declared size (more is an archive that lied: refused).</summary>
    private static byte[] Unpack(ZipArchiveEntry entry)
    {
        var size = entry.Length;
        var bytes = new byte[size];
        using var stream = entry.Open();
        var at = 0;
        while (at < size)
        {
            var n = stream.Read(bytes, at, (int)Math.Min(81_920, size - at));
            if (n == 0) throw new InvalidDataException("The entry is shorter than its declared size");
            at += n;
        }
        Span<byte> one = stackalloc byte[1];
        if (stream.Read(one) > 0) throw new BombException();
        return bytes;
    }

    /// <summary>A name as a refusal shows it: at most 200 characters.</summary>
    private static string Shown(string name) => name.Length > MaxName ? name[..MaxName] : name;

    /// <summary>The manifest's fields, checked one by one; anything else in it is dropped.</summary>
    public static PluginManifest? ReadManifest(byte[] json, out string? code)
    {
        code = ManifestInvalid;
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json, documentOptions: new JsonDocumentOptions { MaxDepth = 16 });
        }
        catch (JsonException)
        {
            return null;
        }
        if (node is not JsonObject root) return null;
        static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        static int? Whole(JsonNode? n)
        {
            if (n is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return null;
            return v.TryGetValue<int>(out var i) ? i : v.TryGetValue<double>(out var d) && d == Math.Floor(d) && d is >= int.MinValue and <= int.MaxValue ? (int)d : null;
        }
        static bool Visible(string s) => s.Any(c => !char.IsWhiteSpace(c));
        static PluginText? Text(JsonNode? n, int min, int max)
        {
            if (n is not JsonObject o || Str(o["en"]) is not { } en || Str(o["ar"]) is not { } ar) return null;
            if (en.Length < min || en.Length > max || ar.Length < min || ar.Length > max) return null;
            if (min > 0 && (!Visible(en) || !Visible(ar))) return null;
            return new PluginText(en, ar);
        }
        if (Str(root["contract"]) != Contract) return null;
        if (Str(root["type"]) is not { } type || type.Length > MaxType || !TypePattern().IsMatch(type)) return null;
        if (Reserved(type))
        {
            code = TypeReserved;
            return null;
        }
        if (Whole(root["version"]) is not { } version || version < 1) return null;
        if (Text(root["name"], 1, 80) is not { } name) return null;
        PluginText? description = null;
        if (root["description"] is { } d && (description = Text(d, 0, 300)) is null) return null;
        var entry = "index.html";
        if (root["entry"] is { } e)
        {
            if (Str(e) is not { } given || !NameOk(given) || TypeOf(given) != Types[".html"]) return null;
            entry = given;
        }
        var reads = new PluginReads(false);
        if (root["reads"] is { } r)
        {
            if (r is not JsonObject readsObject) return null;
            var rows = readsObject["rows"];
            if (rows is not null && (rows is not JsonValue rv || rv.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False))) return null;
            reads = new PluginReads(rows is JsonValue yes && yes.GetValueKind() == JsonValueKind.True);
        }
        var height = DefaultHeight;
        if (root["height"] is { } h)
        {
            if (Whole(h) is not { } given || given is < MinHeight or > MaxHeight) return null;
            height = given;
        }
        var keywords = new List<string>();
        if (root["keywords"] is { } k)
        {
            if (k is not JsonArray list || list.Count > 10) return null;
            foreach (var word in list)
            {
                if (Str(word) is not { Length: >= 1 and <= 30 } w || !Visible(w)) return null;
                keywords.Add(w);
            }
        }
        code = null;
        return new PluginManifest(Contract, type, version, name, description, entry, reads, height, keywords);
    }
}
