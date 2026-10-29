using Pi.Durable.Harness;
using PiTravel.Server.Agent.Tools;

namespace PiTravel.Server.Agent;

/// <summary>
/// Registers the travel planner's six tools and the trip-context prompt section,
/// mirroring <c>apps/server/src/agent/extension.ts</c>.
/// </summary>
public sealed class TravelExtension : IExtension
{
    public TravelExtension(TravelDeps deps)
    {
        Tools =
        [
            Define.Tool(new UpdateBriefTool(deps)),
            Define.Tool(new EmitDayTool(deps)),
            Define.Tool(new FinalizeTool()),
            Define.Tool(new SearchTool(deps)),
            Define.Tool(new FetchTool(deps)),
            Define.Tool(new SketchDayTool(deps)),
        ];
        Sections =
        [
            TripContextSection.Create(deps.Now),
        ];
    }

    public string Name => "travel";

    public IReadOnlyList<IToolRegistration> Tools { get; }

    public IReadOnlyList<IPromptSection> Sections { get; }

    public IReadOnlyList<HookRegistration>? Hooks => null;

    public IReadOnlyList<Wrap>? Wraps => null;

    public IReadOnlyList<AnyDurableTask>? Tasks => null;

    public static IExtension Create(TravelDeps deps) => Define.Extension(new TravelExtension(deps));
}
