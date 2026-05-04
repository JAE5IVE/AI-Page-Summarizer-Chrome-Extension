# AI Page Summarizer Chrome Extension

A local Manifest V3 Chrome extension that extracts readable content from the active webpage, sends it to an AI provider, and displays a structured summary with key insights, reading time, caching, copy support, and optional in-page highlights.

## Features

- Manifest V3 extension with background service worker, popup UI, and injected content script.
- Heuristic article extraction that prefers `article`, `main`, and high-signal content regions while filtering nav, sidebars, footers, comments, ads, and social clutter.
- AI summaries with bullet points, key insights, key phrases for highlighting, and estimated reading time.
- `chrome.storage.local` caching per URL and summary length to avoid duplicate calls.
- No hardcoded secrets. API keys are never committed and API requests are made from the background service worker.
- Clean popup UX with loading state, errors, keyboard focus styles, copy, reset, and dark mode support.

## Local Installation

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Pin **AI Page Summarizer** from the Chrome extensions menu.
7. Open an article page, click the extension icon, add AI settings, and click **Summarize Page**.

This extension is intended for local installation and is not packaged for the Chrome Web Store.

## AI Setup

The extension supports three integration modes.

### Option 1: Gemini REST

1. Create a Google AI Studio API key.
2. Open the extension popup.
3. Click the settings button.
4. Choose **Gemini REST**.
5. Paste your API key and keep the default model `gemini-2.0-flash` or enter another Gemini model.
6. Save settings.

The key is stored in `chrome.storage.local` on your machine. It is not hardcoded in the repository and is not placed in the content script or popup request path. The background service worker makes the API request.

### Option 2: Custom Secure Proxy

### Option 2: OpenRouter

1. Create a free OpenRouter account.
2. Go to `https://openrouter.ai/keys`.
3. Create an API key.
4. Open the extension popup.
5. Click the settings button.
6. Choose **OpenRouter**.
7. Paste your API key and keep the default model `openrouter/free`.
8. Save settings.

OpenRouter's `openrouter/free` route selects from currently available free models. Free model availability and rate limits can change, so check OpenRouter if a request starts failing.

### Option 3: Custom Secure Proxy

For stronger production security, use a backend proxy endpoint. Choose **Custom secure proxy** and enter your endpoint URL.
When you save the endpoint, Chrome asks for permission to access that specific origin.

Expected request body:

```json
{
  "url": "https://example.com/article",
  "title": "Article title",
  "text": "Readable page text",
  "summaryStyle": "standard"
}
```

Expected response body:

```json
{
  "bullets": ["Concise summary point"],
  "insights": ["Important implication"],
  "keyPhrases": ["Exact phrase from the source page"],
  "readingTimeMinutes": 5
}
```

In proxy mode, keep provider keys on the server and add your own authentication, domain allow-listing, quota checks, and logging policy.

## Architecture

```text
manifest.json
src/
  background/
    serviceWorker.js   # validates popup messages, injects content script, calls AI, caches results
  content/
    contentScript.js   # extracts readable content and applies/removes highlights
  popup/
    popup.html         # accessible extension popup
    popup.css          # responsive light/dark UI
    popup.js           # UI state, settings, messaging, rendering
assets/
  icon*.png
```

Flow:

1. Popup sends `SUMMARIZE_PAGE` to the background service worker.
2. Background validates the active tab and injects `contentScript.js` using `chrome.scripting`.
3. Content script extracts meaningful text and returns title, URL, word count, and reading time.
4. Background checks `chrome.storage.local` for a fresh cached summary.
5. If needed, background calls Gemini REST or a configured proxy endpoint.
6. Popup renders the summary using `textContent` and DOM APIs to prevent XSS.
7. Optional highlight sends exact key phrases back to the content script, which wraps matching page text in sanitized `mark` elements.

## Security Decisions

- No secrets are committed.
- API requests are not made from the content script.
- The popup renders AI output with `textContent`, not `innerHTML`.
- Message handlers validate message type before acting.
- Content script highlighting only uses text nodes and `mark` elements, not arbitrary HTML injection.
- Permissions are limited to `activeTab`, `scripting`, `storage`, and the Gemini API host.
- The content script is injected only into the active tab when the user clicks the extension.

Important trade-off: a browser extension cannot perfectly hide a user-provided API key from the local browser profile. For production or shared distribution, use proxy mode so provider secrets stay on your backend.

## Trade-offs

- The extractor uses local heuristics instead of a bundled Readability dependency to keep the extension lightweight and dependency-free.
- Some highly dynamic pages, PDFs, paywalled pages, and pages with unusual markup may produce sparse extraction.
- Caching is local and expires after 24 hours.
- Gemini host permission is included for direct local setup. If you only use a proxy, you can remove the Gemini host permission.

## Development Notes

No build step is required. Edit the source files, then click **Reload** on the extension in `chrome://extensions`.

## Troubleshooting

### Gemini quota limit reached / HTTP 429

This means Google rejected the request because the API key or project has hit a quota/rate limit. Try one of these:

- Wait a while and summarize again.
- Use a different Google AI Studio API key.
- Check that the Google AI project has quota/billing enabled.
- Try a lighter model if your account supports it.
- Switch the extension to **Custom secure proxy** and route requests through your own backend/provider.

To inspect errors:

1. Go to `chrome://extensions`.
2. Find **AI Page Summarizer**.
3. Click **service worker** to inspect background logs.
4. Right-click the popup and choose **Inspect** to inspect popup logs.

## Files to Review

- `manifest.json`
- `src/background/serviceWorker.js`
- `src/content/contentScript.js`
- `src/popup/popup.html`
- `src/popup/popup.css`
- `src/popup/popup.js`
