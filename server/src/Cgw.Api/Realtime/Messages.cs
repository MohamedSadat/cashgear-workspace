using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Cgw.Core;

namespace Cgw.Api.Realtime;

// The hub's shapes (Phase 6 contracts, section 1, realtime.1), as the JSON hub protocol writes
// them: camelCase, bytes as base64 strings.

/// <summary>
/// What every hub method answers: <c>{ ok: true, value }</c> or <c>{ ok: false, status, code,
/// title, retryAfterMs? }</c>, with the HTTP route's status and code, so the client treats a refused
/// call exactly as the same refusal over HTTP.
/// </summary>
public sealed record Answer<T>
    where T : class
{
    public bool Ok { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public T? Value { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Status { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Code { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Title { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? RetryAfterMs { get; init; }

    public static Answer<T> Of(T value) => new() { Ok = true, Value = value };

    public static Answer<T> Fail(Failure failure) => new()
    {
        Ok = false,
        Status = failure.Status,
        Code = failure.Code,
        Title = failure.Title,
        RetryAfterMs = failure.RetryAfter is { } wait ? Math.Max(1, (long)Math.Ceiling(wait.TotalMilliseconds)) : null,
    };

    public static implicit operator Answer<T>(Failure failure) => Fail(failure);
}

/// <summary>An empty value: <c>{}</c>.</summary>
public sealed record Empty
{
    public static readonly Empty Value = new();
}

public sealed record PagePresenceEntry(Guid PageId, IReadOnlyList<Guid> UserIds);

/// <summary><c>JoinWorkspaces</c>' value, one per workspace the caller is a member of.</summary>
public sealed record WorkspaceJoined(Guid WorkspaceId, long Seq, IReadOnlyList<PagePresenceEntry> Presence);

/// <summary><c>JoinPage</c>'s value.</summary>
public sealed record PageJoined(Guid WorkspaceId, int Epoch, long HeadSeq, int SchemaVersion, string Level, IReadOnlyList<PresenceMessage> Presence);

public sealed record PresenceCursor(string Anchor, string Head);

/// <summary>What a client says about itself on a page, validated exactly (these keys only).</summary>
public sealed record PresenceState(uint ClientId, PresenceCursor? Cursor)
{
    public const int MaxJsonBytes = 1024;
    public const int MaxPositionLength = 256;

    /// <summary>
    /// <c>{ clientId: uint32, cursor: { anchor, head } | null }</c>, at most 1 KB of JSON, each
    /// position base64 of at most 256 characters. The positions are relayed as they are and never
    /// decoded (the API loads no Yjs library).
    /// </summary>
    public static Result<PresenceState?> Parse(JsonElement? element)
    {
        if (element is not { } state || state.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return (PresenceState?)null;
        if (System.Text.Encoding.UTF8.GetByteCount(state.GetRawText()) > MaxJsonBytes) return new Failure(Codes.LimitSize, 413, "A presence state is at most 1 KB");
        if (state.ValueKind != JsonValueKind.Object || !Only(state, "clientId", "cursor")
            || !state.TryGetProperty("clientId", out var client) || client.ValueKind != JsonValueKind.Number || !client.TryGetUInt32(out var clientId)
            || !state.TryGetProperty("cursor", out var cursor))
            return Failure.Invalid("A presence state is { clientId, cursor }");
        if (cursor.ValueKind == JsonValueKind.Null) return new PresenceState(clientId, null);
        if (cursor.ValueKind != JsonValueKind.Object || !Only(cursor, "anchor", "head")
            || Position(cursor, "anchor") is not { } anchor || Position(cursor, "head") is not { } head)
            return Failure.Invalid("A cursor is { anchor, head }: base64, at most 256 characters each");
        return new PresenceState(clientId, new PresenceCursor(anchor, head));
    }

    private static string? Position(JsonElement cursor, string name)
    {
        if (!cursor.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return null;
        var s = value.GetString()!;
        if (s.Length is 0 or > MaxPositionLength || s.Length % 4 != 0) return null;
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (char.IsAsciiLetterOrDigit(c) || c is '+' or '/') continue;
            // Padding only at the end, at most two.
            if (c == '=' && i >= s.Length - 2 && s[i..].All(p => p == '=')) continue;
            return null;
        }
        return s;
    }

    private static bool Only(JsonElement element, params string[] keys)
    {
        var count = 0;
        foreach (var property in element.EnumerateObject())
        {
            if (!keys.Contains(property.Name)) return false;
            count++;
        }
        return count <= keys.Length;
    }
}

public sealed record PresenceMessage(
    Guid PageId,
    /// <summary>Random per connection and page; never the SignalR connection id.</summary>
    string PresenceId,
    /// <summary>Stamped by the server from the connection's ticket.</summary>
    Guid UserId,
    PresenceState? State);

public sealed record FrameUpdate(long Seq, Guid UpdateId, byte[] Data);

/// <summary>A relay: like a pull's answer, for the range (after, cursor].</summary>
public sealed record RealtimeFrame(
    Guid PageId,
    int Epoch,
    long After,
    long Cursor,
    long HeadSeq,
    IReadOnlyList<FrameUpdate> Updates,
    IReadOnlyList<Guid> Rejected,
    bool Complete);

public sealed record ChangesAvailable(Guid WorkspaceId, long Seq);

public sealed record PagePresence(Guid WorkspaceId, Guid PageId, IReadOnlyList<Guid> UserIds);

public sealed record AccessRevoked(Guid WorkspaceId, Guid? PageId, string Reason);

public static class RevokeReasons
{
    public const string AccessDenied = "access.denied";
    public const string MemberRemoved = "member.removed";
    public const string SessionEnded = "session.ended";
}

/// <summary>The events the hub sends (server to client).</summary>
public static class Events
{
    public const string Updates = "Updates";
    public const string Awareness = "Awareness";
    public const string ChangesAvailable = "ChangesAvailable";
    public const string PagePresence = "PagePresence";
    public const string AccessRevoked = "AccessRevoked";
}

/// <summary>
/// The hub's settings (<c>Realtime__*</c>; docs/OPERATIONS.md): how often the relay polls, how long
/// a connection's access is trusted, how often the sweep looks for those due, how often a
/// workspace's followers are told its feed moved, and the bench's metrics route (never in Production).
/// </summary>
public sealed record RealtimeSettings(
    TimeSpan Relay,
    TimeSpan Recheck,
    TimeSpan Sweep,
    TimeSpan ChangesEvery,
    bool Metrics,
    bool AllowMissingOrigin,
    IReadOnlyList<string> Origins)
{
    /// <summary>Who has a page open is told at most this often a page.</summary>
    public static readonly TimeSpan PresenceEvery = TimeSpan.FromMilliseconds(500);
    public const int MaxPagesPerConnection = 50;
    public const int MaxWorkspacesPerCall = 50;
    public const int MaxConnectionsPerDevice = 20;
    public const int MaxConnectionsPerPerson = 200;
    public const int AwarenessPerSecond = 20;
    /// <summary>Decoded update bytes in one <c>PushUpdates</c> (the client sends anything larger over HTTP).</summary>
    public const int MaxPushBytes = 1024 * 1024;
    /// <summary>A frame carries at most this many rows and bytes; past them it says "pull".</summary>
    public const int MaxFrameRows = 1000;
    public const int MaxFrameBytes = 2 * 1024 * 1024;

    public static RealtimeSettings From(IConfiguration configuration, IHostEnvironment environment)
    {
        var section = configuration.GetSection("Realtime");
        double Number(string name, double fallback) =>
            double.TryParse(section[name], NumberStyles.Float, CultureInfo.InvariantCulture, out var n) && n > 0 ? n : fallback;
        var testing = environment.IsDevelopment() || environment.IsEnvironment("Testing");
        return new RealtimeSettings(
            TimeSpan.FromMilliseconds(Number("RelayMs", 20)),
            TimeSpan.FromSeconds(Number("RecheckSeconds", 60)),
            TimeSpan.FromSeconds(Number("SweepSeconds", 10)),
            TimeSpan.FromMilliseconds(Number("ChangesMs", 250)),
            !environment.IsProduction() && section["Metrics"] == "true",
            testing,
            ApiServices.Origins(configuration));
    }
}
