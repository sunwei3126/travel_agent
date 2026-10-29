using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace PiTravel.Acceptance.Infrastructure;

/// <summary>
/// Starts <c>dotnet run --project apps/server</c> on a free loopback port with
/// its own <c>DATA_DIR</c>. Killing the process uses the whole process tree.
/// </summary>
public sealed class ServerHost : IAsyncDisposable
{
    private readonly Evidence _evidence;
    private Process? _process;
    private readonly object _logGate = new();
    private int _logLines;

    private ServerHost(Evidence evidence, string dataDir, int port, bool invalidSvg)
    {
        _evidence = evidence;
        DataDir = dataDir;
        Port = port;
        InvalidSvg = invalidSvg;
        BaseUrl = $"http://127.0.0.1:{port}";
    }

    public string DataDir { get; }

    public int Port { get; }

    public bool InvalidSvg { get; }

    public string BaseUrl { get; }

    public Process Process => _process ?? throw new InvalidOperationException("Server is not running.");

    public static ServerHost Create(Evidence evidence, string dataDir, bool invalidSvg = false)
    {
        Directory.CreateDirectory(dataDir);
        return new ServerHost(evidence, dataDir, FreePort(), invalidSvg);
    }

    public async Task StartAsync(CancellationToken ct)
    {
        if (_process is { HasExited: false })
        {
            throw new InvalidOperationException("Server is already running.");
        }

        Require("DEEPSEEK_API_KEY");
        var psi = new ProcessStartInfo
        {
            FileName = "dotnet",
            WorkingDirectory = RepoRoot.Path,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("--project");
        psi.ArgumentList.Add(Path.Combine("apps", "server", "src", "PiTravel.Server"));
        psi.ArgumentList.Add("--no-launch-profile");
        psi.ArgumentList.Add("--");
        psi.ArgumentList.Add("--urls");
        psi.ArgumentList.Add(BaseUrl);

        Copy("DEEPSEEK_API_KEY", psi);
        CopyOptional("DEEPSEEK_BASE_URL", psi);
        psi.Environment["DATA_DIR"] = DataDir;
        CopyOptional("MAGPIE_BASE_URL", psi);
        CopyOptional("MAGPIE_MODEL", psi);
        CopyOptional("MAGPIE_API_KEY", psi);
        CopyOptional("MAGPIE_MAX_TOKENS", psi);
        CopyOptional("PI_THINKING_LEVEL", psi);
        if (InvalidSvg)
        {
            psi.Environment["PITRAVEL_TEST_SVG_MODE"] = "invalid";
        }

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => Capture(e.Data);
        process.ErrorDataReceived += (_, e) => Capture(e.Data);
        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start the .NET server.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _process = process;
        _evidence.Event("host", $"server starting on {BaseUrl}, DATA_DIR={DataDir}");
        await WaitForHealthAsync(ct);
        _evidence.Event("host", $"server healthy on {BaseUrl} (pid {process.Id})");
    }

    public void Kill()
    {
        var process = _process;
        if (process is null || process.HasExited)
        {
            return;
        }

        _evidence.Event("host", $"killing server pid {process.Id}");
        process.Kill(entireProcessTree: true);
        process.WaitForExit(15_000);
    }

    public async ValueTask DisposeAsync()
    {
        if (_process is { HasExited: false })
        {
            Kill();
        }

        _process?.Dispose();
        _process = null;
        await Task.CompletedTask;
    }

    private async Task WaitForHealthAsync(CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTimeOffset.UtcNow.AddMinutes(3);
        Exception? last = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (_process is { HasExited: true })
            {
                throw new InvalidOperationException(
                    $"Server exited early with code {_process.ExitCode}. See {Path.Combine(_evidence.Root, "server.log")}.");
            }

            try
            {
                using var response = await http.GetAsync($"{BaseUrl}/health", ct);
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                last = ex;
            }

            await Task.Delay(500, ct);
        }

        throw new TimeoutException($"Server did not become healthy at {BaseUrl}. {last?.Message}");
    }

    private void Capture(string? line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return;
        }

        var path = Path.Combine(_evidence.Root, "server.log");
        lock (_logGate)
        {
            File.AppendAllText(path, line + Environment.NewLine);
            _logLines++;
        }

        if (_logLines <= 40 || line.Contains("fail", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine($"[server] {line}");
        }
    }

    private static void Require(string name)
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(name)))
        {
            throw new InvalidOperationException($"{name} is required");
        }
    }

    private static void Copy(string name, ProcessStartInfo psi)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException($"{name} is required");
        }

        psi.Environment[name] = value;
    }

    private static void CopyOptional(string name, ProcessStartInfo psi)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrEmpty(value))
        {
            psi.Environment[name] = value;
        }
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}

internal static class RepoRoot
{
    public static string Path { get; } = Find();

    private static string Find()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(System.IO.Path.Combine(dir.FullName, "package.json"))
                && Directory.Exists(System.IO.Path.Combine(dir.FullName, "apps", "web")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        var cwd = new DirectoryInfo(Environment.CurrentDirectory);
        while (cwd is not null)
        {
            if (File.Exists(System.IO.Path.Combine(cwd.FullName, "package.json"))
                && Directory.Exists(System.IO.Path.Combine(cwd.FullName, "apps", "web")))
            {
                return cwd.FullName;
            }

            cwd = cwd.Parent;
        }

        throw new InvalidOperationException("Could not locate the repository root.");
    }
}
