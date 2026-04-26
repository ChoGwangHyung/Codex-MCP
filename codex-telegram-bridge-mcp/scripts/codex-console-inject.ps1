param(
  [Parameter(Mandatory = $true)]
  [Alias("Pid")]
  [int]$TargetPid,
  [Parameter(Mandatory = $true)]
  [AllowEmptyString()]
  [string]$TextBase64,
  [ValidateRange(0, 5000)]
  [int]$SubmitDelayMs = 150,
  [switch]$NoSubmit
)

$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CodexConsoleInput {
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool AttachConsole(uint dwProcessId);

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool FreeConsole();

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern IntPtr CreateFile(
    string lpFileName,
    uint dwDesiredAccess,
    uint dwShareMode,
    IntPtr lpSecurityAttributes,
    uint dwCreationDisposition,
    uint dwFlagsAndAttributes,
    IntPtr hTemplateFile);

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool WriteConsoleInputW(
    IntPtr hConsoleInput,
    INPUT_RECORD[] lpBuffer,
    uint nLength,
    out uint lpNumberOfEventsWritten);

  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)]
  private struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct KEY_EVENT_RECORD {
    [MarshalAs(UnmanagedType.Bool)] public bool bKeyDown;
    public ushort wRepeatCount;
    public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode;
    public char UnicodeChar;
    public uint dwControlKeyState;
  }

  private const uint GENERIC_READ = 0x80000000;
  private const uint GENERIC_WRITE = 0x40000000;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint OPEN_EXISTING = 3;
  private const ushort KEY_EVENT = 0x0001;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  public static string Inject(uint pid, string text, bool submit, int submitDelayMs) {
    FreeConsole();
    if (!AttachConsole(pid)) {
      throw new InvalidOperationException("AttachConsole failed: " + Marshal.GetLastWin32Error());
    }

    IntPtr input = CreateFile(
      "CONIN$",
      GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      IntPtr.Zero,
      OPEN_EXISTING,
      0,
      IntPtr.Zero);

    if (input == INVALID_HANDLE_VALUE) {
      int error = Marshal.GetLastWin32Error();
      FreeConsole();
      throw new InvalidOperationException("CreateFile(CONIN$) failed: " + error);
    }

    try {
      var textRecords = new List<INPUT_RECORD>(text.Length * 2);
      foreach (char ch in text) {
        textRecords.Add(TextKeyRecord(ch, true));
        textRecords.Add(TextKeyRecord(ch, false));
      }

      uint textWritten = WriteInputRecords(input, textRecords);
      if (submit && submitDelayMs > 0) {
        System.Threading.Thread.Sleep(submitDelayMs);
      }
      uint submitWritten = submit ? WriteInputRecords(input, EnterRecords()) : 0;

      int totalRecords = textRecords.Count + (submit ? 2 : 0);
      uint totalWritten = textWritten + submitWritten;
      return "{\"ok\":true,\"pid\":" + pid + ",\"chars\":" + text.Length + ",\"submit\":" + (submit ? "true" : "false") + ",\"submitDelayMs\":" + submitDelayMs + ",\"textRecords\":" + textRecords.Count + ",\"textWritten\":" + textWritten + ",\"submitRecords\":" + (submit ? 2 : 0) + ",\"submitWritten\":" + submitWritten + ",\"records\":" + totalRecords + ",\"written\":" + totalWritten + "}";
    } finally {
      CloseHandle(input);
      FreeConsole();
    }
  }

  private static uint WriteInputRecords(IntPtr input, List<INPUT_RECORD> records) {
    if (records.Count == 0) return 0;
    uint written = 0;
    if (!WriteConsoleInputW(input, records.ToArray(), (uint)records.Count, out written)) {
      throw new InvalidOperationException("WriteConsoleInput failed: " + Marshal.GetLastWin32Error());
    }
    if (written != records.Count) {
      throw new InvalidOperationException("WriteConsoleInput wrote " + written + " of " + records.Count + " records");
    }
    return written;
  }

  private static List<INPUT_RECORD> EnterRecords() {
    return new List<INPUT_RECORD> {
      EnterKeyRecord(true),
      EnterKeyRecord(false)
    };
  }

  private static INPUT_RECORD TextKeyRecord(char ch, bool down) {
    return new INPUT_RECORD {
      EventType = KEY_EVENT,
      KeyEvent = new KEY_EVENT_RECORD {
        bKeyDown = down,
        wRepeatCount = 1,
        wVirtualKeyCode = VirtualKey(ch),
        wVirtualScanCode = VirtualScan(ch),
        UnicodeChar = down ? ch : '\0',
        dwControlKeyState = 0
      }
    };
  }

  private static INPUT_RECORD EnterKeyRecord(bool down) {
    return new INPUT_RECORD {
      EventType = KEY_EVENT,
      KeyEvent = new KEY_EVENT_RECORD {
        bKeyDown = down,
        wRepeatCount = 1,
        wVirtualKeyCode = 13,
        wVirtualScanCode = 28,
        UnicodeChar = down ? '\r' : '\0',
        dwControlKeyState = 0
      }
    };
  }

  private static ushort VirtualKey(char ch) {
    if (ch == '\r' || ch == '\n') return 13;
    if (ch == '\t') return 9;
    if (ch == '\b') return 8;
    if (ch >= 'a' && ch <= 'z') return (ushort)Char.ToUpperInvariant(ch);
    if (ch >= 'A' && ch <= 'Z') return (ushort)ch;
    if (ch >= '0' && ch <= '9') return (ushort)ch;
    return 0;
  }

  private static ushort VirtualScan(char ch) {
    if (ch == '\r' || ch == '\n') return 28;
    return 0;
  }
}
'@

Add-Type -TypeDefinition $source

$bytes = [Convert]::FromBase64String($TextBase64)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$lineSeparator = [char]0x2028
$paragraphSeparator = [char]0x2029
$text = [regex]::Replace($text, "`r`n|`r|`n|$lineSeparator|$paragraphSeparator", '\n')

[CodexConsoleInput]::Inject([uint32]$TargetPid, $text, -not $NoSubmit, $SubmitDelayMs)
