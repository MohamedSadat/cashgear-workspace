using System.Data;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Automations;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Sites;
using Cgw.Core.Sync;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Forms;

/// <summary>A form link's tokens under Data Protection, so full access reads a link again (the Sites process never holds the key ring).</summary>
public sealed class FormKeys(IDataProtectionProvider protection)
{
    public const string Purpose = "Cgw.Forms.Link.v1";

    private IDataProtector For(Guid workspaceId) => protection.CreateProtector(Purpose, workspaceId.ToString("N"));

    public string Protect(Guid workspaceId, string token) => For(workspaceId).Protect(token);

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

    /// <summary>32 random bytes as base64url: 43 characters.</summary>
    public static string NewToken() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    /// <summary>SHA-256 of a token's text, as a link is found by it; null for text no token can be.</summary>
    public static byte[]? Hash(string? token) =>
        token is { Length: > 0 and <= 128 } && token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token)) : null;
}

/// <summary>Whether a link takes answers now (db/forms.ts words them in the app; the Sites process in its page).</summary>
public static class FormLinkStates
{
    public const string Open = "open";
    public const string Off = "off";
    public const string Closed = "closed";
    public const string Full = "full";

    public static string Of(FormLink link, DateTimeOffset now) =>
        !link.Enabled ? Off
        : link.ClosesAt is { } at && at <= now ? Closed
        : link.MaxAnswers is { } max && link.Answers >= max ? Full
        : Open;
}

public sealed record FormLinkDto(
    Guid Id,
    string Url,
    bool Enabled,
    DateTimeOffset? ClosesAt,
    int? MaxAnswers,
    int Answers,
    /// <summary><c>open</c>, <c>off</c>, <c>closed</c> or <c>full</c>.</summary>
    string State,
    Guid? CreatedBy,
    DateTimeOffset CreatedAt,
    long Version);

/// <summary>A form view's answers and its link, as its readers see them.</summary>
public sealed record FormStateDto(
    /// <summary>Rows its answers added, in the app and by its link, not in the trash.</summary>
    int Answers,
    FormLinkDto? Link,
    /// <summary>Full access to the database: the person makes, changes and deletes its link.</summary>
    bool CanManage,
    /// <summary>A database in a private section takes no link.</summary>
    bool LinksAllowed);

/// <summary>A link's settings, all of them each time.</summary>
public sealed class FormLinkRequest
{
    public bool Enabled { get; init; } = true;
    public DateTimeOffset? ClosesAt { get; init; }
    public int? MaxAnswers { get; init; }
}

/// <summary>
/// A form view's link for members (Phase 16, M16.2; DATA_MODEL.md, Forms): its readers read it, with
/// its address; whoever has full access to the database makes it, changes its switch, closing time
/// and maximum, and deletes it. One a form, none in a private section. Each change is audited.
/// </summary>
public sealed class FormService(CgwDb db, Audit audit, FormKeys keys, SitesOptions sites, TimeProvider clock)
{
    public const int MaxAnswersLimit = 1_000_000;

