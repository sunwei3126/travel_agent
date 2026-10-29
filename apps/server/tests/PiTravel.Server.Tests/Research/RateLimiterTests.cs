using PiTravel.Server.Research;

namespace PiTravel.Server.Tests.Research;

/// <summary>
/// Locks the interval spacing of <c>RateLimiter</c> in
/// <c>apps/server/src/deepseek/rate-limiter.ts</c>.
/// </summary>
public sealed class RateLimiterTests
{
    [Fact]
    public async Task RateLimiterSpacesCallsByInterval()
    {
        var clock = new FakeClock();
        var limiter = new RateLimiter(2, clock.NowMs, clock.Delay);
        var waits = new List<long>();

        for (var i = 0; i < 3; i++)
        {
            var startedAt = clock.Now;
            await limiter.AcquireAsync();
            waits.Add(clock.Now - startedAt);
        }

        Assert.Equal(new long[] { 0, 500, 500 }, waits);
        Assert.Equal(new[] { 500, 500 }, clock.Delays);
    }
}
