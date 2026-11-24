using System.Security.Cryptography;
using System.Text;
using Cgw.Core.Databases;
using Cgw.Core.Sites;

namespace Cgw.Core.Forms;

/// <summary>A page of a form link to draw: the form, the page, what was posted, and what to say of it.</summary>
public sealed record FormDraw(
    FormLinkState State,
    string Token,
    /// <summary>The page drawn, an index of the form's pages.</summary>
    int Page,
    /// <summary>The fields posted so far (empty on a first visit): the answers drawn and carried.</summary>
    IReadOnlyDictionary<string, string[]> Fields,
    IReadOnlyList<FormProblem> Problems,
    /// <summary>The API refused the answer as sent (<c>?problem=1</c>).</summary>
    bool Refused,
    bool HasPrevious,
    bool IsLast);

/// <summary>
/// A form link's pages as HTML (Phase 16, M16.2): no script, one hashed stylesheet of their own, the
/// form's language and direction; every text and attribute escaped (<see cref="SiteHtml"/>). A page
/// shows its questions, the earlier answers in hidden fields, the trap field and its buttons; it
/// posts to the Sites process, which sends the last page's post on to the API. Drawn by the Sites
/// process; the API answers two fixed pages of it (no form, too many answers).
/// </summary>
public static class FormHtml
{
    public const string Css = """
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#57606a;--line:#8c959f;--soft:#f6f8fa;--accent:#0b57d0;--accent-fg:#ffffff;--error:#b42318;--error-bg:#fee4e2}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#6e7681;--soft:#161b22;--accent:#8ab4f8;--accent-fg:#0d1117;--error:#ff8c82;--error-bg:#451510}}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Arabic",Tahoma,sans-serif}
body{margin:0}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.skip{position:absolute;inset-inline-start:-9999px}
.skip:focus{inset-inline-start:1rem;inset-block-start:1rem;background:var(--accent);color:var(--accent-fg);padding:.5rem 1rem;z-index:1}
main{max-inline-size:40rem;margin:2rem auto;padding:0 1.25rem}
h1{font-size:1.75rem;line-height:1.25;margin:.5rem 0 .75rem}
h2{font-size:1.25rem;margin:1.25rem 0 .25rem}
p{margin:.25rem 0 .75rem}
.note,.help{color:var(--muted);font-size:.9rem}
.help{margin:0 0 .35rem}
.question{margin:0 0 1.25rem;padding:0;border:0;min-inline-size:0}
.question>label,.question>legend{display:block;font-weight:600;margin-block-end:.25rem;padding:0}
.mark{color:var(--error);margin-inline-start:.2rem}
input[type=text],input[type=email],input[type=url],input[type=tel],input[type=date],input[type=datetime-local],select,textarea{display:block;inline-size:100%;min-block-size:2.5rem;padding:.45rem .6rem;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px}
textarea{resize:vertical}
.choice{display:flex;gap:.5rem;align-items:center;min-block-size:2rem}
.choice input,.check input{inline-size:1.15rem;block-size:1.15rem;margin:0}
.check{display:flex;gap:.6rem;align-items:center}
.check>label{margin:0}
[aria-invalid=true]{border-color:var(--error)}
.error{color:var(--error);font-weight:600;margin:0 0 .35rem}
.problems{border:2px solid var(--error);background:var(--error-bg);border-radius:8px;padding:.75rem 1rem;margin:0 0 1.25rem}
.problems ul{margin:.25rem 0 0;padding-inline-start:1.25rem}
.trap{position:absolute;inset-inline-start:-9999px;inline-size:1px;block-size:1px;overflow:hidden}
.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-block:1.5rem}
button{font:inherit;min-block-size:2.5rem;padding:.45rem 1.25rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}
.again{display:inline-block;margin-block-start:1rem}
footer{border-block-start:1px solid var(--line);color:var(--muted);font-size:.85rem;padding:1rem 1.5rem;text-align:center;margin-block-start:3rem}
""";

    /// <summary>The policy source for <see cref="Css"/>: <c>'sha256-…'</c> of its UTF-8 bytes.</summary>
    public static readonly string StyleHash = $"'sha256-{Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(Css)))}'";

    /// <summary>
    /// The forms' policy: their one stylesheet, no image, no script; a form posts only to the Sites
    /// process itself and the API it sends a last page on to (none on a page with no form).
    /// </summary>
    public static string ContentSecurityPolicy(string? apiOrigin) =>
        $"default-src 'none'; style-src {StyleHash}; base-uri 'none'; form-action {(apiOrigin is null ? "'none'" : "'self' " + apiOrigin)}; frame-ancestors 'none'";

