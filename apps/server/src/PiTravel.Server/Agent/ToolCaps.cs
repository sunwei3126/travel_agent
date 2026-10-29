namespace PiTravel.Server.Agent;

/// <summary>
/// Per-trip API call budget: fail closed before issuing the upstream request,
/// mirroring <c>enforceCap</c> in <c>apps/server/src/agent/tools/caps.ts</c>.
/// </summary>
public static class ToolCaps
{
    public const int DefaultSearchCap = 40;
    public const int DefaultFetchCap = 30;

    public static void EnforceCap(int count, int cap, string kind)
    {
        if (count >= cap)
        {
            throw new InvalidOperationException($"{kind} cap reached ({count}/{cap})");
        }
    }
}
