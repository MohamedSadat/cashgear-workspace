using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace Cgw.Core.Ai;

/// <summary>
/// The server's local completion model (<c>Ai__CompletionModel__*</c>, Phase 18, M18.1; decisions,
/// 2026-11-25): <c>Path</c>, the folder of its package (<c>scripts/completion-model.mjs</c> makes it,
/// <c>install.ps1 -CompletionModel</c> places it; none, and no local model is offered for AI);
/// <c>Threads</c>, the processor threads one answer takes; <c>IdleMinutes</c>, how long a loaded
/// model is kept unused (30); <c>Queue</c>, how many answers may wait for the one being written (8).
/// The model runs in the API only, by <c>Cgw.LocalModel</c>; this record holds no runtime, so the
/// worker and the Sites process never load one.
/// </summary>
public sealed record CompletionModelOptions(string? Path, int Threads, TimeSpan Idle, int Queue, bool Production)
{
    /// <summary>The model a workspace chooses for completions on this server (Qwen3.5-4B, Apache 2.0).</summary>
    public const string Model = "qwen3.5-4b";

    /// <summary>The package's description beside its files.</summary>
    public const string ManifestFile = "cgw-model.json";

    /// <summary>
    /// The package as built from Qwen's weights (<c>Qwen/Qwen3.5-4B</c> at revision
    /// 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a) by <c>scripts/completion-model.mjs</c>: each file's
    /// SHA-256. Production loads exactly these; a package built again must be pinned again here.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> Pinned = new Dictionary<string, string>(StringComparer.Ordinal)
    {
    };

    /// <summary>Whether a package is where the settings say (its files are checked when it is first used).</summary>
    public bool Available => Path is { } path && File.Exists(System.IO.Path.Combine(path, ManifestFile));

    /// <summary>Whether the model is this server's own.</summary>
    public static bool IsLocal(string? model) => model == Model;

    public static CompletionModelOptions From(IConfiguration configuration, bool production)
    {
        var section = configuration.GetSection("Ai:CompletionModel");
        var path = section["Path"] is { Length: > 0 } p ? p : null;
        var threads = int.TryParse(section["Threads"], NumberStyles.None, CultureInfo.InvariantCulture, out var t) && t > 0
            ? t : Math.Clamp(Environment.ProcessorCount / 2, 1, 8);
        var idle = int.TryParse(section["IdleMinutes"], NumberStyles.None, CultureInfo.InvariantCulture, out var m) && m > 0 ? m : 30;
        var queue = int.TryParse(section["Queue"], NumberStyles.None, CultureInfo.InvariantCulture, out var q) && q >= 0 ? Math.Min(q, 100) : 8;
        return new CompletionModelOptions(path, threads, TimeSpan.FromMinutes(idle), queue, production);
    }
}
