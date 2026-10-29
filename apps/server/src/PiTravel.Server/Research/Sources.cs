using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Research;

/// <summary>Stable source ids derived from the normalized URL.</summary>
public static class SourceIds
{
    public static string ForUrl(string url)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(Sources.NormalizeUrl(url)));
        return Convert.ToHexString(hash).ToLowerInvariant()[..12];
    }
}

/// <summary>
/// The source store, mirroring <c>apps/server/src/research/sources.ts</c>: dedupe
/// by normalized URL, keep the highest authority/rerank, and mark a source verified
/// when its page has been fetched.
/// </summary>
public static class Sources
{
    /// <summary>
    /// Cache identity for a URL: trims, lower-cases the scheme and host, drops the
    /// fragment, and removes a trailing slash. Invalid URLs are returned trimmed so
    /// callers can still compare exact strings.
    /// </summary>
    public static string NormalizeUrl(string value)
    {
        var trimmed = value.Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            return trimmed;
        }

        var path = uri.AbsolutePath;
        if (path.Length > 1)
        {
            path = path.TrimEnd('/');
        }

        return $"{uri.Scheme.ToLowerInvariant()}://{uri.Authority.ToLowerInvariant()}{path}{uri.Query}";
    }

    /// <summary>Finds a stored source by normalized URL, regardless of how it was added.</summary>
    public static TripSource? FindByUrl(
        IReadOnlyDictionary<string, TripSource> sources,
        string url)
    {
        var normalized = NormalizeUrl(url);
        foreach (var source in sources.Values)
        {
            if (NormalizeUrl(source.Url) == normalized)
            {
                return source;
            }
        }

        return null;
    }

    public static IReadOnlyList<string> AddSearch(
        IDictionary<string, TripSource> sources,
        string query,
        IReadOnlyList<SearchHit> hits)
    {
        var ids = new List<string>(hits.Count);
        foreach (var hit in hits)
        {
            var id = SourceIds.ForUrl(hit.Url);
            if (sources.TryGetValue(id, out var existing))
            {
                sources[id] = existing with
                {
                    Authority = Highest(existing.Authority, hit.Authority),
                    RerankScore = Highest(existing.RerankScore, hit.RerankScore),
                };
            }
            else
            {
                sources[id] = new TripSource
                {
                    Id = id,
                    Query = query,
                    Title = hit.Title,
                    Url = hit.Url,
                    Snippet = hit.Snippet,
                    Summary = hit.Summary,
                    Content = hit.Content,
                    Date = hit.Date,
                    Authority = hit.Authority,
                    RerankScore = hit.RerankScore,
                    Kind = "search",
                };
            }

            ids.Add(id);
        }

        return ids;
    }

    public static string AddFetch(
        IDictionary<string, TripSource> sources,
        FetchResult result,
        DateTimeOffset now)
    {
        var id = SourceIds.ForUrl(result.Url);
        var fetchedAt = now
            .ToUniversalTime()
            .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

        if (sources.TryGetValue(id, out var existing))
        {
            sources[id] = existing with
            {
                Title = result.Title,
                Content = result.Content,
                FetchedAt = fetchedAt,
                Kind = "fetch",
            };
        }
        else
        {
            sources[id] = new TripSource
            {
                Id = id,
                Query = "",
                Title = result.Title,
                Url = result.Url,
                Snippet = "",
                Content = result.Content,
                FetchedAt = fetchedAt,
                Kind = "fetch",
            };
        }

        return id;
    }

    private static double? Highest(double? a, double? b) =>
        a is null ? b : b is null ? a : Math.Max(a.Value, b.Value);
}
