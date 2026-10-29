using System.Text.Json;
using System.Text.Json.Serialization;

namespace PiTravel.Server.Contracts;

/// <summary>
/// Serializer settings for the shared trip contract: camelCase keys and optional
/// fields omitted rather than written as <c>null</c>.
/// </summary>
public static class TripJson
{
    public static JsonSerializerOptions Options { get; } = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
