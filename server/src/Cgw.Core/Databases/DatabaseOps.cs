using System.Text.Json;
using System.Text.Json.Nodes;
using Cgw.Core.Assets;
using Cgw.Core.Data;
using Cgw.Core.Sync;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core.Databases;

/// <summary>
/// The database rules on the server (contract sections 1, 2 and 4; the client's are
/// packages/workspace/src/db/plan.ts): a database's properties merged per property, every value
/// coerced to its property's type, a type change converting every row, relations kept two-way,
/// the reverse property a relation names added to its target, and formulas and rollups computed.
/// Everything happens in the operation's transaction, under the workspace's lock (OpsService):
/// call <see cref="Reset"/> at the start of each operation and <see cref="FlushAsync"/> before its
/// commit.
/// </summary>
public sealed class DatabaseOps(CgwDb db, Access access, ChangeLog changes, AssetService assets, TimeProvider clock)
{
    public const int MaxProperties = 500;
    public const int MaxPropertiesChars = 1_000_000;
    public const int MaxViewConfigChars = 100_000;
    /// <summary>A change to a formula or rollup recomputes this many rows inline; more wait for the worker.</summary>
    public static int InlineRecompute { get; set; } = 5000;
    /// <summary>Rows relating to a changed row recomputed inline; more mark their database for the worker.</summary>
    public static int InlineRelated { get; set; } = 1000;

    public static readonly HashSet<string> ViewTypes = ["table", "board", "list", "calendar", "gallery"];

    /// <summary>A row this operation changed, as it will be written.</summary>
    private sealed class RowState(Page page, DatabaseRow record)
    {
        public Page Page { get; } = page;
        public DatabaseRow Record { get; } = record;
        public Dictionary<string, object> Values { get; } = ValueJson.ReadMap(record.Values);
        public Dictionary<string, long> Versions { get; } = ValueJson.ReadVersions(record.PropertyVersions);
        public Dictionary<string, object?> Computed { get; set; } = ValueJson.ReadCells(record.Computed);
        /// <summary>Its page's version already rose in this operation (an edit, a create).</summary>
        public bool Bumped { get; set; }
        /// <summary>Written by this operation: stamped and in the feed at the flush.</summary>
        public bool Dirty { get; set; }
        /// <summary>What changed that others' rollups might read (property ids; <c>trashed</c> for its trash).</summary>
        public HashSet<string> Changed { get; } = new(StringComparer.Ordinal);
        public RowData Data() => RowStore.ToData(Page, Record, Values, Computed);
    }

    private readonly Dictionary<Guid, WorkspaceDatabase> databases = [];
    private readonly Dictionary<Guid, Schema> schemas = [];
    private readonly Dictionary<Guid, long> stamped = [];
    private readonly Dictionary<Guid, RowState> rows = [];
    private readonly HashSet<Guid> databaseChanged = [];
    private readonly Dictionary<Guid, List<(WorkspaceDatabase Record, Schema Schema, List<(PropertyDef Rollup, PropertyDef Relation)> Rollups)>> dependents = [];
    private Guid? actor;

    public void Reset()
    {
        databases.Clear();
        schemas.Clear();
        stamped.Clear();
        rows.Clear();
        databaseChanged.Clear();
        dependents.Clear();
        actor = null;
    }

    private DateTimeOffset Now => clock.GetUtcNow();

    // Reading ---------------------------------------------------------------------------------------

    /// <summary>The database record of a database page, tracked; null when it has none.</summary>
    public async Task<WorkspaceDatabase?> DatabaseAsync(Guid id, CancellationToken ct)
    {
        if (databases.TryGetValue(id, out var known)) return known;
        var record = await db.Databases.FirstOrDefaultAsync(d => d.PageId == id, ct);
        if (record is not null) databases[id] = record;
        return record;
    }

    private Schema SchemaOf(WorkspaceDatabase record)
    {
        if (schemas.TryGetValue(record.PageId, out var schema) && schema.Version == record.Version) return schema;
        return schemas[record.PageId] = Schema.Parse(record.PageId, record.Version, record.Properties);
    }

    private void Changed(WorkspaceDatabase record)
    {
        databaseChanged.Add(record.PageId);
        record.UpdatedAt = Now;
    }

    /// <summary>The database's rows version for this operation's writes: raised once.</summary>
    private long Stamp(WorkspaceDatabase record)
    {
        if (stamped.TryGetValue(record.PageId, out var seq)) return seq;
        record.RowsVersion++;
        record.UpdatedAt = Now;
        return stamped[record.PageId] = record.RowsVersion;
    }

    private async Task<RowState?> RowAsync(Guid id, CancellationToken ct)
    {
        if (rows.TryGetValue(id, out var known)) return known;
        var page = await db.Pages.FirstOrDefaultAsync(p => p.Id == id && p.Kind == PageKinds.Row && p.DeletedAt == null, ct);
        if (page is null) return null;
        var record = await db.DatabaseRows.FirstOrDefaultAsync(r => r.PageId == id, ct);
        if (record is null) return null;
        return rows[id] = new RowState(page, record);
    }

