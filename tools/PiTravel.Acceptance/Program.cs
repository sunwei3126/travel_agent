using PiTravel.Acceptance.Infrastructure;
using PiTravel.Acceptance.Scenarios;

namespace PiTravel.Acceptance;

/// <summary>The three processes one scenario drives: server, web, browser.</summary>
public sealed class Stack : IAsyncDisposable
{
    private Stack(ServerHost server, WebHost web, BrowserSession browser, ApiClient api, Evidence evidence)
    {
        Server = server;
        Web = web;
        Browser = browser;
        Api = api;
        Evidence = evidence;
    }

    public ServerHost Server { get; }

    public WebHost Web { get; }

    public BrowserSession Browser { get; }

    public ApiClient Api { get; }

    public Evidence Evidence { get; }

    public static async Task<Stack> StartAsync(Evidence evidence, CancellationToken ct, bool invalidSvg = false)
    {
        var dataDir = Path.Combine(evidence.Root, "data");
        var server = ServerHost.Create(evidence, dataDir, invalidSvg);
        var web = WebHost.Create(evidence, server.BaseUrl);
        try
        {
            await server.StartAsync(ct);
            await web.StartAsync(ct);
            var browser = await BrowserSession.LaunchAsync();
            return new Stack(server, web, browser, new ApiClient(server.BaseUrl), evidence);
        }
        catch
        {
            await web.DisposeAsync();
            await server.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await Browser.DisposeAsync();
        await Web.DisposeAsync();
        await Server.DisposeAsync();
    }
}

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var scenario = "A";
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] is "--scenario" && index + 1 < args.Length)
            {
                scenario = args[index + 1];
            }
        }

        var evidence = Evidence.Create(RepoRoot.Path);
        Console.WriteLine($"evidence: {evidence.Root}");
        // One scenario spends most of its time waiting on the model: scenario A
        // researches for ~20 minutes before it can finalize, so its own cap has
        // to outlast the waits inside it (15 min for the day cards, 15 to settle).
        var minutes = scenario.Equals("all", StringComparison.OrdinalIgnoreCase) ? 150 : 45;
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(minutes));
        try
        {
            var code = await RunAsync(scenario, evidence, cts.Token);
            await evidence.FlushLogAsync();
            return code;
        }
        catch (Exception ex)
        {
            evidence.Event(scenario, ex.ToString());
            Console.Error.WriteLine(ex);
            await evidence.FlushLogAsync();
            return 1;
        }
    }

    private static async Task<int> RunAsync(string scenario, Evidence evidence, CancellationToken ct)
    {
        return scenario.ToUpperInvariant() switch
        {
            "A" => await RunOneAsync("A", evidence, false, (stack, token) => CompleteBrief.RunAsync(stack, token), ct),
            "B" => await RunOneAsync("B", evidence, false, async (stack, token) => { await IncompleteBrief.RunAsync(stack, token); }, ct),
            "C" => await RunOneAsync("C", evidence, false, async (stack, token) => { await CrashResume.RunAsync(stack, token); }, ct),
            "D" => await RunOneAsync("D", evidence, false, async (stack, token) => { await RefreshRecovery.RunAsync(stack, token); }, ct),
            "E" => await RunOneAsync("E", evidence, true, async (stack, token) => { await SvgFallback.RunAsync(stack, token); }, ct),
            "F" or "G" or "H" => await RunDependentAsync(scenario, evidence, ct),
            "ALL" => await RunAllAsync(evidence, ct),
            _ => throw new ArgumentException($"Unknown scenario '{scenario}'. Use A|B|C|D|E|F|G|H|all."),
        };
    }

    private static async Task<int> RunOneAsync(
        string name,
        Evidence evidence,
        bool invalidSvg,
        Func<Stack, CancellationToken, Task> run,
        CancellationToken ct)
    {
        await using var stack = await Stack.StartAsync(evidence, ct, invalidSvg);
        try
        {
            await run(stack, ct);
            return 0;
        }
        catch (Exception ex)
        {
            evidence.Event(name, ex.ToString());
            await CaptureFailureAsync(stack, name);
            return 1;
        }
    }

    private static async Task<int> RunDependentAsync(string scenario, Evidence evidence, CancellationToken ct)
    {
        await using var stack = await Stack.StartAsync(evidence, ct);
        try
        {
            var tripId = await CompleteBrief.RunAsync(stack, ct);
            if (scenario.Equals("F", StringComparison.OrdinalIgnoreCase))
            {
                await TargetedEdit.RunAsync(stack, tripId, ct);
            }
            else if (scenario.Equals("G", StringComparison.OrdinalIgnoreCase))
            {
                await Citations.RunAsync(stack, tripId, ct);
            }
            else
            {
                await ContentCoverage.RunAsync(stack, tripId, ct);
            }

            return 0;
        }
        catch (Exception ex)
        {
            evidence.Event(scenario, ex.ToString());
            await CaptureFailureAsync(stack, scenario);
            return 1;
        }
    }

    private static async Task<int> RunAllAsync(Evidence evidence, CancellationToken ct)
    {
        var failed = new List<string>();
        await using (var stack = await Stack.StartAsync(evidence, ct))
        {
            string? tripId = null;
            tripId = await StepAsync("A", evidence, stack, failed, token => CompleteBrief.RunAsync(stack, token), ct);
            await StepAsync("B", evidence, stack, failed, async token => { await IncompleteBrief.RunAsync(stack, token); }, ct);
            await StepAsync("D", evidence, stack, failed, async token => { await RefreshRecovery.RunAsync(stack, token); }, ct);
            if (tripId is not null)
            {
                await StepAsync("F", evidence, stack, failed, token => TargetedEdit.RunAsync(stack, tripId, token), ct);
                await StepAsync("G", evidence, stack, failed, token => Citations.RunAsync(stack, tripId, token), ct);
                await StepAsync("H", evidence, stack, failed, token => ContentCoverage.RunAsync(stack, tripId, token), ct);
            }
            else
            {
                failed.Add("F");
                failed.Add("G");
                failed.Add("H");
            }
        }

        await using (var crash = await Stack.StartAsync(evidence, ct))
        {
            await StepAsync("C", evidence, crash, failed, async token => { await CrashResume.RunAsync(crash, token); }, ct);
        }

        await using (var svg = await Stack.StartAsync(evidence, ct, invalidSvg: true))
        {
            await StepAsync("E", evidence, svg, failed, async token => { await SvgFallback.RunAsync(svg, token); }, ct);
        }

        if (failed.Count > 0)
        {
            Console.Error.WriteLine("failed scenarios: " + string.Join(", ", failed));
            return 1;
        }

        return 0;
    }

    private static async Task<string?> StepAsync(
        string name,
        Evidence evidence,
        Stack stack,
        List<string> failed,
        Func<CancellationToken, Task<string>> run,
        CancellationToken ct)
    {
        try
        {
            return await run(ct);
        }
        catch (Exception ex)
        {
            failed.Add(name);
            evidence.Event(name, ex.ToString());
            await CaptureFailureAsync(stack, name);
            return null;
        }
    }

    private static async Task StepAsync(
        string name,
        Evidence evidence,
        Stack stack,
        List<string> failed,
        Func<CancellationToken, Task> run,
        CancellationToken ct)
    {
        try
        {
            await run(ct);
        }
        catch (Exception ex)
        {
            failed.Add(name);
            evidence.Event(name, ex.ToString());
            await CaptureFailureAsync(stack, name);
        }
    }

    private static async Task CaptureFailureAsync(Stack stack, string name)
    {
        try
        {
            await stack.Browser.Page.ScreenshotAsync(new()
            {
                Path = Path.Combine(stack.Evidence.Root, $"{name}-failure.png"),
                FullPage = true,
            });
        }
        catch (Exception ex)
        {
            stack.Evidence.Event(name, $"failure screenshot failed: {ex.Message}");
        }
    }
}
