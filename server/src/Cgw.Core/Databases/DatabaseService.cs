using System.Data;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Databases;

public sealed record RowsPageDto(IReadOnlyList<RowDto> Rows, string? Next, long Total);

public sealed record QueryContextDto(string? Today = null, int? OffsetMinutes = null, Guid? Me = null, Dictionary<string, string>? People = null);

/// <summary>
/// <c>POST /databases/{id}/query</c>. Explicit <c>filter</c>, <c>sorts</c> and <c>group</c>
/// override the view's (a <c>null</c> group: no groups); the filter is a <c>FilterGroup</c>
/// (db/types.ts).
/// </summary>
public sealed record QueryRequestDto(
    Guid? ViewId = null,
    JsonElement? Filter = null,
    JsonElement? Sorts = null,
    JsonElement? Group = null,
    string? GroupKey = null,
    string? Search = null,
    QueryContextDto? Context = null,
    string? After = null,
    int? Limit = null);

public sealed record GroupCountDto(string Key, long Count);

public sealed record QueryResponseDto(IReadOnlyList<RowDto> Rows, IReadOnlyList<GroupCountDto>? Groups, long Total, string? Next);

/// <summary><c>columns[i]</c>: the property the file's column i fills, or null to leave it out.</summary>
public sealed record ImportRequestDto(string? Csv, IReadOnlyList<string?>? Columns, bool Header = false);

public sealed record ImportProblemDto(int Line, string Message);

public sealed record ImportResponseDto(long Created, IReadOnlyList<ImportProblemDto> Problems);

/// <summary>
/// The database routes' work (contract section 4): a device's full fetch of rows, the server's
/// query (the C# port of <c>queryRows</c> over the cached rows), CSV import in batches, and CSV
/// export of a view.
/// </summary>
public sealed class DatabaseService(CgwDb db, DatabaseRowCache cache, ChangeLog changes, TimeProvider clock)
{
    public const int DefaultRows = 500;
    public const int MaxRows = 1000;
    public const int DefaultQuery = 100;
    public const int MaxQuery = 500;
    /// <summary>Rows written per transaction by an import.</summary>
    public static int ImportBatch { get; set; } = 1000;

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<(Guid, long), Schema> Schemas = new();
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (long At, Query.Result Result)> Results = new(StringComparer.Ordinal);

    public static Schema SchemaOf(WorkspaceDatabase record)
    {
        if (Schemas.TryGetValue((record.PageId, record.Version), out var schema)) return schema;
        if (Schemas.Count > 2000) Schemas.Clear();
        return Schemas[(record.PageId, record.Version)] = Schema.Parse(record.PageId, record.Version, record.Properties);
    }

    // Rows ------------------------------------------------------------------------------------------

    /// <summary>The database's rows by id, trashed rows and templates included: a device's full fetch.</summary>
    public async Task<Result<RowsPageDto>> RowsAsync(Member member, Page database, string level, string? after, int? limit, CancellationToken ct)
    {
        var size = Math.Clamp(limit ?? DefaultRows, 1, MaxRows);
        Guid? from = null;
        if (!string.IsNullOrEmpty(after))
        {
            if (!Guid.TryParse(after, out var a)) return Failure.Invalid("after is a row id");
            from = a;
        }
        // By id in the database's byte order (UUIDv7: time order); raw SQL for the comparison, so
        // ids are binary(16) here (GuidBytes).
        var parameters = new object[]
        {
            new SqlParameter("@ws", SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(member.WorkspaceId) },
            new SqlParameter("@db", SqlDbType.Binary, 16) { Value = GuidBytes.ToBytes(database.Id) },
            new SqlParameter("@after", SqlDbType.Binary, 16) { Value = from is { } f ? GuidBytes.ToBytes(f) : DBNull.Value },
            new SqlParameter("@n", SqlDbType.Int) { Value = size + 1 },
        };
        var ids = (await db.Database.SqlQueryRaw<byte[]>("""
                SELECT TOP (@n) r.[PageId] AS [Value]
                FROM [DatabaseRows] r INNER JOIN [Pages] p ON p.[Id] = r.[PageId]
                WHERE r.[WorkspaceId] = @ws AND r.[DatabaseId] = @db AND p.[DeletedAt] IS NULL AND (@after IS NULL OR r.[PageId] > @after)
                ORDER BY r.[PageId]
                """, parameters).ToListAsync(ct))
            .Select(GuidBytes.FromBytes).ToList();
        var more = ids.Count > size;
        if (more) ids.RemoveAt(ids.Count - 1);
        var rows = await DtosAsync(ids, level, ct);
        var total = await db.DatabaseRows.Where(r => r.DatabaseId == database.Id)
            .Join(db.Pages, r => r.PageId, p => p.Id, (r, p) => p).LongCountAsync(p => p.DeletedAt == null, ct);
        return new RowsPageDto(rows, more ? ids[^1].ToString() : null, total);
    }

