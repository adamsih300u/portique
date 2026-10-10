import { invoke } from "@tauri-apps/api/core";

/**
 * Sends secrets to Rust as raw bytes instead of JSON, so no JSON text of them is built, and zeroes
 * the bytes once the call settles. The layout is, for each secret in order, a 4-byte little-endian
 * length followed by its UTF-8 bytes. `src-tauri/src/ipc.rs` reads it back.
 *
 * Only the encoded bytes can be wiped here: the string the caller passed in stays until the
 * garbage collector takes it. Anything that is not a secret goes in `headers` (ASCII text).
 */
export function encodeSecrets(secrets: string[]): Uint8Array {
  const enc = new TextEncoder();
  const parts = secrets.map((s) => enc.encode(s));
  const body = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(body.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length, true);
    body.set(p, at + 4);
    at += 4 + p.length;
    p.fill(0);
  }
  return body;
}

export async function invokeSecret<T>(command: string, secrets: string[], headers: Record<string, string> = {}): Promise<T> {
  const body = encodeSecrets(secrets);
  try {
    return await invoke<T>(command, body, { headers });
  } finally {
    body.fill(0);
  }
}
