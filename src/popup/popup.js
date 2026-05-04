const elements = {
  pageTitle: document.querySelector("#pageTitle"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsPanel: document.querySelector("#settingsPanel"),
  provider: document.querySelector("#provider"),
  geminiApiKey: document.querySelector("#geminiApiKey"),
  geminiModel: document.querySelector("#geminiModel"),
  proxyEndpoint: document.querySelector("#proxyEndpoint"),
  geminiKeyField: document.querySelector("#geminiKeyField"),
  geminiModelField: document.querySelector("#geminiModelField"),
  proxyEndpointField: document.querySelector("#proxyEndpointField"),
  saveSettings: document.querySelector("#saveSettings"),
  summaryStyle: document.querySelector("#summaryStyle"),
  summarizeButton: document.querySelector("#summarizeButton"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#statusText"),
  errorMessage: document.querySelector("#errorMessage"),
  summaryPanel: document.querySelector("#summaryPanel"),
  readingTime: document.querySelector("#readingTime"),
  wordCount: document.querySelector("#wordCount"),
  cacheState: document.querySelector("#cacheState"),
  summaryList: document.querySelector("#summaryList"),
  insightsList: document.querySelector("#insightsList"),
  copyButton: document.querySelector("#copyButton"),
  highlightButton: document.querySelector("#highlightButton"),
  clearButton: document.querySelector("#clearButton")
};

let currentResult = null;

init();

async function init() {
  bindEvents();
  await loadSettings();
  await loadCurrentTabTitle();
}

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsPanel.hidden = !elements.settingsPanel.hidden;
    elements.settingsToggle.setAttribute(
      "aria-label",
      elements.settingsPanel.hidden ? "Open settings" : "Close settings"
    );
  });

  elements.provider.addEventListener("change", updateProviderFields);
  elements.saveSettings.addEventListener("click", async () => {
    hideError();
    try {
      await saveSettings();
    } catch (error) {
      showError(error.message || "Could not save settings.");
    }
  });
  elements.summarizeButton.addEventListener("click", () => summarize(false));
  elements.copyButton.addEventListener("click", copySummary);
  elements.highlightButton.addEventListener("click", highlightSummary);
  elements.clearButton.addEventListener("click", clearState);
}

async function loadCurrentTabTitle() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  elements.pageTitle.textContent = tab?.title || "Current page";
}

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    provider: "gemini",
    geminiApiKey: "",
    geminiModel: "gemini-2.0-flash",
    proxyEndpoint: ""
  });

  elements.provider.value = settings.provider;
  elements.geminiApiKey.value = settings.geminiApiKey;
  elements.geminiModel.value = settings.geminiModel;
  elements.proxyEndpoint.value = settings.proxyEndpoint;
  updateProviderFields();
}

async function saveSettings() {
  if (elements.provider.value === "proxy" && elements.proxyEndpoint.value.trim()) {
    await requestProxyPermission(elements.proxyEndpoint.value.trim());
  }

  await chrome.storage.local.set({
    provider: elements.provider.value,
    geminiApiKey: elements.geminiApiKey.value.trim(),
    geminiModel: elements.geminiModel.value.trim() || "gemini-2.0-flash",
    proxyEndpoint: elements.proxyEndpoint.value.trim()
  });
  showStatus("Settings saved.", false);
  setTimeout(hideStatus, 1200);
}

async function requestProxyPermission(endpoint) {
  const url = new URL(endpoint);
  const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Proxy endpoints must use HTTPS unless they are localhost.");
  }

  const originPattern = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error("Chrome needs permission for that proxy origin before it can be used.");
  }
}

function updateProviderFields() {
  const isGemini = elements.provider.value === "gemini";
  elements.geminiKeyField.hidden = !isGemini;
  elements.geminiModelField.hidden = !isGemini;
  elements.proxyEndpointField.hidden = isGemini;
}

async function summarize(forceRefresh) {
  setBusy(true, "Summarizing page...");
  hideError();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_PAGE",
      options: {
        forceRefresh,
        summaryStyle: elements.summaryStyle.value
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Summary failed.");
    }

    currentResult = response;
    renderResult(response);
  } catch (error) {
    showError(error.message || "Could not summarize this page.");
  } finally {
    setBusy(false);
  }
}

function renderResult(result) {
  elements.pageTitle.textContent = result.page.title || "Current page";
  elements.readingTime.textContent = `${result.summary.readingTimeMinutes || result.page.readingTimeMinutes} min read`;
  elements.wordCount.textContent = `${result.page.wordCount.toLocaleString()} words`;
  elements.cacheState.textContent = result.cached ? "Cached" : "Fresh";

  renderList(elements.summaryList, result.summary.bullets);
  renderList(elements.insightsList, result.summary.insights.length ? result.summary.insights : ["No separate insights returned."]);
  elements.summaryPanel.hidden = false;
}

function renderList(list, items) {
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  }
}

async function copySummary() {
  if (!currentResult) {
    return;
  }

  const text = [
    currentResult.page.title,
    "",
    "Summary:",
    ...currentResult.summary.bullets.map((item) => `- ${item}`),
    "",
    "Key insights:",
    ...currentResult.summary.insights.map((item) => `- ${item}`)
  ].join("\n");

  await navigator.clipboard.writeText(text);
  showStatus("Copied summary.", false);
  setTimeout(hideStatus, 1200);
}

async function highlightSummary() {
  if (!currentResult?.summary?.keyPhrases?.length) {
    showError("The summary did not include highlightable key phrases.");
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "HIGHLIGHT_KEY_PHRASES",
      phrases: currentResult.summary.keyPhrases
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Highlighting failed.");
    }
    showStatus(`Highlighted ${response.count} section${response.count === 1 ? "" : "s"}.`, false);
    setTimeout(hideStatus, 1400);
  } catch (error) {
    showError(error.message || "Could not highlight this page.");
  }
}

async function clearState() {
  if (currentResult?.page?.url) {
    await chrome.runtime.sendMessage({ type: "CLEAR_SUMMARY_CACHE", url: currentResult.page.url });
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_HIGHLIGHTS" });
  } catch {
    // The content script may not be active yet.
  }

  currentResult = null;
  elements.summaryPanel.hidden = true;
  hideError();
  hideStatus();
}

function setBusy(isBusy, text = "") {
  elements.summarizeButton.disabled = isBusy;
  elements.status.hidden = !isBusy;
  elements.statusText.textContent = text;
}

function showStatus(text, withSpinner) {
  elements.status.hidden = false;
  elements.statusText.textContent = text;
  elements.status.querySelector(".spinner").hidden = !withSpinner;
}

function hideStatus() {
  elements.status.hidden = true;
  elements.status.querySelector(".spinner").hidden = false;
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = false;
}

function hideError() {
  elements.errorMessage.hidden = true;
  elements.errorMessage.textContent = "";
}
