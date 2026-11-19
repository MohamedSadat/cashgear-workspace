using System.Globalization;
using System.Text;
using Cgw.Core;
using Cgw.Core.Data;
using Cgw.Core.Documents;
using Cgw.Core.Sharing;
using Cgw.Core.Sync;
using Cgw.Core.Workbooks;
using Microsoft.Extensions.DependencyInjection;

namespace Cgw.Tests;

/// <summary>
/// Phase 11's safety net (M11.1): access decided by one rule in every path. Each seed makes a
/// random workspace (shared and private sections, one with no owner; a tree with restricted,
/// trashed and deleted pages; databases and their rows; an owner, an admin, members, guests and
/// someone not in the workspace with rows and groups left over; groups of random people, a guest
/// and the stranger slipped into some; person, group and workspace rows at random levels, a person
/// with their own row and their groups' rows, a person in two groups on one page; workbooks) and
/// holds every path's answer for every person and page to a reference implementation of the rule
/// (DECISIONS.md, 2026-11-19): the deciding page is the nearest page, walking up, that is
/// restricted or has a row for the caller (their own, a group's they are in, the workspace's for
/// a non-guest); there their own row, else the highest of their groups', else the workspace's,
/// else (restricted) none; owners and admins full in shared sections; a private section its
/// owner's; a row its database's. The paths: <see cref="Access"/>'s every method, the page gate,
/// the hub's push (its SQL fast path, which must decide exactly the member cases it claims, in one
/// round trip), workbooks' levels and list, the tree, and keep-access-on-move's copied rows.
/// <c>ORACLE_SEEDS</c> sets how many seeds (default 16), <c>ORACLE_SEED</c> replays one; a
/// failure names its seed and prints the world.
/// </summary>
public sealed class AccessOracleTests(ServerFixture server)
{
    private static readonly string[] AllLevels = [Levels.Full, Levels.Edit, Levels.Comment, Levels.View, Levels.None];

    private sealed class Person(string label, string? role)
    {
        public string Label { get; } = label;
        public Guid Id { get; } = Guid.CreateVersion7();
        /// <summary>Null: not a member of the workspace (rows and groups of theirs are left over).</summary>
        public string? Role { get; } = role;
        public bool IsGuest => Role == Roles.Guest;
        public bool IsAdmin => Role is Roles.Owner or Roles.Admin;
        public override string ToString() => Label;
    }

    private sealed class Sec(string label, bool isPrivate, Person? owner)
    {
        public string Label { get; } = label;
        public Guid Id { get; } = Guid.CreateVersion7();
        public bool IsPrivate { get; } = isPrivate;
        public Person? Owner { get; } = owner;
    }

    private sealed record Row(string Type, Guid Id, string Level);

    private sealed class Pg(string label, Sec section, Pg? parent, string kind)
    {
        public string Label { get; } = label;
        public Guid Id { get; } = Guid.CreateVersion7();
        public Sec Section { get; } = section;
        public Pg? Parent { get; } = parent;
        public string Kind { get; } = kind;
        public bool Restricted { get; set; }
        public bool Trashed { get; set; }
        public bool Deleted { get; set; }
        public List<Row> Rows { get; } = [];
        public override string ToString() => Label;
    }

    private sealed class Grp(string label)
    {
        public string Label { get; } = label;
        public Guid Id { get; } = Guid.CreateVersion7();
        public List<Person> People { get; } = [];
    }

    private sealed class Book(string label, bool restricted)
    {
        public string Label { get; } = label;
        public Guid Id { get; } = Guid.CreateVersion7();
        public bool Restricted { get; } = restricted;
        public List<Row> Rows { get; } = [];
    }

