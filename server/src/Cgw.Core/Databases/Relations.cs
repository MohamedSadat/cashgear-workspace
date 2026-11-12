namespace Cgw.Core.Databases;

/// <summary>One reverse-side change: on row <c>RowId</c> of <c>DatabaseId</c>, property <c>PropertyId</c>.</summary>
public sealed record RelationEdit(string DatabaseId, string RowId, string PropertyId, List<string> Add, List<string> Remove);

/// <summary>
/// Two-way relations (db/relations.ts): setting row A's relation to add B and remove C adds A to
/// B's reverse value and removes A from C's, in the same transaction.
/// </summary>
public static class Relations
{
    private static List<string> Ids(object? value)
    {
        var output = new List<string>();
        foreach (var item in Raw.List(value) ?? [])
            if (item is string id && id.Length > 0 && !output.Contains(id, StringComparer.Ordinal)) output.Add(id);
        return output;
    }

    /// <summary>
    /// The reverse-side edits a change of one row's values makes (<c>planRelationChange</c>): for
    /// each relation property not deleted that has a reverse property, the ids it lost (in
    /// <paramref name="before"/>'s order) remove the row, the ids it gained (in
    /// <paramref name="after"/>'s order) add it; one edit per target row and property, in the
    /// order first touched; a symmetric self-relation's own row is left out. A null before is a new
    /// row; a null after a removed one.
    /// </summary>
    public static List<RelationEdit> Change(Schema database, string rowId, IReadOnlyDictionary<string, object>? before, IReadOnlyDictionary<string, object>? after)
    {
        var edits = new List<RelationEdit>();
        RelationEdit Edit(string databaseId, string target, string propertyId)
        {
            var found = edits.FirstOrDefault(e => e.DatabaseId == databaseId && e.RowId == target && e.PropertyId == propertyId);
            if (found is null) edits.Add(found = new RelationEdit(databaseId, target, propertyId, [], []));
            return found;
        }
        foreach (var def in database.Properties)
        {
            if (def.Type != PropertyTypes.Relation || def.Trashed || string.IsNullOrEmpty(def.ReversePropertyId) || def.RelationDatabase is null) continue;
            var databaseId = def.RelationDatabase;
            var reverse = def.ReversePropertyId;
            var was = Ids(before?.GetValueOrDefault(def.Id));
            var now = Ids(after?.GetValueOrDefault(def.Id));
            bool Self(string target) => databaseId == database.IdText && target == rowId && reverse == def.Id;
            foreach (var target in was)
                if (!now.Contains(target) && !Self(target))
                {
                    var e = Edit(databaseId, target, reverse);
                    e.Add.RemoveAll(id => id == rowId);
                    if (!e.Remove.Contains(rowId)) e.Remove.Add(rowId);
                }
            foreach (var target in now)
                if (!was.Contains(target) && !Self(target))
                {
                    var e = Edit(databaseId, target, reverse);
                    e.Remove.RemoveAll(id => id == rowId);
                    if (!e.Add.Contains(rowId)) e.Add.Add(rowId);
                }
        }
        return edits;
    }

    /// <summary>
    /// What a change of a relation property's def does to its reverse property
    /// (<c>relationTypeChangeEffects</c>): when <paramref name="before"/> was a relation with a
    /// reverse property and <paramref name="after"/> no longer pairs with it, the reverse property
    /// in <paramref name="target"/> becomes one-way (its <c>reversePropertyId</c> null) and keeps
    /// its values. Only a reverse property that still points back changes; a symmetric
    /// self-relation changes nothing. Returns each database's replacing defs.
    /// </summary>
    public static List<(string DatabaseId, List<System.Text.Json.Nodes.JsonObject> Properties)> TypeChangeEffects(Schema database, PropertyDef before, PropertyDef after, Schema? target)
    {
        if (before.Type != PropertyTypes.Relation || !before.HasRelation || string.IsNullOrEmpty(before.ReversePropertyId)) return [];
        if (target is null || target.IdText != before.RelationDatabase) return [];
        var still = after.Type == PropertyTypes.Relation && after.RelationDatabase == before.RelationDatabase && after.ReversePropertyId == before.ReversePropertyId;
        if (still) return [];
        if (target.IdText == database.IdText && before.ReversePropertyId == before.Id) return [];
        var reverse = target[before.ReversePropertyId];
        if (reverse is null || reverse.Type != PropertyTypes.Relation || reverse.RelationDatabase != database.IdText || reverse.ReversePropertyId != before.Id) return [];
        var copy = (System.Text.Json.Nodes.JsonObject)reverse.Json.DeepClone();
        if (copy["relation"] is System.Text.Json.Nodes.JsonObject relation) relation["reversePropertyId"] = null;
        return [(target.IdText, [copy])];
    }

    /// <summary>A reverse value after an edit (<c>applyRelationEdit</c>): removed taken out, added appended once each, the first 1,000 kept.</summary>
    public static string[]? Apply(object? current, RelationEdit edit)
    {
        var next = Ids(current).Where(id => !edit.Remove.Contains(id)).ToList();
        foreach (var id in edit.Add)
            if (!next.Contains(id)) next.Add(id);
        if (next.Count > Conversion.RelationLimit) next.RemoveRange(Conversion.RelationLimit, next.Count - Conversion.RelationLimit);
        return next.Count > 0 ? next.ToArray() : null;
    }
}
