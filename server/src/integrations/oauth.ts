/**
 * OAuth sign-in for remote MCP servers, following the MCP authorization spec.
 *
 * A server that needs it answers 401 with `WWW-Authenticate: Bearer
 * resource_metadata="…"`. From there:
 *
 *   1. protected resource metadata (RFC 9728) names the authorization server
 *   2. authorization server metadata (RFC 8414 / OIDC) names its endpoints
 *   3. Tandem identifies itself, in the spec's order of preference:
 *        a client the operator registered by hand
 *        → a Client ID Metadata Document Tandem publishes about itself
 *        → dynamic client registration (RFC 7591)
 *        → otherwise ask the operator for a client id
 *   4. authorization code + PKCE S256 in the user's own browser, with the
 *      resource indicator (RFC 8707) binding the token to this one server
 *   5. tokens are stored encrypted in an `oauth` credential and refreshed
 *      before they expire; a server that rejects them again asks for sign-in
 *
 * What this refuses, and why:
 *   - a server whose metadata names a different resource than the one it was
 *     reached at. That check is what stops a malicious server pointing Tandem
 *     at another service's metadata and receiving a token meant for it; the
 *     operator is offered the canonical address instead of a silent rewrite.
 *   - an authorization server without PKCE S256, which the spec requires
 *   - an issuer that does not match the server named for it, and a callback
 *     whose `iss` does not match (RFC 9207 mix-up defence)
 *   - any OAuth endpoint that is not https, except loopback http for a server
 *     that is itself on loopback (local development and tests)
 *   - redirects on anything but a GET, and more than three of those
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Integration, McpIntegrationConfig } from '../../../shared/types';
import { createCredential, credentialSecret, getIntegration, replaceCredentialData, setOAuthRequired, updateIntegration } from './store';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_METADATA_BYTES = 256 * 1024;
const FLOW_TTL_MS = 10 * 60_000;
/** refresh this long before the stated expiry, so a call never races it */
const EXPIRY_SKEW_MS = 60_000;

export const CLIENT_METADATA_PATH = '/oauth/client-metadata.json';
export const CALLBACK_PATH = '/api/integrations/oauth/callback';

/** Thrown when a server wants a sign-in that does not exist (or no longer works). */
export class OAuthRequiredError extends Error {
  constructor(message = 'This MCP server needs you to sign in. Use "Sign in" on the integration.') {
    super(message);
    this.name = 'OAuthRequiredError';
  }
}

/** A sign-in that cannot proceed, with what the operator could do about it. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly extra: { needsClient?: boolean; canonicalUrl?: string; redirectUri?: string } = {},
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

// ---------------------------------------------------------------- policy

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** loopback http is allowed only when the MCP server itself is on loopback http */
function loopbackHttpAllowed(mcpUrl: string): boolean {
  try { const u = new URL(mcpUrl); return u.protocol === 'http:' && isLoopback(u.hostname); } catch { return false; }
}

function assertOAuthUrl(raw: string, allowLoopbackHttp: boolean, what: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new OAuthError(`${what} is not a valid address.`); }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && allowLoopbackHttp && isLoopback(u.hostname)) return u;
  throw new OAuthError(`${what} must use https (got ${u.protocol}//${u.host}).`);
}

