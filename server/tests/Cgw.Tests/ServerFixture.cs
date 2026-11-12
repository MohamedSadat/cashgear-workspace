using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Worker;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

[assembly: AssemblyFixture(typeof(Cgw.Tests.ServerFixture))]
[assembly: CaptureConsole]

namespace Cgw.Tests;

/// <summary>
/// One scratch database and one Azurite for the whole run. SQL Server is LocalDB unless
/// CGW_TEST_SQL names a server (CI: a container with full-text search). Tests stay apart by
/// working in workspaces of their own, which is what tenancy is for.
/// </summary>
public sealed class ServerFixture : IAsyncLifetime
{
    public string Root { get; } = FindRoot();
    public string Database { get; } = $"cgw_test_{DateTime.UtcNow:yyyyMMddHHmmss}_{Random.Shared.Next(1000, 9999)}";
    public string ServerConnection { get; } =
        Environment.GetEnvironmentVariable("CGW_TEST_SQL") is { Length: > 0 } sql
            ? sql
            : "Server=(localdb)\\MSSQLLocalDB;Integrated Security=true;TrustServerCertificate=true";
    public string SqlConnection => new SqlConnectionStringBuilder(ServerConnection) { InitialCatalog = Database }.ConnectionString;
    public int BlobPort { get; } = FreePort();
    public string BlobConnection =>
        $"DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey={AzuriteKey};BlobEndpoint=http://127.0.0.1:{BlobPort}/devstoreaccount1;";
    /// <summary>Azurite's published development key, not a secret.</summary>
    public const string AzuriteKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
    public string MailDir { get; } = Path.Combine(Path.GetTempPath(), "cgw-mail-" + Guid.NewGuid().ToString("N"));

    private Process? azurite;
    public WebApplicationFactory<Program> Api { get; private set; } = null!;
    public IServiceProvider Worker { get; private set; } = null!;

    public Dictionary<string, string?> Settings => new()
    {
        ["ConnectionStrings:Sql"] = SqlConnection,
        ["Blob:ConnectionString"] = BlobConnection,
        ["Blob:Container"] = "workspace",
        ["Smtp:PickupDirectory"] = MailDir,
        ["Web:Origins:0"] = "http://localhost:5273",
        ["Web:Origins:1"] = "http://tauri.localhost",
        ["Web:AppUrl"] = "http://localhost:5273",
        ["Api:PublicUrl"] = "https://localhost",
        // Tests mail one address several times a minute; the cooldown has a test of its own.
        ["Mail:CooldownSeconds"] = "0",
        ["RateLimits:signin"] = "100000",
        ["RateLimits:token"] = "100000",
        ["RateLimits:user"] = "100000",
        ["RateLimits:push"] = "100000",
        ["RateLimits:search"] = "100000",
        ["RateLimits:anonymous"] = "100000",
        ["RateLimits:preview"] = "100000",
    };

    public async ValueTask InitializeAsync()
    {
        azurite = Process.Start(new ProcessStartInfo("node",
        [
            Path.Combine(Root, "node_modules", "azurite", "dist", "src", "blob", "main.js"),
            "--blobHost", "127.0.0.1", "--blobPort", BlobPort.ToString(), "--inMemoryPersistence",
            "--silent", "--skipApiVersionCheck", "--loose", "--disableTelemetry",
        ])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        }) ?? throw new InvalidOperationException("Azurite did not start.");
        await WaitForPort(BlobPort);

        await using (var server = new SqlConnection(ServerConnection))
        {
            await server.OpenAsync();
            await using var create = new SqlCommand($"CREATE DATABASE [{Database}]", server);
            await create.ExecuteNonQueryAsync();
        }
        await using (var db = NewDb())
            await db.Database.MigrateAsync();

