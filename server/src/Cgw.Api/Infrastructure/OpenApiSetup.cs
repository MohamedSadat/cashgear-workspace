using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Cgw.Api.Infrastructure;

/// <summary>
/// Route parameters that only an endpoint filter reads (the workspace, page and asset ids the
/// membership filters check) are still part of the contract: each one in a route template is
/// declared as a required path parameter, a UUID unless it is a token.
/// </summary>
public sealed partial class RouteParameters : IOpenApiOperationTransformer
{
    public Task TransformAsync(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)
    {
        var template = context.Description.RelativePath ?? "";
        operation.Parameters ??= [];
        foreach (Match match in Names().Matches(template))
        {
            var name = match.Groups[1].Value;
            if (operation.Parameters.Any(p => p.Name == name && p.In == ParameterLocation.Path)) continue;
            operation.Parameters.Add(new OpenApiParameter
            {
                Name = name,
                In = ParameterLocation.Path,
                Required = true,
                Schema = name == "token"
                    ? new OpenApiSchema { Type = JsonSchemaType.String }
                    : new OpenApiSchema { Type = JsonSchemaType.String, Format = "uuid" },
            });
        }
        return Task.CompletedTask;
    }

    [GeneratedRegex(@"\{([A-Za-z]+)(?::[^}]*)?\}")]
    private static partial Regex Names();
}

/// <summary>
/// A request body a handler reads itself (Sheet's xlsx, a picture's PNG, Redeem's JSON read after
/// the <c>Origin</c> check). <c>Accepts</c> would let routing refuse another content type with a
/// 415 before the handler runs, and outside the route's CORS policy; this only documents it.
/// </summary>
public sealed record DocumentedBody(string ContentType, Type? Json = null);

public sealed class DocumentedBodies : IOpenApiOperationTransformer
{
    public async Task TransformAsync(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)
    {
        if (context.Description.ActionDescriptor.EndpointMetadata.OfType<DocumentedBody>().FirstOrDefault() is not { } body) return;
        var schema = body.Json is { } type
            ? await context.GetOrCreateSchemaAsync(type, null, ct)
            : new OpenApiSchema { Type = JsonSchemaType.String, Format = "binary" };
        operation.RequestBody = new OpenApiRequestBody
        {
            Required = true,
            Content = new Dictionary<string, OpenApiMediaType> { [body.ContentType] = new() { Schema = schema } },
        };
    }
}

/// <summary>
/// A collection property whose items are a nullable reference type (<c>IReadOnlyList&lt;string?&gt;</c>:
/// the import's columns, null for a column not imported) has nullable items in the document; the
/// generator reads only the property's own nullability.
/// </summary>
public sealed class NullableItems : IOpenApiSchemaTransformer
{
    private readonly NullabilityInfoContext nullability = new();

    public Task TransformAsync(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)
    {
        if (context.JsonPropertyInfo?.AttributeProvider is not PropertyInfo property
            || schema.Items is not OpenApiSchema items || items.Type is not { } type)
            return Task.CompletedTask;
        NullabilityInfo info;
        lock (nullability) info = nullability.Create(property);
        var item = info.ElementType ?? (info.GenericTypeArguments is [var only] ? only : null);
        if (item?.ReadState == NullabilityState.Nullable) items.Type = type | JsonSchemaType.Null;
        return Task.CompletedTask;
    }
}
