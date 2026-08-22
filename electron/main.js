const { app, BrowserWindow, session, shell, protocol, net } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// Serve the web app over a custom scheme: ES module scripts are blocked on
// file://, but load fine from a "standard" registered scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const APP_ROOT = path.join(__dirname, "..", "app");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: "Shelf Snap",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Allow webcam access for the "Use webcam" capture button.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === "media");
  });

  // External links (LibraryThing, console.anthropic.com) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.removeMenu();
  win.loadURL("app://bundle/");
}

app.whenReady().then(() => {
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const file = path.normalize(path.join(APP_ROOT, rel));
    if (!file.startsWith(APP_ROOT)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