    private sealed class World(int seed)
    {
        public int Seed { get; } = seed;
        public Guid Id { get; } = Guid.CreateVersion7();
        public List<Person> People { get; } = [];
        public List<Sec> Sections { get; } = [];
        public List<Grp> Groups { get; } = [];
        public List<Pg> Pages { get; } = [];
        public List<Book> Books { get; } = [];
        public Grp Group(Guid id) => Groups.Single(g => g.Id == id);
        public string Name(Guid id) =>
            People.FirstOrDefault(p => p.Id == id)?.Label ?? Groups.FirstOrDefault(g => g.Id == id)?.Label ?? (id == Id ? "workspace" : id.ToString());
        public IReadOnlySet<Guid> GroupsOf(Person who) =>
            who.IsGuest || who.Role is null ? new HashSet<Guid>() : Groups.Where(g => g.People.Contains(who)).Select(g => g.Id).ToHashSet();
    }

    // The rule, as plainly as it can be said -------------------------------------------------------

    /// <summary>What the rows of one page (or workbook) say for someone: own, else highest group, else workspace; null when none speaks.</summary>
    private static string? Says(World w, Person who, IEnumerable<Row> rows)
    {
        var list = rows.ToList();
        if (list.FirstOrDefault(r => r.Type == Principals.User && r.Id == who.Id) is { } own) return own.Level;
        if (who.IsGuest) return null;
        var mine = list.Where(r => r.Type == Principals.Group && w.Group(r.Id).People.Contains(who)).Select(r => r.Level).ToList();
        if (mine.Count > 0) return mine.MaxBy(Levels.Rank);
        return list.FirstOrDefault(r => r.Type == Principals.Workspace)?.Level;
    }

    /// <summary>The level the rule gives, deleted pages read as if they were not (what a tombstone gave).</summary>
    private static string Alive(World w, Person who, Pg page)
    {
        if (who.Role is null) return Levels.None;
        if (page.Kind == PageKinds.Row) return Alive(w, who, page.Parent!);
        if (page.Section.IsPrivate) return page.Section.Owner == who ? Levels.Full : Levels.None;
        if (who.IsAdmin) return Levels.Full;
        for (var link = page; link is not null; link = link.Parent)
        {
            if (Says(w, who, link.Rows) is { } level) return level;
            if (link.Restricted) return Levels.None;
        }
        return who.IsGuest ? Levels.None : Levels.Edit;
    }

    private static string Rule(World w, Person who, Pg page) => page.Deleted ? Levels.None : Alive(w, who, page);

    private static string Rule(World w, Person who, Book book)
    {
        if (who.Role is null) return Levels.None;
        if (who.IsAdmin) return Levels.Full;
        if (Says(w, who, book.Rows) is { } level) return level;
        return book.Restricted || who.IsGuest ? Levels.None : Levels.Edit;
    }

    /// <summary>Whether the push's SQL alone may decide (and so must decide) for a member: nothing on the chain restricted or speaking for them.</summary>
    private static bool NothingSpeaks(World w, Person who, Pg page)
    {
        for (var link = page; link is not null; link = link.Parent)
            if (link.Restricted || Says(w, who, link.Rows) is not null) return false;
        return true;
    }

    // The worlds -----------------------------------------------------------------------------------

    private static T Pick<T>(Random rnd, IReadOnlyList<T> list) => list[rnd.Next(list.Count)];

