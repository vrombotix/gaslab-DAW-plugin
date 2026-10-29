import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { open } from '@tauri-apps/plugin-dialog';

// daw-agent writes JSON with Boost.PropertyTree: every value arrives as a string
// ("true", "128") and an empty array arrives as "".
type Flag = boolean | string | undefined;
type Asset = { role: string; name: string; local_path: string; url: string };
type Generation = {
  ok: Flag; id: string; title: string; prompt: string; bpm: string | number;
  bars: string | number; manifest_path: string; assets: Asset[];
};
type Upload = { id: string; filename: string; size: string | number };
type Song = { id: string; title: string; prompt: string; created_at: string | number; uploads?: Upload[] | string };
type Daw = {
  id: string; name: string; installed: Flag; running: Flag;
  bridge_ready: Flag; executable: string; supports_auto_import: Flag; supports_render?: Flag;
};
type AgentFailure = { error?: string; auth_required?: Flag };

const truthy = (v: Flag) => v === true || v === 'true';
const asList = <T,>(v: T[] | string | undefined): T[] => (Array.isArray(v) ? v : []);
const AUDIO_EXTENSIONS = ['wav', 'aif', 'aiff', 'flac', 'mp3'];

async function agent(args: string[]) {
  const raw = await invoke<string>('agent_call', { args });
  return JSON.parse(raw);
}

// startDrag requires a PNG preview image; draw a small chip in the import button colours.
function dragPreview(label: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 180; canvas.height = 34;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#b9d9c0'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#101310'; ctx.font = 'bold 13px sans-serif'; ctx.fillText(label, 12, 22);
  return canvas.toDataURL('image/png');
}

