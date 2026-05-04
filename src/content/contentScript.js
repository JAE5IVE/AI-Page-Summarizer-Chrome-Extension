const HIGHLIGHT_CLASS = "ai-page-summarizer-highlight";
const STYLE_ID = "ai-page-summarizer-style";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    sendResponse({ ok: false, error: "Invalid message." });
    return false;
  }

  if (message.type === "PING_CONTENT_SCRIPT") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "EXTRACT_PAGE_CONTENT") {
    try {
      sendResponse({ ok: true, page: extractPageContent() });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Extraction failed." });
    }
    return false;
  }

  if (message.type === "HIGHLIGHT_KEY_PHRASES") {
    try {
      const count = highlightKeyPhrases(message.phrases || []);
      sendResponse({ ok: true, count });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Highlighting failed." });
    }
    return false;
  }

  if (message.type === "CLEAR_HIGHLIGHTS") {
    clearHighlights();
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: "Unsupported message type." });
  return false;
});

function extractPageContent() {
  const title = getTitle();
  const main = findBestContentRoot();
  const blocks = collectReadableBlocks(main);
  const text = dedupeLines(blocks.map((block) => block.text)).join("\n\n");
  const wordCount = countWords(text);

  return {
    title,
    url: location.href,
    siteName: getSiteName(),
    text,
    wordCount,
    readingTimeMinutes: Math.max(1, Math.round(wordCount / 225))
  };
}

function findBestContentRoot() {
  const preferred = document.querySelector("article, main, [role='main'], .post, .article, .entry-content, .post-content");
  if (preferred && scoreElement(preferred) > 250) {
    return preferred;
  }

  const candidates = [...document.body.querySelectorAll("article, main, section, div")]
    .filter((element) => isVisible(element))
    .map((element) => ({ element, score: scoreElement(element) }))
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.score > 250 ? candidates[0].element : document.body;
}

function scoreElement(element) {
  const text = cleanText(element.innerText || "");
  const paragraphs = element.querySelectorAll("p").length;
  const headings = element.querySelectorAll("h1,h2,h3").length;
  const linksText = [...element.querySelectorAll("a")]
    .map((link) => link.innerText || "")
    .join(" ");
  const linkDensity = text.length ? linksText.length / text.length : 1;
  const clutterPenalty = element.querySelectorAll("nav, aside, footer, header, form, button").length * 40;

  return text.length + paragraphs * 120 + headings * 50 - linkDensity * 900 - clutterPenalty;
}

function collectReadableBlocks(root) {
  const selectors = "h1,h2,h3,p,li,blockquote,pre";
  const blocks = [...root.querySelectorAll(selectors)]
    .filter((element) => isVisible(element) && !isClutter(element))
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      text: cleanText(element.innerText || element.textContent || "")
    }))
    .filter((block) => isReadableBlock(block));

  if (blocks.length) {
    return blocks;
  }

  return [{ tag: "body", text: cleanText(root.innerText || "") }].filter((block) => block.text.length > 0);
}

function isReadableBlock(block) {
  if (!block.text) {
    return false;
  }
  if (/^h[1-3]$/.test(block.tag)) {
    return block.text.length > 8 && block.text.length < 180;
  }
  return block.text.length > 40 && countWords(block.text) >= 7;
}

function isClutter(element) {
  const clutterSelector = [
    "nav",
    "aside",
    "footer",
    "header",
    "script",
    "style",
    "noscript",
    "form",
    "[aria-hidden='true']",
    "[role='navigation']",
    "[role='complementary']",
    ".nav",
    ".navbar",
    ".menu",
    ".sidebar",
    ".footer",
    ".comments",
    ".comment",
    ".related",
    ".share",
    ".social",
    ".advertisement",
    ".ad"
  ].join(",");
  return Boolean(element.closest(clutterSelector));
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function highlightKeyPhrases(phrases) {
  clearHighlights();
  ensureHighlightStyle();

  const safePhrases = phrases
    .map((phrase) => cleanText(String(phrase || "")))
    .filter((phrase) => phrase.length >= 12 && phrase.length <= 140)
    .slice(0, 8);

  if (!safePhrases.length) {
    return 0;
  }

  const walker = document.createTreeWalker(
    findBestContentRoot(),
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || isClutter(parent) || parent.closest(`.${HIGHLIGHT_CLASS}`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return cleanText(node.nodeValue || "").length > 20
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    }
  );

  let count = 0;
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  for (const node of nodes) {
    if (count >= 8) {
      break;
    }
    for (const phrase of safePhrases) {
      if (highlightPhraseInNode(node, phrase)) {
        count += 1;
        break;
      }
    }
  }

  return count;
}

function highlightPhraseInNode(node, phrase) {
  const text = node.nodeValue || "";
  const index = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (index < 0) {
    return false;
  }

  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + phrase.length);
  const mark = document.createElement("mark");
  mark.className = HIGHLIGHT_CLASS;
  range.surroundContents(mark);
  return true;
}

function clearHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
  });
  document.body.normalize();
}

function ensureHighlightStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background: #fff1a8 !important;
      color: inherit !important;
      border-radius: 0.2em !important;
      box-shadow: 0 0 0 0.15em #fff1a8 !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function getTitle() {
  return cleanText(
    document.querySelector("meta[property='og:title']")?.content ||
      document.querySelector("h1")?.innerText ||
      document.title ||
      "Untitled page"
  );
}

function getSiteName() {
  return cleanText(
    document.querySelector("meta[property='og:site_name']")?.content ||
      location.hostname.replace(/^www\./, "")
  );
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function dedupeLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function countWords(text) {
  return cleanText(text).split(/\s+/).filter(Boolean).length;
}