/** scheme + host + port + path, lower-cased where the URL spec allows, no trailing slash */
function canonical(raw: string): string {
  const u = new URL(raw);
  const port = u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) ? `:${u.port}` : '';
  return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/+$/, '')}`;
}

async function oauthFetch(url: string, init: RequestInit, allowLoopbackHttp: boolean, what: string, hops = 0): Promise<Response> {
  assertOAuthUrl(url, allowLoopbackHttp, what);
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    .catch((err) => { throw new OAuthError(`${what} could not be reached: ${err instanceof Error ? err.message : String(err)}`); });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET') throw new OAuthError(`${what} redirected a ${method} request, which Tandem does not follow.`);
    if (hops >= 3) throw new OAuthError(`${what} redirected too many times.`);
    return oauthFetch(new URL(location, url).href, init, allowLoopbackHttp, what, hops + 1);
  }
  return res;
}

async function readJson(res: Response, what: string): Promise<any> {
  const text = await res.text();
  if (text.length > MAX_METADATA_BYTES) throw new OAuthError(`${what} returned more than ${MAX_METADATA_BYTES / 1024} KB.`);
  try { return JSON.parse(text); } catch { throw new OAuthError(`${what} did not return JSON (HTTP ${res.status}).`); }
}

// ---------------------------------------------------------------- WWW-Authenticate

export interface BearerChallenge {
  bearer: boolean;
  resourceMetadata: string | null;
  scope: string | null;
}

/** `Bearer resource_metadata="https://…", scope="a b"` → its parameters */
export function parseWwwAuthenticate(header: string | null): BearerChallenge {
  const none: BearerChallenge = { bearer: false, resourceMetadata: null, scope: null };
  if (!header || !/^\s*Bearer\b/i.test(header)) return none;
  const params: Record<string, string> = {};
  const re = /([A-Za-z0-9_.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header.replace(/^\s*Bearer\s*/i, '')))) params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return { bearer: true, resourceMetadata: params.resource_metadata || null, scope: params.scope || null };
}

// ---------------------------------------------------------------- discovery

export interface Discovery {
  /** the MCP server's canonical identifier — the token's audience */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  scopes: string[];
  /** the authorization server accepts a Client ID Metadata Document */
  metadataDocument: boolean;
  /** it puts `iss` on the authorization response (RFC 9207) */
  issParameter: boolean;
  tokenAuthMethods: string[];
}

/** Ask the server unauthenticated, so it says where its sign-in lives. */
async function probe(mcpUrl: string, allow: boolean): Promise<BearerChallenge> {
  const res = await oauthFetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tandem', version: '1' } } }),
  }, allow, 'The MCP server');
  await res.text().catch(() => undefined);
  if (res.status !== 401) throw new OAuthError(`The MCP server did not ask for a sign-in (it answered HTTP ${res.status}), so there is nothing to sign in to.`);
  return parseWwwAuthenticate(res.headers.get('www-authenticate'));
}

export async function discover(mcpUrl: string): Promise<Discovery> {
  const allow = loopbackHttpAllowed(mcpUrl);
  const server = assertOAuthUrl(mcpUrl, allow, 'The MCP server address');
  const challenge = await probe(mcpUrl, allow);

  // 1. protected resource metadata: where the server pointed, else the well-known paths
  const path = server.pathname.replace(/\/+$/, '');
  const prmCandidates = challenge.resourceMetadata
    ? [challenge.resourceMetadata]
    : [`${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`];
  let prm: any = null;
  for (const url of prmCandidates) {
    const res = await oauthFetch(url, { headers: { Accept: 'application/json' } }, allow, 'The protected resource metadata');
    if (res.ok) { prm = await readJson(res, 'The protected resource metadata'); break; }
    await res.text().catch(() => undefined);
  }
  if (!prm) throw new OAuthError('The MCP server asks for a sign-in but publishes no protected resource metadata, so its authorization server cannot be found.');
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((s: unknown) => typeof s === 'string') : [];
  if (servers.length === 0) throw new OAuthError('The protected resource metadata names no authorization server.');

  // The resource must be the server Tandem is actually talking to. This is the
  // check that stops a hostile server borrowing another service's metadata to
  // collect a token meant for that service.
  const resource = typeof prm.resource === 'string' && prm.resource ? prm.resource : mcpUrl;
  assertOAuthUrl(resource, allow, 'The resource in the protected resource metadata');
  if (canonical(resource) !== canonical(mcpUrl)) {
    throw new OAuthError(
      `This server identifies itself as ${resource}, not ${mcpUrl}. Tandem only signs in to the address a server names for itself, so use that address instead.`,
      { canonicalUrl: resource },
    );
  }

  // 2. authorization server metadata (RFC 8414, then OpenID Connect discovery)
  const issuerId: string = servers[0];
  const as = assertOAuthUrl(issuerId, allow, 'The authorization server');
  const asPath = as.pathname.replace(/\/+$/, '');
  const asCandidates = asPath
    ? [`${as.origin}/.well-known/oauth-authorization-server${asPath}`, `${as.origin}/.well-known/openid-configuration${asPath}`, `${as.origin}${asPath}/.well-known/openid-configuration`]
    : [`${as.origin}/.well-known/oauth-authorization-server`, `${as.origin}/.well-known/openid-configuration`];
  let meta: any = null;
  for (const url of asCandidates) {
    const res = await oauthFetch(url, { headers: { Accept: 'application/json' } }, allow, 'The authorization server metadata');
    if (res.ok) { meta = await readJson(res, 'The authorization server metadata'); break; }
    await res.text().catch(() => undefined);
  }
  if (!meta) throw new OAuthError(`The authorization server ${issuerId} publishes no metadata Tandem can read.`);
  if (typeof meta.issuer !== 'string' || canonical(meta.issuer) !== canonical(issuerId)) {
    throw new OAuthError(`The authorization server's metadata names a different issuer (${String(meta.issuer)}) than ${issuerId}.`);
  }
  if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    throw new OAuthError('The authorization server metadata has no authorization or token endpoint.');
  }
  assertOAuthUrl(meta.authorization_endpoint, allow, 'The authorization endpoint');
  assertOAuthUrl(meta.token_endpoint, allow, 'The token endpoint');
  const methods: string[] = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : [];
  if (!methods.includes('S256')) {
    throw new OAuthError('The authorization server does not support PKCE with S256, which MCP sign-in requires, so Tandem will not proceed.');
  }
  const optionalUrl = (v: unknown, what: string): string | null => {
    if (typeof v !== 'string' || !v) return null;
    assertOAuthUrl(v, allow, what);
    return v;
  };

  const scopes = challenge.scope
    ? challenge.scope.split(/\s+/).filter(Boolean)
    : Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((s: unknown) => typeof s === 'string') : [];

  return {
    resource,
    issuer: meta.issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: optionalUrl(meta.registration_endpoint, 'The registration endpoint'),
    revocationEndpoint: optionalUrl(meta.revocation_endpoint, 'The revocation endpoint'),
    scopes,
    metadataDocument: meta.client_id_metadata_document_supported === true,
    issParameter: meta.authorization_response_iss_parameter_supported === true,
    tokenAuthMethods: Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported : [],
  };
}

