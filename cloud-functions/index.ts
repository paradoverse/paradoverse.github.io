/**
 * Cloud Function: home page renderer served at "/".
 *
 * Reads the published HTML from KV (key: "page:home:html") and returns it.
 * When storage is empty or unavailable, it lazily loads the static seed page
 * ("default-page.html"), caches it in KV and returns that instead, so the site
 * never breaks.
 *
 * The Update panel script tag is injected right before </body>, which keeps the
 * update option available on the home page no matter which HTML is published.
 */

const HOME_KEY = "page:home:html";
const SEED_PATH = "/default-page.html";
const PANEL_SCRIPT_TAG = '<script src="/assets/update-panel.js" defer></script>';

const HTML_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
};

const EMERGENCY_HTML = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<title>Home page</title>",
  "</head>",
  "<body>",
  "<p>The home page content is temporarily unavailable. Please try again in a moment.</p>",
  PANEL_SCRIPT_TAG,
  "</body>",
  "</html>",
].join("\n");

type KVLike = {
  get(key: string): Promise<unknown>;
  put?(key: string, value: string): Promise<unknown>;
  delete?(key: string): Promise<unknown>;
  list?(options?: unknown): Promise<unknown>;
};

/**
 * Single place where the storage binding is resolved, so it is easy to swap.
 * Primary binding: PAGE_KV. Fallbacks keep older/differently named bindings working.
 */
function resolveKv(context: any): KVLike | null {
  const env = context && context.env ? context.env : {};
  const candidates = [env.PAGE_KV, env.KV, env.PAGE_STORE, context && context.kv, context && context.store];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.get === "function") {
      return candidate as KVLike;
    }
  }
  return null;
}

function toText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof (raw as any).value === "string") return (raw as any).value;
  if (raw && typeof (raw as any).text === "string") return (raw as any).text;
  return "";
}

async function readStoredHtml(kv: KVLike | null): Promise<string> {
  if (!kv) return "";
  try {
    return toText(await kv.get(HOME_KEY));
  } catch (error) {
    console.error("[home] KV read failed", error);
    return "";
  }
}

async function fetchSeed(requestUrl: string): Promise<string> {
  const attempts = [SEED_PATH, SEED_PATH + "?seed=" + Date.now()];
  for (const attempt of attempts) {
    try {
      const seedUrl = new URL(attempt, requestUrl).toString();
      const response = await fetch(seedUrl, { cache: "no-store" });
      if (response.ok) {
        const html = await response.text();
        if (html) return html;
      }
      console.error("[home] seed page fetch failed", response.status, attempt);
    } catch (error) {
      console.error("[home] seed page fetch error", error);
    }
  }
  return "";
}

/**
 * Returns the seed HTML, or an empty string when the seed cannot be read.
 * Callers decide how to degrade (redirect to the static seed, or show a notice).
 */
async function loadSeedPage(requestUrl: string): Promise<string> {
  return await fetchSeed(requestUrl);
}

async function cacheSeed(kv: KVLike | null, html: string): Promise<void> {
  if (!kv || typeof kv.put !== "function" || !html) return;
  try {
    await kv.put(HOME_KEY, html);
  } catch (error) {
    // Caching the seed is best effort; the visitor still gets a page.
    console.error("[home] KV seed cache failed", error);
  }
}

function injectPanel(html: string): string {
  if (html.indexOf("/assets/update-panel.js") !== -1) return html;
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + PANEL_SCRIPT_TAG + "\n" + html.slice(bodyClose);
  }
  const htmlClose = html.toLowerCase().lastIndexOf("</html>");
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + PANEL_SCRIPT_TAG + "\n" + html.slice(htmlClose);
  }
  return html + "\n" + PANEL_SCRIPT_TAG;
}

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: HTML_HEADERS });
}

/**
 * Named export is the Cloud Functions entry style required on this platform
 * (never "export default function onRequest"). The platform routes
 * cloud-functions/index.ts to "/" automatically.
 */
export async function onRequest(context: any): Promise<Response> {
  const request: Request = context.request;
  const method = (request.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const kv = resolveKv(context);
    let html = await readStoredHtml(kv);

    if (!html) {
      html = await loadSeedPage(request.url);
      if (html) {
        await cacheSeed(kv, html);
      } else {
        html = EMERGENCY_HTML;
      }
    }

    const rendered = injectPanel(html);
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: HTML_HEADERS });
    }
    return htmlResponse(rendered);
  } catch (error) {
    console.error("[home] render failed", error);
    try {
      const fallback = (await loadSeedPage(request.url)) || EMERGENCY_HTML;
      return htmlResponse(injectPanel(fallback));
    } catch (innerError) {
      console.error("[home] fallback failed", innerError);
      return htmlResponse(injectPanel(EMERGENCY_HTML));
    }
  }
}
