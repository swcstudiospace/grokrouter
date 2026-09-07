const elements = {
  codex: document.querySelector("#codexEnabled"),
  openRouter: document.querySelector("#openRouterEnabled"),
  anthropic: document.querySelector("#anthropicEnabled"),
  xai: document.querySelector("#xaiEnabled"),
  defaultProvider: document.querySelector("#defaultProvider"),
  codexModel: document.querySelector("#codexModel"),
  openRouterModel: document.querySelector("#openRouterModel"),
  anthropicModel: document.querySelector("#anthropicModel"),
  xaiModel: document.querySelector("#xaiModel"),
  openRouterKey: document.querySelector("#openRouterKey"),
  install: document.querySelector("#install"),
  status: document.querySelector("#status"),
  spinner: document.querySelector("#spinner"),
  activity: document.querySelector("#activity"),
  recovery: document.querySelector("#recovery"),
  retryInstall: document.querySelector("#retryInstall"),
  copyDiagnostics: document.querySelector("#copyDiagnostics"),
  openSupport: document.querySelector("#openSupport"),
};

const buttons = [...document.querySelectorAll("button")];
let busy = false;

function syncProviders() {
  const previous = elements.defaultProvider.value;
  elements.defaultProvider.replaceChildren();
  if (elements.codex.checked) elements.defaultProvider.add(new Option("Codex SDK", "codex"));
  if (elements.openRouter.checked) elements.defaultProvider.add(new Option("OpenRouter", "openrouter"));
  if (elements.anthropic.checked) elements.defaultProvider.add(new Option("Anthropic", "anthropic"));
  if (elements.xai.checked) elements.defaultProvider.add(new Option("xAI", "xai"));
  if ([...elements.defaultProvider.options].some((option) => option.value === previous)) {
    elements.defaultProvider.value = previous;
  }
  elements.codexModel.disabled = !elements.codex.checked || busy;
  elements.openRouterModel.disabled = !elements.openRouter.checked || busy;
  elements.openRouterKey.disabled = !elements.openRouter.checked || busy;
  elements.anthropicModel.disabled = !elements.anthropic.checked || busy;
  elements.xaiModel.disabled = !elements.xai.checked || busy;
  const anyProvider = elements.codex.checked || elements.openRouter.checked || elements.anthropic.checked || elements.xai.checked;
  elements.install.disabled = busy || !anyProvider;
}

function setBusy(value, status) {
  busy = value;
  elements.status.textContent = status;
  elements.spinner.classList.toggle("hidden", !value);
  elements.codex.disabled = value;
  elements.openRouter.disabled = value;
  elements.anthropic.disabled = value;
  elements.xai.disabled = value;
  elements.defaultProvider.disabled = value;
  buttons.forEach((button) => { button.disabled = value; });
  syncProviders();
}

function appendLog(message) {
  elements.activity.textContent += `${message}\n`;
  elements.activity.scrollTop = elements.activity.scrollHeight;
}

function validOpenRouterKey(value) {
  return value.startsWith("sk-or-v1-") && value.length >= 33 && !/\s/.test(value);
}

async function run(action, payload = {}) {
  if (busy) return;
  elements.recovery.classList.add("hidden");
  setBusy(true, action === "install" ? "Checking Grok Bot…" : "Connecting to the Bot computer…");
  try {
    const result = await window.grokRouter.run(action, payload);
    if (!result?.ok) {
      if (busy) setBusy(false, `Stopped: ${result?.error || "The installer request failed."}`);
      elements.retryInstall.classList.toggle("hidden", action !== "install");
      elements.recovery.classList.remove("hidden");
      return;
    }
  } catch (error) {
    setBusy(false, `Stopped: ${error.message}`);
    appendLog(`✗ ${error.message}`);
    elements.retryInstall.classList.toggle("hidden", action !== "install");
    elements.recovery.classList.remove("hidden");
  }
}

elements.codex.addEventListener("change", syncProviders);
elements.openRouter.addEventListener("change", syncProviders);
elements.anthropic.addEventListener("change", syncProviders);
elements.xai.addEventListener("change", syncProviders);
elements.install.addEventListener("click", () => {
  const key = elements.openRouterKey.value.trim();
  if (elements.openRouter.checked && key && !validOpenRouterKey(key)) {
    window.alert("That OpenRouter key does not look valid. Paste the complete key beginning with sk-or-v1-. Nothing has been saved or installed.");
    return;
  }
  const providers = [
    elements.codex.checked && "codex",
    elements.openRouter.checked && "openrouter",
    elements.anthropic.checked && "anthropic",
    elements.xai.checked && "xai",
  ].filter(Boolean);
  const payload = {
    defaultProvider: elements.defaultProvider.value,
    providers,
    codexModel: elements.codexModel.value,
    openRouterModel: elements.openRouterModel.value,
    anthropicModel: elements.anthropicModel.value,
    xaiModel: elements.xaiModel.value,
    openRouterKey: key,
  };
  elements.openRouterKey.value = "";
  run("install", payload);
});

elements.retryInstall.addEventListener("click", () => elements.install.click());
elements.copyDiagnostics.addEventListener("click", async () => {
  const copied = await window.grokRouter.copyDiagnostics();
  if (copied) elements.status.textContent = "Safe diagnostics copied. Paste them into a GitHub issue or support reply.";
});
elements.openSupport.addEventListener("click", () => window.grokRouter.openSupport());

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action === "uninstall" && !window.confirm("Restore the verified stock Grok Bot host? The router runtime and backup will remain recoverable on the Bot computer.")) return;
    run(action);
  });
});

window.grokRouter.onEvent((event) => {
  if (event.type === "log") appendLog(event.message);
  if (event.type === "status") setBusy(event.busy, event.message);
});

syncProviders();