// ---------------------------------------------------------------- who Tandem is

/** The document a server reads when Tandem's client id is its URL. */
export function clientMetadataDocument(publicUrl: string): Record<string, unknown> {
  return {
    client_id: `${publicUrl}${CLIENT_METADATA_PATH}`,
    client_name: 'Tandem',
    client_uri: publicUrl,
    redirect_uris: [`${publicUrl}${CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

interface Client {
  clientId: string;
  clientSecret: string;
  source: 'manual' | 'metadata_document' | 'dynamic';
  authMethod: AuthMethod;
}

function secretMethod(d: Discovery): AuthMethod {
  // RFC 8414: absent means client_secret_basic
  if (d.tokenAuthMethods.length === 0) return 'client_secret_basic';
  return d.tokenAuthMethods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
}

async function chooseClient(
  d: Discovery, publicUrl: string, redirectUri: string, allow: boolean,
  manual: { clientId?: string; clientSecret?: string } | undefined,
  stored: Record<string, string> | null,
): Promise<Client> {
  // 1. one the operator registered by hand — just now, or on an earlier sign-in
  const manualId = manual?.clientId?.trim() || (stored?.clientSource === 'manual' ? stored.clientId : '');
  if (manualId) {
    const secret = manual?.clientId?.trim() ? (manual.clientSecret?.trim() ?? '') : (stored?.clientSecret ?? '');
    return { clientId: manualId, clientSecret: secret, source: 'manual', authMethod: secret ? secretMethod(d) : 'none' };
  }
  // 2. Tandem describes itself at a URL, and that URL is the client id
  const noneAllowed = d.tokenAuthMethods.length === 0 || d.tokenAuthMethods.includes('none');
  if (d.metadataDocument && noneAllowed && (publicUrl.startsWith('https://') || allow)) {
    return { clientId: `${publicUrl}${CLIENT_METADATA_PATH}`, clientSecret: '', source: 'metadata_document', authMethod: 'none' };
  }
  // 3. dynamic registration — reusing a client this server already issued Tandem
  if (d.registrationEndpoint) {
    if (stored?.clientSource === 'dynamic' && stored.clientId && stored.issuer === d.issuer && stored.redirectUri === redirectUri) {
      return { clientId: stored.clientId, clientSecret: stored.clientSecret ?? '', source: 'dynamic', authMethod: (stored.authMethod as AuthMethod) || 'none' };
    }
    const res = await oauthFetch(d.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Tandem', redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      }),
    }, allow, 'Client registration');
    const reg = await readJson(res, 'Client registration');
    if (!res.ok || typeof reg.client_id !== 'string') {
      throw new OAuthError(`The authorization server refused to register Tandem: ${reg.error_description ?? reg.error ?? `HTTP ${res.status}`}.`);
    }
    const secret = typeof reg.client_secret === 'string' ? reg.client_secret : '';
    const issued = reg.token_endpoint_auth_method as AuthMethod | undefined;
    return { clientId: reg.client_id, clientSecret: secret, source: 'dynamic', authMethod: issued ?? (secret ? secretMethod(d) : 'none') };
  }
  // 4. nothing automatic: the operator has to register Tandem with the provider
  throw new OAuthError(
    'This authorization server does not let apps identify themselves automatically. Register Tandem with the provider as an OAuth app, then enter the client id it gives you.',
    { needsClient: true, redirectUri },
  );
}

// ---------------------------------------------------------------- PKCE + the flow

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Pending {
  integrationId: string;
  verifier: string;
  redirectUri: string;
  client: Client;
  discovery: Discovery;
  createdAt: number;
}

/** In memory on purpose: a sign-in lives for minutes, and a restart just means clicking again. */
const pending = new Map<string, Pending>();

function sweepPending(now = Date.now()): void {
  for (const [state, p] of pending) if (now - p.createdAt > FLOW_TTL_MS) pending.delete(state);
}

function mcpConfig(integration: Integration): McpIntegrationConfig {
  const cfg = integration.config as McpIntegrationConfig;
  if (integration.type !== 'mcp' || cfg.transport !== 'http' || !cfg.url) {
    throw new OAuthError('OAuth sign-in applies to MCP servers reached over HTTP.');
  }
  return cfg;
}

/** Everything up to sending the user's browser to the provider. */
export async function startOAuth(
  integration: Integration, publicUrl: string, manual?: { clientId?: string; clientSecret?: string },
): Promise<{ authorizeUrl: string }> {
  const cfg = mcpConfig(integration);
  const allow = loopbackHttpAllowed(cfg.url!);
  const discovery = await discover(cfg.url!);
  const redirectUri = `${publicUrl}${CALLBACK_PATH}`;
  const current = integration.credentialId ? credentialSecret(integration.credentialId) : null;
  const stored = current?.type === 'oauth' ? current.data : null;
  const client = await chooseClient(discovery, publicUrl, redirectUri, allow, manual, stored);

  sweepPending();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(32));
  pending.set(state, { integrationId: integration.id, verifier, redirectUri, client, discovery, createdAt: Date.now() });

  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('resource', discovery.resource);
  if (discovery.scopes.length) url.searchParams.set('scope', discovery.scopes.join(' '));
  return { authorizeUrl: url.href };
}

function tokenRequestAuth(client: Client, body: URLSearchParams): Record<string, string> {
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    const enc = (s: string) => encodeURIComponent(s);
    return { Authorization: `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`).toString('base64')}` };
  }
  body.set('client_id', client.clientId);
  if (client.authMethod === 'client_secret_post' && client.clientSecret) body.set('client_secret', client.clientSecret);
  return {};
}

interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: number | null; scope?: string }

async function tokenRequest(tokenEndpoint: string, client: Client, body: URLSearchParams, allow: boolean): Promise<TokenSet> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...tokenRequestAuth(client, body),
  };
  const res = await oauthFetch(tokenEndpoint, { method: 'POST', headers, body: body.toString() }, allow, 'The token endpoint');
  const json = await readJson(res, 'The token endpoint');
  if (!res.ok) {
    const err = new OAuthError(`The provider refused: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}.`);
    (err as any).oauthCode = json.error;
    throw err;
  }
  if (typeof json.access_token !== 'string' || !json.access_token) throw new OAuthError('The provider returned no access token.');
  if (json.token_type && String(json.token_type).toLowerCase() !== 'bearer') {
    throw new OAuthError(`The provider issued a ${json.token_type} token; Tandem sends only Bearer tokens.`);
  }
  const ttl = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

/** The provider sent the browser back: check it is really our flow, then trade the code. */
export async function completeOAuth(q: Record<string, unknown>): Promise<{ integrationId: string }> {
  const state = typeof q.state === 'string' ? q.state : '';
  const p = state ? pending.get(state) : undefined;
  if (!p) throw new OAuthError('This sign-in is unknown or has already been used. Start it again from the integration.');
  pending.delete(state); // single use, whatever happens next
  if (Date.now() - p.createdAt > FLOW_TTL_MS) throw new OAuthError('This sign-in took too long and expired. Start it again.');
  if (typeof q.error === 'string' && q.error) {
    throw new OAuthError(`The provider did not complete the sign-in: ${typeof q.error_description === 'string' && q.error_description ? q.error_description : q.error}.`);
  }
  // RFC 9207: the response must come from the issuer this flow was started with
  const iss = typeof q.iss === 'string' ? q.iss : '';
  if (p.discovery.issParameter && !iss) throw new OAuthError('The sign-in response did not say which server issued it, so Tandem rejected it.');
  if (iss && canonical(iss) !== canonical(p.discovery.issuer)) {
    throw new OAuthError('The sign-in response came from a different authorization server than the one this sign-in was started with, so Tandem rejected it.');
  }
  const code = typeof q.code === 'string' ? q.code : '';
  if (!code) throw new OAuthError('The provider returned no authorization code.');

  const integrationUrl = p.discovery.resource;
  const allow = loopbackHttpAllowed(integrationUrl);
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier, resource: p.discovery.resource,
  });
  const tokens = await tokenRequest(p.discovery.tokenEndpoint, p.client, body, allow);

  const data: Record<string, string> = {
    clientId: p.client.clientId,
    clientSecret: p.client.clientSecret,
    clientSource: p.client.source,
    authMethod: p.client.authMethod,
    issuer: p.discovery.issuer,
    tokenEndpoint: p.discovery.tokenEndpoint,
    revocationEndpoint: p.discovery.revocationEndpoint ?? '',
    resource: p.discovery.resource,
    redirectUri: p.redirectUri,
    scope: tokens.scope ?? p.discovery.scopes.join(' '),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? '',
    expiresAt: tokens.expiresAt ? String(tokens.expiresAt) : '',
  };
  // the integration's existing OAuth credential is updated in place; anything
  // else it pointed at (a pasted API key, say) is left alone for the operator
  const integration = getIntegration(p.integrationId);
  if (!integration) throw new OAuthError('The integration was deleted while you were signing in.');
  const current = integration.credentialId ? credentialSecret(integration.credentialId) : null;
  if (current?.type === 'oauth' && integration.credentialId) {
    replaceCredentialData(integration.credentialId, data);
  } else {
    const cred = createCredential(`${integration.name} (OAuth)`, 'oauth', data);
    updateIntegration(integration.id, { credentialId: cred.id });
  }
  setOAuthRequired(integration.id, false);
  return { integrationId: integration.id };
}

