using Pi.Ai.Models;
using Pi.Ai.Providers;
using Pi.Ai.Types;
using Pi.Chord.Context;
using Pi.Chord.Delta;
using Pi.Durable;
using Pi.Durable.Harness;
using Pi.Durable.Storage;
using Pi.Durable.Types;

namespace PiTravel.Server.Tests;

using DeltaPath = Pi.Chord.Delta.Path;
using DurableHarness = Pi.Durable.Harness.Harness;

/// <summary>
/// Proves the pi.net primitives the port depends on: a typed custom document, conversation
/// creation, input submission, the event stream, and resume after reopen.
/// </summary>
public sealed class HarnessSpikeTests
{
    private static readonly Context Ctx = Context.Background;

    private sealed class SpikeNote : Dictionary<string, object?>;

    private static readonly DocToken<SpikeNote> NoteDoc = DurableDocuments.DefineDoc(new DocDefinition<SpikeNote>
    {
        Kind = "spike.note",
        Version = 1,
        Initial = () => new SpikeNote { ["text"] = "" },
        Semantics = new DocumentSemantics.LatestConversationScope(ConversationFork.Initial),
    });

    [Fact]
    public async Task WritesADocSubmitsAInputStreamsRunEndAndSurvivesReopen()
    {
        var storage = new MemoryStorage();
        var faux = Faux.CreateProvider();
        faux.SetResponses([Faux.Response.Text("ok")]);
        var model = faux.GetModel(null)!;
        var models = new Models();
        models.SetProvider(faux.Provider);
        var options = new HarnessOptions { Models = models, Registry = Registry.CreateRegistry() };

        var harness = await DurableHarness.OpenAsync(storage, options, Ctx);
        var conversation = await harness.CreateConversationAsync(new ConversationCreateOptions
        {
            Ownership = new ConversationOwnership.Ownerless(),
            Agent = new AgentChange { Model = new ModelRef(model.Provider, model.Id) },
        }, Ctx);

        await conversation.CommitAsync(async tx =>
        {
            var note = await tx.DocAsync(NoteDoc, conversation.Id);
            note.Set(new DeltaPath([Seg.Key("text")]), "hello");
            return true;
        }, Ctx);

        var stream = await Events.WatchEventsAsync(harness, conversation.Id, Ctx);
        var runEnded = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        stream.Start((events, _) =>
        {
            if (events.OfType<AgentEvent.RunEnd>().Any()) runEnded.TrySetResult();
            return Task.CompletedTask;
        });

        await conversation.SubmitAsync(
            new SubmissionDraft.Input { Content = [new TextContent("hello")] }, Ctx);
        await runEnded.Task.WaitAsync(TimeSpan.FromSeconds(10));

        var snapshot = await harness.SnapshotAsync(NoteDoc, conversation.Id, Ctx);
        Assert.NotNull(snapshot);
        Assert.Equal("hello", snapshot["text"]);

        await stream.StopAsync();
        await harness.CloseAsync(Ctx);

        var reopenedStorage = storage.Reopen();
        var reopened = await DurableHarness.OpenAsync(reopenedStorage, options, Ctx);
        reopened.Resume();

        var afterReopen = await reopened.SnapshotAsync(NoteDoc, conversation.Id, Ctx);
        Assert.NotNull(afterReopen);
        Assert.Equal("hello", afterReopen["text"]);

        await reopened.CloseAsync(Ctx);
    }
}
