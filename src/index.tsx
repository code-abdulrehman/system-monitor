import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useState, useEffect, useCallback } from "react";

// ─── Helper: run a shell command via Bun.spawn ───────────────────────────────

async function runCommand(cmd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return output.trim();
  } catch {
    return "N/A";
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface MemoryInfo {
  total: string;
  used: string;
  free: string;
  percent: number;
}

interface CpuInfo {
  user: number;
  sys: number;
  idle: number;
  usage: number;
}

interface WifiInfo {
  connected: boolean;
  network: string;
}

interface BluetoothInfo {
  enabled: boolean;
  devices: string[];
}

interface BatteryInfo {
  percent: number;
  charging: boolean;
  source: string;
}

interface PortInfo {
  port: string;
  process: string;
  pid: string;
}

interface ProcessInfo {
  pid: string;
  name: string;
  cpu: string;
  mem: string;
}

interface DiskInfo {
  total: string;
  used: string;
  available: string;
  percent: number;
}

interface SystemInfo {
  hostname: string;
  osVersion: string;
  uptime: string;
  disk: DiskInfo;
}

interface SystemData {
  memory: MemoryInfo;
  cpu: CpuInfo;
  wifi: WifiInfo;
  bluetooth: BluetoothInfo;
  battery: BatteryInfo;
  ports: PortInfo[];
  processes: ProcessInfo[];
  system: SystemInfo;
  lastUpdated: string;
}

// ─── Data Fetching ───────────────────────────────────────────────────────────

async function fetchMemory(): Promise<MemoryInfo> {
  try {
    const totalRaw = await runCommand("sysctl -n hw.memsize");
    const totalBytes = parseInt(totalRaw, 10);
    if (isNaN(totalBytes)) return { total: "N/A", used: "N/A", free: "N/A", percent: 0 };

    const vmstatRaw = await runCommand("vm_stat");
    const pageSize = 16384;
    const pageSizeMatch = vmstatRaw.match(/page size of (\d+) bytes/);
    const actualPageSize = pageSizeMatch?.[1] ? parseInt(pageSizeMatch[1], 10) : pageSize;

    const freeMatch = vmstatRaw.match(/Pages free:\s+(\d+)/);
    const inactiveMatch = vmstatRaw.match(/Pages inactive:\s+(\d+)/);
    const speculativeMatch = vmstatRaw.match(/Pages speculative:\s+(\d+)/);

    const freePages = freeMatch?.[1] ? parseInt(freeMatch[1], 10) : 0;
    const inactivePages = inactiveMatch?.[1] ? parseInt(inactiveMatch[1], 10) : 0;
    const speculativePages = speculativeMatch?.[1] ? parseInt(speculativeMatch[1], 10) : 0;

    const freeBytes = (freePages + inactivePages + speculativePages) * actualPageSize;
    const usedBytes = totalBytes - freeBytes;
    const percent = Math.round((usedBytes / totalBytes) * 100);

    const formatGB = (bytes: number) => (bytes / 1073741824).toFixed(1) + " GB";

    return {
      total: formatGB(totalBytes),
      used: formatGB(usedBytes),
      free: formatGB(freeBytes),
      percent: Math.max(0, Math.min(100, percent)),
    };
  } catch {
    return { total: "N/A", used: "N/A", free: "N/A", percent: 0 };
  }
}

async function fetchCpu(): Promise<CpuInfo> {
  try {
    const raw = await runCommand("top -l 1 -n 0 | grep 'CPU usage'");
    const userMatch = raw.match(/([\d.]+)% user/);
    const sysMatch = raw.match(/([\d.]+)% sys/);
    const idleMatch = raw.match(/([\d.]+)% idle/);

    const user = userMatch?.[1] ? parseFloat(userMatch[1]) : 0;
    const sys = sysMatch?.[1] ? parseFloat(sysMatch[1]) : 0;
    const idle = idleMatch?.[1] ? parseFloat(idleMatch[1]) : 100;
    const usage = Math.round(user + sys);

    return { user, sys, idle, usage: Math.max(0, Math.min(100, usage)) };
  } catch {
    return { user: 0, sys: 0, idle: 100, usage: 0 };
  }
}

async function fetchWifi(): Promise<WifiInfo> {
  try {
    // Run both methods in parallel; system_profiler is more reliable on many Macs
    const portsRaw = await runCommand("networksetup -listallhardwareports 2>/dev/null");
    const wifiBlock = portsRaw.match(/Hardware Port: (?:Wi-Fi|AirPort)[\s\S]*?Device: (\w+)/i);
    const wifiDevice = wifiBlock?.[1] ?? "en0";

    const [netRaw, profilerRaw] = await Promise.all([
      runCommand(`networksetup -getairportnetwork ${wifiDevice} 2>/dev/null`),
      runCommand("system_profiler SPAirPortDataType 2>/dev/null"),
    ]);

    // Prefer networksetup for SSID (system_profiler often redacts it as "<redacted>")
    if (!netRaw.includes("You are not associated")) {
      const match = netRaw.match(/Current Wi-Fi Network:\s*(.+)/);
      const network = match?.[1]?.trim();
      if (network) return { connected: true, network };
    }

    // Fallback: system_profiler says connected but use "Connected" if SSID is redacted
    if (profilerRaw.includes("Status: Connected")) {
      const nameMatch = profilerRaw.match(/Current Network Information:\s*\n\s*([^:]+):/);
      const rawName = nameMatch?.[1]?.trim();
      const network =
        rawName && !/redacted|unknown/i.test(rawName) ? rawName : "Connected";
      return { connected: true, network };
    }

    return { connected: false, network: "Not connected" };
  } catch {
    return { connected: false, network: "N/A" };
  }
}

async function fetchBluetooth(): Promise<BluetoothInfo> {
  try {
    const raw = await runCommand("system_profiler SPBluetoothDataType 2>/dev/null");
    const stateMatch = raw.match(/State:\s*(On|Off)/i);
    const enabled = stateMatch?.[1]?.toLowerCase() === "on";

    const devices: string[] = [];
    const connectedSection = raw.match(/Connected:\s*\n([\s\S]*?)(?:\n\s*\n|\n\S|$)/);
    if (connectedSection?.[1]) {
      const deviceMatches = connectedSection[1].matchAll(/^\s{8}(\S[^:]*?):/gm);
      for (const m of deviceMatches) {
        const name = m[1]?.trim();
        if (name) devices.push(name);
      }
    }

    return { enabled, devices };
  } catch {
    return { enabled: false, devices: [] };
  }
}

async function fetchBattery(): Promise<BatteryInfo> {
  try {
    const raw = await runCommand("pmset -g batt");
    const percentMatch = raw.match(/(\d+)%/);
    const percent = percentMatch?.[1] ? parseInt(percentMatch[1], 10) : -1;
    const charging =
      raw.includes("AC Power") ||
      raw.includes("charging") ||
      raw.includes("charged");
    const sourceMatch = raw.match(/Now drawing from '([^']+)'/);
    const source = sourceMatch?.[1] ?? "Unknown";

    return {
      percent: Math.max(0, Math.min(100, percent)),
      charging,
      source,
    };
  } catch {
    return { percent: -1, charging: false, source: "N/A" };
  }
}

