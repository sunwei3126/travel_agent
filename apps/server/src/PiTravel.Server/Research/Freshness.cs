using System.Globalization;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Research;

/// <summary>
/// Freshness and verification rules, mirroring
/// <c>apps/server/src/research/freshness.ts</c>.
/// </summary>
public static class Freshness
{
    private static readonly TimeSpan FreshWindow = TimeSpan.FromDays(90);

    /// <summary>A search snippet is only a lead; a fetched page is a verified fact.</summary>
    public static bool IsVerifiedFact(TripSource source) => source.FetchedAt is not null;

    /// <summary>Returns <c>"fresh"</c>, <c>"stale"</c>, or <c>"unknown"</c>.</summary>
    public static string Of(TripSource source, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(source.Date))
        {
            return "unknown";
        }

        if (!DateTimeOffset.TryParse(
                source.Date,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var date))
        {
            return "unknown";
        }

        return (now - date).Duration() <= FreshWindow ? "fresh" : "stale";
    }

    /// <summary>Fresh first, then unknown, then stale; ties by authority and rerank.</summary>
    public static IReadOnlyList<TripSource> Rank(
        IEnumerable<TripSource> sources,
        DateTimeOffset now) =>
        sources
            .OrderBy(source => RankOf(Of(source, now)))
            .ThenByDescending(ScoreOf)
            .ToList();

    private static int RankOf(string freshness) => freshness switch
    {
        "fresh" => 0,
        "unknown" => 1,
        _ => 2,
    };

    private static double ScoreOf(TripSource source) =>
        (source.Authority ?? 0) * 10 + (source.RerankScore ?? 0);
}
