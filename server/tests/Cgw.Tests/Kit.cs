using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>Steps the Phase 2 tests share: people in a workspace, documents pushed and derived.</summary>
public static class Kit
{
    private static readonly Lazy<Dictionary<string, Fixture>> Fixtures = new(() =>
        JsonSerializer.Deserialize<List<Fixture>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "updates.json")),
                new JsonSerializerOptions(JsonSerializerDefaults.Web))!
            .ToDictionary(f => f.Name));

    /// <summary>"Hello" (client 1001), and " world" typed after it (client 1002).</summary>
    public static byte[] Update(string name) => Fixtures.Value[name].Bytes;

    public static async Task<Account> Join(ServerFixture server, Ws ws, string role, Account? account = null)
    {
        account ??= await server.NewAccount();
        var added = await ws.Client.PostAsJsonAsync($"/api/v1/workspaces/{ws.Id}/members", new { email = account.Email, role });
        Assert.Equal(HttpStatusCode.OK, added.StatusCode);
        return account;
    }

    public static async Task Register(HttpClient client, Guid workspace, params long[] ids)
    {
        var response = await client.PostAsJsonAsync($"/api/v1/workspaces/{workspace}/yjs-clients", new { register = ids.Length > 0 ? ids : [1001L, 1002L] });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    public static async Task<HttpResponseMessage> Push(HttpClient client, Guid page, byte[] data, int epoch = 0) =>
        await client.PostAsJsonAsync($"/api/v1/pages/{page}/doc/updates", new
        {
            epoch,
            clientSchemaVersion = 1,
            updates = new[] { new { updateId = Guid.CreateVersion7(), data } },
        });

    public static async Task PushOk(HttpClient client, Guid page, byte[] data, int epoch = 0)
    {
        var response = await Push(client, page, data, epoch);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    /// <summary>A page with "Hello world" in it, validated and derived.</summary>
    public static async Task<Guid> PageWithText(ServerFixture server, Ws ws, string title = "Doc", Guid? parent = null, Guid? section = null)
    {
        var page = (await ws.NewPage(title, parent, section: section)).GetProperty("id").GetGuid();
        await Register(ws.Client, ws.Id);
        await PushOk(ws.Client, page, Update("page"));
        await PushOk(ws.Client, page, Update("edit"));
        await server.RunJob<ValidateJob>();
        await Derive(server, ws.Id, page);
        return page;
    }

    public static async Task Derive(ServerFixture server, Guid workspace, Guid page)
    {
        await using var scope = server.Worker.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        db.Scope.Switch(workspace);
        await scope.ServiceProvider.GetServices<IJob>().OfType<DeriveJob>().Single().DeriveAsync(db, page, CancellationToken.None);
    }

    /// <summary>Runs something against a worker scope in one workspace.</summary>
    public static async Task<T> InWorker<T>(ServerFixture server, Guid workspace, Func<IServiceProvider, CgwDb, Task<T>> act)
    {
        await using var scope = server.Worker.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CgwDb>();
        db.Scope.Switch(workspace);
        return await act(scope.ServiceProvider, db);
    }

    public static T Job<T>(ServerFixture server) where T : IJob => server.Worker.GetServices<IJob>().OfType<T>().Single();

    public static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        return text.Length == 0 ? default : JsonDocument.Parse(text).RootElement.Clone();
    }

    public static async Task<string?> Code(HttpResponseMessage response) =>
        (await Json(response)) is { ValueKind: JsonValueKind.Object } body && body.TryGetProperty("code", out var code) ? code.GetString() : null;

    /// <summary>The permissions PUT body.</summary>
    public static object Entries(bool restricted, params (string Type, Guid Id, string Level)[] entries) => new
    {
        restricted,
        entries = entries.Select(e => new { principalType = e.Type, principalId = e.Id, level = e.Level }).ToArray(),
    };

    public static async Task Share(Ws ws, Guid page, bool restricted, params (string Type, Guid Id, string Level)[] entries)
    {
        var response = await ws.Client.PutAsJsonAsync($"/api/v1/pages/{page}/permissions", Entries(restricted, entries));
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    /// <summary>Waits for something that happens in its own time (full-text population).</summary>
    public static async Task<T> Eventually<T>(Func<Task<T>> read, Func<T, bool> done, TimeSpan? within = null)
    {
        var until = DateTime.UtcNow + (within ?? TimeSpan.FromSeconds(60));
        while (true)
        {
            var value = await read();
            if (done(value) || DateTime.UtcNow > until) return value;
            await Task.Delay(250);
        }
    }
}

/// <summary>A clock some way ahead, for jobs that act on age.</summary>
public sealed class ShiftedClock(TimeSpan by) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => base.GetUtcNow() + by;
}
