using System.Diagnostics;

namespace PiTravel.Acceptance.Infrastructure;

/// <summary>
/// Starts the Next.js app with <c>npm run start:web</c> when a production build
/// exists, otherwise <c>npm run dev:web</c>. Both get <c>API_URL</c> and
/// <c>AGENT_URL</c> pointed at the acceptance server.
/// </summary>
public sealed class WebHost : IAsyncDisposable
{
    private readonly Evidence _evidence;
    private readonly object _logGate = new();
    private Process? _process;

    private WebHost(Evidence evidence, int port, string apiBase, string mode)
    {
        _evidence = evidence;
        Port = port;
        ApiBase = apiBase;
        Mode = mode;
        BaseUrl = $"http://127.0.0.1:{port}";
    }

    public int Port { get; }

    public string ApiBase { get; }

    public string Mode { get; }

    public string BaseUrl { get; }

    public static WebHost Create(Evidence evidence, string apiBase)
    {
        var built = File.Exists(Path.Combine(RepoRoot.Path, "apps", "web", ".next", "BUILD_ID"));
        return new WebHost(evidence, FreePort(), apiBase, built ? "start:web" : "dev:web");
    }

    public async Task StartAsync(CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "npm",
            WorkingDirectory = RepoRoot.Path,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add(Mode == "start:web" ? "start" : "dev");
        psi.ArgumentList.Add("--workspace");
        psi.ArgumentList.Add("@pi-demo/web");
        psi.ArgumentList.Add("--");
        psi.ArgumentList.Add("--port");
        psi.ArgumentList.Add(Port.ToString());
        psi.ArgumentList.Add("--hostname");
        psi.ArgumentList.Add("127.0.0.1");
        psi.Environment["API_URL"] = ApiBase;
        psi.Environment["AGENT_URL"] = $"{ApiBase}/agui";

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => Capture(e.Data);
        process.ErrorDataReceived += (_, e) => Capture(e.Data);
        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start the Next.js web app.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _process = process;
        _evidence.Event("host", $"web starting via npm run {Mode} on {BaseUrl}");
        await WaitForPageAsync(ct);
        _evidence.Event("host", $"web ready on {BaseUrl} (pid {process.Id}, mode {Mode})");
    }

    public async ValueTask DisposeAsync()
    {
        if (_process is { HasExited: false })
        {
            _evidence.Event("host", $"stopping web pid {_process.Id}");
            _process.Kill(entireProcessTree: true);
            _process.WaitForExit(15_000);
        }

        _process?.Dispose();
        _process = null;
        await Task.CompletedTask;
    }

    private async Task WaitForPageAsync(CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTimeOffset.UtcNow.AddMinutes(3);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (_process is { HasExited: true })
            {
                throw new InvalidOperationException(
                    $"Web app exited early with code {_process.ExitCode}. See {Path.Combine(_evidence.Root, "web.log")}.");
            }

            try
            {
                using var response = await http.GetAsync(BaseUrl, ct);
                if ((int)response.StatusCode < 500)
                {
                    return;
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
            }

            await Task.Delay(500, ct);
        }

        throw new TimeoutException($"Web app did not become ready at {BaseUrl}.");
    }

    private void Capture(string? line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return;
        }

        lock (_logGate)
        {
            File.AppendAllText(Path.Combine(_evidence.Root, "web.log"), line + Environment.NewLine);
        }
    }

    private static int FreePort()
    {
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        return ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
    }
}