    private static World Generate(int seed)
    {
        var rnd = new Random(seed);
        var w = new World(seed);
        Person Add(string label, string? role)
        {
            var person = new Person(label, role);
            w.People.Add(person);
            return person;
        }
        Add("owner", Roles.Owner);
        Add("admin", Roles.Admin);
        for (var i = 0; i < rnd.Next(3, 6); i++) Add($"member{i}", Roles.Member);
        for (var i = 0; i < rnd.Next(2, 4); i++) Add($"guest{i}", Roles.Guest);
        var stranger = Add("stranger", null);
        var members = w.People.Where(p => p.Role is not null && !p.IsGuest).ToList();
        var plain = w.People.Where(p => p.Role == Roles.Member).ToList();
        var guests = w.People.Where(p => p.IsGuest).ToList();

        var shared = new[] { new Sec("shared A", false, null), new Sec("shared B", false, null) };
        w.Sections.AddRange(shared);
        w.Sections.Add(new Sec("private of " + plain[0].Label, true, plain[0]));
        w.Sections.Add(new Sec("private of " + guests[0].Label, true, guests[0]));
        if (rnd.Next(2) == 0) w.Sections.Add(new Sec("private of no one", true, null));
        var privates = w.Sections.Where(s => s.IsPrivate).ToList();

        for (var i = 0; i < rnd.Next(2, 6); i++) w.Groups.Add(new Grp($"group{i}"));
        foreach (var group in w.Groups)
            foreach (var person in members)
                if (rnd.NextDouble() < 0.4) group.People.Add(person);
        // Left over or slipped in: nothing a guest or a stranger is in may give them anything.
        if (rnd.Next(2) == 0) Pick(rnd, w.Groups).People.Add(Pick(rnd, guests));
        if (rnd.Next(2) == 0) Pick(rnd, w.Groups).People.Add(stranger);

        var count = rnd.Next(26, 38);
        for (var i = 0; i < count; i++)
        {
            var section = rnd.NextDouble() < 0.8 ? Pick(rnd, shared) : Pick(rnd, privates);
            var parents = w.Pages.Where(p => p.Section == section && p.Kind == PageKinds.Page).ToList();
            var parent = parents.Count > 0 && rnd.NextDouble() < 0.75 ? Pick(rnd, parents) : null;
            var page = new Pg($"p{i}", section, parent, rnd.NextDouble() < 0.12 ? PageKinds.Database : PageKinds.Page)
            {
                Restricted = rnd.NextDouble() < 0.2,
                Trashed = rnd.NextDouble() < 0.1,
            };
            w.Pages.Add(page);
            if (page.Kind == PageKinds.Database)
                for (var r = 0; r < rnd.Next(1, 4); r++) w.Pages.Add(new Pg($"p{i}.row{r}", section, page, PageKinds.Row));
        }

        Row RandomRow(IReadOnlyCollection<Row> taken)
        {
            for (var tries = 0; ; tries++)
            {
                var roll = rnd.NextDouble();
                var row = roll < 0.45 ? new Row(Principals.User, Pick(rnd, w.People).Id, Pick(rnd, AllLevels))
                    : roll < 0.8 ? new Row(Principals.Group, Pick(rnd, w.Groups).Id, Pick(rnd, AllLevels))
                    : new Row(Principals.Workspace, w.Id, Pick(rnd, AllLevels));
                if (tries > 20 || !taken.Any(t => t.Type == row.Type && t.Id == row.Id)) return row;
            }
        }
        void Put(List<Row> rows, Row row)
        {
            rows.RemoveAll(r => r.Type == row.Type && r.Id == row.Id);
            rows.Add(row);
        }
        foreach (var page in w.Pages.Where(p => p.Kind != PageKinds.Row))
            if (rnd.NextDouble() < 0.55)
                for (var r = rnd.Next(1, 5); r > 0; r--)
                {
                    var row = RandomRow(page.Rows);
                    Put(page.Rows, row);
                }

        // A subtree or two deleted for good (their rows of databases with them).
        for (var d = rnd.Next(1, 3); d > 0; d--)
        {
            var root = Pick(rnd, w.Pages.Where(p => p.Kind != PageKinds.Row).ToList());
            foreach (var page in w.Pages)
                for (var link = page; link is not null; link = link.Parent)
                    if (link == root) page.Deleted = true;
        }

        // What must be there whatever the dice say, on live pages of shared sections.
        var open = w.Pages.Where(p => !p.Deleted && p.Kind != PageKinds.Row && !p.Section.IsPrivate).ToList();
        var inTwo = plain.FirstOrDefault(p => w.Groups.Count(g => g.People.Contains(p)) >= 2);
        if (inTwo is null)
        {
            inTwo = Pick(rnd, plain);
            foreach (var group in w.Groups.Take(2))
                if (!group.People.Contains(inTwo)) group.People.Add(inTwo);
        }
        var two = w.Groups.Where(g => g.People.Contains(inTwo)).Take(2).ToList();
        if (two.Count == 2)
        {
            // Two of their groups on one page, the levels different: the higher decides.
            var page = Pick(rnd, open);
            Put(page.Rows, new Row(Principals.Group, two[0].Id, Levels.View));
            Put(page.Rows, new Row(Principals.Group, two[1].Id, Levels.Edit));
            page.Rows.RemoveAll(r => r.Type == Principals.User && r.Id == inTwo.Id);
            // And a nearer page giving the lower of them: nearer decides, even when lower.
            if (w.Pages.FirstOrDefault(p => p.Parent == page && !p.Deleted && p.Kind == PageKinds.Page) is { } child)
            {
                Put(child.Rows, new Row(Principals.Group, two[0].Id, Levels.Comment));
                child.Rows.RemoveAll(r => r.Type == Principals.User && r.Id == inTwo.Id);
            }
        }
        // Their own row beside their group's: their own decides.
        var grouped = w.Groups.First(g => g.People.Any(p => p.Role == Roles.Member));
        var someone = grouped.People.First(p => p.Role == Roles.Member);
        var both = Pick(rnd, open);
        Put(both.Rows, new Row(Principals.User, someone.Id, Levels.View));
        Put(both.Rows, new Row(Principals.Group, grouped.Id, Levels.Full));
        // A page restricted to a group.
        var restricted = Pick(rnd, open);
        restricted.Restricted = true;
        restricted.Rows.Clear();
        restricted.Rows.Add(new Row(Principals.Group, Pick(rnd, w.Groups).Id, Pick<string>(rnd, [Levels.View, Levels.Edit, Levels.Full])));

        for (var i = 0; i < rnd.Next(4, 9); i++)
        {
            var book = new Book($"book{i}", rnd.NextDouble() < 0.4);
            for (var r = rnd.Next(0, 4); r > 0; r--) Put(book.Rows, RandomRow(book.Rows));
            w.Books.Add(book);
        }
        var bookOfGroups = new Book("book of two groups", true);
        if (two.Count == 2)
        {
            bookOfGroups.Rows.Add(new Row(Principals.Group, two[0].Id, Levels.Comment));
            bookOfGroups.Rows.Add(new Row(Principals.Group, two[1].Id, Levels.Full));
        }
        w.Books.Add(bookOfGroups);
        return w;
    }

