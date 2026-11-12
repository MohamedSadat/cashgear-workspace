using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// "Every error code has a test" (IMPLEMENTATION_PLAN.md, Phase 2, Automated tests): the codes no
/// other test reaches, and a guard that fails when a code is added without one.
/// </summary>
public sealed class ErrorCodeTests(ServerFixture server)
{
    private static async Task<JsonElement> Problem(HttpResponseMessage response)
    {
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
    }

    [Fact]
    public void Every_code_clients_use_is_asserted_by_a_test()
    {
        var dir = Path.Combine(server.Root, "server", "tests", "Cgw.Tests");
        var sources = string.Join('\n', Directory.EnumerateFiles(dir, "*.cs")
            .Select(File.ReadAllText));
        var missing = Codes.All.Where(code => !sources.Contains($"\"{code}\"", StringComparison.Ordinal)).ToList();
        Assert.True(missing.Count == 0, $"No test asserts: {string.Join(", ", missing)}");
    }

    [Fact]
    public async Task A_route_that_needs_a_session_answers_auth_required()
    {
        var response = await server.Anonymous().GetAsync("/api/v1/account/me");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("auth.required", (await Problem(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Too_many_requests_answer_limit_rate_with_retry_after()
    {
        await using var api = server.Api.WithWebHostBuilder(b => b.UseSetting("RateLimits:anonymous", "3"));
        var client = api.CreateClient(new() { AllowAutoRedirect = false });
        HttpResponseMessage? refused = null;
        for (var i = 0; i < 10 && refused is null; i++)
        {
            var response = await client.GetAsync("/api/v1/shared");
            if (response.StatusCode == HttpStatusCode.TooManyRequests) refused = response;
        }
        Assert.NotNull(refused);
        Assert.Equal("60", refused.Headers.RetryAfter?.ToString());
        var problem = await Problem(refused);
        Assert.Equal("limit.rate", problem.GetProperty("code").GetString());
        Assert.False(string.IsNullOrEmpty(problem.GetProperty("correlationId").GetString()));
    }

    [Fact]
    public async Task A_parent_in_another_section_answers_tree_section()
    {
        var ws = await Ws.Create(server);
        var parent = await ws.NewPage("In the shared section");
        var id = Guid.CreateVersion7();
        var results = await ws.Push(ws.Op("page.create", id,
            Ws.Page(id, ws.Id, ws.Personal, parent.GetProperty("id").GetGuid(), "a0", "Elsewhere")));
        Assert.Equal("tree.section", results[0].GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task A_request_the_state_forbids_answers_conflict()
    {
        var ws = await Ws.Create(server);
        var page = (await ws.NewPage("Going to the trash")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", page, new { }, 1));
        var response = await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("conflict", (await Problem(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task An_unexpected_failure_answers_server_error_and_says_nothing_of_it()
    {
        await using var api = server.Api.WithWebHostBuilder(b => b.ConfigureTestServices(services =>
            services.AddSingleton<IStartupFilter, ThrowingEndpoint>()));
        var response = await api.CreateClient().GetAsync("/test/boom");
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(ThrowingEndpoint.Secret, text, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidOperationException", text, StringComparison.Ordinal);
        var problem = await Problem(response);
        Assert.Equal("server.error", problem.GetProperty("code").GetString());
        Assert.False(string.IsNullOrEmpty(problem.GetProperty("correlationId").GetString()));
    }

    /// <summary>A path no route has, at the end of the pipeline, that throws.</summary>
    private sealed class ThrowingEndpoint : IStartupFilter
    {
        public const string Secret = "connection string with a password in it";

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            next(app);
            app.Run(context => context.Request.Path == "/test/boom"
                ? throw new InvalidOperationException(Secret)
                : Task.CompletedTask);
        };
    }
}
