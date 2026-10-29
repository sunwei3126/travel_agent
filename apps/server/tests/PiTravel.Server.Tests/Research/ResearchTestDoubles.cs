using System.Net;
using System.Text;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Tests.Research;

/// <summary>
/// An injected clock and delay for the rate limiter and client retry tests. Every
/// delay advances the clock, so a test can assert the exact wait sequence without
/// sleeping.
/// </summary>
internal sealed class FakeClock
{
    public long Now { get; private set; }

    public List<int> Delays { get; } = [];

    public Func<long> NowMs => () => Now;

    public Func<int, Task> Delay => ms =>
    {
        Delays.Add(ms);
        Now += ms;
        return Task.CompletedTask;
    };
}

internal sealed record CapturedRequest(
    string Method,
    string Uri,
    string? Authorization,
    string Body);

/// <summary>A queued-response <see cref="HttpMessageHandler"/> that records requests.</summary>
internal sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpResponseMessage>> _responses;

    public FakeHttpMessageHandler(params Func<HttpResponseMessage>[] responses) =>
        _responses = new Queue<Func<HttpResponseMessage>>(responses);

    public List<CapturedRequest> Requests { get; } = [];

    public static Func<HttpResponseMessage> Json(
        string json,
        HttpStatusCode status = HttpStatusCode.OK) =>
        () => new HttpResponseMessage(status)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };

    public static Func<HttpResponseMessage> Status(
        HttpStatusCode status,
        string? retryAfter = null,
        string body = "") =>
        () =>
        {
            var response = new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "text/plain"),
            };
            if (retryAfter is not null)
            {
                response.Headers.TryAddWithoutValidation("Retry-After", retryAfter);
            }
            return response;
        };

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(new CapturedRequest(
            request.Method.Method,
            request.RequestUri?.ToString() ?? "",
            request.Headers.Authorization?.ToString(),
            request.Content is null
                ? ""
                : await request.Content.ReadAsStringAsync(cancellationToken)));

        if (_responses.Count == 0)
        {
            throw new InvalidOperationException("FakeHttpMessageHandler ran out of responses.");
        }

        return _responses.Dequeue()();
    }
}

internal static class TestSource
{
    public static TripSource Create(
        string id = "src",
        string title = "标题",
        string url = "https://example.com/page",
        string snippet = "",
        string? date = null,
        double? authority = null,
        double? rerankScore = null,
        string? content = null,
        string? fetchedAt = null,
        string kind = "search",
        string query = "q") => new()
    {
        Id = id,
        Query = query,
        Title = title,
        Url = url,
        Snippet = snippet,
        Date = date,
        Authority = authority,
        RerankScore = rerankScore,
        Content = content,
        FetchedAt = fetchedAt,
        Kind = kind,
    };
}
