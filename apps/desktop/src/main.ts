import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import type {
  DesktopNotificationInput,
  DesktopNotificationPermissionResult,
  ServerConnectionResult,
  SetupState,
} from "./contracts";
import { DEFAULT_SERVER_URL, normalizeServerUrl, serverHealthUrl } from "./server-url";

const APP_NAME = "近聊";
const CONNECTION_TIMEOUT_MS = 5_000;
const CONFIG_FILE_NAME = "desktop-config.json";

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let configuredServerUrl: string | null = null;
let setupErrorMessage: string | null = null;
let isQuitting = false;

const userDataOverride = process.env.NEAR_CHAT_DESKTOP_USER_DATA?.trim();
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));

/** Squirrel 安装/更新阶段不启动界面，只维护 Windows 快捷方式。 */
function handleSquirrelEvent(): boolean {
  if (process.platform !== "win32") return false;
  const squirrelEvent = process.argv[1];
  if (!squirrelEvent?.startsWith("--squirrel-")) return false;

  const executableName = path.basename(process.execPath);
  const updateExecutable = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  const shortcutArgument =
    squirrelEvent === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut";

  if (squirrelEvent !== "--squirrel-obsolete") {
    const child = spawn(updateExecutable, [shortcutArgument, executableName], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
  app.quit();
  return true;
}

const squirrelEventHandled = handleSquirrelEvent();

function configFilePath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE_NAME);
}

async function readConfiguredServerUrl(): Promise<string | null> {
  const environmentUrl = process.env.NEAR_CHAT_DESKTOP_SERVER_URL?.trim();
  if (environmentUrl) return normalizeServerUrl(environmentUrl);

  try {
    const parsed = JSON.parse(await fs.readFile(configFilePath(), "utf8")) as {
      serverUrl?: unknown;
    };
    return typeof parsed.serverUrl === "string" ? normalizeServerUrl(parsed.serverUrl) : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") setupErrorMessage = "本机服务器配置无效，请重新设置";
    return null;
  }
}

async function saveConfiguredServerUrl(serverUrl: string): Promise<void> {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(configFilePath(), `${JSON.stringify({ serverUrl }, null, 2)}\n`, "utf8");
}

async function testServerConnection(input: string): Promise<ServerConnectionResult> {
  let serverUrl: string;
  try {
    serverUrl = normalizeServerUrl(input);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "服务器地址无效" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    const response = await fetch(serverHealthUrl(serverUrl), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, message: `服务器返回异常状态（HTTP ${response.status}）` };
    }
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    if (body?.status !== "UP") {
      return { ok: false, message: "该地址不是可用的近聊服务器" };
    }
    return { ok: true, serverUrl, message: "连接成功，近聊服务工作正常" };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return { ok: false, message: "连接超时，请检查地址、网络或防火墙" };
    }
    return { ok: false, message: "无法连接服务器，请检查地址、网络或防火墙" };
  } finally {
    clearTimeout(timeout);
  }
}

function isSetupSender(event: IpcMainInvokeEvent): boolean {
  return setupWindow?.webContents === event.sender;
}

function isConfiguredServerSender(event: IpcMainInvokeEvent): boolean {
  if (!configuredServerUrl || mainWindow?.webContents !== event.sender) return false;
  try {
    return new URL(event.sender.getURL()).origin === new URL(configuredServerUrl).origin;
  } catch {
    return false;
  }
}

function createProductIcon(size: number, template = false): Electron.NativeImage {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = Math.max(2, Math.round(size * 0.2));
  const left = Math.round(size * 0.12);
  const right = Math.round(size * 0.88);
  const top = Math.round(size * 0.13);
  const bottom = Math.round(size * 0.74);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cornerX = Math.max(left + radius - x, 0, x - (right - radius));
      const cornerY = Math.max(top + radius - y, 0, y - (bottom - radius));
      const inBubble =
        x >= left &&
        x <= right &&
        y >= top &&
        y <= bottom &&
        cornerX ** 2 + cornerY ** 2 <= radius ** 2;
      const inTail =
        y > bottom &&
        y <= Math.round(size * 0.9) &&
        x >= left + radius &&
        x <= Math.round(size * 0.5) - (y - bottom);
      if (!inBubble && !inTail) continue;

      const offset = (y * size + x) * 4;
      const color = template ? { red: 0, green: 0, blue: 0 } : { red: 103, green: 87, blue: 232 };
      // NativeImage 位图使用 BGRA 字节序。
      pixels[offset] = color.blue;
      pixels[offset + 1] = color.green;
      pixels[offset + 2] = color.red;
      pixels[offset + 3] = 255;
    }
  }

  const image = nativeImage.createFromBitmap(pixels, { height: size, width: size });
  if (template) image.setTemplateImage(true);
  return image;
}

