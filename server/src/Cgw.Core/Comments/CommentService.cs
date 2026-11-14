using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Notifications;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;
using IsolationLevel = System.Data.IsolationLevel;

namespace Cgw.Core.Comments;

public sealed record CommentAnchorDto(string? Start, string? End);

public sealed record CommentDto(Guid Id, Guid ThreadId, PersonRef Author, JsonElement Body, DateTimeOffset CreatedAt, DateTimeOffset? EditedAt);

public sealed record ThreadDto(
    Guid Id,
    Guid PageId,
    string BlockId,
    CommentAnchorDto Anchor,
    /// <summary>The text the comment was made on, at most 1,000 characters; "" for a whole block.</summary>
    string Quote,
    PersonRef CreatedBy,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ResolvedAt,
    PersonRef? ResolvedBy,
    long Version,
    /// <summary>In order; deleted ones left out.</summary>
    IReadOnlyList<CommentDto> Comments);

public sealed record ThreadsDto(IReadOnlyList<ThreadDto> Threads);

public sealed record NewCommentRequest(Guid Id, JsonElement Body);

public sealed record NewThreadRequest(Guid Id, string? BlockId, JsonElement Anchor, string? Quote, NewCommentRequest? Comment);

public sealed record ThreadUpdateRequest(bool? Resolved);

public sealed record CommentUpdateRequest(JsonElement Body);

/// <summary>A thread found by its id and opened for the caller as its page is (<see cref="PageGate"/>).</summary>
public sealed record OpenThread(PageAccess Access, CommentThread Thread);

/// <summary>A comment found by its id, with its thread, opened for the caller.</summary>
public sealed record OpenComment(PageAccess Access, CommentThread Thread, Comment Comment);

/// <summary>
/// Comments (Phase 6 contracts, section 3): threads anchored on a block, online only. Listing needs
/// <c>view</c> on the page; a thread, a reply, resolving and reopening need <c>comment</c>; a
/// comment is edited by its author only and deleted by its author or someone with <c>full</c>;
/// deleting a thread's first comment deletes the thread. Ids are the client's: a create repeated by
/// the same person answers with what is stored. Every write appends a <c>comments</c> change for the
/// page (shown to whoever can read it) and its notifications, in one transaction under the
/// workspace's lock. A share link reaches none of this.
/// </summary>
public sealed class CommentService(CgwDb db, PageGate gate, Access access, ChangeLog changes, TimeProvider clock)
{
    /// <summary>Now, to the millisecond the columns keep: an answer says what is stored.</summary>
    private DateTimeOffset Now()
    {
        var now = clock.GetUtcNow();
        return now.AddTicks(-(now.Ticks % TimeSpan.TicksPerMillisecond));
    }

    public static Failure NoThread() => Failure.NotFound("No such comment thread");
    public static Failure NoComment() => Failure.NotFound("No such comment");

    public async Task<Result<OpenThread>> OpenThreadAsync(Guid userId, Guid threadId, CancellationToken ct = default)
    {
        var thread = await db.CommentThreads.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(t => t.Id == threadId, ct);
        if (thread is null || thread.DeletedAt is not null) return NoThread();
        var opened = await gate.OpenAsync(userId, thread.PageId, ct);
        // Someone who cannot see the page learns nothing of its threads.
        if (!opened.Ok) return opened.Failure!.Status == 404 ? NoThread() : opened.Failure!;
        return new OpenThread(opened.Value!, thread);
    }

    public async Task<Result<OpenComment>> OpenCommentAsync(Guid userId, Guid commentId, CancellationToken ct = default)
    {
        var comment = await db.Comments.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(c => c.Id == commentId, ct);
        if (comment is null || comment.DeletedAt is not null) return NoComment();
        var thread = await OpenThreadAsync(userId, comment.ThreadId, ct);
        if (!thread.Ok) return thread.Failure!.Code == Codes.NotFound ? NoComment() : thread.Failure!;
        return new OpenComment(thread.Value!.Access, thread.Value.Thread, comment);
    }

    public async Task<Result<ThreadsDto>> ListAsync(PageAccess page, string? state, CancellationToken ct = default)
    {
        state ??= "open";
        if (state is not ("open" or "resolved" or "all")) return Failure.Invalid("state is open, resolved or all");
        var query = db.CommentThreads.AsNoTracking().Where(t => t.PageId == page.Page.Id && t.DeletedAt == null);
        if (state == "open") query = query.Where(t => t.ResolvedAt == null);
        else if (state == "resolved") query = query.Where(t => t.ResolvedAt != null);
        var threads = await query.OrderBy(t => t.CreatedAt).ThenBy(t => t.Id).ToListAsync(ct);
        return new ThreadsDto(await DtosAsync(threads, ct));
    }