    private static SiteHtml Start(string title, FormWords words)
    {
        var h = new SiteHtml();
        h.Raw("<!doctype html>\n<html").Attr("lang", words.Language).Attr("dir", words.Direction).Raw(">\n<head>\n<meta charset=\"utf-8\">\n")
            .Raw("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"referrer\" content=\"no-referrer\">\n")
            .Raw("<meta name=\"robots\" content=\"noindex\">\n<title>").Text(title).Raw("</title>\n<style>").Raw(Css).Raw("</style>\n</head>\n<body>\n");
        return h;
    }

    private static string End(SiteHtml h, FormWords words) =>
        h.Raw("<footer>").Text(words.Footer).Raw("</footer>\n</body>\n</html>\n").ToString();

    private static string TitleOf(FormLinkState state, FormWords words) => state.Title.Length > 0 ? state.Title : words.Untitled;

    private static void Heading(SiteHtml h, FormLinkState state, FormWords words)
    {
        h.Raw("<h1>").Text(TitleOf(state, words)).Raw("</h1>\n");
        if (state.Form.Description is { } description) Paragraphs(h, description, "description");
    }

    /// <summary>Text with its line breaks as paragraphs (a form's words are plain text).</summary>
    private static void Paragraphs(SiteHtml h, string text, string? css = null)
    {
        foreach (var line in text.Replace("\r", "", StringComparison.Ordinal).Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            h.Raw("<p");
            if (css is not null) h.Attr("class", css);
            h.Attr("dir", "auto").Raw(">");
            var parts = line.Split('\n');
            for (var i = 0; i < parts.Length; i++)
            {
                if (i > 0) h.Raw("<br>");
                h.Text(parts[i]);
            }
            h.Raw("</p>\n");
        }
    }

    /// <summary>A page of the form: its questions, the earlier answers carried, its buttons.</summary>
    public static string Page(FormDraw draw)
    {
        var state = draw.State;
        var words = FormWords.For(state.Form.Language);
        var h = Start(TitleOf(state, words), words);
        h.Raw("<a class=\"skip\" href=\"#form\">").Text(words.Skip).Raw("</a>\n<main id=\"main\">\n");
        Heading(h, state, words);
        if (state.Form.Pages.Count == 0 || draw.Page < 0 || draw.Page >= state.Form.Pages.Count)
        {
            h.Raw("<p>").Text(words.NoQuestions).Raw("</p>\n</main>\n");
            return End(h, words);
        }
        var page = state.Form.Pages[draw.Page];
        if (page.Title is { } title) h.Raw("<h2>").Text(title).Raw("</h2>\n");
        if (page.Description is { } description) Paragraphs(h, description);
        if (draw.Refused) h.Raw("<div class=\"problems\" role=\"alert\"><p>").Text(words.Refused).Raw("</p></div>\n");
        var problems = draw.Problems.Where(p => p.PropertyId is not null).GroupBy(p => p.PropertyId!).ToDictionary(g => g.Key, g => g.First().Reason, StringComparer.Ordinal);
        var asked = page.Questions.Where(q => state.Schema.Live(q.PropertyId) is not null).ToList();
        if (draw.Problems.Count > 0)
        {
            h.Raw("<div class=\"problems\" role=\"alert\" tabindex=\"-1\" id=\"problems\"><p>").Text(words.CheckThese).Raw("</p>\n<ul>\n");
            foreach (var problem in draw.Problems)
            {
                if (problem.PropertyId is { } id && asked.FirstOrDefault(q => q.PropertyId == id) is { } question)
                    h.Raw("<li><a").Attr("href", "#" + FieldId(id)).Raw(">").Text(Label(state, question)).Raw("</a>: ").Text(words.Problem(problem.Reason)).Raw("</li>\n");
                else if (problem.PropertyId is null) h.Raw("<li>").Text(words.Problem(problem.Reason)).Raw("</li>\n");
            }
            h.Raw("</ul>\n</div>\n");
        }
        if (asked.Any(q => q.Required)) h.Raw("<p class=\"note\">").Text(words.RequiredNote).Raw("</p>\n");
        h.Raw("<form id=\"form\" method=\"post\"").Attr("action", "/_form/" + draw.Token).Raw(">\n");
        h.Raw("<input type=\"hidden\"").Attr("name", FormPosts.At).Attr("value", draw.Page).Raw(">\n");
        // The answers of the form's other pages, carried to the end as they were posted.
        var here = asked.Select(q => q.PropertyId).ToHashSet(StringComparer.Ordinal);
        foreach (var question in state.Form.Pages.SelectMany(p => p.Questions))
        {
            if (here.Contains(question.PropertyId)) continue;
            foreach (var value in Values(draw.Fields, question.PropertyId))
                h.Raw("<input type=\"hidden\"").Attr("name", FormPosts.Field(question.PropertyId)).Attr("value", value).Raw(">\n");
        }
        h.Raw("<div class=\"trap\" aria-hidden=\"true\"><label for=\"cgw-trap\">").Text(words.Trap)
            .Raw("</label><input type=\"text\" id=\"cgw-trap\"").Attr("name", FormPosts.Trap).Raw(" tabindex=\"-1\" autocomplete=\"off\"></div>\n");
        foreach (var question in asked)
            Question(h, state, question, state.Schema.Live(question.PropertyId)!, Values(draw.Fields, question.PropertyId), problems.GetValueOrDefault(question.PropertyId), words);
        h.Raw("<div class=\"actions\">\n");
        if (draw.HasPrevious)
            h.Raw("<button type=\"submit\" class=\"secondary\"").Attr("name", FormPosts.Go).Attr("value", "back").Raw(" formnovalidate>").Text(words.Back).Raw("</button>\n");
        h.Raw("<button type=\"submit\"").Attr("name", FormPosts.Go).Attr("value", "next").Raw(">")
            .Text(draw.IsLast ? state.Form.Submit ?? words.Submit : words.Next).Raw("</button>\n</div>\n</form>\n</main>\n");
        return End(h, words);
    }

