using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Cgw.Core.Data;
using Cgw.Ydoc;
using Microsoft.EntityFrameworkCore;

namespace Cgw.Tests;

/// <summary>M2.1: the scaffold's promises.</summary>
public sealed class InfraTests(ServerFixture server)
{
    [Fact]
    public async Task Health_is_reported()
    {
        var client = server.Anonymous();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/live")).StatusCode);
        var ready = await client.GetAsync("/health/ready");
        // Degraded (the worker has not run in this test) still answers 200; unreachable SQL or Blob is 503.
        Assert.Equal(HttpStatusCode.OK, ready.StatusCode);
    }

    [Fact]
    public async Task Errors_are_problems_with_a_code_and_the_correlation_id()
    {
        var client = server.Anonymous();
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/no-such-route");
        request.Headers.Add("X-Correlation-Id", "test-correlation-1");
        var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("test-correlation-1", response.Headers.GetValues("X-Correlation-Id").Single());
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not.found", problem.GetProperty("code").GetString());
        Assert.Equal("test-correlation-1", problem.GetProperty("correlationId").GetString());
    }

    [Fact]
    public async Task A_correlation_id_is_made_when_none_is_sent_or_it_is_unsafe()
    {
        var client = server.Anonymous();
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/version");
        request.Headers.Add("X-Correlation-Id", "bad id with spaces <script>");
        var response = await client.SendAsync(request);
        var id = response.Headers.GetValues("X-Correlation-Id").Single();
        Assert.Matches("^[0-9a-f]{32}$", id);
        var version = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("v1", version.GetProperty("api").GetString());
    }

    [Fact]
    public async Task Api_responses_are_not_cached_and_not_sniffed()
    {
        var response = await server.Anonymous().GetAsync("/api/v1/version");
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
    }

    [Fact]
    public void Every_entity_with_a_workspace_has_the_tenant_filter()
    {
        using var db = server.NewDb();
        var missing = db.Model.GetEntityTypes()
            .Where(t => t.FindProperty("WorkspaceId") is not null)
            .Where(t => !t.GetDeclaredQueryFilters().Any(f => f.Key == CgwDb.Tenant))
            .Select(t => t.ClrType.Name)
            .ToList();
        Assert.Empty(missing);
    }

    [Fact]
    public async Task Tenant_rows_are_invisible_without_a_scope()
    {
        var workspace = Guid.CreateVersion7();
        await using (var db = server.NewDb(workspace))
        {
            db.Sections.Add(new Section { Id = Guid.CreateVersion7(), WorkspaceId = workspace, Name = "S", OrderKey = "a0", CreatedAt = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
        }
        await using (var none = server.NewDb())
            Assert.False(await none.Sections.AnyAsync(s => s.WorkspaceId == workspace));
        await using (var other = server.NewDb(Guid.CreateVersion7()))
            Assert.False(await other.Sections.AnyAsync(s => s.WorkspaceId == workspace));
        await using (var own = server.NewDb(workspace))
            Assert.True(await own.Sections.AnyAsync(s => s.WorkspaceId == workspace));
    }

    [Fact]
    public async Task Ids_are_stored_in_time_order()
    {
        var a = Guid.CreateVersion7();
        await Task.Delay(5);
        var b = Guid.CreateVersion7();
        Assert.True(GuidBytes.ToBytes(a).AsSpan().SequenceCompareTo(GuidBytes.ToBytes(b)) < 0);
        Assert.Equal(a, GuidBytes.FromBytes(GuidBytes.ToBytes(a)));
        await Task.CompletedTask;
    }

    /// <summary>D14: the API process loads no Yjs library.</summary>
    [Fact]
    public void The_api_never_references_the_yjs_library()
    {
        var seen = new HashSet<string>();
        var queue = new Queue<AssemblyName>([typeof(Program).Assembly.GetName()]);
        while (queue.TryDequeue(out var name))
        {
            if (!seen.Add(name.Name!)) continue;
            Assert.NotEqual(Yjs.Assembly.GetName().Name, name.Name);
            Assembly loaded;
            try
            {
                loaded = Assembly.Load(name);
            }
            catch (FileNotFoundException)
            {
                continue;
            }
            foreach (var reference in loaded.GetReferencedAssemblies())
                if (reference.Name!.StartsWith("Cgw.", StringComparison.Ordinal)) queue.Enqueue(reference);
        }
        var output = Path.Combine(server.Root, "server", "src", "Cgw.Api", "bin");
        if (Directory.Exists(output))
            Assert.Empty(Directory.GetFiles(output, "*cgw_ydoc*", SearchOption.AllDirectories)
                .Concat(Directory.GetFiles(output, "Cgw.Ydoc.dll", SearchOption.AllDirectories)));
    }

    [Fact]
    public void The_worker_calls_cgw_ydoc()
    {
        Assert.Matches(@"^\d+\.\d+\.\d+", Yjs.Version());
        // An empty Yjs update is two zero bytes; merging two gives one.
        var merged = Yjs.Merge([[0, 0], [0, 0]]);
        Assert.Equal("doc", System.Text.Json.JsonDocument.Parse(Yjs.ToJson(merged)).RootElement.GetProperty("type").GetString());
        Assert.Throws<YdocException>(() => Yjs.Compact([0xff, 0xff, 0xff]));
    }
}
