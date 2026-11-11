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
