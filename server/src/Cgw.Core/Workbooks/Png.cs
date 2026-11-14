using System.Buffers.Binary;

namespace Cgw.Core.Workbooks;

/// <summary>A workbook's picture (DECISIONS.md, 2026-11-14): PNG only, at most 2 MB and 4,096 px a side.</summary>
public static class Png
{
    public const string ContentType = "image/png";
    public const int MaxBytes = 2 * 1024 * 1024;
    public const int MaxSide = 4096;

    private static ReadOnlySpan<byte> Signature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>
    /// The width and height an image's header gives, when the bytes start with the PNG signature
    /// and then an <c>IHDR</c> chunk of 13 bytes, as every PNG must; null otherwise.
    /// </summary>
    public static (int Width, int Height)? Dimensions(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 33 || !bytes[..8].SequenceEqual(Signature)) return null;
        if (BinaryPrimitives.ReadUInt32BigEndian(bytes[8..12]) != 13 || !bytes[12..16].SequenceEqual("IHDR"u8)) return null;
        var width = BinaryPrimitives.ReadUInt32BigEndian(bytes[16..20]);
        var height = BinaryPrimitives.ReadUInt32BigEndian(bytes[20..24]);
        if (width is 0 or > int.MaxValue || height is 0 or > int.MaxValue) return null;
        return ((int)width, (int)height);
    }
}
