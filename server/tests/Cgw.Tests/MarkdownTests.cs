using System.Text.Json;
using Cgw.Core.Documents;
using Cgw.Core.Exports;

namespace Cgw.Tests;

/// <summary>M2.8: the export's Markdown is the app's, proven on the vectors its writer made.</summary>
public sealed class MarkdownTests(ServerFixture server)
{
    private static TextContext ContextOf(JsonElement vector)
    {
        if (!vector.TryGetProperty("context", out var context) || context.ValueKind != JsonValueKind.Object) return new TextContext();
        Func<string, string?>? Map(string name) =>
            context.TryGetProperty(name, out var map) && map.ValueKind == JsonValueKind.Object
                ? id => map.TryGetProperty(id, out var value) ? value.GetString() : null
                : null;
        var hrefs = Map("pageHrefs");
        return new TextContext
        {
            PageTitle = Map("pageTitles"),
            // Phase 6: a person's name for a userMention, when the writer is given one.
            UserName = Map("userNames"),
            PageHref = hrefs is null ? null : (id, _) => hrefs(id),
            AssetName = Map("assetNames"),
            AssetHref = Map("assetHrefs"),
            Untitled = context.TryGetProperty("untitled", out var untitled) ? untitled.GetString() : null,
        };
    }

    [Fact]
    public void The_port_writes_what_the_apps_writer_wrote()
    {
        var path = Path.Combine(server.Root, "packages", "doc", "vectors", "markdown-vectors.json");
        using var vectors = JsonDocument.Parse(File.ReadAllText(path));
        var count = 0;
        foreach (var vector in vectors.RootElement.EnumerateArray())
        {
            var name = vector.GetProperty("name").GetString();
            var expected = vector.GetProperty("markdown").GetString();
            var actual = Markdown.Write(vector.GetProperty("doc"), ContextOf(vector));
            Assert.True(expected == actual, $"{name}:\n--- expected\n{expected}\n--- actual\n{actual}");
            count++;
        }
        Assert.True(count >= 10);
    }

    [Fact]
    public void Numbers_from_the_derived_json_read_as_the_app_reads_them()
    {
        // The worker's JSON (yrs) writes integers as 2.0.
        using var doc = JsonDocument.Parse("""
            {"type":"doc","content":[{"type":"block","attrs":{"id":"aaaaaaaaaaaa"},"content":[
              {"type":"textBody","attrs":{"kind":"heading","level":2.0},"content":[{"type":"text","text":"Two"}]}]},
              {"type":"block","attrs":{"id":"bbbbbbbbbbbb"},"content":[
              {"type":"textBody","attrs":{"kind":"callout","icon":3.0},"content":[{"type":"text","text":"Three"}]}]}]}
            """);
        Assert.Equal("## Two\n\n> 3 Three\n", Markdown.Write(doc.RootElement));
    }

    [Fact]
    public void A_table_of_contents_writes_nothing_of_its_own()
    {
        // Schema version 2's node: the app draws the page's headings; the Markdown has them already.
        using var doc = JsonDocument.Parse("""
            {"type":"doc","content":[{"type":"block","attrs":{"id":"aaaaaaaaaaaa"},"content":[{"type":"tableOfContents"}]},
              {"type":"block","attrs":{"id":"bbbbbbbbbbbb"},"content":[
              {"type":"textBody","attrs":{"kind":"heading","level":1},"content":[{"type":"text","text":"Plans"}]}]}]}
            """);
        Assert.Equal("# Plans\n", Markdown.Write(doc.RootElement));
    }

    [Theory]
    [InlineData("Report: Q3/Q4 *draft*", "Report Q3 Q4 draft")]
    [InlineData("  ..hidden..  ", "hidden")]
    [InlineData("", "fallback")]
    [InlineData("تقرير \"الربع\"", "تقرير الربع")]
    public void Safe_names_follow_the_app(string name, string expected) =>
        Assert.Equal(expected, SafeNames.Name(name, "fallback"));

    [Fact]
    public void Links_between_export_files_are_relative_and_encoded()
    {
        Assert.Equal("../Plans%20(2)/Plans%20(2).md", ExportBuilder.Relative("Shared/Report/Report", "Shared/Plans (2)/Plans (2).md"));
        Assert.Equal("../../assets/a1/r%C3%A9sum%C3%A9.pdf", ExportBuilder.Relative("Shared/Report/Report", "assets/a1/résumé.pdf"));
        Assert.Equal("Child/Child.md", ExportBuilder.Relative("Shared/Parent/Parent", "Shared/Parent/Child/Child.md"));
    }
}
