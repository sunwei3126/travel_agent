using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PiTravel.Server.Research;

public sealed record SearchOptions(
    double? Count = null,
    string? OriQuestion = null,
    string? Localization = null,
    bool? NeedContent = null);

public sealed record SearchHit(
    string Title,
    string Url,
    string Snippet,
    string? Summary = null,
    string? Content = null,
    string? Date = null,
    double? Authority = null,
    double? RerankScore = null,
    string? SiteName = null);

public sealed record FetchResult(string Title, string Url, string Content);

public sealed class DeepSeekException : Exception
{
    public DeepSeekException(int status, string message)
        : base(message) => Status = status;

    public int Status { get; }
}

/// <summary>
/// The DeepSeek Search/Fetch client, mirroring
/// <c>apps/server/src/deepseek/client.ts</c>. The <see cref="HttpClient"/> is
/// injected so tests can run offline against a fake handler.
/// </summary>
public sealed class DeepSeekClient
{
    public const string DefaultBaseUrl = "https://api.deepseek.com";

    private const int DefaultQps = 5;
    private const int MaxRetries = 3;
    private const int BaseBackoffMs = 500;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly string _apiKey;
    private readonly string _baseUrl;
    private readonly Func<int, Task> _delay;
    private readonly RateLimiter _searchLimiter;
    private readonly RateLimiter _fetchLimiter;

    public DeepSeekClient(
        HttpClient http,
        string apiKey,
        string? baseUrl = null,
        int qps = DefaultQps,
        Func<long>? nowMs = null,
        Func<int, Task>? delay = null)
    {
        _http = http;
        _apiKey = apiKey;
        _baseUrl = (baseUrl ?? DefaultBaseUrl).TrimEnd('/');
        _delay = delay ?? (ms => Task.Delay(ms));
        var clock = nowMs ?? (() => Environment.TickCount64);
        _searchLimiter = new RateLimiter(qps, clock, _delay);
        _fetchLimiter = new RateLimiter(qps, clock, _delay);
    }

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(
        string query,
        SearchOptions? options,
        CancellationToken ct)
    {
        options ??= new SearchOptions();
        var response = await PostAsync<SearchResponse>(
            "/v1/tools/search",
            new SearchRequest(
                query,
                options.Count,
                options.OriQuestion,
                options.Localization,
                options.NeedContent),
            _searchLimiter,
            ct);

        var results = response?.Results ?? Array.Empty<RawSearchHit>();
        return results
            .Select(hit => new SearchHit(
                hit.Title ?? "",
                hit.Url ?? "",
                hit.Snippet ?? "",
                hit.Summary,
                hit.Content,
                hit.Date,
                hit.Authority,
                hit.RerankScore,
                hit.SiteName))
            .ToList();
    }

    public async Task<FetchResult> FetchAsync(string url, CancellationToken ct)
    {
        // The live endpoint returns only `{ content }`; other deployments also send
        // title/url. Normalize both shapes so callers always get a complete result.
        var response = await PostAsync<FetchResponse>(
            "/v1/tools/fetch",
            new FetchRequest(url),
            _fetchLimiter,
            ct);

        var returnedUrl =
            StringOrNull(response?.Url) is { Length: > 0 } value ? value : url;
        return new FetchResult(
            StringOrNull(response?.Title) is { Length: > 0 } title ? title : returnedUrl,
            returnedUrl,
            StringOrNull(response?.Content) ?? "");
    }

    private async Task<T?> PostAsync<T>(
        string path,
        object body,
        RateLimiter limiter,
        CancellationToken ct)
        where T : class
    {
        var endpoint = _baseUrl + path;
        var payload = JsonSerializer.Serialize(body, JsonOptions);

        for (var attempt = 0; ; attempt++)
        {
            await limiter.AcquireAsync();

            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

            using var response = await _http.SendAsync(request, ct);

            if (response.IsSuccessStatusCode)
            {
                var json = await response.Content.ReadAsStringAsync(ct);
                return JsonSerializer.Deserialize<T>(json, JsonOptions);
            }

            var status = (int)response.StatusCode;
            var retryable = status == 429 || status is >= 500 and < 600;
            if (retryable && attempt < MaxRetries)
            {
                await _delay(RetryDelayMs(response, attempt));
                continue;
            }

            throw new DeepSeekException(status, await response.Content.ReadAsStringAsync(ct));
        }
    }

    private static int RetryDelayMs(HttpResponseMessage response, int attempt)
    {
        if (response.Headers.TryGetValues("Retry-After", out var values))
        {
            var header = values.FirstOrDefault();
            if (header is not null &&
                double.TryParse(
                    header,
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out var seconds))
            {
                return (int)Math.Round(seconds * 1000, MidpointRounding.AwayFromZero);
            }
        }

        return BaseBackoffMs * (1 << attempt);
    }

    private static string? StringOrNull(JsonElement? element) =>
        element is { } value && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private sealed record SearchRequest(
        [property: JsonPropertyName("query")] string Query,
        [property: JsonPropertyName("count")] double? Count,
        [property: JsonPropertyName("ori_question")] string? OriQuestion,
        [property: JsonPropertyName("localization")] string? Localization,
        [property: JsonPropertyName("need_content")] bool? NeedContent);

    private sealed record FetchRequest(
        [property: JsonPropertyName("url")] string Url);

    private sealed record SearchResponse(
        [property: JsonPropertyName("results")] IReadOnlyList<RawSearchHit>? Results);

    private sealed record RawSearchHit(
        [property: JsonPropertyName("title")] string? Title,
        [property: JsonPropertyName("url")] string? Url,
        [property: JsonPropertyName("snippet")] string? Snippet,
        [property: JsonPropertyName("summary")] string? Summary,
        [property: JsonPropertyName("content")] string? Content,
        [property: JsonPropertyName("date")] string? Date,
        [property: JsonPropertyName("authority")] double? Authority,
        [property: JsonPropertyName("rerank_score")] double? RerankScore,
        [property: JsonPropertyName("site_name")] string? SiteName);

    private sealed record FetchResponse(
        [property: JsonPropertyName("title")] JsonElement? Title,
        [property: JsonPropertyName("url")] JsonElement? Url,
        [property: JsonPropertyName("content")] JsonElement? Content);
}