    private async Task<Result<DatabaseView>> FormViewAsync(Guid databaseId, Guid viewId, CancellationToken ct)
    {
        var view = await db.DatabaseViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == viewId && v.DatabaseId == databaseId, ct);
        return view is null || view.Type != DatabaseOps.FormView ? Failure.NotFound("No such form view") : view;
    }

    private async Task<bool> SharedSectionAsync(Page database, CancellationToken ct) =>
        await db.Sections.AsNoTracking().Where(s => s.Id == database.SectionId).Select(s => s.Visibility).FirstOrDefaultAsync(ct) != "private";

    public string Url(string token) => $"{sites.PublicUrl}/_form/{token}";

    private FormLinkDto Dto(FormLink link) => new(link.Id, keys.Unprotect(link.WorkspaceId, link.TokenCipher) is { } token ? Url(token) : "", link.Enabled, link.ClosesAt,
        link.MaxAnswers, link.Answers, FormLinkStates.Of(link, clock.GetUtcNow()), link.CreatedBy == Guid.Empty ? null : link.CreatedBy, link.CreatedAt, link.Version);

    /// <summary>The answers' count for every form of the database, and this form's link.</summary>
    public async Task<Result<FormStateDto>> StateAsync(Page database, string level, Guid viewId, CancellationToken ct = default)
    {
        var view = await FormViewAsync(database.Id, viewId, ct);
        if (!view.Ok) return view.Failure!;
        var answers = await db.Pages.AsNoTracking().CountAsync(p => p.FormId == viewId && p.Kind == PageKinds.Row && p.DeletedAt == null && p.TrashedAt == null, ct);
        var link = await db.FormLinks.AsNoTracking().FirstOrDefaultAsync(l => l.ViewId == viewId, ct);
        return new FormStateDto(answers, link is null ? null : Dto(link), level == Levels.Full, await SharedSectionAsync(database, ct));
    }

    private static Failure? Check(FormLinkRequest request)
    {
        if (request.MaxAnswers is { } max && max is < 1 or > MaxAnswersLimit) return Failure.Invalid($"maxAnswers is 1 to {MaxAnswersLimit:N0}");
        return null;
    }

    public async Task<Result<FormLinkDto>> CreateLinkAsync(Member member, Actor actor, Page database, string level, Guid viewId, FormLinkRequest request, CancellationToken ct = default)
    {
        if (level != Levels.Full) return new Failure(Codes.AccessDenied, 403, "A form's link is made with full access to its database");
        var view = await FormViewAsync(database.Id, viewId, ct);
        if (!view.Ok) return view.Failure!;
        if (database.TrashedAt is not null) return Failure.Conflict(Codes.Conflict, "The database is in the trash");
        if (!await SharedSectionAsync(database, ct)) return Failure.Invalid("A database in a private section takes no link; move it to a shared section first");
        if (Check(request) is { } problem) return problem;
        if (await db.FormLinks.AnyAsync(l => l.ViewId == viewId, ct)) return Failure.Conflict(Codes.FormLinkExists, "The form has a link: delete it to make another");
        var token = FormKeys.NewToken();
        var now = clock.GetUtcNow();
        var link = new FormLink
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = member.WorkspaceId,
            DatabaseId = database.Id,
            ViewId = viewId,
            TokenHash = FormKeys.Hash(token)!,
            TokenCipher = keys.Protect(member.WorkspaceId, token),
            Enabled = request.Enabled,
            ClosesAt = request.ClosesAt,
            MaxAnswers = request.MaxAnswers,
            CreatedBy = member.UserId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.FormLinks.Add(link);
        audit.Add(actor, "form.link.create", member.WorkspaceId, "view", viewId, new { linkId = link.Id, link.Enabled, link.ClosesAt, link.MaxAnswers });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // Two made at once: one form, one link.
            return Failure.Conflict(Codes.FormLinkExists, "The form has a link: delete it to make another");
        }
        return Dto(link);
    }

    public async Task<Result<FormLinkDto>> UpdateLinkAsync(Member member, Actor actor, Page database, string level, Guid viewId, FormLinkRequest request, CancellationToken ct = default)
    {
        if (level != Levels.Full) return new Failure(Codes.AccessDenied, 403, "A form's link is changed with full access to its database");
        if (Check(request) is { } problem) return problem;
        var link = await db.FormLinks.FirstOrDefaultAsync(l => l.ViewId == viewId && l.DatabaseId == database.Id, ct);
        if (link is null) return Failure.NotFound("The form has no link");
        var before = new { link.Enabled, link.ClosesAt, link.MaxAnswers };
        link.Enabled = request.Enabled;
        link.ClosesAt = request.ClosesAt;
        link.MaxAnswers = request.MaxAnswers;
        link.UpdatedAt = clock.GetUtcNow();
        link.Version++;
        audit.Add(actor, "form.link.update", member.WorkspaceId, "view", viewId, new { linkId = link.Id, link.Enabled, link.ClosesAt, link.MaxAnswers, before });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Failure.Conflict(Codes.Conflict, "The link was changed meanwhile: read it again");
        }
        return Dto(link);
    }

    public async Task<Result<bool>> DeleteLinkAsync(Member member, Actor actor, Page database, string level, Guid viewId, CancellationToken ct = default)
    {
        if (level != Levels.Full) return new Failure(Codes.AccessDenied, 403, "A form's link is deleted with full access to its database");
        var link = await db.FormLinks.FirstOrDefaultAsync(l => l.ViewId == viewId && l.DatabaseId == database.Id, ct);
        if (link is null) return true;
        db.FormLinks.Remove(link);
        audit.Add(actor, "form.link.delete", member.WorkspaceId, "view", viewId, new { linkId = link.Id, link.Answers });
        await db.SaveChangesAsync(ct);
        return true;
    }
}

