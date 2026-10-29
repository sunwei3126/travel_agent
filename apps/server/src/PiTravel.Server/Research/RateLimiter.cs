namespace PiTravel.Server.Research;

/// <summary>
/// Spaces calls to at most <c>qps</c> per second, mirroring
/// <c>apps/server/src/deepseek/rate-limiter.ts</c>. The clock and delay are injected
/// so tests can assert the exact wait sequence without sleeping.
/// </summary>
public sealed class RateLimiter
{
    private readonly double _intervalMs;
    private readonly Func<long> _nowMs;
    private readonly Func<int, Task> _delay;
    private readonly object _gate = new();
    private double _nextAllowedAt;

    public RateLimiter(int qps, Func<long> nowMs, Func<int, Task> delay)
    {
        _intervalMs = 1000.0 / qps;
        _nowMs = nowMs;
        _delay = delay;
    }

    public Task AcquireAsync()
    {
        int waitMs;
        lock (_gate)
        {
            var current = _nowMs();
            var scheduled = Math.Max((double)current, _nextAllowedAt);
            _nextAllowedAt = scheduled + _intervalMs;
            var wait = scheduled - current;
            waitMs = wait > 0 ? (int)wait : 0;
        }

        return waitMs > 0 ? _delay(waitMs) : Task.CompletedTask;
    }
}
