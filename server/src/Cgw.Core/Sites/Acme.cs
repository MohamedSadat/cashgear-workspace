using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cgw.Core.Sites;

/// <summary>
/// An ACME problem (RFC 8555, 6.7): the last part of its type (<c>badNonce</c>, <c>rateLimited</c>,
/// <c>incorrectResponse</c>, <c>connection</c>, <c>userActionRequired</c>...), its detail, the answer's
/// status and any <c>Retry-After</c>; <c>unreachable</c> when the directory could not be asked at all.
/// </summary>
public sealed class AcmeException(string type, string detail, HttpStatusCode? status = null, TimeSpan? retryAfter = null, Exception? inner = null)
    : Exception($"ACME {type}: {detail}", inner)
{
    public string Type { get; } = type;
    public HttpStatusCode? Status { get; } = status;
    public TimeSpan? RetryAfter { get; } = retryAfter;
}

/// <summary>A certificate made: the PFX under the store's password, its validity, its SHA-1 thumbprint.</summary>
public sealed record AcmeCertificate(byte[] Pfx, DateTimeOffset NotBefore, DateTimeOffset NotAfter, string Thumbprint);

/// <summary>
/// An ACME client (RFC 8555) for the worker (Phase 14, M14.4): an ES256 account, an order for one host
/// name proven by HTTP-01, a CSR made by .NET (RSA 2048), the chain downloaded and packed as a PFX for
/// the IIS host to bind (<c>deploy/iis/site-bindings.ps1</c>). Over <see cref="HttpClient"/>, no package. The key
/// authorisation to serve is handed to <c>publish</c> before the challenge is answered (the worker
/// writes it where the Sites process reads it) and taken back by <c>withdraw</c> when the order ends.
/// </summary>
public sealed class AcmeClient(HttpClient http, Uri directoryUrl, ECDsa accountKey, TimeProvider clock)
{
    /// <summary>How long an authorisation or an order is waited for before the order is given up.</summary>
    public static readonly TimeSpan PollLimit = TimeSpan.FromMinutes(2);

    private JsonObject? directory;
    private string? nonce;

    /// <summary>The account's URL (its <c>kid</c>), once made or found.</summary>
    public string? AccountUrl { get; set; }