    private async Task SeedAsync(World w)
    {
        await using var db = server.NewDb(w.Id);
        var now = DateTimeOffset.UtcNow;
        var owner = w.People[0].Id;
        db.Workspaces.Add(new Workspace { Id = w.Id, Name = $"Oracle {w.Seed}", OwnerUserId = owner, CreatedAt = now, Version = 1 });
        foreach (var person in w.People.Where(p => p.Role is not null))
            db.WorkspaceMembers.Add(new WorkspaceMember { WorkspaceId = w.Id, UserId = person.Id, Role = person.Role!, CreatedAt = now });
        foreach (var section in w.Sections)
            db.Sections.Add(new Section
            {
                Id = section.Id, WorkspaceId = w.Id, Name = section.Label, OrderKey = "a0",
                Visibility = section.IsPrivate ? "private" : "workspace", OwnerUserId = section.Owner?.Id, CreatedAt = now,
            });
        foreach (var page in w.Pages)
        {
            db.Pages.Add(new Page
            {
                Id = page.Id, WorkspaceId = w.Id, SectionId = page.Section.Id, ParentPageId = page.Parent?.Id, OrderKey = "a0",
                Kind = page.Kind, Title = page.Label, SearchTitle = page.Label, Restricted = page.Restricted,
                CreatedBy = owner, UpdatedBy = owner, CreatedAt = now, UpdatedAt = now,
                // Not a trash root, so trash retention never takes it; a tombstone already purged, so
                // the purge job leaves its rows (what a tombstone gave is read from them).
                TrashedAt = page.Trashed ? now : null,
                DeletedAt = page.Deleted ? now : null,
                PurgedAt = page.Deleted ? now : null,
            });
            if (page.Kind != PageKinds.Row && !page.Deleted)
            {
                var depth = 0;
                for (var link = page; link is not null; link = link.Parent, depth++)
                    db.PageAncestors.Add(new PageAncestor { PageId = page.Id, AncestorPageId = link.Id, Depth = depth, WorkspaceId = w.Id });
            }
            foreach (var row in page.Rows)
                db.PagePermissions.Add(new PagePermission
                {
                    PageId = page.Id, PrincipalType = row.Type, PrincipalId = row.Id, Level = row.Level, WorkspaceId = w.Id, CreatedBy = owner, CreatedAt = now,
                });
        }
        foreach (var group in w.Groups)
        {
            db.WorkspaceGroups.Add(new WorkspaceGroup
            {
                Id = group.Id, WorkspaceId = w.Id, Name = group.Label, SearchName = group.Label, CreatedBy = owner, CreatedAt = now, UpdatedBy = owner, UpdatedAt = now,
            });
            foreach (var person in group.People)
                db.WorkspaceGroupMembers.Add(new WorkspaceGroupMember { GroupId = group.Id, UserId = person.Id, WorkspaceId = w.Id, AddedBy = owner, AddedAt = now });
        }
        foreach (var book in w.Books)
        {
            db.Workbooks.Add(new Workbook
            {
                Id = book.Id, WorkspaceId = w.Id, Name = book.Label, SearchName = book.Label, Restricted = book.Restricted, CreatedBy = owner, CreatedAt = now, UpdatedAt = now,
            });
            foreach (var row in book.Rows)
                db.WorkbookPermissions.Add(new WorkbookPermission
                {
                    WorkbookId = book.Id, PrincipalType = row.Type, PrincipalId = row.Id, Level = row.Level, WorkspaceId = w.Id, CreatedBy = owner, CreatedAt = now,
                });
        }
        await db.SaveChangesAsync();
    }

