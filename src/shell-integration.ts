import { h, modal } from "./ui";

/** Makes the shell announce prompts and command output (OSC 133) so Portique can navigate and copy them. */
const SNIPPETS = [
  {
    name: "bash (~/.bashrc, bash 4.4+)",
    text: `if [[ -z $__PORTIQUE_SI ]]; then
  __PORTIQUE_SI=1
  __portique_pc() { printf '\\e]133;D;%s\\a\\e]133;A\\a' "$?"; }
  PROMPT_COMMAND="__portique_pc\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS0='\\e]133;C\\a'
  PS1="\${PS1}\\[\\e]133;B\\a\\]"
fi
`,
  },
  {
    name: "zsh (~/.zshrc)",
    text: `if [[ -z $__PORTIQUE_SI ]]; then
  __PORTIQUE_SI=1
  __portique_precmd()  { print -Pn '\\e]133;D;%?\\a\\e]133;A\\a' }
  __portique_preexec() { print -n '\\e]133;C\\a' }
  precmd_functions+=(__portique_precmd)
  preexec_functions+=(__portique_preexec)
  PS1+=$'%{\\e]133;B\\a%}'
fi
`,
  },
];

export async function shellIntegrationDialog() {
  const body = h("div", {},
    h("p", { class: "muted" }, "Add one of these to the shell's startup file on the machine you connect to. Portique can then jump between prompts (Ctrl+Shift+↑/↓) and copy the output of the last command."),
    ...SNIPPETS.flatMap((s) => {
      const copy = h("button", { type: "button", onclick: async () => {
        await navigator.clipboard.writeText(s.text).catch(() => {});
        copy.textContent = "Copied";
      } }, "Copy");
      return [h("h3", {}, s.name), h("textarea", { class: "snippet", readOnly: true, spellcheck: false, value: s.text }), copy];
    }));
  await modal("Shell integration", body, [{ label: "Close", primary: true }], true);
}
