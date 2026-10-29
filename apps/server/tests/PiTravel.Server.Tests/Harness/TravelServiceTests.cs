using Pi.Ai.Models;
using Pi.Ai.Providers;
using Pi.Ai.Types;
using Pi.Durable.Harness;
using Pi.Durable.Storage;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;

namespace PiTravel.Server.Tests.Harness;

/// <summary>
/// Locks <see cref="TravelService"/> and <see cref="Docs"/> to
/// <c>apps/server/src/harness/service.ts</c> and <c>apps/server/src/trips/docs.ts</c>.
/// </summary>
public sealed class TravelServiceTests
{
    private static readonly DateTimeOffset FixedNow =
        new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static (
        MemoryStorage Storage,
        Faux.FauxProviderHandle Faux,
        Models Models,
        ModelRef DefaultModel,
        IRegistry Registry) CreateTestEnv()
    {
        var storage = new MemoryStorage();
        var faux = Faux.CreateProvider();
        var model = faux.GetModel(null)!;
        var models = new Models();
        models.SetProvider(faux.Provider);
        return (
            storage,
            faux,
            models,
            new ModelRef(model.Provider, model.Id),
            Registry.CreateRegistry());
    }

    private static Task<TravelService> OpenServiceAsync(
        (
            MemoryStorage Storage,
            Faux.FauxProviderHandle Faux,
            Models Models,
            ModelRef DefaultModel,
            IRegistry Registry) env,
        IStorage? storage = null,
        ThinkingLevel thinkingLevel = ThinkingLevel.Off,
        Func<DateTimeOffset>? now = null) =>
        TravelService.OpenAsync(
            new TravelServiceOptions
            {
                Storage = storage ?? env.Storage,
                Models = env.Models,
                Registry = env.Registry,
                DefaultModel = env.DefaultModel,
                ThinkingLevel = thinkingLevel,
                Now = now ?? (() => FixedNow),
            },
            CancellationToken.None);

