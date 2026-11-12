using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Cgw.Core.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Search;

public sealed record SearchHitDto(Guid PageId, string Title, string Snippet, double Score);
public sealed record SearchResultDto(IReadOnlyList<SearchHitDto> Hits, string? Cursor);

/// <summary>
/// Whether the server has full-text search (Q7), asked once: full-text installed and the index
/// the <c>SearchFullText</c> migration makes where it is. Otherwise search uses LIKE.
/// </summary>
public sealed class FullText
{
    private volatile int state;

    public bool? Known => state == 0 ? null : state == 1;

    public async Task<bool> AvailableAsync(CgwDb db, CancellationToken ct = default)
    {
        if (state != 0) return state == 1;
        var found = await db.Database.SqlQueryRaw<int>(
            """
            SELECT CASE WHEN FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') = 1
                AND EXISTS (SELECT 1 FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID(N'dbo.PageDocDerived'))
                THEN 1 ELSE 0 END AS Value
            """).ToListAsync(ct);
        state = found.Count == 1 && found[0] == 1 ? 1 : 2;
        return state == 1;
    }
}

/// <summary>
/// Server search (M2.7; ARCHITECTURE.md, Search): the query is normalised as the clients do (D25),
/// and every term must begin a word of the page's title or of its text. Titles rank first. Pages
/// in the trash or deleted are left out, and what the caller may not read is filtered at query
/// time, never by the client. Pages come in keyset order (title terms matched, then most recently
/// changed, then id) under a cursor sealed with Data Protection to its user and workspace: it may
/// hold the key of a page the caller cannot see (the last one scanned), and says nothing of it.
/// </summary>
public sealed class SearchService(CgwDb db, Access access, FullText fullText, IDataProtectionProvider protection)
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 50;
    public const int MaxTerms = 8;
    private const int Rounds = 10;
    public const string CursorPurpose = "Cgw.Search.Cursor.v1";

    private IDataProtector Protector(Member member) =>
        protection.CreateProtector(CursorPurpose, member.WorkspaceId.ToString("N"), member.UserId.ToString("N"));

    private sealed record Key(int TitleHits, DateTimeOffset UpdatedAt, Guid PageId);

    /// <summary>One row of the named search query.</summary>
    private sealed class Row
    {
        public byte[] PageId { get; set; } = [];
        public string Title { get; set; } = "";
        public DateTimeOffset UpdatedAt { get; set; }
        public int TitleHits { get; set; }
    }

    public async Task<Result<SearchResultDto>> SearchAsync(Member member, string? q, int? limit, string? cursor, CancellationToken ct = default)
    {
        var size = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var terms = TextNormaliser.Terms(TextNormaliser.Normalise(q ?? "")).Distinct().Take(MaxTerms)
            .Select(t => t.Length > 100 ? t[..100] : t).ToArray();
        if (terms.Length == 0) return new SearchResultDto([], null);
        Key? after = null;
        var protector = Protector(member);
        if (!string.IsNullOrEmpty(cursor))
        {
            after = Decode(protector, cursor);
            if (after is null) return Failure.Invalid("The cursor is not valid");
        }

        var full = await fullText.AvailableAsync(db, ct);
        var levels = await access.AllLevelsAsync(member);
        var hits = new List<(Key Key, string Title)>();
        var take = Math.Max(size * 3, 60);
        var exhausted = false;
        Key? scanned = after;
        for (var round = 0; round < Rounds && hits.Count <= size; round++)
        {
            var rows = await QueryAsync(member.WorkspaceId, terms, full, scanned, take, ct);
            foreach (var row in rows)
            {
                var key = new Key(row.TitleHits, row.UpdatedAt, GuidBytes.FromBytes(row.PageId));
                scanned = key;
                if (levels.GetValueOrDefault(key.PageId, Levels.None) == Levels.None) continue;
                hits.Add((key, row.Title));
                if (hits.Count > size) break;
            }
            if (rows.Count < take)
            {
                exhausted = true;
                break;
            }
        }
        string? next;
        if (hits.Count > size)
        {
            hits.RemoveRange(size, hits.Count - size);
            next = Encode(protector, hits[^1].Key);
        }
        else next = exhausted || scanned is null ? null : Encode(protector, scanned);

        var ids = hits.Select(h => h.Key.PageId).ToList();
        var texts = await db.PageDocDerived.AsNoTracking().Where(d => ids.Contains(d.PageId))
            .Select(d => new { d.PageId, Text = d.PlainText.Substring(0, 20_000) })
            .ToDictionaryAsync(d => d.PageId, d => d.Text, ct);
        var result = hits.Select(h => new SearchHitDto(
                h.Key.PageId,
                h.Title,
                Snippet(texts.GetValueOrDefault(h.Key.PageId) ?? "", terms),
                1 + (double)h.Key.TitleHits / terms.Length))
            .ToList();
        return new SearchResultDto(result, next);
    }

    /// <summary>
    /// The named search query. Both columns hold normalised text (single spaces between words),
    /// so a word starting with a term is <c>' ' + column LIKE '% term%'</c>; with full-text, the
    /// text side is <c>CONTAINS(SearchText, '"term*"')</c> instead. LIKE compares code points (a
    /// binary collation): both sides are already lowercased and folded, so the database's
    /// linguistic collation would change nothing but the time, four to eight times as long over
    /// 10,000 pages (bench/phase2.mjs). Ids are binary(16) here, as raw SQL bypasses EF's
    /// converters.
    /// </summary>
    private async Task<List<Row>> QueryAsync(Guid workspaceId, string[] terms, bool full, Key? after, int take, CancellationToken ct)
    {
        var parameters = new List<SqlParameter>
        {
            new("@ws", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(workspaceId) },
            new("@take", System.Data.SqlDbType.Int) { Value = take },
        };
        var titleHits = new List<string>();
        var where = new List<string>();
        for (var i = 0; i < terms.Length; i++)
        {
            parameters.Add(new SqlParameter($"@t{i}", System.Data.SqlDbType.NVarChar, 300) { Value = "% " + EscapeLike(terms[i]) + "%" });
            var title = $"(N' ' + p.SearchTitle) COLLATE {CgwDb.BinaryCollation} LIKE @t{i} ESCAPE N'\\'";
            titleHits.Add($"CASE WHEN {title} THEN 1 ELSE 0 END");
            string text;
            if (full)
            {
                parameters.Add(new SqlParameter($"@f{i}", System.Data.SqlDbType.NVarChar, 300) { Value = "\"" + terms[i] + "*\"" });
                text = $"EXISTS (SELECT 1 FROM PageDocDerived d WHERE d.PageId = p.Id AND CONTAINS(d.SearchText, @f{i}))";
            }
            else text = $"EXISTS (SELECT 1 FROM PageDocDerived d WHERE d.PageId = p.Id AND (N' ' + d.SearchText) COLLATE {CgwDb.BinaryCollation} LIKE @t{i} ESCAPE N'\\')";
            where.Add($"({title} OR {text})");
        }
        var keyset = "";
        if (after is not null)
        {
            parameters.Add(new SqlParameter("@ct", System.Data.SqlDbType.Int) { Value = after.TitleHits });
            parameters.Add(new SqlParameter("@cu", System.Data.SqlDbType.DateTimeOffset) { Value = after.UpdatedAt });
            parameters.Add(new SqlParameter("@ci", System.Data.SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(after.PageId) });
            keyset = "WHERE h.TitleHits < @ct OR (h.TitleHits = @ct AND (h.UpdatedAt < @cu OR (h.UpdatedAt = @cu AND h.PageId > @ci)))";
        }
        var sql = $"""
            SELECT TOP (@take) h.PageId, h.Title, h.UpdatedAt, h.TitleHits FROM (
                SELECT p.Id AS PageId, p.Title, p.UpdatedAt, ({string.Join(" + ", titleHits)}) AS TitleHits
                FROM Pages p
                WHERE p.WorkspaceId = @ws AND p.TrashedAt IS NULL AND p.DeletedAt IS NULL
                    AND {string.Join(" AND ", where)}
            ) h
            {keyset}
            ORDER BY h.TitleHits DESC, h.UpdatedAt DESC, h.PageId
            """;
        return await db.Database.SqlQueryRaw<Row>(sql, parameters.ToArray<object>()).ToListAsync(ct);
    }

    private static string EscapeLike(string term) =>
        term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace("[", "\\[");

    private static string Encode(IDataProtector protector, Key key) =>
        WebEncoders.Base64UrlEncode(protector.Protect(Encoding.UTF8.GetBytes(
            $"{key.TitleHits}|{key.UpdatedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)}|{key.PageId:N}")));

    /// <summary>The key a cursor holds; null when it was not sealed for this caller in this workspace.</summary>
    private static Key? Decode(IDataProtector protector, string cursor)
    {
        try
        {
            var parts = Encoding.UTF8.GetString(protector.Unprotect(WebEncoders.Base64UrlDecode(cursor))).Split('|');
            if (parts.Length == 3
                && int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var hits)
                && DateTimeOffset.TryParseExact(parts[1], "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var at)
                && Guid.TryParseExact(parts[2], "N", out var id))
                return new Key(hits, at, id);
        }
        catch (Exception e) when (e is FormatException or CryptographicException)
        {
        }
        return null;
    }

    /// <summary>
    /// A few words of the page's text around the first word a term begins, else its first words.
    /// Words are compared normalised, so Arabic and English match as the search did.
    /// </summary>
    public static string Snippet(string text, IReadOnlyList<string> terms, int before = 6, int length = 24)
    {
        var words = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return "";
        var at = -1;
        for (var i = 0; i < words.Length && at < 0; i++)
            foreach (var part in TextNormaliser.Terms(TextNormaliser.Normalise(words[i])))
                if (terms.Any(t => part.StartsWith(t, StringComparison.Ordinal)))
                {
                    at = i;
                    break;
                }
        var start = at < 0 ? 0 : Math.Max(0, at - before);
        var end = Math.Min(words.Length, start + length);
        var snippet = string.Join(' ', words[start..end]);
        if (snippet.Length > 200) snippet = snippet[..200];
        return (start > 0 ? "… " : "") + snippet + (end < words.Length ? " …" : "");
    }
}