// ---------------------------------------------------------------- tokens in use

const refreshing = new Map<string, Promise<string>>();

function clientFrom(data: Record<string, string>): Client {
  return {
    clientId: data.clientId, clientSecret: data.clientSecret ?? '',
    source: (data.clientSource as Client['source']) || 'manual', authMethod: (data.authMethod as AuthMethod) || 'none',
  };
}

/**
 * A usable access token for this credential, refreshed first when it is about
 * to expire (or when `force` says the server just rejected it). Concurrent
 * callers share one refresh: providers that rotate refresh tokens invalidate
 * the old one on use, so two refreshes racing would sign the user out.
 *
 * `rejected` is the token a server just refused. If a newer one is already
 * stored, another call refreshed in the meantime and this one only has to
 * retry with it — so any number of simultaneous 401s cost exactly one refresh.
 */
export async function oauthAccessToken(credentialId: string, rejected?: string): Promise<string> {
  const cred = credentialSecret(credentialId);
  if (!cred || cred.type !== 'oauth' || !cred.data.accessToken) throw new OAuthRequiredError();
  if (rejected !== undefined && cred.data.accessToken !== rejected) return cred.data.accessToken;
  const exp = Number(cred.data.expiresAt);
  const fresh = !Number.isFinite(exp) || exp <= 0 || Date.now() < exp - EXPIRY_SKEW_MS;
  if (fresh && rejected === undefined) return cred.data.accessToken;

  const inFlight = refreshing.get(credentialId);
  if (inFlight) return inFlight;
  const run = refresh(credentialId, cred.data).finally(() => refreshing.delete(credentialId));
  refreshing.set(credentialId, run);
  return run;
}

