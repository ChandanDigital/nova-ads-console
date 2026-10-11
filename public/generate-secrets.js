// Runs entirely in the browser. No network request is made and nothing is stored.
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const b64u = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

const fill = () => {
  document.getElementById("enc").textContent = b64(rand(32)); // 32 random bytes, base64
  document.getElementById("setup").textContent = b64u(rand(32)); // 256 bits, URL-safe
};
const copy = (id, btn) => async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById(id).textContent);
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1500);
  } catch {
    // Clipboard may be blocked; the text is selectable (click it once and press Ctrl+C).
  }
};
fill();
document.getElementById("again").addEventListener("click", fill);
document.getElementById("copy-enc").addEventListener("click", copy("enc", document.getElementById("copy-enc")));
document.getElementById("copy-setup").addEventListener("click", copy("setup", document.getElementById("copy-setup")));
