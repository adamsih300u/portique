import { api } from "./api";
import { field, h, modal } from "./ui";

let pending: Promise<void> | null = null;

/** Resolves once the vault is unlocked, prompting (and creating it on first run) as needed. */
export function ensureUnlocked(): Promise<void> {
  pending ??= (async () => {
    try {
      for (;;) {
        const s = await api.vaultStatus();
        if (s.unlocked) return;
        if (s.exists) await unlockDialog();
        else await createDialog(s.minPasswordLen);
      }
    } finally {
      pending = null;
    }
  })();
  return pending;
}

function enterSubmits(...inputs: HTMLInputElement[]) {
  for (const i of inputs)
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (document.querySelector(".modal-buttons .primary") as HTMLElement)?.click();
    });
}

async function unlockDialog() {
  const pw = h("input", { type: "password", autocomplete: "off" });
  enterSubmits(pw);
  await modal("Unlock Portique", h("div", {}, field("Master password", pw)), [
    {
      label: "Unlock",
      primary: true,
      action: async () => {
        await api.vaultUnlock(pw.value);
        pw.value = "";
      },
    },
  ], false, false);
}

async function createDialog(minLen: number) {
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password" });
  enterSubmits(pw, pw2);
  const body = h("div", {},
    h("p", {}, "Portique keeps saved passwords, key passphrases, and imported private keys in one encrypted vault file. Choose a master password to protect it."),
    field(`Master password (at least ${minLen} characters)`, pw),
    field("Confirm master password", pw2),
    h("p", { class: "muted" }, "There is no recovery: if you forget this password, the vault contents cannot be decrypted. A long passphrase of several words is best."));
  await modal("Create vault", body, [
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
  ], false, false);
}

export async function changePasswordDialog() {
  const s = await api.vaultStatus();
  const old = h("input", { type: "password", autocomplete: "current-password" });
  const nw = h("input", { type: "password", autocomplete: "new-password" });
  const nw2 = h("input", { type: "password", autocomplete: "new-password" });
  const body = h("div", {}, field("Current master password", old), field(`New master password (at least ${s.minPasswordLen} characters)`, nw), field("Confirm new password", nw2));
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
