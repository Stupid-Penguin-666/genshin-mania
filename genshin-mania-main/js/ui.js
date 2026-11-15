/* ==========================================================================
   UI.JS
   Small shared helpers: toasts, modal open/close (with Escape + focus
   restore) and a promise-based confirm dialog. Replaces the blocking
   alert() / confirm() calls that used to be scattered through the app.

   Exposes a single global: window.UI
   ========================================================================== */

const UI = (() => {
  const openModals = [];

  function toast(message, type = "info", durationMs = 3200) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast--show"));
    setTimeout(() => {
      el.classList.remove("toast--show");
      setTimeout(() => el.remove(), 220);
    }, durationMs);
  }

  function openModal(el) {
    if (!el || !el.hidden) return;
    el._returnFocus = document.activeElement;
    el.hidden = false;
    openModals.push(el);
    const target = el.querySelector("[data-autofocus]") || el.querySelector("button, input, select");
    if (target) target.focus({ preventScroll: true });
  }

  function closeModal(el) {
    if (!el || el.hidden) return;
    el.hidden = true;
    const i = openModals.indexOf(el);
    if (i !== -1) openModals.splice(i, 1);
    const back = el._returnFocus;
    el._returnFocus = null;
    if (back && document.contains(back) && typeof back.focus === "function") back.focus({ preventScroll: true });
    el.dispatchEvent(new CustomEvent("modal-close"));
  }

  // Escape closes the top-most modal before anything else sees the key.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !openModals.length) return;
    e.preventDefault();
    e.stopPropagation();
    closeModal(openModals[openModals.length - 1]);
  }, true);

  // Click on the dimmed backdrop (not the panel) also closes.
  document.addEventListener("mousedown", (e) => {
    const top = openModals[openModals.length - 1];
    if (top && e.target === top && top.dataset.dismissable !== "false") closeModal(top);
  });

  function confirmDialog({ title, text, okLabel = t("common.ok"), cancelLabel = t("common.cancel"), danger = false }) {
    const modal = document.getElementById("confirm-modal");
    modal.querySelector("[data-role='title']").textContent = title;
    modal.querySelector("[data-role='text']").textContent = text;
    const ok = modal.querySelector("[data-role='ok']");
    const cancel = modal.querySelector("[data-role='cancel']");
    ok.textContent = okLabel;
    cancel.textContent = cancelLabel;
    ok.classList.toggle("btn--danger", danger);

    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        modal.removeEventListener("modal-close", onClose);
        closeModal(modal);
        resolve(value);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onClose = () => done(false);
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      modal.addEventListener("modal-close", onClose);
      openModal(modal);
      cancel.focus({ preventScroll: true });
    });
  }

  function keyLabel(code) {
    if (!code) return "?";
    if (code === "Semicolon") return ";";
    if (code === "Comma") return ",";
    if (code === "Period") return ".";
    if (code === "Slash") return "/";
    if (code === "Space") return "␣";
    return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "N");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str ?? "");
    return div.innerHTML;
  }

  return { toast, openModal, closeModal, confirm: confirmDialog, keyLabel, escapeHtml };
})();

window.UI = UI;