    private static string Describe(World w)
    {
        var text = new StringBuilder();
        text.AppendLine(CultureInfo.InvariantCulture, $"World of seed {w.Seed}:");
        text.AppendLine("  people: " + string.Join(", ", w.People.Select(p => $"{p.Label} ({p.Role ?? "not a member"})")));
        foreach (var group in w.Groups) text.AppendLine(CultureInfo.InvariantCulture, $"  {group.Label}: {string.Join(", ", group.People)}");
        foreach (var page in w.Pages)
        {
            var flags = string.Join(" ", new[] { page.Kind, page.Restricted ? "restricted" : null, page.Trashed ? "trashed" : null, page.Deleted ? "deleted" : null }.Where(f => f is not null));
            text.AppendLine(CultureInfo.InvariantCulture,
                $"  {page.Label} in {page.Section.Label} under {page.Parent?.Label ?? "the top"} [{flags}]: {string.Join(", ", page.Rows.Select(r => $"{w.Name(r.Id)} {r.Level}"))}");
        }
        foreach (var book in w.Books)
            text.AppendLine(CultureInfo.InvariantCulture, $"  {book.Label}{(book.Restricted ? " restricted" : "")}: {string.Join(", ", book.Rows.Select(r => $"{w.Name(r.Id)} {r.Level}"))}");
        return text.ToString();
    }

