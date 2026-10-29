using PiTravel.Server.Contracts;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Tests.Planning;

/// <summary>
/// Locks the day-card rules, their messages, and their ordering to
/// <c>validateDayCard</c> in <c>apps/server/src/plan/validate.ts</c>.
/// </summary>
public sealed class DayCardValidatorTests
{
    private static TripBrief CompleteBrief() => new()
    {
        Destination = "泰安",
        Origin = "上海虹桥",
        StartDate = "2026-10-26",
        Days = 3,
        BudgetCny = 3000,
        Companions = "独自",
        Fitness = "average",
        Interests = ["风景"],
    };

    [Fact]
    public void RejectsIncompleteBrief()
    {
        var errors = DayCardValidator.Validate(Card(), Sources(), new TripBrief());

        Assert.Equal(new[] { "brief is incomplete" }, errors);
    }

    [Fact]
    public void AcceptsValidCard()
    {
        Assert.Empty(DayCardValidator.Validate(Card(), Sources(), CompleteBrief()));
    }

    [Fact]
    public void RejectsFactClaimWithoutSources()
    {
        var claim = Fact("门票 115 元") with { Unverified = false };
        var card = Card(blocks: [Block([claim])]);

        var errors = DayCardValidator.Validate(card, Sources(), CompleteBrief());

        Assert.Equal(new[] { "claim has no source: 门票 115 元" }, errors);
    }

    [Fact]
    public void RejectsUnknownSourceId()
    {
        var card = Card(blocks: [Block([Fact("门票 115 元", "missing")])]);

        var errors = DayCardValidator.Validate(card, Sources(), CompleteBrief());

        Assert.Equal(new[] { "claim references unknown source: missing" }, errors);
    }

    [Fact]
    public void RejectsUnfetchedSourceAsFact()
    {
        var card = Card(blocks: [Block([Fact("门票 115 元", "s2")])]);
        var unfetched = new Dictionary<string, TripSource> { ["s2"] = UnfetchedSource("s2") };
        var fetched = new Dictionary<string, TripSource> { ["s2"] = FetchedSource("s2") };

        Assert.Equal(
            new[]
            {
                "claim cites an unfetched source (fetch the page before treating it as a fact): s2",
            },
            DayCardValidator.Validate(card, unfetched, CompleteBrief()));
        Assert.Empty(DayCardValidator.Validate(card, fetched, CompleteBrief()));
    }

    [Fact]
    public void AllowsUnverifiedFactWithoutSources()
    {
        var claim = Fact("门票 115 元") with { Unverified = true };
        var card = Card(blocks: [Block([claim])]);

        Assert.Empty(DayCardValidator.Validate(card, Sources(), CompleteBrief()));
    }

    [Fact]
    public void RejectsCostRangeWhereLowExceedsHigh()
    {
        Assert.Equal(
            new[] { "estimatedCostCny cost low must not exceed high" },
            DayCardValidator.Validate(Card(cost: [200, 100]), Sources(), CompleteBrief()));
        Assert.Equal(
            new[] { "blocks[0].costCny cost low must not exceed high" },
            DayCardValidator.Validate(
                Card(blocks: [Block([], cost: [10, 5])]),
                Sources(),
                CompleteBrief()));
    }

    [Fact]
    public void IgnoresOpinionClaims()
    {
        var card = Card(
            blocks: [Block([Opinion("风景很美")])],
            food: [Opinion("饭菜可口", "missing")]);

        Assert.Empty(DayCardValidator.Validate(card, Sources(), CompleteBrief()));
    }

    [Fact]
    public void ErrorsFollowTheTypescriptOrder()
    {
        var sources = new Dictionary<string, TripSource> { ["s2"] = UnfetchedSource("s2") };
        var card = new DayCard
        {
            DayIndex = 0,
            Date = "  ",
            Title = "D1",
            Blocks = [Block([Fact("block fact")], cost: [10, 5])],
            Scenery = [Opinion("scenery opinion")],
            Food = [Fact("food fact", "missing")],
            Transport = [Fact("transport fact", "s2")],
            EstimatedCostCny = [-1, 5],
            Sources = [],
            SvgStatus = "pending",
            UpdatedAt = "",
        };

        var errors = DayCardValidator.Validate(card, sources, new TripBrief());

        Assert.Equal(
            new[]
            {
                "brief is incomplete",
                "dayIndex must be at least 1",
                "date is required",
                "estimatedCostCny costs must be non-negative",
                "blocks[0].costCny cost low must not exceed high",
                "claim has no source: block fact",
                "claim references unknown source: missing",
                "claim cites an unfetched source (fetch the page before treating it as a fact): s2",
            },
            errors);
    }

    private static Dictionary<string, TripSource> Sources() => [];

    private static TripSource FetchedSource(string id) => new()
    {
        Id = id,
        Query = "q",
        Title = "t",
        Url = "https://example.test/page",
        Snippet = "",
        FetchedAt = "2026-10-19T00:00:00.000Z",
        Kind = "fetch",
    };

    private static TripSource UnfetchedSource(string id) =>
        FetchedSource(id) with { FetchedAt = null };

    private static Claim Fact(string text, params string[] sourceIds) =>
        new() { Text = text, Kind = "fact", SourceIds = sourceIds };

    private static Claim Opinion(string text, params string[] sourceIds) =>
        new() { Text = text, Kind = "opinion", SourceIds = sourceIds };

    private static DayBlock Block(IReadOnlyList<Claim> claims, IReadOnlyList<double>? cost = null) =>
        new()
        {
            Time = "09:00",
            Title = "红门",
            Detail = "",
            Claims = claims,
            CostCny = cost,
        };

    private static DayCard Card(
        IReadOnlyList<DayBlock>? blocks = null,
        IReadOnlyList<Claim>? food = null,
        IReadOnlyList<double>? cost = null) =>
        new()
        {
            DayIndex = 1,
            Date = "2026-10-26",
            Title = "D1",
            Blocks = blocks ?? [],
            Scenery = [],
            Food = food ?? [],
            Transport = [],
            EstimatedCostCny = cost ?? [100, 200],
            Sources = [],
            SvgStatus = "pending",
            UpdatedAt = "",
        };
}
