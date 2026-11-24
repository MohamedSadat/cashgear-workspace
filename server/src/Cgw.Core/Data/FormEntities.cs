namespace Cgw.Core.Data;

// Phase 16: forms (DATA_MODEL.md, Forms). Tenant-owned and filtered; the Sites process finds a link
// by its token's hash across workspaces, then reads in the link's own.

/// <summary>
/// A form view's link: anyone holding its token answers the form with no session, while it is on,
/// before its closing time and under its maximum. One a form; deleted for good (a new link is a new
/// token).
/// </summary>
public sealed class FormLink : ITenantOwned
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid DatabaseId { get; set; }
    /// <summary>The form view (<c>DatabaseViews</c>, type <c>form</c>) the link answers.</summary>
    public Guid ViewId { get; set; }
    /// <summary>SHA-256 of the token (32 random bytes, base64url): how the link is found.</summary>
    public byte[] TokenHash { get; set; } = [];
    /// <summary>The token as Data Protection's output (<c>Cgw.Forms.Link.v1</c>), so full access reads the link again.</summary>
    public string TokenCipher { get; set; } = "";
    /// <summary>Its own switch: off, it takes no answers and its page says so.</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>It takes no answers from this instant.</summary>
    public DateTimeOffset? ClosesAt { get; set; }
    /// <summary>It takes no answers once it has this many.</summary>
    public int? MaxAnswers { get; set; }
    /// <summary>The answers it has taken (rows added), counted in each answer's transaction.</summary>
    public int Answers { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    /// <summary>Rises on every change of its settings (the Sites process's drawn page is keyed by it).</summary>
    public long Version { get; set; } = 1;
}
