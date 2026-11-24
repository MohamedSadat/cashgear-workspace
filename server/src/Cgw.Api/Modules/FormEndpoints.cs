using System.Globalization;
using System.Text;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Forms;
using Cgw.Core.Sites;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Phase 16: forms. A form view's state and its link for members (its readers read them; full
/// access makes, changes and deletes the link), and a link's answer: <c>POST /api/v1/forms/{token}</c>,
/// a plain HTML form's post (the Sites process sends the last page's here), with no session (a
/// cookie sent with it is never read) and no antiforgery token, answered by a redirect to the
/// form's pages on the Sites process, or 429 with a page of its own that holds nothing of the form.
/// </summary>
public static class FormEndpoints
{
    private static IResult Answer<T>(Result<T> result) => result.Ok ? TypedResults.Ok(result.Value) : Problems.From(result.Failure!);

    public static void MapForms(this RouteGroupBuilder api)
    {
        var form = api.MapGroup("/databases/{databaseId:guid}/views/{viewId:guid}/form").WithTags("Forms").RequireAuthorization()
            .AddEndpointFilter<DatabaseFilter>().RequireRateLimiting(RateLimits.User);

        form.MapGet("", async Task<Results<Ok<FormStateDto>, ProblemHttpResult>> (Guid viewId, FormService forms, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await forms.StateAsync(access.Page, access.Level, viewId, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("getFormState");

        form.MapPost("/link", async Task<Results<Ok<FormLinkDto>, ProblemHttpResult>> (Guid viewId, FormLinkRequest body, FormService forms, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await forms.CreateLinkAsync(access.Member, http.Actor(), access.Page, access.Level, viewId, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("createFormLink")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        form.MapPut("/link", async Task<Results<Ok<FormLinkDto>, ProblemHttpResult>> (Guid viewId, FormLinkRequest body, FormService forms, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await forms.UpdateLinkAsync(access.Member, http.Actor(), access.Page, access.Level, viewId, body, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updateFormLink")
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4 * 1024));

        form.MapDelete("/link", async Task<Results<NoContent, ProblemHttpResult>> (Guid viewId, FormService forms, HttpContext http) =>
            {
                var access = http.DatabaseAccess();
                var result = await forms.DeleteLinkAsync(access.Member, http.Actor(), access.Page, access.Level, viewId, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("deleteFormLink");

        // A link's answer. The address's own windows first (the link's minute and day), then the
        // anonymous window every address has; nothing is read of a session or of who is signed in.
        api.MapPost("/forms/{token}", async (string token, HttpContext http, FormAnswers answers, FormLimits limits, SitesOptions sites) =>
            {
                if (FormKeys.Hash(token) is not { } hash) return Missing();
                var (taken, wait) = limits.Take(http.Connection.RemoteIpAddress, Convert.ToHexString(hash));
                if (!taken) return TooMany(http, wait);
                if (!http.Request.HasFormContentType) return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);
                // The route's own limit too: the request size limit is the server's (IIS, Kestrel), not every host's.
                if (http.Request.ContentLength > FormRules.MaxAnswerBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                IFormCollection posted;
                try
                {
                    posted = await http.Request.ReadFormAsync(http.RequestAborted);
                }
                catch (Exception e) when (e is InvalidDataException or BadHttpRequestException or IOException)
                {
                    return Results.StatusCode(StatusCodes.Status400BadRequest);
                }
                var fields = posted.ToDictionary(p => p.Key, p => p.Value.Select(v => v ?? "").ToArray(), StringComparer.Ordinal);
                var actor = new Actor(null, http.Connection.RemoteIpAddress?.ToString(), http.TraceIdentifier);
                var answer = await answers.AnswerAsync(token, fields, actor, http.RequestAborted);
                var page = $"{sites.PublicUrl}/_form/{token}";
                return answer.Outcome switch
                {
                    AnswerOutcome.Added or AnswerOutcome.Dropped => SeeOther(page + "/done"),
                    AnswerOutcome.Refused => SeeOther(page + "?problem=1"),
                    _ => SeeOther(page),
                };
            })
            .AllowAnonymous().DisableAntiforgery().RequireRateLimiting(RateLimits.Anonymous).ExcludeFromDescription()
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(FormRules.MaxAnswerBytes));
    }

    /// <summary>303: the browser asks for the page with GET.</summary>
    private static IResult SeeOther(string url) => new SeeOtherResult(url);

    private sealed class SeeOtherResult(string url) : IResult
    {
        public Task ExecuteAsync(HttpContext http)
        {
            http.Response.StatusCode = StatusCodes.Status303SeeOther;
            http.Response.Headers.Location = url;
            return Task.CompletedTask;
        }
    }

    private static IResult Missing() => Page(StatusCodes.Status404NotFound, FormHtml.Missing());

    private static IResult TooMany(HttpContext http, TimeSpan wait)
    {
        http.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(wait.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
        return Page(StatusCodes.Status429TooManyRequests, FormHtml.TooMany());
    }

    /// <summary>A page in both languages that holds nothing of any form, under the forms' own policy.</summary>
    private static IResult Page(int status, string html) => new PageResult(status, html);

    private sealed class PageResult(int status, string html) : IResult
    {
        public async Task ExecuteAsync(HttpContext http)
        {
            http.Response.StatusCode = status;
            http.Response.ContentType = "text/html; charset=utf-8";
            http.Response.Headers.ContentSecurityPolicy = FormHtml.ContentSecurityPolicy(null);
            http.Response.Headers.CacheControl = "no-store";
            await http.Response.WriteAsync(html, Encoding.UTF8, http.RequestAborted);
        }
    }
}
