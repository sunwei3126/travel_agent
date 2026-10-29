using System.Net.Http.Json;
using System.Text.Json;
using PiTravel.Server.Contracts;

namespace PiTravel.Acceptance.Infrastructure;

/// <summary>Reads trip snapshots and transcripts from the acceptance server.</summary>
public sealed class ApiClient
{
    private readonly HttpClient _http;

    public ApiClient(string baseUrl)
    {
        _http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(30) };
    }

    public async Task<TripSnapshot> GetTripAsync(string tripId, CancellationToken ct)
    {
        var snapshot = await _http.GetFromJsonAsync<TripSnapshot>(
            $"/api/trips/{Uri.EscapeDataString(tripId)}",
            TripJson.Options,
            ct);
        return snapshot ?? throw new InvalidOperationException($"Trip {tripId} returned an empty snapshot.");
    }

    public async Task<JsonElement> GetTripJsonAsync(string tripId, CancellationToken ct)
    {
        var json = await _http.GetStringAsync($"/api/trips/{Uri.EscapeDataString(tripId)}", ct);
        return JsonDocument.Parse(json).RootElement.Clone();
    }

    public async Task<JsonElement> GetTranscriptAsync(string tripId, CancellationToken ct)
    {
        var json = await _http.GetStringAsync($"/api/trips/{Uri.EscapeDataString(tripId)}/transcript", ct);
        return JsonDocument.Parse(json).RootElement.Clone();
    }

    public async Task<bool> IsRunningAsync(string tripId, CancellationToken ct)
    {
        var snapshot = await GetTripAsync(tripId, ct);
        return snapshot.Running;
    }
}