function showMainWindow(): void {
  if (!configuredServerUrl) {
    showSetupWindow();
    return;
  }
  if (!mainWindow) createMainWindow();
  mainWindow?.show();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const template: MenuItemConstructorOptions[] = [
    { label: "打开近聊", click: showMainWindow },
    {
      label: configuredServerUrl ? `服务器：${configuredServerUrl}` : "尚未配置服务器",
      enabled: false,
    },
    { label: "服务器设置…", click: () => showSetupWindow() },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(
    createProductIcon(process.platform === "darwin" ? 18 : 20, process.platform === "darwin"),
  );
  tray.setToolTip(APP_NAME);
  tray.on("click", showMainWindow);
  refreshTrayMenu();
}

/**
 * 前端由局域网服务器提供。重新加载前清理 HTTP 缓存，确保服务器升级后客户端不会
 * 继续使用旧的 index.html 或样式文件；登录态保存在站点存储中，不会因此丢失。
 */
async function reloadMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }
  await mainWindow.webContents.session.clearCache();
  mainWindow.webContents.reloadIgnoringCache();
  mainWindow.show();
  mainWindow.focus();
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "服务器设置…",
                accelerator: "CmdOrCtrl+,",
                click: () => showSetupWindow(),
              },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : [
          {
            label: "文件",
            submenu: [
              {
                label: "服务器设置…",
                accelerator: "CmdOrCtrl+,",
                click: () => showSetupWindow(),
              },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]),
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "显示",
      submenu: [
        {
          label: "重新加载客户端",
          accelerator: "CmdOrCtrl+R",
          click: () => void reloadMainWindow(),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function protectRemoteNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!configuredServerUrl) {
      event.preventDefault();
      return;
    }
    try {
      if (new URL(targetUrl).origin === new URL(configuredServerUrl).origin) return;
    } catch {
      // 无法解析的导航一律阻止。
    }
    event.preventDefault();
    if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
      void shell.openExternal(targetUrl);
    }
  });
}

function createMainWindow(): BrowserWindow {
  if (mainWindow) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: "#f1f2f4",
    icon: createProductIcon(64),
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "web-preload.js"),
    },
  });
  protectRemoteNavigation(mainWindow);
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, targetUrl, isMainFrame) => {
      if (
        !isMainFrame ||
        errorCode === -3 ||
        !configuredServerUrl ||
        !targetUrl.startsWith(configuredServerUrl)
      )
        return;
      mainWindow?.hide();
      showSetupWindow(`服务器页面加载失败：${errorDescription}`);
    },
  );
  return mainWindow;
}

async function loadConfiguredServer(): Promise<void> {
  if (!configuredServerUrl) {
    showSetupWindow();
    return;
  }
  const window = createMainWindow();
  try {
    // 桌面端连接的服务器可独立更新，启动时始终读取服务器当前发布的前端版本。
    await window.webContents.session.clearCache();
    await window.loadURL(configuredServerUrl);
    setupWindow?.close();
    window.show();
    window.focus();
  } catch {
    window.hide();
    showSetupWindow("服务器页面加载失败，请检查服务地址");
  }
}

