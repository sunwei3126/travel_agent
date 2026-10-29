namespace PiTravel.Server.Hosting.Endpoints;

/// <summary>
/// Maps the service's unknown-trip errors to HTTP 404, mirroring
/// <c>isNotFoundError</c> in <c>apps/server/src/http/routes/trips.ts</c>.
/// </summary>
internal static class NotFound
{
    public static bool IsNotFound(Exception error) =>
        error.Message.StartsWith("Trip not found:", StringComparison.Ordinal)
        || error.Message.StartsWith("Conversation not found:", StringComparison.Ordinal);

    public static IResult Result(Exception error) =>
        Results.Json(new { error = error.Message }, statusCode: StatusCodes.Status404NotFound);
}
