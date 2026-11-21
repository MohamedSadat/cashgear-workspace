using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Search;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Ai;

/// <summary>
/// The workspace's key, kept as Data Protection's output (purpose <c>Cgw.Ai.Key.v1</c>, bound to the
/// workspace, so one workspace's cipher opens in no other), opened only for the provider's call.
/// </summary>
public sealed class AiKeys(IDataProtectionProvider protection)
{
    public const string Purpose = "Cgw.Ai.Key.v1";

    private IDataProtector For(Guid workspaceId) => protection.CreateProtector(Purpose, workspaceId.ToString("N"));

    public string Protect(Guid workspaceId, string key) => For(workspaceId).Protect(key);

    /// <summary>The key, or null when the cipher no longer opens (a lost key ring, another workspace's).</summary>
    public string? Unprotect(Guid workspaceId, string cipher)
    {
        try
        {
            return For(workspaceId).Unprotect(cipher);
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    /// <summary>A key as typed: 20 to 500 visible ASCII characters, no spaces.</summary>
    public static bool Plausible(string? key) => key is { Length: >= 20 and <= 500 } && key.All(c => c is > ' ' and < '\u007f');
}

/// <summary>
/// A completion ready to run: who asked, where, which call, and for <c>ask</c> the pages it sends.
/// <c>Call</c> is null for an <c>ask</c> no readable page answers: nothing is sent then.
/// </summary>
public sealed record AiPrepared(Member Member, Guid RequestId, string Action, Guid? PageId, string Model, AiCall? Call, IReadOnlyList<AiSourceDto>? Sources)
{
    /// <summary>Phase 13: made with Cash Gear's key, and the reservation of the allowance it holds.</summary>
    public bool Subscription { get; init; }
    public Guid? Reservation { get; init; }
}

/// <summary>
/// AI for a workspace (INTEGRATIONS.md, AI, As agreed for 0.7.0): its settings, and each completion
/// checked, built, sent, metered and audited. Off means off: nothing is built or sent unless AI is on
/// for this server and the workspace and a key is set. The module calls no other system than its
/// provider, and has no route to the ERP.
/// </summary>
public sealed class AiService(CgwDb db, Access access, TenantScope scope, SearchService search, MeaningSearch meaning, EmbeddingsService embeddings, AiKeys keys, AiOptions options, AiSubscriptionOptions subscription, AiAllowance allowance, Audit audit, TimeProvider clock)
{
    public const string Provider = AnthropicProvider.ProviderId;

    private async Task<AiSettings?> RowAsync(CancellationToken ct) => await db.AiSettings.FirstOrDefaultAsync(ct);

    /// <summary>Whether a completion may run: on here, on for the workspace, and a key: its own set, or (Phase 13) Cash Gear's offered to it.</summary>
    private bool On(AiSettings? row) => options.Enabled && row is { Enabled: true } && HasKey(row);

    private bool HasKey(AiSettings row) =>
        row.KeySource == KeySources.Subscription ? subscription.OffersCompletions(row.WorkspaceId) : row.KeyCipher is not null;

    public async Task<AiSettingsDto> SettingsAsync(Member member, CancellationToken ct = default)
    {
        var row = await RowAsync(ct);
        var model = row?.Model is { } m && options.Models.Contains(m) ? m : options.DefaultModel;
        var dto = new AiSettingsDto
        {
            Enabled = On(row),
            Provider = Provider,
            Model = model,
            Models = options.Models,
            Embeddings = await embeddings.SettingsAsync(member, row, ct),
            KeySource = row?.KeySource ?? KeySources.Own,
        };
        if (!member.IsAdmin) return dto;
        AiPersonDto? setBy = null;
        if (row?.KeyCipher is not null && row.KeySetBy is { } by)
            setBy = new AiPersonDto(by, await db.Users.AsNoTracking().Where(u => u.Id == by).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone");
        var month = new DateTimeOffset(clock.GetUtcNow().Year, clock.GetUtcNow().Month, 1, 0, 0, 0, TimeSpan.Zero);
        // Completions only: the embeddings provider's calls are counted in their own part (Phase 10).
        var embedding = EmbeddingActions.All;
        var used = await db.AiUsage.AsNoTracking().Where(u => u.CreatedAt >= month && !embedding.Contains(u.Action))
            .GroupBy(_ => 1)
            .Select(g => new { Requests = g.Count(), Input = g.Sum(u => u.InputTokens), Output = g.Sum(u => u.OutputTokens) })
            .FirstOrDefaultAsync(ct);
        return dto with
        {
            HasKey = row?.KeyCipher is not null,
            KeySetAt = row?.KeyCipher is not null ? row.KeySetAt : null,
            KeySetBy = setBy,
            Usage = new AiUsageDto(month.ToString("yyyy-MM", CultureInfo.InvariantCulture), used?.Requests ?? 0, used?.Input ?? 0, used?.Output ?? 0),
            Subscription = subscription.OffersCompletions(member.WorkspaceId) ? await allowance.UsageAsync(member.WorkspaceId, AiAllowance.Completions, ct) : null,
        };
    }

    public async Task<Result<AiSettingsDto>> UpdateAsync(Member member, Actor actor, AiSettingsUpdate body, CancellationToken ct = default)
    {
        if (!member.IsAdmin) return Failure.Denied("Only an owner or admin changes the workspace's AI");
        if (body.Model is { } model && !options.Models.Contains(model)) return Failure.Invalid("model is one of " + string.Join(", ", options.Models));
        if (body.KeySource is { } source && !KeySources.All.Contains(source)) return Failure.Invalid("keySource is own or subscription");
        if (body.KeySource == KeySources.Subscription && !subscription.OffersCompletions(member.WorkspaceId))
            return Failure.Invalid("Cash Gear's subscription is not offered to this workspace");
        string? newKey = null;
        var removeKey = false;
        switch (body.ApiKey.ValueKind)
        {
            case JsonValueKind.Undefined:
                break;
            case JsonValueKind.Null:
                removeKey = true;
                break;
            case JsonValueKind.String when AiKeys.Plausible(body.ApiKey.GetString()):
                newKey = body.ApiKey.GetString();
                break;
            default:
                return Failure.Invalid("apiKey is the provider's key (20 to 500 characters, no spaces) or null to remove it");
        }
        var embeddingsChange = embeddings.Read(body.Embeddings, member.WorkspaceId);
        if (!embeddingsChange.Ok) return embeddingsChange.Failure!;

        // Under the settings row's lock, which the worker's writes of vectors take too: vectors are
        // never written after the switch went off, and off deletes them with the change.
        await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct);
        await db.Database.ExecuteSqlRawAsync("SELECT 1 FROM [AiSettings] WITH (UPDLOCK, HOLDLOCK) WHERE [WorkspaceId] = @ws",
            [new Microsoft.Data.SqlClient.SqlParameter("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(member.WorkspaceId) }], ct);
        var row = await RowAsync(ct);
        var now = clock.GetUtcNow();
        if (row is null)
        {
            row = new AiSettings { WorkspaceId = member.WorkspaceId, Provider = Provider, Model = options.DefaultModel, UpdatedAt = now };
            db.AiSettings.Add(row);
        }
        var before = new { row.Enabled, row.Model, HasKey = row.KeyCipher is not null, row.KeySource };
        if (body.Model is { } chosen) row.Model = chosen;
        if (body.KeySource is { } keySource) row.KeySource = keySource;
        if (newKey is not null)
        {
            row.KeyCipher = keys.Protect(member.WorkspaceId, newKey);
            row.KeySetAt = now;
            row.KeySetBy = member.UserId;
        }
        else if (removeKey)
        {
            row.KeyCipher = null;
            row.KeySetAt = null;
            row.KeySetBy = null;
        }
        if (body.Enabled is { } enabled) row.Enabled = enabled;
        // A workspace with no key is never on; removing the key turns it off (Phase 13: on the
        // subscription it needs none of its own).
        if (row.Enabled && !HasKey(row))
        {
            if (body.Enabled == true) return new Failure(Codes.AiKeyMissing, 400, "Set the provider's key before turning AI on");
            row.Enabled = false;
        }
        EmbeddingsService.Applied? applied = null;
        if (embeddingsChange.Value is { } change)
        {
            var result = embeddings.Apply(row, member, change);
            if (!result.Ok) return result.Failure!;
            applied = result.Value;
        }
        row.UpdatedAt = now;
        row.UpdatedBy = member.UserId;
        audit.Add(actor, "ai.settings", member.WorkspaceId, "workspace", member.WorkspaceId, new
        {
            enabled = row.Enabled,
            model = row.Model,
            keySource = row.KeySource,
            key = newKey is not null ? "set" : removeKey ? (before.HasKey ? "removed" : "none") : "kept",
            was = before,
            embeddings = applied?.Detail,
        });
        await db.SaveChangesAsync(ct);
        // Off deletes every vector of the workspace in this same transaction (decisions, 2026-11-18).
        if (applied is { TurnedOff: true }) await embeddings.DeleteVectorsAsync(member.WorkspaceId, ct);
        await tx.CommitAsync(ct);
        if (applied is { Changed: true }) embeddings.Forget(member.WorkspaceId);
        return await SettingsAsync(member, ct);
    }

    /// <summary>
    /// Everything a completion needs, in the contract's order: a member who is not a guest; AI on (else
    /// <c>ai.disabled</c>, before anything is read or built); the action and language; a named page the
    /// person can read; the input; for <c>ask</c> the readable pages; the key.
    /// </summary>
    public async Task<Result<AiPrepared>> PrepareAsync(Guid userId, AiCompleteRequest body, CancellationToken ct = default)
    {
        if (await access.MemberAsync(body.WorkspaceId, userId) is not { } member) return Failure.NotFound("No such workspace");
        scope.Enter(member.WorkspaceId);
        if (member.IsGuest) return Failure.Denied("Guests do not use the workspace's AI");
        var row = await RowAsync(ct);
        if (!On(row)) return new Failure(Codes.AiDisabled, 403, "AI is off for this workspace");
        if (body.Action is not { } action || !AiActions.All.Contains(action)) return Failure.Invalid("action is one of " + string.Join(", ", AiActions.All));
        if (body.Language is not ("en" or "ar")) return Failure.Invalid("language is en or ar");
        if (AiActions.NeedsPage(action) && body.PageId is null) return Failure.Invalid($"{action} names its page");
        if (body.PageId is { } pageId)
        {
            var page = await db.Pages.AsNoTracking().Where(p => p.Id == pageId && p.DeletedAt == null).Select(p => new { p.Id }).FirstOrDefaultAsync(ct);
            if (page is null || !Levels.AtLeast(await access.PageLevelAsync(member, pageId), Levels.View)) return Failure.NotFound("No such page");
        }
        var read = AiRequestBuilder.Read(action, body.Input);
        if (!read.Ok) return read.Failure!;
        var input = read.Value!;

        IReadOnlyList<AiSource>? sources = null;
        if (input is AskInput ask)
        {
            sources = await SourcesAsync(member, ask.Question, ct);
            if (sources.Count == 0)
                return new AiPrepared(member, Guid.CreateVersion7(), action, body.PageId, row!.Model, null, []);
        }
        var model = options.Models.Contains(row!.Model) ? row.Model : options.DefaultModel;
        var onSubscription = row.KeySource == KeySources.Subscription;
        if ((onSubscription ? subscription.AnthropicKey : keys.Unprotect(member.WorkspaceId, row.KeyCipher!)) is not { } key)
            return new Failure(Codes.AiKeyInvalid, 502, "The workspace's key could not be read: enter it again");
        var request = AiRequestBuilder.Build(input, body.Language, sources);
        // Phase 13: on Cash Gear's subscription, the call's most (its text's tokens, estimated never
        // short, and its output limit) is reserved of the month's allowance before it is sent.
        Guid? reservation = null;
        if (onSubscription)
        {
            var reserved = await allowance.ReserveAsync(member.WorkspaceId, AiAllowance.Completions,
                AiAllowance.Estimate(request.System.Length + request.User.Length) + request.MaxTokens, ct);
            if (!reserved.Ok) return reserved.Failure!;
            reservation = reserved.Value;
        }
        return new AiPrepared(member, Guid.CreateVersion7(), action, body.PageId, model, new AiCall(request, model, key),
            sources?.Select(s => new AiSourceDto(s.PageId, s.Title)).ToList())
        {
            Subscription = onSubscription,
            Reservation = reservation,
        };
    }

    /// <summary>Reciprocal rank fusion's constant (decisions, 2026-11-18).</summary>
    public const int FusionK = 60;

    /// <summary>
    /// The pages <c>ask</c> sends: the server's own search, under the person's permission filter, for
    /// the question's words together, then for each word alone, at most eight, each with its derived
    /// text. A page the person cannot read is never found, so never sent. With embeddings on too
    /// (Phase 10), those pages and the pages search by meaning finds, fused by reciprocal rank
    /// (k = 60), the top eight; with them off, exactly as in 0.9.0.
    /// </summary>
    public async Task<IReadOnlyList<AiSource>> SourcesAsync(Member member, string question, CancellationToken ct = default)
    {
        var words = await WordSourcesAsync(member, question, ct);
        var meant = await meaning.ForAskAsync(member, question, AiRequestBuilder.MaxSources, ct);
        var top = meant.Count == 0 ? words : Fuse(words, meant.Select(h => (h.PageId, h.Title)).ToList());
        var ids = top.Select(t => t.PageId).ToList();
        if (ids.Count == 0) return [];
        var texts = await db.PageDocDerived.AsNoTracking().Where(d => ids.Contains(d.PageId))
            .Select(d => new { d.PageId, Text = d.PlainText.Substring(0, AiRequestBuilder.MaxSourceText) })
            .ToDictionaryAsync(d => d.PageId, d => d.Text, ct);
        return top.Select((t, i) => new AiSource(i + 1, t.PageId, t.Title, texts.GetValueOrDefault(t.PageId) ?? "")).ToList();
    }

    /// <summary>Two ranked lists as one: each page's sum of 1 / (k + rank) over the lists that hold it, the top eight.</summary>
    public static List<(Guid PageId, string Title)> Fuse(IReadOnlyList<(Guid PageId, string Title)> words, IReadOnlyList<(Guid PageId, string Title)> meant)
    {
        var scores = new Dictionary<Guid, (double Score, int First, string Title)>();
        var order = 0;
        foreach (var list in new[] { words, meant })
            for (var rank = 0; rank < list.Count; rank++)
            {
                var (id, title) = list[rank];
                var add = 1.0 / (FusionK + rank + 1);
                scores[id] = scores.TryGetValue(id, out var seen) ? (seen.Score + add, seen.First, seen.Title) : (add, order++, title);
            }
        return scores.OrderByDescending(s => s.Value.Score).ThenBy(s => s.Value.First).Take(AiRequestBuilder.MaxSources)
            .Select(s => (s.Key, s.Value.Title)).ToList();
    }

    /// <summary>0.9.0's retrieval: the word search's pages, best first, at most eight.</summary>
    private async Task<List<(Guid PageId, string Title)>> WordSourcesAsync(Member member, string question, CancellationToken ct)
    {
        var all = TextNormaliser.Terms(TextNormaliser.Normalise(question)).Distinct(StringComparer.Ordinal).ToList();
        var words = all.Where(t => t.Length >= 3).OrderByDescending(t => t.Length).Take(6).ToList();
        if (words.Count == 0) words = all.Take(6).ToList();
        if (words.Count == 0) return [];
        var found = new Dictionary<Guid, (int Score, int Order, string Title)>();
        async Task FindAsync(string query, int weight)
        {
            var result = await search.SearchAsync(member, query, AiRequestBuilder.MaxSources, null, ct);
            if (!result.Ok) return;
            foreach (var hit in result.Value!.Hits)
                found[hit.PageId] = found.TryGetValue(hit.PageId, out var seen)
                    ? (seen.Score + weight, seen.Order, seen.Title)
                    : (weight, found.Count, hit.Title);
        }
        await FindAsync(string.Join(' ', words), words.Count * 10);
        if (found.Count < AiRequestBuilder.MaxSources && words.Count > 1)
            foreach (var word in words)
                await FindAsync(word, 1);
        return found.OrderByDescending(f => f.Value.Score).ThenBy(f => f.Value.Order).Take(AiRequestBuilder.MaxSources)
            .Select(f => (f.Key, f.Value.Title)).ToList();
    }

    /// <summary>One <c>AiUsage</c> row and one <c>ai.complete</c> audit row, without content, however the completion ended.</summary>
    public async Task RecordAsync(AiPrepared prepared, Actor actor, string outcome, long inputTokens, long outputTokens, TimeSpan took)
    {
        var now = clock.GetUtcNow();
        db.AiUsage.Add(new AiUsage
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = prepared.Member.WorkspaceId,
            UserId = prepared.Member.UserId,
            Action = prepared.Action,
            Model = prepared.Model,
            PageId = prepared.PageId,
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            Outcome = outcome,
            DurationMs = (int)Math.Min(int.MaxValue, took.TotalMilliseconds),
            CreatedAt = now,
            Subscription = prepared.Subscription,
        });
        // Phase 13: the call's own row takes its reservation's place, in the same save.
        allowance.Settle(prepared.Reservation);
        audit.Add(actor, "ai.complete", prepared.Member.WorkspaceId, prepared.PageId is null ? "workspace" : "page", prepared.PageId ?? prepared.Member.WorkspaceId, new
        {
            requestId = prepared.RequestId,
            action = prepared.Action,
            model = prepared.Model,
            outcome,
            inputTokens,
            outputTokens,
            sources = prepared.Sources?.Count,
            subscription = prepared.Subscription,
        });
        await db.SaveChangesAsync(CancellationToken.None);
    }
}