    /// <summary>Rows as they are now, in the order of <paramref name="ids"/>.</summary>
    private async Task<List<RowDto>> DtosAsync(IReadOnlyList<Guid> ids, string level, CancellationToken ct)
    {
        var pages = new Dictionary<Guid, Page>();
        var values = new Dictionary<Guid, DatabaseRow>();
        foreach (var chunk in Chunked.Of(ids))
        {
            foreach (var p in await db.Pages.AsNoTracking().Where(p => chunk.Contains(p.Id)).ToListAsync(ct)) pages[p.Id] = p;
            foreach (var r in await db.DatabaseRows.AsNoTracking().Where(r => chunk.Contains(r.PageId)).ToListAsync(ct)) values[r.PageId] = r;
        }
        return ids.Where(id => pages.ContainsKey(id) && values.ContainsKey(id) && pages[id].DeletedAt is null)
            .Select(id => RowDto.From(pages[id], values[id], level)).ToList();
    }

    // Query -----------------------------------------------------------------------------------------

    public static QueryContext Context(QueryContextDto? given, Member member, TimeProvider clock)
    {
        var offset = Math.Clamp(given?.OffsetMinutes ?? 0, -14 * 60, 14 * 60);
        var today = given?.Today is { } t && DbDates.IsDay(t)
            ? t
            : clock.GetUtcNow().ToOffset(TimeSpan.FromMinutes(offset)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var people = given?.People?.Take(10_000).ToDictionary(p => p.Key.ToLowerInvariant(), p => p.Value);
        return new QueryContext(today, offset, (given?.Me ?? member.UserId).ToString(), people);
    }

    /// <summary>
    /// Evaluated in memory over the database's cached rows (<see cref="DatabaseRowCache"/>), so a
    /// page of a 50,000-row query is one read of the rows version, the rows written since, and the
    /// page's rows. <c>next</c> is a keyset cursor over the query's order.
    /// </summary>
    public async Task<Result<QueryResponseDto>> QueryAsync(Member member, Page database, string level, JsonElement body, CancellationToken ct)
    {
        if (body.ValueKind != JsonValueKind.Object) return Failure.Invalid("The query is an object");
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == database.Id, ct);
        if (record is null) return Failure.NotFound("No such database");
        var schema = SchemaOf(record);
        QueryRequestDto request;
        try
        {
            request = body.Deserialize<QueryRequestDto>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        }
        catch (JsonException)
        {
            return Failure.Invalid("The query does not read");
        }
        var spec = new QuerySpec();
        long viewVersion = 0;
        if (request.ViewId is { } viewId)
        {
            var view = await db.DatabaseViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == viewId && v.DatabaseId == database.Id, ct);
            if (view is null) return Failure.NotFound("No such view");
            spec = QuerySpec.FromView(view.Config);
            viewVersion = view.Version;
        }
        // Explicit parts override the view's: present means given, even as null.
        if (body.TryGetProperty("filter", out var filter))
            spec = new QuerySpec { Filter = QuerySpec.ReadFilter(filter), Sorts = spec.Sorts, Group = spec.Group };
        if (body.TryGetProperty("sorts", out var sorts))
            spec = new QuerySpec { Filter = spec.Filter, Sorts = QuerySpec.ReadSorts(sorts), Group = spec.Group };
        if (body.TryGetProperty("group", out var group))
            spec = new QuerySpec { Filter = spec.Filter, Sorts = spec.Sorts, Group = QuerySpec.ReadGroup(group) };
        spec = new QuerySpec { Filter = spec.Filter, Sorts = spec.Sorts, Group = spec.Group, Search = request.Search };
        var size = Math.Clamp(request.Limit ?? DefaultQuery, 1, MaxQuery);
        var ctx = Context(request.Context, member, clock);

