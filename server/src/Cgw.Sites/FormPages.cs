using System.Security.Cryptography;
using System.Text;
using Cgw.Core.Data;
using Cgw.Core.Forms;
using Cgw.Core.Sites;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Primitives;

namespace Cgw.Sites;

/// <summary>
/// Phase 16 (M16.2): a form link's pages on the sites' own host, under <c>/_form/{token}</c> (no slug
/// starts with <c>_</c>). <c>GET</c> draws the form's first page shown (held as a site's page is, by a
/// key of everything it is drawn from); <c>POST</c>, a page's answers: checked by the form rules, then
/// the next page shown (the earlier answers carried in hidden fields), the same page with what is
/// wrong, the page before it (<c>go=back</c>), or, after the last, a 307 that sends the same post on
/// to the API, which writes the row. This process writes nothing. <c>/_form/{token}/done</c> is the
/// thank-you page. A link off, closed or full is a page saying so; an unknown one the 404 page.
/// </summary>
public static class FormPages
{
    /// <summary>The policy an answer of a form page carries instead of the sites' (which posts nothing).</summary>
    public const string PolicyKey = "cgw.formPolicy";

    public static WebApplication MapFormPages(this WebApplication app)
    {
        app.Map("/_form/{token}", (string token, HttpContext http) => FormAsync(token, http));
        app.Map("/_form/{token}/done", (string token, HttpContext http) => DoneAsync(token, http));
        return app;
    }

