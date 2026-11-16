using System.Net;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Cgw.Core.Notifications;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Identity;

/// <summary>
/// Phase 8, M8.5: the account's mail choice, and turning mail off from a mail without signing in.
/// <c>GET</c>, <c>PUT /api/v1/account/notification-settings</c> (on, a daily digest, off; on by
/// default); <c>POST /api/v1/mail/unsubscribe</c> with the token from a mail; and the link itself,
/// <c>/mail/unsubscribe?token=</c>: a page whose button turns mail off (nothing changes on a
/// <c>GET</c>, so a mail scanner turns nothing off), and the address of the mail's
/// <c>List-Unsubscribe</c> header, where a mail client posts <c>List-Unsubscribe=One-Click</c>
/// (RFC 8058). Every unsubscribe answers the same for any token.
/// </summary>
public static class MailEndpoints
{
    public static void MapMail(this RouteGroupBuilder api)
    {
        var account = api.MapGroup("/account/notification-settings").WithTags("Account").RequireAuthorization().RequireRateLimiting(RateLimits.User);
        account.MapGet("", async (MailSettingsService settings, HttpContext http) =>
                TypedResults.Ok(await settings.GetAsync(http.User.UserId()!.Value, http.RequestAborted)))
            .WithName("getNotificationSettings");
        account.MapPut("", async Task<Results<Ok<NotificationSettingsDto>, ProblemHttpResult>> (NotificationSettingsDto body, MailSettingsService settings, HttpContext http) =>
            {
                var result = await settings.SetAsync(http.User.UserId()!.Value, body.Email, http.RequestAborted);
                return result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);
            })
            .WithName("updateNotificationSettings");

        api.MapPost("/mail/unsubscribe", async (UnsubscribeRequest body, MailSettingsService settings, HttpContext http) =>
            {
                await settings.UnsubscribeAsync(body.Token, http.RequestAborted);
                return TypedResults.NoContent();
            })
            .WithName("unsubscribeMail").WithTags("Account").AllowAnonymous().RequireRateLimiting(RateLimits.Anonymous);
    }

    private static readonly Dictionary<string, string> En = new()
    {
        ["title"] = "Turn off email notifications",
        ["body"] = "Mail for mentions and replies you have not read will stop. You can turn it on again in the app's Settings.",
        ["button"] = "Turn off",
        ["done"] = "Email notifications are off",
        ["doneBody"] = "Mail for mentions and replies is off for the account this link was sent to. You can turn it on again in the app's Settings.",
    };

    private static readonly Dictionary<string, string> Ar = new()
    {
        ["title"] = "إيقاف إشعارات البريد الإلكتروني",
        ["body"] = "ستتوقف رسائل الإشارات والردود التي لم تقرأها. يمكنك تشغيلها مرة أخرى من إعدادات التطبيق.",
        ["button"] = "إيقاف",
        ["done"] = "إشعارات البريد الإلكتروني متوقفة",
        ["doneBody"] = "أُوقفت رسائل الإشارات والردود للحساب الذي أُرسل إليه هذا الرابط. يمكنك تشغيلها مرة أخرى من إعدادات التطبيق.",
    };

    /// <summary>The pages of the link in a mail, beside the account pages (same frame, styles and policy).</summary>
    public static void MapMailPages(this WebApplication app)
    {
        var pages = app.MapGroup("/mail").ExcludeFromDescription();
        pages.MapGet("/unsubscribe", (HttpContext http, string? token, string? lang) =>
            {
                var language = AccountService.Language(lang, http);
                var t = language == "ar" ? Ar : En;
                var action = $"/mail/unsubscribe?token={Uri.EscapeDataString(token ?? "")}&lang={language}";
                var body = $"""
                    <p>{WebUtility.HtmlEncode(t["body"])}</p>
                    <form method="post" action="{WebUtility.HtmlEncode(action)}"><button type="submit">{WebUtility.HtmlEncode(t["button"])}</button></form>
                    """;
                return AccountPages.Page(http, language, t["title"], body);
            })
            .AllowAnonymous().RequireRateLimiting(RateLimits.Anonymous);
        // The page's button and a mail client's One-Click (its body is List-Unsubscribe=One-Click):
        // the token is the link's; no session, no antiforgery token (the token is the proof, and
        // all it can do is turn mail off).
        pages.MapPost("/unsubscribe", async (HttpContext http, string? token, string? lang, MailSettingsService settings) =>
            {
                await settings.UnsubscribeAsync(token, http.RequestAborted);
                var language = AccountService.Language(lang, http);
                var t = language == "ar" ? Ar : En;
                return AccountPages.Page(http, language, t["done"], $"<p>{WebUtility.HtmlEncode(t["doneBody"])}</p>",
                    [KeyValuePair.Create("token", token ?? "")]);
            })
            .AllowAnonymous().DisableAntiforgery().RequireRateLimiting(RateLimits.Anonymous);
    }
}
