const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const MAX_CONTENT_CHARS = 42000;
const MIN_REQUEST_INTERVAL_MS = 2500;

let lastRequestAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    sendResponse({ ok: false, error: "Invalid message." });
    return false;
  }

  if (message.type === "SUMMARIZE_PAGE") {
    summarizeCurrentPage(message.options || {})
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  if (message.type === "CLEAR_SUMMARY_CACHE") {
    clearSummaryCache(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: toUserError(error) }));
    return true;
  }

  sendResponse({ ok: false, error: "Unsupported message type." });
  return false;
});

async function summarizeCurrentPage(options) {
  const tab = await getTargetTab(options.sourceTabId);
  if (!tab?.id || !isSummarizableUrl(tab.url)) {
    throw new Error("Open a regular web page before summarizing.");
  }

  await ensureContentScript(tab.id);
  const extracted = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE_CONTENT" });
  if (!extracted?.ok) {
    throw new Error(extracted?.error || "Could not extract page content.");
  }

  const page = extracted.page;
  if (!page?.text || page.text.length < 300) {
    throw new Error("This page does not have enough readable text to summarize.");
  }

  const cacheKey = cacheKeyFor(page.url, options.summaryStyle);
  const cached = await getCachedSummary(cacheKey);
  if (cached && !options.forceRefresh) {
    return { page, summary: cached.summary, cached: true };
  }

  await waitForRateLimit();
  const settings = await getSettings();
  const summary = await callAiProvider(page, settings, options);
  await putCachedSummary(cacheKey, summary);

  return { page, summary, cached: false };
}

async function getTargetTab(sourceTabId) {
  if (Number.isInteger(sourceTabId)) {
    try {
      return await chrome.tabs.get(sourceTabId);
    } catch {
      throw new Error("The original page tab is no longer available.");
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT_SCRIPT" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/contentScript.js"]
    });
  }
}

async function callAiProvider(page, settings, options) {
  if (settings.provider === "proxy") {
    return callProxyProvider(page, settings, options);
  }
  return callGeminiProvider(page, settings, options);
}

async function callProxyProvider(page, settings, options) {
  if (!settings.proxyEndpoint) {
    throw new Error("Add a proxy endpoint in settings before summarizing.");
  }

  const response = await fetch(settings.proxyEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: page.url,
      title: page.title,
      text: trimContent(page.text),
      summaryStyle: options.summaryStyle || "standard"
    })
  });

  if (!response.ok) {
    throw new Error(formatHttpError("AI proxy", response, await safeResponseText(response)));
  }

  const data = await response.json();
  return normalizeSummary(data);
}

async function callGeminiProvider(page, settings, options) {
  if (!settings.geminiApiKey) {
    throw new Error("Add a Gemini API key in settings or switch to a proxy endpoint.");
  }

  const model = settings.geminiModel || "gemini-2.0-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`;
  const prompt = buildPrompt(page, options);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const details = await safeResponseText(response);
    throw new Error(formatHttpError("Gemini", response, details));
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error("The AI response was empty.");
  }

  return normalizeSummary(parseAiJson(rawText));
}

function buildPrompt(page, options) {
  const bulletCount = options.summaryStyle === "brief" ? 3 : 6;
  return [
    "Summarize the webpage content below. Return only valid JSON with this exact shape:",
    "{\"bullets\":[\"...\"],\"insights\":[\"...\"],\"keyPhrases\":[\"...\"],\"readingTimeMinutes\":0}",
    `Use ${bulletCount} concise bullet points. Key phrases must be exact short phrases from the page that are worth highlighting.`,
    `Title: ${page.title}`,
    `URL: ${page.url}`,
    "Content:",
    trimContent(page.text)
  ].join("\n\n");
}

function normalizeSummary(data) {
  const summary = {
    bullets: sanitizeStringArray(data?.bullets).slice(0, 8),
    insights: sanitizeStringArray(data?.insights).slice(0, 6),
    keyPhrases: sanitizeStringArray(data?.keyPhrases || data?.highlights).slice(0, 8),
    readingTimeMinutes: Number.isFinite(Number(data?.readingTimeMinutes))
      ? Math.max(1, Math.round(Number(data.readingTimeMinutes)))
      : undefined
  };

  if (!summary.bullets.length && typeof data?.summary === "string") {
    summary.bullets = data.summary
      .split(/\n+/)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  if (!summary.bullets.length) {
    throw new Error("The AI response did not include a usable summary.");
  }

  return summary;
}

function parseAiJson(rawText) {
  const cleaned = String(rawText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(cleaned);
}

function sanitizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function trimContent(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CONTENT_CHARS);
}

async function getSettings() {
  const defaults = {
    provider: "gemini",
    geminiApiKey: "",
    geminiModel: "gemini-2.0-flash",
    proxyEndpoint: ""
  };
  const stored = await chrome.storage.local.get(defaults);
  return { ...defaults, ...stored };
}

async function getCachedSummary(cacheKey) {
  const result = await chrome.storage.local.get(cacheKey);
  const entry = result[cacheKey];
  if (!entry || Date.now() - entry.createdAt > CACHE_TTL_MS) {
    return null;
  }
  return entry;
}

async function putCachedSummary(cacheKey, summary) {
  await chrome.storage.local.set({
    [cacheKey]: {
      summary,
      createdAt: Date.now()
    }
  });
}

async function clearSummaryCache(url) {
  if (!url) {
    return;
  }
  const keys = [`summary:${url}:standard`, `summary:${url}:brief`];
  await chrome.storage.local.remove(keys);
}

function cacheKeyFor(url, summaryStyle = "standard") {
  return `summary:${url}:${summaryStyle || "standard"}`;
}

async function waitForRateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

function isSummarizableUrl(url = "") {
  return /^https?:\/\//i.test(url);
}

async function safeResponseText(response) {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function toUserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message || "Something went wrong while summarizing.";
}

function formatHttpError(provider, response, details) {
  if (response.status === 429) {
    return `${provider} quota limit reached. Wait a bit and try again, use a different API key, enable billing/quota for the Google AI project, or configure a proxy endpoint.`;
  }

  if (response.status === 401 || response.status === 403) {
    return `${provider} rejected the request. Check that your API key is valid and allowed to use the selected model.`;
  }

  const apiMessage = extractApiErrorMessage(details);
  return `${provider} request failed with HTTP ${response.status}.${apiMessage ? ` ${apiMessage}` : ""}`;
}

function extractApiErrorMessage(details) {
  if (!details) {
    return "";
  }

  try {
    const parsed = JSON.parse(details);
    return String(parsed?.error?.message || "").slice(0, 220);
  } catch {
    return String(details).slice(0, 220);
  }
}
