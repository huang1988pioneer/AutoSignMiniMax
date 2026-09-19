using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MiniMaxFlow;

internal sealed class GitHubActionsService
{
    public const string Repository = "huang1988pioneer/AutoSignMiniMax";
    private const string Workflow = "checkin-minimax.yml";
    private static readonly Regex ClaimJobName = new(@"^check-in \((?<number>\d+)\) - (?<name>.+)$", RegexOptions.Compiled);

    public async Task TriggerClaimAsync()
    {
        await RunGhAsync("workflow", "run", Workflow, "--repo", Repository, "--ref", "main");
    }

    public async Task PublishLoginStateAsync(int accountNumber, string storageStateBase64, string accountName)
    {
        if (accountNumber is < 1 or > 33)
            throw new ArgumentOutOfRangeException(nameof(accountNumber), "帳號編號必須介於 1 至 33。");
        if (string.IsNullOrWhiteSpace(storageStateBase64))
            throw new ArgumentException("登入狀態不可為空白。", nameof(storageStateBase64));
        if (Encoding.UTF8.GetByteCount(storageStateBase64) > 48 * 1024)
            throw new InvalidOperationException("登入狀態超過 GitHub Actions Secret 的 48 KB 上限，無法同步。");
        if (string.IsNullOrWhiteSpace(accountName))
            throw new ArgumentException("帳號名稱不可為空白。", nameof(accountName));

        var secretName = $"MINIMAX_STORAGE_STATE_B64_{accountNumber}";
        var variableName = $"MINIMAX_ACCOUNT_NAME_{accountNumber}";

        // Pass the sensitive state through stdin so it never appears in the process command line.
        await RunGhWithInputAsync(
            storageStateBase64,
            "secret", "set", secretName, "--app", "actions", "--repo", Repository);
        await RunGhWithInputAsync(
            accountName,
            "variable", "set", variableName, "--repo", Repository);
    }

    public async Task<DashboardSnapshot> GetSnapshotAsync(decimal pointsPerClaim)
    {
        var runsJson = await RunGhAsync(
            "run", "list", "--workflow", Workflow, "--repo", Repository, "--limit", "100",
            "--json", "databaseId,createdAt,conclusion,status,url,event");
        var runs = JsonSerializer.Deserialize<List<WorkflowRun>>(runsJson, JsonOptions) ?? [];
        var latest = runs.OrderByDescending(run => run.CreatedAt).FirstOrDefault();

        var timeZone = GetTaipeiTimeZone();
        var successfulRuns = runs
            .Where(run => run.IsSuccessful)
            .OrderByDescending(run => run.CreatedAt)
            .ToArray();
        var failedRuns = runs
            .Where(run => run.IsFailed)
            .OrderByDescending(run => run.CreatedAt)
            .ToArray();
        var successfulDates = successfulRuns
            .Select(run => TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date)
            .ToHashSet();
        var today = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, timeZone).Date;
        var monthStart = new DateTime(today.Year, today.Month, 1);
        var monthlyRuns = runs
            .Where(run => TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date >= monthStart)
            .ToArray();
        var accountResultsByRun = new Dictionary<long, AccountResult[]>();
        foreach (var run in monthlyRuns)
            accountResultsByRun[run.DatabaseId] = await GetAccountResultsAsync(run.DatabaseId);
        if (latest is not null && !accountResultsByRun.ContainsKey(latest.DatabaseId))
            accountResultsByRun[latest.DatabaseId] = await GetAccountResultsAsync(latest.DatabaseId);
        var accounts = latest is null ? [] : accountResultsByRun[latest.DatabaseId];

        var consecutiveSuccessActionDays = 0;
        while (successfulDates.Contains(today.AddDays(-consecutiveSuccessActionDays))) consecutiveSuccessActionDays++;

        var lastSuccessfulActionTime = successfulRuns.FirstOrDefault() is { } successfulRun
            ? TimeZoneInfo.ConvertTime(successfulRun.CreatedAt, timeZone)
            : (DateTimeOffset?)null;
        var lastFailedActionTime = failedRuns.FirstOrDefault() is { } failedRun
            ? TimeZoneInfo.ConvertTime(failedRun.CreatedAt, timeZone)
            : (DateTimeOffset?)null;

        var successful = accounts.Where(account => account.IsConfigured && account.IsSuccessful).ToArray();
        var failed = accounts.Where(account => account.IsConfigured && account.IsCompleted && !account.IsSuccessful).ToArray();
        var monthlySuccessfulClaims = monthlyRuns
            .SelectMany(run => accountResultsByRun[run.DatabaseId]
                .Where(account => account.IsConfigured && account.IsSuccessful)
                .Select(account => (Date: TimeZoneInfo.ConvertTime(run.CreatedAt, timeZone).Date, account.Number)))
            .Distinct()
            .Count();
        var monthlyClaimedPoints = monthlySuccessfulClaims * pointsPerClaim;

