using System.Globalization;
using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Durable.Harness;
using PiTravel.Server.Harness;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Agent.Tools;

/// <summary>
/// Sums the day-card cost ranges against the trip budget and stores the result
/// on the plan, mirroring <c>apps/server/src/agent/tools/finalize.ts</c>.
/// </summary>
public sealed class FinalizeTool : IToolRegistration
{
    public static readonly ToolSchema Schema = new(new Dictionary<string, object?>
    {
        ["type"] = "object",
        ["properties"] = new Dictionary<string, object?>(),
    });

    public string Name => "plan_finalize";

    public string Description =>
        "Sum the day-card cost ranges against the trip budget and store the result on the plan.";

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
        var summary = await api.CommitAsync(
            async tx =>
            {
                var briefDoc = await tx.DocAsync(Docs.TripBriefDoc, api.ConversationId);
                var brief = Docs.ReadBrief(briefDoc.Draft);
                if (brief.BudgetCny is not { } budgetCny)
                {
                    throw new InvalidOperationException(
                        "Cannot finalize: trip brief has no budgetCny");
                }

                var planDoc = await tx.DocAsync(Docs.TripPlanDoc, api.ConversationId);
                var plan = Docs.ReadPlan(planDoc.Draft);
                var result = Budget.Finalize(plan, budgetCny);
                Docs.Write(planDoc, plan with { Budget = result });
                return result;
            },
            context);

        var statusText = summary.WithinBudget ? "within budget" : "over budget";
        var text = string.Create(
            CultureInfo.InvariantCulture,
            $"Estimated {summary.Low}-{summary.High} CNY against a {summary.Cap} CNY budget: {statusText}.");

        return new ToolExecutionResult
        {
            Content = [new TextContent(text)],
            Details = Docs.ToDictionary(summary),
        };
    }
}
