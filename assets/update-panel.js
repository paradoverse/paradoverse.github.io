/**
 * Update panel for the home page.
 *
 * Loaded by the home page renderer (and injected on the seed page as well), so
 * the Update option is always available. Visitors can open the panel, but
 * publishing requires the access key checked by the cloud function.
 *
 * Endpoints:
 *   GET  /page  -> { html, updatedAt }
 *   PUT  /page  -> publish full page HTML (x-update-key header)
 *
 * No dependencies, no CDN, no document.write.
 */
(function () {
  "use strict";

  var PUBLISH_PATH = "/page";
  var FALLBACK_PATHS = ["/cloud-functions/page"];
  var MAX_BYTES = 2 * 1024 * 1024;
  var KEY_STORAGE = "pv-update-key";
  var APPLIED_HASH_STORAGE = "pv-applied-hash";
  var PANEL_ID = "pv-update-panel";
  var TOGGLE_ID = "pv-update-toggle";
  var STYLE_ID = "pv-update-styles";
  var PANEL_SCRIPT_MARKER = "/assets/update-panel.js";

  var state = {
    busy: false,
    open: false
  };

  /* ---------------------------------------------------------------- utils */

  function getSession(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function setSession(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (error) {
      /* storage may be unavailable; ignore */
    }
  }

  function hashString(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return "h" + hash.toString(16) + "-" + text.length;
  }

  function byteLength(text) {
    try {
      return new TextEncoder().encode(text).length;
    } catch (error) {
      return text.length;
    }
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return Math.round(bytes / 1024) + " KB";
  }

  function formatTime(value) {
    if (!value) return "";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function normalizeMarkup(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  /* ------------------------------------------------------------ data layer */

  function endpointCandidates() {
    return [PUBLISH_PATH].concat(FALLBACK_PATHS);
  }

  function apiRequest(method, options) {
    var opts = options || {};
    var candidates = endpointCandidates();
    var headers = { "Accept": "application/json" };
    var init = { method: method, headers: headers, cache: "no-store" };

    if (opts.body !== undefined) {
      headers["Content-Type"] = "text/html; charset=utf-8";
      init.body = opts.body;
    }
    if (opts.key) {
      headers["x-update-key"] = opts.key;
    }

    function attempt(index) {
      if (index >= candidates.length) {
        return Promise.reject(new Error("The page service could not be reached. Check your connection and try again."));
      }
      return fetch(candidates[index], init).then(
        function (response) {
          var type = response.headers.get("content-type") || "";
          if (response.status === 404 && type.indexOf("json") === -1) {
            return attempt(index + 1);
          }
          return response.text().then(function (text) {
            var data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch (error) {
              data = null;
            }
            return { response: response, data: data };
          });
        },
        function (error) {
          if (index + 1 < candidates.length) return attempt(index + 1);
          throw error;
        }
      );
    }

    return attempt(0);
  }

  function describeFailure(result) {
    var data = result.data || {};
    if (data && typeof data.error === "string" && data.error) return data.error;
    if (result.response.status === 401) return "Invalid or missing update access key.";
    if (result.response.status === 413) return "The page is too large. The limit is 2 MB.";
    if (result.response.status === 503) return "Storage is not configured for this deployment yet.";
    return "The request failed with status " + result.response.status + ".";
  }

  /* ------------------------------------------------------- client fallback */

  /**
   * When "/" is served straight from the static seed file, the published HTML
   * never reaches the visitor through the renderer. In that case apply the
   * published document on the client so updates still show up.
   */
  function applyPublishedHtml(publishedHtml) {
    if (!publishedHtml) return false;

    var parsed;
    try {
      parsed = new DOMParser().parseFromString(publishedHtml, "text/html");
    } catch (error) {
      return false;
    }
    if (!parsed || !parsed.body) return false;

    var publishedSignature = signatureOf(parsed.body);
    var currentSignature = signatureOf(document.body);
    if (publishedSignature && publishedSignature === currentSignature) return false;

    var publishedHash = hashString(publishedHtml);
    if (getSession(APPLIED_HASH_STORAGE) === publishedHash) return false;

    // Copy the published document's styles and stylesheets into the live head.
    // Existing identical blocks are skipped to avoid duplicated CSS.
    var styles = parsed.head ? parsed.head.querySelectorAll('style, link[rel="stylesheet"]') : [];
    for (var i = 0; i < styles.length; i += 1) {
      var node = styles[i];
      if (!document.head) break;
      if (node.tagName === "STYLE") {
        if (node.getAttribute("id") === STYLE_ID) continue;
        var css = node.textContent || "";
        if (!css.trim()) continue;
        if (hasStyleWithCss(css)) continue;
        var styleCopy = document.createElement("style");
        if (node.getAttribute("id")) styleCopy.setAttribute("id", node.getAttribute("id"));
        styleCopy.setAttribute("data-pv-applied", "1");
        styleCopy.textContent = css;
        document.head.appendChild(styleCopy);
      } else if (node.tagName === "LINK") {
        var href = node.getAttribute("href") || "";
        if (!href) continue;
        if (hasStylesheetWithHref(href)) continue;
        var linkCopy = document.createElement("link");
        linkCopy.setAttribute("rel", "stylesheet");
        linkCopy.setAttribute("href", href);
        linkCopy.setAttribute("data-pv-applied", "1");
        document.head.appendChild(linkCopy);
      }
    }

    document.body.innerHTML = parsed.body.innerHTML;

    // Scripts inserted through innerHTML do not execute; recreate them so the
    // published page keeps its own behavior.
    var scripts = document.body.querySelectorAll("script");
    for (var s = 0; s < scripts.length; s += 1) {
      var old = scripts[s];
      var src = old.getAttribute("src");
      if (src && src.indexOf(PANEL_SCRIPT_MARKER) !== -1) {
        if (old.parentNode) old.parentNode.removeChild(old);
        continue;
      }
      var fresh = document.createElement("script");
      if (src) {
        fresh.src = src;
        fresh.async = false;
        if (old.getAttribute("type")) fresh.setAttribute("type", old.getAttribute("type"));
      } else {
        fresh.textContent = old.textContent;
        if (old.getAttribute("type")) fresh.setAttribute("type", old.getAttribute("type"));
      }
      if (old.parentNode) {
        old.parentNode.replaceChild(fresh, old);
      }
    }

    setSession(APPLIED_HASH_STORAGE, publishedHash);
    return true;
  }

  function hasStyleWithCss(css) {
    if (!document.head) return false;
    var existing = document.head.querySelectorAll("style");
    var needle = normalizeMarkup(css);
    if (!needle) return false;
    for (var i = 0; i < existing.length; i += 1) {
      if (existing[i].getAttribute("id") === STYLE_ID) continue;
      if (normalizeMarkup(existing[i].textContent || "") === needle) return true;
    }
    return false;
  }

  function hasStylesheetWithHref(href) {
    if (!document.head) return false;
    var existing = document.head.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < existing.length; i += 1) {
      if (existing[i].getAttribute("href") === href) return true;
    }
    return false;
  }

  function signatureOf(body) {
    if (!body) return "";
    var clone = body.cloneNode(true);
    var panelNodes = clone.querySelectorAll("#" + PANEL_ID + ", #" + TOGGLE_ID + ", #" + STYLE_ID);
    for (var i = 0; i < panelNodes.length; i += 1) {
      if (panelNodes[i].parentNode) panelNodes[i].parentNode.removeChild(panelNodes[i]);
    }
    var scriptNodes = clone.querySelectorAll("script");
    for (var j = scriptNodes.length - 1; j >= 0; j -= 1) {
      var src = scriptNodes[j].getAttribute("src") || "";
      if (src.indexOf(PANEL_SCRIPT_MARKER) !== -1) {
        if (scriptNodes[j].parentNode) scriptNodes[j].parentNode.removeChild(scriptNodes[j]);
      }
    }
    return hashString(normalizeMarkup(clone.innerHTML));
  }

  function syncPublishedContent() {
    return apiRequest("GET").then(function (result) {
      if (!result.response.ok || !result.data) return false;
      var html = typeof result.data.html === "string" ? result.data.html : "";
      if (!html) return false;
      return applyPublishedHtml(html);
    }).catch(function () {
      return false;
    });
  }

  /* ----------------------------------------------------------------- styles */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "#" + TOGGLE_ID + " {",
      "  position: fixed;",
      "  right: 18px;",
      "  bottom: 18px;",
      "  z-index: 2147483000;",
      "  min-height: 46px;",
      "  padding: 11px 22px;",
      "  border: 1px solid rgba(255, 255, 255, 0.24);",
      "  border-radius: 999px;",
      "  background: linear-gradient(135deg, #2997ff, #0071e3);",
      "  color: #ffffff;",
      '  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      "  font-size: 14.5px;",
      "  font-weight: 700;",
      "  letter-spacing: 0.01em;",
      "  cursor: pointer;",
      "  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.36), 0 6px 20px rgba(41, 151, 255, 0.32);",
      "}",
      "#" + TOGGLE_ID + ":hover { transform: translateY(-2px); }",
      "#" + TOGGLE_ID + ":focus-visible { outline: 2px solid #58d5ff; outline-offset: 3px; }",
      "#" + PANEL_ID + " {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 2147483200;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  padding: 18px;",
      "  background: rgba(2, 4, 10, 0.82);",
      "  -webkit-backdrop-filter: blur(10px);",
      "  backdrop-filter: blur(10px);",
      '  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      "  color: #f8fafc;",
      "}",
      "#" + PANEL_ID + "[hidden] { display: none; }",
      "#" + PANEL_ID + " .pv-card {",
      "  width: min(720px, 100%);",
      "  max-height: 92vh;",
      "  overflow: auto;",
      "  padding: 22px;",
      "  border: 1px solid rgba(255, 255, 255, 0.13);",
      "  border-radius: 20px;",
      "  background: rgba(13, 20, 35, 0.96);",
      "  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);",
      "}",
      "#" + PANEL_ID + " h2 {",
      "  margin: 0 0 6px;",
      "  font-size: 19px;",
      "  font-weight: 800;",
      "  letter-spacing: 0.01em;",
      "}",
      "#" + PANEL_ID + " p.pv-hint {",
      "  margin: 0 0 16px;",
      "  font-size: 13px;",
      "  line-height: 1.55;",
      "  color: #94a3b8;",
      "}",
      "#" + PANEL_ID + " label {",
      "  display: block;",
      "  margin: 14px 0 6px;",
      "  font-size: 12.5px;",
      "  font-weight: 700;",
      "  letter-spacing: 0.06em;",
      "  text-transform: uppercase;",
      "  color: #94a3b8;",
      "}",
      "#" + PANEL_ID + " input[type=password],",
      "#" + PANEL_ID + " textarea {",
      "  width: 100%;",
      "  padding: 11px 13px;",
      "  border: 1px solid rgba(255, 255, 255, 0.13);",
      "  border-radius: 12px;",
      "  background: rgba(2, 4, 10, 0.72);",
      "  color: #f8fafc;",
      "  font-family: inherit;",
      "  font-size: 14px;",
      "}",
      "#" + PANEL_ID + " input[type=password]:focus,",
      "#" + PANEL_ID + " textarea:focus {",
      "  outline: none;",
      "  border-color: rgba(88, 213, 255, 0.65);",
      "}",
      "#" + PANEL_ID + " textarea {",
      "  min-height: 210px;",
      "  resize: vertical;",
      "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
      "  font-size: 12.5px;",
      "  line-height: 1.5;",
      "  white-space: pre;",
      "}",
      "#" + PANEL_ID + " input[type=file] {",
      "  width: 100%;",
      "  padding: 10px 0;",
      "  font-size: 13px;",
      "  color: #94a3b8;",
      "}",
      "#" + PANEL_ID + " .pv-row {",
      "  display: flex;",
      "  flex-wrap: wrap;",
      "  gap: 10px;",
      "  margin-top: 18px;",
      "}",
      "#" + PANEL_ID + " button {",
      "  min-height: 44px;",
      "  padding: 10px 18px;",
      "  border-radius: 999px;",
      "  border: 1px solid rgba(255, 255, 255, 0.24);",
      "  background: linear-gradient(135deg, #2997ff, #0071e3);",
      "  color: #ffffff;",
      "  font-family: inherit;",
      "  font-size: 14px;",
      "  font-weight: 700;",
      "  cursor: pointer;",
      "}",
      "#" + PANEL_ID + " button.pv-ghost {",
      "  background: rgba(255, 255, 255, 0.06);",
      "  color: #f8fafc;",
      "  border-color: rgba(88, 213, 255, 0.48);",
      "}",
      "#" + PANEL_ID + " button:disabled {",
      "  opacity: 0.55;",
      "  cursor: not-allowed;",
      "}",
      "#" + PANEL_ID + " .pv-status {",
      "  margin-top: 14px;",
      "  min-height: 20px;",
      "  font-size: 13px;",
      "  line-height: 1.5;",
      "  color: #94a3b8;",
      "  word-break: break-word;",
      "}",
      "#" + PANEL_ID + ' .pv-status[data-tone="ok"] { color: #34d399; }',
      "#" + PANEL_ID + ' .pv-status[data-tone="error"] { color: #fb7185; }',
      "@media (max-width: 560px) {",
      "  #" + TOGGLE_ID + " { right: 12px; bottom: 12px; padding: 10px 18px; font-size: 13.5px; }",
      "  #" + PANEL_ID + " .pv-card { padding: 16px; border-radius: 16px; }",
      "} "
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  /* -------------------------------------------------------------------- UI */

  function setStatus(message, tone) {
    var node = document.getElementById("pv-update-status");
    if (!node) return;
    node.textContent = message || "";
    if (tone) {
      node.setAttribute("data-tone", tone);
    } else {
      node.removeAttribute("data-tone");
    }
  }

  function readKey() {
    var input = document.getElementById("pv-update-key");
    if (input) return input.value.trim();
    var stored = getSession(KEY_STORAGE);
    return stored ? stored.trim() : "";
  }

  function buildPanel() {
    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "pv-update-title");
    panel.hidden = true;

    panel.innerHTML = [
      '<div class="pv-card">',
      '<h2 id="pv-update-title">Update home page</h2>',
      '<p class="pv-hint">Paste the full HTML of the new home page, or upload an .html file. Publishing replaces the live home page for every visitor.</p>',
      '<label for="pv-update-key">Access key</label>',
      '<input id="pv-update-key" type="password" autocomplete="off" spellcheck="false" placeholder="Required to publish">',
      '<label for="pv-update-html">Page code (full HTML document)</label>',
      '<textarea id="pv-update-html" spellcheck="false" placeholder="&lt;!DOCTYPE html&gt;&#10;&lt;html&gt;...&lt;/html&gt;"></textarea>',
      '<label for="pv-update-file">Or upload an .html file</label>',
      '<input id="pv-update-file" type="file" accept=".html,.htm,text/html">',
      '<div class="pv-row">',
      '<button type="button" id="pv-load-current" class="pv-ghost">Load current version</button>',
      '<button type="button" id="pv-apply">Apply to home page</button>',
      '<button type="button" id="pv-close" class="pv-ghost">Close</button>',
      "</div>",
      '<div class="pv-status" id="pv-update-status" role="status" aria-live="polite"></div>',
      "</div>"
    ].join("");

    panel.addEventListener("click", function (event) {
      if (event.target === panel) closePanel();
    });

    document.body.appendChild(panel);

    var keyInput = document.getElementById("pv-update-key");
    var storedKey = getSession(KEY_STORAGE);
    if (storedKey) keyInput.value = storedKey;
    keyInput.addEventListener("input", function () {
      setSession(KEY_STORAGE, keyInput.value);
    });

    document.getElementById("pv-close").addEventListener("click", closePanel);
    document.getElementById("pv-load-current").addEventListener("click", loadCurrent);
    document.getElementById("pv-apply").addEventListener("click", publish);

    var fileInput = document.getElementById("pv-update-file");
    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > MAX_BYTES) {
        setStatus("That file is " + formatBytes(file.size) + ", over the 2 MB limit. Choose a smaller file.", "error");
        fileInput.value = "";
        return;
      }
      setStatus("Reading file...");
      var reader = new FileReader();
      reader.onload = function () {
        var textarea = document.getElementById("pv-update-html");
        textarea.value = String(reader.result || "");
        setStatus("Loaded " + file.name + " (" + formatBytes(file.size) + "). Review it, then apply.", "ok");
      };
      reader.onerror = function () {
        setStatus("Could not read that file. Try again or paste the code instead.", "error");
      };
      reader.readAsText(file);
    });

    return panel;
  }

  function openPanel() {
    injectStyles();
    var panel = document.getElementById(PANEL_ID) || buildPanel();
    panel.hidden = false;
    state.open = true;
    var keyInput = document.getElementById("pv-update-key");
    if (keyInput) {
      var storedKey = getSession(KEY_STORAGE);
      if (storedKey && !keyInput.value) keyInput.value = storedKey;
      try {
        keyInput.focus();
      } catch (error) {
        /* focus is best effort */
      }
    }
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
    state.open = false;
  }

  function loadCurrent() {
    if (state.busy) return;
    state.busy = true;
    setStatus("Loading the current version...");
    apiRequest("GET").then(function (result) {
      if (!result.response.ok) {
        setStatus(describeFailure(result), "error");
        return;
      }
      var html = result.data && typeof result.data.html === "string" ? result.data.html : "";
      var textarea = document.getElementById("pv-update-html");
      if (!html) {
        setStatus("Nothing has been published yet. The textarea was left unchanged.", "error");
        return;
      }
      textarea.value = html;
      var when = result.data && result.data.updatedAt ? " Last published " + formatTime(result.data.updatedAt) + "." : "";
      setStatus("Loaded the current published version." + when, "ok");
    }).catch(function (error) {
      setStatus(error && error.message ? error.message : "Could not load the current version.", "error");
    }).then(function () {
      state.busy = false;
    });
  }

  function publish() {
    if (state.busy) return;
    var textarea = document.getElementById("pv-update-html");
    var html = textarea ? textarea.value : "";
    var key = readKey();

    if (!html.trim()) {
      setStatus("Paste the page code or upload an .html file first.", "error");
      return;
    }
    if (byteLength(html) > MAX_BYTES) {
      setStatus("The page is " + formatBytes(byteLength(html)) + ", over the 2 MB limit.", "error");
      return;
    }
    var head = html.slice(0, 4096).toLowerCase();
    if (head.indexOf("<html") === -1 && head.indexOf("<!doctype") === -1) {
      setStatus("That does not look like a full HTML document. It must contain <html or <!doctype.", "error");
      return;
    }
    if (!key) {
      setStatus("Enter the access key to publish.", "error");
      return;
    }

    state.busy = true;
    var applyButton = document.getElementById("pv-apply");
    if (applyButton) applyButton.disabled = true;
    setStatus("Publishing...");

    apiRequest("PUT", { body: html, key: key }).then(function (result) {
      if (!result.response.ok || !result.data || result.data.ok !== true) {
        setStatus(describeFailure(result), "error");
        return;
      }
      var updatedAt = result.data.updatedAt || "";
      setStatus("Published successfully" + (updatedAt ? " at " + formatTime(updatedAt) : "") + ". Reloading...", "ok");
      try {
        window.sessionStorage.removeItem(APPLIED_HASH_STORAGE);
        window.sessionStorage.setItem(KEY_STORAGE, key);
      } catch (error) {
        /* ignore */
      }
      window.setTimeout(function () {
        window.location.reload();
      }, 1200);
    }).catch(function (error) {
      setStatus(error && error.message ? error.message : "The page could not be published. Try again.", "error");
    }).then(function () {
      state.busy = false;
      if (applyButton) applyButton.disabled = false;
    });
  }

  function ensureToggle() {
    if (document.getElementById(TOGGLE_ID)) return;
    var button = document.createElement("button");
    button.id = TOGGLE_ID;
    button.type = "button";
    button.textContent = "Update";
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", function () {
      if (state.open) {
        closePanel();
      } else {
        openPanel();
      }
    });
    document.body.appendChild(button);
  }

  function autoOpen() {
    var query = window.location.search || "";
    var hash = window.location.hash || "";
    if (/[?&]edit=1(?:&|$)/.test(query) || hash === "#update") {
      openPanel();
    }
  }

  function onEscape(event) {
    if (event.key === "Escape" && state.open) closePanel();
  }

  function boot() {
    injectStyles();
    ensureToggle();
    document.addEventListener("keydown", onEscape);
    autoOpen();

    // Client-side fallback for deployments where "/" is served as a static file.
    syncPublishedContent().then(function (applied) {
      if (applied) {
        injectStyles();
        ensureToggle();
        autoOpen();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
