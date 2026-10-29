using PiTravel.Server.Contracts;
using PiTravel.Server.Research;

namespace PiTravel.Server.Tests.Research;

/// <summary>
/// Locks the freshness window and ranking in
/// <c>apps/server/src/research/freshness.ts</c>.
/// </summary>
public sealed class FreshnessTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("2026-10-19", "fresh")]
    [InlineData("2026-07-21", "fresh")]
    [InlineData("2026-07-20", "stale")]
    [InlineData("2027-01-17", "fresh")]
    [InlineData("2027-01-18", "stale")]
    [InlineData("2023-01-01", "stale")]
    [InlineData("", "unknown")]
    [InlineData(null, "unknown")]
    [InlineData("not a date", "unknown")]
    public void OfMeasuresTheAbsoluteDistanceAgainstTheNinetyDayWindow(
        string? date,
        string expected)
    {
        Assert.Equal(expected, Freshness.Of(TestSource.Create(date: date), Now));
    }

    [Fact]
    public void IsVerifiedFactRequiresFetchedAt()
    {
        Assert.False(Freshness.IsVerifiedFact(TestSource.Create()));

        var fetched = TestSource.Create(fetchedAt: "2026-10-19T00:00:00.000Z");

        Assert.True(Freshness.IsVerifiedFact(fetched));
    }

    [Fact]
    public void RankOrdersByFreshnessThenAuthorityAndRerankDescending()
    {
        var freshLow = TestSource.Create(id: "fresh-low", date: "2026-10-01", authority: 1);
        var freshHigh = TestSource.Create(id: "fresh-high", date: "2026-10-01", authority: 4);
        var freshReranked = TestSource.Create(
            id: "fresh-reranked",
            date: "2026-10-01",
            authority: 4,
            rerankScore: 1);
        var unknown = TestSource.Create(id: "unknown", authority: 9);
        var stale = TestSource.Create(id: "stale", date: "2020-01-01", authority: 9);

        var ranked = Freshness.Rank(
            [stale, unknown, freshLow, freshHigh, freshReranked],
            Now);

        Assert.Equal(
            new[] { "fresh-reranked", "fresh-high", "fresh-low", "unknown", "stale" },
            ranked.Select(source => source.Id));
    }

    [Fact]
    public void RankUsesAuthorityTimesTenPlusRerankAsTheTieBreaker()
    {
        var authorityThree = TestSource.Create(
            id: "authority-three",
            date: "2026-10-01",
            authority: 3,
            rerankScore: 2);
        var authorityFour = TestSource.Create(
            id: "authority-four",
            date: "2026-10-01",
            authority: 4);

        var ranked = Freshness.Rank([authorityThree, authorityFour], Now);

        Assert.Equal("authority-four", ranked[0].Id);
    }
}
