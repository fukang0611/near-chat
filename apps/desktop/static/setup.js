const form = document.querySelector("#server-form");
const input = document.querySelector("#server-url");
const testButton = document.querySelector("#test-button");
const connectButton = document.querySelector("#connect-button");
const status = document.querySelector("#connection-status");
const statusCopy = status.querySelector("p");
const version = document.querySelector("#app-version");

function showStatus(tone, message) {
  status.hidden = false;
  status.className = `status is-${tone}`;
  statusCopy.textContent = message;
}

function setBusy(busy) {
  input.disabled = busy;
  testButton.disabled = busy;
  connectButton.disabled = busy;
}

async function testConnection() {
  setBusy(true);
  showStatus("loading", "正在检查服务器连接…");
  try {
    const result = await window.nearChatSetup.testServer(input.value);
    showStatus(result.ok ? "success" : "error", result.message);
    if (result.ok && result.serverUrl) input.value = result.serverUrl;
    return result;
  } finally {
    setBusy(false);
  }
}

testButton.addEventListener("click", () => void testConnection());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  showStatus("loading", "正在连接并保存配置…");
  try {
    const result = await window.nearChatSetup.connectServer(input.value);
    if (!result.ok) {
      showStatus("error", result.message);
      return;
    }
    showStatus("success", "连接成功，正在进入近聊…");
  } finally {
    setBusy(false);
  }
});

window.nearChatSetup.getState().then((state) => {
  input.value = state.currentServerUrl || state.defaultServerUrl;
  version.textContent = `近聊桌面客户端 v${state.appVersion}`;
  if (state.errorMessage) showStatus("error", state.errorMessage);
  input.focus();
  input.select();
});
