using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Threading;

namespace MiniMaxFlow;

public partial class MainWindow : Window
{
    private const string MiniMaxUrl = "https://agent.minimax.io/";
    private const int AccountCount = 33;
    private readonly string _workspace = FindWorkspace();
    private readonly GitHubActionsService _githubActions = new();
    private readonly Dictionary<int, TextBox> _aliasInputs = new();
    private readonly Dictionary<int, string> _accountAliases = LoadAccountAliases();
    private readonly CancellationTokenSource _lifetimeCancellation = new();

    public MainWindow()
    {
        InitializeComponent();
        AccountComboBox.ItemsSource = Enumerable.Range(1, AccountCount).Select(number => $"帳號 {number:00}").ToArray();
        AccountComboBox.SelectionChanged += (_, _) => UpdateSecretName();
        Closed += (_, _) => _lifetimeCancellation.Cancel();
        BuildAliasList();
        UpdateSecretName();
    }

    private int AccountNumber => AccountComboBox.SelectedIndex + 1;
    private string StateFile => Path.Combine(_workspace, $"auth-{AccountNumber:00}.json");
    private string LegacyStateFile => Path.Combine(_workspace, $"auth-{AccountNumber}.json");
    private string SecretName => $"MINIMAX_STORAGE_STATE_B64_{AccountNumber}";
    private string AccountNameVariable => $"MINIMAX_ACCOUNT_NAME_{AccountNumber}";
    private string? AccountAlias => _accountAliases.GetValueOrDefault(AccountNumber);

    private void UpdateSecretName()
    {
        SecretNameText.Text = SecretName;
        AccountAliasText.Text = AccountAlias ?? string.Empty;
        AccountAliasText.IsVisible = AccountAlias is not null;
        var existingStateFile = ExistingStateFile();
        ResultText.Text = existingStateFile is null
            ? "登入完成並關閉瀏覽器後，讀取 auth-NN.json 並複製 Base64 至剪貼簿。"
            : $"已找到 {Path.GetFileName(existingStateFile)}。可直接讀取並複製 Base64 至剪貼簿。";
        CopyStateButton.IsEnabled = existingStateFile is not null;
        PublishActionsButton.IsEnabled = existingStateFile is not null;
        CopySecretNameButton.IsEnabled = false;
    }

    private async void RunFlowButton_OnClick(object? sender, RoutedEventArgs e)
    {
        RunFlowButton.IsEnabled = false;
        CopyStateButton.IsEnabled = false;
        CopySecretNameButton.IsEnabled = false;
        try
        {
            await EnsurePlaywrightAsync(_lifetimeCancellation.Token);
            var browser = await ChooseLoginBrowserAsync(_lifetimeCancellation.Token);

            if (File.Exists(StateFile)) File.Delete(StateFile);
            SetStatus($"正在開啟 {browser.DisplayName}。請完成 MiniMax 登入，確認成功後關閉瀏覽器視窗。");
            var codegenArguments = new List<string> { "playwright", "codegen" };
            if (browser.Channel is not null)
            {
                codegenArguments.Add("--channel");
                codegenArguments.Add(browser.Channel);
            }
            codegenArguments.Add("--save-storage");
            codegenArguments.Add(Path.GetFileName(StateFile));
            codegenArguments.Add(MiniMaxUrl);
            await RunProcessAsync(
                NodeCommandPath("npx"),
                codegenArguments,
                _workspace,
                cancellationToken: _lifetimeCancellation.Token);

            if (!File.Exists(StateFile))
                throw new InvalidOperationException("找不到登入狀態檔。請確認是在瀏覽器中登入完成後才關閉。\n");

            ResultText.Text = $"已建立 {Path.GetFileName(StateFile)}。請按下「讀取並複製登入狀態」，再貼到 GitHub Secret：{SecretName}。";
            StatusText.Text = "登入狀態檔已建立，等待你確認複製。";
            CopyStateButton.IsEnabled = true;
            PublishActionsButton.IsEnabled = true;
            if (AutoPublishActionsCheckBox.IsChecked == true)
                await PublishCurrentStateToActionsAsync();
        }
        catch (OperationCanceledException) when (_lifetimeCancellation.IsCancellationRequested)
        {
            // Closing the tool must also close its browser/install child process.
        }
        catch (Exception exception)
        {
            StatusText.Text = $"流程未完成：{exception.Message}";
            ResultText.Text = "沒有複製任何登入狀態。請修正問題後重新執行。";
        }
        finally
        {
            if (!_lifetimeCancellation.IsCancellationRequested)
                RunFlowButton.IsEnabled = true;
        }
    }

