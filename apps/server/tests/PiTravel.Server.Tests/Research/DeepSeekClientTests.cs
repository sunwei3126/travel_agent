using System.Net;
using System.Text.Json;
using PiTravel.Server.Research;

namespace PiTravel.Server.Tests.Research;

/// <summary>
/// Locks the DeepSeek Search/Fetch wire behavior in
/// <c>apps/server/src/deepseek/client.ts</c>: endpoints, auth, mapping, retries,
/// and the fetch fallbacks for a content-only response.
/// </summary>
public sealed class DeepSeekClientTests
{
    [Fact]
    public async Task SearchPostsBearerAuthAndMapsResults()
    {
        var handler = new FakeHttpMessageHandler(FakeHttpMessageHandler.Json(
            """
            {
              "results": [
                {
                  "title": "泰山门票",
                  "url": "https://example.com/a",
                  "snippet": "s",
                  "summary": "sum",
                  "content": "body",
                  "date": "2026-09-01",
                  "authority": 4,
                  "rerank_score": 2.1,
                  "site_name": "官网"
                }
              ]
            }
            """));
        var client = Client(handler, new FakeClock());

        var hits = await client.SearchAsync(
            "泰山 门票",
            new SearchOptions(Count: 5),
            CancellationToken.None);

        var request = Assert.Single(handler.Requests);
        Assert.Equal("POST", request.Method);
        Assert.Equal("https://api.deepseek.com/v1/tools/search", request.Uri);
        Assert.Equal("Bearer k", request.Authorization);
        using var body = JsonDocument.Parse(request.Body);
        Assert.Equal("泰山 门票", body.RootElement.GetProperty("query").GetString());
        Assert.Equal(5, body.RootElement.GetProperty("count").GetDouble());
        Assert.False(body.RootElement.TryGetProperty("ori_question", out _));
        Assert.False(body.RootElement.TryGetProperty("need_content", out _));

        var hit = Assert.Single(hits);
        Assert.Equal("泰山门票", hit.Title);
        Assert.Equal("https://example.com/a", hit.Url);
        Assert.Equal("s", hit.Snippet);
        Assert.Equal("sum", hit.Summary);
        Assert.Equal("body", hit.Content);
        Assert.Equal("2026-09-01", hit.Date);
        Assert.Equal(4, hit.Authority);
        Assert.Equal(2.1, hit.RerankScore);
        Assert.Equal("官网", hit.SiteName);
    }

    [Fact]
    public async Task SearchTreatsMissingResultsAsEmpty()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Json("{}"));

        var hits = await Client(handler, new FakeClock())
            .SearchAsync("q", null, CancellationToken.None);

        Assert.Empty(hits);
    }

    [Fact]
    public async Task SearchRetriesOn429HonoringRetryAfter()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Status(HttpStatusCode.TooManyRequests, retryAfter: "1"),
            FakeHttpMessageHandler.Json("""{"results":[]}"""));
        var clock = new FakeClock();

        var hits = await Client(handler, clock).SearchAsync("q", null, CancellationToken.None);

        Assert.Empty(hits);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(new[] { 1000 }, clock.Delays);
    }

    [Fact]
    public async Task SearchRetriesOn5xxUsingExponentialBackoff()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Status(HttpStatusCode.ServiceUnavailable),
            FakeHttpMessageHandler.Status(HttpStatusCode.BadGateway),
            FakeHttpMessageHandler.Json("""{"results":[]}"""));
        var clock = new FakeClock();

        await Client(handler, clock).SearchAsync("q", null, CancellationToken.None);

        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal(new[] { 500, 1000 }, clock.Delays);
    }

    [Fact]
    public async Task SearchThrowsDeepSeekExceptionWithStatusAfterRetries()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Status(HttpStatusCode.TooManyRequests, body: "slow down"),
            FakeHttpMessageHandler.Status(HttpStatusCode.TooManyRequests, body: "slow down"),
            FakeHttpMessageHandler.Status(HttpStatusCode.TooManyRequests, body: "slow down"),
            FakeHttpMessageHandler.Status(HttpStatusCode.TooManyRequests, body: "slow down"));
        var clock = new FakeClock();

        var error = await Assert.ThrowsAsync<DeepSeekException>(
            () => Client(handler, clock).SearchAsync("q", null, CancellationToken.None));

        Assert.Equal(429, error.Status);
        Assert.Equal("slow down", error.Message);
        Assert.Equal(4, handler.Requests.Count);
        Assert.Equal(new[] { 500, 1000, 2000 }, clock.Delays);
    }

    [Fact]
    public async Task NonRetryableStatusThrowsImmediately()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Status(HttpStatusCode.BadRequest, body: "bad request"));
        var clock = new FakeClock();

        var error = await Assert.ThrowsAsync<DeepSeekException>(
            () => Client(handler, clock).SearchAsync("q", null, CancellationToken.None));

        Assert.Equal(400, error.Status);
        Assert.Single(handler.Requests);
        Assert.Empty(clock.Delays);
    }

    [Fact]
    public async Task FetchDefaultsMissingUrlAndTitle()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Json("""{"content":"正文"}"""));
        var client = Client(handler, new FakeClock());

        var result = await client.FetchAsync("https://example.com/page", CancellationToken.None);

        Assert.Equal("https://example.com/page", result.Url);
        Assert.Equal("https://example.com/page", result.Title);
        Assert.Equal("正文", result.Content);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("https://api.deepseek.com/v1/tools/fetch", request.Uri);
        using var body = JsonDocument.Parse(request.Body);
        Assert.Equal(
            "https://example.com/page",
            body.RootElement.GetProperty("url").GetString());
    }

    [Fact]
    public async Task FetchKeepsReturnedTitleAndUrl()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Json(
                """{"title":"页面标题","url":"https://example.com/final","content":"正文"}"""));

        var result = await Client(handler, new FakeClock())
            .FetchAsync("https://example.com/page", CancellationToken.None);

        Assert.Equal("页面标题", result.Title);
        Assert.Equal("https://example.com/final", result.Url);
        Assert.Equal("正文", result.Content);
    }

    [Fact]
    public async Task FetchIgnoresNonStringTitleAndUrl()
    {
        var handler = new FakeHttpMessageHandler(
            FakeHttpMessageHandler.Json("""{"title":42,"url":{},"content":"正文"}"""));

        var result = await Client(handler, new FakeClock())
            .FetchAsync("https://example.com/page", CancellationToken.None);

        Assert.Equal("https://example.com/page", result.Title);
        Assert.Equal("https://example.com/page", result.Url);
        Assert.Equal("正文", result.Content);
    }

    private static DeepSeekClient Client(FakeHttpMessageHandler handler, FakeClock clock) =>
        new(
            new HttpClient(handler),
            "k",
            qps: 5,
            nowMs: clock.NowMs,
            delay: clock.Delay);
}