    private static string[] Values(IReadOnlyDictionary<string, string[]> fields, string propertyId) =>
        fields.TryGetValue(FormPosts.Field(propertyId), out var values) ? values.Where(v => v.Length > 0).ToArray() : [];

    private static string FieldId(string propertyId) => "f-" + propertyId;

    private static string Label(FormLinkState state, FormQuestion question) =>
        question.Label ?? state.Schema.Live(question.PropertyId)?.Name ?? "";

    private static void Question(SiteHtml h, FormLinkState state, FormQuestion question, PropertyDef def, string[] values, string? problem, FormWords words)
    {
        var id = FieldId(def.Id);
        var name = FormPosts.Field(def.Id);
        var label = Label(state, question);
        var described = new List<string>();
        if (question.Help is not null) described.Add("h-" + def.Id);
        if (problem is not null) described.Add("e-" + def.Id);
        void Notes()
        {
            if (question.Help is { } help) h.Raw("<p class=\"help\"").Attr("id", "h-" + def.Id).Attr("dir", "auto").Raw(">").Text(help).Raw("</p>\n");
            if (problem is not null) h.Raw("<p class=\"error\"").Attr("id", "e-" + def.Id).Raw(">").Text(words.Problem(problem)).Raw("</p>\n");
        }
        void Common()
        {
            h.Attr("id", id).Attr("name", name);
            if (question.Required) h.Raw(" required");
            if (described.Count > 0) h.Attr("aria-describedby", string.Join(' ', described));
            if (problem is not null) h.Raw(" aria-invalid=\"true\"");
        }
        void Mark()
        {
            if (question.Required) h.Raw("<span class=\"mark\" aria-hidden=\"true\">*</span>");
        }
        var options = PropertyTypes.HasOptions(def.Type)
            ? (question.Options is { } shown ? def.Options.Where(o => shown.Contains(o.Id)) : def.Options).ToList()
            : [];
        switch (def.Type)
        {
            case PropertyTypes.Checkbox:
                h.Raw("<div class=\"question\"").Attr("id", "q-" + def.Id).Raw(">\n");
                Notes();
                h.Raw("<div class=\"check\"><input type=\"checkbox\" value=\"on\"");
                Common();
                if (values.Length > 0) h.Raw(" checked");
                h.Raw("><label").Attr("for", id).Attr("dir", "auto").Raw(">").Text(label);
                Mark();
                h.Raw("</label></div>\n</div>\n");
                return;
            case PropertyTypes.MultiSelect:
                h.Raw("<fieldset class=\"question\"").Attr("id", "q-" + def.Id);
                if (described.Count > 0) h.Attr("aria-describedby", string.Join(' ', described));
                h.Raw(">\n<legend dir=\"auto\">").Text(label);
                Mark();
                h.Raw("</legend>\n");
                Notes();
                // The first box takes the summary's link.
                var first = true;
                foreach (var option in options)
                {
                    h.Raw("<label class=\"choice\"><input type=\"checkbox\"").Attr("name", name).Attr("value", option.Id);
                    if (first) h.Attr("id", id);
                    first = false;
                    if (values.Contains(option.Id, StringComparer.Ordinal)) h.Raw(" checked");
                    h.Raw("><span dir=\"auto\">").Text(option.Name).Raw("</span></label>\n");
                }
                h.Raw("</fieldset>\n");
                return;
        }
        h.Raw("<div class=\"question\"").Attr("id", "q-" + def.Id).Raw(">\n<label").Attr("for", id).Attr("dir", "auto").Raw(">").Text(label);
        Mark();
        h.Raw("</label>\n");
        Notes();
        var value = values.FirstOrDefault() ?? "";
        switch (def.Type)
        {
            case PropertyTypes.Select or PropertyTypes.Status:
                h.Raw("<select");
                Common();
                h.Raw(">\n<option value=\"\">").Text(words.Choose).Raw("</option>\n");
                foreach (var option in options)
                {
                    h.Raw("<option").Attr("value", option.Id);
                    if (option.Id == value) h.Raw(" selected");
                    h.Raw(">").Text(option.Name).Raw("</option>\n");
                }
                h.Raw("</select>\n");
                break;
            case PropertyTypes.Text:
                h.Raw("<textarea rows=\"4\" dir=\"auto\"").Attr("maxlength", FormRules.MaxAnswerText);
                Common();
                h.Raw(">").Text(value).Raw("</textarea>\n");
                break;
            default:
                var (type, extra) = def.Type switch
                {
                    PropertyTypes.Number => ("text", " inputmode=\"decimal\" autocomplete=\"off\""),
                    PropertyTypes.Date => (def.IncludeTime ? "datetime-local" : "date", ""),
                    PropertyTypes.Url => ("url", " autocomplete=\"url\""),
                    PropertyTypes.Email => ("email", " autocomplete=\"email\""),
                    PropertyTypes.Phone => ("tel", " autocomplete=\"tel\""),
                    _ => ("text", " dir=\"auto\""),
                };
                h.Raw("<input").Attr("type", type).Raw(extra);
                if (def.Type is PropertyTypes.Title) h.Attr("maxlength", FormRules.MaxAnswerTitle);
                else if (def.Type is PropertyTypes.Url or PropertyTypes.Email or PropertyTypes.Phone) h.Attr("maxlength", FormRules.MaxAnswerText);
                Common();
                h.Attr("value", value).Raw(">\n");
                break;
        }
        h.Raw("</div>\n");
    }

