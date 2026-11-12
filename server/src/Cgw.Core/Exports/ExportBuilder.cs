using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Core.Databases;
using Cgw.Core.Documents;

namespace Cgw.Core.Exports;

/// <summary>
/// The workspace zip, in the format the app's export writes (<c>packages/shell/src/exchange/exchange.ts</c>,
/// FORMAT_VERSION 2): per page <c>Title.md</c> and <c>Title.json</c> (the ProseMirror JSON) in
/// folders that follow the tree, siblings with the same name numbered; a database's rows in its
/// folder as child pages are, and beside its own files <c>Title.csv</c> (<c>rowsToCsv</c> of every
/// row and every property not deleted, title first, in database order);
/// <c>assets/{id}/{name}</c>; and the manifest <c>cgw-export.json</c> of ids, written last
/// (version 2: <c>kind</c> on every page, a row's <c>databaseId</c> and <c>values</c>, and
/// <c>databases</c> with their properties and views). Pages in the trash are left out, and rows
/// whose database is; the caller passes only what the requester may read.
/// </summary>
public static class ExportBuilder
{
    public const string Format = "cash-gear-workspace-export";
    public const int FormatVersion = 2;
    public const string Manifest = "cgw-export.json";

    public static string Untitled(string? locale) => locale == "ar" ? "بدون عنوان" : "Untitled";

