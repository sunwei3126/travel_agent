using PiTravel.Server.Contracts;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Tests.Planning;

/// <summary>
/// Locks the required-field list and ordering to <c>missingBriefFields</c> in
/// <c>packages/shared/src/trip.ts</c>.
/// </summary>
public sealed class BriefRulesTests
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
    public void MissingFieldsOfEmptyBriefListsAllEight()
    {
        Assert.Equal(
            new[]
            {
                "destination",
                "origin",
                "startDate",
                "days",
                "budgetCny",
                "companions",
                "fitness",
                "interests",
            },
            BriefRules.MissingFields(new TripBrief()));
    }

    [Fact]
    public void CompleteBriefHasNoMissingFields()
    {
        Assert.Empty(BriefRules.MissingFields(CompleteBrief()));
        Assert.True(BriefRules.IsComplete(CompleteBrief()));
    }

    [Fact]
    public void StartDateMustMatchIsoPattern()
    {
        var brief = CompleteBrief() with { StartDate = "2026/10/26" };

        Assert.Equal(new[] { "startDate" }, BriefRules.MissingFields(brief));
        Assert.False(BriefRules.IsComplete(brief));
    }

    [Fact]
    public void InterestsMustBeNonEmpty()
    {
        Assert.Equal(
            new[] { "interests" },
            BriefRules.MissingFields(CompleteBrief() with { Interests = [] }));
    }

    [Fact]
    public void WhitespaceOnlyTextAndNonPositiveBudgetAreMissing()
    {
        var brief = CompleteBrief() with { Destination = "  ", BudgetCny = 0, Days = 1.5 };

        // Fractional days pass the completeness check; BriefValidator rejects them later.
        Assert.Equal(new[] { "destination", "budgetCny" }, BriefRules.MissingFields(brief));
    }
}

/// <summary>
/// Locks the date and day rules, their messages, and their ordering to
/// <c>validateBrief</c> in <c>apps/server/src/plan/validate.ts</c>.
/// </summary>
public sealed class BriefValidatorTests
{
    private static readonly DateTimeOffset Now =
        new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

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
    public void RejectsImpossibleCalendarDate()
    {
        var errors = BriefValidator.Validate(
            CompleteBrief() with { StartDate = "2026-02-30" },
            Now);

        Assert.Equal(
            new[] { "startDate must be a real calendar date (YYYY-MM-DD)" },
            errors);
    }

    [Theory]
    [InlineData("2026-02-30", false)]
    [InlineData("2026-13-01", false)]
    [InlineData("2028-02-29", true)]
    [InlineData("2026-2-3", false)]
    public void IsValidCalendarDateAcceptsOnlyRealDays(string value, bool expected)
    {
        Assert.Equal(expected, BriefValidator.IsValidCalendarDate(value));
    }

    [Fact]
    public void RejectsPastStartDate()
    {
        var errors = BriefValidator.Validate(
            CompleteBrief() with { StartDate = "2026-10-18" },
            Now);

        Assert.Equal(new[] { "startDate must not be in the past" }, errors);
    }

    [Fact]
    public void RejectsZeroOrFractionalDays()
    {
        // Zero also fails completeness, which is reported before the day rule.
        Assert.Equal(
            new[] { "days", "days must be at least 1" },
            BriefValidator.Validate(CompleteBrief() with { Days = 0 }, Now));
        Assert.Equal(
            new[] { "days must be at least 1" },
            BriefValidator.Validate(CompleteBrief() with { Days = 1.5 }, Now));
    }

    [Fact]
    public void RequireCompleteFalseOnlyChecksDateAndDays()
    {
        var brief = new TripBrief { StartDate = "2026-10-26" };

        Assert.Empty(BriefValidator.Validate(brief, Now, requireComplete: false));
        Assert.Equal(
            new[]
            {
                "destination",
                "origin",
                "days",
                "budgetCny",
                "companions",
                "fitness",
                "interests",
            },
            BriefValidator.Validate(brief, Now));
    }
}