    private static bool Readable(HttpContext http) => HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method);

    private static IResult NotFound(HttpContext http)
    {
        http.Response.Headers.CacheControl = "no-cache";
        return Results.Content(SiteRenderer.NotFound(), "text/html; charset=utf-8", Encoding.UTF8, 404);
    }

    private static IResult Html(HttpContext http, string html, string cache = "no-store")
    {
        http.Response.Headers.CacheControl = cache;
        return Results.Content(html, "text/html; charset=utf-8", Encoding.UTF8);
    }

    private static async Task<FormLinkState?> StateAsync(string token, HttpContext http)
    {
        var services = http.RequestServices;
        var clock = services.GetRequiredService<TimeProvider>();
        var state = await FormLinkReader.ReadAsync(services.GetRequiredService<CgwDb>(), token, clock.GetUtcNow(), http.RequestAborted);
        if (state is not null) http.Items[PolicyKey] = FormHtml.ContentSecurityPolicy(services.GetRequiredService<SitesOptions>().ApiOrigin);
        return state;
    }

    private static readonly IReadOnlyDictionary<string, string[]> Nothing = new Dictionary<string, string[]>(StringComparer.Ordinal);

    private static async Task<IResult> FormAsync(string token, HttpContext http)
    {
        var post = HttpMethods.IsPost(http.Request.Method);
        if (!post && !Readable(http)) return NotFound(http);
        var state = await StateAsync(token, http);
        if (state is null) return NotFound(http);
        if (state.State != FormLinkStates.Open) return Html(http, FormHtml.Stopped(state), "no-cache");
        var clock = http.RequestServices.GetRequiredService<TimeProvider>();
        var ctx = state.Context(clock.GetUtcNow());
        var form = state.Form;
        var schema = state.Schema;
        if (!post)
        {
            var refused = http.Request.Query["problem"] is { Count: > 0 };
            var first = FormRules.Next(form, schema, Raw(Nothing, state), ctx, -1) ?? 0;
            return Cached(http, state, $"form|{state.Link.Id}|{state.Link.Version}|{state.View.Id}|{state.View.Version}|{state.Record.Version}|{ctx.Today}|{refused}",
                () => FormHtml.Page(new FormDraw(state, token, first, Nothing, [], refused, false, FormRules.Next(form, schema, Raw(Nothing, state), ctx, first) is null)));
        }
        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } size) size.MaxRequestBodySize = FormRules.MaxAnswerBytes;
        if (!http.Request.HasFormContentType) return NotFound(http);
        if (http.Request.ContentLength > FormRules.MaxAnswerBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        Dictionary<string, string[]> fields;
        try
        {
            var posted = await http.Request.ReadFormAsync(http.RequestAborted);
            fields = posted.ToDictionary(p => p.Key, p => p.Value.Select(v => v ?? "").ToArray(), StringComparer.Ordinal);
        }
        catch (Exception e) when (e is InvalidDataException or BadHttpRequestException or IOException)
        {
            return Results.StatusCode(StatusCodes.Status400BadRequest);
        }
        var raw = Raw(fields, state);
        var at = FormPosts.PageOf(fields, form);
        IResult Draw(int page, IReadOnlyList<FormProblem> problems) => Html(http, FormHtml.Page(new FormDraw(state, token, page, fields, problems, false,
            FormRules.Previous(form, schema, raw, ctx, page) is not null, FormRules.Next(form, schema, raw, ctx, page) is null)));
        if (FormPosts.One(fields, FormPosts.Go) == "back")
            return Draw(FormRules.Previous(form, schema, raw, ctx, at) ?? FormRules.Next(form, schema, raw, ctx, -1) ?? 0, []);
        var next = FormRules.Next(form, schema, raw, ctx, at);
        // The last page's check is the whole answer's (nothing in it is refused too).
        var (_, problems) = FormRules.Check(form, schema, raw, ctx, next is null ? int.MaxValue : at);
        if (problems.Count > 0) return Draw(PageOf(form, schema, raw, ctx, problems, at), problems);
        if (next is { } page) return Draw(page, []);
        // After the last page: the same post, sent on to the API, which writes the row.
        var api = http.RequestServices.GetRequiredService<SitesOptions>().ApiOrigin;
        http.Response.Headers.CacheControl = "no-store";
        return Results.Redirect($"{api}/api/v1/forms/{token}", permanent: false, preserveMethod: true);
    }

    /// <summary>The page a refused answer is drawn on: the first shown that asks a question refused, else the one posted.</summary>
    private static int PageOf(FormConfig form, Cgw.Core.Databases.Schema schema, IReadOnlyDictionary<string, object?> raw, Cgw.Core.Databases.QueryContext ctx,
        IReadOnlyList<FormProblem> problems, int at)
    {
        var refused = problems.Select(p => p.PropertyId).OfType<string>().ToHashSet(StringComparer.Ordinal);
        foreach (var index in FormRules.Shown(form, schema, raw, ctx))
            if (form.Pages[index].Questions.Any(q => refused.Contains(q.PropertyId))) return index;
        return at;
    }

    private static IReadOnlyDictionary<string, object?> Raw(IReadOnlyDictionary<string, string[]> fields, FormLinkState state) =>
        FormPosts.Read(state.Form, state.Schema, fields, state.Zone);

    /// <summary>A first page, kept by its key as a site's page is; its entity tag answers a reload with 304.</summary>
    private static IResult Cached(HttpContext http, FormLinkState state, string key, Func<string> draw)
    {
        var cache = http.RequestServices.GetRequiredService<SiteCache>();
        var rendered = cache.Page(key);
        if (rendered is null)
        {
            var body = Encoding.UTF8.GetBytes(draw());
            var tag = "\"" + Convert.ToBase64String(SHA256.HashData(body))[..27].Replace('+', '-').Replace('/', '_') + "\"";
            rendered = new RenderedPage(body, tag);
            cache.PutPage(key, rendered);
        }
        var headers = http.Response.Headers;
        headers.CacheControl = "no-cache";
        headers.ETag = rendered.ETag;
        if (Matches(http.Request.Headers.IfNoneMatch, rendered.ETag)) return Results.StatusCode(304);
        return Results.Bytes(rendered.Body, "text/html; charset=utf-8");
    }

    private static bool Matches(StringValues ifNoneMatch, string tag) =>
        ifNoneMatch.SelectMany(v => (v ?? "").Split(',')).Select(v => v.Trim()).Any(v => v == tag || v == "*");

    private static async Task<IResult> DoneAsync(string token, HttpContext http)
    {
        if (!Readable(http)) return NotFound(http);
        var state = await StateAsync(token, http);
        return state is null ? NotFound(http) : Html(http, FormHtml.Done(state, token), "no-cache");
    }
}
