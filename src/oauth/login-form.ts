/**
 * Inline HTML template for the OAuth login page (plan 0004 § Login-Form).
 *
 * Rendered by `GET /oauth/authorize` when no valid session cookie is present.
 * Submits to `POST /oauth/login`, which validates the supplied token against
 * `Config.tokens`, sets a session cookie and redirects back to `/oauth/authorize`
 * so the OAuth code-issuance can proceed.
 *
 * Keep this template self-contained — no external CSS, no JavaScript, no
 * third-party fonts. CSP-friendly by construction.
 */

/** Authorize-query fields the form must propagate as hidden inputs. */
export type LoginFormState = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource?: string;
  /** Display-only values sourced from authoritative client metadata. */
  client_name: string;
  redirect_host: string;
  localhost_redirect: boolean;
};

/** Optional UI feedback (e.g. „token did not match"). */
export type LoginFormError = {
  message: string;
};

/** Static inline stylesheet for the login page. */
const LOGIN_STYLES = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; background: Canvas; color: CanvasText; }
  main { width: min(360px, 92vw); padding: 1.5rem; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,0.08); background: Field; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; font-size: 0.9rem; margin: 0.75rem 0 0.25rem; }
  input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.5rem 0.75rem; border: 1px solid GrayText; border-radius: 6px; font: inherit; background: Canvas; color: CanvasText; }
  button { margin-top: 1rem; width: 100%; padding: 0.6rem; border: 0; border-radius: 6px; background: #2563eb; color: white; font: inherit; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .error { color: #b91c1c; margin: 0 0 0.75rem; font-size: 0.9rem; }
  .hint { color: GrayText; font-size: 0.8rem; margin-top: 0.75rem; }
`;

/** Renders the form body (hidden inputs, token field, submit button). */
function renderFormBody(state: LoginFormState): string {
  return `
    <form method="post" action="/oauth/login" autocomplete="off">
      ${renderHidden("client_id", state.client_id)}
      ${renderHidden("redirect_uri", state.redirect_uri)}
      ${renderHidden("response_type", state.response_type)}
      ${renderHidden("scope", state.scope)}
      ${renderHidden("state", state.state)}
      ${renderHidden("code_challenge", state.code_challenge)}
      ${renderHidden("code_challenge_method", state.code_challenge_method)}
      ${state.resource === undefined ? "" : renderHidden("resource", state.resource)}
      <label for="token">Stellara token</label>
      <input
        type="password"
        id="token"
        name="token"
        required
        minlength="32"
        autocomplete="current-password"
        aria-describedby="form-error"
      />
      <button type="submit">Sign in to Stellara</button>
    </form>`;
}

/**
 * Renders the login page. `error` is optional; when supplied it surfaces a
 * short inline message above the form. Every authorize-query parameter is
 * propagated as a hidden input so the POST submit can resume the flow with
 * identical state.
 */
export function renderLoginForm(state: LoginFormState, error?: LoginFormError): string {
  const errorBlock =
    error === undefined
      ? ""
      : `<p class="error" role="alert" id="form-error">${escapeHtml(error.message)}</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in to Stellara</title>
    <style>${LOGIN_STYLES}</style>
  </head>
  <body>
    <main>
      <h1>Sign in to Stellara</h1>
      <p><strong>${escapeHtml(state.client_name)}</strong> wants to connect.</p>
      <p class="hint">Redirect host: <code>${escapeHtml(state.redirect_host)}</code></p>
      ${state.localhost_redirect ? '<p class="error" role="alert">Warning: this client redirects to localhost.</p>' : ""}
      ${errorBlock}
      ${renderFormBody(state)}
      <p class="hint">Enter the value of your <code>STELLARA_TOKEN_&lt;USERID&gt;</code> environment variable.</p>
    </main>
  </body>
</html>`;
}

function renderHidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

/**
 * Minimal HTML-attribute escaping. Sufficient for our needs because every
 * field we render is already either client-controlled state we must echo
 * back (where escaping is mandatory) or developer-supplied static text.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
