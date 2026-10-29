using System.Globalization;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Chord.Delta;
using Pi.Durable;
using Pi.Durable.Harness;
using Pi.Durable.Storage;
using Pi.Durable.Types;
using PiTravel.Server.Contracts;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Harness;

using DeltaPath = Pi.Chord.Delta.Path;
using DurableHarness = Pi.Durable.Harness.Harness;

/// <summary>
/// Durable conversation and document facade for trips, mirroring
/// <c>apps/server/src/harness/service.ts</c>.
/// </summary>
public sealed class TravelService
{
    internal const string DefaultPlannerInstructions = """
        You are a meticulous travel planner. Work only from the brief, the recorded sources, and your tools.

        Follow this order:
        1. Clarify first. Before any research, call trip_update_brief for every missing or uncertain brief field (destination, origin, startDate, days, budgetCny, companions, fitness, interests). In one turn ask at most 3 key questions. Record explicit assumptions instead of silently guessing.
        2. No research before the brief is complete. If the brief is incomplete, ask the remaining questions and stop; do not search yet.
        3. Research before writing. Use deepseek_search, then deepseek_fetch the promising or fact-heavy pages before emitting any itinerary content. Do not plan from memory.
        4. Hard facts need fetched pages. A search snippet is only a lead. Opening hours, prices, transport schedules, and rules must be verified on the fetched page; if you cannot fetch it, mark the claim unverified instead of presenting it as fact.
        5. Freshness and authority. Prefer official sources (scenic-area, railway, government tourism) over OTAs over blogs. Prefer sources from the last 90 days; mark older prices/hours as possibly expired and keep looking for a newer source.
        6. Transport and weather caveats. Treat search-result train times as advisory and say they must be checked on 12306; use climate normals or a forecast within the next 7 days for late-October weather, and label which one you used.
        7. Emit exactly one plan_emit_day card per trip day, in day order, using the recorded source ids.
        8. After emitting a day, call sketch_day for that day. Re-emitting a changed day invalidates its sketch, so sketch it again; unchanged days keep their sketch.
        9. Cite every hard-fact claim with source ids. Mark claims you could not verify as unverified instead of presenting them as facts. Never fabricate places, prices, schedules, or availability.
        10. When all days are written, call plan_finalize and check the total against the stated budget. If it is over budget, revise days before finalizing.

        Targeted edits and cascades:
        - A request that names one day (for example "make day 3 easier") changes only that day. Re-emit only that card and leave every other card untouched.
        - Cross-day changes (budget, dates, lodging area, transport choice) cascade to every affected day; update each affected card and say which days changed.
        - If the user says a specific day must not change, exclude it from the cascade.
        - When you modify cards, state in one sentence which days were affected.

        Write in the user's language, keep day cards practical, and keep the user informed about brief gaps, research gaps, and budget risk.
        """;

    private static readonly DocToken<Dictionary<string, object?>> SessionIndexDoc =
        DurableDocuments.DefineDoc(new DocDefinition<Dictionary<string, object?>>
        {
            Kind = "trip.index",
            Version = 1,
            Initial = static () => new Dictionary<string, object?>(),
            Semantics = new DocumentSemantics.SessionScope(),
        });

    private readonly HarnessImpl _harness;
    private readonly TripIndexStore _index;
    private readonly ModelRef _defaultModel;
    private readonly ThinkingLevel _thinkingLevel;
    private readonly Func<DateTimeOffset> _now;
    private readonly string _instructions;
    private readonly HashSet<string> _upgradedThinkingTrips = [];
    private readonly SemaphoreSlim _thinkingGate = new(1, 1);

    private TravelService(
        HarnessImpl harness,
        TripIndexStore index,
        ModelRef defaultModel,
        ThinkingLevel thinkingLevel,
        Func<DateTimeOffset> now,
        string instructions)
    {
        _harness = harness;
        _index = index;
        _defaultModel = defaultModel;
        _thinkingLevel = thinkingLevel;
        _now = now;
        _instructions = instructions;
    }

