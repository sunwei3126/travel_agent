using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;

namespace PiTravel.Server.Tests.Harness;

/// <summary>
/// Locks <see cref="TripIndexStore"/> to <c>apps/server/src/trips/index-store.ts</c>:
/// atomic JSON persistence, newest-first ordering by <c>updatedAt</c>, and empty result
/// when the backing file does not exist yet.
/// </summary>
public sealed class TripIndexStoreTests : IDisposable
{
    private readonly string _tempDir = Path.Combine(
        Path.GetTempPath(),
        $"pi-travel-index-{Guid.NewGuid():N}");

    public TripIndexStoreTests()
    {
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
        {
            Directory.Delete(_tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task TripIndexStoreListsNewestFirst()
    {
        var store = new TripIndexStore(Path.Combine(_tempDir, "trips.json"));
        var older = SampleEntry("a", "c1", "旧", "2026-10-18T00:00:00.000Z");
        var newer = SampleEntry("b", "c2", "新", "2026-10-19T00:00:00.000Z");

        await store.UpsertAsync(older);
        await store.UpsertAsync(newer);

        var listed = await store.ListAsync();
        Assert.Equal(new[] { "b", "a" }, listed.Select(entry => entry.TripId).ToArray());
    }

    [Fact]
    public async Task TripIndexStoreUpsertsById()
    {
        var filePath = Path.Combine(_tempDir, "trips.json");
        var store = new TripIndexStore(filePath);
        var initial = SampleEntry("a", "c1", "初版", "2026-10-18T00:00:00.000Z");
        var updated = initial with
        {
            Title = "改名后",
            UpdatedAt = "2026-10-19T00:00:00.000Z",
            Status = "completed",
        };

        await store.UpsertAsync(initial);
        await store.UpsertAsync(updated);

        var listed = await store.ListAsync();
        var single = Assert.Single(listed);
        Assert.Equal("改名后", single.Title);
        Assert.Equal("completed", single.Status);
        Assert.Equal(updated, await store.GetAsync("a"));
        Assert.Null(await store.GetAsync("missing"));
        Assert.False(File.Exists($"{filePath}.tmp"));
    }

    [Fact]
    public async Task TripIndexStoreReturnsEmptyForMissingFile()
    {
        var store = new TripIndexStore(Path.Combine(_tempDir, "missing", "trips.json"));

        Assert.Empty(await store.ListAsync());
        Assert.Null(await store.GetAsync("a"));
    }

    private static TripIndexEntry SampleEntry(
        string tripId,
        string conversationId,
        string title,
        string updatedAt) => new()
    {
        TripId = tripId,
        ConversationId = conversationId,
        Title = title,
        Destination = "泰山",
        StartDate = "2026-10-26",
        Days = 3,
        UpdatedAt = updatedAt,
        Status = "active",
    };
}