    public async Task<Result<(ThreadDto Thread, bool Created)>> CreateThreadAsync(PageAccess page, NewThreadRequest request, CancellationToken ct = default)
    {
        if (!Levels.AtLeast(page.Level, Levels.Comment)) return Failure.Denied("You may not comment on this page");
        var me = page.Member.UserId;
        // A repeat (a lost answer) is answered with what is stored, to the one who made it.
        if (request.Id != Guid.Empty && await db.CommentThreads.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(t => t.Id == request.Id, ct) is { } known)
            return await AgainAsync(known, page, me, ct);
        if (!CommentRules.ClientId(request.Id)) return CommentRules.Invalid("The thread's id is a UUIDv7");
        if (!CommentRules.BlockId(request.BlockId)) return CommentRules.Invalid("blockId is 12 characters of base 62");
        var anchor = CommentRules.Anchor(request.Anchor);
        if (!anchor.Ok) return anchor.Failure!;
        var quote = CommentRules.Quote(request.Quote);
        if (!quote.Ok) return quote.Failure!;
        if (request.Comment is not { } first) return CommentRules.Invalid("A thread starts with a comment");
        if (!CommentRules.ClientId(first.Id)) return CommentRules.Invalid("The comment's id is a UUIDv7");
        var body = CommentRules.Body(first.Body);
        if (!body.Ok) return body.Failure!;
        if (await db.Comments.IgnoreQueryFilters([CgwDb.Tenant]).AnyAsync(c => c.Id == first.Id, ct))
            return Failure.Conflict(Codes.Conflict, "That comment id is taken");

        var now = Now();
        var thread = new CommentThread
        {
            Id = request.Id,
            WorkspaceId = page.Page.WorkspaceId,
            PageId = page.Page.Id,
            BlockId = request.BlockId!,
            AnchorStart = anchor.Value!.Start,
            AnchorEnd = anchor.Value.End,
            Quote = quote.Value!,
            CreatedBy = me,
            CreatedAt = now,
            Version = 1,
        };
        var comment = new Comment
        {
            Id = first.Id,
            WorkspaceId = thread.WorkspaceId,
            ThreadId = thread.Id,
            PageId = thread.PageId,
            AuthorUserId = me,
            Body = body.Value!.Json,
            CreatedAt = now,
        };
        try
        {
            await WriteAsync(page, thread, async () =>
            {
                db.CommentThreads.Add(thread);
                db.Comments.Add(comment);
                await NotifyAsync(page, thread, comment, body.Value, [], ct);
            }, ct);
        }
        catch (DbUpdateException)
        {
            // The same create raced itself: answer as the repeat it is.
            db.ChangeTracker.Clear();
            if (await db.CommentThreads.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(t => t.Id == request.Id, ct) is { } raced)
                return await AgainAsync(raced, page, me, ct);
            throw;
        }
        return ((await DtosAsync([thread], ct))[0], true);
    }

    private async Task<Result<(ThreadDto, bool)>> AgainAsync(CommentThread known, PageAccess page, Guid me, CancellationToken ct)
    {
        if (known.CreatedBy != me || known.PageId != page.Page.Id || known.DeletedAt is not null) return Failure.Conflict(Codes.Conflict, "That thread id is taken");
        return ((await DtosAsync([known], ct))[0], false);
    }

