# Lowers other apps' volume on Windows while read-aloud speaks, and puts it back.
# Reads JSON lines on stdin: {"op":"list"} | {"op":"duck","level":0.3,"keep":["msrdc"]} | {"op":"restore"}.
# Restores everything when stdin closes, so a speech service that dies never leaves apps quiet.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace ReadAloud {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid param);
    [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(bool mute, ref Guid context);
    [PreserveSig] int GetMute(out bool mute);
  }

  public class Session {
    public string Id; public uint Pid; public string Process; public bool IsSystem; public int State;
    internal ISimpleAudioVolume Volume;
    public float Get() { float v; Volume.GetMasterVolume(out v); return v; }
    public void Set(float v) { Guid g = Guid.Empty; Volume.SetMasterVolume(Math.Max(0f, Math.Min(1f, v)), ref g); }
  }

  public static class Mixer {
    // Audio sessions answer for their volume only to a multithreaded
    // apartment; PowerShell's own thread is single-threaded, so each call
    // runs on a fresh MTA thread.
    public static T OnMta<T>(Func<T> work) {
      T result = default(T); Exception error = null;
      var t = new System.Threading.Thread(() => { try { result = work(); } catch (Exception e) { error = e; } });
      t.SetApartmentState(System.Threading.ApartmentState.MTA);
      t.Start(); t.Join();
      if (error != null) throw error;
      return result;
    }

    public static string List() {
      return OnMta(() => {
        var rows = new List<string>();
        foreach (var s in Sessions()) rows.Add(s.Process + ":" + s.Pid + ":" + s.Get().ToString("0.00") + ":" + s.State);
        return string.Join(";", rows.ToArray());
      });
    }

    // Lowers every session but those whose process is in `keep`, to `level` of
    // the volume it had before the first duck; returns how many it lowered.
    public static int Duck(float level, string[] keep, Dictionary<string, float> saved, int self) {
      return OnMta(() => {
        int n = 0;
        foreach (var s in Sessions()) {
          if (s.IsSystem || Array.IndexOf(keep, s.Process) >= 0 || s.Pid == self) continue;
          if (!saved.ContainsKey(s.Id)) saved[s.Id] = s.Get();
          s.Set(saved[s.Id] * level); n++;
        }
        return n;
      });
    }

    public static int Restore(Dictionary<string, float> saved) {
      return OnMta(() => {
        int n = 0;
        foreach (var s in Sessions()) {
          float v;
          if (saved.TryGetValue(s.Id, out v)) { try { s.Set(v); n++; } catch {} }
        }
        saved.Clear();
        return n;
      });
    }

    static List<Session> Sessions() {
      var list = new List<Session>();
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice device;
      enumerator.GetDefaultAudioEndpoint(0, 1, out device); // render, multimedia
      Guid iid = typeof(IAudioSessionManager2).GUID;
      object o;
      device.Activate(ref iid, 23, IntPtr.Zero, out o);
      var manager = (IAudioSessionManager2)o;
      IAudioSessionEnumerator sessions;
      manager.GetSessionEnumerator(out sessions);
      int n; sessions.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 c; sessions.GetSession(i, out c);
        var s = new Session();
        c.GetSessionInstanceIdentifier(out s.Id);
        c.GetProcessId(out s.Pid);
        c.GetState(out s.State);
        s.IsSystem = c.IsSystemSoundsSession() == 0;
        try { s.Process = System.Diagnostics.Process.GetProcessById((int)s.Pid).ProcessName; } catch { s.Process = "?"; }
        s.Volume = c as ISimpleAudioVolume;
        if (s.Volume != null) list.Add(s);
      }
      return list;
    }
  }
}
'@

$saved = New-Object 'System.Collections.Generic.Dictionary[string,float]'  # session -> volume before ducking

function Restore { [void][ReadAloud.Mixer]::Restore($saved) }

[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
try {
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
      $req = $line | ConvertFrom-Json
      switch ($req.op) {
        'list' { [Console]::Out.WriteLine('LIST ' + [ReadAloud.Mixer]::List()) }
        'duck' {
          $n = [ReadAloud.Mixer]::Duck([float]$req.level, [string[]]@($req.keep), $saved, $PID)
          [Console]::Out.WriteLine("OK $n")
        }
        'restore' { Restore; [Console]::Out.WriteLine('OK') }
      }
    } catch {
      [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '\s+', ' '))
    }
    [Console]::Out.Flush()
  }
} finally {
  Restore
}