export default function App() {
  const [user, setUser] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [prompt, setPrompt] = useState('Dark melodic techno with a driving bassline');
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [daws, setDaws] = useState<Daw[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Connecting to the API…');

  const signedOut = () => { setUser(null); setSongs([]); setGeneration(null); };

  // Shows an agent failure; an auth failure means the session is gone.
  const fail = (what: string, result: AgentFailure) => {
    if (truthy(result.auth_required)) signedOut();
    setMessage(`${what}: ${result.error}`);
  };

  // Runs one user action: busy while it runs, any thrown error shown as the status.
  const act = async (status: string, action: () => Promise<void>) => {
    setBusy(true);
    setMessage(status);
    try { await action(); }
    catch (e) { setMessage(`Agent error: ${String(e)}`); }
    finally { setBusy(false); }
  };

  const refreshSongs = async () => {
    const result = await agent(['songs']);
    if (!truthy(result.ok)) { fail('Could not load your songs', result); return false; }
    setUser(result.user.email);
    setSongs(asList<Song>(result.songs));
    return true;
  };

  const refreshDaws = async () => {
    try {
      const result = await agent(['daws']);
      setDaws(result.daws ?? []);
    } catch (e) {
      setMessage(`Agent error: ${String(e)}`);
    }
  };

  useEffect(() => {
    act('Connecting to the API…', async () => { if (await refreshSongs()) setMessage('Ready'); });
    refreshDaws();
    const timer = window.setInterval(refreshDaws, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    act('Signing in…', async () => {
      const result = JSON.parse(await invoke<string>('agent_login', { email, password }));
      if (!truthy(result.ok)) return fail('Sign-in failed', result);
      setPassword('');
      if (await refreshSongs()) setMessage(`Signed in as ${result.user.email}.`);
    });
  };

  const signOut = () => act('Signing out…', async () => {
    await agent(['logout']);
    signedOut();
    setMessage('Signed out.');
  });

  const generate = () => act('Generating and downloading stems…', async () => {
    const result = await agent(['generate', '--prompt', prompt]);
    if (!truthy(result.ok)) return fail('Generation failed', result);
    setGeneration(result);
    await refreshSongs();
    setMessage('Generation complete — stems downloaded locally.');
  });

  const openSong = (song: Song) => act(`Downloading “${song.title}”…`, async () => {
    const result = await agent(['download', '--song', song.id]);
    if (!truthy(result.ok)) return fail('Download failed', result);
    setGeneration(result);
    setMessage(`“${song.title}” is ready to import.`);
  });

  const launchDaw = async (daw: Daw) => {
    setMessage(`Launching ${daw.name}…`);
    try { await agent(['launch', '--daw', daw.id]); await refreshDaws(); }
    catch (e) { setMessage(`Launch failed: ${String(e)}`); }
  };

  // The first DAW whose bridge is listening; FL Studio and Logic Pro never qualify (drag only).
  const importTarget = daws.find(d => truthy(d.supports_auto_import) && truthy(d.bridge_ready));

  const importIntoDaw = (daw: Daw, song: Generation) => act(`Sending the stems to ${daw.name}…`, async () => {
    const result = await agent(['import', '--daw', daw.id, '--manifest', song.manifest_path]);
    setMessage(truthy(result.ok) ? `Import queued — the stems should appear in ${daw.name}.` : result.error);
  });

  // Ardour and REAPER (dev builds only) can render their mix on request.
  const renderTarget = daws.find(d => truthy(d.supports_render) && truthy(d.bridge_ready));

  const renderAndUpload = (daw: Daw, song: Generation) => act(`Rendering the mix in ${daw.name}…`, async () => {
    const result = await agent(['export', '--daw', daw.id, '--song', song.id]);
    if (!truthy(result.ok)) return fail('Export failed', result);
    await refreshSongs();
    setMessage(`Rendered in ${daw.name} and uploaded ${result.upload.filename} to “${song.title}”.`);
  });

  // Ableton Live, FL Studio and Logic Pro can't be made to render from
  // outside, so the user bounces the mix and picks the file; it is uploaded
  // to the open song.
  const exportMix = (song: Generation) => act('Choose the mix you exported from your DAW…', async () => {
    const file = await open({
      title: 'Choose the mix you exported from your DAW',
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (!file) return setMessage('Export cancelled.');
    setMessage('Uploading your mix…');
    const result = await agent(['upload', '--song', song.id, '--file', file]);
    if (!truthy(result.ok)) return fail('Upload failed', result);
    await refreshSongs();
    setMessage(`Uploaded ${result.upload.filename} to “${song.title}”.`);
  });

  // Native OS file drag, so the stems drop into any DAW like files from Finder/Explorer -
  // the only route into DAWs without an import API (FL Studio, Logic Pro).
  const dragOut = (e: DragEvent, paths: string[], label: string) => {
    e.preventDefault();
    startDrag({ item: paths, icon: dragPreview(label) }).catch(err => setMessage(`Drag failed: ${String(err)}`));
  };

  const uploads = asList(songs.find(s => s.id === generation?.id)?.uploads);

  return <main className="shell">
    <header>
      <div>
        <div className="eyebrow">AI → DAW framework / prototype 0.1</div>
        <h1>Generate once. Open anywhere.</h1>
        <p className="sub">Generate stems, import them into your DAW, and export your mix back to the API.</p>
      </div>
      <div className="header-side">
        <div className="status-pill" role="status"><span className="dot" /> {message}</div>
        {user && <div className="account">{user} · <button className="link" onClick={signOut} disabled={busy}>Sign out</button></div>}
      </div>
    </header>

    {!user ? <form className="panel sign-in" onSubmit={signIn}>
      <div className="panel-title"><span>00</span> Sign in</div>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" required value={password}
        onChange={e => setPassword(e.target.value)} />
      <button className="primary" disabled={busy}>SIGN IN</button>
      <p className="hint">Built-in mock API: any email, password <code>demo</code>.</p>
    </form> : <>
      <section className="grid">
        <div className="panel composer">
          <div className="panel-title"><span>01</span> Generation</div>
          <label htmlFor="prompt">Prompt</label>
          <textarea id="prompt" value={prompt} onChange={e => setPrompt(e.target.value)} />
          <div className="chips"><span>128 BPM</span><span>8 bars</span><span>4 stems</span><span>WAV</span></div>
          <button className="primary" disabled={busy} onClick={generate}>{busy ? 'WORKING…' : 'GENERATE'}</button>
        </div>

        <div className="panel daws">
          <div className="panel-title"><span>02</span> DAWs</div>
          {daws.map(daw => <div className="daw-card" key={daw.id}>
            <div>
              <strong>{daw.name}</strong>
              <small>{daw.executable || 'Executable not detected yet'}</small>
            </div>
            <div className="badges">
              <i className={truthy(daw.installed) ? 'good' : ''}>{truthy(daw.installed) ? 'installed' : 'not found'}</i>
              <i className={truthy(daw.running) ? 'good' : ''}>{truthy(daw.running) ? 'running' : 'closed'}</i>
              {truthy(daw.supports_auto_import)
                ? <i className={truthy(daw.bridge_ready) ? 'good' : ''}>{truthy(daw.bridge_ready) ? 'bridge ready' : 'bridge offline'}</i>
                : <i>manual import only</i>}
            </div>
            {!truthy(daw.running) && <button className="secondary" onClick={() => launchDaw(daw)}>OPEN {daw.name.toUpperCase()}</button>}
            {!truthy(daw.supports_auto_import) &&
              <p className="hint">{daw.name} has no import API — drag the stems from the song below into it.</p>}
          </div>)}
          {daws.length === 0 && <div className="empty">No DAW adapters reported by the agent yet.</div>}
        </div>
      </section>

      <section className="panel songs">
        <div className="panel-title"><span>03</span> My songs</div>
        {songs.length === 0 ? <div className="empty">No songs yet — generate your first one above.</div> :
          <ul className="song-list">
            {songs.map(song => <li key={song.id} className={generation?.id === song.id ? 'current' : ''}>
              <div>
                <strong>{song.title}</strong>
                <small>{song.prompt}</small>
              </div>
              <span className="meta">
                {new Date(Number(song.created_at) * 1000).toLocaleDateString()} · {asList(song.uploads).length} upload(s)
              </span>
              <button className="secondary" disabled={busy} onClick={() => openSong(song)}>OPEN</button>
            </li>)}
          </ul>}
      </section>

      <section className="panel result">
        <div className="panel-title"><span>04</span> Song</div>
        {!generation ? <div className="empty">Generate a song or open one from your list.</div> : <>
          <div className="generation-head">
            <div><h2>{generation.title}</h2><p>{generation.prompt}</p></div>
            <div className="meta">{generation.bpm} BPM · {generation.bars} bars</div>
          </div>
          <div className="stems">
            {generation.assets.map((asset, index) => <div className="stem" key={asset.role} draggable
              title="Drag into your DAW" onDragStart={e => dragOut(e, [asset.local_path], asset.name)}>
              <span className="stem-index">0{index + 1}</span>
              <strong>{asset.name}</strong>
              <div className="wave">▁▃▆▄▂▇▅▂▃▆▇▃▁▅▇▂▅▃▇▆▂▁▆▄</div>
              <small>{asset.local_path}</small>
            </div>)}
          </div>
          <div className="actions">
            <button className="import" disabled={busy || !importTarget}
              onClick={() => importTarget && importIntoDaw(importTarget, generation)}>
              IMPORT INTO {importTarget ? importTarget.name.toUpperCase() : 'DAW'}
            </button>
            <button className="export" disabled={busy} onClick={() => exportMix(generation)}>EXPORT MIX TO API</button>
          </div>
          {renderTarget && <button className="export render" disabled={busy}
            onClick={() => renderAndUpload(renderTarget, generation)}>
            RENDER IN {renderTarget.name.toUpperCase()} &amp; UPLOAD
          </button>}
          {!importTarget && <p className="hint">No DAW bridge is ready: open Ardour, REAPER or Ableton Live with its bridge active,
            or drag the stems in (FL Studio and Logic Pro only take a drag).</p>}
          <div className="drag-all" draggable
            onDragStart={e => dragOut(e, generation.assets.map(a => a.local_path), `${generation.assets.length} stems`)}>
            DRAG ALL STEMS INTO YOUR DAW
          </div>
          <p className="hint">To export, bounce your mix in the DAW first, then pick that file — it is uploaded to this song.</p>
          {uploads.length > 0 && <ul className="uploads" aria-label="Uploaded mixes">
            {uploads.map(u => <li key={u.id}>{u.filename}<small>{(Number(u.size) / 1048576).toFixed(1)} MB</small></li>)}
          </ul>}
        </>}
      </section>
    </>}
  </main>;
}