    /// <summary>A new account key (P-256), for the first account of a directory.</summary>
    public static ECDsa NewAccountKey() => ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public static string Base64Url(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>The account key as a JWK, its members in the order RFC 7638 hashes them.</summary>
    private JsonObject Jwk()
    {
        var q = accountKey.ExportParameters(false).Q;
        return new JsonObject { ["crv"] = "P-256", ["kty"] = "EC", ["x"] = Base64Url(q.X), ["y"] = Base64Url(q.Y) };
    }

    /// <summary>RFC 7638's thumbprint of the account key: the SHA-256 of its canonical JWK, base64url.</summary>
    public string Thumbprint() => Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(Jwk().ToJsonString())));

    /// <summary>What HTTP-01 serves for a token (RFC 8555, 8.1).</summary>
    public string KeyAuthorization(string token) => token + "." + Thumbprint();

    private async Task<JsonObject> DirectoryAsync(CancellationToken ct)
    {
        if (directory is not null) return directory;
        try
        {
            using var response = await http.GetAsync(directoryUrl, ct);
            var text = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode) throw Problem(response, text);
            return directory = JsonNode.Parse(text) as JsonObject ?? throw new AcmeException("malformed", "The directory is not an object");
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new AcmeException("unreachable", "The ACME directory did not answer", inner: e);
        }
    }

    private async Task<string> Url(string name, CancellationToken ct) =>
        (await DirectoryAsync(ct))[name]?.GetValue<string>() ?? throw new AcmeException("malformed", $"The directory names no {name}");

    /// <summary>The terms of service the directory names, if it names any.</summary>
    public async Task<string?> TermsAsync(CancellationToken ct) => (await DirectoryAsync(ct))["meta"]?["termsOfService"]?.GetValue<string>();

    private async Task<string> NonceAsync(CancellationToken ct)
    {
        if (nonce is { } kept)
        {
            nonce = null;
            return kept;
        }
        using var request = new HttpRequestMessage(HttpMethod.Head, await Url("newNonce", ct));
        using var response = await http.SendAsync(request, ct);
        return response.Headers.TryGetValues("Replay-Nonce", out var values) ? values.First()
            : throw new AcmeException("badNonce", "The directory gave no nonce", response.StatusCode);
    }

    /// <summary>
    /// A signed POST (a POST-as-GET when <paramref name="payload"/> is null), by the account's
    /// <c>kid</c>, or by its <c>jwk</c> for a new account; a <c>badNonce</c> is tried once more.
    /// </summary>
    private async Task<(HttpResponseMessage Response, string Text)> PostAsync(string url, JsonNode? payload, CancellationToken ct, bool byKey = false, string? accept = null)
    {
        for (var attempt = 0; ; attempt++)
        {
            var header = new JsonObject { ["alg"] = "ES256", ["nonce"] = await NonceAsync(ct), ["url"] = url };
            if (byKey) header["jwk"] = Jwk();
            else header["kid"] = AccountUrl ?? throw new InvalidOperationException("No account yet.");
            var protectedPart = Base64Url(Encoding.UTF8.GetBytes(header.ToJsonString()));
            var payloadPart = payload is null ? "" : Base64Url(Encoding.UTF8.GetBytes(payload.ToJsonString()));
            var signature = accountKey.SignData(Encoding.ASCII.GetBytes(protectedPart + "." + payloadPart), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            var body = new JsonObject { ["protected"] = protectedPart, ["payload"] = payloadPart, ["signature"] = Base64Url(signature) };
            var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8) };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/jose+json");
            if (accept is not null) request.Headers.Accept.ParseAdd(accept);
            HttpResponseMessage response;
            try
            {
                response = await http.SendAsync(request, ct);
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                throw new AcmeException("unreachable", "The ACME server did not answer", inner: e);
            }
            if (response.Headers.TryGetValues("Replay-Nonce", out var fresh)) nonce = fresh.First();
            var text = await response.Content.ReadAsStringAsync(ct);
            if (response.IsSuccessStatusCode) return (response, text);
            var problem = Problem(response, text);
            response.Dispose();
            if (problem.Type == "badNonce" && attempt == 0) continue;
            throw problem;
        }
    }

    private static AcmeException Problem(HttpResponseMessage response, string text)
    {
        string type = "serverInternal", detail = $"The ACME server answered {(int)response.StatusCode}";
        try
        {
            if (JsonNode.Parse(text) is JsonObject problem)
            {
                var full = problem["type"]?.GetValue<string>() ?? "";
                const string prefix = "urn:ietf:params:acme:error:";
                type = full.StartsWith(prefix, StringComparison.Ordinal) ? full[prefix.Length..] : full.Length > 0 ? full : type;
                detail = problem["detail"]?.GetValue<string>() ?? detail;
            }
        }
        catch (JsonException)
        {
        }
        return new AcmeException(type.Length > 40 ? type[..40] : type, detail, response.StatusCode, RetryAfter(response));
    }

    private static TimeSpan? RetryAfter(HttpResponseMessage response) =>
        response.Headers.RetryAfter?.Delta ?? (response.Headers.RetryAfter?.Date is { } at ? at - DateTimeOffset.UtcNow : null);

    private static JsonObject Json(string text) => JsonNode.Parse(text) as JsonObject ?? throw new AcmeException("malformed", "The answer is not an object");

    /// <summary>The account for this key: made (agreeing to the terms, which the operator has done) or found.</summary>
    public async Task<string> AccountAsync(string? email, CancellationToken ct)
    {
        var payload = new JsonObject { ["termsOfServiceAgreed"] = true };
        if (email is { Length: > 0 }) payload["contact"] = new JsonArray("mailto:" + email);
        var (response, _) = await PostAsync(await Url("newAccount", ct), payload, ct, byKey: true);
        using (response)
            return AccountUrl = response.Headers.Location?.ToString() ?? throw new AcmeException("malformed", "The new account has no Location");
    }

    /// <summary>
    /// A certificate for <paramref name="host"/>: an order, HTTP-01 for each of its authorisations, the
    /// CSR, the chain, the PFX under <paramref name="password"/>.
    /// </summary>
    public async Task<AcmeCertificate> CertificateAsync(string host, string password, Func<string, string, Task> publish, Func<Task> withdraw, CancellationToken ct)
    {
        var identifiers = new JsonArray(new JsonObject { ["type"] = "dns", ["value"] = host });
        var (made, madeText) = await PostAsync(await Url("newOrder", ct), new JsonObject { ["identifiers"] = identifiers }, ct);
        string orderUrl;
        using (made) orderUrl = made.Headers.Location?.ToString() ?? throw new AcmeException("malformed", "The new order has no Location");
        var order = Json(madeText);
        try
        {
            foreach (var authorization in order["authorizations"]?.AsArray() ?? [])
                await AuthorizeAsync(authorization!.GetValue<string>(), publish, ct);
        }
        finally
        {
            await withdraw();
        }
        order = await PollAsync(orderUrl, s => s is "ready" or "valid" or "invalid", ct);
        if (order["status"]?.GetValue<string>() != "ready" && order["status"]?.GetValue<string>() != "valid")
            throw new AcmeException("orderInvalid", "The order was not made ready");

        using var key = RSA.Create(2048);
        if (order["status"]?.GetValue<string>() == "ready")
        {
            var request = new CertificateRequest(new X500DistinguishedName("CN=" + host), key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var names = new SubjectAlternativeNameBuilder();
            names.AddDnsName(host);
            request.CertificateExtensions.Add(names.Build());
            var finalize = order["finalize"]?.GetValue<string>() ?? throw new AcmeException("malformed", "The order has no finalize URL");
            var (finalized, _) = await PostAsync(finalize, new JsonObject { ["csr"] = Base64Url(request.CreateSigningRequest()) }, ct);
            finalized.Dispose();
            order = await PollAsync(orderUrl, s => s is "valid" or "invalid", ct);
        }
        var certificateUrl = order["status"]?.GetValue<string>() == "valid" ? order["certificate"]?.GetValue<string>() : null;
        if (certificateUrl is null) throw new AcmeException("orderInvalid", "The order gave no certificate");
        var (chainResponse, pem) = await PostAsync(certificateUrl, null, ct, accept: "application/pem-certificate-chain");
        chainResponse.Dispose();
        return Pack(pem, key, password);
    }

    /// <summary>The chain's leaf with its key and the rest beside it, as one PFX.</summary>
    public static AcmeCertificate Pack(string pem, RSA key, string password)
    {
        var blocks = new List<X509Certificate2>();
        const string begin = "-----BEGIN CERTIFICATE-----", end = "-----END CERTIFICATE-----";
        for (var at = pem.IndexOf(begin, StringComparison.Ordinal); at >= 0; at = pem.IndexOf(begin, at + 1, StringComparison.Ordinal))
        {
            var stop = pem.IndexOf(end, at, StringComparison.Ordinal);
            if (stop < 0) break;
            blocks.Add(X509Certificate2.CreateFromPem(pem.AsSpan(at, stop + end.Length - at)));
        }
        if (blocks.Count == 0) throw new AcmeException("malformed", "The certificate chain holds no certificate");
        try
        {
            using var leaf = blocks[0].CopyWithPrivateKey(key);
            var collection = new X509Certificate2Collection { leaf };
            collection.AddRange(blocks.Skip(1).ToArray());
            var pfx = collection.ExportPkcs12(Pkcs12ExportPbeParameters.Pbes2Aes256Sha256, password);
            return new AcmeCertificate(pfx, leaf.NotBefore.ToUniversalTime(), leaf.NotAfter.ToUniversalTime(), leaf.Thumbprint);
        }
        finally
        {
            foreach (var block in blocks) block.Dispose();
        }
    }

    private async Task AuthorizeAsync(string url, Func<string, string, Task> publish, CancellationToken ct)
    {
        var (response, text) = await PostAsync(url, null, ct);
        response.Dispose();
        var authz = Json(text);
        if (authz["status"]?.GetValue<string>() == "valid") return;
        var challenge = authz["challenges"]?.AsArray().OfType<JsonObject>().FirstOrDefault(c => c["type"]?.GetValue<string>() == "http-01")
            ?? throw new AcmeException("unsupported", "The authorisation offers no http-01 challenge");
        var token = challenge["token"]?.GetValue<string>() ?? throw new AcmeException("malformed", "The challenge has no token");
        await publish(token, KeyAuthorization(token));
        var (answered, _) = await PostAsync(challenge["url"]!.GetValue<string>(), new JsonObject(), ct);
        answered.Dispose();
        var done = await PollAsync(url, s => s is "valid" or "invalid" or "deactivated" or "expired" or "revoked", ct);
        if (done["status"]?.GetValue<string>() == "valid") return;
        var error = done["challenges"]?.AsArray().OfType<JsonObject>().Select(c => c["error"]).OfType<JsonObject>().FirstOrDefault();
        var type = error?["type"]?.GetValue<string>()?.Split(':').LastOrDefault() ?? "incorrectResponse";
        throw new AcmeException(type, error?["detail"]?.GetValue<string>() ?? "The challenge was not met");
    }

    /// <summary>An order's or an authorisation's object, asked again (as its <c>Retry-After</c> says, else each second) until <paramref name="done"/>.</summary>
    private async Task<JsonObject> PollAsync(string url, Func<string?, bool> done, CancellationToken ct)
    {
        var until = clock.GetUtcNow() + PollLimit;
        while (true)
        {
            var (response, text) = await PostAsync(url, null, ct);
            var wait = RetryAfter(response);
            response.Dispose();
            var item = Json(text);
            if (done(item["status"]?.GetValue<string>())) return item;
            if (clock.GetUtcNow() > until) throw new AcmeException("timeout", "The ACME server took too long");
            var pause = wait is { } w && w > TimeSpan.Zero ? (w > TimeSpan.FromSeconds(10) ? TimeSpan.FromSeconds(10) : w) : TimeSpan.FromSeconds(1);
            await Task.Delay(pause, clock, ct);
        }
    }
}
