using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Durable.Harness;
using PiTravel.Server.Harness;

namespace PiTravel.Server.Agent.Tools;

public sealed record SketchDayArgs
{
    public required int DayIndex { get; init; }
}

/// <summary>
/// Generates an SVG sketch for one day card and stores it on that card,
/// mirroring <c>apps/server/src/agent/tools/sketch-day.ts</c>.
/// </summary>
public sealed class SketchDayTool : IToolRegistration
{
    public static readonly ToolSchema Schema = new(new Dictionary<string, object?>
    {
        ["type"] = "object",
        ["properties"] = new Dictionary<string, object?>
        {
            ["dayIndex"] = new Dictionary<string, object?>
            {
                ["type"] = "number",
                ["description"] = "1-based day number to sketch",
            },
        },
        ["required"] = new[] { "dayIndex" },
    });

    private readonly TravelDeps _deps;

    public SketchDayTool(TravelDeps deps) => _deps = deps;

    public string Name => "sketch_day";

    public string Description =>
        "Generate an SVG sketch for one day card and store it on that card.";

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
        var parsed = UpdateBriefTool.ReadArgs<SketchDayArgs>(args);
        var ct = context.AbortSignal ?? CancellationToken.None;

        var plan = Docs.ReadPlan(
            await api.SnapshotAsync(Docs.TripPlanDoc, api.ConversationId, context));
        var day = plan.Days.FirstOrDefault(card => card.DayIndex == parsed.DayIndex);
        if (day is null)
        {
            throw new InvalidOperationException(
                $"Cannot sketch day {parsed.DayIndex}: no day card with that dayIndex");
        }

        var sketch = await _deps.GenerateSketch(day, ct);

        await api.CommitAsync(
            async tx =>
            {
                var planDoc = await tx.DocAsync(Docs.TripPlanDoc, api.ConversationId);
                var currentPlan = Docs.ReadPlan(planDoc.Draft);
                var card = currentPlan.Days.FirstOrDefault(
                    candidate => candidate.DayIndex == parsed.DayIndex);
                if (card is null)
                {
                    throw new InvalidOperationException(
                        $"Cannot sketch day {parsed.DayIndex}: no day card with that dayIndex");
                }

                var updated = card with
                {
                    Svg = sketch.Svg,
                    SvgStatus = sketch.Status,
                };
                Docs.Write(planDoc, Docs.UpsertDayCard(currentPlan, updated));
                return true;
            },
            context);

        return new ToolExecutionResult
        {
            Content = [new TextContent($"Sketch for day {parsed.DayIndex} is {sketch.Status}.")],
            Details = new Dictionary<string, object?> { ["status"] = sketch.Status },
        };
    }
}
