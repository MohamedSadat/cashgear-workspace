using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Cgw.Core.Data;

/// <summary>
/// Ids are UUIDv7 stored as <c>binary(16)</c> in RFC byte order, so time order is index order
/// (D13). SQL Server sorts <c>uniqueidentifier</c> by its last bytes first, which would scatter them.
/// </summary>
public static class GuidBytes
{
    public static byte[] ToBytes(Guid id) => id.ToByteArray(bigEndian: true);

    public static Guid FromBytes(byte[] bytes) => new(bytes, bigEndian: true);
}

public sealed class GuidBytesConverter()
    : ValueConverter<Guid, byte[]>(id => GuidBytes.ToBytes(id), bytes => GuidBytes.FromBytes(bytes));
