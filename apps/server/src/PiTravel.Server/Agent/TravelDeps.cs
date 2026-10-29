using PiTravel.Server.Artifacts;
using PiTravel.Server.Contracts;
using PiTravel.Server.Research;

namespace PiTravel.Server.Agent;

/// <summary>
/// Dependencies injected into the travel planner extension and its six tools,
/// mirroring <c>TravelDeps</c> in <c>apps/server/src/agent/deps.ts</c>.
/// </summary>
public sealed record TravelDeps(
    Func<DateTimeOffset> Now,
    DeepSeekClient DeepSeek,
    Func<DayCard, CancellationToken, Task<SketchResult>> GenerateSketch,
    int SearchCap = 40,
    int FetchCap = 30);
