using System.Text.Json;
using System.Text.Json.Nodes;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Tests.Contracts;

/// <summary>
/// Locks the wire shape of the shared trip contract to
/// <c>packages/shared/src/trip.ts</c>: camelCase keys, optional fields omitted, and
/// numeric ranges carried as <c>[low, high]</c> arrays.
/// </summary>
public sealed class TripJsonTests
{
    private const string UpdatedAt = "2026-10-20T00:00:00.000Z";

    [Fact]
    public void SnapshotSerializesToTheSharedShape()
    {
        var json = JsonSerializer.Serialize(SampleSnapshot(), TripJson.Options);
        var root = JsonNode.Parse(json)!.AsObject();

        Assert.Equal(
            new[] { "brief", "plan", "research", "running", "sources", "trip" },
            root.Select(pair => pair.Key).Order(StringComparer.Ordinal).ToArray());

        var trip = root["trip"]!.AsObject();
        Assert.Equal("t1", trip["tripId"]!.GetValue<string>());
        Assert.Equal("t1", trip["conversationId"]!.GetValue<string>());
        Assert.Equal("泰山", trip["title"]!.GetValue<string>());
        Assert.Equal("泰安", trip["destination"]!.GetValue<string>());
        Assert.Equal("2026-10-26", trip["startDate"]!.GetValue<string>());
        Assert.Equal(3, trip["days"]!.GetValue<int>());
        Assert.Equal(UpdatedAt, trip["updatedAt"]!.GetValue<string>());
        Assert.Equal("active", trip["status"]!.GetValue<string>());

        var brief = root["brief"]!.AsObject();
        Assert.Equal("泰安", brief["destination"]!.GetValue<string>());
        Assert.False(brief.ContainsKey("origin"));
        Assert.False(brief.ContainsKey("fitness"));

        var plan = root["plan"]!.AsObject();
        Assert.False(plan.ContainsKey("summary"));
        Assert.False(plan.ContainsKey("budget"));

        var day = Assert.Single(plan["days"]!.AsArray())!.AsObject();
        Assert.Equal(1, day["dayIndex"]!.GetValue<int>());
        Assert.Equal("2026-10-26", day["date"]!.GetValue<string>());
        Assert.Equal("红门—中天门", day["title"]!.GetValue<string>());
        Assert.Empty(day["scenery"]!.AsArray());
        Assert.Empty(day["food"]!.AsArray());
        Assert.Empty(day["transport"]!.AsArray());
        Assert.Equal(
            new[] { "s1" },
            day["sources"]!.AsArray().Select(node => node!.GetValue<string>()));
        Assert.Equal("pending", day["svgStatus"]!.GetValue<string>());
        Assert.Equal(UpdatedAt, day["updatedAt"]!.GetValue<string>());
        Assert.False(day.ContainsKey("svg"));

        var block = Assert.Single(day["blocks"]!.AsArray())!.AsObject();
        Assert.Equal("08:00", block["time"]!.GetValue<string>());
        Assert.Equal("红门", block["title"]!.GetValue<string>());
        Assert.Equal("开始登山", block["detail"]!.GetValue<string>());
        Assert.False(block.ContainsKey("costCny"));

        var claim = Assert.Single(block["claims"]!.AsArray())!.AsObject();
        Assert.Equal("门票115元", claim["text"]!.GetValue<string>());
        Assert.Equal("fact", claim["kind"]!.GetValue<string>());
        Assert.Equal(
            new[] { "s1" },
            claim["sourceIds"]!.AsArray().Select(node => node!.GetValue<string>()));
        Assert.False(claim.ContainsKey("unverified"));

        Assert.Empty(root["sources"]!.AsObject());

        var research = root["research"]!.AsObject();
        Assert.Equal(0, research["searchCount"]!.GetValue<int>());
        Assert.Equal(0, research["fetchCount"]!.GetValue<int>());
        Assert.False(research.ContainsKey("searchAttempts"));
        Assert.False(research.ContainsKey("fetchAttempts"));

        Assert.False(root["running"]!.GetValue<bool>());
        Assert.False(root.ContainsKey("faults"));
    }

    [Fact]
    public void DayCardCostRangeSerializesAsATwoElementArray()
    {
        var json = JsonSerializer.Serialize(SampleDayCard(), TripJson.Options);
        var cost = JsonNode.Parse(json)!["estimatedCostCny"]!.AsArray();

        Assert.Equal(2, cost.Count);
        Assert.Equal(100d, cost[0]!.GetValue<double>());
        Assert.Equal(200d, cost[1]!.GetValue<double>());
    }

    [Fact]
    public void PlanOmitsBudgetAndSummaryWhenNull()
    {
        var json = JsonSerializer.Serialize(new TripPlan { Days = [] }, TripJson.Options);
        var plan = JsonNode.Parse(json)!.AsObject();

        Assert.False(plan.ContainsKey("budget"));
        Assert.False(plan.ContainsKey("summary"));
    }