async function fetchPorts(): Promise<PortInfo[]> {
  try {
    const raw = await runCommand("lsof -i -P -n 2>/dev/null | grep LISTEN | head -15");
    const lines = raw.split("\n").filter(Boolean);
    const ports: PortInfo[] = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      const processName = parts[0] ?? "unknown";
      const pid = parts[1] ?? "?";
      const addressField = parts[8] ?? "";
      const portMatch = addressField.match(/:(\d+)$/);
      const port = portMatch?.[1] ?? "?";

      if (port !== "?" && !ports.some((p) => p.port === port && p.process === processName)) {
        ports.push({ port, process: processName, pid });
      }
    }

    return ports.slice(0, 10);
  } catch {
    return [];
  }
}

async function fetchProcesses(): Promise<ProcessInfo[]> {
  try {
    const raw = await runCommand(
      "ps aux --sort=-%cpu 2>/dev/null | head -9 || ps aux | sort -nrk 3,3 | head -8"
    );
    const lines = raw.split("\n").filter(Boolean);
    const processes: ProcessInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || i === 0) continue; // skip header
      const parts = line.split(/\s+/);
      const pid = parts[1] ?? "?";
      const cpu = parts[2] ?? "0";
      const mem = parts[3] ?? "0";
      const name = parts.slice(10).join(" ") || parts[10] || "unknown";

      // Skip kernel_task and ps itself
      if (name.includes("ps aux") || name.includes("sort ")) continue;

      const shortName = name.length > 30 ? name.substring(0, 27) + "..." : name;
      processes.push({ pid, name: shortName, cpu, mem });
    }

    return processes.slice(0, 6);
  } catch {
    return [];
  }
}

