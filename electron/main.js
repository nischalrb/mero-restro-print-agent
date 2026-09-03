// Mero Restro Print Agent — Electron tray wrapper.
//
// Deliberately plain CommonJS (not TypeScript) so this file needs no
// separate build step: electron-builder just ships it as-is alongside the
// already-compiled `dist/` output. It never creates a BrowserWindow — this
// is a pure menu-bar/tray background utility, not an app with a UI of its
// own. All the actual HTTP server / ESC/POS / CUPS / printer-discovery
// logic lives entirely in ../src (compiled to ../dist) and is completely
// unmodified by packaging — this file only starts it, shows its status in
// a tray menu, and wires OS-level "start at login."
"use strict";

const { app, Tray, Menu, nativeImage, shell, clipboard, dialog } = require("electron");
const path = require("path");

// A second launch (e.g. the user double-clicking the installed app again,
// or macOS relaunching it) should focus/no-op against the FIRST instance
// rather than spinning up a second HTTP server that would immediately lose
// the port race to the first one — see requirement "do not create
// duplicate agent processes."
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return;
}

// The compiled agent (dist/index.js) is a CommonJS module — requiring it
// runs its top-level code, but startAgentServer() is only ever CALLED by
// this file (see index.ts's `require.main === module` guard), never by
// require() itself, so this is safe and doesn't double-start anything.
const agentModule = require(path.join(__dirname, "..", "dist", "index.js"));
const { discoverPrinters } = require(path.join(__dirname, "..", "dist", "printers", "discovery.js"));
const { submitTestPrintJob } = require(path.join(__dirname, "..", "dist", "jobs", "queue.js"));
const { logFilePath } = require(path.join(__dirname, "..", "dist", "paths.js"));
const { VERSION } = require(path.join(__dirname, "..", "dist", "config.js"));

const PRODUCTION_APP_URL = "https://app.merorestroapp.com";

/** @type {import("electron").Tray | null} */
let tray = null;
/** @type {Awaited<ReturnType<typeof agentModule.startAgentServer>> | null} */
let agentHandle = null;
/** Set on a failed/failed-to-restart agent so the tray menu can show a clear error instead of silently doing nothing. */
let lastStartupError = null;

function trayIconPath() {
  // A 16x16 render of the same source icon electron-builder derives the
  // .icns/.ico app icons from — see build/icon.png. Kept as one source
  // image rather than a second hand-authored tray-specific asset; Electron
  // resizes fine for a menu-bar-sized icon.
  return path.join(__dirname, "..", "build", "icon.png");
}

function loadTrayIcon() {
  const image = nativeImage.createFromPath(trayIconPath()).resize({ width: 16, height: 16 });
  if (process.platform === "darwin") {
    // Template images let macOS re-tint the icon automatically for light
    // vs dark menu bars — without this a colored icon looks wrong/muddy
    // in dark mode. Only meaningful on macOS; harmless elsewhere.
    image.setTemplateImage(true);
  }
  return image;
}

