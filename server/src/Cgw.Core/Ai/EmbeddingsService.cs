using System.Globalization;
using System.Text.Json;
using Cgw.Core.Data;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Ai;

/// <summary>A checked change to the embeddings' settings: each part null when the body left it out.</summary>
public sealed record EmbeddingsChange(bool? Enabled, string? Model, string? NewKey, bool RemoveKey);

/// <summary>
/// A workspace's embeddings settings (Phase 10, decisions 2026-11-18): a switch, a model and a
/// Voyage key of their own, beside completions'. On means on for this server (<c>Ai__Enabled</c>),
/// on for the workspace, with a key and a model offered. Off deletes every vector of the workspace
/// in the same transaction and drops the API's copy; turned on again, or with a new model, the
/// generation rises and the worker embeds every page again.
/// </summary>
public sealed class EmbeddingsService(CgwDb db, EmbeddingKeys keys, EmbeddingsOptions options, AiOptions ai, Cgw.Core.Search.EmbeddingsCache cache, TimeProvider clock)
{
    /// <summary>Lets this API instance's copy of the workspace's vectors go (others see the change on their next search).</summary>
    public void Forget(Guid workspaceId) => cache.Drop(workspaceId);

    public bool On(AiSettings? row) =>
        ai.Enabled && row is { EmbeddingsEnabled: true, EmbeddingsKeyCipher: not null } && options.Models.Contains(row.EmbeddingsModel);

    public string ModelOf(AiSettings? row) => row?.EmbeddingsModel is { } m && options.Models.Contains(m) ? m : options.DefaultModel;

