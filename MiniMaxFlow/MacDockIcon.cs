using System.Runtime.InteropServices;

namespace MiniMaxFlow;

internal static class MacDockIcon
{
    public static void TryApply(string pngPath)
    {
        if (!OperatingSystem.IsMacOS() || !File.Exists(pngPath))
            return;

        var pathPtr = Marshal.StringToCoTaskMemUTF8(pngPath);
        try
        {
            var app = Send(GetClass("NSApplication"), Sel("sharedApplication"));
            var path = SendUtf8(Send(GetClass("NSString"), Sel("alloc")), Sel("initWithUTF8String:"), pathPtr);
            var image = SendArg(Send(GetClass("NSImage"), Sel("alloc")), Sel("initWithContentsOfFile:"), path);
            if (image == IntPtr.Zero)
                return;
            SendArg(app, Sel("setApplicationIconImage:"), image);
        }
        finally
        {
            Marshal.FreeCoTaskMem(pathPtr);
        }
    }

    [DllImport("/usr/lib/libobjc.A.dylib", CharSet = CharSet.Ansi)]
    private static extern IntPtr objc_getClass(string name);

    [DllImport("/usr/lib/libobjc.A.dylib", CharSet = CharSet.Ansi)]
    private static extern IntPtr sel_registerName(string name);

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    private static extern IntPtr Send(IntPtr receiver, IntPtr selector);

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    private static extern IntPtr SendArg(IntPtr receiver, IntPtr selector, IntPtr arg);

    [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    private static extern IntPtr SendUtf8(IntPtr receiver, IntPtr selector, IntPtr utf8);

    private static IntPtr GetClass(string name) => objc_getClass(name);

    private static IntPtr Sel(string name) => sel_registerName(name);
}
