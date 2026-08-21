import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, '..', 'assets');
const port = Number(process.env.PORT ?? 8787);

function json(res: any, status: number, data: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(data));
}

const stems = [
  ['drums', 'Drums', 'drums.wav'],
  ['bass', 'Bass', 'bass.wav'],
  ['synth', 'Synth', 'synth.wav'],
  ['vocals', 'Vocals', 'vocals.wav'],
] as const;

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, service: 'mock-api' });
  }

  if (req.method === 'POST' && req.url === '/v1/generations') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let prompt = 'Dark melodic techno';
      try { prompt = JSON.parse(body || '{}').prompt ?? prompt; } catch {}
      const id = `demo-${Date.now()}`;
      return json(res, 200, {
        id,
        title: 'Prototype Generation',
        prompt,
        bpm: 128,
        bars: 8,
        status: 'complete',
        assets: stems.map(([role, name, filename]) => ({
          role,
          name,
          filename,
          url: `/v1/assets/${filename}`,
        })),
      });
    });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/v1/assets/')) {
    const filename = req.url.split('/').pop() ?? '';
    if (!/^[a-z0-9_-]+\.wav$/i.test(filename)) return json(res, 400, { error: 'bad filename' });
    const path = join(assetsDir, filename);
    if (!existsSync(path)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': statSync(path).size,
      'access-control-allow-origin': '*',
    });
    return createReadStream(path).pipe(res);
  }

  return json(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => {
  console.log(`Mock AI API listening on http://127.0.0.1:${port}`);
});
