using PiTravel.Server.Harness;
using PiTravel.Server.Hosting.Endpoints;

namespace PiTravel.Server.Hosting;

/// <summary>
/// Hosts the trip and AG-UI HTTP surface. <see cref="BuildApp"/> is the seam the
/// tests use to substitute a fake <see cref="TravelService"/>; <see cref="Main"/>
/// builds the real one from the environment.
/// </summary>
public class Program
{
    public static async Task Main(string[] args)
    {
        var app = CreateHostBuilder(args).Build();
        await app.RunAsync();
        await app.Services.GetRequiredService<TravelService>().CloseAsync();
    }

    /// <summary>
    /// The host builder <see cref="Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory{TEntryPoint}"/>
    /// discovers. Tests replace <see cref="TravelService"/> before the host is built.
    /// </summary>
    public static IHostBuilder CreateHostBuilder(string[] args)
    {
        var config = ServerConfig.FromEnvironment(ReadEnvironment());
        var urls = UrlFromArgs(args) ?? config.Urls;
        return Host.CreateDefaultBuilder(args)
            .ConfigureServices(services =>
            {
                services.AddSingleton(config);
                services.AddSingleton(provider =>
                    ServiceCollectionExtensions.CreateServiceAsync(config, CancellationToken.None)
                        .GetAwaiter()
                        .GetResult());
                services.ConfigureHttpJsonOptions(options =>
                {
                    options.SerializerOptions.PropertyNamingPolicy =
                        Contracts.TripJson.Options.PropertyNamingPolicy;
                    options.SerializerOptions.DefaultIgnoreCondition =
                        Contracts.TripJson.Options.DefaultIgnoreCondition;
                });
            })
            .ConfigureWebHostDefaults(web =>
            {
                web.UseUrls(urls);
                web.Configure(Routes);
            });
    }

    /// <summary>The <c>--urls</c> command-line value, which wins over the environment.</summary>
    private static string? UrlFromArgs(string[] args)
    {
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index].StartsWith("--urls=", StringComparison.OrdinalIgnoreCase))
            {
                return args[index]["--urls=".Length..];
            }

            if (args[index].Equals("--urls", StringComparison.OrdinalIgnoreCase)
                && index + 1 < args.Length)
            {
                return args[index + 1];
            }
        }

        return null;
    }

    /// <summary>Builds the HTTP application around an already-opened service.</summary>
    public static WebApplication BuildApp(ServerConfig config, TravelService service)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls(config.Urls);
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.PropertyNamingPolicy = Contracts.TripJson.Options.PropertyNamingPolicy;
            options.SerializerOptions.DefaultIgnoreCondition = Contracts.TripJson.Options.DefaultIgnoreCondition;
        });
        builder.Services.AddSingleton(config);
        builder.Services.AddSingleton(service);

        var app = builder.Build();
        Routes(app);
        return app;
    }

    private static void Routes(IApplicationBuilder app)
    {
        app.UseRouting();
        app.UseEndpoints(endpoints =>
        {
            endpoints.MapGet("/health", () => Results.Ok(new { ok = true }));
            TripsEndpoints.Map(endpoints);
            AguiEndpoints.Map(endpoints);
        });
    }

    private static Dictionary<string, string?> ReadEnvironment()
    {
        var env = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string name) env[name] = entry.Value as string;
        }

        return env;
    }
}
