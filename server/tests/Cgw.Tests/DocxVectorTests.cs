using System.IO.Compression;
using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

namespace Cgw.Tests;

/// <summary>
/// Phase 19, M19.2: the device's Word writer (packages/doc/src/out/docx.ts) held to OOXML. Each of
/// its vectors (packages/doc/vectors/docx-vectors.json, the parts written from the page with every
/// block in English and Arabic and in two layouts) is put in a package as the shell zips it, opened
/// by DocumentFormat.OpenXml and run through its validator, as Microsoft 365 reads a file: no error.
/// </summary>
public sealed class DocxVectorTests(ServerFixture server)
{
    private static byte[] Package(JsonElement file)
    {
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var part in file.GetProperty("parts").EnumerateArray())
            {
                var entry = zip.CreateEntry(part.GetProperty("path").GetString()!, CompressionLevel.Fastest);
                using var write = entry.Open();
                var bytes = part.TryGetProperty("text", out var text)
                    ? Encoding.UTF8.GetBytes(text.GetString()!)
                    : Convert.FromBase64String(part.GetProperty("base64").GetString()!);
                write.Write(bytes);
            }
        }
        return stream.ToArray();
    }

    [Fact]
    public void Every_file_the_writer_writes_passes_the_OOXML_validator()
    {
        using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "doc", "vectors", "docx-vectors.json")));
        var files = vectors.RootElement.GetProperty("files").EnumerateArray().ToList();
        Assert.True(files.Count >= 3);
        var failures = new List<string>();
        foreach (var file in files)
        {
            var name = file.GetProperty("name").GetString();
            using var stream = new MemoryStream(Package(file));
            using var document = WordprocessingDocument.Open(stream, false);
            var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365);
            foreach (var error in validator.Validate(document).Take(20))
                failures.Add($"{name}: {error.Part?.Uri} {error.Path?.XPath}: {error.Description}");
            // What Word itself needs: the body, its section, the styles, numbering, the header and footer.
            var main = document.MainDocumentPart!;
            Assert.NotNull(main.Document?.Body);
            Assert.NotNull(main.StyleDefinitionsPart);
            Assert.NotNull(main.NumberingDefinitionsPart);
            Assert.Single(main.HeaderParts);
            Assert.Single(main.FooterParts);
            Assert.Equal(3, main.ImageParts.Count());
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void The_validator_finds_a_part_written_out_of_the_schemas_order()
    {
        // The control: the same file with one paragraph's direction before its style is refused, so
        // the test above has something to find.
        using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.Root, "packages", "doc", "vectors", "docx-vectors.json")));
        var arabic = vectors.RootElement.GetProperty("files")[1];
        var parts = System.Text.Json.Nodes.JsonNode.Parse(arabic.GetRawText())!;
        var document = parts["parts"]!.AsArray().First(p => p!["path"]!.GetValue<string>() == "word/document.xml")!;
        var xml = document["text"]!.GetValue<string>();
        Assert.Contains("<w:pPr><w:pStyle w:val=\"Title\"/>", xml, StringComparison.Ordinal);
        document["text"] = xml.Replace("<w:pPr><w:pStyle w:val=\"Title\"/><w:bidi/>", "<w:pPr><w:bidi/><w:pStyle w:val=\"Title\"/>", StringComparison.Ordinal);
        using var file = JsonDocument.Parse(parts.ToJsonString());
        using var stream = new MemoryStream(Package(file.RootElement));
        using var opened = WordprocessingDocument.Open(stream, false);
        Assert.NotEmpty(new OpenXmlValidator(FileFormatVersions.Microsoft365).Validate(opened));
    }
}
