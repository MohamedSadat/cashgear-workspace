using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Cgw.Api.Realtime;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// A hub connection as the app makes one (Phase 6 contracts, section 1): a ticket from the
/// signed-in client, then a WebSocket to <c>/api/v1/realtime?ticket=</c> with no negotiation, against
/// the in-process server. Every event is kept in its own queue for the test to wait on.
/// </summary>
public sealed class HubClient : IAsyncDisposable
{
    public const string Origin = "http://localhost:5273";
    public static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);

    public HubConnection Connection { get; }
    public Channel<JsonElement> Updates { get; } = Channel.CreateUnbounded<JsonElement>();
    public Channel<JsonElement> Awareness { get; } = Channel.CreateUnbounded<JsonElement>();
    public Channel<JsonElement> Changes { get; } = Channel.CreateUnbounded<JsonElement>();
    public Channel<JsonElement> Presence { get; } = Channel.CreateUnbounded<JsonElement>();
    public Channel<JsonElement> Revoked { get; } = Channel.CreateUnbounded<JsonElement>();
    public TaskCompletionSource Closed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private HubClient(HubConnection connection)
    {
        Connection = connection;
        connection.On<JsonElement>(Events.Updates, e => Updates.Writer.TryWrite(e));
        connection.On<JsonElement>(Events.Awareness, e => Awareness.Writer.TryWrite(e));
        connection.On<JsonElement>(Events.ChangesAvailable, e => Changes.Writer.TryWrite(e));
        connection.On<JsonElement>(Events.PagePresence, e => Presence.Writer.TryWrite(e));
        connection.On<JsonElement>(Events.AccessRevoked, e => Revoked.Writer.TryWrite(e));
        connection.Closed += _ =>
        {
            Closed.TrySetResult();
            return Task.CompletedTask;
        };
    }

    public static async Task<string> Ticket(HttpClient client)
    {
        var response = await client.PostAsync("/api/v1/realtime/tickets", null);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString()!;
    }

    public static async Task<HubClient> Connect(WebApplicationFactory<Program> api, HttpClient client, string? origin = Origin)
    {
        var ticket = await Ticket(client);
        var connection = new HubConnectionBuilder()
            .WithUrl($"http://localhost/api/v1/realtime?ticket={ticket}", o =>
            {
                o.SkipNegotiation = true;
                o.Transports = HttpTransportType.WebSockets;
                o.WebSocketFactory = async (context, ct) =>
                {
                    var socket = api.Server.CreateWebSocketClient();
                    socket.ConfigureRequest = r =>
                    {
                        if (origin is not null) r.Headers.Origin = origin;
                    };
                    return await socket.ConnectAsync(context.Uri, ct);
                };
            })
            .Build();
        var hub = new HubClient(connection);
        await connection.StartAsync();
        return hub;
    }

    /// <summary>The raw answer of a method.</summary>
    public async Task<JsonElement> Call(string method, params object?[] args) =>
        await Connection.InvokeCoreAsync<JsonElement>(method, args);

    /// <summary>A method's value, when it answered <c>ok: true</c>.</summary>
    public async Task<JsonElement> Ok(string method, params object?[] args)
    {
        var answer = await Call(method, args);
        Assert.True(answer.GetProperty("ok").GetBoolean(), $"{method}: {answer}");
        return answer.GetProperty("value");
    }

    /// <summary>A refusal's status and code (and that it is a refusal).</summary>
    public async Task<(int Status, string Code, string Title)> Refused(string method, params object?[] args)
    {
        var answer = await Call(method, args);
        Assert.False(answer.GetProperty("ok").GetBoolean(), $"{method} was not refused: {answer}");
        return (answer.GetProperty("status").GetInt32(), answer.GetProperty("code").GetString()!, answer.GetProperty("title").GetString()!);
    }

    public static async Task<JsonElement> Next(Channel<JsonElement> channel, TimeSpan? within = null)
    {
        using var timeout = new CancellationTokenSource(within ?? Wait);
        try
        {
            return await channel.Reader.ReadAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            throw new TimeoutException("No event came in time");
        }
    }

    /// <summary>The next event that passes the test, dropping others.</summary>
    public static async Task<JsonElement> Next(Channel<JsonElement> channel, Func<JsonElement, bool> wanted, TimeSpan? within = null)
    {
        var until = DateTime.UtcNow + (within ?? Wait);
        while (true)
        {
            var left = until - DateTime.UtcNow;
            if (left <= TimeSpan.Zero) throw new TimeoutException("No such event came in time");
            var next = await Next(channel, left);
            if (wanted(next)) return next;
        }
    }

    /// <summary>Nothing (that passes the test) comes for a while.</summary>
    public static async Task None(Channel<JsonElement> channel, TimeSpan during, Func<JsonElement, bool>? wanted = null)
    {
        var until = DateTime.UtcNow + during;
        while (DateTime.UtcNow < until)
        {
            using var timeout = new CancellationTokenSource(until - DateTime.UtcNow);
            try
            {
                var next = await channel.Reader.ReadAsync(timeout.Token);
                if (wanted is null || wanted(next)) Assert.Fail($"Unexpected event: {next}");
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    public static void Drain(Channel<JsonElement> channel)
    {
        while (channel.Reader.TryRead(out _)) { }
    }

    public async ValueTask DisposeAsync() => await Connection.DisposeAsync();
}

public static class RealtimeKit
{
    /// <summary>A WebSocket upgrade by hand: its status, or 101 when it opened (and is closed again).</summary>
    public static async Task<int> Upgrade(WebApplicationFactory<Program> api, string path, string? origin = HubClient.Origin)
    {
        var socket = api.Server.CreateWebSocketClient();
        socket.ConfigureRequest = r =>
        {
            if (origin is not null) r.Headers.Origin = origin;
        };
        try
        {
            using var open = await socket.ConnectAsync(new Uri("ws://localhost" + path), CancellationToken.None);
            await open.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
            return 101;
        }
        catch (InvalidOperationException e) when (System.Text.RegularExpressions.Regex.Match(e.Message, @"status code: (\d+)") is { Success: true } m)
        {
            return int.Parse(m.Groups[1].Value);
        }
    }

    /// <summary>A variant of the API whose relay runs only when a test says (one pass at a time).</summary>
    public static WebApplicationFactory<Program> Manual(ServerFixture server, params (string Key, string Value)[] settings) =>
        server.Variant(b =>
        {
            b.UseSetting("Realtime:RelayMs", "3600000");
            foreach (var (key, value) in settings) b.UseSetting(key, value);
        });

    public static RealtimeRelay Relay(WebApplicationFactory<Program> api) => api.Services.GetRequiredService<RealtimeRelay>();

    /// <summary>A client of a variant, signed in as the account (a device of its own).</summary>
    public static async Task<HttpClient> SignedIn(WebApplicationFactory<Program> api, Account account)
    {
        var client = ServerFixture.ClientOf(api);
        await ServerFixture.SignIn(client, account.Email, account.Password);
        return client;
    }

    public static object Push(int epoch, int clientSchemaVersion, params (Guid Id, byte[] Data)[] updates) => new
    {
        epoch,
        clientSchemaVersion,
        updates = updates.Select(u => new { updateId = u.Id, data = Convert.ToBase64String(u.Data) }).ToArray(),
    };

    public static object Push(params (Guid Id, byte[] Data)[] updates) => Push(0, 1, updates);
}
