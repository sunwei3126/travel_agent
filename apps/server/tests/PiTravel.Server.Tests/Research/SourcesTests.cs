using PiTravel.Server.Contracts;
using PiTravel.Server.Research;

namespace PiTravel.Server.Tests.Research;

/// <summary>
/// Locks the source identity and merge rules in
/// <c>apps/server/src/research/sources.ts</c>.
/// </summary>
public sealed class SourcesTests
{
    [Fact]
    public void NormalizeUrlDropsFragmentAndTrailingSlash()
    {
        Assert.Equal(
            "https://example.com/a",
            Sources.NormalizeUrl("  HTTPS://Example.COM/a/#frag  "));
        Assert.Equal(
            "https://example.com/a?q=1",
            Sources.NormalizeUrl("https://example.com/a/?q=1#x"));
        Assert.Equal(
            "https://example.com/",
            Sources.NormalizeUrl("https://example.com/"));
    }

    [Fact]
    public void NormalizeUrlReturnsTrimmedInputWhenUrlDoesNotParse()
    {
        Assert.Equal("not a url", Sources.NormalizeUrl("  not a url  "));
        Assert.Equal("example.com/path", Sources.NormalizeUrl("example.com/path"));
    }

    [Fact]
    public void SourceIdIsStableSha256PrefixOfNormalizedUrl()
    {
        var id = SourceIds.ForUrl("https://example.com/a#x");

        Assert.Equal(SourceIds.ForUrl("https://example.com/a"), id);
        Assert.Equal("2dce0a4c5044", id);
        Assert.Equal(12, id.Length);
    }

    [Fact]
    public void AddSearchKeepsHighestAuthorityAndRerankForDuplicateUrl()
    {
        var sources = new Dictionary<string, TripSource>();
        var ids = Sources.AddSearch(
            sources,
            "泰山",
            [new SearchHit("A", "https://a.com", "s", Authority: 3)]);
        Sources.AddSearch(
            sources,
            "泰山",
            [new SearchHit("A2", "https://a.com/#x", "s2", Authority: 4, RerankScore: 2.1)]);

        var source = Assert.Single(sources).Value;
        Assert.Equal(ids[0], source.Id);
        Assert.Equal(4, source.Authority);
        Assert.Equal(2.1, source.RerankScore);
        Assert.Equal("A", source.Title);
        Assert.Equal("s", source.Snippet);
        Assert.Equal("search", source.Kind);
    }

    [Fact]
    public void AddSearchStoresOptionalFieldsWhenPresent()
    {
        var sources = new Dictionary<string, TripSource>();

        var ids = Sources.AddSearch(
            sources,
            "q",
            [
                new SearchHit(
                    "A",
                    "https://a.com",
                    "s",
                    Summary: "sum",
                    Content: "body",
                    Date: "2026-10-01",
                    Authority: 4,
                    RerankScore: 2.1,
                    SiteName: "官网"),
            ]);

        var source = sources[ids[0]];
        Assert.Equal("sum", source.Summary);
        Assert.Equal("body", source.Content);
        Assert.Equal("2026-10-01", source.Date);
        Assert.Equal(4, source.Authority);
        Assert.Equal(2.1, source.RerankScore);
        Assert.Equal("q", source.Query);
    }

    [Fact]
    public void AddFetchMarksSourceAsFetchedAndChangesKind()
    {
        var sources = new Dictionary<string, TripSource>();
        var ids = Sources.AddSearch(
            sources,
            "q",
            [new SearchHit("A", "https://a.com/p", "s")]);

        var id = Sources.AddFetch(
            sources,
            new FetchResult("A", "https://a.com/p", "正文"),
            new DateTimeOffset(2026, 10, 19, 0, 0, 0, TimeSpan.Zero));

        Assert.Equal(ids[0], id);
        var source = Assert.Single(sources).Value;
        Assert.Equal("正文", source.Content);
        Assert.Equal("2026-10-19T00:00:00.000Z", source.FetchedAt);
        Assert.Equal("fetch", source.Kind);
        Assert.True(Freshness.IsVerifiedFact(source));
    }

    [Fact]
    public void AddFetchCreatesAnUnseenSource()
    {
        var sources = new Dictionary<string, TripSource>();

        var id = Sources.AddFetch(
            sources,
            new FetchResult("页面", "https://a.com/p", "正文"),
            new DateTimeOffset(2026, 10, 19, 0, 0, 0, TimeSpan.Zero));

        var source = sources[id];
        Assert.Equal("", source.Query);
        Assert.Equal("", source.Snippet);
        Assert.Equal("页面", source.Title);
        Assert.Equal("正文", source.Content);
        Assert.Equal("fetch", source.Kind);
    }

    [Fact]
    public void FindByUrlMatchesAcrossFragmentsAndTrailingSlashes()
    {
        var sources = new Dictionary<string, TripSource>
        {
            ["abc"] = TestSource.Create(id: "abc", url: "https://a.com/p/"),
        };

        Assert.Equal("abc", Sources.FindByUrl(sources, "https://a.com/p#x")?.Id);
        Assert.Null(Sources.FindByUrl(sources, "https://a.com/other"));
    }
}
