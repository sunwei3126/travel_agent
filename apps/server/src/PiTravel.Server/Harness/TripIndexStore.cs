using System.Text.Json;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Harness;

/// <summary>
/// Persists the trip index as an atomically replaced JSON array, mirroring
/// <c>apps/server/src/trips/index-store.ts</c>.
/// </summary>
public sealed class TripIndexStore
{
    private static readonly JsonSerializerOptions WriteOptions = new(TripJson.Options)
    {
        WriteIndented = true,
    };

    private readonly string? _filePath;
    private readonly List<TripIndexEntry> _memoryEntries = [];
    private readonly SemaphoreSlim _gate = new(1, 1);

    public TripIndexStore(string filePath)
    {
        _filePath = filePath;
    }

    public TripIndexStore()
    {
        _filePath = null;
    }

    internal bool IsInMemory => _filePath is null;

    public async Task<IReadOnlyList<TripIndexEntry>> ListAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var entries = await ReadUnsafeAsync(ct);
            entries.Sort((a, b) => string.CompareOrdinal(b.UpdatedAt, a.UpdatedAt));
            return entries;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<TripIndexEntry?> GetAsync(string tripId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var entries = await ReadUnsafeAsync(ct);
            return entries.FirstOrDefault(entry => entry.TripId == tripId);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task UpsertAsync(TripIndexEntry entry, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var entries = await ReadUnsafeAsync(ct);
            var index = entries.FindIndex(existing => existing.TripId == entry.TripId);
            if (index == -1)
            {
                entries.Add(entry);
            }
            else
            {
                entries[index] = entry;
            }

            if (_filePath is null)
            {
                _memoryEntries.Clear();
                _memoryEntries.AddRange(entries);
                return;
            }

            var directory = Path.GetDirectoryName(_filePath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var tmpPath = $"{_filePath}.tmp";
            var json = JsonSerializer.Serialize(entries, WriteOptions);
            await File.WriteAllTextAsync(tmpPath, json, ct);
            File.Move(tmpPath, _filePath, overwrite: true);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<List<TripIndexEntry>> ReadUnsafeAsync(CancellationToken ct)
    {
        if (_filePath is null)
        {
            return [.. _memoryEntries];
        }

        if (!File.Exists(_filePath))
        {
            return [];
        }

        try
        {
            var text = await File.ReadAllTextAsync(_filePath, ct);
            return JsonSerializer.Deserialize<List<TripIndexEntry>>(text, TripJson.Options) ?? [];
        }
        catch (FileNotFoundException)
        {
            return [];
        }
        catch (DirectoryNotFoundException)
        {
            return [];
        }
    }
}