async function fetchSystemInfo(): Promise<SystemInfo> {
  try {
    const [hostname, osVersionRaw, uptimeRaw, dfRaw] = await Promise.all([
      runCommand("hostname -s"),
      runCommand("sw_vers -productName && sw_vers -productVersion"),
      runCommand("uptime"),
      runCommand("df -h /"),
    ]);

    const osLines = osVersionRaw.split("\n");
    const osVersion = `${osLines[0] ?? "macOS"} ${osLines[1] ?? ""}`.trim();

    const uptimeMatch = uptimeRaw.match(/up\s+(.+?),\s+\d+ users?/);
    const uptime = uptimeMatch?.[1]?.trim() ?? uptimeRaw.substring(0, 40);

    // Parse df output
    const dfLines = dfRaw.split("\n");
    const dfData = dfLines[1]?.split(/\s+/);
    const disk: DiskInfo = {
      total: dfData?.[1] ?? "N/A",
      used: dfData?.[2] ?? "N/A",
      available: dfData?.[3] ?? "N/A",
      percent: dfData?.[4] ? parseInt(dfData[4].replace("%", ""), 10) : 0,
    };

    return { hostname, osVersion, uptime, disk };
  } catch {
    return {
      hostname: "N/A",
      osVersion: "N/A",
      uptime: "N/A",
      disk: { total: "N/A", used: "N/A", available: "N/A", percent: 0 },
    };
  }
}

async function fetchAllData(): Promise<SystemData> {
  const [memory, cpu, wifi, bluetooth, battery, ports, processes, system] =
    await Promise.all([
      fetchMemory(),
      fetchCpu(),
      fetchWifi(),
      fetchBluetooth(),
      fetchBattery(),
      fetchPorts(),
      fetchProcesses(),
      fetchSystemInfo(),
    ]);

  return {
    memory,
    cpu,
    wifi,
    bluetooth,
    battery,
    ports,
    processes,
    system,
    lastUpdated: new Date().toLocaleTimeString(),
  };
}

// ─── UI Components ───────────────────────────────────────────────────────────

function ProgressBar({
  percent,
  width,
  filledColor="#22c55e",
  emptyColor = "#3a3a3a",
  label,
}: {
  percent: number;
  width: number;
  filledColor: string;
  emptyColor?: string;
  label?: string;
}) {
  const barWidth = Math.max(width - 2, 5); // account for brackets
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;
  const filledBar = "█".repeat(Math.max(0, filled));
  const emptyBar = "░".repeat(Math.max(0, empty));
  const displayLabel = label ?? `${percent}%`;

  return (
    <box flexDirection="row">
      <text fg="#666666">[</text>
      <text fg={filledColor}>{filledBar}</text>
      <text fg={emptyColor}>{emptyBar}</text>
      <text fg="#666666">]</text>
      <text fg="#AAAAAA">{` ${displayLabel}`}</text>
    </box>
  );
}

function getPercentColor(percent: number): string {
  if (percent < 50) return "#22c55e"; // green
  if (percent < 80) return "#eab308"; // yellow
  return "#ef4444"; // red
}

function StatusDot({ good }: { good: boolean }) {
  return <text fg={good ? "#22c55e" : "#ef4444"}>{good ? "●" : "●"}</text>;
}

// ─── Section Components ──────────────────────────────────────────────────────

