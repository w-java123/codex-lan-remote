using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Codex 手机共享控制")]
[assembly: AssemblyDescription("启动 Codex LAN 手机共享控制")]

internal static class Launcher {
    [STAThread]
    private static int Main(string[] args) {
        bool atLogin = args.Contains("--login");
        try {
            string runtime = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.GetFullPath(Path.Combine(runtime, "..", "desktop", "launch-shared.mjs"));
            var info = new ProcessStartInfo(Path.Combine(runtime, "node.exe"));
            info.Arguments = "\"" + script + "\"";
            int data = Array.IndexOf(args, "--data");
            if (data >= 0 && data + 1 < args.Length) {
                info.EnvironmentVariables["CODEX_LAN_DATA_DIR"] = args[data + 1];
            }
            if (atLogin) info.Arguments += " --login";
            int session = Process.GetCurrentProcess().SessionId;
            if (Process.GetProcessesByName("ChatGPT").Any(p => p.SessionId == session)) {
                info.Arguments += " --desktop-existing";
            }
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardError = true;
            info.StandardErrorEncoding = System.Text.Encoding.UTF8;
            using (var process = Process.Start(info)) {
                string details = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0 && !atLogin) {
                    MessageBox.Show(details.Trim(), "Codex 手机共享控制");
                }
                return process.ExitCode;
            }
        } catch (Exception error) {
            if (!atLogin) MessageBox.Show(error.Message, "Codex 手机共享控制");
            return 1;
        }
    }
}
