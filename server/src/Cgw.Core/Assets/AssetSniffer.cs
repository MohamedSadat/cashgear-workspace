using System.Buffers.Binary;
using System.Text;

namespace Cgw.Core.Assets;

/// <summary>
/// The type a file's first bytes say it is, checked against the type it was uploaded as, and the
/// size of an image (ARCHITECTURE.md, Upload safety: "type checked against the bytes").
/// </summary>
public static class AssetSniffer
{
    public const int HeadBytes = 64 * 1024;

    public static string? Sniff(ReadOnlySpan<byte> b)
    {
        if (b.Length >= 8 && b[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 6 && (b[..6].SequenceEqual("GIF87a"u8) || b[..6].SequenceEqual("GIF89a"u8))) return "image/gif";
        if (b.Length >= 12 && b[..4].SequenceEqual("RIFF"u8) && b[8..12].SequenceEqual("WEBP"u8)) return "image/webp";
        if (b.Length >= 12 && b[..4].SequenceEqual("RIFF"u8) && b[8..12].SequenceEqual("WAVE"u8)) return "audio/wav";
        if (b.Length >= 5 && b[..5].SequenceEqual("%PDF-"u8)) return "application/pdf";
        if (b.Length >= 4 && b[0] == 0x50 && b[1] == 0x4B && b[2] is 0x03 or 0x05 && b[3] is 0x04 or 0x06) return "application/zip";
        if (b.Length >= 12 && b[4..8].SequenceEqual("ftyp"u8)) return "video/mp4";
        if (b.Length >= 4 && b[..4].SequenceEqual(new byte[] { 0x1A, 0x45, 0xDF, 0xA3 })) return "video/webm";
        if (b.Length >= 3 && (b[..3].SequenceEqual("ID3"u8) || (b[0] == 0xFF && (b[1] & 0xE0) == 0xE0))) return "audio/mpeg";
        return Text(b) ? "text/plain" : null;
    }

    /// <summary>Valid UTF-8 with no NUL: a text file (or an SVG, which is XML text).</summary>
    private static bool Text(ReadOnlySpan<byte> b)
    {
        if (b.IndexOf((byte)0) >= 0) return false;
        // A cut in the middle of a character at the end of the head is not an error.
        var cut = b.Length;
        for (var i = 1; i <= 3 && b.Length - i >= 0; i++)
            if ((b[^i] & 0xC0) == 0xC0)
            {
                cut = b.Length - i;
                break;
            }
        try
        {
            new UTF8Encoding(false, true).GetCharCount(b[..cut]);
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    /// <summary>Whether the bytes fit the type the file was uploaded as.</summary>
    public static bool Fits(string declared, ReadOnlySpan<byte> head)
    {
        var sniffed = Sniff(head);
        if (sniffed is null) return false;
        return declared switch
        {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                or "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                or "application/vnd.openxmlformats-officedocument.presentationml.presentation" => sniffed == "application/zip",
            "text/plain" or "text/csv" or "text/markdown" or "application/json" => sniffed == "text/plain",
            "image/svg+xml" => sniffed == "text/plain" && Encoding.UTF8.GetString(head[..Math.Min(head.Length, 4096)]).Contains("<svg", StringComparison.OrdinalIgnoreCase),
            _ => sniffed == declared,
        };
    }

    public static (int? Width, int? Height) Dimensions(string type, ReadOnlySpan<byte> b)
    {
        try
        {
            switch (type)
            {
                case "image/png" when b.Length >= 24:
                    return ((int)BinaryPrimitives.ReadUInt32BigEndian(b[16..]), (int)BinaryPrimitives.ReadUInt32BigEndian(b[20..]));
                case "image/gif" when b.Length >= 10:
                    return (BinaryPrimitives.ReadUInt16LittleEndian(b[6..]), BinaryPrimitives.ReadUInt16LittleEndian(b[8..]));
                case "image/webp" when b.Length >= 30:
                {
                    var chunk = Encoding.ASCII.GetString(b[12..16]);
                    if (chunk == "VP8X") return (1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16));
                    if (chunk == "VP8L") return (1 + ((b[21] | b[22] << 8) & 0x3FFF), 1 + ((b[22] >> 6 | b[23] << 2 | b[24] << 10) & 0x3FFF));
                    if (chunk == "VP8 ") return (BinaryPrimitives.ReadUInt16LittleEndian(b[26..]) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(b[28..]) & 0x3FFF);
                    break;
                }
                case "image/jpeg":
                {
                    var i = 2;
                    while (i + 9 < b.Length)
                    {
                        if (b[i] != 0xFF) return (null, null);
                        var marker = b[i + 1];
                        var length = BinaryPrimitives.ReadUInt16BigEndian(b[(i + 2)..]);
                        if (marker is >= 0xC0 and <= 0xCF and not 0xC4 and not 0xC8 and not 0xCC)
                            return (BinaryPrimitives.ReadUInt16BigEndian(b[(i + 7)..]), BinaryPrimitives.ReadUInt16BigEndian(b[(i + 5)..]));
                        i += 2 + length;
                    }
                    break;
                }
            }
        }
        catch (ArgumentOutOfRangeException)
        {
        }
        return (null, null);
    }
}