        var settings = Settings;
        Api = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Testing");
            foreach (var (key, value) in settings) b.UseSetting(key, value);
            b.ConfigureLogging(l => l.SetMinimumLevel(Enum.TryParse<LogLevel>(Environment.GetEnvironmentVariable("CGW_TEST_LOG"), out var level) ? level : LogLevel.Warning));
        });
        _ = Api.Server;

        var worker = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { EnvironmentName = "Testing" });
        worker.Configuration.AddInMemoryCollection(settings);
        worker.Logging.SetMinimumLevel(LogLevel.Warning);
        worker.Services.AddCgwCore(worker.Configuration);
        worker.Services.AddCgwWorker(worker.Configuration);
        // A stand-in for a malware scanner (the hook ARCHITECTURE.md's Upload safety names): it
        // refuses files named for the test that checks a refusal is quarantined.
        worker.Services.AddSingleton<Cgw.Worker.Jobs.IAssetScanner, RefusingScanner>();
        Worker = worker.Build().Services;
    }

    public async ValueTask DisposeAsync()
    {
        await Api.DisposeAsync();
        Microsoft.Data.SqlClient.SqlConnection.ClearAllPools();
        try
        {
            await using var server = new SqlConnection(ServerConnection);
            await server.OpenAsync();
            await using var drop = new SqlCommand($"ALTER DATABASE [{Database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{Database}];", server);
            await drop.ExecuteNonQueryAsync();
        }
        catch (SqlException)
        {
            // A database left behind is dropped by the next run's clean-up of old ones.
        }
        try
        {
            azurite?.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
        }
        if (Directory.Exists(MailDir)) Directory.Delete(MailDir, recursive: true);
    }

    public CgwDb NewDb(Guid? workspace = null)
    {
        var builder = new DbContextOptionsBuilder<CgwDb>().UseSqlServer(SqlConnection);
        builder.UseOpenIddict<Guid>();
        var options = builder.Options;
        var scope = new TenantScope();
        if (workspace is { } id) scope.Enter(id);
        return new CgwDb(options, scope);
    }

    /// <summary>Runs one of the worker's jobs to the end of what is due.</summary>
    public async Task RunJob<T>(int rounds = 20) where T : IJob
    {
        var job = Worker.GetServices<IJob>().OfType<T>().Single();
        var logger = Worker.GetRequiredService<ILoggerFactory>().CreateLogger("test");
        for (var i = 0; i < rounds; i++)
            if (!await JobLoop.RunOnceAsync(Worker, job, logger, TimeProvider.System, CancellationToken.None))
                break;
    }

    public HttpClient Anonymous() => ClientOf(Api);

    /// <summary>A browser-like client (cookies, no redirects followed) on this API or a variant of it.</summary>
    public static HttpClient ClientOf(WebApplicationFactory<Program> factory) => factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        BaseAddress = new Uri("https://localhost"),
        HandleCookies = true,
        AllowAutoRedirect = false,
    });

    /// <summary>
    /// The API with some settings or services changed, on the same database and keys (a cookie or
    /// token from one is good in the other). Disposed with the fixture.
    /// </summary>
    public WebApplicationFactory<Program> Variant(Action<IWebHostBuilder> configure) => Api.WithWebHostBuilder(configure);

    /// <summary>The fields of a page's form (by its action): the hidden ones, HTML-decoded.</summary>
    public static List<KeyValuePair<string, string>> FormFields(string html, string action)
    {
        var form = Regex.Match(html, $"""<form method="post" action="{Regex.Escape(action)}">(.*?)</form>""", RegexOptions.Singleline);
        if (!form.Success) throw new InvalidOperationException($"No form for {action} in the page.");
        return Regex.Matches(form.Groups[1].Value, """<input type="hidden" name="([^"]*)" value="([^"]*)">""")
            .Select(m => KeyValuePair.Create(WebUtility.HtmlDecode(m.Groups[1].Value), WebUtility.HtmlDecode(m.Groups[2].Value)))
            .ToList();
    }

    /// <summary>Submits a page's form as a browser does: its hidden fields and the ones typed or pressed.</summary>
    public static async Task<HttpResponseMessage> Submit(HttpClient client, string html, string action, params (string Name, string Value)[] typed)
    {
        var fields = FormFields(html, action);
        fields.AddRange(typed.Select(t => KeyValuePair.Create(t.Name, t.Value)));
        return await client.PostAsync(action, new FormUrlEncodedContent(fields));
    }

    /// <summary>Opens a page and submits its form.</summary>
    public static async Task<HttpResponseMessage> OpenAndSubmit(HttpClient client, string url, string action, params (string Name, string Value)[] typed)
    {
        var page = await client.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        return await Submit(client, await page.Content.ReadAsStringAsync(), action, typed);
    }

    /// <summary>The mail files to an address so far, to tell a new mail from an old one.</summary>
    public HashSet<string> MailFiles() => Directory.Exists(MailDir) ? Directory.GetFiles(MailDir, "*.eml").ToHashSet() : [];

    /// <summary>A mail to an address that was not among <paramref name="before"/>, waiting for the queue to send it.</summary>
    public async Task<string> NewMailTo(string address, string containing, HashSet<string> before)
    {
        for (var i = 0; i < 100; i++)
        {
            var found = MailFiles().Except(before).OrderByDescending(f => f).Select(Read)
                .FirstOrDefault(m => m.Contains(address, StringComparison.OrdinalIgnoreCase) && m.Replace("=\r\n", "").Contains(containing));
            if (found is not null) return found;
            await Task.Delay(100);
        }
        throw new InvalidOperationException($"No new mail to {address}.");
    }

    /// <summary>How many mails to an address hold a text (after the queue has had a moment).</summary>
    public async Task<int> CountMailTo(string address, string containing)
    {
        await Task.Delay(1500);
        return MailFiles().Select(Read).Count(m => m.Contains(address, StringComparison.OrdinalIgnoreCase) && m.Replace("=\r\n", "").Contains(containing));
    }

    /// <summary>The newest mail to an address, waiting a moment for it.</summary>
    public async Task<string> MailTo(string address, string? containing = null)
    {
        for (var i = 0; i < 50; i++)
        {
            if (Directory.Exists(MailDir))
            {
                var found = Directory.GetFiles(MailDir, "*.eml")
                    .OrderByDescending(f => f)
                    .Select(Read)
                    .FirstOrDefault(m => m.Contains(address, StringComparison.OrdinalIgnoreCase) && (containing is null || m.Contains(containing)));
                if (found is not null) return found;
            }
            await Task.Delay(100);
        }
        throw new InvalidOperationException($"No mail to {address}.");
    }

    /// <summary>A mail file, or nothing while the mailer is still writing it (tests run in parallel).</summary>
    private static string Read(string file)
    {
        try
        {
            return File.ReadAllText(file);
        }
        catch (IOException)
        {
            return "";
        }
    }

    public static string Link(string mail, string path)
    {
        var text = mail.Replace("=\r\n", "").Replace("=3D", "=");
        var match = Regex.Match(text, $@"https://localhost{Regex.Escape(path)}[^\s""<>]+");
        if (!match.Success) throw new InvalidOperationException($"No {path} link in the mail.");
        return WebUtility.HtmlDecode(match.Value);
    }

    private static int counter;

    /// <summary>A fresh confirmed account, signed in on a cookie client with its antiforgery header.</summary>
    public async Task<Account> NewAccount(string? name = null)
    {
        var n = Interlocked.Increment(ref counter);
        var email = $"user{n}-{Guid.NewGuid():N}@example.test";
        var password = "correct horse battery " + n;
        var client = Anonymous();
        var register = await client.PostAsJsonAsync("/api/v1/account/register", new { email, password, displayName = name ?? $"User {n}", locale = "en" });
        Assert.Equal(HttpStatusCode.Accepted, register.StatusCode);
        var link = Link(await MailTo(email), "/account/confirm");
        var confirmed = await OpenAndSubmit(client, link, "/account/confirm");
        Assert.Contains("Your email is confirmed", await confirmed.Content.ReadAsStringAsync());
        await SignIn(client, email, password);
        var me = await client.GetFromJsonAsync<JsonElement>("/api/v1/account/me");
        return new Account(client, email, password, me.GetProperty("id").GetGuid());
    }

    public static async Task<HttpResponseMessage> SignIn(HttpClient client, string email, string password, string? returnUrl = null)
    {
        var page = await (await client.GetAsync("/account/signin")).Content.ReadAsStringAsync();
        var token = Regex.Match(page, "name=\"__RequestVerificationToken\" value=\"([^\"]+)\"").Groups[1].Value;
        var response = await client.PostAsync("/account/signin", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["__RequestVerificationToken"] = WebUtility.HtmlDecode(token),
            ["Email"] = email,
            ["Password"] = password,
            ["ReturnUrl"] = returnUrl ?? "",
        }));
        if (response.StatusCode == HttpStatusCode.Redirect)
        {
            var csrf = await client.GetFromJsonAsync<JsonElement>("/api/v1/account/antiforgery");
            client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
            client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", csrf.GetProperty("token").GetString());
        }
        return response;
    }

    private static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "pnpm-workspace.yaml"))) return dir.FullName;
        throw new InvalidOperationException("Run the tests inside the repository.");
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static async Task WaitForPort(int port)
    {
        for (var i = 0; i < 100; i++)
        {
            try
            {
                using var client = new TcpClient();
                await client.ConnectAsync(IPAddress.Loopback, port);
                return;
            }
            catch (SocketException)
            {
                await Task.Delay(100);
            }
        }
        throw new InvalidOperationException("Azurite did not open its port.");
    }
}

public sealed record Account(HttpClient Client, string Email, string Password, Guid Id);

/// <summary>Refuses assets whose file name starts with <see cref="Refused"/>; passes the rest.</summary>
public sealed class RefusingScanner : Cgw.Worker.Jobs.IAssetScanner
{
    public const string Refused = "infected-";

    public Task<bool> CleanAsync(Cgw.Core.Data.Asset asset, byte[] head, CancellationToken ct) =>
        Task.FromResult(!asset.FileName.StartsWith(Refused, StringComparison.Ordinal));
}