async function refresh(credentialId: string, data: Record<string, string>): Promise<string> {
  const signOut = (why: string): never => {
    replaceCredentialData(credentialId, { ...data, accessToken: '', refreshToken: '', expiresAt: '' });
    throw new OAuthRequiredError(why);
  };
  if (!data.refreshToken) signOut('The sign-in for this MCP server has expired. Sign in again.');
  const allow = loopbackHttpAllowed(data.resource);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refreshToken, resource: data.resource });
  let tokens: TokenSet;
  try {
    tokens = await tokenRequest(data.tokenEndpoint, clientFrom(data), body, allow);
  } catch (err) {
    // only a refusal ends the sign-in; a network failure should be retried
    if ((err as any)?.oauthCode === 'invalid_grant' || (err as any)?.oauthCode === 'invalid_client') {
      signOut('The provider no longer accepts this sign-in. Sign in again.');
    }
    throw err;
  }
  replaceCredentialData(credentialId, {
    ...data,
    accessToken: tokens.accessToken,
    // providers that rotate send a new one; keep the old one when they do not
    refreshToken: tokens.refreshToken ?? data.refreshToken,
    expiresAt: tokens.expiresAt ? String(tokens.expiresAt) : '',
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  });
  return tokens.accessToken;
}

/** Sign out: tell the provider (best effort), then forget the tokens but keep the client. */
export async function disconnectOAuth(integration: Integration): Promise<void> {
  const cred = integration.credentialId ? credentialSecret(integration.credentialId) : null;
  if (!cred || cred.type !== 'oauth' || !integration.credentialId) return;
  const d = cred.data;
  if (d.revocationEndpoint) {
    const allow = loopbackHttpAllowed(d.resource);
    for (const [token, hint] of [[d.refreshToken, 'refresh_token'], [d.accessToken, 'access_token']] as const) {
      if (!token) continue;
      const body = new URLSearchParams({ token, token_type_hint: hint });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...tokenRequestAuth(clientFrom(d), body) };
      await oauthFetch(d.revocationEndpoint, { method: 'POST', headers, body: body.toString() }, allow, 'The revocation endpoint')
        .then((r) => r.text()).catch(() => undefined);
    }
  }
  replaceCredentialData(integration.credentialId, { ...d, accessToken: '', refreshToken: '', expiresAt: '' });
}