async function buildMenu() {
  const items = [];

  if (agentHandle) {
    items.push({ label: `● Running — 127.0.0.1:${agentHandle.port}`, enabled: false });
  } else {
    items.push({ label: lastStartupError ? `⚠ Agent failed to start` : "Starting…", enabled: false });
  }

  let printerCountLabel = "Printers: checking…";
  try {
    const printers = await discoverPrinters();
    printerCountLabel = `Printers: ${printers.length} detected`;
  } catch (err) {
    printerCountLabel = `Printers: discovery failed (${err.message})`;
  }
  items.push({ label: printerCountLabel, enabled: false });
  items.push({ label: `Version ${VERSION}`, enabled: false });
  items.push({ type: "separator" });

  items.push({
    label: "Copy Pairing Token",
    enabled: Boolean(agentHandle),
    click: () => {
      if (!agentHandle) return;
      clipboard.writeText(agentHandle.pairingToken);
      // No confirmation dialog needed beyond this — a native notification
      // would be nicer but adds another moving part; the menu item's own
      // click feedback is enough for a "copy to clipboard" action.
    },
  });

  items.push({
    label: "Open Printer Settings",
    click: () => {
      shell.openExternal(PRODUCTION_APP_URL);
    },
  });

  items.push({
    label: "Test Print",
    enabled: Boolean(agentHandle),
    click: async () => {
      try {
        const printers = await discoverPrinters();
        const target = printers.find((p) => p.type === "thermal") ?? printers[0];
        if (!target) {
          dialog.showErrorBox("No printer found", "No printers were detected on this computer. Install/connect a printer first.");
          return;
        }
        const job = await submitTestPrintJob({
          printerTarget: target.name,
          connectionType: "usb",
          // discoverPrinters() only ever reports "80mm" or "unknown" (see
          // DiscoveredPrinter in types.ts) — default to 80mm, the common
          // case, when it can't tell.
          paperWidth: target.paperWidth === "58mm" ? "58mm" : "80mm",
          idempotencyKey: `tray-test-${Date.now()}`,
        });
        if (job.status !== "printed") {
          dialog.showErrorBox("Test print failed", job.error || "Unknown error — see logs for details.");
        }
      } catch (err) {
        dialog.showErrorBox("Test print failed", err.message);
      }
    },
  });

  items.push({
    label: "View Logs",
    click: () => {
      shell.openPath(logFilePath());
    },
  });

  items.push({ type: "separator" });

  items.push({
    label: "Restart Agent",
    click: async () => {
      await restartAgent();
    },
  });

  items.push({
    label: "Quit",
    click: () => {
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}

async function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip(agentHandle ? `Mero Restro Print Agent — Running on port ${agentHandle.port}` : "Mero Restro Print Agent — Not running");
  tray.setContextMenu(await buildMenu());
}

async function startAgent() {
  try {
    agentHandle = await agentModule.startAgentServer();
    lastStartupError = null;
  } catch (err) {
    lastStartupError = err;
    agentHandle = null;
    dialog.showErrorBox(
      "Mero Restro Print Agent could not start",
      `${err.message}\n\nCheck the log file from the tray menu for more detail, or quit and reopen the app.`,
    );
  }
  await refreshTrayMenu();
}

async function restartAgent() {
  if (agentHandle) {
    try {
      await agentHandle.stop();
    } catch {
      // Ignore — we're about to replace it with a fresh instance regardless.
    }
    agentHandle = null;
  }
  await startAgent();
}

app.on("second-instance", () => {
  // Someone tried to launch a second copy — nothing to focus (we have no
  // window), just make sure the tray menu reflects current state.
  refreshTrayMenu();
});

app.whenReady().then(async () => {
  // Menu-bar/tray-only app: no Dock icon on macOS. electron-builder's
  // LSUIElement (see electron-builder.yml) handles this for the packaged
  // .app; hiding it here too covers `electron .` dev runs where the
  // packaged Info.plist tweak doesn't apply.
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  tray = new Tray(loadTrayIcon());
  tray.setToolTip("Mero Restro Print Agent");
  tray.setContextMenu(await buildMenu());

  // Native, OS-level "start at login" — macOS Login Items / Windows
  // Registry Run key — rather than the old shell-script LaunchAgent/
  // Startup-folder installers (scripts/install-*), which required the
  // customer to run Terminal/PowerShell commands. openAsHidden keeps it
  // from popping any window at login (moot here since there's never a
  // window, but also suppresses a Dock bounce on macOS).
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  await startAgent();

  // Printer counts change when a USB cable is plugged/unplugged, so the
  // tray menu's "N detected" line is refreshed periodically rather than
  // only at startup. Cheap — discoverPrinters() is a single lpstat/
  // Get-Printer call — and only runs while the menu could plausibly be
  // reopened, not on every print job.
  setInterval(refreshTrayMenu, 60_000);
});

app.on("window-all-closed", (event) => {
  // There are never any windows to begin with, but guard against Electron's
  // default "quit when last window closes" behavior anyway — this is a
  // background service; it should only exit via the tray's Quit item.
  event.preventDefault();
});

app.on("before-quit", async () => {
  if (agentHandle) {
    try {
      await agentHandle.stop();
    } catch {
      // Best-effort — the process is exiting either way.
    }
  }
});
