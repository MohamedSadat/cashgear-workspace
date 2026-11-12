using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Cgw.Core.Blob;
using Cgw.Core.Data;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Cgw.Tests;

/// <summary>M2.8 on the server: export, purges, account deletion and the reconcile job.</summary>
public sealed class OperationsTests(ServerFixture server)
{
    private static readonly HttpClient Blob = new();

    private BlobStore Store => server.Worker.GetRequiredService<BlobStore>();

    private async Task<List<string>> Blobs(string prefix)
    {
        var names = new List<string>();
        await foreach (var (name, _) in Store.ListAsync(prefix)) names.Add(name);
        return names;
    }

    [Fact]
    public async Task An_export_is_the_apps_zip_of_what_its_requester_may_read()
    {
        var ws = await Ws.Create(server);
        var admin = await Kit.Join(server, ws, "admin");
        var member = await Kit.Join(server, ws, "member");
        var parent = await Kit.PageWithText(server, ws, "Parent");
        var child = (await ws.NewPage("Child", parent)).GetProperty("id").GetGuid();
        var twin = (await ws.NewPage("Parent", orderKey: "a5")).GetProperty("id").GetGuid();
        var binned = (await ws.NewPage("Binned", orderKey: "a7")).GetProperty("id").GetGuid();
        await ws.Push(ws.Op("page.trash", binned, new { }));
        var mine = (await ws.NewPage("Diary", section: ws.Personal)).GetProperty("id").GetGuid();
        var picture = await AssetTests.Upload(ws, AssetTests.Png, "image/png", "cover: one.png");
        await server.RunJob<AssetCheckJob>();
        await ws.Push(ws.Op("page.update", child, new { coverAssetId = picture, icon = "📄" }));

        Assert.Equal(HttpStatusCode.Forbidden, (await member.Client.PostAsync($"/api/v1/workspaces/{ws.Id}/exports", null)).StatusCode);
        var requested = await Kit.Json(await ws.Client.PostAsync($"/api/v1/workspaces/{ws.Id}/exports", null));
        Assert.Equal("pending", requested.GetProperty("status").GetString());
        var id = requested.GetProperty("id").GetGuid();
        Assert.Equal(id, (await Kit.Json(await ws.Client.PostAsync($"/api/v1/workspaces/{ws.Id}/exports", null))).GetProperty("id").GetGuid());
        Assert.Equal(JsonValueKind.Null, (await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/exports/{id}")).GetProperty("url").ValueKind);
        await server.RunJob<ExportJob>();

        var ready = await ws.Client.GetFromJsonAsync<JsonElement>($"/api/v1/exports/{id}");
        Assert.Equal("ready", ready.GetProperty("status").GetString());
        // Only its requester reads it, even another admin.
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Client.GetAsync($"/api/v1/exports/{id}")).StatusCode);
        var download = await Blob.GetAsync(ready.GetProperty("url").GetString());
        Assert.Equal("attachment", download.Content.Headers.ContentDisposition?.DispositionType);
        using var zip = new ZipArchive(new MemoryStream(await download.Content.ReadAsByteArrayAsync()));
        string Read(string name)
        {
            var entry = zip.GetEntry(name) ?? throw new Xunit.Sdk.XunitException($"No {name} in {string.Join(", ", zip.Entries.Select(e => e.FullName))}");
            using var reader = new StreamReader(entry.Open(), Encoding.UTF8);
            return reader.ReadToEnd();
        }

        using var manifest = JsonDocument.Parse(Read("cgw-export.json"));
        var root = manifest.RootElement;
        Assert.Equal("cash-gear-workspace-export", root.GetProperty("format").GetString());
        Assert.Equal(1, root.GetProperty("version").GetInt32());
        Assert.Equal(ws.Id, root.GetProperty("workspace").GetProperty("id").GetGuid());
        Assert.Equal(["Shared", "Private"], root.GetProperty("sections").EnumerateArray().Select(s => s.GetProperty("name").GetString()));
        var pages = root.GetProperty("pages").EnumerateArray().ToDictionary(p => p.GetProperty("id").GetGuid());
        Assert.Equal(new[] { parent, child, twin, mine }.Order(), pages.Keys.Order());
        Assert.Equal("Shared/Parent/Parent.md", pages[parent].GetProperty("markdown").GetString());
        Assert.Equal("Shared/Parent/Child/Child.json", pages[child].GetProperty("json").GetString());
        Assert.Equal(parent, pages[child].GetProperty("parentPageId").GetGuid());
        Assert.Equal("Shared/Parent (2)/Parent (2).md", pages[twin].GetProperty("markdown").GetString());
        Assert.Equal("Private/Diary/Diary.md", pages[mine].GetProperty("markdown").GetString());
        var asset = Assert.Single(root.GetProperty("assets").EnumerateArray());
        Assert.Equal($"assets/{picture}/cover one.png", asset.GetProperty("file").GetString());
        Assert.Equal(64, asset.GetProperty("sha256").GetString()!.Length);

        Assert.Equal("# Parent\n\nHello world\n", Read("Shared/Parent/Parent.md"));
        // A page never edited is an empty document: a heading, then an empty body.
        Assert.Equal("# 📄 Child\n\n\n", Read("Shared/Parent/Child/Child.md"));
        using var json = JsonDocument.Parse(Read("Shared/Parent/Parent.json"));
        Assert.Equal(parent, json.RootElement.GetProperty("id").GetGuid());
        Assert.Equal("doc", json.RootElement.GetProperty("content").GetProperty("type").GetString());
        Assert.Contains("Hello world", json.RootElement.GetProperty("content").GetRawText());
        using (var image = zip.GetEntry($"assets/{picture}/cover one.png")!.Open())
        {
            var bytes = new MemoryStream();
            image.CopyTo(bytes);
            Assert.Equal(AssetTests.Png, bytes.ToArray());
        }
        await using var db = server.NewDb(ws.Id);
        Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "workspace.export" && a.TargetId == id));
    }

    [Fact]
    public async Task A_page_deleted_for_good_loses_its_document_history_links_and_grants()
    {
        var ws = await Ws.Create(server);
        var member = await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws, "Doomed");
        var other = (await ws.NewPage("Other")).GetProperty("id").GetGuid();
        await Kit.Share(ws, page, false, ("user", member.Id, "view"));
        await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/share-links", new { });
        await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { name = "v1" });
        await server.RunJob<SnapshotJob>();
        await Kit.InWorker(server, ws.Id, async (services, db) =>
        {
            await new CompactJob(services.GetRequiredService<DocStates>(), Store, new NoFaults(), TimeProvider.System).CompactAsync(db, page, CancellationToken.None);
            return 0;
        });
        await using (var db = server.NewDb(ws.Id))
        {
            db.PageLinks.Add(new PageLink { FromPageId = other, ToPageId = page, WorkspaceId = ws.Id });
            db.AssetRefs.Add(new AssetRef { AssetId = Guid.CreateVersion7(), PageId = page, WorkspaceId = ws.Id });
            await db.SaveChangesAsync();
            Assert.True(await db.PageDocSnapshots.CountAsync(s => s.PageId == page) >= 2);
        }
        Assert.NotEmpty(await Blobs(BlobStore.PagePrefix(ws.Id, page)));

        await ws.Push(ws.Op("page.trash", page, new { }));
        await ws.Push(ws.Op("page.delete", page, new { }));
        await Kit.InWorker(server, ws.Id, async (_, db) =>
        {
            await Kit.Job<PagePurgeJob>(server).PurgeAsync(db, ws.Id, page, CancellationToken.None);
            return 0;
        });

        await using (var db = server.NewDb(ws.Id))
        {
            Assert.False(await db.PageDocUpdates.AnyAsync(u => u.PageId == page));
            Assert.False(await db.PageDocSnapshots.AnyAsync(s => s.PageId == page));
            Assert.False(await db.PageDocDerived.AnyAsync(d => d.PageId == page));
            Assert.False(await db.PageLinks.AnyAsync(l => l.FromPageId == page || l.ToPageId == page));
            Assert.False(await db.AssetRefs.AnyAsync(r => r.PageId == page));
            Assert.False(await db.PagePermissions.AnyAsync(r => r.PageId == page));
            Assert.False(await db.ShareLinks.AnyAsync(l => l.PageId == page));
            var tombstone = await db.Pages.SingleAsync(p => p.Id == page);
            Assert.NotNull(tombstone.PurgedAt);
            Assert.Equal("", tombstone.Title);
        }
        Assert.Empty(await Blobs(BlobStore.PagePrefix(ws.Id, page)));
        // The tombstone still answers a late push.
        Assert.Equal(HttpStatusCode.Gone, (await Kit.Push(ws.Client, page, Kit.Update("edit"))).StatusCode);
    }

    [Fact]
    public async Task A_workspace_deleted_over_30_days_ago_loses_every_row_and_blob()
    {
        var ws = await Ws.Create(server);
        await Kit.Join(server, ws, "member");
        var page = await Kit.PageWithText(server, ws);
        await AssetTests.Upload(ws, AssetTests.Png, "image/png");
        await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { });
        await server.RunJob<SnapshotJob>();
        Assert.Equal(HttpStatusCode.NoContent, (await ws.Client.DeleteAsync($"/api/v1/workspaces/{ws.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ws.Client.GetAsync($"/api/v1/workspaces/{ws.Id}")).StatusCode);

        await server.RunJob<WorkspacePurgeJob>();
        await using (var db = server.NewDb(ws.Id))
            Assert.True(await db.Pages.AnyAsync(), "purged before its 30 days");
        await using (var db = server.NewDb())
            await db.Workspaces.Where(w => w.Id == ws.Id).ExecuteUpdateAsync(s => s.SetProperty(w => w.DeletedAt, DateTimeOffset.UtcNow.AddDays(-31)));
        await server.RunJob<WorkspacePurgeJob>();

        await using (var db = server.NewDb(ws.Id))
        {
            Assert.False(await db.Workspaces.AnyAsync(w => w.Id == ws.Id));
            var counts = new Dictionary<string, int>
            {
                ["members"] = await db.WorkspaceMembers.CountAsync(),
                ["sections"] = await db.Sections.CountAsync(),
                ["pages"] = await db.Pages.CountAsync(),
                ["ancestors"] = await db.PageAncestors.CountAsync(),
                ["updates"] = await db.PageDocUpdates.CountAsync(),
                ["snapshots"] = await db.PageDocSnapshots.CountAsync(),
                ["derived"] = await db.PageDocDerived.CountAsync(),
                ["assets"] = await db.Assets.CountAsync(),
                ["changes"] = await db.WorkspaceChanges.CountAsync(),
                ["applied"] = await db.AppliedOps.CountAsync(),
                ["yjsClients"] = await db.YjsClients.CountAsync(),
            };
            Assert.All(counts, c => Assert.True(c.Value == 0, $"{c.Key}: {c.Value} left"));
            // The audit log is append-only.
            Assert.True(await db.AuditLog.AnyAsync(a => a.Action == "workspace.delete"));
        }
        Assert.Empty(await Blobs(BlobStore.WorkspacePrefix(ws.Id)));
    }

    [Fact]
    public async Task The_session_answers_200_signed_in_or_not()
    {
        var account = await server.NewAccount("Sam");
        var signedIn = await account.Client.GetAsync("/api/v1/account/session");
        Assert.Equal(HttpStatusCode.OK, signedIn.StatusCode);
        var me = (await Kit.Json(signedIn)).GetProperty("account");
        Assert.Equal(account.Id, me.GetProperty("id").GetGuid());
        Assert.Equal("Sam", me.GetProperty("displayName").GetString());
        Assert.Equal(JsonValueKind.String, me.GetProperty("deviceId").ValueKind);

        var anonymous = await server.Anonymous().GetAsync("/api/v1/account/session");
        Assert.Equal(HttpStatusCode.OK, anonymous.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await Kit.Json(anonymous)).GetProperty("account").ValueKind);
        await account.Client.PostAsync("/api/v1/account/signout", null);
        Assert.Equal(JsonValueKind.Null, (await account.Client.GetFromJsonAsync<JsonElement>("/api/v1/account/session")).GetProperty("account").ValueKind);
        // /account/me keeps its 401.
        Assert.Equal(HttpStatusCode.Unauthorized, (await account.Client.GetAsync("/api/v1/account/me")).StatusCode);
    }

    [Fact]
    public async Task Deleting_an_account_hands_nothing_over_silently_and_scrubs_the_person()
    {
        var leaving = await server.NewAccount("Leaving");
        var alone = await Ws.Create(server, leaving);
        var colleague = await server.NewAccount("Colleague");
        var theirs = await Ws.Create(server, colleague);
        await Kit.Join(server, theirs, "member", leaving);
        var shared = await Kit.PageWithText(server, theirs, "Shared");
        var personal = Guid.CreateVersion7();
        var created = await theirs.Push(leaving.Client, theirs.Op("section.create", personal,
            new { id = personal, workspaceId = theirs.Id, name = "Mine", orderKey = "a5", visibility = "private", version = 1, createdAt = DateTimeOffset.UtcNow }));
        Assert.Equal("applied", created[0].GetProperty("status").GetString());
        var diary = Guid.CreateVersion7();
        Assert.Equal("applied", (await theirs.Push(leaving.Client, theirs.Op("page.create", diary, Ws.Page(diary, theirs.Id, personal, null, "a0", "Diary"))))[0].GetProperty("status").GetString());
        // An edit of theirs in a shared page stays, under "Deleted user".
        await Kit.Register(leaving.Client, theirs.Id, 7_000_001);
        await Kit.PushOk(leaving.Client, shared, Kit.Update("edit"));
        var held = await Ws.Create(server, leaving);
        await Kit.Join(server, held, "member", colleague);

        // The only owner of a workspace with other members must hand it over first.
        var refused = await leaving.Client.DeleteAsync("/api/v1/account");
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("conflict", await Kit.Code(refused));
        Assert.Equal(HttpStatusCode.OK, (await leaving.Client.PatchAsJsonAsync($"/api/v1/workspaces/{held.Id}/members/{colleague.Id}", new { role = "owner" })).StatusCode);
        var other = server.Anonymous();
        await ServerFixture.SignIn(other, leaving.Email, leaving.Password);
        Assert.Equal(HttpStatusCode.NoContent, (await leaving.Client.DeleteAsync("/api/v1/account")).StatusCode);

        // Every session is over, and the address no longer signs in.
        Assert.Equal(HttpStatusCode.Unauthorized, (await leaving.Client.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await other.GetAsync("/api/v1/account/me")).StatusCode);
        Assert.NotEqual(HttpStatusCode.Redirect, (await ServerFixture.SignIn(server.Anonymous(), leaving.Email, leaving.Password)).StatusCode);

        await using var db = server.NewDb();
        var user = await db.Users.AsNoTracking().SingleAsync(u => u.Id == leaving.Id);
        Assert.NotNull(user.DeletedAt);
        Assert.Equal("", user.DisplayName);
        Assert.DoesNotContain("example.test", user.Email);
        Assert.Null(user.PasswordHash);
        Assert.True(await db.Devices.Where(d => d.UserId == leaving.Id).AllAsync(d => d.RevokedAt != null));
        Assert.True(await db.AuditLog.IgnoreQueryFilters().AnyAsync(a => a.Action == "account.delete" && a.TargetId == leaving.Id));
        // A workspace no one else was in is deleted; the others carry on without them.
        Assert.NotNull((await db.Workspaces.AsNoTracking().SingleAsync(w => w.Id == alone.Id)).DeletedAt);
        Assert.Null((await db.Workspaces.AsNoTracking().SingleAsync(w => w.Id == held.Id)).DeletedAt);
        Assert.False(await db.WorkspaceMembers.IgnoreQueryFilters().AnyAsync(m => m.UserId == leaving.Id && (m.WorkspaceId == theirs.Id || m.WorkspaceId == held.Id)));
        var members = await colleague.Client.GetFromJsonAsync<JsonElement>($"/api/v1/workspaces/{theirs.Id}/members");
        Assert.DoesNotContain(members.EnumerateArray(), m => m.GetProperty("userId").GetGuid() == leaving.Id);
        // Their private section went with them; their edit stayed.
        Assert.False(await db.Sections.IgnoreQueryFilters().AnyAsync(s => s.Id == personal));
        Assert.NotNull((await db.Pages.IgnoreQueryFilters().AsNoTracking().SingleAsync(p => p.Id == diary)).DeletedAt);
        Assert.True(await db.PageDocUpdates.IgnoreQueryFilters().AnyAsync(u => u.PageId == shared && u.UserId == leaving.Id));
    }

    [Fact]
    public async Task Reconcile_puts_rows_and_blobs_back_in_step_and_can_run_any_time()
    {
        var ws = await Ws.Create(server);
        var page = await Kit.PageWithText(server, ws);
        await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { name = "kept" });
        var lost = await Kit.Json(await ws.Client.PostAsJsonAsync($"/api/v1/pages/{page}/versions", new { name = "lost" }));
        await server.RunJob<SnapshotJob>();
        var asset = await AssetTests.Upload(ws, AssetTests.Png, "image/png");
        await server.RunJob<AssetCheckJob>();
        var orphan = BlobStore.SnapshotKey(ws.Id, page, Guid.CreateVersion7());
        await Store.PutAsync(orphan, DocStates.Empty, "application/octet-stream");
        var orphanExport = BlobStore.ExportKey(ws.Id, Guid.CreateVersion7());
        await Store.PutAsync(orphanExport, [1, 2, 3], "application/zip");
        var lostId = lost.GetProperty("id").GetGuid();
        await Store.DeleteAsync(BlobStore.SnapshotKey(ws.Id, page, lostId));
        await Store.DeleteAsync(BlobStore.AssetKey(ws.Id, asset));

        Task<ReconcileJob.Report> Run(TimeSpan ahead) => Kit.InWorker(server, ws.Id, (services, db) =>
            new ReconcileJob(Store, services.GetRequiredService<DocStates>(), services.GetRequiredService<ILogger<ReconcileJob>>(), new ShiftedClock(ahead))
                .ReconcileAsync(db, CancellationToken.None, ws.Id));

        // Today: the missing are dealt with; the new orphans are left alone (a writer may be between its blob and its row).
        var first = await Run(TimeSpan.Zero);
        Assert.Equal(1, first.SnapshotsDropped);
        Assert.Equal(1, first.AssetsMissing);
        Assert.Equal(0, first.OrphansDeleted);
        Assert.True(await Store.ExistsAsync(orphan));
        await using (var db = server.NewDb(ws.Id))
        {
            Assert.False(await db.PageDocSnapshots.AnyAsync(s => s.Id == lostId));
            Assert.True(await db.PageDocSnapshots.AnyAsync(s => s.PageId == page && s.Name == "kept"));
            var missing = await db.Assets.SingleAsync(a => a.Id == asset);
            Assert.Equal("deleted", missing.Status);
            Assert.NotNull(missing.Problem);
        }
        // Two days on, orphans older than a day go; what rows name stays.
        var later = await Run(TimeSpan.FromDays(2));
        Assert.Equal(2, later.OrphansDeleted);
        Assert.False(await Store.ExistsAsync(orphan));
        Assert.False(await Store.ExistsAsync(orphanExport));
        Assert.NotEmpty(await Blobs(BlobStore.PagePrefix(ws.Id, page)));
        // Again: nothing left to do, and the page still loads.
        Assert.Equal(new ReconcileJob.Report(0, 0, 0, 0, 0), await Run(TimeSpan.FromDays(2)));
        Assert.Equal(HttpStatusCode.OK, (await ws.Client.GetAsync($"/api/v1/pages/{page}/doc?after=0")).StatusCode);
    }
}
