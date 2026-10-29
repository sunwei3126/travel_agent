using System.Globalization;
using System.Text.Json;
using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Durable.Harness;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Agent.Tools;

public sealed record EmitDayArgs
{
    public required int DayIndex { get; init; }
    public required string Date { get; init; }
    public required string Title { get; init; }
    public required IReadOnlyList<DayBlock> Blocks { get; init; }
    public required IReadOnlyList<Claim> Scenery { get; init; }
    public required IReadOnlyList<Claim> Food { get; init; }
    public required IReadOnlyList<Claim> Transport { get; init; }
    public required IReadOnlyList<double> EstimatedCostCny { get; init; }
    public required IReadOnlyList<string> Sources { get; init; }
}

/// <summary>
/// Writes or replaces one day card in the durable trip plan, mirroring
/// <c>apps/server/src/agent/tools/emit-day.ts</c>.
/// </summary>
public sealed class EmitDayTool : IToolRegistration
{
    public static readonly ToolSchema Schema = BuildSchema(includeArrayItems: true);

    private static readonly ToolSchema ValidationSchema = BuildSchema(includeArrayItems: false);

    private readonly AsyncLocal<bool> _validating = new();
    private readonly TravelDeps _deps;

    public EmitDayTool(TravelDeps deps) => _deps = deps;

    public string Name => "plan_emit_day";

    public string Description => "Write or replace one day card in the durable trip plan.";

    public ToolSchema Parameters => _validating.Value ? ValidationSchema : Schema;

    public string? Replay => "safe";

    public ToolExecutionMode? ExecutionMode => null;

    public ToolOutputLimits? OutputLimits => null;

    public object? PrepareArguments(object args)
    {
        // See UpdateBriefTool: validation reads the items-less schema, and the
        // flag is re-armed per call so a failed validation cannot leak it.
        _validating.Value = true;
        return args;
    }

    public async Task<ToolExecutionResult> ExecuteAsync(
        object args,
        IToolExecutionApi api,
        Context context)
    {
        _validating.Value = false;
        var parsed = UpdateBriefTool.ReadArgs<EmitDayArgs>(args);
        var now = _deps.Now();

        await api.CommitAsync(
            async tx =>
            {
                var briefDoc = await tx.DocAsync(Docs.TripBriefDoc, api.ConversationId);
                var brief = Docs.ReadBrief(briefDoc.Draft);
                if (!BriefRules.IsComplete(brief))
                {
                    throw new InvalidOperationException(
                        $"Cannot emit day {parsed.DayIndex}: trip brief is incomplete (missing {string.Join(", ", BriefRules.MissingFields(brief))})");
                }

                var sourcesDoc = await tx.DocAsync(Docs.TripSourcesDoc, api.ConversationId);
                var sources = Docs.ReadSources(sourcesDoc.Draft);
                var planDoc = await tx.DocAsync(Docs.TripPlanDoc, api.ConversationId);
                var plan = Docs.ReadPlan(planDoc.Draft);

                var next = ApplyDayEmit(plan, parsed, now);
                var card = next.Days.First(day => day.DayIndex == parsed.DayIndex);
                var errors = DayCardValidator.Validate(card, sources, brief);
                if (errors.Count > 0)
                {
                    throw new InvalidOperationException(
                        $"Cannot emit day {parsed.DayIndex}: {string.Join("; ", errors)}");
                }

                Docs.Write(planDoc, plan with { Days = next.Days });
                return true;
            },
            context);

        return new ToolExecutionResult
        {
            Content = [new TextContent($"Day {parsed.DayIndex} written.")],
        };
    }

    /// <summary>
    /// Applies one emitted day to a plan. Re-emitting unchanged content keeps the
    /// existing SVG; changed content invalidates it (status <c>pending</c>) so a stale
    /// sketch is never shown, and only the targeted day is replaced.
    /// </summary>
    public static TripPlan ApplyDayEmit(
        TripPlan plan,
        EmitDayArgs args,
        DateTimeOffset now)
    {
        var blocks = args.Blocks
            .Select((block, index) => new DayBlock
            {
                Time = block.Time,
                Title = block.Title,
                Detail = block.Detail,
                Claims = block.Claims,
                CostCny = block.CostCny is null
                    ? null
                    : ToPair(block.CostCny, $"blocks[{index}].costCny"),
            })
            .ToList();

        var candidate = new DayCard
        {
            DayIndex = args.DayIndex,
            Date = args.Date,
            Title = args.Title,
            Blocks = blocks,
            Scenery = args.Scenery,
            Food = args.Food,
            Transport = args.Transport,
            EstimatedCostCny = ToPair(args.EstimatedCostCny, "estimatedCostCny"),
            Sources = args.Sources,
            SvgStatus = "pending",
            UpdatedAt = now
                .ToUniversalTime()
                .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        };

        var existing = plan.Days.FirstOrDefault(day => day.DayIndex == args.DayIndex);
        if (existing is not null && ContentOf(existing) == ContentOf(candidate))
        {
            candidate = candidate with
            {
                SvgStatus = existing.SvgStatus,
                Svg = existing.Svg,
            };
        }

        return Docs.UpsertDayCard(plan, candidate);
    }