        var snapshot = await cache.RowsAsync(db, record, ct);
        // A query paged through is evaluated once per version of the rows: the next pages read the
        // order kept from the first (a few results kept, the oldest dropped first).
        var asked = (JsonObject)JsonNode.Parse(body.GetRawText())!;
        asked.Remove("after");
        asked.Remove("limit");
        var key = $"{database.Id}|{record.Version}|{snapshot.Version}|{viewVersion}|{member.UserId}|{asked.ToJsonString()}";
        Query.Result result;
        if (Results.TryGetValue(key, out var kept)) result = kept.Result;
        else
        {
            result = Query.Run(schema, snapshot.Rows.Values, spec, ctx, request.GroupKey);
            if (Results.Count >= 64)
                foreach (var old in Results.OrderBy(r => r.Value.At).Take(16).ToList()) Results.TryRemove(old.Key, out _);
            Results[key] = (Environment.TickCount64, result);
        }
        var start = 0;
        if (!string.IsNullOrEmpty(request.After))
        {
            if (Query.After(schema, spec, result.Rows, request.After, ctx) is not { } at) return Failure.Invalid("The cursor is not valid");
            start = at;
        }
        var page = result.Rows.Skip(start).Take(size).ToList();
        var next = start + page.Count < result.Rows.Count && page.Count > 0 ? Query.Cursor(schema, spec, page[^1], ctx) : null;
        var rows = await DtosAsync(page.Select(r => r.Id).ToList(), level, ct);
        return new QueryResponseDto(rows, result.Groups?.Select(g => new GroupCountDto(g.Key, g.Count)).ToList(), result.Rows.Count, next);
    }

    // Export ----------------------------------------------------------------------------------------

    /// <summary>The view's rows in its order as <c>rowsToCsv</c> writes them (no view: every property, no filter).</summary>
    public async Task<Result<(byte[] Bytes, string FileName)>> ExportAsync(Member member, Page database, Guid? viewId, QueryContextDto? given, CancellationToken ct)
    {
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == database.Id, ct);
        if (record is null) return Failure.NotFound("No such database");
        var schema = SchemaOf(record);
        DatabaseView? view = null;
        if (viewId is { } id)
        {
            view = await db.DatabaseViews.AsNoTracking().FirstOrDefaultAsync(v => v.Id == id && v.DatabaseId == database.Id, ct);
            if (view is null) return Failure.NotFound("No such view");
        }
        var spec = view is null ? new QuerySpec() : QuerySpec.FromView(view.Config);
        var ctx = Context(given, member, clock);
        var snapshot = await cache.RowsAsync(db, record, ct);
        var rows = Query.Run(schema, snapshot.Rows.Values, spec, ctx).Rows;
        var config = view is null ? null : JsonNode.Parse(view.Config) as JsonObject;
        var shown = Csv.Shown(schema, config);

        // What the shown cells name by id.
        var people = (await db.WorkspaceMembers.AsNoTracking().Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.DisplayName }).ToListAsync(ct))
            .ToDictionary(u => u.Id.ToString(), u => u.DisplayName);
        var related = new Dictionary<string, string>(StringComparer.Ordinal);
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        var relationIds = shown.Where(d => d.Type == PropertyTypes.Relation)
            .SelectMany(d => rows.SelectMany(r => r.Values.GetValueOrDefault(d.Id) as string[] ?? [])).Distinct().Select(Guid.Parse).ToList();
        foreach (var chunk in Chunked.Of(relationIds))
            foreach (var p in await db.Pages.AsNoTracking().Where(p => chunk.Contains(p.Id) && p.DeletedAt == null).Select(p => new { p.Id, p.Title }).ToListAsync(ct))
                related[p.Id.ToString()] = p.Title;
        var fileIds = shown.Where(d => d.Type == PropertyTypes.Files)
            .SelectMany(d => rows.SelectMany(r => r.Values.GetValueOrDefault(d.Id) as string[] ?? [])).Distinct().Select(Guid.Parse).ToList();
        foreach (var chunk in Chunked.Of(fileIds))
            foreach (var a in await db.Assets.AsNoTracking().Where(a => chunk.Contains(a.Id)).Select(a => new { a.Id, a.FileName }).ToListAsync(ct))
                files[a.Id.ToString()] = a.FileName;
        var bytes = Csv.Write(schema, config, rows, new CsvLookups { People = people, Rows = related, Files = files });
        var name = Documents.SafeNames.Name(database.Title + (view is null ? "" : " - " + view.Name), "Database");
        return (bytes, name + ".csv");
    }

    // Import ----------------------------------------------------------------------------------------

    /// <summary>
    /// Rows from a CSV file into the database: each cell read as the text conversion reads it
    /// (<c>textToValue</c>); the options a select column needs added to its property first, in a
    /// transaction of their own; then the rows in batches, each its own transaction under the
    /// workspace's lock. At most 50,000 rows and 20 MB (413 <c>db.tooLarge</c>).
    /// </summary>
    public async Task<Result<ImportResponseDto>> ImportAsync(Member member, Actor actor, Page database, ImportRequestDto request, CancellationToken ct)
    {
        var text = request.Csv ?? "";
        if (Encoding.UTF8.GetByteCount(text) > Csv.MaxBytes) return new Failure(Codes.DbTooLarge, 413, "A file to import is at most 20 MB");
        var records = Csv.Parse(text);
        if (request.Header && records.Count > 0) records.RemoveAt(0);
        var firstLine = request.Header ? 2 : 1;
        records = records.Where(r => !(r.Length == 1 && r[0].Length == 0)).ToList();
        if (records.Count > Csv.MaxRows) return new Failure(Codes.DbTooLarge, 413, "A file to import holds at most 50,000 rows");
        var columns = request.Columns ?? [];
        if (columns.Count == 0) return Failure.Invalid("Say which property each column fills");
        if (database.TrashedAt is not null) return Failure.Conflict(Codes.Conflict, "The database is in the trash");

        var problems = new List<ImportProblemDto>();
        void Problem(int line, string message)
        {
            if (problems.Count < 1000) problems.Add(new ImportProblemDto(line, message));
        }

        // The options the select columns need, added to their properties first.
        var record = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == database.Id, ct);
        if (record is null) return Failure.NotFound("No such database");
        var schema = Schema.Parse(record.PageId, record.Version, record.Properties);
        for (var c = 0; c < columns.Count; c++)
            if (columns[c] is { } id && id != PropertyDef.TitleId && (schema.Live(id) is not { } def || !PropertyTypes.IsStored(def.Type)))
                return Failure.Invalid($"Column {c + 1} names {id}, which is not a property values are written to");
        var needed = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        for (var c = 0; c < columns.Count; c++)
        {
            if (columns[c] is not { } id || schema.Live(id) is not { } def || !PropertyTypes.HasOptions(def.Type)) continue;
            var list = needed.TryGetValue(id, out var known) ? known : needed[id] = [];
            foreach (var row in records)
            {
                if (c >= row.Length) continue;
                var names = def.Type == PropertyTypes.MultiSelect ? row[c].Split(',') : [row[c]];
                list.AddRange(names.Select(n => n.Trim()).Where(n => n.Length > 0));
            }
        }
        if (needed.Count > 0) schema = await AddOptionsAsync(member, database.Id, needed, ct);

        var created = 0L;
        var strategy = db.Database.CreateExecutionStrategy();
        for (var start = 0; start < records.Count; start += ImportBatch)
        {
            var batch = records.Skip(start).Take(ImportBatch).Select((r, i) => (Row: r, Line: firstLine + start + i)).ToList();
            created += await strategy.ExecuteAsync(async () =>
            {
                db.ChangeTracker.Clear();
                await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
                await changes.LockAsync(member.WorkspaceId, ct);
                var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == database.Id && p.DeletedAt == null, ct);
                var current = await db.Databases.FirstOrDefaultAsync(d => d.PageId == database.Id, ct);
                if (page is null || current is null || page.TrashedAt is not null) return 0;
                schema = Schema.Parse(current.PageId, current.Version, current.Properties);
                var last = await db.Pages.Where(p => p.SectionId == page.SectionId && p.ParentPageId == page.Id && p.DeletedAt == null)
                    .OrderByDescending(p => p.OrderKey).Select(p => p.OrderKey).FirstOrDefaultAsync(ct);
                current.RowsVersion++;
                var seq = current.RowsVersion;
                var now = clock.GetUtcNow();
                var made = new List<RowStore.NewRow>(batch.Count);
                foreach (var (row, line) in batch)
                {
                    if (row.Length > columns.Count) Problem(line, $"{row.Length} fields, {columns.Count} columns: the rest are left out");
                    var values = new Dictionary<string, object>(StringComparer.Ordinal);
                    var title = "";
                    for (var c = 0; c < Math.Min(row.Length, columns.Count); c++)
                    {
                        if (columns[c] is not { } id) continue;
                        if (id == PropertyDef.TitleId)
                        {
                            // The title is text: export's guard taken off, blank is no title.
                            title = schema["title"] is { } titleDef && Csv.TextToValue(titleDef, row[c]) is string t ? t : "";
                            if (title.Length > 1000) title = title[..1000];
                            continue;
                        }
                        var def = schema.Live(id)!;
                        var value = Csv.TextToValue(def, row[c]);
                        if (value is null && DbText.Trim(row[c]).Length > 0 && def.Type != PropertyTypes.Checkbox)
                            Problem(line, $"\"{(row[c].Length > 40 ? row[c][..40] + "…" : row[c])}\" is not a {def.Type} value for {def.Name}: left empty");
                        if (value is not null) values[id] = value;
                    }
                    last = OrderKeys.Between(last, null);
                    var rowId = Guid.CreateVersion7(now);
                    var data = new RowData
                    {
                        Id = rowId,
                        DatabaseId = current.PageId,
                        Title = title,
                        OrderKey = last,
                        CreatedAt = now,
                        UpdatedAt = now,
                        CreatedBy = member.UserId.ToString(),
                        UpdatedBy = member.UserId.ToString(),
                        Values = values,
                    };
                    // Formulas over the row's own cells; nothing an import writes is related yet.
                    var computed = Compute.Row(schema, data, NoRelatedRows.Instance);
                    made.Add(new RowStore.NewRow(rowId, last, title, ValueJson.WriteMap(values),
                        ValueJson.WriteVersions(values.Keys.ToDictionary(k => k, _ => 1L, StringComparer.Ordinal)), ValueJson.WriteMap(computed)));
                }
                // Set-based: the pages, the values and the feed, a statement each.
                await RowStore.InsertAsync(db, member.WorkspaceId, page.SectionId, current.PageId, made, member.UserId, now, current.Version, seq, ct);
                await changes.AddPagesAsync(made.Select(r => r.Id).ToList(), "upsert", member.UserId, ct);
                current.RowCount += made.Count;
                current.UpdatedAt = now;
                changes.Add("database", current.PageId, "upsert", current.Version, member.UserId);
                await db.SaveChangesAsync(ct);
                await changes.FlushAsync(ct);
                await tx.CommitAsync(ct);
                return made.Count;
            });
        }
        return new ImportResponseDto(created, problems);
    }

    /// <summary>The options import needs added to their select properties (by name, as a text conversion makes them), as a <c>db.update</c> would.</summary>
    private async Task<Schema> AddOptionsAsync(Member member, Guid databaseId, Dictionary<string, List<string>> needed, CancellationToken ct)
    {
        var strategy = db.Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await changes.LockAsync(member.WorkspaceId, ct);
            var record = await db.Databases.FirstAsync(d => d.PageId == databaseId, ct);
            var properties = JsonNode.Parse(record.Properties)!.AsArray();
            var changed = false;
            foreach (var node in properties.OfType<JsonObject>())
            {
                var def = PropertyDef.Parse(node);
                if (!needed.TryGetValue(def.Id, out var names)) continue;
                var options = node["options"] as JsonArray ?? [];
                var known = def.Options.Select(o => TextNormaliser.Normalise(o.Name)).ToHashSet(StringComparer.Ordinal);
                foreach (var name in names)
                {
                    var normal = TextNormaliser.Normalise(name);
                    if (normal.Length == 0 || !known.Add(normal) || options.Count >= 1000) continue;
                    var option = new JsonObject { ["id"] = DbIds.New(), ["name"] = name.Length > 200 ? name[..200] : name, ["colour"] = Values.Colours[(options.Count % (Values.Colours.Length - 1)) + 1] };
                    if (def.Type == PropertyTypes.Status) option["group"] = "todo";
                    options.Add(option);
                    changed = true;
                }
                node["options"] = options;
            }
            if (changed)
            {
                record.Properties = properties.ToJsonString();
                record.Version++;
                record.UpdatedAt = clock.GetUtcNow();
                changes.Add("database", record.PageId, "upsert", record.Version, member.UserId);
                await db.SaveChangesAsync(ct);
                await changes.FlushAsync(ct);
            }
            await tx.CommitAsync(ct);
            return Schema.Parse(record.PageId, record.Version, record.Properties);
        });
    }
}
