using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
using System.Diagnostics;

namespace DshBackground {
    // Console.In is a synchronized reader: ReadLineAsync can still block.
    // Read on a background thread so the policy loop can apply before the next command.
    public sealed class BorderCommands {
        readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
        volatile bool ended;
        public bool Ended { get { return ended; } }
        public BorderCommands() {
            var reader = new Thread(delegate() {
                try { string line; while ((line = Console.In.ReadLine()) != null) commands.Enqueue(line); }
                catch (Exception) { }
                finally { ended = true; }
            });
            reader.IsBackground = true; reader.Start();
        }
        public bool TryRead(out string command) { return commands.TryDequeue(out command); }
    }
    // DWMWA_BORDER_COLOR is independent of resize hit testing and title buttons.
    // https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
    public sealed class WindowBorder : IDisposable {
        const int BorderColor = 34;
        const uint ColorNone = 0xfffffffe;
        const uint ColorDefault = 0xffffffff;
        const string PolicyProperty = "dsh-bg.WindowBorder.Owner";
        readonly uint owner;
        readonly IntPtr marker = new IntPtr(Process.GetCurrentProcess().Id);
        readonly Dictionary<IntPtr, uint> applied = new Dictionary<IntPtr, uint>();
        bool superseded;
        public int Count { get { return applied.Count; } }
        public int Writes { get; private set; }
        public int RestoreFailures { get; private set; }
        public IList<IntPtr> Targets { get { return new List<IntPtr>(applied.Keys).AsReadOnly(); } }
        public WindowBorder(int ownerPid) { owner = (uint)ownerPid; }
        delegate bool EnumProc(IntPtr hwnd, IntPtr param);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int size);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int size);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr hwnd, string name);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr hwnd, string name);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref uint value, int size);
        bool Owned(IntPtr hwnd) {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid != owner || GetWindow(hwnd, 4) != IntPtr.Zero) return false;
            var type = new StringBuilder(256); GetClassName(hwnd, type, type.Capacity);
            return type.ToString() == "Chrome_WidgetWin_1";
        }
        bool Eligible(IntPtr hwnd) {
            if (!Owned(hwnd)) return false;
            var title = new StringBuilder(1024); GetWindowText(hwnd, title, title.Capacity);
            return title.ToString().EndsWith("DeepSeek Harness", StringComparison.Ordinal);
        }
        public void Update(bool hidden) {
            if (!hidden) { Restore(); return; }
            if (superseded) return;
            foreach (var hwnd in new List<IntPtr>(applied.Keys)) {
                if (!Owned(hwnd)) { applied.Remove(hwnd); continue; }
                var tag = GetProp(hwnd, PolicyProperty);
                if (tag == IntPtr.Zero) applied.Remove(hwnd); // destroyed/reused handle
                else if (tag != marker) { superseded = true; Restore(); return; }
            }
            EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
                if (!Eligible(hwnd)) return true;
                uint dpi = GetDpiForWindow(hwnd), previousDpi;
                if (applied.TryGetValue(hwnd, out previousDpi) && previousDpi == dpi) return true;
                uint next = ColorNone;
                if (DwmSetWindowAttribute(hwnd, BorderColor, ref next, 4) == 0) {
                    if (SetProp(hwnd, PolicyProperty, marker)) { applied[hwnd] = dpi; Writes++; }
                    else { next = ColorDefault; DwmSetWindowAttribute(hwnd, BorderColor, ref next, 4); }
                }
                return true;
            }, IntPtr.Zero);
        }
        void Restore() {
            foreach (var pair in applied) {
                if (!Owned(pair.Key) || GetProp(pair.Key, PolicyProperty) != marker) continue;
                // BORDER_COLOR is a Set-only attribute (Get returns E_INVALIDARG).
                // DSH uses the system default: restore the documented sentinel.
                uint previous = ColorDefault;
                if (DwmSetWindowAttribute(pair.Key, BorderColor, ref previous, 4) != 0) RestoreFailures++;
                RemoveProp(pair.Key, PolicyProperty);
            }
            applied.Clear();
        }
        public void Dispose() { Restore(); }
    }
}
