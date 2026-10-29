using PiTravel.Server.Contracts;

namespace PiTravel.Server.AgUi;

/// <summary>
/// Builds the conversation snapshot an AG-UI run starts from, mirroring
/// <c>buildSnapshot</c> in <c>apps/server/src/agui/mapper.ts</c>.
/// </summary>
public static class SnapshotBuilder
{
    public static IReadOnlyList<AgUiEvent> Build(
        string threadId,
        string runId,
        IReadOnlyList<TranscriptEntry> entries,
        TripState state)
    {
        _ = threadId;
        _ = runId;
        return
        [
            new MessagesSnapshot(AgUiMessages.FromTranscript(entries)),
            new StateSnapshot(state),
        ];
    }
}
