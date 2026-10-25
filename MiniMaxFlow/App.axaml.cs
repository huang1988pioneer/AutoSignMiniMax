using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Platform;

namespace MiniMaxFlow;

public partial class App : Application
{
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        ApplyDockIcon();
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
            desktop.MainWindow = new MainWindow();
        base.OnFrameworkInitializationCompleted();
    }

    private static void ApplyDockIcon()
    {
        if (!OperatingSystem.IsMacOS())
            return;

        using var stream = AssetLoader.Open(new Uri("avares://MiniMaxFlow/Assets/icon.png"));
        var path = Path.Combine(Path.GetTempPath(), "minimax-flow-icon.png");
        using (var file = File.Create(path))
            stream.CopyTo(file);
        MacDockIcon.TryApply(path);
    }
}