    public async Task<Result<ThreadDto>> ResolveAsync(OpenThread open, ThreadUpdateRequest request, CancellationToken ct = default)
    {
        if (!Levels.AtLeast(open.Access.Level, Levels.Comment)) return Failure.Denied("You may not comment on this page");
        if (request.Resolved is not { } resolved) return Failure.Invalid("resolved is true or false");
        var thread = open.Thread;
        if ((thread.ResolvedAt is not null) != resolved)
        {
            var me = open.Access.Member.UserId;
            var now = Now();
            await WriteAsync(open.Access, thread, async () =>
            {
                var id = thread.Id;
                await db.CommentThreads.Where(t => t.Id == id).ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.ResolvedAt, resolved ? now : null)
                    .SetProperty(t => t.ResolvedBy, resolved ? me : null)
                    .SetProperty(t => t.Version, t => t.Version + 1), ct);
            }, ct);
        }
        var current = await db.CommentThreads.AsNoTracking().FirstAsync(t => t.Id == thread.Id, ct);
        return (await DtosAsync([current], ct))[0];
    }

    public async Task<Result<(CommentDto Comment, bool Created)>> ReplyAsync(OpenThread open, NewCommentRequest request, CancellationToken ct = default)
    {
        if (!Levels.AtLeast(open.Access.Level, Levels.Comment)) return Failure.Denied("You may not comment on this page");
        var me = open.Access.Member.UserId;
        if (request.Id != Guid.Empty && await db.Comments.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(c => c.Id == request.Id, ct) is { } known)
            return await ReplyAgainAsync(known, open, me, ct);
        if (!CommentRules.ClientId(request.Id)) return CommentRules.Invalid("The comment's id is a UUIDv7");
        var body = CommentRules.Body(request.Body);
        if (!body.Ok) return body.Failure!;
        var thread = open.Thread;
        var comment = new Comment
        {
            Id = request.Id,
            WorkspaceId = thread.WorkspaceId,
            ThreadId = thread.Id,
            PageId = thread.PageId,
            AuthorUserId = me,
            Body = body.Value!.Json,
            CreatedAt = Now(),
        };
        try
        {
            await WriteAsync(open.Access, thread, async () =>
            {
                // Everyone in the thread so far: its maker and every earlier commenter.
                var earlier = await db.Comments.AsNoTracking().Where(c => c.ThreadId == thread.Id).Select(c => c.AuthorUserId).Distinct().ToListAsync(ct);
                db.Comments.Add(comment);
                await BumpAsync(thread.Id, ct);
                await NotifyAsync(open.Access, thread, comment, body.Value, earlier.Append(thread.CreatedBy).ToHashSet(), ct);
            }, ct);
        }
        catch (DbUpdateException)
        {
            db.ChangeTracker.Clear();
            if (await db.Comments.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().FirstOrDefaultAsync(c => c.Id == request.Id, ct) is { } raced)
                return await ReplyAgainAsync(raced, open, me, ct);
            throw;
        }
        return (await CommentDtoAsync(comment, ct), true);
    }

    private async Task<Result<(CommentDto, bool)>> ReplyAgainAsync(Comment known, OpenThread open, Guid me, CancellationToken ct)
    {
        if (known.AuthorUserId != me || known.ThreadId != open.Thread.Id || known.DeletedAt is not null) return Failure.Conflict(Codes.Conflict, "That comment id is taken");
        return (await CommentDtoAsync(known, ct), false);
    }

    public async Task<Result<CommentDto>> EditAsync(OpenComment open, CommentUpdateRequest request, CancellationToken ct = default)
    {
        var me = open.Access.Member.UserId;
        if (open.Comment.AuthorUserId != me) return Failure.Denied("Only its author edits a comment");
        if (!Levels.AtLeast(open.Access.Level, Levels.Comment)) return Failure.Denied("You may not comment on this page");
        var body = CommentRules.Body(request.Body);
        if (!body.Ok) return body.Failure!;
        var now = Now();
        var comment = open.Comment;
        await WriteAsync(open.Access, open.Thread, async () =>
        {
            var (id, json) = (comment.Id, body.Value!.Json);
            await db.Comments.Where(c => c.Id == id).ExecuteUpdateAsync(s => s.SetProperty(c => c.Body, json).SetProperty(c => c.EditedAt, now), ct);
            await BumpAsync(open.Thread.Id, ct);
            // Someone the edit newly mentions is told; a mention already told is not told again.
            await NotifyAsync(open.Access, open.Thread, comment, body.Value, [], ct, replies: false);
        }, ct);
        var current = await db.Comments.AsNoTracking().FirstAsync(c => c.Id == comment.Id, ct);
        return await CommentDtoAsync(current, ct);
    }

    public async Task<Result<bool>> DeleteAsync(OpenComment open, CancellationToken ct = default)
    {
        var me = open.Access.Member.UserId;
        var mayDelete = (open.Comment.AuthorUserId == me && Levels.AtLeast(open.Access.Level, Levels.Comment)) || open.Access.Level == Levels.Full;
        if (!mayDelete) return Failure.Denied("Only its author, or someone with full access to the page, deletes a comment");
        var now = Now();
        var thread = open.Thread;
        await WriteAsync(open.Access, thread, async () =>
        {
            var id = open.Comment.Id;
            await db.Comments.Where(c => c.Id == id).ExecuteUpdateAsync(s => s.SetProperty(c => c.DeletedAt, now), ct);
            // The thread's first comment is the thread: it goes with it.
            var first = await db.Comments.AsNoTracking().Where(c => c.ThreadId == thread.Id).OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).Select(c => c.Id).FirstAsync(ct);
            if (first == id)
                await db.CommentThreads.Where(t => t.Id == thread.Id).ExecuteUpdateAsync(s => s.SetProperty(t => t.DeletedAt, now).SetProperty(t => t.Version, t => t.Version + 1), ct);
            else await BumpAsync(thread.Id, ct);
        }, ct);
        return true;
    }

    private async Task BumpAsync(Guid threadId, CancellationToken ct) =>
        await db.CommentThreads.Where(t => t.Id == threadId).ExecuteUpdateAsync(s => s.SetProperty(t => t.Version, t => t.Version + 1), ct);

    /// <summary>One write: under the workspace's lock, with the page's <c>comments</c> change, in one transaction.</summary>
    private async Task WriteAsync(PageAccess page, CommentThread thread, Func<Task> write, CancellationToken ct)
    {
        var strategy = db.Database.CreateExecutionStrategy();
        await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(page.Page.WorkspaceId, ct);
            await write();
            changes.Add("comments", page.Page.Id, "upsert", thread.Version, page.Member.UserId);
            await db.SaveChangesAsync(ct);
            await changes.FlushAsync(ct);
            await tx.CommitAsync(ct);
        });
    }

    /// <summary>
    /// <c>commentMention</c> for the people the body mentions; <c>reply</c> for the thread's earlier
    /// participants it does not mention; never the author, never someone who cannot read the page.
    /// </summary>
    private async Task NotifyAsync(PageAccess page, CommentThread thread, Comment comment, CommentBodyParsed body, HashSet<Guid> participants, CancellationToken ct, bool replies = true)
    {
        var author = comment.AuthorUserId;
        var mentioned = body.UserMentions.Where(u => u != author).ToHashSet();
        var replied = replies ? participants.Where(u => u != author && !mentioned.Contains(u)).ToHashSet() : [];
        if (mentioned.Count == 0 && replied.Count == 0) return;
        var readers = await access.ReadersAsync(page.Page.WorkspaceId, page.Page.Id, mentioned.Concat(replied), ct);
        var excerpt = CommentRules.Excerpt(body.Text);
        var now = Now();
        Notification Make(Guid user, string kind, string key) => new()
        {
            Id = Guid.CreateVersion7(),
            WorkspaceId = page.Page.WorkspaceId,
            UserId = user,
            Kind = kind,
            PageId = page.Page.Id,
            BlockId = thread.BlockId,
            ThreadId = thread.Id,
            CommentId = comment.Id,
            ActorUserId = author,
            Excerpt = excerpt,
            DedupeKey = key,
            CreatedAt = now,
        };
        var candidates = mentioned.Where(readers.Contains).Select(u => Make(u, NotificationKinds.CommentMention, NotificationService.CommentMentionKey(comment.Id)))
            .Concat(replied.Where(readers.Contains).Select(u => Make(u, NotificationKinds.Reply, NotificationService.ReplyKey(comment.Id))))
            .ToList();
        await NotificationService.AddAsync(db, changes, candidates, ct);
    }

    private async Task<CommentDto> CommentDtoAsync(Comment comment, CancellationToken ct)
    {
        var people = await People.RefsAsync(db, [comment.AuthorUserId], ct);
        return ToDto(comment, people);
    }

    private static CommentDto ToDto(Comment c, IReadOnlyDictionary<Guid, PersonRef> people) =>
        new(c.Id, c.ThreadId, People.Of(people, c.AuthorUserId), Element(c.Body), c.CreatedAt, c.EditedAt);

    private static JsonElement Element(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private async Task<List<ThreadDto>> DtosAsync(IReadOnlyList<CommentThread> threads, CancellationToken ct)
    {
        if (threads.Count == 0) return [];
        var ids = threads.Select(t => t.Id).ToList();
        var comments = new List<Comment>();
        foreach (var chunk in ids.Chunk(1000).Select(c => c.ToList()))
            comments.AddRange(await db.Comments.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking()
                .Where(c => chunk.Contains(c.ThreadId) && c.DeletedAt == null).ToListAsync(ct));
        var people = await People.RefsAsync(db, threads.Select(t => t.CreatedBy).Concat(threads.Where(t => t.ResolvedBy is not null).Select(t => t.ResolvedBy!.Value))
            .Concat(comments.Select(c => c.AuthorUserId)), ct);
        var byThread = comments.ToLookup(c => c.ThreadId);
        return threads.Select(t => new ThreadDto(
            t.Id, t.PageId, t.BlockId,
            new CommentAnchorDto(t.AnchorStart is { } a ? Convert.ToBase64String(a) : null, t.AnchorEnd is { } b ? Convert.ToBase64String(b) : null),
            t.Quote, People.Of(people, t.CreatedBy), t.CreatedAt, t.ResolvedAt,
            t.ResolvedBy is { } by ? People.Of(people, by) : null, t.Version,
            byThread[t.Id].OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).Select(c => ToDto(c, people)).ToList())).ToList();
    }
}