    private static IReadOnlyList<double> ToPair(IReadOnlyList<double>? value, string label)
    {
        if (value is null || value.Count != 2 || !value.All(double.IsFinite))
        {
            throw new InvalidOperationException($"{label} must be an array of exactly two numbers");
        }

        return [value[0], value[1]];
    }

    private static string ContentOf(DayCard day) =>
        JsonSerializer.Serialize(
            new
            {
                date = day.Date,
                title = day.Title,
                blocks = day.Blocks,
                scenery = day.Scenery,
                food = day.Food,
                transport = day.Transport,
                estimatedCostCny = day.EstimatedCostCny,
                sources = day.Sources,
            },
            TripJson.Options);

    private static ToolSchema BuildSchema(bool includeArrayItems)
    {
        var claimKindLiterals = new object[]
        {
            new Dictionary<string, object?> { ["const"] = "fact", ["type"] = "string" },
            new Dictionary<string, object?> { ["const"] = "opinion", ["type"] = "string" },
        };

        var sourceIdsSchema = new Dictionary<string, object?> { ["type"] = "array" };
        if (includeArrayItems)
        {
            sourceIdsSchema["items"] = new Dictionary<string, object?> { ["type"] = "string" };
        }

        var claimSchema = new Dictionary<string, object?>
        {
            ["type"] = "object",
            ["properties"] = new Dictionary<string, object?>
            {
                ["text"] = new Dictionary<string, object?> { ["type"] = "string" },
                ["kind"] = new Dictionary<string, object?> { ["anyOf"] = claimKindLiterals },
                ["sourceIds"] = sourceIdsSchema,
                ["unverified"] = new Dictionary<string, object?> { ["type"] = "boolean" },
            },
            ["required"] = new[] { "text", "kind", "sourceIds" },
        };

        Dictionary<string, object?> CostPairSchema()
        {
            var pair = new Dictionary<string, object?>
            {
                ["type"] = "array",
                ["minItems"] = 2,
                ["maxItems"] = 2,
            };
            if (includeArrayItems)
            {
                pair["items"] = new Dictionary<string, object?> { ["type"] = "number" };
            }

            return pair;
        }

        Dictionary<string, object?> ClaimArraySchema()
        {
            var arr = new Dictionary<string, object?> { ["type"] = "array" };
            if (includeArrayItems)
            {
                arr["items"] = claimSchema;
            }

            return arr;
        }

        var dayBlockSchema = new Dictionary<string, object?>
        {
            ["type"] = "object",
            ["properties"] = new Dictionary<string, object?>
            {
                ["time"] = new Dictionary<string, object?> { ["type"] = "string" },
                ["title"] = new Dictionary<string, object?> { ["type"] = "string" },
                ["detail"] = new Dictionary<string, object?> { ["type"] = "string" },
                ["claims"] = ClaimArraySchema(),
                ["costCny"] = CostPairSchema(),
            },
            ["required"] = new[] { "time", "title", "detail", "claims" },
        };

        var blocksSchema = new Dictionary<string, object?> { ["type"] = "array" };
        if (includeArrayItems)
        {
            blocksSchema["items"] = dayBlockSchema;
        }

        var sourcesSchema = new Dictionary<string, object?>
        {
            ["type"] = "array",
            ["description"] = "Source ids used by this day",
        };
        if (includeArrayItems)
        {
            sourcesSchema["items"] = new Dictionary<string, object?> { ["type"] = "string" };
        }

        var properties = new Dictionary<string, object?>
        {
            ["dayIndex"] = new Dictionary<string, object?>
            {
                ["type"] = "number",
                ["description"] = "1-based day number",
            },
            ["date"] = new Dictionary<string, object?>
            {
                ["type"] = "string",
                ["description"] = "Date of this day as YYYY-MM-DD",
            },
            ["title"] = new Dictionary<string, object?> { ["type"] = "string" },
            ["blocks"] = blocksSchema,
            ["scenery"] = ClaimArraySchema(),
            ["food"] = ClaimArraySchema(),
            ["transport"] = ClaimArraySchema(),
            ["estimatedCostCny"] = CostPairSchema(),
            ["sources"] = sourcesSchema,
        };

        return new ToolSchema(new Dictionary<string, object?>
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["required"] = new[]
            {
                "dayIndex",
                "date",
                "title",
                "blocks",
                "scenery",
                "food",
                "transport",
                "estimatedCostCny",
                "sources",
            },
        });
    }
}
