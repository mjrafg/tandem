#!/usr/bin/env node
/**
 * A fake MCP resource server and OAuth authorization server, one of each per
 * MODE, all in one process under path prefixes — so one harness run exercises
 * every way Tandem can identify itself to a provider.
 *
 *   cimd      accepts a Client ID Metadata Document (the way ElevenLabs does);
 *             it FETCHES Tandem's document and checks the redirect against it
 *   dcr       dynamic client registration
 *   manual    neither: the operator must supply a client id ("manual-client")
 *   mismatch  its metadata names a different resource than it is reached at
 *   static    no OAuth at all: a fixed bearer token, the way most servers work
 *
 * It is strict on purpose: PKCE S256 is verified, the redirect and client must
 * match between authorize and token, the resource indicator must be present
 * and correct on every request, refresh tokens rotate (the old one dies on
 * use), and the authorization response carries iss.
 *
 * Control:  POST /_ctl/revoke-access?mode=M   invalidate every access token of M
 *           POST /_ctl/revoke-refresh?mode=M  invalidate every refresh token of M
 *           POST /_ctl/expires?s=N            expires_in for tokens issued next
 *           GET  /_state                      what the fake saw
 */
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2]);
const BASE = `http://127.0.0.1:${PORT}`;

const seen = { authorize: [], token: [], refreshes: {}, revoked: [], mcpTokens: [], cimdFetched: [], registered: [] };
const codes = new Map();
const access = new Map();
const refresh = new Map();
const registered = new Set();
let expiresIn = 3600;

const resourceOf = (m) => (m === 'mismatch' ? `${BASE}/r/elsewhere/mcp` : `${BASE}/r/${m}/mcp`);
const issuerOf = (m) => `${BASE}/as/${m}`;
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => r(s)); });

function issue(mode, resource, clientId) {
  const a = `at_${crypto.randomBytes(12).toString('hex')}`;
  const r = `rt_${crypto.randomBytes(12).toString('hex')}`;
  access.set(a, { mode, resource, clientId, exp: Date.now() + expiresIn * 1000 });
  refresh.set(r, { mode, resource, clientId });
  return { access_token: a, token_type: 'Bearer', expires_in: expiresIn, refresh_token: r, scope: 'tts voices' };
}

