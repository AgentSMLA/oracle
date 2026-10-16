const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

if (!requestUrl || !requestToken) {
  throw new Error("GitHub OIDC request credentials are missing; check id-token: write.");
}

const url = new URL(requestUrl);
url.searchParams.set("audience", "npm:registry.npmjs.org");
const identityResponse = await fetch(url, {
  headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
});
console.log(`GitHub OIDC response: HTTP ${identityResponse.status}`);
if (!identityResponse.ok) {
  throw new Error("GitHub did not issue an OIDC token.");
}
const { value: identityToken } = await identityResponse.json();
if (typeof identityToken !== "string" || !identityToken) {
  throw new Error("GitHub OIDC response did not contain a token.");
}

const claims = JSON.parse(Buffer.from(identityToken.split(".")[1], "base64url").toString());
console.log(
  JSON.stringify({
    repository: claims.repository,
    ref: claims.ref,
    workflow_ref: claims.workflow_ref,
    job_workflow_ref: claims.job_workflow_ref,
    environment: claims.environment ?? null,
    audience: claims.aud,
  }),
);

const exchange = await fetch(
  "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@steipete%2foracle",
  {
    method: "POST",
    headers: { Authorization: `Bearer ${identityToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  },
);
const result = await exchange.json();
console.log(`npm OIDC exchange: HTTP ${exchange.status}; token issued: ${Boolean(result.token)}`);
if (!exchange.ok || !result.token) {
  const message = String(result.message ?? result.error ?? "No registry error message")
    .replaceAll(identityToken, "[redacted]")
    .replaceAll(requestToken, "[redacted]");
  throw new Error(`npm rejected the OIDC exchange: ${message}`);
}
