using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.WebUtilities;

namespace Cgw.Tests;

/// <summary>
/// A passkey authenticator in software, answering WebAuthn as a browser and its platform
/// authenticator do (Phase 11, M11.2): ES256 keys on P-256, attestation <c>none</c>, discoverable
/// credentials, the client data JSON a browser writes. It reads the options the API's pages hand
/// out (WebAuthn's JSON forms) and writes the JSON a page's script posts back. Every part of an
/// answer can be made wrong on purpose (<see cref="Tweaks"/>), for the server's refusals. For the
/// passkey tests, single sign-on's (S3) and the sign-in benchmark.
/// </summary>
public sealed class SoftwareAuthenticator
{
    /// <summary>One credential the authenticator holds.</summary>
    public sealed class Passkey
    {
        public required byte[] Id { get; init; }
        public required ECDsa Key { get; init; }
        /// <summary>The user handle the creation's options named (the account's id, as UTF-8).</summary>
        public required byte[] UserHandle { get; init; }
        public required string RpId { get; init; }
        public uint SignCount { get; set; }
        public string IdText => WebEncoders.Base64UrlEncode(Id);
    }

    /// <summary>What to make wrong (or say differently) in one answer.</summary>
    public sealed record Tweaks
    {
        /// <summary>The client data's origin (the authenticator's own <see cref="Origin"/> otherwise).</summary>
        public string? Origin { get; init; }
        /// <summary>The relying party whose id the authenticator data hashes (the options' otherwise).</summary>
        public string? RpId { get; init; }
        public bool UserVerified { get; init; } = true;
        public bool UserPresent { get; init; } = true;
        /// <summary>The client data's type (<c>webauthn.create</c> or <c>webauthn.get</c> otherwise).</summary>
        public string? Type { get; init; }
        public bool CrossOrigin { get; init; }
        public string? TopOrigin { get; init; }
        /// <summary>The client data's challenge, base64url (the options' otherwise).</summary>
        public string? Challenge { get; init; }
        /// <summary>The signature counter to answer with (the last one plus <see cref="CounterStep"/> otherwise).</summary>
        public uint? SignCount { get; init; }
        /// <summary>The credential to answer with (else the first the options allow).</summary>
        public Passkey? Use { get; init; }
        /// <summary>A key to sign with that is not the credential's.</summary>
        public ECDsa? SignWith { get; init; }
        /// <summary>A credential id to make (else 16 random bytes).</summary>
        public byte[]? CredentialId { get; init; }
        /// <summary>The user handle to answer with (else the credential's).</summary>
        public byte[]? UserHandle { get; init; }
    }

    public List<Passkey> Passkeys { get; } = [];

    /// <summary>The origin of the page the ceremonies run on, as a browser names it.</summary>
    public string Origin { get; set; } = "https://localhost";

    /// <summary>How the counter moves at each assertion (0: always 0, as synced passkeys answer).</summary>
    public uint CounterStep { get; set; } = 1;

