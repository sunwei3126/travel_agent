using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Pi.Durable.Harness;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;
using PiTravel.Server.Hosting;

namespace PiTravel.Server.Tests.Hosting;

/// <summary>
/// Locks the trip and AG-UI endpoints to <c>apps/server/src/http/app.test.ts</c>.
/// The service is a scripted fake substituted through <see cref="Program.BuildApp"/>,
/// so none of these tests open a harness or a network connection.
/// </summary>
public sealed class EndpointTests : IAsyncDisposable
{
    private static readonly JsonSerializerOptions Json = TripJson.Options;

    private readonly List<WebApplication> _apps = [];

    public async ValueTask DisposeAsync()
    {
        foreach (var app in _apps)
        {
            await app.DisposeAsync();
        }
    }

    [Fact]
    public async Task HealthReturnsOk()
    {
        using var client = CreateClient(new FakeTravelService());

        var response = await client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""{"ok":true}""", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task CreateTripRejectsMissingFieldsWith400()
    {
        using var client = CreateClient(new FakeTravelService());

        var response = await client.PostAsJsonAsync(
            "/api/trips",
            new { title = "泰山" },
            Json);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("error", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task CreateTripRejectsImpossibleDateWith400()
    {
        using var client = CreateClient(new FakeTravelService());

        var response = await client.PostAsJsonAsync(
            "/api/trips",
            new { title = "泰山", destination = "泰山", startDate = "2026-02-30", days = 3 },
            Json);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("real calendar date", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task CreateTripReturns201WithIndexEntry()
    {
        using var client = CreateClient(new FakeTravelService());

        var created = await client.PostAsJsonAsync(
            "/api/trips",
            new { title = "泰山", destination = "泰山", startDate = "2026-10-26", days = 3 },
            Json);

        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var entry = await created.Content.ReadFromJsonAsync<TripIndexEntry>(Json);
        Assert.NotNull(entry);
        Assert.Equal("泰山", entry.Destination);
        Assert.Equal(3, entry.Days);

        var listed = await client.GetFromJsonAsync<TripIndexEntry[]>("/api/trips", Json);
        Assert.NotNull(listed);
        Assert.Single(listed);
        Assert.Equal(entry.TripId, listed[0].TripId);
    }

    [Fact]
    public async Task GetSnapshotReturns404ForUnknownTrip()
    {
        using var client = CreateClient(new FakeTravelService());

        var response = await client.GetAsync("/api/trips/missing");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("Trip not found", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task TranscriptReturnsAguiMessages()
    {
        var service = new FakeTravelService
        {
            Transcript =
            [
                new TranscriptEntry { Id = "r1", Role = "reasoning", Content = "想" },
                new TranscriptEntry { Id = "a1", Role = "assistant", Content = "你好" },
            ],
        };
        using var client = CreateClient(service);
        var tripId = await CreateTripAsync(client);

        var response = await client.GetAsync($"/api/trips/{tripId}/transcript");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var messages = JsonNode.Parse(await response.Content.ReadAsStringAsync())!.AsArray();
        Assert.Equal(2, messages.Count);
        Assert.Equal("reasoning", messages[0]!["role"]!.GetValue<string>());
        Assert.Equal("想", messages[0]!["content"]!.GetValue<string>());
        Assert.Equal("assistant", messages[1]!["role"]!.GetValue<string>());
        Assert.Equal("你好", messages[1]!["content"]!.GetValue<string>());

        var missing = await client.GetAsync("/api/trips/missing/transcript");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task MessagesRequiresRequestId()
    {
        using var client = CreateClient(new FakeTravelService());
        var tripId = await CreateTripAsync(client);

        var response = await client.PostAsJsonAsync(
            $"/api/trips/{tripId}/messages",
            new { content = "泰山三天" },
            Json);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task MessagesRejectsEmptyContentWith400()
    {
        using var client = CreateClient(new FakeTravelService());
        var tripId = await CreateTripAsync(client);

        var response = await client.PostAsJsonAsync(
            $"/api/trips/{tripId}/messages",
            new { content = "  ", requestId = "r1" },
            Json);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("content must not be empty", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task MessagesReturns202WithSubmissionId()
    {
        using var client = CreateClient(new FakeTravelService());
        var tripId = await CreateTripAsync(client);

        var first = await client.PostAsJsonAsync(
            $"/api/trips/{tripId}/messages",
            new { content = "泰山三天", requestId = "r1" },
            Json);
        var second = await client.PostAsJsonAsync(
            $"/api/trips/{tripId}/messages",
            new { content = "泰山三天", requestId = "r1" },
            Json);

        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, second.StatusCode);
        var firstId = (await first.Content.ReadFromJsonAsync<JsonObject>(Json))!["submissionId"]!
            .GetValue<string>();
        var secondId = (await second.Content.ReadFromJsonAsync<JsonObject>(Json))!["submissionId"]!
            .GetValue<string>();
        Assert.False(string.IsNullOrEmpty(firstId));
        Assert.Equal(firstId, secondId);

        var missing = await client.PostAsJsonAsync(
            "/api/trips/missing/messages",
            new { content = "泰山", requestId = "r1" },
            Json);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task AguiRequiresTripIdAndRunId()
    {
        using var client = CreateClient(new FakeTravelService());
        var tripId = await CreateTripAsync(client);
        var body = new { runId = "r1", messages = new[] { new { id = "m1", role = "user", content = "泰山" } } };

        var missingTrip = await client.PostAsJsonAsync("/agui", body, Json);
        Assert.Equal(HttpStatusCode.BadRequest, missingTrip.StatusCode);
        Assert.Contains("tripId is required", await missingTrip.Content.ReadAsStringAsync());

        var missingRun = await client.PostAsJsonAsync(
            $"/agui?tripId={tripId}",
            new { messages = body.messages },
            Json);
        Assert.Equal(HttpStatusCode.BadRequest, missingRun.StatusCode);
        Assert.Contains("runId is required", await missingRun.Content.ReadAsStringAsync());

        var empty = await client.PostAsJsonAsync(
            $"/agui?tripId={tripId}",
            new { runId = "r1", messages = new[] { new { id = "m1", role = "user", content = "  " } } },
            Json);
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);
        Assert.Contains("must not be empty", await empty.Content.ReadAsStringAsync());

        var unknown = await client.PostAsJsonAsync(
            "/agui?tripId=missing",
            body,
            Json);
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    [Fact]
    public async Task AguiStreamsRunStartedSnapshotThenFinishes()
    {
        var service = new FakeTravelService
        {
            Events =
            [
                new AgentEvent.RunStart { Inputs = [] },
                new AgentEvent.RunEnd { Inputs = [] },
            ],
        };
        using var client = CreateClient(service);
        var tripId = await CreateTripAsync(client);

        var response = await client.PostAsJsonAsync(
            $"/agui?tripId={tripId}",
            new { runId = "r1", messages = new[] { new { id = "m1", role = "user", content = "泰山" } } },
            Json);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("text/event-stream", response.Content.Headers.ContentType?.ToString());
        var frames = SseEvents(await response.Content.ReadAsStringAsync());
        Assert.Equal("RUN_STARTED", frames[0]["type"]!.GetValue<string>());
        Assert.Contains(frames, frame => frame["type"]!.GetValue<string>() == "MESSAGES_SNAPSHOT");
        Assert.Contains(frames, frame => frame["type"]!.GetValue<string>() == "STATE_SNAPSHOT");
        Assert.Equal("RUN_FINISHED", frames[^1]["type"]!.GetValue<string>());

        var snapshot = frames.First(frame => frame["type"]!.GetValue<string>() == "MESSAGES_SNAPSHOT");
        Assert.Contains(
            snapshot["messages"]!.AsArray(),
            message => message!["role"]!.GetValue<string>() == "user"
                && message["content"]!.GetValue<string>() == "泰山"
                && message["id"]!.GetValue<string>() == "pending-user-r1");
        Assert.Equal(tripId, service.SubmittedTripId);
        Assert.Equal("泰山", service.SubmittedContent);
        Assert.Equal(1, service.ClearFaultsCalls);
    }

    [Fact]
    public async Task AguiReturnsWhenClientDisconnects()
    {
        var service = new FakeTravelService { HoldWatch = true };
        using var client = CreateClient(service);
        var tripId = await CreateTripAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/agui?tripId={tripId}")
        {
            Content = JsonContent.Create(
                new { runId = "r1", messages = new[] { new { id = "m1", role = "user", content = "泰山" } } },
                options: Json),
        };
        using var canceller = new CancellationTokenSource();

        // Wait for the body, not just the headers: with ResponseHeadersRead the
        // send task stops observing the token once the headers arrive, so the
        // server would never see this client go away.
        var pending = client.SendAsync(request, HttpCompletionOption.ResponseContentRead, canceller.Token);
        var enteredDeadline = DateTime.UtcNow.AddSeconds(5);
        while (!service.WatchEntered.Task.IsCompleted && DateTime.UtcNow < enteredDeadline)
        {
            await Task.Delay(20);
        }

        Assert.True(service.WatchEntered.Task.IsCompleted);
        await canceller.CancelAsync();

        // The request token must reach the watch and end the handler. The client
        // may already hold the headers, so the handler returning is observed on
        // the fake's watcher disposal rather than on the send task.
        Assert.True(await WaitAsync(service.WatchAborted.Task));
        Assert.True(await WaitAsync(service.WatchDisposed.Task));
        Assert.Equal(1, service.AbortCount);

        try
        {
            await pending;
        }
        catch (OperationCanceledException)
        {
        }
        catch (HttpRequestException)
        {
        }
    }

    private static async Task<bool> WaitAsync(Task task)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!task.IsCompleted && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        return task.IsCompleted;
    }

    private HttpClient CreateClient(FakeTravelService service)
    {
        var app = Program.BuildApp(TestConfig(), service);
        app.StartAsync().GetAwaiter().GetResult();
        _apps.Add(app);
        return new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
    }

    private static async Task<string> CreateTripAsync(HttpClient client)
    {
        var created = await client.PostAsJsonAsync(
            "/api/trips",
            new { title = "泰山", destination = "泰山", startDate = "2026-10-26", days = 3 },
            Json);
        created.EnsureSuccessStatusCode();
        var entry = await created.Content.ReadFromJsonAsync<TripIndexEntry>(Json);
        return entry!.TripId;
    }

    private static int _port = 4300;

    private static ServerConfig TestConfig()
    {
        var config = ServerConfig.FromEnvironment(new Dictionary<string, string?>
        {
            ["DEEPSEEK_API_KEY"] = "test-key",
            ["ASPNETCORE_URLS"] = $"http://127.0.0.1:{Interlocked.Increment(ref _port)}",
        });
        return config with { Now = static () => new DateTimeOffset(2026, 10, 19, 0, 0, 0, TimeSpan.Zero) };
    }

    private static List<JsonObject> SseEvents(string body) =>
        body.Split('\n')
            .Where(line => line.StartsWith("data:", StringComparison.Ordinal))
            .Select(line => line["data:".Length..].Trim())
            .Where(data => data.Length > 0 && data != "[DONE]")
            .Select(data => JsonNode.Parse(data)!.AsObject())
            .ToList();

    /// <summary>
    /// In-memory stand-in for <see cref="TravelService"/>. It records submissions and
    /// replays a scripted event sequence, so the endpoints can be tested offline.
    /// </summary>
    private sealed class FakeTravelService : TravelService
    {
        private readonly Dictionary<string, TripIndexEntry> _trips = [];
        private readonly Dictionary<string, string> _submissions = [];
        private int _sequence;

        public IReadOnlyList<TranscriptEntry> Transcript { get; init; } = [];

        public IReadOnlyList<AgentEvent> Events { get; init; } = [new AgentEvent.RunEnd { Inputs = [] }];

        public bool HoldWatch { get; init; }

        public string? SubmittedTripId { get; private set; }

        public string? SubmittedContent { get; private set; }

        public int ClearFaultsCalls { get; private set; }

        public int AbortCount { get; private set; }

        public TaskCompletionSource WatchEntered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource WatchAborted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        /// <summary>Set when the handler disposes the watcher, i.e. when it has returned.</summary>
        public TaskCompletionSource WatchDisposed { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override Task<IReadOnlyList<TripIndexEntry>> ListTripsAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<TripIndexEntry>>(_trips.Values.ToArray());

        public override Task<TripIndexEntry> CreateTripAsync(
            CreateTripInput input,
            CancellationToken ct = default)
        {
            _sequence += 1;
            var entry = new TripIndexEntry
            {
                TripId = $"t{_sequence}",
                ConversationId = $"t{_sequence}",
                Title = input.Title,
                Destination = input.Destination,
                StartDate = input.StartDate,
                Days = input.Days,
                UpdatedAt = "2026-10-19T00:00:00.000Z",
                Status = "active",
            };
            _trips[entry.TripId] = entry;
            return Task.FromResult(entry);
        }

        public override Task<TripSnapshot> GetSnapshotAsync(string tripId, CancellationToken ct = default)
        {
            if (!_trips.TryGetValue(tripId, out var trip))
            {
                throw new KeyNotFoundException($"Trip not found: {tripId}");
            }

            return Task.FromResult(new TripSnapshot
            {
                Trip = trip,
                Brief = new TripBrief
                {
                    Destination = trip.Destination,
                    StartDate = trip.StartDate,
                    Days = trip.Days,
                },
                Plan = new TripPlan { Days = [] },
                Sources = new Dictionary<string, TripSource>(),
                Research = new TripResearch { SearchCount = 0, FetchCount = 0 },
                Running = false,
            });
        }

        public override Task<string> SubmitMessageAsync(
            string tripId,
            string content,
            string requestId,
            CancellationToken ct = default)
        {
            if (!_trips.ContainsKey(tripId)) throw new KeyNotFoundException($"Trip not found: {tripId}");

            SubmittedTripId = tripId;
            SubmittedContent = content;
            var key = $"{tripId}:{requestId}";
            if (!_submissions.TryGetValue(key, out var submissionId))
            {
                _sequence += 1;
                submissionId = $"s{_sequence}";
                _submissions[key] = submissionId;
            }

            return Task.FromResult(submissionId);
        }

        public override Task<IReadOnlyList<TranscriptEntry>> GetTranscriptAsync(
            string tripId,
            CancellationToken ct = default)
        {
            if (!_trips.ContainsKey(tripId)) throw new KeyNotFoundException($"Trip not found: {tripId}");
            return Task.FromResult(Transcript);
        }

        public override async IAsyncEnumerable<AgentEvent> WatchEventsAsync(
            string tripId,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
        {
            if (!_trips.ContainsKey(tripId)) throw new KeyNotFoundException($"Trip not found: {tripId}");

            using var registration = ct.Register(() =>
            {
                AbortCount += 1;
                WatchAborted.TrySetResult();
            });
            WatchEntered.TrySetResult();
            try
            {
                yield return new AgentEvent.Snapshot
                {
                    Entries = [],
                    Tools = [],
                    Compactions = [],
                    Inbox = [],
                    Agent = new Dictionary<string, object?>(),
                    Usage = new Dictionary<string, object?>(),
                };

                if (HoldWatch)
                {
                    try
                    {
                        await Task.Delay(Timeout.Infinite, ct);
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested)
                    {
                        yield break;
                    }
                }

                foreach (var agentEvent in Events)
                {
                    ct.ThrowIfCancellationRequested();
                    yield return agentEvent;
                }
            }
            finally
            {
                WatchDisposed.TrySetResult();
            }
        }

        public override Task ClearFaultsAsync(string tripId, CancellationToken ct = default)
        {
            ClearFaultsCalls += 1;
            return Task.CompletedTask;
        }

        public override Task RecordFaultAsync(string tripId, TripFault fault, CancellationToken ct = default) =>
            Task.CompletedTask;

        public override Task CloseAsync(CancellationToken ct = default) => Task.CompletedTask;
    }
}
