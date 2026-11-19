using System.Globalization;
using Cgw.Api.Identity;
using Cgw.Api.Infrastructure;
using Cgw.Core;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Cgw.Api.Modules;

/// <summary>
/// Phase 11 (M11.3): a workspace's single sign-on, for its owners alone (<see cref="SsoSettings"/>;
/// admins and members 403), under the membership filter as every <c>/workspaces/{workspaceId}</c>
/// route. The provider's change takes an optional <c>If-Match</c> holding its version, as its
/// <c>ETag</c> gave it. The sign-in itself is the API's pages' (<c>/account/sso</c>).
/// </summary>
public static class SsoEndpoints
{
    private static string Tag(long version) => $"\"{version.ToString(CultureInfo.InvariantCulture)}\"";

    private static Results<Ok<T>, ProblemHttpResult> Answer<T>(Result<T> result) =>
        result.Ok ? TypedResults.Ok(result.Value!) : Problems.From(result.Failure!);

    public static void MapSso(this RouteGroupBuilder api)
    {
        var sso = api.MapGroup("/workspaces/{workspaceId:guid}/sso").WithTags("Single sign-on")
            .RequireAuthorization().AddEndpointFilter<MemberFilter>().RequireRateLimiting(RateLimits.User)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16 * 1024));

        sso.MapGet("", async Task<Results<Ok<SsoSettingsDto>, ProblemHttpResult>> (SsoSettings settings, AccountService accounts, HttpContext http) =>
                Answer(await settings.GetAsync(http.Member(), SsoSignIn.RedirectUri(accounts.PublicUrl(http)), http.RequestAborted)))
            .WithName("getSso").ProducesProblem(403);

        sso.MapPost("/domains", async Task<Results<Created<SsoDomainDto>, ProblemHttpResult>> (NewSsoDomain body, SsoSettings settings, HttpContext http) =>
            {
                var member = http.Member();
                var result = await settings.AddDomainAsync(member, http.Actor(), body, http.RequestAborted);
                return result.Ok
                    ? TypedResults.Created($"/api/v1/workspaces/{member.WorkspaceId}/sso/domains/{result.Value!.Domain}", result.Value)
                    : Problems.From(result.Failure!);
            })
            .WithName("addSsoDomain").ProducesProblem(400).ProducesProblem(403).ProducesProblem(409);

        sso.MapPost("/domains/{domain}/verify", async Task<Results<Ok<SsoDomainDto>, ProblemHttpResult>> (string domain, SsoSettings settings, HttpContext http) =>
                Answer(await settings.VerifyAsync(http.Member(), http.Actor(), domain, http.RequestAborted)))
            .WithName("verifySsoDomain").ProducesProblem(400).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409);

        sso.MapPatch("/domains/{domain}", async Task<Results<Ok<SsoDomainDto>, ProblemHttpResult>> (string domain, SsoDomainUpdate body, SsoSettings settings, HttpContext http) =>
                Answer(await settings.SetRequiredAsync(http.Member(), http.Actor(), domain, body, http.RequestAborted)))
            .WithName("updateSsoDomain").ProducesProblem(400).ProducesProblem(403).ProducesProblem(404);

        sso.MapDelete("/domains/{domain}", async Task<Results<NoContent, ProblemHttpResult>> (string domain, SsoSettings settings, HttpContext http) =>
            {
                var result = await settings.RemoveDomainAsync(http.Member(), http.Actor(), domain, http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("removeSsoDomain").ProducesProblem(403).ProducesProblem(404);

        sso.MapPut("/provider", async Task<Results<Ok<SsoProviderDto>, ProblemHttpResult>> (SsoProviderUpdate body, SsoSettings settings, HttpContext http) =>
            {
                if (!WorkbookEndpoints.TryIfMatchVersion(http, out var ifVersion)) return Problems.Of(Codes.RequestInvalid, 400, "If-Match is the provider's version from its ETag");
                var result = await settings.SetProviderAsync(http.Member(), http.Actor(), body, ifVersion, http.RequestAborted);
                if (!result.Ok) return Problems.From(result.Failure!);
                http.Response.Headers.ETag = Tag(result.Value!.Version);
                return TypedResults.Ok(result.Value);
            })
            .WithName("setSsoProvider").ProducesProblem(400).ProducesProblem(403).ProducesProblem(409);

        sso.MapDelete("/provider", async Task<Results<NoContent, ProblemHttpResult>> (SsoSettings settings, HttpContext http) =>
            {
                var result = await settings.RemoveProviderAsync(http.Member(), http.Actor(), http.RequestAborted);
                return result.Ok ? TypedResults.NoContent() : Problems.From(result.Failure!);
            })
            .WithName("removeSsoProvider").ProducesProblem(403).ProducesProblem(404);
    }
}
