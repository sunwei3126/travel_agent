using PiTravel.Server.Contracts;
using PiTravel.Server.Research;

namespace PiTravel.Server.Tests.Research;

/// <summary>
/// Locks the model-visible research strings in
/// <c>apps/server/src/research/format.ts</c>.
/// </summary>
public sealed class FormattingTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void SearchResultsFormatsTheModelVisibleBlock()
    {
        var source = TestSource.Create(
            id: "abc123",
            title: "泰山",
            url: "https://example.com/a",
            snippet: "s",
            date: "2026-10-01",
            authority: 4);

        var text = Formatting.SearchResults(
            "泰山 门票",
            ["abc123"],
            new Dictionary<string, TripSource> { ["abc123"] = source },
            Now);

        Assert.Equal(
            "Found 1 source(s) for \"泰山 门票\", ranked by freshness and authority.\n" +
            "Cite the bracketed ids; snippets are leads, so fetch a page before using a hard fact.\n" +
            "[abc123] 泰山\n" +
            "  url: https://example.com/a\n" +
            "  date: 2026-10-01 (fresh); authority: 4; fetched: no\n" +
            "  snippet: s",
            text);
    }

    [Fact]
    public void SearchResultsTellsTheModelNotToPlanFromMemoryWhenEmpty()
    {
        var text = Formatting.SearchResults(
            "空白查询",
            [],
            new Dictionary<string, TripSource>(),
            Now);

        Assert.Equal(
            "Found 0 sources for \"空白查询\".\n" +
            "Do not plan from memory; try a different query or tell the user what is missing.",
            text);
    }

    [Fact]
    public void SearchResultsIncludesFetchedContentOnlyForVerifiedSources()
    {
        var fetched = TestSource.Create(
            id: "fetched",
            title: "官网",
            url: "https://example.com/a",
            snippet: "s",
            content: "正文",
            fetchedAt: "2026-10-19T00:00:00.000Z",
            kind: "fetch");
        var unfetched = TestSource.Create(
            id: "unfetched",
            title: "博客",
            url: "https://example.com/b",
            snippet: "s2");
        var sources = new Dictionary<string, TripSource>
        {
            ["fetched"] = fetched,
            ["unfetched"] = unfetched,
        };

        var text = Formatting.SearchResults("q", ["fetched", "unfetched"], sources, Now);

        Assert.Contains("  fetchedContent: 正文", text);
        Assert.Single(
            text.Split('\n'),
            line => line.Contains("fetchedContent:"));
    }

    [Fact]
    public void FormattingTruncatesSnippetAt300Chars()
    {
        var snippet = new string('a', 400);
        var source = TestSource.Create(id: "s1", snippet: snippet);

        var text = Formatting.SearchResults(
            "q",
            ["s1"],
            new Dictionary<string, TripSource> { ["s1"] = source },
            Now);

        Assert.Contains(new string('a', 300) + "…[truncated]", text);
        Assert.DoesNotContain(new string('a', 301), text);
    }

    [Fact]
    public void FormattingNormalizesWhitespaceBeforeTruncating()
    {
        var source = TestSource.Create(id: "s1", snippet: "  红门 \n 索道  ");

        var text = Formatting.SearchResults(
            "q",
            ["s1"],
            new Dictionary<string, TripSource> { ["s1"] = source },
            Now);

        Assert.Contains("  snippet: 红门 索道", text);
    }

    [Fact]
    public void FormattingTruncatesFetchedContentAt1000Chars()
    {
        var content = new string('b', 1200);
        var source = TestSource.Create(
            id: "s1",
            content: content,
            fetchedAt: "2026-10-19T00:00:00.000Z",
            kind: "fetch");

        var text = Formatting.SearchResults(
            "q",
            ["s1"],
            new Dictionary<string, TripSource> { ["s1"] = source },
            Now);

        Assert.Contains(new string('b', 1000) + "…[truncated]", text);
        Assert.DoesNotContain(new string('b', 1001), text);
    }

    [Fact]
    public void FetchResultTruncatesContentAt4000Chars()
    {
        var content = new string('c', 4100);
        var source = TestSource.Create(
            id: "s1",
            content: content,
            fetchedAt: "2026-10-19T00:00:00.000Z",
            kind: "fetch");

        var text = Formatting.FetchResult(source, Now);

        Assert.Contains(new string('c', 4000) + "…[truncated]", text);
        Assert.DoesNotContain(new string('c', 4001), text);
    }

    [Fact]
    public void FetchResultFormatsTheModelVisibleBlock()
    {
        var source = TestSource.Create(
            id: "abc123",
            title: "泰山",
            url: "https://example.com/a",
            date: "2026-10-01",
            authority: 4,
            content: "正文",
            fetchedAt: "2026-10-19T00:00:00.000Z",
            kind: "fetch");

        var text = Formatting.FetchResult(source, Now);

        Assert.Equal(
            "Fetched [abc123] \"泰山\"\n" +
            "url: https://example.com/a\n" +
            "fetchedAt: 2026-10-19T00:00:00.000Z; date: 2026-10-01 (fresh); authority: 4\n" +
            "content (truncated to 4000 chars):\n" +
            "正文",
            text);
    }

    [Fact]
    public void FetchResultFallsBackForUntitledAndEmptyPages()
    {
        var source = TestSource.Create(id: "s1", title: "", content: "");

        var text = Formatting.FetchResult(source, Now);

        Assert.Contains("Fetched [s1] \"(untitled)\"", text);
        Assert.Contains("fetchedAt: unknown; date: unknown (unknown); authority: unknown", text);
        Assert.EndsWith("\n(empty page)", text);
    }
}