function showSetupWindow(errorMessage: string | null = null): void {
  if (errorMessage) setupErrorMessage = errorMessage;
  if (setupWindow) {
    void setupWindow.webContents.reload();
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 520,
    minHeight: 620,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: "#eef0f3",
    icon: createProductIcon(64),
    title: "连接近聊服务器",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "setup-preload.js"),
    },
  });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  setupWindow.once("ready-to-show", () => setupWindow?.show());
  setupWindow.on("closed", () => {
    setupWindow = null;
    setupErrorMessage = null;
  });
  void setupWindow.loadFile(path.join(__dirname, "setup", "setup.html"));
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-setup-state", (event): SetupState => {
    if (!isSetupSender(event)) throw new Error("不允许的配置请求");
    return {
      appVersion: app.getVersion(),
      currentServerUrl: configuredServerUrl,
      defaultServerUrl: DEFAULT_SERVER_URL,
      errorMessage: setupErrorMessage,
    };
  });

  ipcMain.handle("desktop:test-server", async (event, serverUrl: unknown) => {
    if (!isSetupSender(event) || typeof serverUrl !== "string") {
      return { ok: false, message: "不允许的连接请求" } satisfies ServerConnectionResult;
    }
    return testServerConnection(serverUrl);
  });

  ipcMain.handle("desktop:connect-server", async (event, serverUrl: unknown) => {
    if (!isSetupSender(event) || typeof serverUrl !== "string") {
      return { ok: false, message: "不允许的连接请求" } satisfies ServerConnectionResult;
    }
    const result = await testServerConnection(serverUrl);
    if (!result.ok || !result.serverUrl) return result;

    try {
      await saveConfiguredServerUrl(result.serverUrl);
      configuredServerUrl = result.serverUrl;
      setupErrorMessage = null;
      refreshTrayMenu();
      void loadConfiguredServer();
      return result;
    } catch {
      return { ok: false, message: "服务器地址保存失败，请检查本机目录权限" };
    }
  });

  ipcMain.handle("desktop:open-server-settings", (event) => {
    if (!isConfiguredServerSender(event)) return;
    showSetupWindow();
  });

  ipcMain.handle(
    "desktop:request-notification-permission",
    async (event): Promise<DesktopNotificationPermissionResult> => {
      if (!isConfiguredServerSender(event)) {
        return { granted: false, status: "failed", message: "不允许的通知授权请求" };
      }
      if (!Notification.isSupported()) {
        return { granted: false, status: "unsupported", message: "当前系统不支持通知" };
      }

      // Electron 没有独立的通知授权 API。由用户点击触发一条确认通知，既向系统发起
      // 首次授权请求，也能在授权成功后立即给出可见反馈。
      return new Promise((resolve) => {
        const notification = new Notification({
          title: "近聊通知已开启",
          body: "有新消息时，近聊会通过系统通知及时提醒你。",
          icon: createProductIcon(64),
        });
        let settled = false;
        let fallbackTimer: NodeJS.Timeout | null = null;
        const finish = (result: DesktopNotificationPermissionResult) => {
          if (settled) return;
          settled = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
          resolve(result);
        };
        notification.once("show", () =>
          finish({ granted: true, status: "granted", message: "系统通知已开启" }),
        );
        notification.once("failed", (_event, error) =>
          finish({
            granted: false,
            status: "failed",
            message: error || "系统未能显示通知，请检查系统通知设置",
          }),
        );
        // 部分 Linux 通知服务不回传 show 事件；请求已交给系统时允许业务继续启用。
        fallbackTimer = setTimeout(
          () =>
            finish({
              granted: true,
              status: "requested",
              message: "已向系统请求通知权限",
            }),
          2_000,
        );
        notification.show();
      });
    },
  );

  ipcMain.handle("desktop:show-notification", (event, input: DesktopNotificationInput) => {
    if (!isConfiguredServerSender(event) || !Notification.isSupported()) return false;
    if (
      !input ||
      typeof input.title !== "string" ||
      typeof input.body !== "string" ||
      typeof input.conversationId !== "string"
    ) {
      return false;
    }

    const notification = new Notification({
      title: input.title.slice(0, 150),
      body: input.body.slice(0, 500),
      icon: createProductIcon(64),
    });
    notification.on("click", () => {
      showMainWindow();
      mainWindow?.webContents.send("desktop:notification-clicked", input.conversationId);
    });
    notification.show();
    return true;
  });
}

function configurePermissions(): void {
  const isConfiguredOrigin = (requestingUrl: string) => {
    if (!configuredServerUrl) return false;
    try {
      return new URL(requestingUrl).origin === new URL(configuredServerUrl).origin;
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      permission === "notifications" && isConfiguredOrigin(requestingOrigin),
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "notifications" && isConfiguredOrigin(webContents.getURL()));
  });
}

async function startApplication(): Promise<void> {
  app.setName(APP_NAME);
  registerIpcHandlers();
  configurePermissions();
  configureApplicationMenu();
  createTray();

  configuredServerUrl = await readConfiguredServerUrl();
  refreshTrayMenu();
  if (!configuredServerUrl) {
    showSetupWindow();
    return;
  }

  const connection = await testServerConnection(configuredServerUrl);
  if (!connection.ok) {
    showSetupWindow(connection.message ?? "无法连接已配置的服务器");
    return;
  }
  await loadConfiguredServer();
}

if (!squirrelEventHandled) {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", showMainWindow);
    app.on("before-quit", () => {
      isQuitting = true;
    });
    app.on("activate", showMainWindow);
    app.on("window-all-closed", () => {
      // 托盘继续提供入口，明确选择“退出”时才终止客户端。
    });
    void app.whenReady().then(startApplication);
  }
}
