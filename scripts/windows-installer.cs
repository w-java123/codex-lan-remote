using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;
using System.Windows.Forms;

internal static class Installer {
    [STAThread]
    private static int Main(string[] args) {
        try {
            bool extractOnly = args.Length == 2 && args[0] == "--extract-only";
            if (args.Length != 0 && !extractOnly) throw new ArgumentException("Invalid arguments");
            string destination = extractOnly ? Path.GetFullPath(args[1]) : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CodexLAN", "install-bundles", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(destination);
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("bundle.zip"))
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
                zip.ExtractToDirectory(destination);
            if (extractOnly) return 0;
            var start = new ProcessStartInfo {
                FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(destination, "install-desktop-plugin.ps1") + "\"",
                WorkingDirectory = destination,
                UseShellExecute = false
            };
            using (var process = Process.Start(start)) {
                process.WaitForExit();
                if (process.ExitCode != 0) throw new Exception("Installation failed. Installer exit code: " + process.ExitCode);
            }
            MessageBox.Show("Installed. Open Phone Connection Settings from your desktop.", "Codex LAN");
            return 0;
        } catch (Exception error) {
            if (args.Length == 0) MessageBox.Show(error.Message, "Codex LAN");
            return 1;
        }
    }
}
