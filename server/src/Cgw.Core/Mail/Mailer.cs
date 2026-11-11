using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MimeKit;

namespace Cgw.Core.Mail;

public sealed record MailMessage(string To, string Subject, string Text, string Html);

/// <summary>
/// Sign-up confirmation, password reset and invites (Q8). SMTP settings come from the environment
/// (<c>Smtp__Host</c>, <c>Smtp__Port</c>, <c>Smtp__User</c>, <c>Smtp__Password</c>,
/// <c>Smtp__From</c>); with <c>Smtp__PickupDirectory</c> set, mail is written there as .eml files
/// instead (development and tests).
/// </summary>
public sealed class Mailer(IConfiguration configuration, ILogger<Mailer> logger)
{
    private readonly IConfigurationSection smtp = configuration.GetSection("Smtp");

    public async Task SendAsync(MailMessage message, CancellationToken ct = default)
    {
        var mime = new MimeMessage();
        mime.From.Add(MailboxAddress.Parse(smtp["From"] ?? "Cash Gear Workspace <no-reply@cashgearerp.com>"));
        mime.To.Add(MailboxAddress.Parse(message.To));
        mime.Subject = message.Subject;
        mime.Body = new BodyBuilder { TextBody = message.Text, HtmlBody = message.Html }.ToMessageBody();

        var pickup = smtp["PickupDirectory"];
        if (!string.IsNullOrEmpty(pickup))
        {
            Directory.CreateDirectory(pickup);
            var file = Path.Combine(pickup, $"{DateTimeOffset.UtcNow:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}.eml");
            await mime.WriteToAsync(file, ct);
            logger.LogInformation("Mail to the pickup folder: {Subject}", message.Subject);
            return;
        }
        var host = smtp["Host"];
        if (string.IsNullOrEmpty(host))
            throw new InvalidOperationException("Mail is not configured: set Smtp__Host or Smtp__PickupDirectory.");
        using var client = new SmtpClient();
        var port = int.TryParse(smtp["Port"], out var p) ? p : 587;
        await client.ConnectAsync(host, port, port == 465 ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTls, ct);
        if (smtp["User"] is { Length: > 0 } user) await client.AuthenticateAsync(user, smtp["Password"] ?? "", ct);
        await client.SendAsync(mime, ct);
        await client.DisconnectAsync(true, ct);
    }
}