    public static async Task<TravelService> OpenAsync(
        TravelServiceOptions options,
        CancellationToken ct = default)
    {
        if (!string.IsNullOrEmpty(options.DataDir))
        {
            Directory.CreateDirectory(options.DataDir);
        }

        var storage = options.Storage ?? (!string.IsNullOrEmpty(options.DataDir)
            ? await SqliteStorage.OpenAsync(
                System.IO.Path.Combine(options.DataDir, "pi.sqlite"),
                new SqliteStorageOptions
                {
                    BusyTimeoutMs = 5_000,
                    WalAutoCheckpointPages = 1_000,
                },
                ct)
            : new MemoryStorage());

        var index = options.IndexStore ?? (!string.IsNullOrEmpty(options.DataDir)
            ? new TripIndexStore(System.IO.Path.Combine(options.DataDir, "trips.json"))
            : new TripIndexStore());

        // Default to DateTimeOffset.Now so local calendar date comparisons match JS Date.
        var now = options.Now ?? (static () => DateTimeOffset.Now);
        var registry = options.Registry ?? Registry.CreateRegistry();
        var harnessOptions = new HarnessOptions
        {
            Models = options.Models,
            Registry = registry,
            Now = () => now().ToUnixTimeMilliseconds(),
        };

        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        HarnessImpl harness;
        try
        {
            harness = await DurableHarness.OpenAsync(storage, harnessOptions, ctx);
        }
        catch (InvalidOperationException ex) when (
            storage is MemoryStorage mem &&
            ex.Message.Contains("closed", StringComparison.OrdinalIgnoreCase))
        {
            harness = await DurableHarness.OpenAsync(mem.Reopen(), harnessOptions, ctx);
        }

        if (index.IsInMemory)
        {
            var storedIndex = await harness.SnapshotAsync(SessionIndexDoc, ctx);
            if (storedIndex is not null)
            {
                foreach (var raw in storedIndex.Values)
                {
                    if (raw is IReadOnlyDictionary<string, object?> entryDict)
                    {
                        await index.UpsertAsync(
                            Docs.FromDictionary<TripIndexEntry>(entryDict),
                            ct);
                    }
                }
            }
        }

        harness.Resume();

        return new TravelService(
            harness,
            index,
            options.DefaultModel,
            options.ThinkingLevel,
            now,
            options.Instructions ?? DefaultPlannerInstructions);
    }

