using System.Globalization;
using System.Threading.Channels;
using Cgw.Core.Mail;
using Microsoft.Extensions.Caching.Memory;

namespace Cgw.Api.Infrastructure;

public sealed record QueuedMail(string Kind, MailMessage Message);

/// <summary>
/// Mail goes out after the answer (Q8), drained by <see cref="MailSender"/>: how long a sign-up,
/// a "forgot" or an invite takes says nothing about whether the address has an account, and a slow
/// mail server does not hold a request. The queue is in memory: a mail queued when the process
/// stops is lost, and the person asks again.
/// </summary>
public sealed class MailQueue(ILogger<MailQueue> logger)
{
    private readonly Channel<QueuedMail> channel = Channel.CreateBounded<QueuedMail>(
        new BoundedChannelOptions(10_000) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });

    public ChannelReader<QueuedMail> Reader => channel.Reader;

    public void Enqueue(string kind, MailMessage message)
    {
        if (!channel.Writer.TryWrite(new QueuedMail(kind, message)))
            logger.LogWarning("The mail queue is full; a {Kind} mail was dropped", kind);
    }
}

/// <summary>
/// Sends what <see cref="MailQueue"/> holds, one at a time. Each mail is logged by kind only, sent
/// or not: the message holds a link with a token, and the address is the person's.
/// </summary>
public sealed class MailSender(MailQueue queue, Mailer mailer, ILogger<MailSender> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var mail in queue.Reader.ReadAllAsync(stoppingToken))
            {
                try
                {
                    await mailer.SendAsync(mail.Message, stoppingToken);
                    logger.LogInformation("A {Kind} mail was sent", mail.Kind);
                }
                catch (Exception e) when (e is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                {
                    logger.LogError("A {Kind} mail was not sent: {Failure}", mail.Kind, $"{e.GetType().Name}: {e.Message}");
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }
}

/// <summary>
/// At most one account mail (confirmation, already registered, password reset) per address in a
/// window (<c>Mail__CooldownSeconds</c>, 120 by default), keyed by the normalised address and kept
/// in memory. A mail inside the window is skipped and the answer stays the same.
/// </summary>
public sealed class MailCooldown(IMemoryCache cache, IConfiguration configuration)
{
    private readonly TimeSpan window = TimeSpan.FromSeconds(
        int.TryParse(configuration["Mail:CooldownSeconds"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds) ? seconds : 120);

    private readonly Lock gate = new();

    /// <summary>True when a mail to the address may go now; the window then starts.</summary>
    public bool Take(string normalisedAddress)
    {
        if (window <= TimeSpan.Zero) return true;
        var key = ("mail.cooldown", normalisedAddress);
        lock (gate)
        {
            if (cache.TryGetValue(key, out _)) return false;
            cache.Set(key, true, window);
            return true;
        }
    }
}