    private async Task<List<RowState>> RowsAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var wanted = ids.Distinct().Where(id => !rows.ContainsKey(id)).ToList();
        foreach (var chunk in Chunked.Of(wanted))
        {
            var pages = await db.Pages.Where(p => chunk.Contains(p.Id) && p.Kind == PageKinds.Row && p.DeletedAt == null).ToDictionaryAsync(p => p.Id, ct);
            foreach (var record in await db.DatabaseRows.Where(r => chunk.Contains(r.PageId)).ToListAsync(ct))
                if (pages.TryGetValue(record.PageId, out var page)) rows[record.PageId] = new RowState(page, record);
        }
        return ids.Distinct().Select(id => rows.GetValueOrDefault(id)).OfType<RowState>().ToList();
    }

    // Properties ------------------------------------------------------------------------------------

    private static OpFailure Invalid(string why) => new("invalid", why);

    /// <summary>Throws unless the def is one a database may hold (plan.ts <c>checkDef</c>, and the shapes db/types.ts gives).</summary>
    public static void CheckDef(JsonObject def)
    {
        var parsed = PropertyDef.Parse(def);
        if (!PropertyTypes.All.Contains(parsed.Type)) throw Invalid($"Not a property type: {parsed.Type}");
        if (parsed.Id == PropertyDef.TitleId)
        {
            if (parsed.Type != PropertyTypes.Title) throw Invalid("The title property stays a title");
            if (parsed.Trashed) throw Invalid("The title property cannot be deleted");
        }
        else
        {
            if (!DbIds.IsShortId(parsed.Id)) throw Invalid($"Not a property id: {parsed.Id}");
            if (parsed.Type == PropertyTypes.Title) throw Invalid("A database has one title property");
        }
        if (def["name"] is not JsonValue name || !name.TryGetValue<string>(out var text)) throw Invalid("A property has a name");
        if (text.Length > 200) throw Invalid("A property's name is at most 200 characters");
        if (def["options"] is { } options)
        {
            if (options is not JsonArray list || list.Count > 1000) throw Invalid("Options are a list of at most 1,000");
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in list)
            {
                if (item is not JsonObject o || o["id"] is not JsonValue idValue || !idValue.TryGetValue<string>(out var id) || !DbIds.IsShortId(id) || !ids.Add(id))
                    throw Invalid("Each option has its own id of 8 base-62 characters");
                if (o["name"] is not JsonValue n || !n.TryGetValue<string>(out var optionName) || optionName.Length > 200)
                    throw Invalid("Each option has a name of at most 200 characters");
            }
        }
        if (parsed.Type == PropertyTypes.Relation && parsed.RelationDatabaseId is null) throw Invalid("A relation names its database");
        if (parsed.ReversePropertyId is { } reverse && !DbIds.IsShortId(reverse)) throw Invalid($"Not a property id: {reverse}");
        if (parsed.Type == PropertyTypes.Rollup && (parsed.RollupRelation is null || parsed.RollupTarget is null || !Rollups.Functions.Contains(parsed.RollupFunction ?? "")))
            throw Invalid("A rollup names its relation, its property and its function");
        if (parsed.Type == PropertyTypes.Formula && (parsed.Expression is null || parsed.Expression.Length > 10_000))
            throw Invalid("A formula has an expression of at most 10,000 characters");
    }

    private static JsonArray ReadArray(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array
            ? JsonNode.Parse(value.GetRawText())!.AsArray()
            : [];

    /// <summary>A new database's properties: as given, checked, with the title property first if none is (plan.ts <c>startProperties</c>).</summary>
    public static JsonArray StartProperties(JsonArray given)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in given)
        {
            if (node is not JsonObject def) throw Invalid("A property is an object");
            CheckDef(def);
            if (!seen.Add(PropertyDef.Parse(def).Id)) throw Invalid("A property is given twice");
        }
        var result = new JsonArray();
        if (!seen.Contains(PropertyDef.TitleId)) result.Add(new JsonObject { ["id"] = PropertyDef.TitleId, ["name"] = "Name", ["type"] = PropertyTypes.Title });
        foreach (var node in given) result.Add(node!.DeepClone());
        return result;
    }

    private static void CheckSize(JsonArray properties)
    {
        if (properties.Count > MaxProperties) throw Invalid($"A database holds at most {MaxProperties} properties");
        if (properties.ToJsonString().Length > MaxPropertiesChars) throw Invalid("The properties are too large");
    }

    /// <summary>page.create of kind database: its record, with the reverse properties its relations need.</summary>
    public async Task<WorkspaceDatabase> CreateDatabaseAsync(Member member, Page page, JsonElement payload, CancellationToken ct)
    {
        actor = member.UserId;
        var given = payload.TryGetProperty("database", out var part) && part.ValueKind == JsonValueKind.Object ? ReadArray(part, "properties") : [];
        var properties = StartProperties(given);
        CheckSize(properties);
        var record = new WorkspaceDatabase
        {
            PageId = page.Id,
            WorkspaceId = member.WorkspaceId,
            Properties = properties.ToJsonString(),
            Version = 1,
            CreatedAt = page.CreatedAt,
            UpdatedAt = Now,
        };
        db.Databases.Add(record);
        databases[record.PageId] = record;
        Changed(record);
        var defs = Schema.ParseDefs(properties);
        await CheckRelationsAsync(member, record, defs, ct);
        await ReversePropertiesAsync(member, record, page.Title, defs, ct);
        return record;
    }

    /// <summary>A relation's target must be a database the caller can see.</summary>
    private async Task CheckRelationsAsync(Member member, WorkspaceDatabase source, IEnumerable<PropertyDef> defs, CancellationToken ct)
    {
        foreach (var def in defs)
        {
            if (def.Type != PropertyTypes.Relation || def.RelationDatabaseId is not { } target || target == source.PageId) continue;
            if (await DatabaseAsync(target, ct) is null) throw new OpFailure(Codes.NotFound, "The relation's database is not there");
            var level = await access.PageLevelAsync(member, target);
            if (level == Levels.None) throw new OpFailure(Codes.NotFound, "The relation's database is not there");
        }
    }

    /// <summary>
    /// The reverse properties a database's relations need in their targets (plan.ts
    /// <c>planReverseProperties</c>): a relation naming a <c>reversePropertyId</c> its target lacks
    /// adds it there, pointing back, which needs edit on the target. A self-relation's reverse is a
    /// second property in the same database.
    /// </summary>
    private async Task ReversePropertiesAsync(Member member, WorkspaceDatabase source, string sourceTitle, IEnumerable<PropertyDef> defs, CancellationToken ct)
    {
        foreach (var def in defs)
        {
            if (def.Type != PropertyTypes.Relation || def.ReversePropertyId is not { } reverseId || def.RelationDatabaseId is not { } targetId) continue;
            var self = targetId == source.PageId;
            var target = self ? source : await DatabaseAsync(targetId, ct);
            if (target is null) continue;
            var properties = JsonNode.Parse(target.Properties)!.AsArray();
            if (properties.OfType<JsonObject>().Any(p => PropertyDef.Parse(p).Id == reverseId)) continue;
            if (!self && !Levels.AtLeast(await access.PageLevelAsync(member, target.PageId), Levels.Edit))
                throw new OpFailure(Codes.AccessDenied, "Adding the reverse property needs edit on the related database");
            var reverse = new JsonObject
            {
                ["id"] = reverseId,
                ["name"] = self ? $"{def.Name} (reverse)" : sourceTitle.Length > 0 ? sourceTitle : def.Name,
                ["type"] = PropertyTypes.Relation,
                ["relation"] = new JsonObject { ["databaseId"] = source.PageId.ToString(), ["reversePropertyId"] = def.Id },
            };
            if (((string)reverse["name"]!).Length > 200) reverse["name"] = ((string)reverse["name"]!)[..200];
            CheckDef(reverse);
            properties.Add(reverse);
            CheckSize(properties);
            target.Properties = properties.ToJsonString();
            if (!self) target.Version++;
            Changed(target);
        }
    }

    /// <summary>
    /// db.update (plan.ts <c>planDatabaseUpdate</c>): each def replaces the property with its id or
    /// is added at the end; a type change converts every row's value (and makes the options it
    /// needs); <c>order</c> puts the ids it names first, the rest keeping their places after them.
    /// Deleting a property or an option never rewrites a row.
    /// </summary>
    public async Task<WorkspaceDatabase> UpdateDatabaseAsync(Member member, Page page, JsonElement payload, CancellationToken ct)
    {
        actor = member.UserId;
        var record = await DatabaseAsync(page.Id, ct) ?? throw new OpFailure(Codes.NotFound, "Database not found");
        var properties = JsonNode.Parse(record.Properties)!.AsArray().OfType<JsonObject>().Select(o => (JsonObject)o.DeepClone()).ToList();
        var given = ReadArray(payload, "properties");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var converted = new List<(PropertyDef Before, JsonObject After)>();
        var incoming = new List<JsonObject>();
        foreach (var node in given)
        {
            if (node is not JsonObject def) throw Invalid("A property is an object");
            CheckDef(def);
            var id = PropertyDef.Parse(def).Id;
            if (!seen.Add(id)) throw Invalid($"Property {id} given twice");
            incoming.Add((JsonObject)def.DeepClone());
        }
        var newDefs = new List<PropertyDef>();
        foreach (var def in incoming)
        {
            var parsed = PropertyDef.Parse(def);
            var index = properties.FindIndex(p => PropertyDef.Parse(p).Id == parsed.Id);
            var before = index >= 0 ? PropertyDef.Parse(properties[index]) : null;
            var next = def;
            if (before is not null && before.Type != parsed.Type)
            {
                next = await ConvertRowsAsync(member, record, before, def, ct);
                converted.Add((before, next));
            }
            // A relation that no longer pairs leaves its reverse property one-way.
            if (before is { Type: PropertyTypes.Relation }) await OneWayAsync(record, before, PropertyDef.Parse(next), properties, ct);
            if (index >= 0) properties[index] = next;
            else properties.Add(next);
            newDefs.Add(PropertyDef.Parse(next));
        }
        if (payload.TryGetProperty("order", out var order) && order.ValueKind == JsonValueKind.Array)
        {
            var named = order.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!)
                .Where(id => properties.Any(p => PropertyDef.Parse(p).Id == id)).Distinct(StringComparer.Ordinal).ToList();
            var first = named.Select(id => properties.First(p => PropertyDef.Parse(p).Id == id)).ToList();
            properties = [.. first, .. properties.Where(p => !named.Contains(PropertyDef.Parse(p).Id))];
        }
        var array = new JsonArray(properties.Select(p => (JsonNode)p).ToArray());
        CheckSize(array);
        await CheckRelationsAsync(member, record, newDefs, ct);
        var changedTypes = converted.Count > 0;
        record.Properties = array.ToJsonString();
        record.Version++;
        Changed(record);
        await ReversePropertiesAsync(member, record, page.Title, newDefs, ct);

        // Formulas and rollups read what changed: every row again, inline while there are few.
        var schema = SchemaOf(record);
        if (incoming.Count > 0 && schema.Properties.Any(p => PropertyTypes.IsComputed(p.Type)))
        {
            if (await db.DatabaseRows.CountAsync(r => r.DatabaseId == record.PageId, ct) <= InlineRecompute)
                await RecomputeAllAsync(db, changes, record, schema, member.UserId, Stamp(record), ct);
            else record.ComputePending = true;
        }
        // Rollups elsewhere over this database's properties read their new shape later.
        if (incoming.Count > 0 || changedTypes) await MarkDependentsAsync(record.PageId, ct);
        return record;
    }

    /// <summary>A type change: every row's value converted, in a few statements, and the def with the options the values need.</summary>
    private async Task<JsonObject> ConvertRowsAsync(Member member, WorkspaceDatabase record, PropertyDef before, JsonObject after, CancellationToken ct)
    {
        await FlushRowsAsync(ct);
        // In id order, as the planner converts them: the options a conversion makes are named in
        // the order the values need them.
        var all = (await RowStore.AllAsync(db, record.PageId, ct)).OrderBy(r => r.IdText, StringComparer.Ordinal).ToList();
        // A formula, rollup or created/edited property converts from what its cells read as.
        var values = all.Select(r => PropertyTypes.IsStored(before.Type) ? r.Values.GetValueOrDefault(before.Id) : Cells.Read(before, r)).ToList();
        var (def, next) = Conversion.Property(before, after, values, record.PageId.ToString());
        var writes = new List<RowStore.Write>();
        var touched = new List<Guid>();
        var versionRows = await db.DatabaseRows.AsNoTracking().Where(r => r.DatabaseId == record.PageId)
            .Select(r => new { r.PageId, r.PropertyVersions }).ToDictionaryAsync(r => r.PageId, r => r.PropertyVersions, ct);
        for (var i = 0; i < all.Count; i++)
        {
            var row = all[i];
            var old = row.Values.GetValueOrDefault(before.Id);
            var value = next[i];
            if (ValueJson.Same(old, value)) continue;
            if (value is null) row.Values.Remove(before.Id);
            else row.Values[before.Id] = value;
            var versions = ValueJson.ReadVersions(versionRows.GetValueOrDefault(row.Id) ?? "{}");
            versions[before.Id] = versions.GetValueOrDefault(before.Id) + 1;
            writes.Add(new RowStore.Write(row.Id, Values: ValueJson.WriteMap(row.Values), Versions: ValueJson.WriteVersions(versions)));
            touched.Add(row.Id);
        }
        if (writes.Count > 0)
        {
            var seq = Stamp(record);
            await RowStore.WriteAsync(db, writes, seq, ct);
            await RowStore.BumpPagesAsync(db, touched, member.UserId, Now, ct);
            await changes.AddPagesAsync(touched, "upsert", member.UserId, ct);
        }
        return def;
    }

    /// <summary>
    /// A relation converted to another type (or to another database or reverse) leaves its reverse
    /// property one-way: its <c>reversePropertyId</c> is cleared and its values stay (db/convert.ts
    /// <c>relationTypeChangeEffects</c>).
    /// </summary>
    private async Task OneWayAsync(WorkspaceDatabase source, PropertyDef before, PropertyDef after, List<JsonObject> sourceProperties, CancellationToken ct)
    {
        if (before.RelationDatabaseId is not { } targetId) return;
        var self = targetId == source.PageId;
        var target = self ? source : await DatabaseAsync(targetId, ct);
        if (target is null) return;
        var sourceSchema = new Schema(source.PageId, source.Version, sourceProperties.Select(PropertyDef.Parse).ToList());
        var targetSchema = self ? sourceSchema : SchemaOf(target);
        foreach (var (_, defs) in Relations.TypeChangeEffects(sourceSchema, before, after, targetSchema))
        {
            var properties = self ? sourceProperties : JsonNode.Parse(target.Properties)!.AsArray().OfType<JsonObject>().Select(o => (JsonObject)o.DeepClone()).ToList();
            foreach (var def in defs)
            {
                var index = properties.FindIndex(p => PropertyDef.Parse(p).Id == PropertyDef.Parse(def).Id);
                if (index >= 0) properties[index] = def;
            }
            if (self) continue;
            target.Properties = new JsonArray(properties.Select(p => (JsonNode)p).ToArray()).ToJsonString();
            target.Version++;
            Changed(target);
        }
    }

    /// <summary>Databases with rollups over a relation into this one: their results are made again by the worker.</summary>
    private async Task MarkDependentsAsync(Guid databaseId, CancellationToken ct)
    {
        foreach (var other in await DependentsAsync(databaseId, ct))
        {
            if (other.Record.PageId == databaseId) continue;
            other.Record.ComputePending = true;
        }
    }

    /// <summary>The databases of the workspace whose rollups read a relation into <paramref name="databaseId"/> (itself included).</summary>
    private async Task<List<(WorkspaceDatabase Record, Schema Schema, List<(PropertyDef Rollup, PropertyDef Relation)> Rollups)>> DependentsAsync(Guid databaseId, CancellationToken ct)
    {
        if (dependents.TryGetValue(databaseId, out var known)) return known;
        var text = databaseId.ToString();
        var ids = await db.Databases.AsNoTracking().Where(d => d.PageId == databaseId || d.Properties.Contains(text)).Select(d => d.PageId).ToListAsync(ct);
        var result = new List<(WorkspaceDatabase, Schema, List<(PropertyDef, PropertyDef)>)>();
        foreach (var id in ids)
        {
            var record = await DatabaseAsync(id, ct);
            if (record is null) continue;
            var schema = SchemaOf(record);
            var rollups = schema.Properties
                .Where(p => p is { Type: PropertyTypes.Rollup, Trashed: false } && p.RollupRelation is { } r && schema.Live(r) is { Type: PropertyTypes.Relation } rel && rel.RelationDatabaseId == databaseId)
                .Select(p => (p, schema.Live(p.RollupRelation!)!)).ToList();
            if (rollups.Count > 0) result.Add((record, schema, rollups));
        }
        return dependents[databaseId] = result;
    }

    // Views -----------------------------------------------------------------------------------------

    public async Task<DatabaseView> UpsertViewAsync(Member member, Guid id, JsonElement payload, WorkspaceDatabase database, CancellationToken ct)
    {
        actor = member.UserId;
        string? Str(string name) => payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var name = Str("name") ?? "";
        if (name.Length > 200) throw Invalid("A view's name is at most 200 characters");
        var type = Str("type") ?? "";
        if (!ViewTypes.Contains(type)) throw Invalid($"Not a view type: {type}");
        var orderKey = Str("orderKey");
        if (!OrderKeys.IsValid(orderKey)) throw Invalid("Not an order key");
        var config = payload.TryGetProperty("config", out var c) && c.ValueKind == JsonValueKind.Object ? c.GetRawText() : throw Invalid("A view has its config");
        if (config.Length > MaxViewConfigChars) throw Invalid("The view's config is too large");
        var view = await db.DatabaseViews.FirstOrDefaultAsync(v => v.Id == id, ct);
        if (view is not null && view.DatabaseId != database.PageId) throw Invalid("A view stays with its database");
        var now = Now;
        if (view is null)
        {
            if (await db.DatabaseViews.IgnoreQueryFilters([CgwDb.Tenant]).AnyAsync(v => v.Id == id, ct)) throw Invalid("View exists");
            view = new DatabaseView
            {
                Id = id,
                WorkspaceId = member.WorkspaceId,
                DatabaseId = database.PageId,
                Version = 1,
                CreatedAt = payload.TryGetProperty("createdAt", out var at) && at.TryGetDateTimeOffset(out var created) && created <= now.AddMinutes(5) ? created : now,
            };
            db.DatabaseViews.Add(view);
        }
        else view.Version++;
        view.Name = name;
        view.Type = type;
        view.OrderKey = orderKey!;
        view.Config = config;
        changes.Add("view", view.Id, "upsert", view.Version, member.UserId);
        return view;
    }

    public void DeleteView(Member member, DatabaseView view)
    {
        db.DatabaseViews.Remove(view);
        changes.Add("view", view.Id, "delete", view.Version + 1, member.UserId);
    }

    // Rows ------------------------------------------------------------------------------------------

    /// <summary>Values written to a row, merged per property (plan.ts <c>writeValues</c>): each coerced; null, or what cannot be coerced, clears it.</summary>
    private async Task WriteValuesAsync(Member member, Schema schema, RowState row, JsonElement changesJson, CancellationToken ct)
    {
        if (changesJson.ValueKind != JsonValueKind.Object) return;
        foreach (var p in changesJson.EnumerateObject())
        {
            var def = schema[p.Name] ?? throw Invalid($"No property {p.Name}");
            if (!PropertyTypes.IsStored(def.Type)) throw Invalid($"Property {p.Name} is not written on a row");
            var value = Values.Coerce(def, Raw.From(p.Value));
            var old = row.Values.GetValueOrDefault(def.Id);
            if (value is string[] ids)
                value = def.Type switch
                {
                    PropertyTypes.Relation => await RelatedAsync(member, def, ids, ct),
                    PropertyTypes.Files => await FilesAsync(member, ids, old as string[] ?? [], ct),
                    _ => value,
                };
            if (value is string[] { Length: 0 }) value = null;
            if (value is null) row.Values.Remove(def.Id);
            else row.Values[def.Id] = value;
            // The last write to reach the server wins, and the property's version rises.
            row.Versions[def.Id] = row.Versions.GetValueOrDefault(def.Id) + 1;
            if (!ValueJson.Same(old, value)) row.Changed.Add(def.Id);
        }
        row.Dirty = true;
    }

    /// <summary>A relation holds rows of its database the caller may see; a two-way one needs edit there (the reverse values are written).</summary>
    private async Task<string[]> RelatedAsync(Member member, PropertyDef def, string[] ids, CancellationToken ct)
    {
        if (def.RelationDatabaseId is not { } target) return [];
        var level = await access.PageLevelAsync(member, target);
        if (level == Levels.None) return [];
        if (def.ReversePropertyId is not null && !Levels.AtLeast(level, Levels.Edit))
            throw new OpFailure(Codes.AccessDenied, "Linking rows of that database needs edit on it");
        var guids = ids.Select(Guid.Parse).ToList();
        var known = new HashSet<Guid>();
        foreach (var chunk in Chunked.Of(guids))
            known.UnionWith(await db.DatabaseRows.AsNoTracking().Where(r => r.DatabaseId == target && chunk.Contains(r.PageId))
                .Join(db.Pages.Where(p => p.DeletedAt == null), r => r.PageId, p => p.Id, (r, p) => r.PageId).ToListAsync(ct));
        return guids.Where(known.Contains).Select(g => g.ToString()).ToArray();
    }

    /// <summary>Files added to a row must be files the caller may read: knowing an id is not enough (as for covers).</summary>
    private async Task<string[]> FilesAsync(Member member, string[] ids, string[] before, CancellationToken ct)
    {
        foreach (var id in ids.Except(before))
        {
            var asset = await db.Assets.AsNoTracking().FirstOrDefaultAsync(a => a.Id == Guid.Parse(id), ct);
            if (asset is null || !await assets.CanReadAsync(member, asset, ct))
                throw new OpFailure(Codes.AccessDenied, "A file is one you may not read");
        }
        return ids;
    }

    /// <summary>
    /// Relations kept two-way (plan.ts <c>planRelationEdits</c>, the core's
    /// <c>planRelationChange</c> and <c>applyRelationEdit</c>): each row a relation now names gains
    /// this row in the reverse property, each it no longer names loses it; a reverse value keeps
    /// its first 1,000.
    /// </summary>
    private async Task RelationEditsAsync(Schema schema, RowState row, IReadOnlyDictionary<string, object>? before, CancellationToken ct)
    {
        var edits = Relations.Change(schema, row.Page.Id.ToString(), before, row.Values);
        if (edits.Count == 0) return;
        var targets = await RowsAsync(edits.Select(e => Guid.TryParse(e.RowId, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty), ct);
        foreach (var edit in edits)
        {
            var target = targets.FirstOrDefault(t => t.Page.Id.ToString() == edit.RowId);
            if (target is null || target.Record.DatabaseId.ToString() != edit.DatabaseId) continue;
            var current = target.Values.GetValueOrDefault(edit.PropertyId);
            var value = Relations.Apply(current, edit);
            if (ValueJson.Same(value, current)) continue;
            if (value is null) target.Values.Remove(edit.PropertyId);
            else target.Values[edit.PropertyId] = value;
            target.Versions[edit.PropertyId] = target.Versions.GetValueOrDefault(edit.PropertyId) + 1;
            target.Changed.Add(edit.PropertyId);
            target.Dirty = true;
            // The row's own version rose with its write already (a self-relation).
            if (target != row && !target.Bumped)
            {
                target.Page.Version++;
                target.Page.UpdatedAt = Now;
                if (actor is { } who) target.Page.UpdatedBy = who;
                target.Bumped = true;
            }
        }
    }

    /// <summary>page.create of kind row: its values, its database's count, the reverse values its relations need.</summary>
    public async Task<DatabaseRow> CreateRowAsync(Member member, Page page, WorkspaceDatabase database, JsonElement payload, CancellationToken ct)
    {
        actor = member.UserId;
        var record = new DatabaseRow { PageId = page.Id, WorkspaceId = member.WorkspaceId, DatabaseId = database.PageId };
        db.DatabaseRows.Add(record);
        var row = rows[page.Id] = new RowState(page, record) { Bumped = true, Dirty = true };
        row.Versions.Clear();
        var schema = SchemaOf(database);
        if (payload.TryGetProperty("row", out var part) && part.ValueKind == JsonValueKind.Object && part.TryGetProperty("values", out var values))
            await WriteValuesAsync(member, schema, row, values, ct);
        await RelationEditsAsync(schema, row, null, ct);
        if (page.TrashedAt is null && !page.IsTemplate)
        {
            database.RowCount++;
            Changed(database);
        }
        // A create is a database change too: its rowCount (contract section 4).
        Changed(database);
        row.Changed.Add("trashed");
        return record;
    }

    /// <summary>row.update: values merged per property, the last to reach the server winning.</summary>
    public async Task<DatabaseRow> UpdateRowAsync(Member member, Page page, JsonElement payload, CancellationToken ct)
    {
        actor = member.UserId;
        var row = await RowAsync(page.Id, ct) ?? throw new OpFailure(Codes.NotFound, "Row not found");
        var database = await DatabaseAsync(row.Record.DatabaseId, ct) ?? throw new OpFailure(Codes.NotFound, "Database not found");
        var schema = SchemaOf(database);
        var before = new Dictionary<string, object>(row.Values, StringComparer.Ordinal);
        if (payload.TryGetProperty("values", out var values)) await WriteValuesAsync(member, schema, row, values, ct);
        page.Version++;
        page.UpdatedAt = Now;
        page.UpdatedBy = member.UserId;
        row.Bumped = true;
        row.Dirty = true;
        row.Changed.Add(PropertyTypes.LastEditedTime);
        await RelationEditsAsync(schema, row, before, ct);
        return row.Record;
    }

    /// <summary>
    /// A row's page changed (its title, icon, cover, template flag, order, trash): its version has
    /// risen already; it is stamped, recomputed when its title changed, and its database's count moves.
    /// </summary>
    public async Task TouchRowAsync(Member member, Page page, int countDelta, bool titleChanged, bool trashChanged, CancellationToken ct)
    {
        actor = member.UserId;
        var row = await RowAsync(page.Id, ct) ?? throw new OpFailure(Codes.NotFound, "Row not found");
        row.Bumped = true;
        row.Dirty = true;
        if (titleChanged) row.Changed.Add(PropertyDef.TitleId);
        if (trashChanged) row.Changed.Add("trashed");
        if (countDelta != 0 && await DatabaseAsync(row.Record.DatabaseId, ct) is { } database)
        {
            database.RowCount = Math.Max(0, database.RowCount + countDelta);
            Changed(database);
        }
    }

    // Computing and writing -------------------------------------------------------------------------

    /// <summary>Rollups read rows of other databases: those this operation holds as they now are, the rest from the database.</summary>
    private sealed class Related(DatabaseOps ops) : IRelatedRows
    {
        public Dictionary<Guid, RowData> Loaded { get; } = [];

        public (Schema Schema, IReadOnlyDictionary<string, RowData> Rows)? Rows(string databaseId, IReadOnlyList<string> rowIds)
        {
            if (!Guid.TryParse(databaseId, out var id)) return null;
            // A database that is not there: no rows, and the rollup says its target is unknown.
            var schema = ops.databases.TryGetValue(id, out var record) ? ops.SchemaOf(record) : new Schema(id, 0, []);
            var rows = new Dictionary<string, RowData>(StringComparer.Ordinal);
            foreach (var rowId in rowIds)
            {
                if (!Guid.TryParse(rowId, out var g)) continue;
                if (ops.rows.TryGetValue(g, out var state))
                {
                    if (state.Record.DatabaseId == id) rows[rowId] = state.Data();
                }
                else if (Loaded.TryGetValue(g, out var row) && row.DatabaseId == id) rows[rowId] = row;
            }
            return (schema, rows);
        }
    }

    /// <summary>Loads what the rollups of these rows read: their targets' schemas and related rows.</summary>
    private async Task PrepareAsync(Related related, IEnumerable<RowState> states, CancellationToken ct)
    {
        var wanted = new HashSet<Guid>();
        foreach (var state in states)
        {
            var database = await DatabaseAsync(state.Record.DatabaseId, ct);
            if (database is null) continue;
            var schema = SchemaOf(database);
            foreach (var rollup in schema.Properties.Where(p => p is { Type: PropertyTypes.Rollup, Trashed: false }))
            {
                if (rollup.RollupRelation is not { } r || schema.Live(r) is not { Type: PropertyTypes.Relation, RelationDatabaseId: { } target } relation) continue;
                await DatabaseAsync(target, ct);
                foreach (var id in state.Values.GetValueOrDefault(relation.Id) as string[] ?? [])
                    if (Guid.TryParse(id, out var g) && !rows.ContainsKey(g) && !related.Loaded.ContainsKey(g)) wanted.Add(g);
            }
        }
        foreach (var row in await RowStore.ByIdsAsync(db, wanted, ct)) related.Loaded[row.Id] = row;
    }

    /// <summary>
    /// The rows this operation changed, computed again; then the rows whose rollups read what
    /// changed (through the reverse property), up to <see cref="InlineRelated"/>, else their
    /// database is left to the worker. Then everything written: values, computed, stamps, the feed.
    /// </summary>
    public async Task FlushAsync(CancellationToken ct)
    {
        var related = new Related(this);
        var queue = new Queue<RowState>(rows.Values.Where(r => r.Dirty));
        var seen = new HashSet<Guid>(queue.Select(r => r.Page.Id));
        var extra = 0;
        while (queue.Count > 0)
        {
            var batch = new List<RowState>();
            while (queue.Count > 0) batch.Add(queue.Dequeue());
            await PrepareAsync(related, batch, ct);
            foreach (var state in batch)
            {
                var database = await DatabaseAsync(state.Record.DatabaseId, ct);
                if (database is null) continue;
                var schema = SchemaOf(database);
                var computed = Compute.Row(schema, state.Data(), related);
                if (!Compute.Same(computed, state.Computed) || state.Record.ComputedVersion != database.Version)
                {
                    foreach (var key in computed.Keys.Union(state.Computed.Keys))
                        if (!ValueJson.Same(computed.GetValueOrDefault(key), state.Computed.GetValueOrDefault(key))) state.Changed.Add(key);
                    state.Computed = computed;
                    state.Record.ComputedVersion = database.Version;
                    state.Dirty = true;
                }
                if (state.Changed.Count == 0) continue;
                // Who reads this row through a rollup: the rows its reverse properties name.
                foreach (var (record, otherSchema, rollups) in await DependentsAsync(database.PageId, ct))
                {
                    foreach (var (rollup, relation) in rollups)
                    {
                        if (!state.Changed.Contains(rollup.RollupTarget!) && !state.Changed.Contains("trashed")) continue;
                        if (relation.ReversePropertyId is not { } reverse || schema.Live(reverse) is null)
                        {
                            record.ComputePending = true;
                            continue;
                        }
                        foreach (var id in state.Values.GetValueOrDefault(reverse) as string[] ?? [])
                        {
                            if (!Guid.TryParse(id, out var g) || !seen.Add(g)) continue;
                            if (++extra > InlineRelated)
                            {
                                record.ComputePending = true;
                                continue;
                            }
                            if (await RowAsync(g, ct) is { } dependent && dependent.Record.DatabaseId == record.PageId)
                            {
                                dependent.Dirty = true;
                                queue.Enqueue(dependent);
                            }
                        }
                    }
                }
            }
        }

        foreach (var state in rows.Values.Where(r => r.Dirty))
        {
            var database = await DatabaseAsync(state.Record.DatabaseId, ct);
            state.Record.Values = ValueJson.WriteMap(state.Values);
            state.Record.PropertyVersions = ValueJson.WriteVersions(state.Versions);
            state.Record.Computed = ValueJson.WriteMap(state.Computed);
            if (database is not null) state.Record.Seq = Stamp(database);
            if (!state.Bumped)
            {
                state.Page.Version++;
                state.Bumped = true;
            }
            changes.Add("page", state.Page.Id, "upsert", state.Page.Version, actor);
        }
        foreach (var id in databaseChanged)
            if (databases.TryGetValue(id, out var record))
                changes.Add("database", id, "upsert", record.Version, actor);
        databaseChanged.Clear();
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Saves what is tracked so far, so set-based statements see it.</summary>
    private async Task FlushRowsAsync(CancellationToken ct) => await db.SaveChangesAsync(ct);

    /// <summary>
    /// Every row of a database computed again and the changed ones written in a few statements
    /// (a formula changed; the worker's recompute). Returns how many rows changed.
    /// </summary>
    public static async Task<int> RecomputeAllAsync(CgwDb db, ChangeLog changes, WorkspaceDatabase record, Schema schema, Guid? actor, long seq, CancellationToken ct)
    {
        await db.SaveChangesAsync(ct);
        var all = await RowStore.AllAsync(db, record.PageId, ct);
        var related = await AllRelatedAsync(db, schema, all, record, ct);
        var writes = new List<RowStore.Write>();
        foreach (var row in all)
        {
            var computed = Compute.Row(schema, row, related);
            if (Compute.Same(computed, row.Computed) && row.ComputedVersion == record.Version) continue;
            writes.Add(new RowStore.Write(row.Id, Computed: ValueJson.WriteMap(computed), ComputedVersion: record.Version));
        }
        if (writes.Count == 0) return 0;
        await RowStore.WriteAsync(db, writes, seq, ct);
        var ids = writes.Select(w => w.Id).ToList();
        await RowStore.BumpPagesAsync(db, ids, null, DateTimeOffset.UtcNow, ct);
        await changes.AddPagesAsync(ids, "upsert", actor, ct);
        return writes.Count;
    }

    /// <summary>What a whole database's rollups read: each target database's rows, all of them.</summary>
    private static async Task<IRelatedRows> AllRelatedAsync(CgwDb db, Schema schema, List<RowData> own, WorkspaceDatabase record, CancellationToken ct)
    {
        var targets = schema.Properties.Where(p => p is { Type: PropertyTypes.Rollup, Trashed: false })
            .Select(p => p.RollupRelation is { } r ? schema[r]?.RelationDatabaseId : null).OfType<Guid>().Distinct().ToList();
        var loaded = new Dictionary<Guid, (Schema Schema, Dictionary<string, RowData> Rows)>();
        foreach (var target in targets)
        {
            if (target == record.PageId)
            {
                loaded[target] = (schema, own.ToDictionary(r => r.Id.ToString(), StringComparer.Ordinal));
                continue;
            }
            var other = await db.Databases.AsNoTracking().FirstOrDefaultAsync(d => d.PageId == target, ct);
            if (other is null) continue;
            var rowsOf = await RowStore.AllAsync(db, target, ct);
            loaded[target] = (Schema.Parse(other.PageId, other.Version, other.Properties), rowsOf.ToDictionary(r => r.Id.ToString(), StringComparer.Ordinal));
        }
        return new Loaded(loaded);
    }

    private sealed class Loaded(Dictionary<Guid, (Schema Schema, Dictionary<string, RowData> Rows)> data) : IRelatedRows
    {
        public (Schema Schema, IReadOnlyDictionary<string, RowData> Rows)? Rows(string databaseId, IReadOnlyList<string> rowIds)
        {
            if (!Guid.TryParse(databaseId, out var id)) return null;
            return data.TryGetValue(id, out var d) ? (d.Schema, d.Rows) : (new Schema(id, 0, []), new Dictionary<string, RowData>());
        }
    }

    // Answers ---------------------------------------------------------------------------------------

    public async Task<RowDto?> RowDtoAsync(Member member, Page page, CancellationToken ct)
    {
        var record = rows.TryGetValue(page.Id, out var state) ? state.Record : await db.DatabaseRows.AsNoTracking().FirstOrDefaultAsync(r => r.PageId == page.Id, ct);
        if (record is null) return null;
        var level = await access.PageLevelAsync(member, page.Id);
        return level == Levels.None ? null : RowDto.From(page, record, level);
    }
}
