/**
 * Cloud Function: page read / publish API.
 *
 *   GET  /page  -> { html, updatedAt }
 *   PUT  /page  -> publish whole-page HTML (POST is accepted as an alias)
 *
 * Publishing requires the shared secret in the "x-update-key" header, matched
 * against the UPDATE_ACCESS_KEY environment variable.
 *
 * Route convention used by the client: "/page" (update-panel.js also falls back
 * to "/cloud-functions/page" if the short path is not available).
 */

const HOME_KEY = "page:home:html";
const UPDATED_AT_KEY = "page:home:updatedAt";
const HISTORY_PREFIX = "page:home:history:";
const HISTORY_LIMIT = 5;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

type KVLike = {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<unknown>;
  delete?(key: string): Promise<unknown>;
  list?(options?: unknown): Promise<unknown>;
};

/** Single place where the storage binding is resolved, so it is easy to swap. */
function resolveKv(context: any): KVLike | null {
  const env = context && context.env ? context.env : {};
  const candidates = [env.PAGE_KV, env.KV, env.PAGE_STORE, context && context.kv, context && context.store];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate.get === "function" &&
      typeof candidate.put === "function"
    ) {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function failure(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, status);
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 4096).toLowerCase();
  return head.indexOf("<html") !== -1 || head.indexOf("<!doctype") !== -1;
}

async function readOptional(kv: KVLike, key: string): Promise<string> {
  try {
    return toText(await kv.get(key));
  } catch (error) {
    console.error(`[page] KV read failed for ${key}`, error);
    return "";
  }
}

/** Normalizes KV list results into an array of key names. */
function extractKeyNames(raw: unknown): string[] {
  const holder: any = raw;
  const items = Array.isArray(raw)
    ? raw
    : holder && Array.isArray(holder.keys)
      ? holder.keys
      : holder && Array.isArray(holder.list)
        ? holder.list
        : [];

  return items
    .map((item: any) => {
      if (typeof item === "string") return item;
      if (item && typeof item.name === "string") return item.name;
      if (item && typeof item.key === "string") return item.key;
      return "";
    })
    .filter((name: string) => name.length > 0);
}

async function archivePrevious(kv: KVLike, previous: string): Promise<void> {
  if (!previous || typeof kv.list !== "function") return;

  try {
    const names = extractKeyNames(await kv.list({ prefix: HISTORY_PREFIX }));
    const historyKeys = names
      .filter((name) => name.indexOf(HISTORY_PREFIX) === 0)
      .sort();

    // Make room for the new snapshot before writing it.
    while (historyKeys.length >= HISTORY_LIMIT) {
      const oldest = historyKeys.shift();
      if (!oldest) break;
      try {
        if (typeof kv.delete === "function") await kv.delete(oldest);
      } catch (error) {
        console.error("[page] history prune failed", error);
      }
    }

    await kv.put(HISTORY_PREFIX + new Date().toISOString(), previous);
  } catch (error) {
    // Archiving is best effort and must never block the publish.
    console.error("[page] archive failed", error);
  }
}

async function handleRead(context: any): Promise<Response> {
  const kv = resolveKv(context);
  if (!kv) {
    return failure(
      503,
      "Storage is not configured for this deployment. Bind a KV namespace to PAGE_KV to enable page storage.",
    );
  }

  const html = await readOptional(kv, HOME_KEY);
  const updatedAt = await readOptional(kv, UPDATED_AT_KEY);
  return json({ ok: true, html, updatedAt });
}

async function handlePublish(context: any, request: Request): Promise<Response> {
  const kv = resolveKv(context);
  if (!kv) {
    return failure(
      503,
      "Storage is not configured for this deployment. Bind a KV namespace to PAGE_KV to enable publishing.",
    );
  }

  const env = context && context.env ? context.env : {};
  const expectedKey = typeof env.UPDATE_ACCESS_KEY === "string" ? env.UPDATE_ACCESS_KEY.trim() : "";
  if (!expectedKey) {
    return failure(
      503,
      "Publishing is disabled because UPDATE_ACCESS_KEY is not configured on this deployment.",
    );
  }

  const providedKey = (request.headers.get("x-update-key") || "").trim();
  if (!providedKey || providedKey !== expectedKey) {
    return failure(401, "Invalid or missing update access key.");
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return failure(413, "Payload too large. The limit is 2 MB.");
  }

  let body = "";
  try {
    body = await request.text();
  } catch (error) {
    console.error("[page] body read failed", error);
    return failure(400, "Could not read the request body.");
  }

  if (!body) {
    return failure(400, "Request body is empty. Send the full HTML document.");
  }

  if (new TextEncoder().encode(body).length > MAX_PAYLOAD_BYTES) {
    return failure(413, "Payload too large. The limit is 2 MB.");
  }

  if (!looksLikeHtml(body)) {
    return failure(400, "Payload does not look like an HTML document. It must contain <html or <!doctype.");
  }

  const previous = await readOptional(kv, HOME_KEY);
  await archivePrevious(kv, previous);

  const updatedAt = new Date().toISOString();
  try {
    await kv.put(HOME_KEY, body);
    await kv.put(UPDATED_AT_KEY, updatedAt);
  } catch (error) {
    console.error("[page] KV write failed", error);
    return failure(500, "Could not save the page. Please try again.");
  }

  return json({ ok: true, updatedAt });
}

export async function onRequest(context: any): Promise<Response> {
  const request: Request = context.request;
  const method = (request.method || "GET").toUpperCase();

  try {
    if (method === "GET" || method === "HEAD") {
      return await handleRead(context);
    }
    if (method === "PUT" || method === "POST") {
      return await handlePublish(context, request);
    }
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...JSON_HEADERS, Allow: "GET, HEAD, PUT, POST, OPTIONS" },
      });
    }
    return failure(405, "Method not allowed. Use GET or PUT.", { allow: "GET, HEAD, PUT, POST, OPTIONS" });
  } catch (error) {
    console.error("[page] unhandled error", error);
    return failure(500, "Unexpected server error.");
  }
}