    [Fact]
    public void SnapshotRoundTripsOptionalFieldsThroughJson()
    {
        var original = SampleSnapshotWithOptionals();
        var json = JsonSerializer.Serialize(original, TripJson.Options);

        var roundTripped = JsonSerializer.Deserialize<TripSnapshot>(json, TripJson.Options);

        Assert.NotNull(roundTripped);
        Assert.Equal(original.Plan.Budget, roundTripped.Plan.Budget);
        var cost = roundTripped.Plan.Days[0].Blocks[0].CostCny;
        Assert.NotNull(cost);
        Assert.Equal(2, cost.Count);
        Assert.Equal(10d, cost[0]);
        Assert.Equal(20d, cost[1]);
        Assert.Equal(original.Research.SearchAttempts!["泰山 门票"], roundTripped.Research.SearchAttempts!["泰山 门票"]);
        Assert.Equal(original.Research.FetchAttempts!["https://example.test/ticket"], roundTripped.Research.FetchAttempts!["https://example.test/ticket"]);
        Assert.Equal(original.Faults!.Single(), roundTripped.Faults!.Single());
        Assert.Equal(json, JsonSerializer.Serialize(roundTripped, TripJson.Options));
    }

    [Fact]
    public void TripStateSerializesRunningInsideResearch()
    {
        var state = new TripState
        {
            Brief = new TripBrief { Destination = "泰安" },
            Plan = new TripPlan { Days = [] },
            Sources = new Dictionary<string, TripSource>(),
            Research = new TripResearchState { SearchCount = 0, FetchCount = 0, Running = false },
        };

        var json = JsonSerializer.Serialize(state, TripJson.Options);
        var root = JsonNode.Parse(json)!.AsObject();

        Assert.False(root.ContainsKey("running"));
        var research = root["research"]!.AsObject();
        Assert.Equal(0, research["searchCount"]!.GetValue<int>());
        Assert.Equal(0, research["fetchCount"]!.GetValue<int>());
        Assert.False(research["running"]!.GetValue<bool>());
    }

    private static TripSnapshot SampleSnapshot() => new()
    {
        Trip = new TripIndexEntry
        {
            TripId = "t1",
            ConversationId = "t1",
            Title = "泰山",
            Destination = "泰安",
            StartDate = "2026-10-26",
            Days = 3,
            UpdatedAt = UpdatedAt,
            Status = "active",
        },
        Brief = new TripBrief { Destination = "泰安" },
        Plan = new TripPlan { Days = [SampleDayCard()] },
        Sources = new Dictionary<string, TripSource>(),
        Research = new TripResearch { SearchCount = 0, FetchCount = 0 },
        Running = false,
    };

    private static DayCard SampleDayCard() => new()
    {
        DayIndex = 1,
        Date = "2026-10-26",
        Title = "红门—中天门",
        Blocks =
        [
            new DayBlock
            {
                Time = "08:00",
                Title = "红门",
                Detail = "开始登山",
                Claims = [new Claim { Text = "门票115元", Kind = "fact", SourceIds = ["s1"] }],
            },
        ],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = [100, 200],
        Sources = ["s1"],
        SvgStatus = "pending",
        UpdatedAt = UpdatedAt,
    };

    private static TripSnapshot SampleSnapshotWithOptionals() => new()
    {
        Trip = new TripIndexEntry
        {
            TripId = "t2",
            ConversationId = "7",
            Title = "泰山",
            Destination = "泰安",
            StartDate = "2026-10-26",
            Days = 3,
            UpdatedAt = UpdatedAt,
            Status = "completed",
        },
        Brief = new TripBrief
        {
            Destination = "泰安",
            Origin = "北京",
            StartDate = "2026-10-26",
            Days = 3,
            BudgetCny = 3000,
            Companions = "朋友",
            Fitness = "average",
            Interests = ["登山"],
            Constraints = ["不坐缆车"],
            Assumptions = ["天气晴好"],
        },
        Plan = new TripPlan
        {
            Summary = "两日登山",
            Days =
            [
                SampleDayCard() with
                {
                    Svg = "<svg/>",
                    SvgStatus = "ok",
                    Blocks =
                    [
                        new DayBlock
                        {
                            Time = "08:00",
                            Title = "红门",
                            Detail = "开始登山",
                            Claims = [new Claim { Text = "门票115元", Kind = "fact", SourceIds = ["s1"], Unverified = false }],
                            CostCny = [10, 20],
                        },
                    ],
                },
            ],
            Budget = new BudgetSummary { Low = 100, High = 200, Cap = 300, WithinBudget = true },
        },
        Sources = new Dictionary<string, TripSource>
        {
            ["s1"] = new()
            {
                Id = "s1",
                Query = "泰山 门票",
                Title = "泰山门票",
                Url = "https://example.test/ticket",
                Snippet = "门票115元",
                Summary = "门票价格",
                Content = "全价票115元",
                Date = "2026-10-01",
                Authority = 4,
                RerankScore = 0.92,
                FetchedAt = UpdatedAt,
                Kind = "fetch",
            },
        },
        Research = new TripResearch
        {
            SearchCount = 1,
            FetchCount = 1,
            SearchAttempts = new Dictionary<string, int> { ["泰山 门票"] = 1 },
            FetchAttempts = new Dictionary<string, int> { ["https://example.test/ticket"] = 1 },
        },
        Running = true,
        Faults = [new TripFault { Kind = "task.failed", Message = "search failed", TaskId = "task-1", At = UpdatedAt }],
    };
}