function asMetadata(mode) {
  const iss = issuerOf(mode);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    revocation_endpoint: `${iss}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    ...(mode === 'cimd' || mode === 'mismatch' ? { client_id_metadata_document_supported: true } : {}),
    ...(mode === 'dcr' ? { registration_endpoint: `${iss}/register` } : {}),
  };
}

async function authorize(mode, q, res) {
  const p = Object.fromEntries(q);
  seen.authorize.push({ mode, ...p });
  const bad = (why) => send(res, 400, { error: 'invalid_request', error_description: why });
  if (p.response_type !== 'code') return bad('response_type must be code');
  if (p.code_challenge_method !== 'S256' || !p.code_challenge) return bad('PKCE S256 required');
  if (p.resource !== resourceOf(mode)) return bad(`resource must be ${resourceOf(mode)}, got ${p.resource}`);
  if (!p.state || !p.redirect_uri || !p.client_id) return bad('state, redirect_uri and client_id are required');

  if (mode === 'cimd') {
    // a Client ID Metadata Document: fetch it, and hold the client to what it says
    let doc;
    try {
      const r = await fetch(p.client_id, { headers: { accept: 'application/json' } });
      seen.cimdFetched.push({ url: p.client_id, status: r.status, cookie: r.headers.get('set-cookie') });
      doc = await r.json();
    } catch (e) { return bad(`could not fetch the client metadata document: ${e.message}`); }
    if (doc.client_id !== p.client_id) return bad('the document names a different client_id');
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.includes(p.redirect_uri)) return bad('redirect_uri is not in the document');
  } else if (mode === 'dcr') {
    if (!registered.has(p.client_id)) return bad('unknown client');
  } else if (mode === 'manual') {
    if (p.client_id !== 'manual-client') return bad('unknown client');
  }

  const code = `c_${crypto.randomBytes(10).toString('hex')}`;
  codes.set(code, { mode, challenge: p.code_challenge, redirectUri: p.redirect_uri, clientId: p.client_id, resource: p.resource });
  const back = new URL(p.redirect_uri);
  back.searchParams.set('code', code);
  back.searchParams.set('state', p.state);
  back.searchParams.set('iss', issuerOf(mode));
  res.writeHead(302, { location: back.href });
  res.end();
}

function token(mode, form, res) {
  const f = Object.fromEntries(form);
  seen.token.push({ mode, grant_type: f.grant_type, resource: f.resource, client_id: f.client_id, hasVerifier: !!f.code_verifier });
  const refuse = (error, d) => send(res, 400, { error, error_description: d });
  if (f.resource !== resourceOf(mode)) return refuse('invalid_target', `resource must be ${resourceOf(mode)}`);

  if (f.grant_type === 'authorization_code') {
    const c = codes.get(f.code);
    codes.delete(f.code); // one use
    if (!c || c.mode !== mode) return refuse('invalid_grant', 'unknown code');
    if (b64url(crypto.createHash('sha256').update(f.code_verifier || '').digest()) !== c.challenge) return refuse('invalid_grant', 'PKCE verifier mismatch');
    if (f.redirect_uri !== c.redirectUri) return refuse('invalid_grant', 'redirect_uri mismatch');
    if (f.client_id !== c.clientId) return refuse('invalid_client', 'client mismatch');
    return send(res, 200, issue(mode, f.resource, f.client_id));
  }
  if (f.grant_type === 'refresh_token') {
    const r = refresh.get(f.refresh_token);
    if (!r || r.mode !== mode) return refuse('invalid_grant', 'refresh token is not valid');
    if (f.client_id !== r.clientId) return refuse('invalid_client', 'client mismatch');
    refresh.delete(f.refresh_token); // rotation: the old one dies on use
    seen.refreshes[mode] = (seen.refreshes[mode] || 0) + 1;
    return send(res, 200, issue(mode, f.resource, f.client_id));
  }
  return refuse('unsupported_grant_type', f.grant_type);
}

function mcp(mode, req, body, res) {
  const auth = String(req.headers.authorization || '');
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (mode === 'static') {
    // an ordinary server: one fixed key, and a plain challenge with no OAuth metadata
    if (t !== 'static-secret') return send(res, 401, { detail: 'invalid api key' }, { 'www-authenticate': 'Bearer' });
    return rpc(msgOf(body, res), res);
  }
  const a = access.get(t);
  if (!a || a.mode !== mode || a.exp < Date.now() || a.resource !== resourceOf(mode)) {
    return send(res, 401, { detail: 'OAuth bearer token required for the hosted MCP.' },
      { 'www-authenticate': `Bearer resource_metadata="${BASE}/prm/${mode}", scope="tts voices"` });
  }
  seen.mcpTokens.push(t);
  return rpc(msgOf(body, res), res);
}

function msgOf(body, res) {
  try { return JSON.parse(body); } catch { send(res, 400, { error: 'bad json' }); return null; }
}

function rpc(msg, res) {
  if (!msg) return;
  if (msg.id === undefined) return send(res, 202);
  const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  if (msg.method === 'tools/list') {
    return reply({ tools: [{ name: 'speak', description: 'Say something', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  }
  if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: `spoke: ${msg.params?.arguments?.text ?? ''}` }] });
  return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const path = url.pathname;
  const body = req.method === 'POST' ? await readBody(req) : '';
  let m;
  if (path === '/_state') return send(res, 200, seen);
  if (path === '/_ctl/expires') { expiresIn = Number(url.searchParams.get('s')); return send(res, 200, { ok: true }); }
  if (path === '/_ctl/revoke-access') { for (const [k, v] of access) if (v.mode === url.searchParams.get('mode')) access.delete(k); return send(res, 200, { ok: true }); }
  if (path === '/_ctl/revoke-refresh') { for (const [k, v] of refresh) if (v.mode === url.searchParams.get('mode')) refresh.delete(k); return send(res, 200, { ok: true }); }

  if ((m = path.match(/^\/prm\/(\w+)$/))) {
    return send(res, 200, { resource: resourceOf(m[1]), authorization_servers: [issuerOf(m[1])], scopes_supported: ['tts', 'voices'] });
  }
  // RFC 8414: the well-known segment goes between the host and the issuer's path
  if ((m = path.match(/^\/\.well-known\/oauth-authorization-server\/as\/(\w+)$/))) return send(res, 200, asMetadata(m[1]));
  if ((m = path.match(/^\/as\/(\w+)\/authorize$/))) return authorize(m[1], url.searchParams, res);
  if ((m = path.match(/^\/as\/(\w+)\/token$/))) return token(m[1], new URLSearchParams(body), res);
  if ((m = path.match(/^\/as\/(\w+)\/register$/))) {
    const id = `dcr_${crypto.randomBytes(6).toString('hex')}`;
    registered.add(id);
    seen.registered.push({ id, request: JSON.parse(body || '{}') });
    return send(res, 201, { client_id: id, token_endpoint_auth_method: 'none' });
  }
  if ((m = path.match(/^\/as\/(\w+)\/revoke$/))) {
    const f = Object.fromEntries(new URLSearchParams(body));
    seen.revoked.push({ mode: m[1], hint: f.token_type_hint, known: access.has(f.token) || refresh.has(f.token) });
    access.delete(f.token); refresh.delete(f.token);
    return send(res, 200);
  }
  if ((m = path.match(/^\/r\/(\w+)\/mcp$/))) return mcp(m[1], req, body, res);
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1');
