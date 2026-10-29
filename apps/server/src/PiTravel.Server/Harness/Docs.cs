using System.Text.Json;
using Pi.Chord.Delta;
using Pi.Durable;
using Pi.Durable.Harness;
using Pi.Durable.Types;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Harness;

/// <summary>One entry in <see cref="Docs.TripSearchCacheDoc"/>.</summary>
public sealed record SearchCacheEntry
{
    public required IReadOnlyList<string> SourceIds { get; init; }
    public required string At { get; init; }
}

/// <summary>The fault list stored in <see cref="Docs.TripFaultsDoc"/>.</summary>
public sealed record TripFaults
{
    public required IReadOnlyList<TripFault> Items { get; init; }
}

/// <summary>
/// Conversation-scoped durable document definitions and typed value-tree helpers,
/// mirroring <c>apps/server/src/trips/docs.ts</c>.
/// </summary>
public static class Docs
{
    private static readonly DocumentSemantics ConversationSemantics =
        new DocumentSemantics.LatestConversationScope(ConversationFork.Initial);

    public static readonly DocToken<Dictionary<string, object?>> TripBriefDoc =
        DurableDocuments.DefineDoc(new DocDefinition<Dictionary<string, object?>>
        {
            Kind = "trip.brief",
            Version = 1,
            Initial = static () => new Dictionary<string, object?>(),
            Semantics = ConversationSemantics,
        });

    public static readonly DocToken<Dictionary<string, object?>> TripPlanDoc =
        DurableDocuments.DefineDoc(new DocDefinition<Dictionary<string, object?>>
        {
            Kind = "trip.plan",
            Version = 1,
            Initial = static () => new Dictionary<string, object?>
            {
                ["days"] = new List<object?>(),
            },
            Semantics = ConversationSemantics,
        });

    public static readonly DocToken<Dictionary<string, object?>> TripSourcesDoc =
        DurableDocuments.DefineDoc(new DocDefinition<Dictionary<string, object?>>
        {
            Kind = "trip.sources",
            Version = 1,
            Initial = static () => new Dictionary<string, object?>(),
            Semantics = ConversationSemantics,
        });

    public static readonly DocToken<Dictionary<string, object?>> TripResearchDoc =
        DurableDocuments.DefineDoc(new DocDefinition<Dictionary<string, object?>>
        {
            Kind = "trip.research",
            Version = 1,
            Initial = static () => new Dictionary<string, object?>
            {
                ["searchCount"] = 0d,
                ["fetchCount"] = 0d,
            },
            Semantics = ConversationSemantics,
        });

    public static readonly DocToken<Dictionary<string, object?>> TripSearchCacheDoc =
        DurableDocuments.DefineDoc(new DocDefinition<Dictionary<string, object?>>
        {
            Kind = "trip.search-cache",
            Version = 1,
            Initial = static () => new Dictionary<string, object?>(),
            Semantics = ConversationSemantics,
        });

    public static readonly DocToken<Dictionary<string, object?>> TripFaultsDoc =
        DurableDocuments.DefineDoc(new DocDefinition<Dictionary<string, object?>>
        {
            Kind = "trip.faults",
            Version = 1,
            Initial = static () => new Dictionary<string, object?>
            {
                ["items"] = new List<object?>(),
            },
            Semantics = ConversationSemantics,
        });

    public static Dictionary<string, object?> ToDictionary<T>(T value) =>
        (Dictionary<string, object?>)JsonTrees.FromElement(
            JsonSerializer.SerializeToElement(value, TripJson.Options))!;

    public static T FromDictionary<T>(IReadOnlyDictionary<string, object?> dict) where T : class =>
        JsonTrees.Deserialize<T>(dict);

    public static void Write<T>(
        Tracker<IReadOnlyDictionary<string, object?>>.Change doc,
        T value) =>
        doc.Replace(ToDictionary(value));

    public static TripBrief ReadBrief(IReadOnlyDictionary<string, object?>? dict) =>
        dict is null || dict.Count == 0 ? new TripBrief() : FromDictionary<TripBrief>(dict);

    public static TripPlan ReadPlan(IReadOnlyDictionary<string, object?>? dict) =>
        dict is null || !dict.ContainsKey("days")
            ? new TripPlan { Days = [] }
            : FromDictionary<TripPlan>(dict);

    public static Dictionary<string, TripSource> ReadSources(
        IReadOnlyDictionary<string, object?>? dict) =>
        dict is null || dict.Count == 0
            ? new Dictionary<string, TripSource>()
            : FromDictionary<Dictionary<string, TripSource>>(dict);

    public static TripResearch ReadResearch(IReadOnlyDictionary<string, object?>? dict) =>
        dict is null || (!dict.ContainsKey("searchCount") && !dict.ContainsKey("fetchCount"))
            ? new TripResearch { SearchCount = 0, FetchCount = 0 }
            : FromDictionary<TripResearch>(dict);

    public static Dictionary<string, SearchCacheEntry> ReadSearchCache(
        IReadOnlyDictionary<string, object?>? dict) =>
        dict is null || dict.Count == 0
            ? new Dictionary<string, SearchCacheEntry>()
            : FromDictionary<Dictionary<string, SearchCacheEntry>>(dict);

    public static TripFaults ReadFaults(IReadOnlyDictionary<string, object?>? dict) =>
        dict is null || !dict.ContainsKey("items")
            ? new TripFaults { Items = [] }
            : FromDictionary<TripFaults>(dict);

    public static TripBrief MergeBrief(TripBrief current, TripBrief patch) => new()
    {
        Destination = patch.Destination ?? current.Destination,
        Origin = patch.Origin ?? current.Origin,
        StartDate = patch.StartDate ?? current.StartDate,
        Days = patch.Days ?? current.Days,
        BudgetCny = patch.BudgetCny ?? current.BudgetCny,
        Companions = patch.Companions ?? current.Companions,
        Fitness = patch.Fitness ?? current.Fitness,
        Interests = patch.Interests ?? current.Interests,
        Constraints = patch.Constraints ?? current.Constraints,
        Assumptions = patch.Assumptions ?? current.Assumptions,
    };

    public static TripPlan UpsertDayCard(TripPlan plan, DayCard card)
    {
        var days = plan.Days.ToList();
        var index = days.FindIndex(day => day.DayIndex == card.DayIndex);
        if (index == -1)
        {
            days.Add(card);
        }
        else
        {
            days[index] = card;
        }

        return plan with { Days = days };
    }
}