    private async void CopySecretNameButton_OnClick(object? sender, RoutedEventArgs e)
    {
        if (Clipboard is { } clipboard) await clipboard.SetTextAsync(SecretName);
        StatusText.Text = $"已複製 {SecretName}。";
    }

    private async void PublishActionsButton_OnClick(object? sender, RoutedEventArgs e) =>
        await PublishCurrentStateToActionsAsync();

    private async void TriggerClaimButton_OnClick(object? sender, RoutedEventArgs e)
    {
        TriggerClaimButton.IsEnabled = false;
        RefreshDashboardButton.IsEnabled = false;
        DashboardStatusText.Text = "正在送出 GitHub Actions 手動執行請求…";
        try
        {
            await _githubActions.TriggerClaimAsync();
            DashboardStatusText.Text = "已觸發每日簽到 workflow。啟動後按「更新執行結果」即可查看帳號進度。";
        }
        catch (Exception exception)
        {
            DashboardStatusText.Text = $"無法觸發 workflow：{exception.Message}";
        }
        finally
        {
            TriggerClaimButton.IsEnabled = true;
            RefreshDashboardButton.IsEnabled = true;
        }
    }

    private void DashboardNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(DashboardView);

    private void AccountNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(AccountView);

    private void LoginNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(LoginView);

    private void ShowView(Control view)
    {
        DashboardView.IsVisible = view == DashboardView;
        AccountView.IsVisible = view == AccountView;
        LoginView.IsVisible = view == LoginView;
        view.BringIntoView();
    }

    private async void RefreshDashboardButton_OnClick(object? sender, RoutedEventArgs e)
    {
        TriggerClaimButton.IsEnabled = false;
        RefreshDashboardButton.IsEnabled = false;
        DashboardStatusText.Text = "正在讀取 GitHub Actions 執行紀錄…";
        try
        {
            var pointsPerClaim = ParsePointsPerClaim();
            var snapshot = await _githubActions.GetSnapshotAsync(pointsPerClaim);
            RenderDashboard(snapshot);
        }
        catch (Exception exception)
        {
            DashboardStatusText.Text = $"無法讀取 GitHub Actions：{exception.Message}";
        }
        finally
        {
            TriggerClaimButton.IsEnabled = true;
            RefreshDashboardButton.IsEnabled = true;
        }
    }

    private decimal ParsePointsPerClaim()
    {
        if (decimal.TryParse(PointsPerClaimTextBox.Text, out var points) && points >= 0) return points;
        PointsPerClaimTextBox.Text = "20";
        return 20;
    }

    private void RenderDashboard(DashboardSnapshot snapshot)
    {
        SuccessfulAccountsMetric.Text = $"{snapshot.SuccessfulAccounts.Length} 個";
        ConsecutiveSuccessActionDaysMetric.Text = $"{snapshot.ConsecutiveSuccessActionDays} 天";
        MonthlyPointsMetric.Text = snapshot.MonthlyClaimedPoints.ToString("0.##");
        LastSuccessfulActionMetric.Text = FormatActionTime(snapshot.LastSuccessfulActionTime);
        LastFailedActionMetric.Text = FormatActionTime(snapshot.LastFailedActionTime);

        if (snapshot.LatestRun is null)
        {
            DashboardStatusText.Text = "找不到每日簽到 workflow 的執行紀錄。";
            ActionAccountResultsPanel.Children.Clear();
            return;
        }

        var runStatus = string.IsNullOrWhiteSpace(snapshot.LatestRun.Conclusion)
            ? snapshot.LatestRun.Status
            : snapshot.LatestRun.Conclusion;
        var unconfiguredCount = snapshot.Accounts.Count(account => !account.IsConfigured);
        DashboardStatusText.Text =
            $"最近執行：{snapshot.LatestRun.CreatedAt.LocalDateTime:g} · {runStatus} · " +
            $"成功 {snapshot.SuccessfulAccounts.Length} 個、失敗 {snapshot.FailedAccounts.Length} 個、未設定 {unconfiguredCount} 個。";

        ActionAccountResultsPanel.Children.Clear();
        foreach (var account in snapshot.Accounts)
        {
            var alias = account.IsConfigured
                ? _accountAliases.GetValueOrDefault(account.Number) ?? account.Alias
                : "未設定帳號";
            var result = !account.IsConfigured
                ? "尚未設定登入狀態"
                : account.IsSuccessful
                ? "登入有效、領取流程成功"
                : account.IsCompleted ? "登入或領取流程失敗" : "尚在執行或未設定";
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("78,160,*") };
            row.Children.Add(new TextBlock { Text = $"帳號 {account.Number:00}", FontWeight = Avalonia.Media.FontWeight.SemiBold });
            var aliasText = new TextBlock { Text = alias, TextTrimming = Avalonia.Media.TextTrimming.CharacterEllipsis };
            Grid.SetColumn(aliasText, 1);
            row.Children.Add(aliasText);
            var stateText = new TextBlock { Text = result };
            Grid.SetColumn(stateText, 2);
            row.Children.Add(stateText);
            ActionAccountResultsPanel.Children.Add(row);
        }

