using PiTravel.Server.Artifacts;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Tests.Artifacts;

/// <summary>
/// Locks the day-sketch generation, retry, and placeholder fallback behavior to
/// <c>apps/server/src/svg/generate.ts</c>.
/// </summary>
public sealed class SketchGeneratorTests
{
    private static DayCard SampleDay() => new()
    {
        DayIndex = 1,
        Date = "2026-10-26",
        Title = "红门",
        Blocks =
        [
            new DayBlock
            {
                Time = "08:00",
                Title = "红门宫",
                Detail = "登山起点",
                Claims = [],
            },
            new DayBlock
            {
                Time = "10:00",
                Title = "中天门",
                Detail = "半山腰休整",
                Claims = [],
            },
        ],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = [100, 200],
        Sources = [],
        SvgStatus = "pending",
        UpdatedAt = "",
    };

    [Fact]
    public async Task AcceptsValidSvgOnFirstTry()
    {
        var calls = new List<string>();
        const string validSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><rect width=\"10\" height=\"10\"/></svg>";

        var result = await SketchGenerator.GenerateAsync(
            SampleDay(),
            (prompt, _) =>
            {
                calls.Add(prompt);
                return Task.FromResult(validSvg);
            },
            CancellationToken.None);

        Assert.Single(calls);
        Assert.Equal("ok", result.Status);
        Assert.Null(result.Error);
        Assert.Contains("<svg", result.Svg, StringComparison.Ordinal);
        Assert.Contains("Day 1: 红门", calls[0], StringComparison.Ordinal);
        Assert.Contains("- 红门宫", calls[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task RetriesOnceThenFallsBackToPlaceholder()
    {
        var calls = new List<string>();

        var result = await SketchGenerator.GenerateAsync(
            SampleDay(),
            (prompt, _) =>
            {
                calls.Add(prompt);
                return Task.FromResult("not an svg");
            },
            CancellationToken.None);

        Assert.Equal(2, calls.Count);
        Assert.Equal("failed", result.Status);
        Assert.Equal(Placeholder.Build("Day 1 · 红门"), result.Svg);
        Assert.Equal("No SVG found in response", result.Error);
        Assert.Contains("The previous response was rejected: No SVG found in response", calls[1], StringComparison.Ordinal);
        Assert.Contains("not an svg", calls[1], StringComparison.Ordinal);
    }

    [Fact]
    public async Task TreatsGeneratorExceptionAsFailedAttempt()
    {
        var calls = new List<string>();
        const string validSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><rect width=\"10\" height=\"10\"/></svg>";

        var result = await SketchGenerator.GenerateAsync(
            SampleDay(),
            (prompt, _) =>
            {
                calls.Add(prompt);
                if (calls.Count == 1)
                {
                    throw new InvalidOperationException("provider 500");
                }
                return Task.FromResult(validSvg);
            },
            CancellationToken.None);

        Assert.Equal(2, calls.Count);
        Assert.Equal("ok", result.Status);
        Assert.Null(result.Error);
        Assert.Contains("<rect", result.Svg, StringComparison.Ordinal);
        Assert.Contains("The previous response was rejected: provider 500", calls[1], StringComparison.Ordinal);
    }

    [Fact]
    public async Task InvalidModeAlwaysReturnsPlaceholder()
    {
        const string validSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><rect width=\"10\" height=\"10\"/></svg>";
        var previous = Environment.GetEnvironmentVariable("PITRAVEL_TEST_SVG_MODE");
        Environment.SetEnvironmentVariable("PITRAVEL_TEST_SVG_MODE", "invalid");
        try
        {
            var calls = 0;
            var result = await SketchGenerator.GenerateAsync(
                SampleDay(),
                (_, _) =>
                {
                    calls++;
                    return Task.FromResult(validSvg);
                },
                CancellationToken.None);

            Assert.Equal(0, calls);
            Assert.Equal("failed", result.Status);
            Assert.Equal(Placeholder.Build("Day 1 · 红门"), result.Svg);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PITRAVEL_TEST_SVG_MODE", previous);
        }
    }
}
