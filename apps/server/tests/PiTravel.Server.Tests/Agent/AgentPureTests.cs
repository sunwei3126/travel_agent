using PiTravel.Server.Agent;
using PiTravel.Server.Agent.Tools;
using PiTravel.Server.Contracts;
using PiTravel.Server.Research;

namespace PiTravel.Server.Tests.Agent;

public sealed class AgentPureTests
{
    private static readonly DateTimeOffset FixedNow =
        new(2026, 10, 19, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void SearchCacheKeyNormalizesWhitespaceAndIncludesOptions()
    {
        var first = SearchTool.SearchCacheKey("  泰山   门票 \n\t 价格  ");
        var second = SearchTool.SearchCacheKey("泰山 门票 价格", new SearchOptions());

        Assert.Equal(first, second);
        Assert.Contains("\"needContent\":false", first);

        var withNeedContent = SearchTool.SearchCacheKey(
            "泰山 门票 价格",
            new SearchOptions(NeedContent: true));
        var withCount = SearchTool.SearchCacheKey(
            "泰山 门票 价格",
            new SearchOptions(Count: 5, OriQuestion: " 泰山门票多少钱 ", Localization: "zh-CN"));

        Assert.NotEqual(first, withNeedContent);
        Assert.Contains("\"needContent\":true", withNeedContent);
        Assert.NotEqual(first, withCount);
        Assert.Contains("\"count\":5", withCount);
        Assert.Contains("\"oriQuestion\":\"泰山门票多少钱\"", withCount);
        Assert.Contains("\"localization\":\"zh-CN\"", withCount);
    }

    [Fact]
    public void SelectFetchTargetsPrefersAuthorityAtLeastThreeThenSearchOrder()
    {
        var items = new[]
        {
            MakeSource("s1", "https://example.com/blog-1", authority: 1),
            MakeSource("s2", "https://example.com/gov", authority: 4),
            MakeSource("s3", "https://example.com/blog-2", authority: 2),
            MakeSource("s4", "https://example.com/ota", authority: 3),
        };

        var topTwo = SearchTool.SelectFetchTargets(items, limit: 2);
        Assert.Equal(["s2", "s4"], topTwo.Select(s => s.Id).ToArray());

        var topThree = SearchTool.SelectFetchTargets(items, limit: 3);
        Assert.Equal(["s2", "s4", "s1"], topThree.Select(s => s.Id).ToArray());
    }

    [Fact]
    public void SelectFetchTargetsDeduplicatesByNormalizedUrl()
    {
        var items = new[]
        {
            MakeSource("s1", "https://example.com/taishan/", authority: 4),
            MakeSource("s2", "https://EXAMPLE.com/taishan#section", authority: 4),
            MakeSource("s3", "https://example.com/guide", authority: 2),
        };

        var selected = SearchTool.SelectFetchTargets(items, limit: 2);
        Assert.Equal(["s1", "s3"], selected.Select(s => s.Id).ToArray());
    }

    [Fact]
    public void ApplyDayEmitKeepsSvgWhenContentUnchanged()
    {
        var existing = SampleDayCard(1, "第一天", "<svg>day-1</svg>");
        var plan = new TripPlan { Days = [existing] };

        var updated = EmitDayTool.ApplyDayEmit(
            plan,
            SampleEmitArgs(1, "第一天"),
            FixedNow.AddDays(1));

        var day = Assert.Single(updated.Days);
        Assert.Equal("<svg>day-1</svg>", day.Svg);
        Assert.Equal("ok", day.SvgStatus);
    }

    [Fact]
    public void ApplyDayEmitResetsSvgStatusToPendingWhenContentChanged()
    {
        var existing = SampleDayCard(1, "第一天", "<svg>day-1</svg>");
        var plan = new TripPlan { Days = [existing] };

        var updated = EmitDayTool.ApplyDayEmit(
            plan,
            SampleEmitArgs(1, "第一天（改）"),
            FixedNow.AddDays(1));

        var day = Assert.Single(updated.Days);
        Assert.Null(day.Svg);
        Assert.Equal("pending", day.SvgStatus);
        Assert.Equal("第一天（改）", day.Title);
    }

    [Fact]
    public void ApplyDayEmitReplacesOnlyTheTargetedDay()
    {
        var day1 = SampleDayCard(1, "第一天", "<svg>1</svg>");
        var day2 = SampleDayCard(2, "第二天", "<svg>2</svg>");
        var plan = new TripPlan { Days = [day1, day2] };

        var updated = EmitDayTool.ApplyDayEmit(
            plan,
            SampleEmitArgs(2, "第二天（改）"),
            FixedNow.AddDays(1));

        Assert.Equal(2, updated.Days.Count);
        Assert.Equal(day1, updated.Days[0]);
        Assert.Equal("第二天（改）", updated.Days[1].Title);
        Assert.Equal("pending", updated.Days[1].SvgStatus);
        Assert.Null(updated.Days[1].Svg);
    }

    [Fact]
    public void RenderTripContextOmitsSectionWhenEmpty()
    {
        Assert.Null(TripContextSection.Render(null, null, null, FixedNow));
        Assert.Null(TripContextSection.Render(
            new TripBrief(),
            new TripPlan { Days = [] },
            new Dictionary<string, TripSource>(),
            FixedNow));
    }

    [Fact]
    public void RenderTripContextCapsBlocksAtEightAndSourcesAtForty()
    {
        var blocks = Enumerable.Range(1, 10)
            .Select(i => new DayBlock
            {
                Time = $"{i:00}:00",
                Title = $"景点{i}",
                Detail = $"详情{i}",
                Claims = [],
                CostCny = [10, 20],
            })
            .ToList();

        var day = new DayCard
        {
            DayIndex = 1,
            Date = "2026-10-26",
            Title = "红门登顶",
            Blocks = blocks,
            Scenery = [],
            Food = [],
            Transport = [],
            EstimatedCostCny = [100, 200],
            Sources = ["s1"],
            SvgStatus = "ok",
            UpdatedAt = "2026-10-19T00:00:00.000Z",
        };

        var sources = Enumerable.Range(1, 45)
            .ToDictionary(
                i => $"s{i}",
                i => MakeSource(
                    $"s{i}",
                    $"https://example.com/{i}",
                    authority: 4,
                    date: "2026-10-01",
                    fetchedAt: "2026-10-19T00:00:00.000Z"));

        var rendered = TripContextSection.Render(
            new TripBrief { Destination = "泰山", Days = 3, BudgetCny = 3000 },
            new TripPlan
            {
                Days = [day],
                Summary = "三日泰山行程",
                Budget = new BudgetSummary { Low = 100, High = 200, Cap = 3000, WithinBudget = true },
            },
            sources,
            FixedNow);

        Assert.NotNull(rendered);
        Assert.Contains("Brief: destination=泰山; days=3; budget=3000 CNY", rendered);
        Assert.Contains("景点8 (¥10–¥20)", rendered);
        Assert.DoesNotContain("景点9", rendered);
        Assert.Contains("+2 more blocks", rendered);
        Assert.Contains("Sources: 45", rendered);
        Assert.Contains("+5 more sources", rendered);
    }

    [Fact]
    public void EnforceCapThrowsAtLimit()
    {
        ToolCaps.EnforceCap(39, 40, "search");
        var searchEx = Assert.Throws<InvalidOperationException>(() =>
            ToolCaps.EnforceCap(40, 40, "search"));
        Assert.Equal("search cap reached", searchEx.Message);

        var fetchEx = Assert.Throws<InvalidOperationException>(() =>
            ToolCaps.EnforceCap(30, 30, "fetch"));
        Assert.Equal("fetch cap reached", fetchEx.Message);
    }

    [Fact]
    public void PlannerInstructionsContainAllMandatedRules()
    {
        Assert.Equal(2630, Prompts.PlannerInstructions.Length);
        var sha256 = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(
                    System.Text.Encoding.UTF8.GetBytes(Prompts.PlannerInstructions)))
            .ToLowerInvariant();
        Assert.Equal(
            "d9aaee3bea25adbc3ef3b88fdd4d6047eabde73a7f6c9ff35dd8f242da41ed65",
            sha256);

        Assert.Contains("at most 3 key questions", Prompts.PlannerInstructions);
        Assert.Contains("No research before the brief is complete", Prompts.PlannerInstructions);
        Assert.Contains("A search snippet is only a lead", Prompts.PlannerInstructions);
        Assert.Contains("last 90 days", Prompts.PlannerInstructions);
        Assert.Contains("official sources", Prompts.PlannerInstructions);
        Assert.Contains("12306", Prompts.PlannerInstructions);
        Assert.Contains("Targeted edits and cascades", Prompts.PlannerInstructions);
        Assert.Contains("changes only that day", Prompts.PlannerInstructions);
    }