/// <summary>
/// A form link as the Sites process and the answer route read it (Phase 16): the link by its token's
/// hash in any workspace, then in its own: its form view, its database (live, in a shared section, in
/// a workspace not deleted), the form for a link, and whether it takes answers now.
/// </summary>
public sealed record FormLinkState(FormLink Link, DatabaseView View, Page Database, WorkspaceDatabase Record, Schema Schema, FormConfig Form, string State, TimeZoneInfo Zone)
{
    /// <summary>The form's title: its own, else the view's name.</summary>
    public string Title => Form.Title ?? (View.Name.Length > 0 ? View.Name : Database.Title);

    public QueryContext Context(DateTimeOffset now)
    {
        var local = TimeZoneInfo.ConvertTime(now, Zone);
        return new QueryContext(local.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture), Zone.GetUtcOffset(now).TotalMinutes, null, null);
    }
}

public static class FormLinkReader
{
    /// <summary>The link the token names and what it answers, or null (an unknown token, a link deleted, a form or database gone).</summary>
    public static async Task<FormLinkState?> ReadAsync(CgwDb db, string? token, DateTimeOffset now, CancellationToken ct = default)
    {
        if (FormKeys.Hash(token) is not { } hash) return null;
        var link = await db.FormLinks.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(l => l.TokenHash == hash, ct);
        if (link is null) return null;
        var workspace = await db.Workspaces.AsNoTracking().Where(w => w.Id == link.WorkspaceId && w.DeletedAt == null).Select(w => new { w.TimeZone }).FirstOrDefaultAsync(ct);
        if (workspace is null) return null;
        db.Scope.Enter(link.WorkspaceId);
        var view = await db.DatabaseViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == link.ViewId && v.DatabaseId == link.DatabaseId, ct);
        if (view is null || view.Type != DatabaseOps.FormView) return null;
        var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == link.DatabaseId && p.Kind == PageKinds.Database && p.DeletedAt == null, ct);
        if (page is null) return null;
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == page.Id, ct);
        if (record is null) return null;
        var schema = DatabaseService.SchemaOf(record);
        var form = FormRules.Read(JsonNode.Parse(string.IsNullOrEmpty(view.Config) ? "{}" : view.Config), schema, link: true);
        var state = FormLinkStates.Of(link, now);
        // A database in the trash or moved into a private section takes no answers: the link is off.
        if (state == FormLinkStates.Open && (page.TrashedAt is not null
            || await db.Sections.AsNoTracking().Where(s => s.Id == page.SectionId).Select(s => s.Visibility).FirstOrDefaultAsync(ct) == "private"))
            state = FormLinkStates.Off;
        return new FormLinkState(link, view, page, record, schema, form, state, AutomationTimes.Zone(workspace.TimeZone));
    }
}

/// <summary>What became of a link's answer.</summary>
public enum AnswerOutcome
{
    Added,
    /// <summary>The trap field was filled: answered as if added, nothing written.</summary>
    Dropped,
    Unknown,
    Off,
    Closed,
    Full,
    Refused,
}

/// <summary>
/// A form link's answer (Phase 16, M16.2): the link and its state read again, the answer read from
/// its fields and checked by the form rules (a link's questions only), then, in the workspace's lock,
/// the link's count raised by one statement that holds its switch, closing time and maximum, and the
/// row added through <see cref="DatabaseOps"/> with no member (its creator empty, its form the view),
/// audited with the address. The API process's route only; no session is read.
/// </summary>
public sealed class FormAnswers(CgwDb db, ChangeLog changes, Audit audit, DatabaseOps databases, TimeProvider clock)
{
    public sealed record Answer(AnswerOutcome Outcome, Guid? RowId = null, IReadOnlyList<FormProblem>? Problems = null);

