using System.Globalization;
using System.Text.RegularExpressions;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Research;

/// <summary>
/// The model-visible research channel, mirroring
/// <c>apps/server/src/research/format.ts</c>. Full data stays in the trip sources.
/// </summary>
public static class Formatting
{
    public const int MaxSnippetChars = 300;
    public const int MaxContentChars = 4000;
    public const int MaxVerifiedExcerptChars = 1000;

    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);

    /// <summary>
    /// Ids, titles, URLs, dates, authority, freshness, and snippets, ordered by
    /// freshness and authority so the model can choose what to fetch and cite.
    /// </summary>
    public static string SearchResults(
        string query,
        IReadOnlyList<string> sourceIds,
        IReadOnlyDictionary<string, TripSource> sources,
        DateTimeOffset now)
    {
        var unique = sourceIds.Distinct().ToList();
        if (unique.Count == 0)
        {
            return string.Join(
                "\n",
                $"Found 0 sources for \"{query}\".",
                "Do not plan from memory; try a different query or tell the user what is missing.");
        }

        var ranked = Freshness.Rank(
            unique.Where(sources.ContainsKey).Select(id => sources[id]),
            now);

        var lines = new List<string>
        {
            $"Found {unique.Count} source(s) for \"{query}\", ranked by freshness and authority.",
            "Cite the bracketed ids; snippets are leads, so fetch a page before using a hard fact.",
        };
        foreach (var source in ranked)
        {
            lines.AddRange(SourceLines(source, now));
        }

        return string.Join("\n", lines);
    }

    /// <summary>Source id, metadata, and the truncated page body.</summary>
    public static string FetchResult(TripSource source, DateTimeOffset now)
    {
        var freshness = Freshness.Of(source, now);
        return string.Join(
            "\n",
            $"Fetched [{source.Id}] \"{Fallback(source.Title, "(untitled)")}\"",
            $"url: {source.Url}",
            $"fetchedAt: {source.FetchedAt ?? "unknown"}; date: {source.Date ?? "unknown"} ({freshness}); authority: {Number(source.Authority)}",
            $"content (truncated to {MaxContentChars} chars):",
            Fallback(Truncate(source.Content ?? "", MaxContentChars), "(empty page)"));
    }

    private static IEnumerable<string> SourceLines(TripSource source, DateTimeOffset now)
    {
        var freshness = Freshness.Of(source, now);
        var verified = Freshness.IsVerifiedFact(source);
        var lines = new List<string>
        {
            $"[{source.Id}] {Fallback(source.Title, "(untitled)")}",
            $"  url: {source.Url}",
            $"  date: {source.Date ?? "unknown"} ({freshness}); authority: {Number(source.Authority)}; fetched: {(verified ? "yes" : "no")}",
            $"  snippet: {Fallback(Truncate(source.Snippet, MaxSnippetChars), "(none)")}",
        };

        if (verified && source.Content is not null)
        {
            lines.Add(
                $"  fetchedContent: {Fallback(Truncate(source.Content, MaxVerifiedExcerptChars), "(empty page)")}");
        }

        return lines;
    }

    private static string Truncate(string value, int max)
    {
        var normalized = Whitespace.Replace(value, " ").Trim();
        return normalized.Length <= max
            ? normalized
            : $"{normalized[..max]}…[truncated]";
    }

    private static string Fallback(string value, string fallback) =>
        string.IsNullOrEmpty(value) ? fallback : value;

    private static string Number(double? value) =>
        value?.ToString(CultureInfo.InvariantCulture) ?? "unknown";
}