function MemorySection({ memory }: { memory: MemoryInfo }) {
  const color = getPercentColor(memory.percent);
  return (
    <box
      title=" 🧠 Memory "
      border
      borderColor="#4a4a4a"
      flexDirection="column"
      padding={1}
      flexGrow={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg="#CCCCCC">
          {"Used: "}
          <span fg={color}>{memory.used}</span>
          {" / "}
          <span fg="#AAAAAA">{memory.total}</span>
        </text>
        <text fg="#88CC88">{"Free: " + memory.free}</text>
      </box>
      <ProgressBar percent={memory.percent} width={40} filledColor={"#22c55e"} />
    </box>
  );
}

function CpuSection({ cpu }: { cpu: CpuInfo }) {
  const color = getPercentColor(cpu.usage);
  return (
    <box
      title=" 🖥  CPU "
      border
      borderColor="#4a4a4a"
      flexDirection="column"
      padding={1}
      flexGrow={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg="#CCCCCC">
          {"Usage: "}
          <span fg={color}>{cpu.usage + "%"}</span>
        </text>
        <text fg="#AAAAAA">{`User: ${cpu.user.toFixed(1)}%  Sys: ${cpu.sys.toFixed(1)}%`}</text>
      </box>
      <ProgressBar percent={cpu.usage} width={40} filledColor={color} />
    </box>
  );
}

function WifiSection({ wifi }: { wifi: WifiInfo }) {
  return (
    <box
      title=" 📶 WiFi "
      border
      borderColor="#4a4a4a"
      flexDirection="row"
      padding={1}
      flexGrow={1}
      gap={1}
    >
      <StatusDot good={wifi.connected} />
      <text fg={wifi.connected ? "#22c55e" : "#ef4444"}>
        {wifi.connected ? wifi.network : "Disconnected"}
      </text>
    </box>
  );
}

function BluetoothSection({ bluetooth }: { bluetooth: BluetoothInfo }) {
  return (
    <box
      title=" 🔵 Bluetooth "
      border
      borderColor="#4a4a4a"
      flexDirection="column"
      padding={1}
      flexGrow={1}
    >
      <box flexDirection="row" gap={1}>
        <StatusDot good={bluetooth.enabled} />
        <text fg={bluetooth.enabled ? "#22c55e" : "#ef4444"}>
          {bluetooth.enabled ? "On" : "Off"}
        </text>
      </box>
      {bluetooth.devices.length > 0 ? (
        bluetooth.devices.map((device, i) => (
          <text key={i} fg="#88AAFF">{"  ↳ " + device}</text>
        ))
      ) : (
        <text fg="#666666">{"  No connected devices"}</text>
      )}
    </box>
  );
}

function BatterySection({ battery }: { battery: BatteryInfo }) {
  const percent = battery.percent;
  let emoji = "🔋";
  let color = "#22c55e";

  if (battery.charging) {
    emoji = "⚡";
    color = "#eab308";
  } else if (percent <= 10) {
    emoji = "🪫";
    color = "#ef4444";
  } else if (percent <= 30) {
    emoji = "🔋";
    color = "#eab308";
  }

  const label = percent >= 0 ? `${percent}%` : "N/A";

  return (
    <box
      title={` ${emoji} Battery `}
      border
      borderColor="#4a4a4a"
      flexDirection="column"
      padding={1}
      flexGrow={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg="#CCCCCC">
          {"Charge: "}
          <span fg={color}>{label}</span>
        </text>
        <text fg="#AAAAAA">
          {battery.charging ? "⚡ Charging" : "🔌 " + battery.source}
        </text>
      </box>
        
      <ProgressBar
        percent={percent >= 0 ? percent : 0}
        width={40}
        filledColor={"#22c55e"}
        label={label}
      />
    </box>
  );
}

function PortsSection({ ports }: { ports: PortInfo[] }) {
  return (
    <box
      title=" 🌐 Listening Ports "
      border
      borderColor="#4a4a4a"
      flexDirection="column"
      padding={1}
      flexGrow={1}
    >
      {ports.length === 0 ? (
        <text fg="#666666">No listening ports detected</text>
      ) : (
        <>
          <box flexDirection="row">
            <text fg="#AAAAAA" attributes={TextAttributes.BOLD}>
              {"PORT      PROCESS          PID"}
            </text>
          </box>
          {ports.map((p, i) => (
            <box key={i} flexDirection="row">
              <text fg="#88CCFF">{`:${p.port}`.padEnd(10)}</text>
              <text fg="#CCCCCC">{p.process.padEnd(17)}</text>
              <text fg="#888888">{p.pid}</text>
            </box>
          ))}
        </>
      )}
    </box>
  );
}

function ProcessesSection({ processes }: { processes: ProcessInfo[] }) {
  return (
    <box
      title=" ⚙️  Top Processes "
      border
      borderColor="#4a4a4a"
      flexDirection="column"
      padding={1}
      flexGrow={1}
    >
      <box flexDirection="row">
        <text fg="#AAAAAA" attributes={TextAttributes.BOLD}>
          {"PID      CPU%  MEM%  COMMAND"}
        </text>
      </box>
      {processes.map((p, i) => {
        const cpuVal = parseFloat(p.cpu);
        const cpuColor = cpuVal > 50 ? "#ef4444" : cpuVal > 20 ? "#eab308" : "#22c55e";
        return (
          <box key={i} flexDirection="row">
            <text fg="#888888">{p.pid.padEnd(9)}</text>
            <text fg={cpuColor}>{p.cpu.padEnd(6)}</text>
            <text fg="#AAAAAA">{p.mem.padEnd(6)}</text>
            <text fg="#CCCCCC">{p.name}</text>
          </box>
        );
      })}
    </box>
  );
}

function SystemInfoSection({ system }: { system: SystemInfo }) {
  const diskColor = getPercentColor(system.disk.percent);
  return (
    <box
      title=" 💻 System Info "
      border
      borderColor="#4a4a4a"
      flexDirection="column"
      padding={1}
      flexGrow={1}
    >
      <text fg="#CCCCCC">
        {"Hostname:   "}
        <span fg="#88CCFF">{system.hostname}</span>
      </text>
      <text fg="#CCCCCC">
        {"OS:         "}
        <span fg="#88CCFF">{system.osVersion}</span>
      </text>
      <text fg="#CCCCCC">
        {"Uptime:     "}
        <span fg="#88CCFF">{system.uptime}</span>
      </text>
      <text fg="#CCCCCC">
        {"Disk:       "}
        <span fg={diskColor}>{system.disk.used}</span>
        {" / "}
        <span fg="#AAAAAA">{system.disk.total}</span>
        {" ("}
        <span fg="#AAAAAA">{system.disk.available}</span>
        {" free)"}
      </text>
      <ProgressBar
        percent={system.disk.percent}
        width={40}
        filledColor={diskColor}
        label={`${system.disk.percent}% used`}
      />
    </box>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

const defaultData: SystemData = {
  memory: { total: "...", used: "...", free: "...", percent: 0 },
  cpu: { user: 0, sys: 0, idle: 100, usage: 0 },
  wifi: { connected: false, network: "Loading..." },
  bluetooth: { enabled: false, devices: [] },
  battery: { percent: 0, charging: false, source: "..." },
  ports: [],
  processes: [],
  system: {
    hostname: "...",
    osVersion: "...",
    uptime: "...",
    disk: { total: "...", used: "...", available: "...", percent: 0 },
  },
  lastUpdated: "Loading...",
};

function App() {
  const { width, height } = useTerminalDimensions();
  const [data, setData] = useState<SystemData>(defaultData);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const newData = await fetchAllData();
      setData(newData);
    } catch {
      // silently ignore fetch errors
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh every 3 seconds
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Keyboard handling
  useKeyboard((e) => {
    if (e.name === "q" || (e.name === "c" && e.ctrl)) {
      process.exit(0);
    }
    if (e.name === "r") {
      setLoading(true);
      void refresh();
    }

  });

  const isNarrow = width < 80;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
    >
      {/* Header */}
      <box
        border
        borderColor="#6a5acd"
        flexDirection="column"
        alignItems="center"
        paddingLeft={1}
        paddingRight={1}
      >
        <ascii-font text="System Monitor" font="tiny" color="#6a5acd" />
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text fg="#888888">
            {"Last updated: "}
            <span fg="#AAAAAA">{data.lastUpdated}</span>
            {loading ? " ⏳" : " "}
          </text>
          <text fg="#555555" attributes={TextAttributes.DIM}>
            {"q:quit  r:refresh  ↑↓:scroll  |  Terminal: " +
              width +
              "x" +
              height}
          </text>
        </box>
      </box>

      {/* Scrollable Content */}
      <scrollbox
        flexGrow={1}
        focused
        scrollY
        stickyScroll={false}
      >
        <box flexDirection="column" width="100%" padding={0}>
          {/* Row 1: Memory + CPU */}
          <box flexDirection={isNarrow ? "column" : "row"} width="100%">
            <MemorySection memory={data.memory} />
            <CpuSection cpu={data.cpu} />
          </box>

          {/* Row 2: WiFi + Bluetooth + Battery */}
          <box flexDirection={isNarrow ? "column" : "row"} width="100%">
            <WifiSection wifi={data.wifi} />
            <BluetoothSection bluetooth={data.bluetooth} />
            <BatterySection battery={data.battery} />
          </box>

          {/* Row 3: System Info */}
          <SystemInfoSection system={data.system} />

          {/* Row 4: Ports + Processes */}
          <box flexDirection={isNarrow ? "column" : "row"} width="100%">
            <PortsSection ports={data.ports} />
            <ProcessesSection processes={data.processes} />
          </box>
        </box>
      </scrollbox>

      {/* Footer */}
      <box
        border
        borderColor="#333333"
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg="#555555">
          {"◆ "}
          <span fg="#6a5acd">System Monitor</span>
          {" — OpenTUI + Bun"}
        </text>
        <text fg="#555555">{"Auto-refresh: 3s"}</text>
      </box>
    </box>
  );
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App />);