    [Fact]
    public async Task CreateTripWritesSeedBriefWithoutRequiringCompleteness()
    {
        var env = CreateTestEnv();
        var service = await OpenServiceAsync(env);
        try
        {
            var trip = await service.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
                CancellationToken.None);

            var snapshot = await service.GetSnapshotAsync(trip.TripId, CancellationToken.None);

            Assert.Equal(trip, snapshot.Trip);
            Assert.Equal("泰山", snapshot.Brief.Destination);
            Assert.Equal("2026-10-26", snapshot.Brief.StartDate);
            Assert.Equal(3d, snapshot.Brief.Days);
            Assert.Null(snapshot.Brief.Origin);
            Assert.Empty(snapshot.Plan.Days);
            Assert.Empty(snapshot.Sources);
            Assert.Equal(0, snapshot.Research.SearchCount);
            Assert.Equal(0, snapshot.Research.FetchCount);
            Assert.False(snapshot.Running);

            var listed = await service.ListTripsAsync(CancellationToken.None);
            Assert.Equal(new[] { trip }, listed);
        }
        finally
        {
            await service.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task CreateTripRejectsPastOrImpossibleDate()
    {
        // 2026-10-20 01:00 +08:00 is 2026-10-19 in UTC, so local-date comparison must
        // treat 2026-10-19 as in the past and 2026-10-20 as today.
        var localNow = new DateTimeOffset(2026, 10, 20, 1, 0, 0, TimeSpan.FromHours(8));
        var env = CreateTestEnv();
        var service = await OpenServiceAsync(env, now: () => localNow);
        try
        {
            var impossible = await Assert.ThrowsAnyAsync<Exception>(() =>
                service.CreateTripAsync(
                    new CreateTripInput("泰山", "泰山", "2026-02-30", 3),
                    CancellationToken.None));
            Assert.Contains("real calendar date", impossible.Message);

            var past = await Assert.ThrowsAnyAsync<Exception>(() =>
                service.CreateTripAsync(
                    new CreateTripInput("泰山", "泰山", "2026-10-19", 3),
                    CancellationToken.None));
            Assert.Contains("past", past.Message);

            var today = await service.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-20", 3),
                CancellationToken.None);
            Assert.Equal("2026-10-20", today.StartDate);
        }
        finally
        {
            await service.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task SubmitMessageIsIdempotentPerRequestId()
    {
        var env = CreateTestEnv();
        env.Faux.SetResponses([Faux.Response.Text("收到")]);
        var service = await OpenServiceAsync(env);
        try
        {
            var trip = await service.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
                CancellationToken.None);

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var enumerator = service
                .WatchEventsAsync(trip.TripId, cts.Token)
                .GetAsyncEnumerator(cts.Token);

            // Prime the watcher before submitting so we do not miss run_end.
            Assert.True(await enumerator.MoveNextAsync());
            Assert.IsType<AgentEvent.Snapshot>(enumerator.Current);

            var firstId = await service.SubmitMessageAsync(
                trip.TripId,
                "泰山三天",
                "req-1",
                CancellationToken.None);
            var secondId = await service.SubmitMessageAsync(
                trip.TripId,
                "泰山三天",
                "req-1",
                CancellationToken.None);

            Assert.Equal(firstId, secondId);

            while (await enumerator.MoveNextAsync())
            {
                if (enumerator.Current is AgentEvent.RunEnd)
                {
                    break;
                }
            }

            var transcript = await service.GetTranscriptAsync(trip.TripId, CancellationToken.None);
            var userEntry = Assert.Single(transcript, entry => entry.Role == "user");
            Assert.Equal("泰山三天", userEntry.Content);
            var assistantEntry = Assert.Single(transcript, entry => entry.Role == "assistant");
            Assert.Equal("收到", assistantEntry.Content);
        }
        finally
        {
            await service.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task SnapshotReportsRunningWhileARunIsActive()
    {
        var env = CreateTestEnv();
        var callStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseCall = new TaskCompletionSource<AssistantMessage>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        env.Faux.SetResponses(
        [
            new Faux.FactoryStep((_, _, _, _) =>
            {
                callStarted.TrySetResult();
                return releaseCall.Task;
            }),
        ]);

        var service = await OpenServiceAsync(env);
        try
        {
            var trip = await service.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
                CancellationToken.None);

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var enumerator = service
                .WatchEventsAsync(trip.TripId, cts.Token)
                .GetAsyncEnumerator(cts.Token);
            Assert.True(await enumerator.MoveNextAsync());

            await service.SubmitMessageAsync(
                trip.TripId,
                "开始规划",
                "req-active",
                CancellationToken.None);
            await callStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));

            var activeSnapshot = await service.GetSnapshotAsync(trip.TripId, CancellationToken.None);
            Assert.True(activeSnapshot.Running);

            releaseCall.TrySetResult(Faux.ScriptedMessage("完成"));

            while (await enumerator.MoveNextAsync())
            {
                if (enumerator.Current is AgentEvent.RunEnd)
                {
                    break;
                }
            }

            var settledSnapshot = await service.GetSnapshotAsync(trip.TripId, CancellationToken.None);
            Assert.False(settledSnapshot.Running);
        }
        finally
        {
            await service.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task RecordFaultAppendsAndCapsAtTen()
    {
        var env = CreateTestEnv();
        var service = await OpenServiceAsync(env);
        try
        {
            var trip = await service.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
                CancellationToken.None);

            for (var i = 1; i <= 12; i++)
            {
                await service.RecordFaultAsync(
                    trip.TripId,
                    new TripFault
                    {
                        Kind = "pi.tool",
                        Message = $"fault-{i}",
                        TaskId = i.ToString(),
                        At = "2026-10-19T00:00:00.000Z",
                    },
                    CancellationToken.None);
            }

            var snapshot = await service.GetSnapshotAsync(trip.TripId, CancellationToken.None);
            Assert.NotNull(snapshot.Faults);
            Assert.Equal(10, snapshot.Faults.Count);
            Assert.Equal(
                Enumerable.Range(3, 10).Select(i => $"fault-{i}").ToArray(),
                snapshot.Faults.Select(fault => fault.Message).ToArray());

            await service.ClearFaultsAsync(trip.TripId, CancellationToken.None);
            var afterClear = await service.GetSnapshotAsync(trip.TripId, CancellationToken.None);
            Assert.NotNull(afterClear.Faults);
            Assert.Empty(afterClear.Faults);
        }
        finally
        {
            await service.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task WatchEventsStartsWithSnapshotThenBatches()
    {
        var env = CreateTestEnv();
        env.Faux.SetResponses([Faux.Response.Text("好的")]);
        var service = await OpenServiceAsync(env);
        try
        {
            var trip = await service.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
                CancellationToken.None);

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var enumerator = service
                .WatchEventsAsync(trip.TripId, cts.Token)
                .GetAsyncEnumerator(cts.Token);

            Assert.True(await enumerator.MoveNextAsync());
            Assert.IsType<AgentEvent.Snapshot>(enumerator.Current);

            await service.SubmitMessageAsync(
                trip.TripId,
                "你好",
                "req-watch",
                CancellationToken.None);

            var received = new List<AgentEvent>();
            Task<bool> pendingNext;
            while (true)
            {
                pendingNext = enumerator.MoveNextAsync().AsTask();
                if (!pendingNext.IsCompleted && received.Any(ev => ev is AgentEvent.RunEnd))
                {
                    break;
                }

                Assert.True(await pendingNext);
                received.Add(enumerator.Current);
            }

            Assert.Contains(received, ev => ev is AgentEvent.RunStart);
            Assert.Contains(received, ev => ev is AgentEvent.RunEnd);

            await cts.CancelAsync();
            Assert.False(await pendingNext.WaitAsync(TimeSpan.FromSeconds(5)));
        }
        finally
        {
            await service.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task ReopenResumesAPendingRun()
    {        var env = CreateTestEnv();
        var firstCallStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var holdFirstCall = new TaskCompletionSource<AssistantMessage>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        env.Faux.SetResponses(
        [
            new Faux.FactoryStep((_, _, _, _) =>
            {
                firstCallStarted.TrySetResult();
                return holdFirstCall.Task;
            }),
            Faux.Response.Text("恢复后完成"),
        ]);

        var firstService = await OpenServiceAsync(env);
        var trip = await firstService.CreateTripAsync(
            new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
            CancellationToken.None);

        await firstService.SubmitMessageAsync(
            trip.TripId,
            "泰山三天",
            "req-resume",
            CancellationToken.None);
        await firstCallStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));

        await firstService.CloseAsync(CancellationToken.None);

        var reopenedService = await OpenServiceAsync(env, storage: env.Storage.Reopen());
        try
        {
            var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
            IReadOnlyList<TranscriptEntry> transcript = [];
            while (DateTimeOffset.UtcNow < deadline)
            {
                transcript = await reopenedService.GetTranscriptAsync(
                    trip.TripId,
                    CancellationToken.None);
                if (transcript.Any(entry => entry.Role == "assistant" && entry.Content == "恢复后完成"))
                {
                    break;
                }

                await Task.Delay(25);
            }

            Assert.Contains(
                transcript,
                entry => entry.Role == "assistant" && entry.Content == "恢复后完成");

            var snapshot = await reopenedService.GetSnapshotAsync(
                trip.TripId,
                CancellationToken.None);
            Assert.Equal("泰山", snapshot.Brief.Destination);
            Assert.Equal("2026-10-26", snapshot.Brief.StartDate);
            Assert.Equal(3d, snapshot.Brief.Days);
            Assert.False(snapshot.Running);
        }
        finally
        {
            await reopenedService.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task ReopenWithTheSameDataDirKeepsTheTrip()
    {
        var dataDir = Path.Combine(
            Path.GetTempPath(),
            $"pi-travel-service-{Guid.NewGuid():N}");
        var env = CreateTestEnv();
        try
        {
            var first = await TravelService.OpenAsync(
                new TravelServiceOptions
                {
                    DataDir = dataDir,
                    Models = env.Models,
                    Registry = env.Registry,
                    DefaultModel = env.DefaultModel,
                    Now = () => FixedNow,
                },
                CancellationToken.None);
            var trip = await first.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
                CancellationToken.None);
            await first.CloseAsync(CancellationToken.None);

            var reopened = await TravelService.OpenAsync(
                new TravelServiceOptions
                {
                    DataDir = dataDir,
                    Models = env.Models,
                    Registry = env.Registry,
                    DefaultModel = env.DefaultModel,
                    Now = () => FixedNow,
                },
                CancellationToken.None);
            try
            {
                var listed = await reopened.ListTripsAsync(CancellationToken.None);
                Assert.Equal(trip, Assert.Single(listed));
                var snapshot = await reopened.GetSnapshotAsync(trip.TripId, CancellationToken.None);
                Assert.Equal("泰山", snapshot.Brief.Destination);
            }
            finally
            {
                await reopened.CloseAsync(CancellationToken.None);
            }
        }
        finally
        {
            if (Directory.Exists(dataDir))
            {
                Directory.Delete(dataDir, recursive: true);
            }
        }
    }

    [Fact]
    public async Task ReopenUpgradesALegacyTripToTheConfiguredThinkingLevel()
    {
        var env = CreateTestEnv();
        var off = await OpenServiceAsync(env);
        var trip = await off.CreateTripAsync(
            new CreateTripInput("泰山", "泰山", "2026-10-26", 3),
            CancellationToken.None);
        await off.CloseAsync(CancellationToken.None);

        var seen = new List<string?>();
        env.Faux.SetResponses(
        [
            new Faux.FactoryStep((_, options, _, _) =>
            {
                seen.Add(options?.Reasoning);
                return Task.FromResult(Faux.ScriptedMessage("ok"));
            }),
        ]);

        var low = await OpenServiceAsync(
            env,
            storage: env.Storage.Reopen(),
            thinkingLevel: ThinkingLevel.Low);
        try
        {
            await low.SubmitMessageAsync(
                trip.TripId,
                "你好",
                "req-low",
                CancellationToken.None);

            var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
            while (seen.Count == 0 && DateTimeOffset.UtcNow < deadline)
            {
                await Task.Delay(25);
            }

            Assert.Equal(new[] { "low" }, seen);
        }
        finally
        {
            await low.CloseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void DocsDefineTheSharedKindsAndVersions()
    {
        Assert.Equal(
            new[]
            {
                "trip.brief",
                "trip.plan",
                "trip.sources",
                "trip.research",
                "trip.search-cache",
                "trip.faults",
            },
            new[]
            {
                Docs.TripBriefDoc,
                Docs.TripPlanDoc,
                Docs.TripSourcesDoc,
                Docs.TripResearchDoc,
                Docs.TripSearchCacheDoc,
                Docs.TripFaultsDoc,
            }.Select(token => token.Definition.Kind).ToArray());

        Assert.All(
            new[]
            {
                Docs.TripBriefDoc,
                Docs.TripPlanDoc,
                Docs.TripSourcesDoc,
                Docs.TripResearchDoc,
                Docs.TripSearchCacheDoc,
                Docs.TripFaultsDoc,
            },
            token => Assert.Equal(1, token.Definition.Version));
    }

    [Fact]
    public void DocsHelpersMergeBriefAndUpsertDayCards()
    {
        var brief = new TripBrief { Destination = "泰山", Days = 3 };
        var merged = Docs.MergeBrief(brief, new TripBrief { Origin = "上海", Days = null });

        Assert.Equal("泰山", merged.Destination);
        Assert.Equal("上海", merged.Origin);
        Assert.Equal(3d, merged.Days);

        var first = SampleDayCard(1);
        var plan = Docs.UpsertDayCard(new TripPlan { Days = [] }, first);
        Assert.Equal(first, Assert.Single(plan.Days));

        var replacement = SampleDayCard(1) with { Title = "改过的第一天" };
        var updated = Docs.UpsertDayCard(plan, replacement);
        Assert.Equal("改过的第一天", Assert.Single(updated.Days).Title);

        var twoDays = Docs.UpsertDayCard(updated, SampleDayCard(2));
        Assert.Equal(new[] { 1, 2 }, twoDays.Days.Select(day => day.DayIndex).ToArray());
    }

    private static DayCard SampleDayCard(int dayIndex) => new()
    {
        DayIndex = dayIndex,
        Date = $"2026-10-{25 + dayIndex}",
        Title = $"第 {dayIndex} 天",
        Blocks = [],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = [0, 0],
        Sources = [],
        SvgStatus = "pending",
        UpdatedAt = "2026-10-19T00:00:00.000Z",
    };
}