    /// <summary>The thank-you page: the form's own words, else the app's, and a way to answer again.</summary>
    public static string Done(FormLinkState state, string token)
    {
        var words = FormWords.For(state.Form.Language);
        var h = Start(TitleOf(state, words), words);
        h.Raw("<main id=\"main\">\n<h1>").Text(TitleOf(state, words)).Raw("</h1>\n");
        Paragraphs(h, state.Form.Thanks ?? words.Thanks);
        if (state.State == FormLinkStates.Open) h.Raw("<a class=\"again\"").Attr("href", "/_form/" + token).Raw(">").Text(words.Again).Raw("</a>\n");
        h.Raw("</main>\n");
        return End(h, words);
    }

    /// <summary>A link that takes no answers now: off, closed or full, said so in the form's language.</summary>
    public static string Stopped(FormLinkState state)
    {
        var words = FormWords.For(state.Form.Language);
        var h = Start(TitleOf(state, words), words);
        h.Raw("<main id=\"main\">\n<h1>").Text(TitleOf(state, words)).Raw("</h1>\n<p>")
            .Text(state.State switch { FormLinkStates.Closed => words.Closed, FormLinkStates.Full => words.Full, _ => words.Off })
            .Raw("</p>\n</main>\n");
        return End(h, words);
    }

    /// <summary>No form: the token names no link (or a form or database gone). In both languages.</summary>
    public static string Missing() =>
        Fixed("Form not available · النموذج غير متاح", "This form is not available", "The address may not be right, or the form was removed.",
            "هذا النموذج غير متاح", "ربما العنوان غير صحيح، أو أُزيل النموذج.");

    /// <summary>An address past its answers' limit (the API's 429). In both languages; nothing of the form.</summary>
    public static string TooMany() =>
        Fixed("Too many answers · إجابات كثيرة", "Too many answers", "This address has sent this form many answers in a short time. Wait a while, then try again.",
            "إجابات كثيرة جدًا", "أرسل هذا العنوان إلى هذا النموذج إجابات كثيرة في وقت قصير. انتظر قليلًا، ثم حاول مرة أخرى.");

    private static string Fixed(string title, string heading, string text, string arHeading, string arText)
    {
        var h = new SiteHtml();
        h.Raw("<!doctype html>\n<html lang=\"en\" dir=\"ltr\">\n<head>\n<meta charset=\"utf-8\">\n")
            .Raw("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n<title>")
            .Text(title).Raw("</title>\n<style>").Raw(Css).Raw("</style>\n</head>\n<body>\n<main>\n<h1>").Text(heading).Raw("</h1>\n<p>").Text(text)
            .Raw("</p>\n<div lang=\"ar\" dir=\"rtl\">\n<h2>").Text(arHeading).Raw("</h2>\n<p>").Text(arText).Raw("</p>\n</div>\n</main>\n</body>\n</html>\n");
        return h.ToString();
    }
}