    public async Task<Answer> AnswerAsync(string token, IReadOnlyDictionary<string, string[]> fields, Actor actor, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        var state = await FormLinkReader.ReadAsync(db, token, now, ct);
        if (state is null) return new Answer(AnswerOutcome.Unknown);
        var outcome = Outcome(state.State);
        if (outcome != AnswerOutcome.Added) return new Answer(outcome);
        if (FormPosts.One(fields, FormPosts.Trap) is not null) return new Answer(AnswerOutcome.Dropped);
        var raw = FormPosts.Read(state.Form, state.Schema, fields, state.Zone);
        var (answer, problems) = FormRules.Check(state.Form, state.Schema, raw, state.Context(now));
        if (answer is null) return new Answer(AnswerOutcome.Refused, null, problems);

        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(state.Link.WorkspaceId, ct);
            databases.Reset();
            // One answer more, only while it takes answers (a switch, a close or the maximum reached
            // since the read above wins).
            var taken = await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE [FormLinks] SET [Answers] = [Answers] + 1 WHERE [Id] = {GuidBytes.ToBytes(state.Link.Id)} AND [Enabled] = 1 AND ([ClosesAt] IS NULL OR [ClosesAt] > {now}) AND ([MaxAnswers] IS NULL OR [Answers] < [MaxAnswers])", ct);
            if (taken == 0)
            {
                await tx.RollbackAsync(ct);
                var again = await FormLinkReader.ReadAsync(db, token, now, ct);
                return new Answer(again is null ? AnswerOutcome.Unknown : Outcome(again.State) is var o && o != AnswerOutcome.Added ? o : AnswerOutcome.Full);
            }
            var database = await databases.DatabaseAsync(state.Database.Id, ct);
            var parent = await db.Pages.FirstOrDefaultAsync(p => p.Id == state.Database.Id && p.DeletedAt == null && p.TrashedAt == null, ct);
            if (database is null || parent is null)
            {
                await tx.RollbackAsync(ct);
                return new Answer(AnswerOutcome.Off);
            }
            var last = await db.Pages.AsNoTracking().Where(p => p.SectionId == parent.SectionId && p.ParentPageId == parent.Id && p.DeletedAt == null)
                .OrderByDescending(p => p.OrderKey).Select(p => p.OrderKey).FirstOrDefaultAsync(ct);
            var title = answer.Title;
            var page = new Page
            {
                Id = Guid.CreateVersion7(),
                WorkspaceId = parent.WorkspaceId,
                SectionId = parent.SectionId,
                ParentPageId = parent.Id,
                OrderKey = OrderKeys.Between(last, null),
                Kind = PageKinds.Row,
                Title = title,
                SearchTitle = TextNormaliser.Normalise(title),
                Version = 1,
                CreatedBy = Guid.Empty,
                UpdatedBy = Guid.Empty,
                CreatedAt = now,
                UpdatedAt = now,
                FormId = state.View.Id,
            };
            db.Pages.Add(page);
            using var payload = JsonDocument.Parse($"{{\"row\":{{\"values\":{ValueJson.WriteMap(answer.Values)}}}}}");
            await databases.CreateAnsweredRowAsync(page, database, payload.RootElement, ct);
            await databases.FlushAsync(ct);
            audit.Add(actor, "form.answer", parent.WorkspaceId, "view", state.View.Id, new { linkId = state.Link.Id, rowId = page.Id });
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
            return new Answer(AnswerOutcome.Added, page.Id);
        });
    }

    private static AnswerOutcome Outcome(string state) => state switch
    {
        FormLinkStates.Open => AnswerOutcome.Added,
        FormLinkStates.Closed => AnswerOutcome.Closed,
        FormLinkStates.Full => AnswerOutcome.Full,
        _ => AnswerOutcome.Off,
    };
}
