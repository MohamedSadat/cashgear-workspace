using Cgw.Core.Data;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Core;

/// <summary>Someone an answer names: their id and their name as shown now.</summary>
public sealed record PersonRef(Guid Id, string Name);

/// <summary>Names for ids, read once per answer: "Deleted user" for an account that is gone.</summary>
public static class People
{
    public const string Deleted = "Deleted user";
    public const string Someone = "Someone";

    public static async Task<Dictionary<Guid, PersonRef>> RefsAsync(CgwDb db, IEnumerable<Guid> ids, CancellationToken ct = default)
    {
        var wanted = ids.Where(id => id != Guid.Empty).Distinct().ToList();
        var result = new Dictionary<Guid, PersonRef>();
        foreach (var chunk in wanted.Chunk(1000).Select(c => c.ToList()))
            foreach (var user in await db.Users.AsNoTracking().Where(u => chunk.Contains(u.Id))
                         .Select(u => new { u.Id, u.DisplayName, u.DeletedAt }).ToListAsync(ct))
                result[user.Id] = new PersonRef(user.Id, user.DeletedAt is not null ? Deleted : user.DisplayName is { Length: > 0 } name ? name : Someone);
        return result;
    }

    public static PersonRef Of(IReadOnlyDictionary<Guid, PersonRef> refs, Guid id) =>
        refs.TryGetValue(id, out var person) ? person : new PersonRef(id, Someone);
}