    private static readonly JsonWriterOptions Indented = new()
    {
        Indented = true,
        IndentSize = 1,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>A database the requester may read: its record, its views, and its rows' values by row id.</summary>
    public sealed record Database(WorkspaceDatabase Record, IReadOnlyList<DatabaseView> Views, IReadOnlyDictionary<Guid, DatabaseRow> Rows);

    public sealed record Input(
        Workspace Workspace,
        IReadOnlyList<Section> Sections,
        /// <summary>Every page the requester may read, trashed ones included (their titles name links), rows too.</summary>
        IReadOnlyList<Page> Pages,
        IReadOnlyDictionary<Guid, Asset> Assets,
        Func<Page, Task<string>> Content,
        Func<Asset, Task<byte[]?>> Bytes,
        string Untitled,
        DateTimeOffset Now,
        /// <summary>The databases the requester may read, by page id.</summary>
        IReadOnlyDictionary<Guid, Database>? Databases = null,
        /// <summary>People's names by id, for the CSV files.</summary>
        IReadOnlyDictionary<string, string>? People = null);

    public static async Task WriteAsync(Stream output, Input input, CancellationToken ct = default)
    {
        var sections = input.Sections.OrderBy(s => s.OrderKey, StringComparer.Ordinal).ThenBy(s => Id(s.Id), StringComparer.Ordinal).ToList();
        var sectionNames = sections.ToDictionary(s => s.Id, s => s.Name);
        var all = input.Pages.ToDictionary(p => p.Id);
        var databases = input.Databases ?? new Dictionary<Guid, Database>();
        var live = input.Pages.Where(p => p.TrashedAt is null && p.DeletedAt is null && sectionNames.ContainsKey(p.SectionId)).ToList();
        var liveIds = live.Select(p => p.Id).ToHashSet();
        // A row only with its database, and only with its values.
        live = live.Where(p => p.Kind != PageKinds.Row
            || (p.ParentPageId is { } d && liveIds.Contains(d) && databases.TryGetValue(d, out var holder) && holder.Rows.ContainsKey(p.Id))).ToList();
        liveIds = live.Select(p => p.Id).ToHashSet();
        static IEnumerable<Page> Sorted(IEnumerable<Page> pages) => pages.OrderBy(p => p.OrderKey, StringComparer.Ordinal).ThenBy(p => Id(p.Id), StringComparer.Ordinal);
        var children = live.Where(p => p.ParentPageId is not null).ToLookup(p => p.ParentPageId!.Value);
        var tops = live.Where(p => p.ParentPageId is null).ToLookup(p => p.SectionId);

        // The tree, in drawn order: each section's top pages and everything under them. A page
        // whose parent the requester cannot read starts a tree of its own, after its section's.
        var pages = new List<Page>();
        var seen = new HashSet<Guid>();
        void Walk(Page page)
        {
            if (!seen.Add(page.Id)) return;
            pages.Add(page);
            foreach (var child in Sorted(children[page.Id])) Walk(child);
        }
        foreach (var section in sections)
        {
            foreach (var top in Sorted(tops[section.Id])) Walk(top);
            foreach (var orphan in Sorted(live.Where(p => p.SectionId == section.Id && p.ParentPageId is { } parent && !liveIds.Contains(parent))))
                Walk(orphan);
        }

        // Paths that follow the tree; siblings with the same name get a number.
        var paths = new Dictionary<Guid, string>();
        var taken = new HashSet<string>(StringComparer.Ordinal);
        string Unique(string path)
        {
            var candidate = path;
            for (var n = 2; taken.Contains(candidate.ToLowerInvariant()); n++) candidate = $"{path} ({n})";
            taken.Add(candidate.ToLowerInvariant());
            return candidate;
        }
        foreach (var page in pages)
        {
            var parentFolder = page.ParentPageId is { } parent && paths.TryGetValue(parent, out var parentPath)
                ? string.Join('/', parentPath.Split('/')[..^1])
                : SafeNames.Name(sectionNames.GetValueOrDefault(page.SectionId) ?? "", "Pages");
            var folder = Unique($"{parentFolder}/{SafeNames.Name(page.Title, input.Untitled)}");
            paths[page.Id] = $"{folder}/{folder.Split('/')[^1]}";
        }

        var assets = new Dictionary<Guid, string>();
        var assetOrder = new List<Guid>();
        string? AssetPath(Guid id)
        {
            if (!input.Assets.TryGetValue(id, out var asset)) return null;
            if (!assets.TryGetValue(id, out var file))
            {
                assets[id] = file = $"assets/{id}/{SafeNames.Name(asset.FileName, "file")}";
                assetOrder.Add(id);
            }
            return file;
        }

        using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: Encoding.UTF8);
        var manifestPages = new List<Action<Utf8JsonWriter>>();
        foreach (var page in pages)
        {
            ct.ThrowIfCancellationRequested();
            var @base = paths[page.Id];
            using var content = JsonDocument.Parse(await input.Content(page));
            var context = new TextContext
            {
                PageTitle = id => Guid.TryParse(id, out var g) && all.TryGetValue(g, out var p) ? p.Title : null,
                PageHref = (id, _) => Guid.TryParse(id, out var g) && paths.TryGetValue(g, out var path) ? Relative(@base, $"{path}.md") : null,
                AssetName = id => Guid.TryParse(id, out var g) && input.Assets.TryGetValue(g, out var a) ? a.FileName : null,
                AssetHref = id => Guid.TryParse(id, out var g) && AssetPath(g) is { } path ? Relative(@base, path) : null,
                Untitled = input.Untitled,
            };
            var markdown = Markdown.Write(content.RootElement, context);
            var heading = $"# {(string.IsNullOrEmpty(page.Icon) ? "" : page.Icon + " ")}{(page.Title.Length > 0 ? page.Title : input.Untitled)}\n\n";
            await WriteText(zip, $"{@base}.md", heading + markdown, input.Now, ct);
            await WriteJson(zip, $"{@base}.json", input.Now, w =>
            {
                w.WriteStartObject();
                w.WriteString("id", Id(page.Id));
                w.WriteString("title", page.Title);
                Nullable(w, "icon", page.Icon);
                w.WriteNumber("schemaVersion", page.DocSchemaVersion);
                w.WritePropertyName("content");
                content.RootElement.WriteTo(w);
                w.WriteEndObject();
            }, ct);
            if (page.CoverAssetId is { } cover) AssetPath(cover);
            // A database's rows as CSV, beside its own files.
            if (page.Kind == PageKinds.Database && databases.TryGetValue(page.Id, out var held))
                await WriteText(zip, $"{@base}.csv", DatabaseCsv(held, live, all, input), input.Now, ct);
            DatabaseRow? values = null;
            if (page.Kind == PageKinds.Row && page.ParentPageId is { } rowDatabase && databases.TryGetValue(rowDatabase, out var owner))
                values = owner.Rows.GetValueOrDefault(page.Id);
            var inExport = page.ParentPageId is { } p && paths.ContainsKey(p);
            manifestPages.Add(w =>
            {
                w.WriteStartObject();
                w.WriteString("id", Id(page.Id));
                w.WriteString("kind", page.Kind);
                w.WriteString("sectionId", Id(page.SectionId));
                Nullable(w, "parentPageId", inExport ? Id(page.ParentPageId!.Value) : null);
                if (values is not null)
                {
                    w.WriteString("databaseId", Id(values.DatabaseId));
                    w.WritePropertyName("values");
                    RawJson(w, values.Values, "{}");
                }
                w.WriteString("orderKey", page.OrderKey);
                w.WriteString("title", page.Title);
                Nullable(w, "icon", page.Icon);
                Nullable(w, "coverAssetId", page.CoverAssetId is { } c ? Id(c) : null);
                w.WriteBoolean("isTemplate", page.IsTemplate);
                w.WriteString("markdown", $"{@base}.md");
                w.WriteString("json", $"{@base}.json");
                w.WriteEndObject();
            });
        }

        var manifestAssets = new List<Action<Utf8JsonWriter>>();
        foreach (var id in assetOrder)
        {
            ct.ThrowIfCancellationRequested();
            var asset = input.Assets[id];
            var bytes = await input.Bytes(asset);
            var sha = asset.Sha256;
            if (bytes is not null)
            {
                sha ??= Convert.ToHexStringLower(SHA256.HashData(bytes));
                var entry = zip.CreateEntry(assets[id], CompressionLevel.NoCompression);
                entry.LastWriteTime = input.Now;
                await using var stream = entry.Open();
                await stream.WriteAsync(bytes, ct);
            }
            manifestAssets.Add(w =>
            {
                w.WriteStartObject();
                w.WriteString("id", Id(asset.Id));
                w.WriteString("workspaceId", Id(asset.WorkspaceId));
                w.WriteString("fileName", asset.FileName);
                w.WriteString("contentType", asset.ContentType);
                w.WriteNumber("sizeBytes", asset.SizeBytes);
                w.WriteString("sha256", sha ?? "");
                if (asset.Width is { } width) w.WriteNumber("width", width); else w.WriteNull("width");
                if (asset.Height is { } height) w.WriteNumber("height", height); else w.WriteNull("height");
                w.WriteString("createdAt", Iso(asset.CreatedAt));
                w.WriteString("file", assets[id]);
                w.WriteEndObject();
            });
        }

        await WriteJson(zip, Manifest, input.Now, w =>
        {
            w.WriteStartObject();
            w.WriteString("format", Format);
            w.WriteNumber("version", FormatVersion);
            w.WriteString("exportedAt", Iso(input.Now));
            w.WriteStartObject("workspace");
            w.WriteString("id", Id(input.Workspace.Id));
            w.WriteString("name", input.Workspace.Name);
            Nullable(w, "icon", input.Workspace.Icon);
            w.WriteEndObject();
            w.WriteStartArray("sections");
            foreach (var s in sections)
            {
                w.WriteStartObject();
                w.WriteString("id", Id(s.Id));
                w.WriteString("name", s.Name);
                w.WriteString("orderKey", s.OrderKey);
                w.WriteString("visibility", s.Visibility);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("pages");
            foreach (var write in manifestPages) write(w);
            w.WriteEndArray();
            w.WriteStartArray("databases");
            foreach (var page in pages)
            {
                if (page.Kind != PageKinds.Database || !databases.TryGetValue(page.Id, out var database)) continue;
                w.WriteStartObject();
                w.WriteString("id", Id(page.Id));
                w.WritePropertyName("properties");
                RawJson(w, database.Record.Properties, "[]");
                w.WriteStartArray("views");
                foreach (var view in database.Views.OrderBy(v => v.OrderKey, StringComparer.Ordinal).ThenBy(v => Id(v.Id), StringComparer.Ordinal))
                {
                    w.WriteStartObject();
                    w.WriteString("id", Id(view.Id));
                    w.WriteString("workspaceId", Id(view.WorkspaceId));
                    w.WriteString("databaseId", Id(view.DatabaseId));
                    w.WriteString("name", view.Name);
                    w.WriteString("type", view.Type);
                    w.WriteString("orderKey", view.OrderKey);
                    w.WritePropertyName("config");
                    RawJson(w, view.Config, "{}");
                    w.WriteNumber("version", view.Version);
                    w.WriteString("createdAt", Iso(view.CreatedAt));
                    w.WriteEndObject();
                }
                w.WriteEndArray();
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("assets");
            foreach (var write in manifestAssets) write(w);
            w.WriteEndArray();
            w.WriteEndObject();
        }, ct);
    }

    /// <summary>
    /// A database's rows as the app's export writes them: <c>rowsToCsv</c> with no view (every
    /// property not deleted, title first, in database order), its rows in their order, people,
    /// related rows and files named.
    /// </summary>
    private static string DatabaseCsv(Database database, List<Page> live, Dictionary<Guid, Page> all, Input input)
    {
        var schema = Schema.Parse(database.Record.PageId, database.Record.Version, database.Record.Properties);
        var rows = live.Where(p => p.Kind == PageKinds.Row && p.ParentPageId == database.Record.PageId && database.Rows.ContainsKey(p.Id))
            .OrderBy(p => p.OrderKey, StringComparer.Ordinal).ThenBy(p => Id(p.Id), StringComparer.Ordinal)
            .Select(p => RowStore.ToData(p, database.Rows[p.Id])).ToList();
        var lookups = new CsvLookups
        {
            People = input.People ?? new Dictionary<string, string>(),
            Rows = all.Values.Where(p => p.Kind == PageKinds.Row).ToDictionary(p => Id(p.Id), p => p.Title, StringComparer.Ordinal),
            Files = input.Assets.Values.ToDictionary(a => Id(a.Id), a => a.FileName, StringComparer.Ordinal),
        };
        return Csv.WriteText(schema, null, rows, lookups);
    }

    /// <summary>A JSON column written as JSON (objects and arrays, never a string).</summary>
    private static void RawJson(Utf8JsonWriter w, string? json, string fallback)
    {
        using var document = JsonDocument.Parse(string.IsNullOrEmpty(json) ? fallback : json);
        document.RootElement.WriteTo(w);
    }

    /// <summary>Lower-case hyphenated text, as ids are everywhere outside SQL.</summary>
    private static string Id(Guid id) => id.ToString("D");

    /// <summary>As JavaScript's <c>toISOString</c>.</summary>
    public static string Iso(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static void Nullable(Utf8JsonWriter w, string name, string? value)
    {
        if (value is null) w.WriteNull(name);
        else w.WriteString(name, value);
    }

    /// <summary>A link from one file of the export to another, each segment URI-encoded (the app's <c>relative</c>).</summary>
    public static string Relative(string from, string to)
    {
        var a = from.Split('/')[..^1];
        var b = to.Split('/');
        var common = 0;
        while (common < a.Length && common < b.Length - 1 && a[common] == b[common]) common++;
        return string.Join('/', Enumerable.Repeat("..", a.Length - common).Concat(b[common..]).Select(Js.EncodeUriComponent));
    }

    private static async Task WriteText(ZipArchive zip, string name, string text, DateTimeOffset now, CancellationToken ct)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        entry.LastWriteTime = now;
        await using var stream = entry.Open();
        await stream.WriteAsync(Encoding.UTF8.GetBytes(text), ct);
    }

    private static async Task WriteJson(ZipArchive zip, string name, DateTimeOffset now, Action<Utf8JsonWriter> write, CancellationToken ct)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        entry.LastWriteTime = now;
        await using var stream = entry.Open();
        await using var writer = new Utf8JsonWriter(stream, Indented);
        write(writer);
        await writer.FlushAsync(ct);
    }
}
