using System.Text.Json;
using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Durable.Harness;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;
using PiTravel.Server.Planning;

namespace PiTravel.Server.Agent.Tools;

/// <summary>
/// Merges new or corrected trip requirements into the durable trip brief,
/// mirroring <c>apps/server/src/agent/tools/update-brief.ts</c>.
/// </summary>
public sealed class UpdateBriefTool : IToolRegistration
{
    public static readonly ToolSchema Schema = BuildSchema(includeArrayItems: true);

    private static readonly ToolSchema ValidationSchema = BuildSchema(includeArrayItems: false);

    private readonly AsyncLocal<bool> _validating = new();
    private readonly TravelDeps _deps;

    public UpdateBriefTool(TravelDeps deps) => _deps = deps;

    public string Name => "trip_update_brief";

    public string Description =>
        "Merge new or corrected trip requirements into the durable trip brief.";

    public ToolSchema Parameters => _validating.Value ? ValidationSchema : Schema;

    public string? Replay => "safe";

    public ToolExecutionMode? ExecutionMode => null;

    public ToolOutputLimits? OutputLimits => null;

    public object? PrepareArguments(object args)
    {
        // ToolTask.Validate walks array `items` schemas and crashes on the
        // resulting self-assignment (see the report), so validation reads the
        // items-less schema. The flag is re-armed here on every call, so a
        // validation failure that never reaches ExecuteAsync cannot leak the
        // stripped schema into the next call's model declaration.
        _validating.Value = true;
        return args;
    }

    public async Task<ToolExecutionResult> ExecuteAsync(
        object args,
        IToolExecutionApi api,
        Context context)
    {
        _validating.Value = false;
        var patch = ReadArgs<TripBrief>(args);

        var missing = await api.CommitAsync(
            async tx =>
            {
                var doc = await tx.DocAsync(Docs.TripBriefDoc, api.ConversationId);
                var current = Docs.ReadBrief(doc.Draft);
                var merged = Docs.MergeBrief(current, patch);

                // Incremental updates are allowed to remain incomplete, but a real
                // calendar date and a positive day count are enforced immediately.
                var errors = BriefValidator.Validate(merged, _deps.Now(), requireComplete: false);
                if (errors.Count > 0)
                {
                    throw new InvalidOperationException(
                        $"Invalid trip brief: {string.Join("; ", errors)}");
                }

                Docs.Write(doc, merged);
                return BriefRules.MissingFields(merged);
            },
            context);

        var text = missing.Count == 0
            ? "Brief is complete."
            : $"Missing brief fields: {string.Join(", ", missing)}";

        return new ToolExecutionResult
        {
            Content = [new TextContent(text)],
            Details = new Dictionary<string, object?>
            {
                ["missing"] = missing.Cast<object?>().ToList(),
            },
        };
    }

    internal static T ReadArgs<T>(object? args) where T : class =>
        args switch
        {
            T typed => typed,
            null => JsonSerializer.Deserialize<T>("{}", TripJson.Options)!,
            IReadOnlyDictionary<string, object?> dict => JsonTrees.Deserialize<T>(dict),
            _ => JsonTrees.Deserialize<T>(JsonTrees.ToTree(args)!),
        };

    private static ToolSchema BuildSchema(bool includeArrayItems)
    {
        var fitnessLiterals = new object[]
        {
            new Dictionary<string, object?> { ["const"] = "low", ["type"] = "string" },
            new Dictionary<string, object?> { ["const"] = "average", ["type"] = "string" },
            new Dictionary<string, object?> { ["const"] = "high", ["type"] = "string" },
        };

        var properties = new Dictionary<string, object?>
        {
            ["destination"] = StringProp("Destination city or area"),
            ["origin"] = StringProp("Departure city"),
            ["startDate"] = StringProp("Start date as YYYY-MM-DD"),
            ["days"] = NumberProp("Number of days, at least 1"),
            ["budgetCny"] = NumberProp("Total budget in CNY, greater than 0"),
            ["companions"] = StringProp("Who travels with the user"),
            ["fitness"] = new Dictionary<string, object?> { ["anyOf"] = fitnessLiterals },
            ["interests"] = StringArrayProp("Interests that shape the itinerary", includeArrayItems),
            ["constraints"] = StringArrayProp("Hard constraints to respect", includeArrayItems),
            ["assumptions"] = StringArrayProp("Assumptions made explicit to the user", includeArrayItems),
        };

        return new ToolSchema(new Dictionary<string, object?>
        {
            ["type"] = "object",
            ["properties"] = properties,
        });
    }

    private static Dictionary<string, object?> StringProp(string description) => new()
    {
        ["type"] = "string",
        ["description"] = description,
    };

    private static Dictionary<string, object?> NumberProp(string description) => new()
    {
        ["type"] = "number",
        ["description"] = description,
    };

    private static Dictionary<string, object?> StringArrayProp(
        string description,
        bool includeItems)
    {
        var schema = new Dictionary<string, object?>
        {
            ["type"] = "array",
            ["description"] = description,
        };
        if (includeItems)
        {
            schema["items"] = new Dictionary<string, object?> { ["type"] = "string" };
        }

        return schema;
    }
}
