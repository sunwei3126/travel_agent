using PiTravel.Server.AgUi;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;
using PiTravel.Server.Hosting;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Hosting.Endpoints;

/// <summary>
/// Trip CRUD routes, mirroring <c>apps/server/src/http/routes/trips.ts</c>.
/// </summary>
public static class TripsEndpoints
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/api/trips", (TravelService service, CancellationToken ct) => service.ListTripsAsync(ct));

        app.MapPost("/api/trips", async (
            CreateTripBody? body,
            TravelService service,
            ServerConfig config,
            CancellationToken ct) =>
        {
            if (!TryValidateCreate(body, out var input, out var error))
            {
                return Results.Json(new { error }, TripJson.Options, statusCode: StatusCodes.Status400BadRequest);
            }

            var errors = BriefValidator.Validate(
                new TripBrief
                {
                    Destination = input.Destination,
                    StartDate = input.StartDate,
                    Days = input.Days,
                },
                config.Now(),
                requireComplete: false);
            if (errors.Count > 0)
            {
                return Results.Json(
                    new { error = string.Join("; ", errors) },
                    TripJson.Options,
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var entry = await service.CreateTripAsync(input, ct);
            return Results.Json(entry, TripJson.Options, statusCode: StatusCodes.Status201Created);
        });

        app.MapGet("/api/trips/{tripId}", async (string tripId, TravelService service, CancellationToken ct) =>
        {
            try
            {
                return Results.Ok(await service.GetSnapshotAsync(tripId, ct));
            }
            catch (Exception error) when (NotFound.IsNotFound(error))
            {
                return NotFound.Result(error);
            }
        });

        app.MapGet("/api/trips/{tripId}/transcript", async (string tripId, TravelService service, CancellationToken ct) =>
        {
            try
            {
                var entries = await service.GetTranscriptAsync(tripId, ct);
                return Results.Ok(AgUiMessages.FromTranscript(entries));
            }
            catch (Exception error) when (NotFound.IsNotFound(error))
            {
                return NotFound.Result(error);
            }
        });

        app.MapPost("/api/trips/{tripId}/messages", async (
            string tripId,
            MessageBody? body,
            TravelService service,
            CancellationToken ct) =>
        {
            if (body?.RequestId is not { Length: > 0 })
            {
                return Results.Json(
                    new { error = "requestId is required" },
                    TripJson.Options,
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if ((body.Content ?? "").Trim().Length == 0)
            {
                return Results.Json(
                    new { error = "content must not be empty" },
                    TripJson.Options,
                    statusCode: StatusCodes.Status400BadRequest);
            }

            try
            {
                var submissionId = await service.SubmitMessageAsync(tripId, body.Content ?? "", body.RequestId, ct);
                return Results.Json(new { submissionId }, TripJson.Options, statusCode: StatusCodes.Status202Accepted);
            }
            catch (Exception error) when (NotFound.IsNotFound(error))
            {
                return NotFound.Result(error);
            }
        });
    }

    private static bool TryValidateCreate(
        CreateTripBody? body,
        out CreateTripInput input,
        out string error)
    {
        input = null!;
        if (body is null
            || string.IsNullOrEmpty(body.Title)
            || string.IsNullOrEmpty(body.Destination)
            || body.StartDate is not { Length: 10 }
            || body.Days is not int days
            || days < 1)
        {
            error = "title, destination, startDate and days are required";
            return false;
        }

        input = new CreateTripInput(body.Title, body.Destination, body.StartDate, days);
        error = "";
        return true;
    }

    private sealed record CreateTripBody(string? Title, string? Destination, string? StartDate, int? Days);

    private sealed record MessageBody(string? Content, string? RequestId);
}
