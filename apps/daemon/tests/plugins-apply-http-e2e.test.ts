// Plan §8 e2e-2 (HTTP layer) — residual gap closed per OB-62444.
//
// plugins-dod-e2e.test.ts's "e2e-2 pure apply across runs" calls
// applyPlugin() directly against an in-memory DB; it never drives two
// consecutive applies through the actual HTTP route the daemon exposes
// (POST /api/plugins/:id/apply, apps/daemon/src/server.ts:6425). This file
// closes that gap at the HTTP layer, following the in-process startServer
// pattern from plugins-headless-run.test.ts.

import type http from 'node:http';
import Database from 'better-sqlite3';
import path from 'node:path';
import url from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'plugin-fixtures', 'sample-plugin');

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
});

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface SseEvent {
  kind: string;
  [key: string]: unknown;
}

async function readSseUntilSuccess(resp: Response): Promise<SseEvent | undefined> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const parsed = JSON.parse(dataLine.slice(5).trim()) as SseEvent;
      if (parsed.kind === 'success' || parsed.kind === 'error') return parsed;
    }
  }
  return undefined;
}

/** Count rows in applied_plugin_snapshots directly against the daemon's
 *  shared sqlite file (OD_DATA_DIR/app.sqlite, set process-wide by
 *  tests/setup.ts). This vitest worker runs test files serially
 *  (fileParallelism: false) but does not reset the DB between files, so
 *  this asserts a DELTA across the two apply calls, not an absolute count --
 *  other test files in the same run may already have written rows. */
function snapshotCount(): number {
  const dbFile = path.join(process.env.OD_DATA_DIR!, 'app.sqlite');
  const db = new Database(dbFile, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM applied_plugin_snapshots').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('Plan §8 e2e-2 (HTTP layer) — pure apply across runs via POST /api/plugins/:id/apply', () => {
  it('two consecutive HTTP applies share manifestSourceDigest and write no snapshot rows', async () => {
    const installResp = await fetch(`${baseUrl}/api/plugins/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ source: FIXTURE_DIR }),
    });
    expect(installResp.status).toBe(200);
    const installSuccess = await readSseUntilSuccess(installResp);
    expect(installSuccess?.plugin && (installSuccess.plugin as { id: string }).id).toBe('sample-plugin');

    const beforeSnapshots = snapshotCount();

    const applyOnce = () => fetch(`${baseUrl}/api/plugins/sample-plugin/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: { topic: 'design' } }),
    });

    const respA = await applyOnce();
    expect(respA.status).toBe(200);
    const bodyA = (await respA.json()) as { ok: boolean; manifestSourceDigest: string };

    const respB = await applyOnce();
    expect(respB.status).toBe(200);
    const bodyB = (await respB.json()) as { ok: boolean; manifestSourceDigest: string };

    expect(bodyA.ok).toBe(true);
    expect(bodyB.ok).toBe(true);
    expect(bodyA.manifestSourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyA.manifestSourceDigest).toBe(bodyB.manifestSourceDigest);

    // Purity invariant I2: the HTTP apply route itself writes no
    // applied_plugin_snapshots rows -- the resolver (a separate write path,
    // e.g. /api/projects or /api/runs) is the only writer.
    expect(snapshotCount()).toBe(beforeSnapshots);
  });
});
