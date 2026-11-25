namespace Cgw.Core.Databases;

/// <summary>
/// Phase 17, M17.3 and M17.4: a database's tasks (db/dependencies.ts): the relations of a database
/// to itself that are its sub-items' Parent and Sub-items and its dependencies' Blocked by and
/// Blocking, by their defs' <c>relation.role</c>.
/// </summary>
public static class Dependencies
{
    public const string Parent = "parent";
    public const string SubItems = "subItems";
    public const string BlockedByRole = "blockedBy";
    public const string Blocking = "blocking";

    /// <summary>The live relation of the database to itself holding the role, else null (db/dependencies.ts <c>roleDef</c>).</summary>
    public static PropertyDef? Role(Schema schema, string role) =>
        schema.Properties.FirstOrDefault(p => !p.Trashed && p.Type == PropertyTypes.Relation
            && string.Equals(p.RelationDatabase, schema.IdText, StringComparison.OrdinalIgnoreCase)
            && p.Json["relation"]?["role"] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<string>(out var text) && text == role);

    public static PropertyDef? BlockedBy(Schema schema) => Role(schema, BlockedByRole);

    /// <summary>A relation's value as row ids.</summary>
    public static List<Guid> Ids(object? value) =>
        (Raw.List(value) ?? []).OfType<string>().Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList();
}