        if (snapshot.Accounts.Length == 0)
            ActionAccountResultsPanel.Children.Add(new TextBlock { Text = "最新 run 尚未建立帳號 job；請稍後再更新。" });
    }

    private static string FormatActionTime(DateTimeOffset? actionTime) =>
        actionTime is { } value ? value.ToString("yyyy/MM/dd HH:mm") : "—";

    private async void CopyStateButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var stateFile = ExistingStateFile();
        if (stateFile is null)
        {
            StatusText.Text = $"找不到 {Path.GetFileName(StateFile)}。請重新執行登入流程。";
            CopyStateButton.IsEnabled = false;
            return;
        }

        var encoded = Convert.ToBase64String(await File.ReadAllBytesAsync(stateFile));
        var duplicateAccounts = await FindDuplicateStateFilesAsync(encoded);
        if (duplicateAccounts.Count > 0)
        {
            ResultText.Text = $"偵測到與帳號 {string.Join("、", duplicateAccounts.Select(number => number.ToString("00")))} 相同的登入狀態，未複製到剪貼簿。";
            StatusText.Text = "請使用不同的 MiniMax 帳號重新登入後再建立狀態，避免重複簽到。";
            return;
        }
        if (Clipboard is { } clipboard) await clipboard.SetTextAsync(encoded);
        ResultText.Text = $"已複製 {Path.GetFileName(stateFile)} 的 Base64（{encoded.Length:N0} 個字元）。貼到 GitHub Repository Secret：{SecretName}。";
        StatusText.Text = "登入狀態已複製；請勿將其貼入聊天訊息或提交到 Git。";
        CopySecretNameButton.IsEnabled = true;
    }

    private async Task PublishCurrentStateToActionsAsync()
    {
        var stateFile = ExistingStateFile();
        if (stateFile is null)
        {
            SetStatus($"找不到 {Path.GetFileName(StateFile)}。請重新執行登入流程。");
            PublishActionsButton.IsEnabled = false;
            return;
        }

        var accountNumber = AccountNumber;
        var secretName = SecretName;
        var variableName = AccountNameVariable;
        var accountName = AccountAlias ?? $"account-{accountNumber}";
        var encoded = Convert.ToBase64String(await File.ReadAllBytesAsync(stateFile));
        var duplicateAccounts = await FindDuplicateStateFilesAsync(encoded);
        if (duplicateAccounts.Count > 0)
        {
            ResultText.Text = $"偵測到與帳號 {string.Join("、", duplicateAccounts.Select(number => number.ToString("00")))} 相同的登入狀態，未同步到 GitHub。";
            SetStatus("請使用不同的 MiniMax 帳號重新登入後再建立狀態，避免重複簽到。");
            return;
        }

        PublishActionsButton.IsEnabled = false;
        SetStatus($"正在安全寫入 GitHub Actions Secret：{secretName}…");
        try
        {
            await _githubActions.PublishLoginStateAsync(accountNumber, encoded, accountName);
            ResultText.Text = $"已寫入 GitHub Actions Secret：{secretName}，並更新 Variable：{variableName}（{accountName}）。";
            SetStatus("GitHub Actions 已同步完成；登入狀態不會顯示在畫面、命令列或日誌中。");
        }
        catch (Exception exception)
        {
            ResultText.Text = "登入狀態仍保留在這台電腦，尚未同步到 GitHub。可完成 GitHub CLI 登入後重試。";
            SetStatus($"GitHub Actions 同步失敗：{exception.Message}");
        }
        finally
        {
            PublishActionsButton.IsEnabled = ExistingStateFile() is not null;
        }
    }

    private void BuildAliasList()
    {
        AliasListPanel.Children.Clear();
        for (var number = 1; number <= AccountCount; number++)
        {
            var input = new TextBox
            {
                Width = 330,
                PlaceholderText = "帳號名稱（可留白）",
                Text = _accountAliases.GetValueOrDefault(number) ?? string.Empty,
            };
            var accountNumber = number;
            input.TextChanged += (_, _) =>
            {
                var alias = input.Text?.Trim() ?? string.Empty;
                if (string.IsNullOrEmpty(alias)) _accountAliases.Remove(accountNumber);
                else _accountAliases[accountNumber] = alias;
                if (accountNumber == AccountNumber) UpdateSecretName();
            };
            _aliasInputs[number] = input;

            var row = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 10 };
            row.Children.Add(new TextBlock { Text = $"帳號 {number:00}", Width = 68, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center });
            row.Children.Add(input);
            AliasListPanel.Children.Add(row);
        }
    }

    private async void SaveAliasesButton_OnClick(object? sender, RoutedEventArgs e)
    {
        foreach (var (number, input) in _aliasInputs)
        {
            var alias = input.Text?.Trim() ?? string.Empty;
            if (string.IsNullOrEmpty(alias)) _accountAliases.Remove(number);
            else _accountAliases[number] = alias;
        }

        var directory = Path.GetDirectoryName(AliasFile);
        if (directory is not null) Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(AliasFile, JsonSerializer.Serialize(_accountAliases));
        UpdateSecretName();
        StatusText.Text = "帳號別名已儲存在這台電腦。";
    }

    private string? ExistingStateFile()
    {
        if (File.Exists(StateFile)) return StateFile;
        return File.Exists(LegacyStateFile) ? LegacyStateFile : null;
    }

    private async Task<IReadOnlyList<int>> FindDuplicateStateFilesAsync(string currentState)
    {
        var duplicates = new List<int>();
        foreach (var file in Directory.EnumerateFiles(_workspace, "auth-*.json"))
        {
            if (string.Equals(file, StateFile, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(file, LegacyStateFile, StringComparison.OrdinalIgnoreCase))
                continue;

            var suffix = Path.GetFileNameWithoutExtension(file)["auth-".Length..];
            if (!int.TryParse(suffix, out var accountNumber)) continue;
            if (Convert.ToBase64String(await File.ReadAllBytesAsync(file)) == currentState)
                duplicates.Add(accountNumber);
        }
        return duplicates;
    }

    private static string AliasFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "MiniMaxFlow",
        "account-aliases.json");

    private static Dictionary<int, string> LoadAccountAliases()
    {
        var defaults = new Dictionary<int, string>
        {
            [1] = "huang1988pioneer",
            [2] = "abuhg17",
            [3] = "goldshoot0720",
        };
        if (!File.Exists(AliasFile)) return defaults;

        try
        {
            return JsonSerializer.Deserialize<Dictionary<int, string>>(File.ReadAllText(AliasFile)) ?? defaults;
        }
        catch (JsonException)
        {
            return defaults;
        }
    }

    private async Task EnsurePlaywrightAsync(CancellationToken cancellationToken)
    {
        if (File.Exists(Path.Combine(_workspace, "node_modules", "playwright", "cli.js")))
        {
            SetStatus("已找到 Playwright 相依套件。");
            return;
        }

        var maximumWait = TimeSpan.FromMinutes(3);
        SetStatus("第一次使用，正在安裝登入工具所需元件…");
        try
        {
            await RunProcessAsync(
                NodeCommandPath("npm"),
                ["install"],
                _workspace,
                timeout: maximumWait,
                waitingUpdate: elapsed => SetStatus($"第一次使用，正在安裝登入工具所需元件（已等待 {FormatElapsed(elapsed)}／最多 {FormatElapsed(maximumWait)}）…"),
                cancellationToken: cancellationToken);
        }
        catch (TimeoutException exception)
        {
            throw new InvalidOperationException(
                "安裝 Playwright 相依套件超過 3 分鐘，已自動停止。請確認網路正常後重試。",
                exception);
        }
    }

    private async Task<LoginBrowser> ChooseLoginBrowserAsync(CancellationToken cancellationToken)
    {
        var installedBrowser = FindInstalledBrowser();
        if (installedBrowser is not null)
        {
            SetStatus($"已找到 {installedBrowser.DisplayName}，將直接使用，不需下載 Chromium。");
            return installedBrowser;
        }

        var maximumWait = TimeSpan.FromMinutes(5);
        SetStatus("找不到可用的 Microsoft Edge 或 Google Chrome，正在準備 Playwright Chromium…");
        try
        {
            await RunProcessAsync(
                NodeCommandPath("npx"),
                ["playwright", "install", "chromium"],
                _workspace,
                timeout: maximumWait,
                waitingUpdate: elapsed => SetStatus($"正在準備 Playwright Chromium（已等待 {FormatElapsed(elapsed)}／最多 {FormatElapsed(maximumWait)}）…"),
                cancellationToken: cancellationToken);
        }
        catch (TimeoutException exception)
        {
            throw new InvalidOperationException(
                "內建 Chromium 準備超過 5 分鐘，已自動停止。請安裝或更新 Microsoft Edge／Google Chrome 後重試。",
                exception);
        }

        return new LoginBrowser(null, "Playwright Chromium", Array.Empty<string>());
    }

    private static LoginBrowser? FindInstalledBrowser() =>
        GetInstalledBrowserCandidates().FirstOrDefault(candidate => candidate.ExecutablePaths.Any(File.Exists));

    private static IReadOnlyList<LoginBrowser> GetInstalledBrowserCandidates()
    {
        if (OperatingSystem.IsWindows())
        {
            var programFiles = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            }.Where(path => !string.IsNullOrWhiteSpace(path));
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            return new[]
            {
                new LoginBrowser(
                    "msedge",
                    "Microsoft Edge",
                    programFiles
                        .Select(path => Path.Combine(path, "Microsoft", "Edge", "Application", "msedge.exe"))
                        .Append(Path.Combine(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"))
                        .ToArray()),
                new LoginBrowser(
                    "chrome",
                    "Google Chrome",
                    programFiles
                        .Select(path => Path.Combine(path, "Google", "Chrome", "Application", "chrome.exe"))
                        .Append(Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe"))
                        .ToArray()),
            };
        }

        if (OperatingSystem.IsMacOS())
        {
            return new[]
            {
                new LoginBrowser("msedge", "Microsoft Edge", ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]),
                new LoginBrowser("chrome", "Google Chrome", ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]),
            };
        }

        return new[]
        {
            new LoginBrowser("msedge", "Microsoft Edge", ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"]),
            new LoginBrowser("chrome", "Google Chrome", ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]),
        };
    }

    private void SetStatus(string status)
    {
        if (Dispatcher.UIThread.CheckAccess())
        {
            StatusText.Text = status;
            return;
        }

        Dispatcher.UIThread.Post(() => StatusText.Text = status);
    }

    private static string FormatElapsed(TimeSpan elapsed) =>
        elapsed.TotalMinutes >= 1
            ? $"{Math.Ceiling(elapsed.TotalMinutes):0} 分鐘"
            : $"{Math.Max(1, Math.Ceiling(elapsed.TotalSeconds)):0} 秒";

    private static async Task RunProcessAsync(
        string fileName,
        IEnumerable<string> arguments,
        string workingDirectory,
        TimeSpan? timeout = null,
        Action<TimeSpan>? waitingUpdate = null,
        CancellationToken cancellationToken = default)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
        };
        foreach (var argument in arguments)
            process.StartInfo.ArgumentList.Add(argument);

        cancellationToken.ThrowIfCancellationRequested();
        if (!process.Start()) throw new InvalidOperationException($"無法啟動 {fileName}。");
        var standardOutput = process.StandardOutput.ReadToEndAsync();
        var standardError = process.StandardError.ReadToEndAsync();
        var processExit = process.WaitForExitAsync();
        var elapsed = Stopwatch.StartNew();
        try
        {
            while (!processExit.IsCompleted)
            {
                var nextUpdate = TimeSpan.FromSeconds(5);
                if (timeout is { } maximumWait)
                {
                    var remaining = maximumWait - elapsed.Elapsed;
                    if (remaining <= TimeSpan.Zero)
                        throw new TimeoutException($"{fileName} 超過 {FormatElapsed(maximumWait)} 尚未完成。");
                    if (remaining < nextUpdate) nextUpdate = remaining;
                }

                if (await Task.WhenAny(processExit, Task.Delay(nextUpdate, cancellationToken)) == processExit)
                    break;

                cancellationToken.ThrowIfCancellationRequested();
                if (timeout is { } timeoutAfter && elapsed.Elapsed >= timeoutAfter)
                    throw new TimeoutException($"{fileName} 超過 {FormatElapsed(timeoutAfter)} 尚未完成。");
                waitingUpdate?.Invoke(elapsed.Elapsed);
            }

            await processExit;
        }
        catch (OperationCanceledException)
        {
            await StopProcessTreeAsync(process);
            throw;
        }
        catch (TimeoutException)
        {
            await StopProcessTreeAsync(process);
            throw;
        }

        var output = await standardOutput;
        var error = await standardError;
        if (process.ExitCode != 0)
        {
            var details = SummarizeProcessFailure(error, output);
            throw new InvalidOperationException(
                $"{fileName} 執行失敗（結束碼 {process.ExitCode}）。{details}");
        }
    }

    private static async Task StopProcessTreeAsync(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // The process exited between the status check and Kill.
        }

        try
        {
            await process.WaitForExitAsync();
        }
        catch (InvalidOperationException)
        {
            // There is nothing left to wait for.
        }
    }

    private sealed record LoginBrowser(string? Channel, string DisplayName, IReadOnlyList<string> ExecutablePaths);

    private static string SummarizeProcessFailure(string standardError, string standardOutput)
    {
        var details = string.IsNullOrWhiteSpace(standardError) ? standardOutput : standardError;
        var lines = details
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Take(12);
        var summary = string.Join(Environment.NewLine, lines);
        if (summary.Length > 1_500) summary = summary[..1_500] + "…";
        return string.IsNullOrWhiteSpace(summary) ? string.Empty : $"{Environment.NewLine}{summary}";
    }

    private static string NodeCommandPath(string commandName)
    {
        if (!OperatingSystem.IsWindows()) return commandName;

        var nodeDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "nodejs");
        var executableName = commandName.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
            ? commandName
            : $"{commandName}.cmd";
        var commandPath = Path.Combine(nodeDirectory, executableName);
        return File.Exists(commandPath) ? commandPath : commandName;
    }

    private static string FindWorkspace()
    {
        foreach (var startPath in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory }.Distinct())
        {
            for (var directory = new DirectoryInfo(startPath); directory is not null; directory = directory.Parent)
                if (File.Exists(Path.Combine(directory.FullName, "package.json")) && IsWritableDirectory(directory.FullName))
                    return directory.FullName;
        }

        var workspace = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "MiniMaxFlow",
            "workspace");
        Directory.CreateDirectory(workspace);
        EnsureNodeProjectFiles(workspace);
        return workspace;
    }

    private static bool IsWritableDirectory(string directory)
    {
        try
        {
            var probe = Path.Combine(directory, $".minimax-flow-write-test-{Guid.NewGuid():N}");
            File.WriteAllText(probe, string.Empty);
            File.Delete(probe);
            return true;
        }
        catch (Exception) when (OperatingSystem.IsMacOS() || OperatingSystem.IsLinux() || OperatingSystem.IsWindows())
        {
            return false;
        }
    }

    private static void EnsureNodeProjectFiles(string workspace)
    {
        var packageJson = Path.Combine(workspace, "package.json");
        if (!File.Exists(packageJson))
        {
            File.WriteAllText(packageJson, """
            {
              "name": "minimax-flow-login-workspace",
              "private": true,
              "version": "1.0.0",
              "type": "module",
              "devDependencies": {
                "playwright": "1.55.0"
              }
            }
            """);
        }
    }
}
