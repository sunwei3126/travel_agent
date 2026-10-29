using Pi.Ai.Models;
using Pi.Ai.Types;
using Pi.Durable.Harness;
using Pi.Durable.Storage;

namespace PiTravel.Server.Harness;

/// <summary>Seed fields supplied when creating a new trip.</summary>
public sealed record CreateTripInput(
    string Title,
    string Destination,
    string StartDate,
    int Days);

/// <summary>
/// Configuration and dependencies for <see cref="TravelService.OpenAsync"/>.
/// Production callers pass <see cref="DataDir"/> and a configured <see cref="Registry"/>;
/// tests can inject an in-memory <see cref="Storage"/> and a fake clock via <see cref="Now"/>.
/// </summary>
public sealed record TravelServiceOptions
{
    public string? DataDir { get; init; }
    public IStorage? Storage { get; init; }
    public TripIndexStore? IndexStore { get; init; }
    public required Models Models { get; init; }
    public IRegistryReader? Registry { get; init; }
    public required ModelRef DefaultModel { get; init; }
    public ThinkingLevel ThinkingLevel { get; init; } = ThinkingLevel.Off;
    public Func<DateTimeOffset>? Now { get; init; }
    public string? Instructions { get; init; }
}
