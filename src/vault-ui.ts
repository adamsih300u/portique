import { api, type PasswordStrength } from "./api";
import { field, h, modal } from "./ui";

let pending: Promise<void> | null = null;

const listeners: (() => void)[] = [];
/** Calls `f` whenever a vault comes into being, so the interface can show what only makes sense with one. */
export const onVaultCreated = (f: () => void) => void listeners.push(f);

/**
 * Resolves once the vault is unlocked, prompting as needed. When no vault exists yet this offers to create
 * one and rejects if the user declines, so whatever needed to store a secret can stop cleanly.
 */
export function ensureUnlocked(): Promise<void> {
  pending ??= (async () => {
    try {
      for (;;) {
        const s = await api.vaultStatus();
        if (s.unlocked) return;
        if (s.exists) await unlockDialog();
        else if (await createDialog(s.minPasswordLen)) listeners.forEach((f) => f());
        else throw new Error("No vault was created, so the secret was not saved.");
      }
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Unlocks an existing vault at startup. With none yet there is nothing to ask: it is made on the first secret. */
export async function unlockIfExists(): Promise<void> {
  if ((await api.vaultStatus()).exists) await ensureUnlocked();
}

/** Locks the vault and asks for the password again. Without a vault there is nothing to lock. */
export async function lockNow(): Promise<void> {
  if (!(await api.vaultStatus()).exists) return;
  await api.vaultLock();
  await ensureUnlocked();
}

function enterSubmits(...inputs: HTMLInputElement[]) {
  for (const i of inputs)
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (document.querySelector(".modal-buttons .primary") as HTMLElement)?.click();
    });
}

const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"];

/** A thin bar and one line of advice under a new-password field; it follows the field as you type. */
function strengthMeter(input: HTMLInputElement) {
  const bar = h("div", { class: "pw-meter-bar" });
  const text = h("small", { class: "pw-meter-text" });
  let timer: number | undefined;
  let seq = 0;
  const show = (s: PasswordStrength | null) => {
    bar.dataset.score = s ? String(s.score) : "";
    text.textContent = s ? `${STRENGTH_LABELS[s.score]}${s.advice ? ` - ${s.advice}` : ""}` : "";
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    if (!input.value) return show(null);
    const mine = ++seq;
    timer = window.setTimeout(async () => {
      const s = await api.vaultPasswordStrength(input.value).catch(() => null);
      if (mine === seq) show(s);
    }, 150);
  });
  return h("div", { class: "pw-meter" }, bar, text);
}

async function unlockDialog() {
  const pw = h("input", { type: "password", autocomplete: "off" });
  enterSubmits(pw);
  // After a rollback warning, a second press of Unlock is the confirmation.
  let acceptOlder = false;
  pw.addEventListener("input", () => (acceptOlder = false));
  await modal("Unlock Portique", h("div", {}, field("Master password", pw)), [
    {
      label: "Unlock",
      primary: true,
      action: async () => {
        try {
          await api.vaultUnlock(pw.value, acceptOlder);
        } catch (e) {
          if (!String(e).includes("vault is older than")) throw e;
          acceptOlder = true;
          throw new Error(`${String(e).replace(/^Error: /, "")}\n\nPress Unlock again to open it anyway.`);
        }
        pw.value = "";
      },
    },
  ], false, false);
}

/** Offers to create the vault; resolves true once it exists, false if the user chose not to. */
async function createDialog(minLen: number): Promise<boolean> {
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password" });
  enterSubmits(pw, pw2);
  const body = h("div", {},
    h("p", {}, "You are saving a secret. Portique keeps saved passwords, key passphrases, private keys and API tokens in one encrypted vault file, and creates it now because this is the first one. Choose a master password to protect it."),
    field(`Master password (at least ${minLen} characters)`, pw),
    strengthMeter(pw),
    field("Confirm master password", pw2),
    h("p", { class: "muted" }, "There is no recovery: if you forget this password, the vault contents cannot be decrypted. A long passphrase of several words is best."));
  const pressed = await modal("Create vault", body, [
    { label: "Not now" },
    {
      label: "Create vault",
      primary: true,
      action: async () => {
        if (pw.value !== pw2.value) throw new Error("Passwords do not match");
        if ([...pw.value].length < minLen) throw new Error(`Use at least ${minLen} characters`);
        await api.vaultCreate(pw.value);
        pw.value = pw2.value = "";
      },
    },
  ]);
  return pressed === "Create vault";
}

export async function changePasswordDialog() {
  const s = await api.vaultStatus();
  if (!s.exists) {
    await modal("No vault yet", h("p", {}, "The vault is created the first time you save a password, key or token. Until then there is no master password to change."), [{ label: "OK", primary: true }]);
    return;
  }
  const old = h("input", { type: "password", autocomplete: "current-password" });
  const nw = h("input", { type: "password", autocomplete: "new-password" });
  const nw2 = h("input", { type: "password", autocomplete: "new-password" });
  const body = h("div", {}, field("Current master password", old), field(`New master password (at least ${s.minPasswordLen} characters)`, nw), strengthMeter(nw), field("Confirm new password", nw2));
  await modal("Change master password", body, [
    { label: "Cancel" },
    {
      label: "Change",
      primary: true,
      action: async () => {
        if (nw.value !== nw2.value) throw new Error("New passwords do not match");
        await api.vaultChangePassword(old.value, nw.value);
      },
    },
  ]);
}