    /// <summary><c>navigator.credentials.create</c>: a new credential for the options, and the JSON a page posts back.</summary>
    public (string Json, Passkey Passkey) Create(string optionsJson, Tweaks? tweaks = null)
    {
        tweaks ??= new Tweaks();
        using var document = JsonDocument.Parse(optionsJson);
        var options = document.RootElement;
        if (!options.GetProperty("pubKeyCredParams").EnumerateArray().Any(p => p.GetProperty("alg").GetInt32() == -7))
            throw new InvalidOperationException("The options do not offer ES256.");
        var rpId = tweaks.RpId ?? options.GetProperty("rp").GetProperty("id").GetString()!;
        var challenge = tweaks.Challenge ?? options.GetProperty("challenge").GetString()!;
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var passkey = new Passkey
        {
            Id = tweaks.CredentialId ?? RandomNumberGenerator.GetBytes(16),
            Key = key,
            UserHandle = WebEncoders.Base64UrlDecode(options.GetProperty("user").GetProperty("id").GetString()!),
            RpId = options.GetProperty("rp").GetProperty("id").GetString()!,
            SignCount = tweaks.SignCount ?? 0,
        };

        var point = key.ExportParameters(includePrivateParameters: false).Q;
        var coseKey = Cbor.Map((Cbor.Int(1), Cbor.Int(2)), (Cbor.Int(3), Cbor.Int(-7)), (Cbor.Int(-1), Cbor.Int(1)), (Cbor.Int(-2), Cbor.Bytes(point.X!)), (Cbor.Int(-3), Cbor.Bytes(point.Y!)));
        var authenticatorData = Concat(
            SHA256.HashData(Encoding.UTF8.GetBytes(rpId)),
            [Flags(tweaks, attested: true)],
            BigEndian(passkey.SignCount),
            new byte[16], // AAGUID: none is told with attestation "none"
            [(byte)(passkey.Id.Length >> 8), (byte)passkey.Id.Length],
            passkey.Id,
            coseKey);
        var attestationObject = Cbor.Map(
            (Cbor.Text("fmt"), Cbor.Text("none")),
            (Cbor.Text("attStmt"), Cbor.Map()),
            (Cbor.Text("authData"), Cbor.Bytes(authenticatorData)));
        var clientData = ClientData(tweaks.Type ?? "webauthn.create", challenge, tweaks);

        var json = new JsonObject
        {
            ["id"] = passkey.IdText,
            ["rawId"] = passkey.IdText,
            ["type"] = "public-key",
            ["response"] = new JsonObject
            {
                ["clientDataJSON"] = WebEncoders.Base64UrlEncode(clientData),
                ["attestationObject"] = WebEncoders.Base64UrlEncode(attestationObject),
                ["authenticatorData"] = WebEncoders.Base64UrlEncode(authenticatorData),
                ["transports"] = new JsonArray("internal"),
                ["publicKey"] = WebEncoders.Base64UrlEncode(key.ExportSubjectPublicKeyInfo()),
                ["publicKeyAlgorithm"] = -7,
            },
            ["authenticatorAttachment"] = "platform",
            ["clientExtensionResults"] = new JsonObject { ["credProps"] = new JsonObject { ["rk"] = true } },
        };
        Passkeys.Add(passkey);
        return (json.ToJsonString(), passkey);
    }

    /// <summary><c>navigator.credentials.get</c>: an assertion for the options, and the JSON a page posts back.</summary>
    public string Get(string optionsJson, Tweaks? tweaks = null)
    {
        tweaks ??= new Tweaks();
        using var document = JsonDocument.Parse(optionsJson);
        var options = document.RootElement;
        var optionsRp = options.GetProperty("rpId").GetString()!;
        var challenge = tweaks.Challenge ?? options.GetProperty("challenge").GetString()!;
        var allowed = options.TryGetProperty("allowCredentials", out var allow) && allow.ValueKind == JsonValueKind.Array
            ? allow.EnumerateArray().Select(c => c.GetProperty("id").GetString()!).ToList()
            : [];
        var passkey = tweaks.Use
            ?? Passkeys.FirstOrDefault(p => p.RpId == optionsRp && (allowed.Count == 0 || allowed.Contains(p.IdText)))
            ?? throw new InvalidOperationException("The authenticator holds no passkey these options allow.");
        var rpId = tweaks.RpId ?? optionsRp;
        passkey.SignCount = tweaks.SignCount ?? passkey.SignCount + CounterStep;

        var authenticatorData = Concat(SHA256.HashData(Encoding.UTF8.GetBytes(rpId)), [Flags(tweaks, attested: false)], BigEndian(passkey.SignCount));
        var clientData = ClientData(tweaks.Type ?? "webauthn.get", challenge, tweaks);
        var signature = (tweaks.SignWith ?? passkey.Key).SignData(Concat(authenticatorData, SHA256.HashData(clientData)), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);

        return new JsonObject
        {
            ["id"] = passkey.IdText,
            ["rawId"] = passkey.IdText,
            ["type"] = "public-key",
            ["response"] = new JsonObject
            {
                ["clientDataJSON"] = WebEncoders.Base64UrlEncode(clientData),
                ["authenticatorData"] = WebEncoders.Base64UrlEncode(authenticatorData),
                ["signature"] = WebEncoders.Base64UrlEncode(signature),
                ["userHandle"] = WebEncoders.Base64UrlEncode(tweaks.UserHandle ?? passkey.UserHandle),
            },
            ["authenticatorAttachment"] = "platform",
            ["clientExtensionResults"] = new JsonObject(),
        }.ToJsonString();
    }

