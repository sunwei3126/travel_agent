using System.Text.Json;
using PiTravel.Server.Contracts;

namespace PiTravel.Acceptance.Infrastructure;

/// <summary>
/// Writes screenshots, snapshot JSON, transcripts, and the scenario event log
/// under <c>artifacts/acceptance/&lt;timestamp&gt;/</c>.
/// </summary>
public sealed class Evidence
{
    private readonly object _gate = new();
    private readonly List<string> _events = [];

    public Evidence(string root)
    {
        Root = root;
        Directory.CreateDirectory(root);
    }

    public string Root { get; }

    public static Evidence Create(string repoRoot)
    {
        var stamp = DateTimeOffset.Now.ToString("yyyyMMdd-HHmmss");
        return new Evidence(Path.Combine(repoRoot, "artifacts", "acceptance", stamp));
    }

    public void Event(string scenario, string message)
    {
        var line = $"{DateTimeOffset.Now:HH:mm:ss} [{scenario}] {message}";
        lock (_gate)
        {
            _events.Add(line);
        }

        Console.WriteLine(line);
    }

    public async Task SaveTextAsync(string name, string text)
    {
        var path = Path.Combine(Root, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, text);
    }

    public async Task SaveJsonAsync(string name, JsonElement json)
    {
        await SaveTextAsync(name, json.GetRawText());
    }

    public async Task SaveSnapshotAsync(string name, TripSnapshot snapshot)
    {
        await SaveTextAsync(name, JsonSerializer.Serialize(snapshot, TripJson.Options));
    }

    public async Task FlushLogAsync()
    {
        string[] lines;
        lock (_gate)
        {
            lines = _events.ToArray();
        }

        await File.WriteAllLinesAsync(Path.Combine(Root, "events.log"), lines);
    }
}