        return new DashboardSnapshot(
            latest,
            accounts,
            successful,
            failed,
            lastSuccessfulActionTime,
            lastFailedActionTime,
            consecutiveSuccessActionDays,
            pointsPerClaim,
            monthlyClaimedPoints);
    }

    private async Task<AccountResult[]> GetAccountResultsAsync(long runId)
    {
        var detailsJson = await RunGhAsync("run", "view", runId.ToString(), "--repo", Repository, "--json", "jobs");
        using var document = JsonDocument.Parse(detailsJson);
        if (!document.RootElement.TryGetProperty("jobs", out var jobs)) return [];

        var results = new List<AccountResult>();
        foreach (var job in jobs.EnumerateArray())
        {
            var name = GetString(job, "name");
            var match = ClaimJobName.Match(name);
            if (!match.Success) continue;

            var number = int.Parse(match.Groups["number"].Value);
            var alias = match.Groups["name"].Value;
            var status = GetString(job, "status");
            var conclusion = GetString(job, "conclusion");
            results.Add(new AccountResult(number, alias, status, conclusion));
        }

        return results.OrderBy(result => result.Number).ToArray();
    }

    private static Task<string> RunGhAsync(params string[] arguments) =>
        RunGhCoreAsync(null, arguments);

    private static Task<string> RunGhWithInputAsync(string input, params string[] arguments) =>
        RunGhCoreAsync(input, arguments);

    private static async Task<string> RunGhCoreAsync(string? input, IReadOnlyList<string> arguments)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "gh",
                UseShellExecute = false,
                RedirectStandardInput = input is not null,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        if (!process.Start()) throw new InvalidOperationException("無法啟動 GitHub CLI（gh）。");

        if (input is not null)
        {
            await process.StandardInput.WriteAsync(input);
            await process.StandardInput.FlushAsync();
            process.StandardInput.Close();
        }

        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await outputTask;
        var error = await errorTask;
        if (process.ExitCode == 0) return output;

        var reason = string.IsNullOrWhiteSpace(error) ? output : error;
        reason = reason.Trim();
        if (reason.Length > 1_000) reason = reason[..1_000] + "…";
        if (reason.Contains("Failed to log in", StringComparison.OrdinalIgnoreCase) ||
            reason.Contains("not logged into", StringComparison.OrdinalIgnoreCase) ||
            reason.Contains("Bad credentials", StringComparison.OrdinalIgnoreCase) ||
            reason.Contains("HTTP 401", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "GitHub CLI 尚未登入或登入已過期。請在 PowerShell 執行 gh auth login -h github.com，完成後再同步。");
        }
        throw new InvalidOperationException($"GitHub CLI 執行失敗：{reason}");
    }

    private static TimeZoneInfo GetTaipeiTimeZone()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Taipei Standard Time"); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei"); }
    }

    private static string GetString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var property) && property.ValueKind != JsonValueKind.Null
            ? property.GetString() ?? string.Empty
            : string.Empty;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
}

internal sealed record WorkflowRun(long DatabaseId, DateTimeOffset CreatedAt, string Conclusion, string Status, string Url, string Event)
{
    public bool IsSuccessful => string.Equals(Conclusion, "success", StringComparison.OrdinalIgnoreCase);
    public bool IsCompleted => string.Equals(Status, "completed", StringComparison.OrdinalIgnoreCase);
    public bool IsFailed => IsCompleted && !string.IsNullOrWhiteSpace(Conclusion) && !IsSuccessful;
}

internal sealed record AccountResult(int Number, string Alias, string Status, string Conclusion)
{
    public bool IsConfigured => !Regex.IsMatch(Alias, "^account-\\d+$", RegexOptions.IgnoreCase);
    public bool IsSuccessful => string.Equals(Conclusion, "success", StringComparison.OrdinalIgnoreCase);
    public bool IsCompleted => string.Equals(Status, "completed", StringComparison.OrdinalIgnoreCase);
}

internal sealed record DashboardSnapshot(
    WorkflowRun? LatestRun,
    AccountResult[] Accounts,
    AccountResult[] SuccessfulAccounts,
    AccountResult[] FailedAccounts,
    DateTimeOffset? LastSuccessfulActionTime,
    DateTimeOffset? LastFailedActionTime,
    int ConsecutiveSuccessActionDays,
    decimal PointsPerClaim,
    decimal MonthlyClaimedPoints);
