using Cgw.Core.Data;
using Cgw.Core.Documents;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Workbooks;

/// <summary>
/// <c>POST /pages/{id}/erp-commits</c>'s body (INTEGRATIONS.md, <c>Commit</c> and <c>CommitStatus</c>):
/// one real commit attempt from an ERP block of the page, as the client saw it end. No value, record
/// or field name: how many.
/// </summary>
public sealed record ErpCommitReport
{
    public Guid? LinkId { get; init; }
    public string? ConnectorId { get; init; }
    public string? CommitId { get; init; }
    public string? BlockId { get; init; }
    public string? Outcome { get; init; }
    public int? Records { get; init; }
    public int? Fields { get; init; }
}

/// <summary>
/// Workspace's own audit of ERP commits (Phase 7, M7.1): who tried which commit from which page and
/// block, through which link, and how it ended. The ERP's per-field audit is the authority; this
/// records the attempt on Workspace's side, without values. A person who can read the page may
/// report one: the ERP decides who may write.
/// </summary>
public sealed class ErpCommitService(CgwDb db, Audit audit)
{
    public static readonly string[] Outcomes = ["committed", "conflict", "refused", "unknown", "failed"];

    public const int MaxRecords = 500;
    public const int MaxFields = 100_000;

    private static bool BlockId(string? id) => id is null || (id.Length == 12 && id.All(char.IsAsciiLetterOrDigit));

    private static bool ConnectorId(string? id) => id is { Length: > 0 and <= 100 } && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.');

    public async Task<Result<bool>> RecordAsync(PageAccess page, Actor actor, ErpCommitReport report, CancellationToken ct = default)
    {
        if (report.LinkId is not { } linkId) return Failure.Invalid("linkId is the workspace's ERP link");
        if (!ConnectorId(report.ConnectorId)) return Failure.Invalid("connectorId is the ERP connector's id");
        if (!Guid.TryParse(report.CommitId, out var commitId)) return Failure.Invalid("commitId is the commit's UUID");
        if (!BlockId(report.BlockId)) return Failure.Invalid("blockId is a block's id or null");
        if (report.Outcome is not { } outcome || !Outcomes.Contains(outcome)) return Failure.Invalid("outcome is one of " + string.Join(", ", Outcomes));
        if (report.Records is not (>= 0 and <= MaxRecords)) return Failure.Invalid($"records is 0 to {MaxRecords}");
        if (report.Fields is not (>= 0 and <= MaxFields)) return Failure.Invalid($"fields is 0 to {MaxFields}");
        // The page's workspace's own live link (the tenant scope is the page's).
        var link = await db.ErpLinks.AsNoTracking().Where(l => l.Id == linkId && l.RevokedAt == null)
            .Select(l => new { l.Id, l.ErpLinkId, l.Company }).FirstOrDefaultAsync(ct);
        if (link is null) return Failure.Invalid("linkId is not a live ERP link of this workspace");
        await audit.WriteAsync(actor, "erp.commit", page.Member.WorkspaceId, "page", page.Page.Id, new
        {
            linkId = link.Id,
            erpLinkId = link.ErpLinkId,
            company = link.Company,
            connectorId = report.ConnectorId,
            commitId = commitId.ToString("D"),
            blockId = report.BlockId,
            outcome,
            records = report.Records,
            fields = report.Fields,
        });
        return true;
    }
}
