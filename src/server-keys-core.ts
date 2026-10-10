// Putting a public key from the vault on a server, so a profile can sign in with the key instead of a password.
// Only the public half is ever involved. Nothing here reads or sends a private key or a passphrase.

import type { KeyInfo } from "./api";
import { clean, sections, shq } from "./server-tools-core";

/** The key in the vault the person means: by its name, or the start or a part of it when that is unambiguous. */
export function pickKey(keys: KeyInfo[], text: string): KeyInfo {
  const t = text.trim().toLowerCase();
  if (!keys.length) throw new Error("The vault has no keys yet. Import one under SSH keys… first.");
  const names = keys.map((k) => k.name).join(", ");
  if (!t) throw new Error(`Enter the name of a key. In the vault: ${names}`);
  const exact = keys.filter((k) => k.name.toLowerCase() === t);
  const hits = exact.length ? exact : [keys.filter((k) => k.name.toLowerCase().startsWith(t)), keys.filter((k) => k.name.toLowerCase().includes(t))].find((h) => h.length) ?? [];
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `More than one key matches: ${hits.map((k) => k.name).join(", ")}` : `No key called "${text.trim()}". In the vault: ${names}`);
}

/** A comment that is safe in `authorized_keys` and a shell word: letters, digits and `. _ -`. */
export const keyComment = (name: string) => `portique:${name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "key"}`;

const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;

/**
 * Adds the key to `~/.ssh/authorized_keys` unless it is already there, creating the folder (mode 700) and the file
 * (mode 600) if needed, and keeping any other line as it is. It decides "already there" by the key itself, not its comment.
 */
export function installKeyUnix(key: string, name: string): string {
  if (!PUBLIC_KEY.test(key)) throw new Error("That isn't a public key Portique can put on a server");
  const line = `${key} ${keyComment(name)}`;
  return `export LC_ALL=C
umask 077
[ -n "$HOME" ] || { echo '@@err'; echo 'This account has no home folder on the server'; exit 0; }
KEY=${shq(key)}
LINE=${shq(line)}
d="$HOME/.ssh"; f="$d/authorized_keys"
mkdir -p "$d" && chmod 700 "$d" && touch "$f" && chmod 600 "$f" || { echo '@@err'; echo "Couldn't prepare $f"; exit 0; }
echo '@@file'; echo "$f"
if grep -qF -- "$KEY" "$f"; then
  echo '@@result'; echo already
else
  if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi
  if printf '%s\\n' "$LINE" >> "$f"; then echo '@@result'; echo added; else echo '@@result'; echo failed; fi
fi
echo '@@count'; grep -c . "$f"
`;
}

/** What the person is told before they confirm. */
export function planInstallKey(k: KeyInfo): string {
  return `Will add the public key of "${k.name}" (${k.algorithm}, ${k.fingerprint}) to ~/.ssh/authorized_keys on the server, unless it is already there.\n\nIt creates ~/.ssh and the file if they are missing and sets them to mode 700 and 600, appends one line, and changes nothing else. Only the public half is sent; the private key stays in the vault.`;
}

export function formatInstallKey(text: string, name: string): string {
  const s = sections(text);
  if (s.err?.length) throw new Error(s.err.join("\n"));
  const file = s.file?.[0] ?? "~/.ssh/authorized_keys";
  const result = s.result?.[0];
  const count = Number(s.count?.[0]);
  if (result === "already") return `"${name}" is already in ${file}. Nothing changed.`;
  if (result === "added") {
    return `Added "${name}" to ${file}${count > 0 ? ` (${count} key${count === 1 ? "" : "s"} there now)` : ""}.\n\nNext: edit this profile, set the sign-in to a key, and choose "${name}". Keep the saved password until you have tried it.`;
  }
  throw new Error(`Couldn't add the key to ${file}.\n${clean(text).trim().slice(0, 300)}`);
}
