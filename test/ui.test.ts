import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

const get = async (path: string) => {
  const r = await env.ASSETS.fetch(new Request("https://x.example" + path));
  return { status: r.status, text: await r.text() };
};
/** The one outbound hyperlink: the maintainer credit in the sidebar (a normal link, never loaded as a resource). */
const MAINTAINER_LINK = "https://chandandigital.com/";
const FILES = ["/app.js", "/core.js", "/views-main.js", "/views-auth.js", "/i18n.js", "/generate-secrets.js"];

describe("dashboard static files", () => {
  it("serve the shell and every module", async () => {
    for (const p of ["/", "/style.css", "/favicon.svg", ...FILES]) expect((await get(p)).status, p).toBe(200);
  });
  it("comply with the strict CSP: no inline script or style anywhere", async () => {
    const html = (await get("/")).text;
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/); // loads nothing from other sites
    for (const f of FILES) {
      const js = (await get(f)).text.replaceAll(MAINTAINER_LINK, "");
      expect(js, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\(\s*["']style/);
      expect(js.replaceAll("http://www.w3.org/2000/svg", ""), f).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i); // only the SVG XML namespace is allowed
    }
  });
  it("links to the maintainer safely and nothing else leaves the site", async () => {
    const app = (await get("/app.js")).text;
    expect(app).toContain(`href: "${MAINTAINER_LINK}"`);
    expect(app).toMatch(/rel: "noopener noreferrer"/);
    expect(app).toContain("© 2026 Chandan Digital");
    expect(app).not.toMatch(/free-tier edition/);
    expect((await get("/i18n.js")).text).toContain("Nova Ads Console");
    expect((await get("/")).text).toContain("<title>Nova Ads Console</title>");
  });
  it("the secret generator page is static and makes no network calls", async () => {
    const html = (await get("/generate-secrets.html")).text;
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\sstyle=/i);
    const js = (await get("/generate-secrets.js")).text;
    expect(js).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|localStorage|WebSocket/);
    expect(js).toMatch(/crypto\.getRandomValues/);
  });
  it("does not store secrets in the browser", async () => {
    for (const f of FILES) {
      const js = (await get(f)).text;
      for (const m of js.matchAll(/(?:localStorage|sessionStorage)\.(?:set|get)Item|safeSet\(\s*["']([^"']+)/g)) expect(m[1] ?? "nodi.theme", f).toMatch(/^nodi\.(theme|lang)$|undefined|^$/);
    }
  });
});
