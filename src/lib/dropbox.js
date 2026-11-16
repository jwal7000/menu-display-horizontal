/**
 * dropbox.js — the few Dropbox API calls the promo builder needs (read-only).
 *
 * Auth is an OAuth refresh token for a Dropbox app with the scopes
 * files.metadata.read and files.content.read (see cloudrun/README.md, "Dropbox promos").
 * Team folders live outside the member's home namespace, so when the account is on a
 * team every call is made relative to the team root (Dropbox-API-Path-Root).
 */

const API     = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

/** JSON for the Dropbox-API-Arg header: HTTP headers must be ASCII, so escape the rest. */
export function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export class DropboxError extends Error {
  constructor(status, summary) { super(`Dropbox ${status}: ${summary}`); this.status = status; this.summary = summary; }
}

/**
 * createDropbox({ app_key, app_secret, refresh_token }) → client with
 * listFolder(path) → [entries] | null (folder missing), thumbnail(path, format) → Buffer,
 * downloadText(path) → string.
 */
export function createDropbox({ app_key, app_secret, refresh_token }, { fetchFn = fetch } = {}) {
  let token = null;
  let pathRoot = null;   // header value, or '' when the home namespace is the root

  async function accessToken() {
    if (token) return token;
    const res = await fetchFn('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id: app_key, client_secret: app_secret }),
    });
    if (!res.ok) throw new DropboxError(res.status, `token refresh failed: ${(await res.text()).slice(0, 200)}`);
    token = (await res.json()).access_token;
    return token;
  }

  async function call(url, { arg, body, raw = false, rootless = false } = {}) {
    const headers = { Authorization: `Bearer ${await accessToken()}` };
    if (!rootless && pathRoot === null) await resolveRoot();
    if (!rootless && pathRoot) headers['Dropbox-API-Path-Root'] = pathRoot;
    if (arg !== undefined) headers['Dropbox-API-Arg'] = headerJson(arg);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchFn(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      let summary = text.slice(0, 300);
      try { summary = JSON.parse(text).error_summary || summary; } catch { /* not JSON */ }
      throw new DropboxError(res.status, summary);
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }

  async function resolveRoot() {
    const acct = await call(`${API}/users/get_current_account`, { body: null, rootless: true });
    const ri = acct.root_info || {};
    pathRoot = ri.root_namespace_id && ri.root_namespace_id !== ri.home_namespace_id
      ? JSON.stringify({ '.tag': 'root', root: ri.root_namespace_id })
      : '';
  }

  return {
    async listFolder(path) {
      let page;
      try {
        page = await call(`${API}/files/list_folder`, { body: { path, recursive: false, include_non_downloadable_files: false } });
      } catch (err) {
        if (err.status === 409 && /not_found/.test(err.summary)) return null;
        throw err;
      }
      const entries = [...page.entries];
      while (page.has_more) {
        page = await call(`${API}/files/list_folder/continue`, { body: { cursor: page.cursor } });
        entries.push(...page.entries);
      }
      return entries;
    },
    thumbnail(path, format) {
      return call(`${CONTENT}/files/get_thumbnail_v2`, {
        arg: { resource: { '.tag': 'path', path }, format, size: 'w2048h1536', mode: 'fitone_bestfit' },
        raw: true,
      });
    },
    async downloadText(path) {
      return (await call(`${CONTENT}/files/download`, { arg: { path }, raw: true })).toString('utf8');
    },
  };
}
