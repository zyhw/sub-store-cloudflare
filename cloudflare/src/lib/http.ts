import type { Context } from "hono";
import type { SubStoreEnv } from "../types";

export function success(c: Context<{ Bindings: SubStoreEnv }>, data: unknown) {
  return c.json({ status: "success", data });
}

export function failed(c: Context<{ Bindings: SubStoreEnv }>, message: string, status = 400) {
  return c.json(
    {
      status: "failed",
      error: {
        code: status,
        message,
      },
    },
    status as 400,
  );
}

export async function isTokenValid(secret: string | undefined, input: string | undefined) {
  if (!secret) return false;
  if (!input) return false;

  const encoder = new TextEncoder();
  const [inputDigest, secretDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(input)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return timingSafeEqual(new Uint8Array(inputDigest), new Uint8Array(secretDigest));
}

export function getBearerToken(c: Context<{ Bindings: SubStoreEnv }>) {
  const authorization = c.req.header("authorization") || "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1] || c.req.query("token") || c.req.header("x-sub-store-token");
}

export async function requireAdmin(c: Context<{ Bindings: SubStoreEnv }>) {
  if (await isTokenValid(c.env.SUB_STORE_ADMIN_TOKEN, getBearerToken(c))) return undefined;
  return failed(c, "Admin token is invalid", 401);
}

export function applyCorsHeaders(response: Response, origin: string | undefined, allowedOrigins = "") {
  const headers = new Headers(response.headers);
  const allowlist = allowedOrigins
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (origin && (allowlist.includes("*") || allowlist.includes(origin))) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Sub-Store-Token");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}
