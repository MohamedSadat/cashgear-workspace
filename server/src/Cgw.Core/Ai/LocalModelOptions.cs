using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Ai;

/// <summary>
/// The server's local embedding model (<c>Ai__LocalModel__*</c>, Phase 13, M13.4; decisions,
/// 2026-11-21): <c>Path</c>, the folder of its package (<c>scripts/local-model.mjs</c> makes it,
/// <c>install.ps1 -LocalModel</c> places it; none, and no local model is offered); <c>Threads</c>, the
/// processor threads one run takes (half the processors, at most 8); <c>IdleMinutes</c>, how long a
/// loaded model is kept unused (30). The model runs in the API (a question) and the worker (pages and
/// rows), by <c>Cgw.LocalModel</c>; this record holds no runtime, so the Sites process never loads one.
/// </summary>
public sealed record LocalModelOptions(string? Path, int Threads, TimeSpan Idle, bool Production)
{
    /// <summary>The model a workspace chooses to embed on this server.</summary>
    public const string Model = "voyage-4-nano";

    /// <summary>The package's description beside its files.</summary>
    public const string ManifestFile = "cgw-model.json";

    /// <summary>
    /// voyage-4-nano's package as built from Voyage's weights (<c>MongoDB/voyage-4-nano</c> at revision
    /// 587d8d6dcaec029a9779c2098d6af020e4a07c01) by <c>scripts/local-model.mjs</c>: each file's SHA-256.
    /// Production loads exactly these; a package built again must be pinned again here.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> Pinned = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["model.onnx"] = "2989a7c9438f41d0e1d662aac3bbb891b545259135e93985a98292df1fd3d848",
        ["vocab.json"] = "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        ["merges.txt"] = "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3",
    };

    /// <summary>Whether a package is where the settings say (its files are checked when it is first used).</summary>
    public bool Available => Path is { } path && File.Exists(System.IO.Path.Combine(path, ManifestFile));

    /// <summary>Whether the model is this server's own.</summary>
    public static bool IsLocal(string? model) => model == Model;

    public static LocalModelOptions From(IConfiguration configuration, bool production)
    {
        var section = configuration.GetSection("Ai:LocalModel");
        var path = section["Path"] is { Length: > 0 } p ? p : null;
        var threads = int.TryParse(section["Threads"], NumberStyles.None, CultureInfo.InvariantCulture, out var t) && t > 0
            ? t : Math.Clamp(Environment.ProcessorCount / 2, 1, 8);
        var idle = int.TryParse(section["IdleMinutes"], NumberStyles.None, CultureInfo.InvariantCulture, out var m) && m > 0 ? m : 30;
        return new LocalModelOptions(path, threads, TimeSpan.FromMinutes(idle), production);
    }
}