    [Theory]
    [InlineData(1e21, "1e+21")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(1e-6, "0.000001")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(3000, "3000")]
    [InlineData(1.5, "1.5")]
    [InlineData(-1e21, "-1e+21")]
    [InlineData(-1e-7, "-1e-7")]
    [InlineData(0.1, "0.1")]
    [InlineData(0.30000000000000004, "0.30000000000000004")]
    [InlineData(123456789.12345679, "123456789.12345679")]
    [InlineData(9.999999e-7, "9.999999e-7")]
    [InlineData(123456789012345680d, "123456789012345680")]
    [InlineData(0, "0")]
    public void FormatNumberMatchesJavaScriptString(double value, string expected) =>
        Assert.Equal(expected, TripContextSection.FormatNumber(value));

    private static TripSource MakeSource(
        string id,
        string url,
        double? authority = null,
        string? date = null,
        string? fetchedAt = null) => new()
    {
        Id = id,
        Query = "泰山",
        Title = $"标题-{id}",
        Url = url,
        Snippet = "摘要",
        Authority = authority,
        Date = date,
        FetchedAt = fetchedAt,
        Kind = fetchedAt is null ? "search" : "fetch",
    };

    private static DayCard SampleDayCard(int dayIndex, string title, string svg) => new()
    {
        DayIndex = dayIndex,
        Date = $"2026-10-{25 + dayIndex}",
        Title = title,
        Blocks = [],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = [100, 200],
        Sources = [],
        Svg = svg,
        SvgStatus = "ok",
        UpdatedAt = "2026-10-19T00:00:00.000Z",
    };

    private static EmitDayArgs SampleEmitArgs(int dayIndex, string title) => new()
    {
        DayIndex = dayIndex,
        Date = $"2026-10-{25 + dayIndex}",
        Title = title,
        Blocks = [],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = [100, 200],
        Sources = [],
    };
}