    private byte[] ClientData(string type, string challenge, Tweaks tweaks)
    {
        var data = new JsonObject
        {
            ["type"] = type,
            ["challenge"] = challenge,
            ["origin"] = tweaks.Origin ?? Origin,
            ["crossOrigin"] = tweaks.CrossOrigin,
        };
        if (tweaks.TopOrigin is not null) data["topOrigin"] = tweaks.TopOrigin;
        return Encoding.UTF8.GetBytes(data.ToJsonString());
    }

    /// <summary>UP, UV, and AT for a new credential (no backup: the credential is this device's alone).</summary>
    private static byte Flags(Tweaks tweaks, bool attested) =>
        (byte)((tweaks.UserPresent ? 0x01 : 0) | (tweaks.UserVerified ? 0x04 : 0) | (attested ? 0x40 : 0));

    private static byte[] BigEndian(uint value)
    {
        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, value);
        return bytes;
    }

    private static byte[] Concat(params byte[][] parts) => [.. parts.SelectMany(p => p)];

    /// <summary>The little of CBOR (RFC 8949) WebAuthn's objects need: integers, byte and text strings, maps; definite lengths, written in the order given.</summary>
    private static class Cbor
    {
        public static byte[] Int(long value) => value >= 0 ? Head(0, (ulong)value) : Head(1, (ulong)(-1 - value));

        public static byte[] Bytes(byte[] value) => [.. Head(2, (ulong)value.Length), .. value];

        public static byte[] Text(string value)
        {
            var utf8 = Encoding.UTF8.GetBytes(value);
            return [.. Head(3, (ulong)utf8.Length), .. utf8];
        }

        public static byte[] Map(params (byte[] Key, byte[] Value)[] entries) =>
            [.. Head(5, (ulong)entries.Length), .. entries.SelectMany(e => e.Key.Concat(e.Value))];

        private static byte[] Head(int major, ulong value)
        {
            var type = (byte)(major << 5);
            if (value < 24) return [(byte)(type | (byte)value)];
            if (value <= byte.MaxValue) return [(byte)(type | 24), (byte)value];
            if (value <= ushort.MaxValue) return [(byte)(type | 25), (byte)(value >> 8), (byte)value];
            return [(byte)(type | 26), (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value];
        }
    }
}

/// <summary>
/// The passkey ceremonies as the API's pages run them in a browser (their script's steps): open the
/// page, ask its options with the antiforgery header, answer with the authenticator, post the form.
/// </summary>
public static class PasskeyFlow
{
    /// <summary>The antiforgery token on a page.</summary>
    public static string Token(string html) =>
        WebUtility.HtmlDecode(Regex.Match(html, "name=\"__RequestVerificationToken\" value=\"([^\"]+)\"").Groups[1].Value);

    /// <summary>A ceremony's options, as the script asks for them.</summary>
    public static async Task<HttpResponseMessage> AskOptions(HttpClient client, string url, string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.Add("X-CSRF-TOKEN", token);
        return await client.SendAsync(request);
    }

    public static async Task<string> Options(HttpClient client, string url, string token)
    {
        var response = await AskOptions(client, url, token);
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{url}: {(int)response.StatusCode} {body}");
        return body;
    }