    private static IEnumerable<int> Seeds()
    {
        if (int.TryParse(Environment.GetEnvironmentVariable("ORACLE_SEED"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var one)) return [one];
        var count = int.TryParse(Environment.GetEnvironmentVariable("ORACLE_SEEDS"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 16;
        return Enumerable.Range(1, count).Select(i => i * 7919);
    }

    [Fact]
    public async Task Every_path_gives_every_person_on_every_page_what_the_rule_says()
    {
        foreach (var seed in Seeds())
        {
            var world = Generate(seed);
            await SeedAsync(world);
            var failures = await CheckAsync(world);
            Assert.True(failures.Count == 0, $"seed {seed} (ORACLE_SEED={seed} replays it):\n{string.Join("\n", failures)}\n\n{Describe(world)}");
        }
    }

    private async Task<List<string>> CheckAsync(World w)
    {
        var failures = new List<string>();
        void Check(string what, string? expected, string? actual)
        {
            if (expected != actual && failures.Count < 60) failures.Add($"{what}: {actual ?? "nothing"}, the rule says {expected ?? "nothing"}");
        }
        void CheckSet(string what, IEnumerable<Guid> expected, IEnumerable<Guid> actual)
        {
            var want = expected.Select(w.Name).Order().ToList();
            var got = actual.Select(w.Name).Order().ToList();
            Check(what, string.Join(", ", want), string.Join(", ", got));
        }

        await using var scope = server.Api.Services.CreateAsyncScope();
        var services = scope.ServiceProvider;
        services.GetRequiredService<TenantScope>().Enter(w.Id);
        var access = services.GetRequiredService<Access>();
        var books = services.GetRequiredService<WorkbookAccess>();
        var bookList = services.GetRequiredService<WorkbookService>();
        var feed = services.GetRequiredService<FeedService>();
        var gate = services.GetRequiredService<PageGate>();
        var docs = services.GetRequiredService<DocService>();
        var everyone = w.People.Select(p => p.Id).ToList();
        Page Entity(Pg page) => new() { Id = page.Id, WorkspaceId = w.Id, SectionId = page.Section.Id, ParentPageId = page.Parent?.Id, Kind = page.Kind, DeletedAt = page.Deleted ? DateTimeOffset.UtcNow : null };

        // The many-people paths: the worker's editors, the hub's and the mail's readers, each person's level.
        var editors = await access.EditorsAsync(w.Id, w.Pages.ToDictionary(p => p.Id, _ => everyone.ToHashSet()));
        foreach (var page in w.Pages)
        {
            CheckSet($"EditorsAsync on {page}", w.People.Where(p => Levels.AtLeast(Rule(w, p, page), Levels.Edit)).Select(p => p.Id), editors[page.Id]);
            CheckSet($"ReadersAsync on {page}", w.People.Where(p => Levels.AtLeast(Rule(w, p, page), Levels.View)).Select(p => p.Id),
                await access.ReadersAsync(w.Id, page.Id, everyone));
            var levels = await access.LevelsOfAsync(w.Id, page.Id, everyone);
            foreach (var person in w.People) Check($"LevelsOfAsync: {person} on {page}", Rule(w, person, page), levels.GetValueOrDefault(person.Id));
        }

        // Keep-access-on-move: the rows a page that leaves its chain keeps give everyone what the chain gave.
        foreach (var page in w.Pages.Where(p => !p.Deleted && p.Kind != PageKinds.Row && !p.Section.IsPrivate))
        {
            var kept = await access.EffectiveRowsAsync(w.Id, page.Id);
            if (kept.GroupBy(r => (r.PrincipalType, r.PrincipalId)).FirstOrDefault(g => g.Count() > 1) is { } twice)
                Check($"EffectiveRowsAsync under {page}", "each principal once", $"{w.Name(twice.Key.PrincipalId)} twice");
            foreach (var row in kept.Where(r => r.PrincipalType == Principals.User && w.People.Single(p => p.Id == r.PrincipalId).Role is null))
                Check($"EffectiveRowsAsync under {page}", "no row for someone not in the workspace", w.Name(row.PrincipalId));
            foreach (var person in w.People.Where(p => p.Role is not null))
                Check($"LevelUnder EffectiveRowsAsync: {person} under {page}", Alive(w, person, page),
                    Access.LevelUnder(new Member(w.Id, person.Id, person.Role!), w.GroupsOf(person), kept));
            var deciding = Chain(page).FirstOrDefault(p => p.Restricted || p.Rows.Count > 0);
            Check($"DecidingPageAsync from {page}", deciding?.Label, (await access.DecidingPageAsync(page.Id)) is { } id ? w.Pages.Single(p => p.Id == id).Label : null);
        }

        // Each member's own paths.
        foreach (var person in w.People.Where(p => p.Role is not null))
        {
            var member = await access.MemberAsync(w.Id, person.Id);
            Check($"MemberAsync of {person}", person.Role, member?.Role);
            if (member is null) continue;
            CheckSet($"GroupsAsync of {person}", w.GroupsOf(person), await access.GroupsAsync(member));
            var many = await access.LevelsAsync(member, w.Pages.Select(p => p.Id).ToList());
            var all = await access.AllLevelsAsync(member);
            var tree = (await feed.TreeAsync(member, null)).Pages.ToDictionary(p => p.Id, p => p.Access);
            foreach (var page in w.Pages)
            {
                var rule = Rule(w, person, page);
                Check($"PageLevelAsync: {person} on {page}", rule, await access.PageLevelAsync(member, page.Id));
                // Absent is none, as every caller reads it.
                Check($"LevelsAsync: {person} on {page}", rule, many.GetValueOrDefault(page.Id, Levels.None));
                if (page.Deleted)
                {
                    Check($"AllLevelsAsync: {person} on deleted {page}", null, all.TryGetValue(page.Id, out var level) ? level : null);
                    Check($"DeletedLevelAsync: {person} on {page}", Alive(w, person, page), await access.DeletedLevelAsync(member, Entity(page)));
                }
                else Check($"AllLevelsAsync (LevelIn): {person} on {page}", rule, Access.LevelIn(all, Entity(page)));
                if (page.Kind != PageKinds.Row)
                    Check($"TreeAsync: {person} on {page}", page.Deleted || rule == Levels.None ? null : rule, tree.GetValueOrDefault(page.Id));
            }
            var entities = w.Books.Select(b => new Workbook { Id = b.Id, WorkspaceId = w.Id, Restricted = b.Restricted }).ToList();
            var bookLevels = await books.LevelsAsync(member, entities);
            var listed = (await bookList.ListAsync(member, false, null)).Workbooks.ToDictionary(b => b.Id, b => b.Access);
            foreach (var (book, entity) in w.Books.Zip(entities))
            {
                var rule = Rule(w, person, book);
                Check($"WorkbookAccess.LevelAsync: {person} on {book.Label}", rule, await books.LevelAsync(member, entity));
                Check($"WorkbookAccess.LevelsAsync: {person} on {book.Label}", rule, bookLevels.GetValueOrDefault(book.Id));
                Check($"WorkbookService.ListAsync: {person} on {book.Label}", rule == Levels.None ? null : rule, listed.GetValueOrDefault(book.Id));
            }
        }

        // The page gate and the hub's push, for everyone (the stranger included): the push is sent
        // to the wrong epoch, so nothing is stored; 409 says it would have gone in.
        using var commands = SqlCommands.Watch();
        foreach (var person in w.People)
            foreach (var page in w.Pages)
            {
                var rule = Rule(w, person, page);
                var expected = person.Role is null ? "404"
                    : page.Deleted ? (Alive(w, person, page) == Levels.None ? "404" : "410")
                    : rule == Levels.None ? "404" : "ok " + rule;
                var opened = await gate.OpenAsync(person.Id, page.Id);
                Check($"PageGate: {person} on {page}", expected, opened.Ok ? "ok " + opened.Value!.Level : opened.Failure!.Status.ToString(CultureInfo.InvariantCulture));

                var push = expected switch
                {
                    "ok full" or "ok edit" => "409",
                    "ok comment" or "ok view" => "403",
                    _ => expected,
                };
                commands.Clear();
                var pushed = await docs.PushThroughGateAsync(gate, person.Id, page.Id,
                    new PushRequest(7, 1, [new DocUpdateIn(Guid.CreateVersion7(), [1, 2, 3])]), null, DocService.MaxRequestBytes);
                Check($"PushThroughGateAsync: {person} on {page}", push, pushed.Ok ? "stored" : pushed.Failure!.Status.ToString(CultureInfo.InvariantCulture));
                // The fast path decides a member's push in one round trip exactly when nothing on the
                // chain is restricted or speaks for them; a guest's never.
                if (!page.Deleted && page.Kind != PageKinds.Row && !page.Section.IsPrivate && person.Role is Roles.Member or Roles.Guest)
                {
                    var trips = commands.Carrying(GuidBytes.ToBytes(page.Id)).Count;
                    var fast = person.Role == Roles.Member && NothingSpeaks(w, person, page);
                    Check($"the push's fast path: {person} on {page}", fast ? "one round trip" : "more than one", trips == 1 ? "one round trip" : "more than one");
                }
            }
        return failures;
    }

    private static IEnumerable<Pg> Chain(Pg page)
    {
        for (var link = page; link is not null; link = link.Parent) yield return link;
    }
}
