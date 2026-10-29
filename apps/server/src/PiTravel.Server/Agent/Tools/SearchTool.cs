using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Durable.Harness;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;
using PiTravel.Server.Research;

namespace PiTravel.Server.Agent.Tools;

public sealed record SearchToolArgs
{
    public required string Query { get; init; }
    public double? Count { get; init; }
    public string? OriQuestion { get; init; }
    public string? Localization { get; init; }
    public bool? NeedContent { get; init; }
}

/// <summary>
/// Searches the web with DeepSeek, stores results as trip sources, and auto-fetches
/// up to two pages for verified content, mirroring
/// <c>apps/server/src/agent/tools/search.ts</c>.
/// </summary>
public sealed class SearchTool : IToolRegistration
{
    public const int AutoFetchLimit = 2;

    public static readonly ToolSchema Schema = new(new Dictionary<string, object?>
    {
        ["type"] = "object",
        ["properties"] = new Dictionary<string, object?>
        {
            ["query"] = new Dictionary<string, object?>
            {
                ["type"] = "string",
                ["description"] = "Search query",
            },
            ["count"] = new Dictionary<string, object?>
            {
                ["type"] = "number",
                ["description"] = "Maximum number of results to return",
            },
            ["oriQuestion"] = new Dictionary<string, object?>
            {
                ["type"] = "string",
                ["description"] = "The user's original question",
            },
            ["localization"] = new Dictionary<string, object?>
            {
                ["type"] = "string",
                ["description"] = "Language or locale for results",
            },
            ["needContent"] = new Dictionary<string, object?>
            {
                ["type"] = "boolean",
                ["description"] = "Ask for page content in the results",
            },
        },
        ["required"] = new[] { "query" },
    });

    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);

    private static readonly JsonSerializerOptions CacheKeyJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly TravelDeps _deps;

    public SearchTool(TravelDeps deps) => _deps = deps;

    public string Name => "deepseek_search";

    public string Description =>
        "Search the web with DeepSeek, store the results as trip sources, and fetch the top two pages for verified content.";

    public ToolSchema Parameters => Schema;

    public string? Replay => "safe";

    public ToolExecutionMode? ExecutionMode => null;

    public ToolOutputLimits? OutputLimits => null;

    public object? PrepareArguments(object args) => args;

    public async Task<ToolExecutionResult> ExecuteAsync(
        object args,
        IToolExecutionApi api,
        Context context)
    {
        var parsed = UpdateBriefTool.ReadArgs<SearchToolArgs>(args);
        var options = new SearchOptions(
            parsed.Count,
            parsed.OriQuestion,
            parsed.Localization,
            parsed.NeedContent);
        var cacheKey = SearchCacheKey(parsed.Query, options);
        var now = _deps.Now();
        var ct = context.AbortSignal ?? CancellationToken.None;

        var cached = Docs.ReadSearchCache(
            await api.SnapshotAsync(Docs.TripSearchCacheDoc, api.ConversationId, context));
        var currentSources = Docs.ReadSources(
            await api.SnapshotAsync(Docs.TripSourcesDoc, api.ConversationId, context));
        var current = Docs.ReadResearch(
            await api.SnapshotAsync(Docs.TripResearchDoc, api.ConversationId, context));
        var fetchRemaining = _deps.FetchCap - current.FetchCount;

        var cachedIds = cached.TryGetValue(cacheKey, out var cachedEntry)
            ? cachedEntry.SourceIds
            : [];
        if (cachedIds.Count > 0 && cachedIds.All(currentSources.ContainsKey))
        {
            var cachedCandidates = cachedIds
                .Where(currentSources.ContainsKey)
                .Select(id => currentSources[id])
                .ToList();
            var cachedFetched = await AutoFetchAsync(
                api,
                context,
                now,
                cachedCandidates,
                fetchRemaining,
                ct);
            var cachedOutputSources = MergeSources(currentSources, cachedFetched);
            var cachedOutputIds = WithFetchedIds(cachedIds, cachedFetched);
            return new ToolExecutionResult
            {
                Content =
                [
                    new TextContent(
                        Formatting.SearchResults(parsed.Query, cachedOutputIds, cachedOutputSources, now)),
                ],
                Details = new Dictionary<string, object?>
                {
                    ["sourceIds"] = cachedIds.Cast<object?>().ToList(),
                },
            };
        }

        ToolCaps.EnforceCap(current.SearchCount, _deps.SearchCap, "search");

        var hits = await _deps.DeepSeek.SearchAsync(parsed.Query, options, ct);

        var (sourceIds, candidates) = await api.CommitAsync(
            async tx =>
            {
                var researchDoc = await tx.DocAsync(Docs.TripResearchDoc, api.ConversationId);
                var research = Docs.ReadResearch(researchDoc.Draft);
                ToolCaps.EnforceCap(research.SearchCount, _deps.SearchCap, "search");

                var sourcesDoc = await tx.DocAsync(Docs.TripSourcesDoc, api.ConversationId);
                var stored = Docs.ReadSources(sourcesDoc.Draft);
                var ids = Sources.AddSearch(stored, parsed.Query, hits);
                Docs.Write(sourcesDoc, stored);

                var cacheDoc = await tx.DocAsync(Docs.TripSearchCacheDoc, api.ConversationId);
                var cache = Docs.ReadSearchCache(cacheDoc.Draft);
                cache[cacheKey] = new SearchCacheEntry
                {
                    SourceIds = ids,
                    At = now.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                };
                Docs.Write(cacheDoc, cache);

                var attempts = new Dictionary<string, int>(
                    research.SearchAttempts ?? new Dictionary<string, int>());
                attempts[cacheKey] = (attempts.TryGetValue(cacheKey, out var prev) ? prev : 0) + 1;
                Docs.Write(
                    researchDoc,
                    research with
                    {
                        SearchCount = research.SearchCount + 1,
                        SearchAttempts = attempts,
                    });

                return (
                    SourceIds: ids,
                    Candidates: ids.Select(id => stored[id]).ToList());
            },
            context);

        var fetched = await AutoFetchAsync(
            api,
            context,
            now,
            candidates,
            fetchRemaining,
            ct);

        var latestDict = await api.SnapshotAsync(
            Docs.TripSourcesDoc,
            api.ConversationId,
            context);
        var fallback = candidates.ToDictionary(c => c.Id, c => c);
        var latest = latestDict is not null ? Docs.ReadSources(latestDict) : fallback;
        var outputSources = MergeSources(latest, fetched);
        var outputIds = WithFetchedIds(sourceIds, fetched);

        return new ToolExecutionResult
        {
            Content =
            [
                new TextContent(
                    Formatting.SearchResults(parsed.Query, outputIds, outputSources, now)),
            ],
            Details = new Dictionary<string, object?>
            {
                ["sourceIds"] = sourceIds.Cast<object?>().ToList(),
            },
        };
    }

    public static string SearchCacheKey(string query, SearchOptions? options = null)
    {
        options ??= new SearchOptions();
        return JsonSerializer.Serialize(
            new CacheKeyPayload(
                Whitespace.Replace(query.Trim(), " "),
                options.Count,
                options.OriQuestion?.Trim(),
                options.Localization,
                options.NeedContent ?? false),
            CacheKeyJsonOptions);
    }

    public static IReadOnlyList<TripSource> SelectFetchTargets(
        IEnumerable<TripSource> items,
        int limit = AutoFetchLimit) =>
        SelectFetchTargetsCore(items, s => s.Url, s => s.Authority, limit);

    public static IReadOnlyList<SearchHit> SelectFetchTargets(
        IEnumerable<SearchHit> items,
        int limit = AutoFetchLimit) =>
        SelectFetchTargetsCore(items, h => h.Url, h => h.Authority, limit);

    private static IReadOnlyList<T> SelectFetchTargetsCore<T>(
        IEnumerable<T> items,
        Func<T, string> getUrl,
        Func<T, double?> getAuthority,
        int limit)
        where T : notnull
    {
        if (limit <= 0)
        {
            return [];
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var unique = new List<T>();
        foreach (var item in items)
        {
            var key = Sources.NormalizeUrl(getUrl(item));
            if (seen.Add(key))
            {
                unique.Add(item);
            }
        }

        var preferred = unique.Where(item => (getAuthority(item) ?? 0) >= 3).ToList();
        var selected = preferred.Take(limit).ToList();
        foreach (var item in unique)
        {
            if (selected.Count >= limit)
            {
                break;
            }

            if (!selected.Contains(item))
            {
                selected.Add(item);
            }
        }

        return selected;
    }

    private async Task<IReadOnlyList<TripSource>> AutoFetchAsync(
        IToolExecutionApi api,
        Context context,
        DateTimeOffset now,
        IReadOnlyList<TripSource> candidates,
        int remaining,
        CancellationToken ct)
    {
        var targets = SelectFetchTargets(
            candidates.Where(source => source.FetchedAt is null),
            Math.Min(AutoFetchLimit, Math.Max(0, remaining)));
        var fetched = new List<TripSource>();

        foreach (var target in targets)
        {
            try
            {
                var raw = await _deps.DeepSeek.FetchAsync(target.Url, ct);
                var url = !string.IsNullOrEmpty(raw.Url) ? raw.Url : target.Url;
                var title = !string.IsNullOrEmpty(raw.Title) ? raw.Title : url;
                var result = new FetchResult(title, url, raw.Content ?? "");

                var source = await api.CommitAsync<TripSource?>(
                    async tx =>
                    {
                        var researchDoc = await tx.DocAsync(Docs.TripResearchDoc, api.ConversationId);
                        var research = Docs.ReadResearch(researchDoc.Draft);
                        if (research.FetchCount >= _deps.FetchCap)
                        {
                            return null;
                        }

                        var sourcesDoc = await tx.DocAsync(Docs.TripSourcesDoc, api.ConversationId);
                        var stored = Docs.ReadSources(sourcesDoc.Draft);
                        var id = Sources.AddFetch(stored, result, now);
                        Docs.Write(sourcesDoc, stored);

                        var attemptKey = Sources.NormalizeUrl(target.Url);
                        var attempts = new Dictionary<string, int>(
                            research.FetchAttempts ?? new Dictionary<string, int>());
                        attempts[attemptKey] =
                            (attempts.TryGetValue(attemptKey, out var prev) ? prev : 0) + 1;
                        Docs.Write(
                            researchDoc,
                            research with
                            {
                                FetchCount = research.FetchCount + 1,
                                FetchAttempts = attempts,
                            });

                        return stored[id];
                    },
                    context);

                if (source is not null)
                {
                    fetched.Add(source);
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    $"[deepseek_search] auto-fetch failed for {target.Url}: {error.Message}");
            }
        }

        return fetched;
    }

    private static IReadOnlyDictionary<string, TripSource> MergeSources(
        IReadOnlyDictionary<string, TripSource> sources,
        IReadOnlyList<TripSource> fetched)
    {
        if (fetched.Count == 0)
        {
            return sources;
        }

        var merged = new Dictionary<string, TripSource>(sources);
        foreach (var source in fetched)
        {
            merged[source.Id] = source;
        }

        return merged;
    }

    private static IReadOnlyList<string> WithFetchedIds(
        IReadOnlyList<string> sourceIds,
        IReadOnlyList<TripSource> fetched) =>
        sourceIds.Concat(fetched.Select(s => s.Id)).Distinct().ToList();

    private sealed record CacheKeyPayload(
        [property: JsonPropertyName("query")] string Query,
        [property: JsonPropertyName("count")] double? Count,
        [property: JsonPropertyName("oriQuestion")] string? OriQuestion,
        [property: JsonPropertyName("localization")] string? Localization,
        [property: JsonPropertyName("needContent")] bool NeedContent);
}