    public static FormUrlEncodedContent Form(string token, string credential, string? returnUrl = null, params (string Name, string Value)[] more)
    {
        var fields = new Dictionary<string, string>
        {
            ["__RequestVerificationToken"] = token,
            ["ReturnUrl"] = returnUrl ?? "",
            ["Lang"] = "en",
            ["Credential"] = credential,
        };
        foreach (var (name, value) in more) fields[name] = value;
        return new FormUrlEncodedContent(fields);
    }

    /// <summary>
    /// Adds a passkey on /account/passkeys/new (the session signed in, or proved itself again,
    /// within ten minutes). A redirect to <paramref name="returnUrl"/> when it is added.
    /// </summary>
    public static async Task<HttpResponseMessage> Add(HttpClient client, SoftwareAuthenticator authenticator, string? name = null, string? returnUrl = null, SoftwareAuthenticator.Tweaks? tweaks = null)
    {
        var page = await client.GetAsync("/account/passkeys/new" + (returnUrl is null ? "" : "?return=" + Uri.EscapeDataString(returnUrl)));
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var token = Token(await page.Content.ReadAsStringAsync());
        var (json, _) = authenticator.Create(await Options(client, "/account/passkey/creation-options", token), tweaks);
        return await client.PostAsync("/account/passkeys/new", Form(token, json, returnUrl, ("Name", name ?? "")));
    }

    /// <summary>Adds one and checks it was (to the app's settings, as Settings opens the page).</summary>
    public static async Task<SoftwareAuthenticator.Passkey> AddOk(HttpClient client, SoftwareAuthenticator authenticator, string? name = null)
    {
        var added = await Add(client, authenticator, name, "http://localhost:5273/#/settings/account");
        Assert.True(added.StatusCode == HttpStatusCode.Redirect, await added.Content.ReadAsStringAsync());
        return authenticator.Passkeys[^1];
    }

    /// <summary>
    /// "Sign in with a passkey" on /account/signin: a redirect on to <paramref name="returnUrl"/>
    /// (the app, or the desktop's /connect/authorize) when signed in, else the page again saying
    /// why. Signed in, the client gets its antiforgery header, as <see cref="ServerFixture.SignIn"/> does.
    /// </summary>
    public static async Task<HttpResponseMessage> SignIn(HttpClient client, SoftwareAuthenticator authenticator, string? returnUrl = null, SoftwareAuthenticator.Tweaks? tweaks = null)
    {
        var page = await (await client.GetAsync("/account/signin" + (returnUrl is null ? "" : "?returnUrl=" + Uri.EscapeDataString(returnUrl)))).Content.ReadAsStringAsync();
        var token = Token(page);
        var json = authenticator.Get(await Options(client, "/account/passkey/request-options?for=signin", token), tweaks);
        var response = await client.PostAsync("/account/signin/passkey", Form(token, json, returnUrl));
        if (response.StatusCode == HttpStatusCode.Redirect)
        {
            var csrf = await client.GetFromJsonAsync<JsonElement>("/api/v1/account/antiforgery");
            client.DefaultRequestHeaders.Remove("X-CSRF-TOKEN");
            client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", csrf.GetProperty("token").GetString());
        }
        return response;
    }

    /// <summary>A passkey asked again on a page of the signed-in account (<c>for=confirm</c>), posted to <paramref name="action"/>.</summary>
    public static async Task<HttpResponseMessage> Confirm(HttpClient client, SoftwareAuthenticator authenticator, string pageUrl, string action, SoftwareAuthenticator.Tweaks? tweaks = null)
    {
        var page = await client.GetAsync(pageUrl);
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var token = Token(await page.Content.ReadAsStringAsync());
        var json = authenticator.Get(await Options(client, "/account/passkey/request-options?for=confirm", token), tweaks);
        return await client.PostAsync(action, Form(token, json));
    }
}
