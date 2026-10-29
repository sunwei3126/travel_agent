using System.Text.Json;
using Pi.Durable.Harness;
using PiTravel.Server.AgUi;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;

namespace PiTravel.Server.Hosting.Endpoints;

/// <summary>
/// The AG-UI SSE route, mirroring <c>apps/server/src/http/routes/agui.ts</c>.
/// The watcher is attached before the message is submitted, so no
/// <c>run_start</c> or <c>run_end</c> can be missed, and the request token
/// aborts the watch when the client disconnects.
/// </summary>
public static class AguiEndpoints
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/agui", (HttpContext context, TravelService service, CancellationToken ct) =>
            StreamAsync(service, context, ct));
    }

    private static async Task StreamAsync(TravelService service, HttpContext context, CancellationToken ct)
    {
        var tripId = context.Request.Query["tripId"].ToString();
        if (tripId.Length == 0)
        {
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "tripId is required", ct);
            return;
        }

        RunInput? input;
        try
        {
            input = await context.Request.ReadFromJsonAsync<RunInput>(TripJson.Options, ct);
        }
        catch (JsonException)
        {
            input = null;
        }

        var runId = input?.RunId;
        if (string.IsNullOrEmpty(runId))
        {
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "runId is required", ct);
            return;
        }

        var content = LastUserText(input);
        if (content.Length == 0)
        {
            await WriteErrorAsync(
                context,
                StatusCodes.Status400BadRequest,
                "the last user message must not be empty",
                ct);
            return;
        }

        // Attach the watcher before submitting. The first item is the mount
        // snapshot, so the watch is registered before the run can start.
        var events = service.WatchEventsAsync(tripId, ct).GetAsyncEnumerator(ct);
        try
        {
            TripSnapshot snapshot;
            IReadOnlyList<TranscriptEntry> entries;
            bool initial;
            try
            {
                snapshot = await service.GetSnapshotAsync(tripId, ct);
                initial = await events.MoveNextAsync();
                await service.SubmitMessageAsync(tripId, content, runId, ct);
                entries = (await service.GetTranscriptAsync(tripId, ct)).ToList();
                var last = entries.Count == 0 ? null : entries[^1];
                if (last?.Role != "user" || last.Content != content)
                {
                    entries = entries.Append(new TranscriptEntry
                    {
                        Id = $"pending-user-{runId}",
                        Role = "user",
                        Content = content,
                    }).ToArray();
                }
            }
            catch (Exception error) when (NotFound.IsNotFound(error))
            {
                await WriteErrorAsync(context, StatusCodes.Status404NotFound, error.Message, ct);
                return;
            }

            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";

            var mapper = new PiEventMapper();
            var terminal = false;
            try
            {
                await WriteEventAsync(context, new RunStarted(tripId, runId), ct);
                var state = new TripState
                {
                    Brief = snapshot.Brief,
                    Plan = snapshot.Plan,
                    Sources = snapshot.Sources,
                    Research = new TripResearchState
                    {
                        SearchCount = snapshot.Research.SearchCount,
                        FetchCount = snapshot.Research.FetchCount,
                        SearchAttempts = snapshot.Research.SearchAttempts,
                        FetchAttempts = snapshot.Research.FetchAttempts,
                        Running = snapshot.Running,
                    },
                };
                foreach (var agUiEvent in SnapshotBuilder.Build(tripId, runId, entries, state))
                {
                    await WriteEventAsync(context, agUiEvent, ct);
                }

                var ended = initial && await ConsumeAsync(
                    service, tripId, events.Current, mapper, context, () => terminal = true, ct);
                while (!terminal && !ended && !ct.IsCancellationRequested)
                {
                    if (!await events.MoveNextAsync()) break;
                    ended = await ConsumeAsync(
                        service, tripId, events.Current, mapper, context, () => terminal = true, ct);
                }

                if (!ct.IsCancellationRequested && !terminal)
                {
                    await WriteEventAsync(context, new RunFinished(tripId, runId), ct);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // The client left. The watch token is the request token, so the
                // enumerator stops and exactly one abort reaches the service.
            }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                await WriteEventAsync(context, new RunError(error.Message), CancellationToken.None);
            }
        }
        finally
        {
            await events.DisposeAsync();
        }
    }

    private static async Task<bool> ConsumeAsync(
        TravelService service,
        string tripId,
        AgentEvent agentEvent,
        PiEventMapper mapper,
        HttpContext context,
        Action onError,
        CancellationToken ct)
    {
        try
        {
            if (agentEvent is AgentEvent.RunStart)
            {
                await service.ClearFaultsAsync(tripId, ct);
            }
            else if (agentEvent is AgentEvent.TaskFailed fault)
            {
                await service.RecordFaultAsync(
                    tripId,
                    new TripFault
                    {
                        Kind = string.IsNullOrEmpty(fault.Kind) ? "unknown" : fault.Kind,
                        Message = string.IsNullOrEmpty(fault.Message) ? "Task failed" : fault.Message,
                        TaskId = fault.TaskId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture),
                        At = DateTimeOffset.UtcNow.ToString(
                            "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                            System.Globalization.CultureInfo.InvariantCulture),
                    },
                    ct);
            }
        }
        catch
        {
            // Fault bookkeeping is best-effort, matching the TypeScript route.
        }

        var terminal = false;
        foreach (var agUiEvent in mapper.Map(agentEvent))
        {
            await WriteEventAsync(context, agUiEvent, ct);
            if (agUiEvent is RunError)
            {
                terminal = true;
                onError();
            }
        }

        return agentEvent is AgentEvent.RunEnd || terminal;
    }

    private static string LastUserText(RunInput? input)
    {
        if (input?.Messages is not { Count: > 0 } messages) return "";

        for (var index = messages.Count - 1; index >= 0; index--)
        {
            var message = messages[index];
            if (message.Role == "user") return (message.Content ?? "").Trim();
        }

        return "";
    }

    private static Task WriteErrorAsync(HttpContext context, int status, string error, CancellationToken ct)
    {
        context.Response.StatusCode = status;
        return context.Response.WriteAsJsonAsync(new { error }, TripJson.Options, ct);
    }

    private static Task WriteEventAsync(HttpContext context, AgUiEvent agUiEvent, CancellationToken ct) =>
        context.Response.WriteAsync($"data: {AgUiJson.Serialize(agUiEvent)}\n\n", ct);

    private sealed record RunInput(string? RunId, IReadOnlyList<RunMessage>? Messages);

    private sealed record RunMessage(string? Id, string? Role, string? Content);
}
