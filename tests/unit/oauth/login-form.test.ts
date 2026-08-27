import { describe, expect, it } from "vitest";

import { renderLoginForm } from "../../../src/oauth/login-form.js";

const STATE = {
  client_id: "client-1",
  redirect_uri: "https://example.test/cb",
  response_type: "code",
  scope: "mcp",
  state: "abc<>123",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  resource: "https://stellara.example.test/mcp",
  client_name: "Example Client",
  redirect_host: "example.test",
  localhost_redirect: false,
};

describe("renderLoginForm", () => {
  it("includes hidden inputs for every authorize-query field", () => {
    const view = renderLoginForm(STATE);
    expect(view).toContain('name="client_id"');
    expect(view).toContain('name="redirect_uri"');
    expect(view).toContain('name="response_type"');
    expect(view).toContain('name="scope"');
    expect(view).toContain('name="state"');
    expect(view).toContain('name="code_challenge"');
    expect(view).toContain('name="code_challenge_method"');
    expect(view).toContain('name="resource"');
    expect(view).toContain("Example Client");
    expect(view).toContain("example.test");
  });

  it("escapes special characters in propagated values", () => {
    const view = renderLoginForm(STATE);
    expect(view).toContain('value="abc&lt;&gt;123"');
    expect(view).not.toContain("abc<>123");
  });

  it("posts to /oauth/login", () => {
    const view = renderLoginForm(STATE);
    expect(view).toContain('action="/oauth/login"');
    expect(view).toContain('method="post"');
  });

  it("renders an inline error block when provided", () => {
    const view = renderLoginForm(STATE, { message: "Invalid token" });
    expect(view).toContain('class="error"');
    expect(view).toContain("Invalid token");
  });

  it("omits the error block when no error is supplied", () => {
    const view = renderLoginForm(STATE);
    expect(view).not.toContain('class="error"');
  });

  it("declares lang=en and CSP-friendly content (no external resources)", () => {
    const view = renderLoginForm(STATE);
    expect(view).toContain('lang="en"');
    expect(view).not.toContain("http://");
    // Inline style only; no <link> tags pulling external CSS.
    expect(view).not.toMatch(/<link[^>]+href=/i);
  });
});