    public async Task<TripIndexEntry> CreateTripAsync(
        CreateTripInput input,
        CancellationToken ct = default)
    {
        var initialBrief = new TripBrief
        {
            Destination = input.Destination,
            StartDate = input.StartDate,
            Days = input.Days,
        };
        var now = _now();
        var errors = BriefValidator.Validate(initialBrief, now, requireComplete: false);
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"Invalid trip: {string.Join("; ", errors)}");
        }

        var updatedAt = IsoTimestamp(now);
        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        var conversation = await _harness.CreateConversationAsync(
            new ConversationCreateOptions
            {
                Ownership = new ConversationOwnership.Ownerless(),
                Agent = new AgentChange
                {
                    Model = _defaultModel,
                    Instructions = _instructions,
                    ThinkingLevel = _thinkingLevel,
                },
                Init = async (tx, conversationId) =>
                {
                    var brief = await tx.DocAsync(Docs.TripBriefDoc, conversationId);
                    Docs.Write(brief, initialBrief);

                    var plan = await tx.DocAsync(Docs.TripPlanDoc, conversationId);
                    Docs.Write(plan, new TripPlan { Days = [] });

                    await tx.DocAsync(Docs.TripSourcesDoc, conversationId);

                    var research = await tx.DocAsync(Docs.TripResearchDoc, conversationId);
                    Docs.Write(research, new TripResearch { SearchCount = 0, FetchCount = 0 });

                    if (_index.IsInMemory)
                    {
                        var idText = conversationId.Value.ToString(CultureInfo.InvariantCulture);
                        var sessionIndex = await tx.DocAsync(SessionIndexDoc);
                        sessionIndex.Set(
                            new DeltaPath([Seg.Key(idText)]),
                            Docs.ToDictionary(new TripIndexEntry
                            {
                                TripId = idText,
                                ConversationId = idText,
                                Title = input.Title,
                                Destination = input.Destination,
                                StartDate = input.StartDate,
                                Days = input.Days,
                                UpdatedAt = updatedAt,
                                Status = "active",
                            }));
                    }
                },
            },
            ctx);

        var id = conversation.Id.Value.ToString(CultureInfo.InvariantCulture);
        var entry = new TripIndexEntry
        {
            TripId = id,
            ConversationId = id,
            Title = input.Title,
            Destination = input.Destination,
            StartDate = input.StartDate,
            Days = input.Days,
            UpdatedAt = updatedAt,
            Status = "active",
        };
        await _index.UpsertAsync(entry, ct);
        return entry;
    }

    public Task<IReadOnlyList<TripIndexEntry>> ListTripsAsync(CancellationToken ct = default) =>
        _index.ListAsync(ct);

    public async Task<TripSnapshot> GetSnapshotAsync(
        string tripId,
        CancellationToken ct = default)
    {
        var trip = await RequireTripAsync(tripId, ct);
        var conversationId = ToConversationId(trip.ConversationId);
        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        await RequireConversationAsync(conversationId, ctx);

        var brief = Docs.ReadBrief(
            await _harness.SnapshotAsync(Docs.TripBriefDoc, conversationId, ctx));
        var plan = Docs.ReadPlan(
            await _harness.SnapshotAsync(Docs.TripPlanDoc, conversationId, ctx));
        var sources = Docs.ReadSources(
            await _harness.SnapshotAsync(Docs.TripSourcesDoc, conversationId, ctx));
        var research = Docs.ReadResearch(
            await _harness.SnapshotAsync(Docs.TripResearchDoc, conversationId, ctx));
        var faults = Docs.ReadFaults(
            await _harness.SnapshotAsync(Docs.TripFaultsDoc, conversationId, ctx)).Items;
        var live = await _harness.SnapshotAsync(Live.LiveDoc, conversationId, ctx);

        return new TripSnapshot
        {
            Trip = trip,
            Brief = brief,
            Plan = plan,
            Sources = sources,
            Research = research,
            Running = live is not null && live.TryGetValue("run", out var run) && run is not null,
            Faults = faults,
        };
    }

    public async Task<string> SubmitMessageAsync(
        string tripId,
        string content,
        string requestId,
        CancellationToken ct = default)
    {
        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        var conversation = await RequireConversationByIdAsync(tripId, ctx, ct);
        await EnsureThinkingLevelAsync(tripId, conversation, ctx, ct);
        var submission = await conversation.SubmitAsync(
            new SubmissionDraft.Input
            {
                Content = [new TextContent(content)],
                RequestId = requestId,
            },
            ctx);
        return submission.Id.Value.ToString(CultureInfo.InvariantCulture);
    }

    public async Task<IReadOnlyList<TranscriptEntry>> GetTranscriptAsync(
        string tripId,
        CancellationToken ct = default)
    {
        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        var conversation = await RequireConversationByIdAsync(tripId, ctx, ct);
        var watch = await conversation.WatchAsync(ctx);
        try
        {
            return TranscriptBuilder.FromEntries(watch.Value.Entries);
        }
        finally
        {
            await watch.Stop();
        }
    }

    public async IAsyncEnumerable<AgentEvent> WatchEventsAsync(
        string tripId,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var trip = await RequireTripAsync(tripId, ct);
        var conversationId = ToConversationId(trip.ConversationId);
        await RequireConversationAsync(conversationId, Context.Background);

        var stream = await Events.WatchEventsAsync(
            _harness,
            conversationId,
            Context.Background);

        var channel = Channel.CreateUnbounded<AgentEvent>();
        stream.Start((batch, _) =>
        {
            foreach (var ev in batch)
            {
                channel.Writer.TryWrite(ev);
            }

            return Task.CompletedTask;
        });
        _ = stream.Closed.ContinueWith(
            _ => channel.Writer.TryComplete(),
            System.Threading.Tasks.TaskScheduler.Default);

        try
        {
            yield return stream.Snapshot;

            while (!ct.IsCancellationRequested)
            {
                while (!ct.IsCancellationRequested && channel.Reader.TryRead(out var ev))
                {
                    yield return ev;
                }

                if (ct.IsCancellationRequested)
                {
                    yield break;
                }

                bool hasMore;
                try
                {
                    hasMore = await channel.Reader.WaitToReadAsync(ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    yield break;
                }

                if (!hasMore)
                {
                    yield break;
                }
            }
        }
        finally
        {
            await stream.StopAsync();
        }
    }

    public async Task RecordFaultAsync(
        string tripId,
        TripFault fault,
        CancellationToken ct = default)
    {
        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        var conversation = await RequireConversationByIdAsync(tripId, ctx, ct);
        await conversation.CommitAsync(
            async tx =>
            {
                var doc = await tx.DocAsync(Docs.TripFaultsDoc, conversation.Id);
                var current = Docs.ReadFaults(doc.Draft);
                var next = current.Items.Append(fault).TakeLast(10).ToList();
                Docs.Write(doc, new TripFaults { Items = next });
                return true;
            },
            ctx);
    }

    public async Task ClearFaultsAsync(
        string tripId,
        CancellationToken ct = default)
    {
        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        var conversation = await RequireConversationByIdAsync(tripId, ctx, ct);
        await conversation.CommitAsync(
            async tx =>
            {
                var doc = await tx.DocAsync(Docs.TripFaultsDoc, conversation.Id);
                Docs.Write(doc, new TripFaults { Items = [] });
                return true;
            },
            ctx);
    }

    public Task CloseAsync(CancellationToken ct = default)
    {
        var ctx = ContextSignals.WithAbortSignal(ct, Context.Background);
        return _harness.CloseAsync(ctx);
    }

    private async Task EnsureThinkingLevelAsync(
        string tripId,
        IConversation conversation,
        Context ctx,
        CancellationToken ct)
    {
        if (_thinkingLevel == ThinkingLevel.Off)
        {
            return;
        }

        await _thinkingGate.WaitAsync(ct);
        try
        {
            if (_upgradedThinkingTrips.Contains(tripId))
            {
                return;
            }

            var agent = await conversation.AgentAsync(ctx);
            if (agent.ThinkingLevel != _thinkingLevel)
            {
                await conversation.ConfigureAsync(
                    new AgentChange { ThinkingLevel = _thinkingLevel },
                    ctx);
            }

            _upgradedThinkingTrips.Add(tripId);
        }
        finally
        {
            _thinkingGate.Release();
        }
    }

    private async Task<TripIndexEntry> RequireTripAsync(string tripId, CancellationToken ct)
    {
        var trip = await _index.GetAsync(tripId, ct);
        if (trip is null)
        {
            throw new KeyNotFoundException($"Trip not found: {tripId}");
        }

        return trip;
    }

    private async Task<IConversation> RequireConversationByIdAsync(
        string tripId,
        Context ctx,
        CancellationToken ct)
    {
        var trip = await RequireTripAsync(tripId, ct);
        return await RequireConversationAsync(ToConversationId(trip.ConversationId), ctx);
    }

    private async Task<IConversation> RequireConversationAsync(
        ConversationId conversationId,
        Context ctx)
    {
        var conversation = await _harness.ConversationAsync(conversationId, ctx);
        if (conversation is null)
        {
            throw new KeyNotFoundException($"Conversation not found: {conversationId.Value}");
        }

        return conversation;
    }

    private static ConversationId ToConversationId(string value) =>
        long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)
            ? ConversationId.From(id)
            : throw new KeyNotFoundException($"Conversation not found: {value}");

    private static string IsoTimestamp(DateTimeOffset value) =>
        value
            .ToUniversalTime()
            .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
