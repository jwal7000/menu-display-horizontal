/**
 * gcs.js — minimal Cloud Storage read/write using Application Default Credentials.
 *
 * Uses google-auth-library through the existing `googleapis` dependency, so no
 * new packages are needed (the Mac mini's node_modules keep working).
 * On Cloud Run the job's service account is picked up automatically.
 */

import { google } from 'googleapis';

let authClient;
async function accessToken() {
  if (!authClient) {
    authClient = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
    });
  }
  const token = await authClient.getAccessToken();
  return typeof token === 'string' ? token : token?.token;
}

/** Parses "gs://bucket/path/to/object" → { bucket, object } */
export function parseGsUrl(url) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(url);
  if (!m) throw new Error(`Not a gs:// URL: ${url}`);
  return { bucket: m[1], object: m[2] };
}

export async function readObject(url) {
  const { bucket, object } = parseGsUrl(url);
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`,
    { headers: { Authorization: `Bearer ${await accessToken()}` } },
  );
  if (!res.ok) throw new Error(`GCS read ${url} failed: HTTP ${res.status} ${await res.text()}`);
  return res.text();
}

export async function writeObject(url, body, contentType = 'application/json') {
  const { bucket, object } = parseGsUrl(url);
  const res = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(object)}`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': contentType },
      body,
    },
  );
  if (!res.ok) throw new Error(`GCS write ${url} failed: HTTP ${res.status} ${await res.text()}`);
}
