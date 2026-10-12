import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens, OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { call, issueToken, mcpCall, mcpTool, resetDb, setupAdmin, workerFetch, ORIGIN, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow } from "./flow";

const fake = new FakeGoogle();
let s: Session;
beforeEach(async () => {
  await resetDb();
  fake.reset();
  fake.install();
  s = await setupAdmin();
  await connectAndAllow(s, fake);
});
afterEach(() => fake.restore());

// The SDK client talks to the Worker in-process instead of over the network.
const inProcessFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  return workerFetch(req);
};

describe("remote MCP endpoint", () => {
  it("answers 401 with the OAuth discovery pointer when no credential is sent", async () => {
    const res = await workerFetch(new Request(ORIGIN + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  });
  it("rejects garbage, revoked and human-credential bearers", async () => {
    expect((await mcpCall("nova_api_" + "a".repeat(43), "tools/list")).status).toBe(401);
    expect((await mcpCall(s.credential!, "tools/list")).status).toBe(401);
    const t = await issueToken(s, ["read"]);
    const list = await call("/api/tokens", { session: s });
    await call(`/api/tokens/${list.json[0].id}`, { method: "DELETE", session: s });
    expect((await mcpCall(t, "tools/list")).status).toBe(401);
  });
  it("is stateless and refuses GET", async () => {
    const res = await workerFetch(new Request(ORIGIN + "/mcp", { method: "GET", headers: { authorization: "Bearer x" } }));
    expect([401, 405]).toContain(res.status);
  });
  it("publishes OAuth metadata (RFC 9728 / RFC 8414) requiring PKCE S256", async () => {
    const pr = (await call("/.well-known/oauth-protected-resource")).json;
    expect(pr.resource).toBe(`${ORIGIN}/mcp`);
    expect(pr.authorization_servers).toEqual([ORIGIN]);
    const as = (await call("/.well-known/oauth-authorization-server")).json;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(as.scopes_supported).toEqual(["read", "draft", "apply"]);
  });
});

describe("official MCP SDK client", () => {
  it("initialises, lists tools and calls one with a pasted API token", async () => {
    const token = await issueToken(s, ["read", "draft"]);
    const transport = new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: inProcessFetch as any, requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const n of ["search", "get_resource_metadata", "list_accessible_customers", "list_accounts", "get_performance", "audit_account", "create_campaign_plan", "validate_change_plan", "execute_authorised_plan"]) expect(names).toContain(n);
    expect(names.length).toBeGreaterThanOrEqual(35);
    for (const t of tools.tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
    const res: any = await client.callTool({ name: "list_accounts", arguments: {} });
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("succeeded");
    expect(body.data.accounts.map((a: any) => a.customer_id)).toEqual([CUSTOMER]);
    const status: any = await client.callTool({ name: "connection_status", arguments: {} });
    expect(JSON.parse(status.content[0].text).data.configured).toBe(true);
    await client.close();
  });

  it("tool annotations mark reads read-only and execution destructive", async () => {
    const token = await issueToken(s, ["read"]);
    const transport = new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), { fetch: inProcessFetch as any, requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.get_performance!.annotations?.readOnlyHint).toBe(true);
    expect(by.create_campaign_plan!.annotations?.readOnlyHint).toBe(false);
    expect(by.execute_authorised_plan!.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it("completes the full OAuth 2.1 flow (discovery, registration, PKCE, consent, token, refresh) with the SDK's own auth client", async () => {
    let saved: OAuthTokens | undefined;
    let info: OAuthClientInformationMixed | undefined;
    let verifier = "";
    let authUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() { return "http://localhost:8123/callback"; },
      get clientMetadata(): OAuthClientMetadata { return { client_name: "SDK test client", redirect_uris: ["http://localhost:8123/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "read draft" }; },
      clientInformation: () => info,
      saveClientInformation: (i) => { info = i; },
      tokens: () => saved,
      saveTokens: (t) => { saved = t; },
      redirectToAuthorization: (u) => { authUrl = u; },
      saveCodeVerifier: (v) => { verifier = v; },
      codeVerifier: () => verifier,
    };
    const serverUrl = ORIGIN + "/mcp";
    // 1) The client discovers the server, registers itself and is sent to the browser.
    const first = await auth(provider, { serverUrl, fetchFn: inProcessFetch as any, scope: "read draft" });
    expect(first).toBe("REDIRECT");
    expect(info?.client_id).toMatch(/^nova_c_/);
    expect(authUrl!.origin + authUrl!.pathname).toBe(ORIGIN + "/oauth/authorize");
    expect(authUrl!.searchParams.get("code_challenge_method")).toBe("S256");

    // 2) The browser lands on /oauth/authorize, which parks the request and sends the human to the dashboard consent screen.
    const authz = await workerFetch(new Request(authUrl!.toString(), { redirect: "manual" }));
    expect(authz.status).toBe(302);
    const consentId = authz.headers.get("location")!.replace("/#/consent/", "");
    // An AI token cannot read or decide the consent request.
    const aiToken = await issueToken(s, ["read", "draft", "apply"]);
    expect((await call(`/api/oauth/pending/${consentId}`, { headers: { authorization: "Bearer " + aiToken } })).status).toBe(403);
    // The signed-in human sees who is asking and for what, narrows the access, and approves.
    const pending = await call(`/api/oauth/pending/${consentId}`, { session: s });
    expect(pending.json.client.name).toBe("SDK test client");
    expect(pending.json.client.redirect_host).toBe("localhost:8123");
    expect(pending.json.requested_scopes).toEqual(["read", "draft"]);
    const decision = await call(`/api/oauth/pending/${consentId}/decision`, { method: "POST", session: s, body: { approve: true, scopes: ["read"], accounts: [CUSTOMER] } });
    const back = new URL(decision.json.redirect);
    expect(back.origin + back.pathname).toBe("http://localhost:8123/callback");

    // 3) The client trades the code for tokens.
    const second = await auth(provider, { serverUrl, authorizationCode: back.searchParams.get("code")!, fetchFn: inProcessFetch as any });
    expect(second).toBe("AUTHORIZED");
    expect(saved!.access_token).toMatch(/^nova_at_/);
    expect(saved!.refresh_token).toMatch(/^nova_rt_/);
    expect(saved!.scope).toBe("read"); // the human narrowed it

    // 4) The OAuth token works on /mcp with exactly the granted scope and account.
    const ok = await mcpTool(saved!.access_token, "list_accounts");
    expect(ok.body.data.accounts).toHaveLength(1);
    const denied = await mcpTool(saved!.access_token, "create_campaign_plan", { account_id: CUSTOMER, spec: {} });
    expect(denied.body.errors[0].code).toBe("forbidden");

    // 5) Refresh rotates; replaying the old refresh token cancels the whole grant.
    const refresh = (rt: string) => workerFetch(new Request(ORIGIN + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: info!.client_id }) }));
    const r1 = await refresh(saved!.refresh_token!);
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as OAuthTokens;
    expect(t2.refresh_token).not.toBe(saved!.refresh_token);
    const replay = await refresh(saved!.refresh_token!);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe("invalid_grant");
    expect((await mcpCall(t2.access_token, "tools/list")).status).toBe(401); // the grant was revoked
    expect((await mcpCall(saved!.access_token, "tools/list")).status).toBe(401);
  });
});

describe("OAuth server hardening", () => {
  const register = (body: unknown) => call("/oauth/register", { method: "POST", body });
  const newClient = async () => (await register({ client_name: "c", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).json.client_id as string;
  const pkce = async () => {
    const verifier = "v".repeat(60);
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
  };
  const startConsent = async (clientId: string, challenge: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", scope: "read", state: "xyz", resource: ORIGIN + "/mcp", ...extra });
    return workerFetch(new Request(`${ORIGIN}/oauth/authorize?${q}`, { redirect: "manual" }));
  };
  const approveAndGetCode = async (clientId: string, challenge: string) => {
    const r = await startConsent(clientId, challenge);
    const id = r.headers.get("location")!.replace("/#/consent/", "");
    const d = await call(`/api/oauth/pending/${id}/decision`, { method: "POST", session: s, body: { approve: true } });
    const u = new URL(d.json.redirect);
    expect(u.searchParams.get("state")).toBe("xyz");
    return u.searchParams.get("code")!;
  };
  const exchange = (body: Record<string, string>) => workerFetch(new Request(ORIGIN + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }));

  it("rejects insecure or dangerous redirect URIs at registration", async () => {
    for (const uri of ["http://evil.example/cb", "javascript:alert(1)", "https://x.example/cb#frag", "data:text/html,x", "not a url"]) {
      expect((await register({ redirect_uris: [uri] })).status, uri).toBe(400);
    }
    expect((await register({ redirect_uris: ["http://localhost:3000/cb"] })).status).toBe(201);
    expect((await register({ redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"] })).status).toBe(201);
  });
  it("authorize refuses unknown clients, unregistered redirects, missing PKCE and a foreign resource", async () => {
    const id = await newClient();
    const { challenge } = await pkce();
    expect((await startConsent("nova_c_unknown", challenge)).status).toBe(400);
    expect((await startConsent(id, challenge, { redirect_uri: "https://evil.example/cb" })).status).toBe(400);
    const noPkce = await startConsent(id, challenge, { code_challenge_method: "plain" });
    expect(noPkce.headers.get("location")).toContain("error=invalid_request");
    const wrongRes = await startConsent(id, challenge, { resource: "https://other.example/mcp" });
    expect(wrongRes.headers.get("location")).toContain("error=invalid_target");
    const wideScope = await startConsent(id, challenge, { scope: "read admin" });
    expect(wideScope.headers.get("location")).toContain("error=invalid_scope");
  });
  it("codes are single-use; a replay cancels the grant; wrong PKCE verifier and wrong redirect fail", async () => {
    const id = await newClient();
    const { verifier, challenge } = await pkce();
    const cb = "https://claude.ai/api/mcp/auth_callback";
    let code = await approveAndGetCode(id, challenge);
    expect((await exchange({ grant_type: "authorization_code", code, client_id: id, redirect_uri: cb, code_verifier: "w".repeat(60) })).status).toBe(400);
    expect((await exchange({ grant_type: "authorization_code", code, client_id: id, redirect_uri: "https://claude.ai/other", code_verifier: verifier })).status).toBe(400);
    const ok = await exchange({ grant_type: "authorization_code", code, client_id: id, redirect_uri: cb, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as any;
    expect((await mcpCall(tokens.access_token, "tools/list")).status).toBe(200);
    const replay = await exchange({ grant_type: "authorization_code", code, client_id: id, redirect_uri: cb, code_verifier: verifier });
    expect(replay.status).toBe(400);
    expect((await mcpCall(tokens.access_token, "tools/list")).status).toBe(401);
    code = "";
  });
  it("the authorization code is useless to another client", async () => {
    const a = await newClient();
    const b = await newClient();
    const { verifier, challenge } = await pkce();
    const code = await approveAndGetCode(a, challenge);
    expect((await exchange({ grant_type: "authorization_code", code, client_id: b, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier })).status).toBe(400);
  });
  it("denying consent returns access_denied and issues nothing", async () => {
    const id = await newClient();
    const { challenge } = await pkce();
    const r = await startConsent(id, challenge);
    const pid = r.headers.get("location")!.replace("/#/consent/", "");
    const d = await call(`/api/oauth/pending/${pid}/decision`, { method: "POST", session: s, body: { approve: false } });
    expect(d.json.redirect).toContain("error=access_denied");
    expect((await call(`/api/oauth/pending/${pid}`, { session: s })).status).toBe(410);
  });
  it("confidential clients must present their secret", async () => {
    const reg = (await register({ client_name: "conf", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" })).json;
    expect(reg.client_secret).toMatch(/^nova_cs_/);
    const { verifier, challenge } = await pkce();
    const code = await approveAndGetCode(reg.client_id, challenge);
    const base = { grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier };
    expect((await exchange({ ...base, client_secret: "wrong" })).status).toBe(401);
    expect((await exchange({ ...base, client_secret: reg.client_secret })).status).toBe(200);
  });
  it("the dashboard can list and revoke OAuth grants", async () => {
    const id = await newClient();
    const { verifier, challenge } = await pkce();
    const code = await approveAndGetCode(id, challenge);
    const tokens = (await (await exchange({ grant_type: "authorization_code", code, client_id: id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier })).json()) as any;
    const list = (await call("/api/tokens", { session: s })).json as any[];
    const entry = list.find((t) => t.kind === "oauth_access")!;
    expect(entry.scopes).toEqual(["read"]);
    await call(`/api/tokens/${entry.id}`, { method: "DELETE", session: s });
    expect((await mcpCall(tokens.access_token, "tools/list")).status).toBe(401);
  });
});
