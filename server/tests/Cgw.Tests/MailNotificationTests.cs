using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Cgw.Core.Data;
using Cgw.Core.Mail;
using Cgw.Core.Notifications;
using Cgw.Worker;
using Cgw.Worker.Jobs;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MimeKit;

namespace Cgw.Tests;

/// <summary>
/// M8.5: mail for mentions and replies. Mailed once still unread after the delay, grouped per
/// person, in their language and direction, with links to the page and block and a one-click
/// unsubscribe; access and being unread checked again when sending; off sends nothing; a digest once
/// a day; a daily cap; failures retried and logged without content. Through the pickup folder.
/// The jobs run on a clock moved past the delay. They queue and send for everyone, so these tests
/// run alone (other tests' people are mailed too, and are never counted here).
/// </summary>
[Collection(AloneCollection.Name)]
public sealed class MailNotificationTests(ServerFixture server)
{
    private static readonly TimeSpan PastDelay = TimeSpan.FromMinutes(16);

    private (NotificationMailJob Queue, MailSendJob Send) Jobs(TimeProvider clock, int? cap = null, Mailer? mailer = null, ILogger<MailSendJob>? log = null)
    {
        var options = new MailSettingsOptions(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Web:AppUrl"] = "http://localhost:5273",
            ["Api:PublicUrl"] = "https://localhost",
            ["Mail:DailyCap"] = cap?.ToString(),
        }).Build());
        var w = server.Worker;
        return (new NotificationMailJob(options, clock, w.GetRequiredService<ILogger<NotificationMailJob>>()),
            new MailSendJob(mailer ?? w.GetRequiredService<Mailer>(), w.GetRequiredService<MailTokens>(), options, clock, log ?? w.GetRequiredService<ILogger<MailSendJob>>()));
    }

    private async Task Run(IJob job)
    {
        for (var i = 0; i < 20; i++)
        {
            await using var scope = server.Worker.CreateAsyncScope();
            if (!await job.RunAsync(scope.ServiceProvider, CancellationToken.None)) return;
        }
    }

    /// <summary>Queue and send, as the two loops do.</summary>
    private async Task Mail(TimeProvider clock, int? cap = null)
    {
        var (queue, send) = Jobs(clock, cap);
        await Run(queue);
        await Run(send);
    }

    private static ShiftedClock At(TimeSpan from) => new(from);

    /// <summary>The notification mails to an address so far, parsed.</summary>
    private List<MimeMessage> MailsTo(string address) =>
        server.MailFiles().Select(f =>
            {
                try
                {
                    return MimeMessage.Load(f);
                }
                catch (IOException)
                {
                    return null;
                }
            })
            .Where(m => m is not null && m.To.Mailboxes.Any(b => string.Equals(b.Address, address, StringComparison.OrdinalIgnoreCase))
                && m.Headers.Contains("List-Unsubscribe"))
            .Select(m => m!).ToList();

    private static string Token(MimeMessage mail)
    {
        var header = mail.Headers["List-Unsubscribe"] ?? "";
        var match = Regex.Match(header, @"^<https://localhost/mail/unsubscribe\?token=([A-Za-z0-9_%-]+)>$");
        Assert.True(match.Success, header);
        return Uri.UnescapeDataString(match.Groups[1].Value);
    }

    private static async Task<string> Setting(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/v1/account/notification-settings")).GetProperty("email").GetString()!;

    private static async Task Set(HttpClient client, string mode)
    {
        var response = await client.PutAsJsonAsync("/api/v1/account/notification-settings", new { email = mode });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private sealed record Team(Ws Ws, Account Member, Guid Page);

    private async Task<Team> TeamAsync(string memberName = "Mo Member", string title = "Budget")
    {
        var ws = await Ws.Create(server, await server.NewAccount("Olive Owner"));
        var member = await Kit.Join(server, ws, "member", await server.NewAccount(memberName));
        var page = (await ws.NewPage(title)).GetProperty("id").GetGuid();
        return new Team(ws, member, page);
    }

    /// <summary>The owner mentions the member in a comment on the page: a commentMention for them.</summary>
    private static async Task<Guid> Mention(Team team, Guid? page = null, string text = "Please look at the totals ")
    {
        var thread = await CommentTests.CreateOk(team.Ws.Client, page ?? team.Page,
            CommentTests.NewThread(body: [CommentTests.Text(text), CommentTests.Mention(team.Member.Id)]));
        return thread.GetProperty("id").GetGuid();
    }

    private async Task<List<Notification>> NotificationsOf(Guid userId)
    {
        await using var db = server.NewDb();
        return await db.Notifications.IgnoreQueryFilters([CgwDb.Tenant]).AsNoTracking().Where(n => n.UserId == userId).OrderBy(n => n.Seq).ToListAsync();
    }

    [Fact]
    public async Task Settings_are_on_by_default_and_take_on_a_daily_digest_or_off()
    {
        var account = await server.NewAccount();
        Assert.Equal("on", await Setting(account.Client));
        await Set(account.Client, "digest");
        Assert.Equal("digest", await Setting(account.Client));
        await Set(account.Client, "off");
        Assert.Equal("off", await Setting(account.Client));
        var wrong = await account.Client.PutAsJsonAsync("/api/v1/account/notification-settings", new { email = "weekly" });
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
        Assert.Equal("request.invalid", await Kit.Code(wrong));
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.Anonymous().GetAsync("/api/v1/account/notification-settings")).StatusCode);
        // Another account's choice is its own.
        Assert.Equal("on", await Setting((await server.NewAccount()).Client));
    }

    [Fact]
    public async Task A_mention_unread_after_the_delay_is_mailed_once_in_Arabic_right_to_left_and_opens_the_block()
    {
        var team = await TeamAsync("منى", "الميزانية");
        Assert.Equal(HttpStatusCode.NoContent, (await team.Member.Client.PatchAsJsonAsync("/api/v1/account/me", new { locale = "ar" })).StatusCode);
        await Mention(team, text: "راجعي الأرقام ");
        // Someone else, mentioned at the same time, who reads English.
        var other = await TeamAsync();
        await Mention(other);

        // Before the delay nothing goes.
        await Mail(At(TimeSpan.Zero));
        Assert.Empty(MailsTo(team.Member.Email));
        await Mail(At(PastDelay));
        var mail = Assert.Single(MailsTo(team.Member.Email));
        Assert.Contains("Olive Owner", mail.Subject);
        Assert.Contains("الميزانية", mail.Subject);
        Assert.StartsWith("أشار إليك", mail.Subject);
        var html = mail.HtmlBody;
        Assert.Contains("<html lang=\"ar\" dir=\"rtl\">", html);
        Assert.Contains("راجعي الأرقام @", html);
        Assert.Contains($"http://localhost:5273/#/p/{team.Page}/{CommentTests.Block}", html);
        Assert.Contains($"http://localhost:5273/#/p/{team.Page}/{CommentTests.Block}", mail.TextBody);
        Assert.Contains("إيقاف هذه الرسائل", mail.TextBody);
        Assert.Equal("List-Unsubscribe=One-Click", mail.Headers["List-Unsubscribe-Post"]);
        Assert.Equal("auto-generated", mail.Headers["Auto-Submitted"]);
        Token(mail);
        // Told once: marked, and nothing more however often the jobs run.
        Assert.All(await NotificationsOf(team.Member.Id), n => Assert.NotNull(n.EmailedAt));
        await Mail(At(PastDelay * 3));
        Assert.Single(MailsTo(team.Member.Email));
        // The other team's member reads English.
        var english = Assert.Single(MailsTo(other.Member.Email));
        Assert.Equal("Olive Owner mentioned you in a comment on “Budget”", english.Subject);
        Assert.Contains("<html lang=\"en\" dir=\"ltr\">", english.HtmlBody);
    }

    [Fact]
    public async Task Several_waiting_go_in_one_mail_and_the_next_waits_out_the_delay()
    {
        var team = await TeamAsync();
        await Mention(team, text: "First ");
        await Mention(team, text: "Second ");
        await Mail(At(PastDelay));
        var mail = Assert.Single(MailsTo(team.Member.Email));
        Assert.Equal("2 new mentions and replies in Cash Gear Workspace", mail.Subject);
        Assert.Contains("First @", mail.TextBody);
        Assert.Contains("Second @", mail.TextBody);
        // A third, a moment later: not before the person's next delay is out.
        await Mention(team, text: "Third ");
        await Mail(At(PastDelay + TimeSpan.FromMinutes(5)));
        Assert.Single(MailsTo(team.Member.Email));
        await Mail(At(PastDelay * 2 + TimeSpan.FromMinutes(1)));
        Assert.Equal(2, MailsTo(team.Member.Email).Count);
    }

    [Fact]
    public async Task Read_in_the_app_or_a_page_no_longer_readable_means_no_mail()
    {
        var team = await TeamAsync();
        var hidden = (await team.Ws.NewPage("Hidden later")).GetProperty("id").GetGuid();
        await Mention(team);
        await Mention(team, hidden);
        // One read in the app before its turn, and the other page taken away.
        var first = (await NotificationsOf(team.Member.Id))[0];
        Assert.Equal(HttpStatusCode.OK, (await team.Member.Client.PostAsJsonAsync("/api/v1/account/notifications/read", new { ids = new[] { first.Id } })).StatusCode);
        await Kit.Share(team.Ws, hidden, true);
        await Mail(At(PastDelay));
        Assert.Empty(MailsTo(team.Member.Email));
        await using (var db = server.NewDb())
        {
            var outcome = await db.MailOutbox.AsNoTracking().Where(m => m.UserId == team.Member.Id).Select(m => m.Outcome).SingleAsync();
            Assert.Equal(MailOutcomes.Skipped, outcome);
        }

        // Read after it was queued and before it went: still nothing.
        var again = await TeamAsync();
        await Mention(again);
        var (queue, send) = Jobs(At(PastDelay));
        await Run(queue);
        Assert.Equal(HttpStatusCode.OK, (await again.Member.Client.PostAsJsonAsync("/api/v1/account/notifications/read", new { all = true })).StatusCode);
        await Run(send);
        Assert.Empty(MailsTo(again.Member.Email));
    }

    [Fact]
    public async Task With_mail_off_nothing_is_sent_and_turning_it_on_mails_only_what_comes_after()
    {
        var team = await TeamAsync();
        await Set(team.Member.Client, "off");
        await Mention(team, text: "While off ");
        await Mail(At(PastDelay));
        Assert.Empty(MailsTo(team.Member.Email));
        await using (var db = server.NewDb())
            Assert.False(await db.MailOutbox.AnyAsync(m => m.UserId == team.Member.Id));
        await Set(team.Member.Client, "on");
        await Mail(At(PastDelay * 2));
        Assert.Empty(MailsTo(team.Member.Email));
        await Mention(team, text: "After ");
        await Mail(At(PastDelay * 3));
        var mail = Assert.Single(MailsTo(team.Member.Email));
        Assert.Contains("After @", mail.TextBody);
        Assert.DoesNotContain("While off", mail.TextBody);
    }

    private async Task<string?> OutcomeOf(Guid userId)
    {
        await using var db = server.NewDb();
        return await db.MailOutbox.AsNoTracking().Where(m => m.UserId == userId).Select(m => m.Outcome).SingleAsync();
    }

    [Fact]
    public async Task A_queued_mail_sends_nothing_made_before_mail_came_back_on_or_past_the_age_limit()
    {
        // Queued; then mail turned off and on again before it went: what it holds came before.
        var team = await TeamAsync();
        await Mention(team, text: "Before the turn ");
        var (queue, send) = Jobs(At(PastDelay));
        await Run(queue);
        await Set(team.Member.Client, "off");
        await Set(team.Member.Client, "on");
        await Run(send);
        Assert.Empty(MailsTo(team.Member.Email));
        Assert.Equal(MailOutcomes.Skipped, await OutcomeOf(team.Member.Id));
        // And it is not mailed later either.
        await Mail(At(PastDelay * 3));
        Assert.Empty(MailsTo(team.Member.Email));

        // Queued, and not sent until past the age limit (the cap held it, or its retries ran on).
        var late = await TeamAsync();
        await Mention(late, text: "Long ago ");
        var (lateQueue, _) = Jobs(At(PastDelay));
        await Run(lateQueue);
        var (_, lateSend) = Jobs(At(MailSettingsOptions.MaxAge + TimeSpan.FromHours(1)));
        await Run(lateSend);
        Assert.Empty(MailsTo(late.Member.Email));
        Assert.Equal(MailOutcomes.Skipped, await OutcomeOf(late.Member.Id));
    }

    /// <summary>The raw mails to an address, as written to the pickup folder.</summary>
    private List<string> RawMailsTo(string address) =>
        server.MailFiles().Where(f => MimeMessage.Load(f) is var m && m.To.Mailboxes.Any(b => string.Equals(b.Address, address, StringComparison.OrdinalIgnoreCase))
            && m.Headers.Contains("List-Unsubscribe")).Select(File.ReadAllText).ToList();

    [Fact]
    public async Task A_name_or_title_with_line_breaks_cannot_add_a_header()
    {
        // Nothing the app makes holds a line break in a title or a name; set here by SQL.
        var team = await TeamAsync();
        var arabic = await TeamAsync("منى", "الميزانية");
        Assert.Equal(HttpStatusCode.NoContent, (await arabic.Member.Client.PatchAsJsonAsync("/api/v1/account/me", new { locale = "ar" })).StatusCode);
        await using (var db = server.NewDb())
        {
            await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).Where(p => p.Id == team.Page)
                .ExecuteUpdateAsync(x => x.SetProperty(p => p.Title, "Budget\r\nBcc: x@example.com"));
            await db.Users.Where(u => u.Id == team.Ws.Account.Id)
                .ExecuteUpdateAsync(x => x.SetProperty(u => u.DisplayName, "Olive\r\nBcc: y@example.com"));
            await db.Pages.IgnoreQueryFilters([CgwDb.Tenant]).Where(p => p.Id == arabic.Page)
                .ExecuteUpdateAsync(x => x.SetProperty(p => p.Title, "الميزانية\nBcc: z@example.com\rX-Injected: 1"));
        }
        await Mention(team);
        await Mention(arabic, text: "راجعي الأرقام ");
        await Mail(At(PastDelay));

        foreach (var (address, subject) in new[]
        {
            (team.Member.Email, "Olive Bcc: y@example.com mentioned you in a comment on “Budget Bcc: x@example.com”"),
            (arabic.Member.Email, "أشار إليك Olive Owner في تعليق على «الميزانية Bcc: z@example.com X-Injected: 1»"),
        })
        {
            var raw = Assert.Single(RawMailsTo(address));
            var headers = raw[..raw.IndexOf("\r\n\r\n", StringComparison.Ordinal)];
            // Header lines, a folded line's continuation joined to its header.
            var names = Regex.Split(headers, "\r\n(?![ \t])").Select(h => h[..Math.Max(0, h.IndexOf(':'))]).ToList();
            Assert.Single(names, n => n.Equals("Subject", StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(names, n => n.Equals("Bcc", StringComparison.OrdinalIgnoreCase) || n.Equals("X-Injected", StringComparison.OrdinalIgnoreCase));
            var mail = MimeMessage.Load(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(raw)));
            Assert.Empty(mail.Bcc);
            Assert.Equal(address, Assert.Single(mail.To.Mailboxes).Address);
            Assert.Equal(subject, mail.Subject);
        }
    }

    [Fact]
    public async Task The_unsubscribe_token_turns_off_its_own_account_once_and_a_forged_or_replayed_one_does_nothing()
    {
        var mo = await TeamAsync();
        var pat = await TeamAsync("Pat Member");
        await Mention(mo);
        await Mention(pat);
        await Mail(At(PastDelay));
        var moToken = Token(Assert.Single(MailsTo(mo.Member.Email)));
        var patToken = Token(Assert.Single(MailsTo(pat.Member.Email)));
        var anonymous = server.Anonymous();

        // Forged, cut, empty: the same answer, nothing changes.
        foreach (var forged in new[] { "garbage", moToken[..^4] + "AAAA", "", moToken.ToUpperInvariant() })
        {
            var answer = await anonymous.PostAsJsonAsync("/api/v1/mail/unsubscribe", new { token = forged });
            Assert.Equal(HttpStatusCode.NoContent, answer.StatusCode);
        }
        Assert.Equal("on", await Setting(mo.Member.Client));
        // The page the link opens changes nothing until its button is pressed.
        var page = await anonymous.GetAsync($"/mail/unsubscribe?token={Uri.EscapeDataString(moToken)}&lang=ar");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.Contains("dir=\"rtl\"", await page.Content.ReadAsStringAsync());
        Assert.Equal("on", await Setting(mo.Member.Client));

        // Another account's token turns off that account only.
        Assert.Equal(HttpStatusCode.NoContent, (await anonymous.PostAsJsonAsync("/api/v1/mail/unsubscribe", new { token = patToken })).StatusCode);
        Assert.Equal("off", await Setting(pat.Member.Client));
        Assert.Equal("on", await Setting(mo.Member.Client));

        // One click, as a mail client posts it (RFC 8058): off, without signing in.
        var click = await anonymous.PostAsync($"/mail/unsubscribe?token={Uri.EscapeDataString(moToken)}",
            new FormUrlEncodedContent([KeyValuePair.Create("List-Unsubscribe", "One-Click")]));
        Assert.Equal(HttpStatusCode.OK, click.StatusCode);
        Assert.Equal("off", await Setting(mo.Member.Client));
        // Turned on again in the app: the old mail's token no longer turns it off.
        await Set(mo.Member.Client, "on");
        var replay = await anonymous.PostAsync($"/mail/unsubscribe?token={Uri.EscapeDataString(moToken)}",
            new FormUrlEncodedContent([KeyValuePair.Create("List-Unsubscribe", "One-Click")]));
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Equal((await click.Content.ReadAsStringAsync()).Length, (await replay.Content.ReadAsStringAsync()).Length);
        Assert.Equal("on", await Setting(mo.Member.Client));
        // A forged token answers the page the real one did.
        var forgedClick = await anonymous.PostAsync("/mail/unsubscribe?token=garbage", new FormUrlEncodedContent([KeyValuePair.Create("List-Unsubscribe", "One-Click")]));
        Assert.Equal(HttpStatusCode.OK, forgedClick.StatusCode);
    }

    [Fact]
    public async Task A_digest_goes_once_a_day_with_everything_waiting()
    {
        var team = await TeamAsync();
        await Set(team.Member.Client, "digest");
        await Mention(team, text: "Morning ");
        await Mention(team, text: "Noon ");
        // Not after the delay: a day from choosing the digest.
        await Mail(At(PastDelay));
        Assert.Empty(MailsTo(team.Member.Email));
        await Mail(At(TimeSpan.FromDays(1) + TimeSpan.FromMinutes(1)));
        var digest = Assert.Single(MailsTo(team.Member.Email));
        Assert.Equal("Your daily summary: 2 mentions and replies", digest.Subject);
        Assert.Contains("Since your last summary:", digest.TextBody);
        await Mention(team, text: "Evening ");
        await Mail(At(TimeSpan.FromDays(1) + TimeSpan.FromHours(2)));
        Assert.Single(MailsTo(team.Member.Email));
        await Mail(At(TimeSpan.FromDays(2) + TimeSpan.FromMinutes(2)));
        Assert.Equal(2, MailsTo(team.Member.Email).Count);
    }

    [Fact]
    public async Task The_daily_cap_holds_mail_back_until_the_day_has_room()
    {
        var team = await TeamAsync();
        await Mention(team);
        var clock = At(PastDelay);
        var (queue, _) = Jobs(clock);
        await Run(queue);
        int sent;
        await using (var db = server.NewDb())
        {
            var day = clock.GetUtcNow() - TimeSpan.FromDays(1);
            sent = await db.MailOutbox.CountAsync(m => m.SentAt != null && m.SentAt > day);
        }
        // The cap reached: nothing goes, the mail waits in the queue.
        await Run(Jobs(clock, cap: sent).Send);
        Assert.Empty(MailsTo(team.Member.Email));
        await using (var db = server.NewDb())
            Assert.Null(await db.MailOutbox.Where(m => m.UserId == team.Member.Id).Select(m => m.Outcome).SingleAsync());
        await Run(Jobs(clock, cap: sent + 1000).Send);
        Assert.Single(MailsTo(team.Member.Email));
    }

    [Fact]
    public async Task A_failed_send_is_tried_again_later_and_logged_without_the_mail()
    {
        var team = await TeamAsync("Faye Failing", "Secret plans");
        await Mention(team);
        var clock = new MovableClock();
        clock.Advance(PastDelay);
        await Run(Jobs(clock).Queue);
        // A mail server that is not there.
        var broken = new Mailer(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Smtp:Host"] = "127.0.0.1",
            ["Smtp:Port"] = "9",
        }).Build(), server.Worker.GetRequiredService<ILogger<Mailer>>());
        var log = new ListLogger<MailSendJob>();
        await Run(Jobs(clock, mailer: broken, log: log).Send);
        await using (var db = server.NewDb())
        {
            var mail = await db.MailOutbox.AsNoTracking().SingleAsync(m => m.UserId == team.Member.Id);
            Assert.Null(mail.Outcome);
            Assert.Equal(1, mail.Attempts);
            // A minute from the attempt (a refused connection takes a moment on Windows).
            Assert.Equal(clock.GetUtcNow() + TimeSpan.FromMinutes(1), mail.NextAttemptAt, TimeSpan.FromSeconds(15));
            Assert.False(string.IsNullOrEmpty(mail.LastError));
        }
        Assert.Contains(log.Lines, l => l.Contains("was not sent (attempt 1 of 6)"));
        Assert.DoesNotContain(log.Lines, l => l.Contains(team.Member.Email, StringComparison.OrdinalIgnoreCase) || l.Contains("Secret plans") || l.Contains("Olive"));
        // Not before its next attempt; then, with the server back, it goes.
        await Run(Jobs(clock).Send);
        Assert.Empty(MailsTo(team.Member.Email));
        clock.Advance(TimeSpan.FromMinutes(2));
        await Run(Jobs(clock).Send);
        Assert.Single(MailsTo(team.Member.Email));
    }
}

/// <summary>A logger that keeps what it is given, formatted.</summary>
public sealed class ListLogger<T> : ILogger<T>
{
    public List<string> Lines { get; } = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        lock (Lines) Lines.Add(formatter(state, exception) + (exception is null ? "" : " " + exception));
    }
}
