import { api, copyButton, field, guard, h, mount, state, t, toast } from "/core.js";

const frame = (rerender, ...kids) =>
  h("div", { class: "auth" }, h("div", { class: "card stack" },
    h("h1", {}, h("span", { class: "logo" }, "N"), t("appName")), ...kids));

/** Shows a freshly issued administrator credential exactly once. */
const showCredential = (root, rerender, credential, onDone) => {
  const saved = h("input", { type: "checkbox", id: "saved" });
  const go = h("button", { class: "primary", disabled: true, onclick: onDone }, t("continue"));
  saved.addEventListener("change", () => (go.disabled = !saved.checked));
  mount(root, frame(rerender,
    h("h2", {}, t("credentialTitle")),
    h("div", { class: "callout warn" }, t("credentialWarn")),
    h("div", { class: "secret-box", "data-testid": "credential" }, credential),
    h("div", { class: "row" }, copyButton(credential)),
    h("label", { class: "row checks" }, saved, t("credentialSaved")),
    go));
};

export const viewSetup = (root, rerender, afterAuth) => {
  const secret = h("input", { type: "password", autocomplete: "off", required: true, id: "setup-secret" });
  const form = h("form", { class: "stack", onsubmit: guard(async (e) => {
    e.preventDefault();
    const r = await api("POST", "/api/auth/setup", { setup_secret: secret.value });
    state.csrf = r.csrf; state.signedIn = true; state.needsSetup = false;
    showCredential(root, rerender, r.credential, afterAuth);
  }) }, field(t("setupSecret"), secret), h("button", { class: "primary", type: "submit" }, t("createAdmin")));
  mount(root, frame(rerender, h("h2", {}, t("setupTitle")), h("p", { class: "muted" }, t("setupIntro")), form));
};

export const viewLogin = (root, rerender, afterAuth, showRecover) => {
  const cred = h("input", { type: "password", autocomplete: "current-password", required: true, id: "credential", placeholder: "nodi_admin_…" });
  const form = h("form", { class: "stack", onsubmit: guard(async (e) => {
    e.preventDefault();
    const r = await api("POST", "/api/auth/login", { credential: cred.value.trim() });
    state.csrf = r.csrf; state.signedIn = true;
    afterAuth();
  }) }, field(t("credential"), cred), h("button", { class: "primary", type: "submit" }, t("signIn")),
  h("button", { class: "ghost", type: "button", onclick: showRecover }, t("lostCredential")));
  mount(root, frame(rerender, h("h2", {}, t("loginTitle")), form));
};

export const viewRecover = (root, rerender, afterAuth, back) => {
  const secret = h("input", { type: "password", autocomplete: "off", required: true, id: "recover-secret" });
  const confirm = h("input", { type: "text", autocomplete: "off", required: true, id: "recover-confirm", placeholder: "REPLACE CREDENTIAL" });
  const revoke = h("input", { type: "checkbox", checked: true, id: "recover-revoke" });
  const form = h("form", { class: "stack", onsubmit: guard(async (e) => {
    e.preventDefault();
    const r = await api("POST", "/api/auth/recover", { setup_secret: secret.value, confirmation: confirm.value, revoke_ai_tokens: revoke.checked });
    state.csrf = r.csrf; state.signedIn = true;
    showCredential(root, rerender, r.credential, afterAuth);
  }) }, field(t("setupSecret"), secret), field(t("recoverConfirm"), confirm),
  h("label", { class: "row checks" }, revoke, t("recoverRevoke")),
  h("div", { class: "row" }, h("button", { class: "danger", type: "submit" }, t("recoverButton")), h("button", { class: "ghost", type: "button", onclick: back }, t("back"))));
  mount(root, frame(rerender, h("h2", {}, t("recoverTitle")), h("div", { class: "callout info" }, t("recoverIntro")), form));
};

export { toast };
