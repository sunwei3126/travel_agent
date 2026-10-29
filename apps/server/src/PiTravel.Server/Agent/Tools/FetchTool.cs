using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Durable.Harness;
using PiTravel.Server.Harness;
using PiTravel.Server.Research;

namespace PiTravel.Server.Agent.Tools;

public sealed record FetchToolArgs
{
    public required string Url { get; init; }
}

/// <summary>
/// Fetches a web page with DeepSeek and stores its content as a trip source,
/// mirroring <c>apps/server/src/agent/tools/fetch.ts</c>.
/// </summary>
public sealed class FetchTool : IToolRegistration
{
    public static readonly ToolSchema Schema = new(new Dictionary<string, object?>
    {
        ["type"] = "object",
        ["properties"] = new Dictionary<string, object?>
        {
            ["url"] = new Dictionary<string, object?>
            {
                ["type"] = "string",
                ["description"] = "URL of the page to fetch",
            },
        },
        ["required"] = new[] { "url" },
    });

    private readonly TravelDeps _deps;

    public FetchTool(TravelDeps deps) => _deps = deps;

    public string Name => "deepseek_fetch";

    public string Description =>
        "Fetch a web page with DeepSeek and store its content as a trip source.";

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
        var parsed = UpdateBriefTool.ReadArgs<FetchToolArgs>(args);
        var now = _deps.Now();
        var ct = context.AbortSignal ?? CancellationToken.None;

        var sources = Docs.ReadSources(
            await api.SnapshotAsync(Docs.TripSourcesDoc, api.ConversationId, context));

        // Never fetch a URL the user invented: only pages returned by search.
        var existing = Sources.FindByUrl(sources, parsed.Url);
        if (existing is null)
        {
            throw new InvalidOperationException(
                $"Cannot fetch \"{parsed.Url}\": the URL must come from a deepseek_search result. Search for it first.");
        }

        // Same-URL guard: a completed fetch is never repeated.
        if (existing.FetchedAt is not null)
        {
            return new ToolExecutionResult
            {
                Content = [new TextContent(Formatting.FetchResult(existing, now))],
                Details = new Dictionary<string, object?> { ["sourceId"] = existing.Id },
            };
        }

        var current = Docs.ReadResearch(
            await api.SnapshotAsync(Docs.TripResearchDoc, api.ConversationId, context));
        ToolCaps.EnforceCap(current.FetchCount, _deps.FetchCap, "fetch");

        var raw = await _deps.DeepSeek.FetchAsync(parsed.Url, ct);
        var url = !string.IsNullOrEmpty(raw.Url) ? raw.Url : parsed.Url;
        var title = !string.IsNullOrEmpty(raw.Title) ? raw.Title : url;
        var result = new FetchResult(title, url, raw.Content ?? "");

        var (sourceId, source) = await api.CommitAsync(
            async tx =>
            {
                var researchDoc = await tx.DocAsync(Docs.TripResearchDoc, api.ConversationId);
                var research = Docs.ReadResearch(researchDoc.Draft);
                ToolCaps.EnforceCap(research.FetchCount, _deps.FetchCap, "fetch");

                var sourcesDoc = await tx.DocAsync(Docs.TripSourcesDoc, api.ConversationId);
                var stored = Docs.ReadSources(sourcesDoc.Draft);
                var id = Sources.AddFetch(stored, result, now);
                Docs.Write(sourcesDoc, stored);

                var attemptKey = Sources.NormalizeUrl(parsed.Url);
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

                return (SourceId: id, Source: stored[id]);
            },
            context);

        return new ToolExecutionResult
        {
            Content = [new TextContent(Formatting.FetchResult(source, now))],
            Details = new Dictionary<string, object?> { ["sourceId"] = sourceId },
        };
    }
}