    /// <summary>The settings as answered: to owners and admins with the key's details, the month's use and the progress.</summary>
    public async Task<EmbeddingsSettingsDto> SettingsAsync(Member member, AiSettings? row, CancellationToken ct = default)
    {
        var model = ModelOf(row);
        var on = On(row);
        var dto = new EmbeddingsSettingsDto { Enabled = on, Provider = EmbeddingsOptions.Provider, Model = model, Models = options.Models };
        if (!member.IsAdmin) return dto;
        AiPersonDto? setBy = null;
        if (row?.EmbeddingsKeyCipher is not null && row.EmbeddingsKeySetBy is { } by)
            setBy = new AiPersonDto(by, await db.Users.AsNoTracking().Where(u => u.Id == by).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? People.Someone);
        var now = clock.GetUtcNow();
        var month = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);
        var actions = EmbeddingActions.All;
        var used = await db.AiUsage.AsNoTracking().Where(u => u.CreatedAt >= month && actions.Contains(u.Action))
            .GroupBy(_ => 1)
            .Select(g => new { Requests = g.Count(), Tokens = g.Sum(u => u.InputTokens) })
            .FirstOrDefaultAsync(ct);
        EmbeddingsProgressDto? progress = null;
        if (on)
        {
            var live = db.Pages.AsNoTracking().Where(p => p.TrashedAt == null && p.DeletedAt == null);
            var vectors = db.PageEmbeddings;
            progress = new EmbeddingsProgressDto(
                await live.CountAsync(ct),
                await live.CountAsync(p => vectors.Any(e => e.PageId == p.Id && e.Model == model), ct));
        }
        var hasKey = row?.EmbeddingsKeyCipher is not null;
        return dto with
        {
            HasKey = hasKey,
            KeySetAt = hasKey ? row!.EmbeddingsKeySetAt : null,
            KeySetBy = setBy,
            Usage = new EmbeddingsUsageDto(month.ToString("yyyy-MM", CultureInfo.InvariantCulture), used?.Requests ?? 0, used?.Tokens ?? 0),
            Progress = progress,
        };
    }

    /// <summary>The body's embeddings part, checked before anything changes: a model offered, a plausible key or null.</summary>
    public Result<EmbeddingsChange?> Read(EmbeddingsUpdate? body)
    {
        if (body is null) return Result<EmbeddingsChange?>.Success(null);
        if (body.Model is { } model && !options.Models.Contains(model))
            return Failure.Invalid("embeddings.model is one of " + string.Join(", ", options.Models));
        string? newKey = null;
        var remove = false;
        switch (body.ApiKey.ValueKind)
        {
            case JsonValueKind.Undefined:
                break;
            case JsonValueKind.Null:
                remove = true;
                break;
            case JsonValueKind.String when AiKeys.Plausible(body.ApiKey.GetString()):
                newKey = body.ApiKey.GetString();
                break;
            default:
                return Failure.Invalid("embeddings.apiKey is the provider's key (20 to 500 characters, no spaces) or null to remove it");
        }
        return Result<EmbeddingsChange?>.Success(new EmbeddingsChange(body.Enabled, body.Model, newKey, remove));
    }

    /// <summary>What a change did, for the audit (never the key) and for what follows it.</summary>
    public sealed record Applied(object Detail, bool TurnedOff, bool Changed);

    /// <summary>
    /// Applies a checked change to the row. Turning on with no key is <c>ai.keyMissing</c>; removing
    /// the key turns embeddings off. Turned on again, or a new model, raises the generation.
    /// </summary>
    public Result<Applied> Apply(AiSettings row, Member member, EmbeddingsChange change)
    {
        var now = clock.GetUtcNow();
        var before = new { enabled = row.EmbeddingsEnabled, model = row.EmbeddingsModel, hasKey = row.EmbeddingsKeyCipher is not null };
        if (change.Model is { } model && model != row.EmbeddingsModel)
        {
            row.EmbeddingsModel = model;
            row.EmbeddingsGeneration++;
        }
        if (change.NewKey is { } key)
        {
            row.EmbeddingsKeyCipher = keys.Protect(member.WorkspaceId, key);
            row.EmbeddingsKeySetAt = now;
            row.EmbeddingsKeySetBy = member.UserId;
        }
        else if (change.RemoveKey)
        {
            row.EmbeddingsKeyCipher = null;
            row.EmbeddingsKeySetAt = null;
            row.EmbeddingsKeySetBy = null;
        }
        if (change.Enabled is { } enabled && enabled != row.EmbeddingsEnabled)
        {
            row.EmbeddingsEnabled = enabled;
            if (enabled) row.EmbeddingsGeneration++;
        }
        if (row.EmbeddingsEnabled && row.EmbeddingsKeyCipher is null)
        {
            if (change.Enabled == true) return new Failure(Codes.AiKeyMissing, 400, "Set the embeddings provider's key before turning search by meaning on");
            row.EmbeddingsEnabled = false;
        }
        var turnedOff = before.enabled && !row.EmbeddingsEnabled;
        var detail = new
        {
            enabled = row.EmbeddingsEnabled,
            model = row.EmbeddingsModel,
            key = change.NewKey is not null ? "set" : change.RemoveKey ? (before.hasKey ? "removed" : "none") : "kept",
            was = before,
        };
        var changed = turnedOff || before.model != row.EmbeddingsModel || before.enabled != row.EmbeddingsEnabled || change.NewKey is not null || change.RemoveKey;
        return new Applied(detail, turnedOff, changed);
    }

    /// <summary>
    /// Every vector of the workspace, deleted in the caller's transaction, with one
    /// <c>EmbeddingChanges</c> row a page they held (so a copy of another API instance drops them too).
    /// </summary>
    public async Task<int> DeleteVectorsAsync(Guid workspaceId, CancellationToken ct = default)
    {
        var ws = new SqlParameter("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(workspaceId) };
        var at = new SqlParameter("@now", System.Data.SqlDbType.DateTimeOffset) { Value = clock.GetUtcNow() };
        await db.Database.ExecuteSqlRawAsync("""
            INSERT INTO [EmbeddingChanges] ([WorkspaceId], [PageId], [CreatedAt])
            SELECT @ws, e.[PageId], @now FROM [PageEmbeddings] e WHERE e.[WorkspaceId] = @ws GROUP BY e.[PageId]
            """, [ws, at], ct);
        return await db.PageEmbeddings.Where(e => e.WorkspaceId == workspaceId).ExecuteDeleteAsync(ct);
    }
}
