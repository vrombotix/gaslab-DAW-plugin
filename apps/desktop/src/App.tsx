import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Asset = { role: string; name: string; local_path: string; url: string };
type Generation = {
  ok: boolean; id: string; title: string; prompt: string; bpm: string | number;
  bars: string | number; manifest_path: string; assets: Asset[];
};
type Daw = {
  id: string; name: string; installed: boolean | string; running: boolean | string;
  bridge_ready: boolean | string; executable: string;
};

const truthy = (v: boolean | string) => v === true || v === 'true';

async function agent(args: string[]) {
  const raw = await invoke<string>('agent_call', { args });
  return JSON.parse(raw);
}

export default function App() {
  const [prompt, setPrompt] = useState('Dark melodic techno with a driving bassline');
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [daws, setDaws] = useState<Daw[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Ready');

  const ardour = useMemo(() => daws.find(d => d.id === 'ardour'), [daws]);

  const refreshDaws = async () => {
    try {
      const result = await agent(['daws']);
      setDaws(result.daws ?? []);
    } catch (e) {
      setMessage(`Agent error: ${String(e)}`);
    }
  };

  useEffect(() => {
    refreshDaws();
    const timer = window.setInterval(refreshDaws, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const generate = async () => {
    setBusy(true);
    setMessage('Calling fake generation API and downloading stems…');
    try {
      const result = await agent(['generate', '--prompt', prompt]);
      setGeneration(result);
      setMessage('Generation complete — four stems downloaded locally.');
    } catch (e) {
      setMessage(`Generation failed: ${String(e)}`);
    } finally { setBusy(false); }
  };

  const launchArdour = async () => {
    setMessage('Launching Ardour…');
    try { await agent(['launch', '--daw', 'ardour']); await refreshDaws(); }
    catch (e) { setMessage(`Launch failed: ${String(e)}`); }
  };

  const importArdour = async () => {
    if (!generation) return;
    setBusy(true);
    setMessage('Sending generation to Ardour bridge…');
    try {
      const result = await agent(['import', '--daw', 'ardour', '--manifest', generation.manifest_path]);
      setMessage(result.ok ? 'Import queued — the stems should appear at Ardour’s playhead.' : result.error);
    } catch (e) {
      setMessage(`Import failed: ${String(e)}`);
    } finally { setBusy(false); }
  };

  return <main className="shell">
    <header>
      <div>
        <div className="eyebrow">AI → DAW framework / prototype 0.1</div>
        <h1>Generate once. Open anywhere.</h1>
        <p className="sub">Standalone AI generation UI with a native C++ DAW agent. Ardour is the first adapter.</p>
      </div>
      <div className="status-pill"><span className="dot" /> {message}</div>
    </header>

    <section className="grid">
      <div className="panel composer">
        <div className="panel-title"><span>01</span> Generation</div>
        <label>Prompt</label>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} />
        <div className="chips"><span>128 BPM</span><span>8 bars</span><span>4 stems</span><span>WAV</span></div>
        <button className="primary" disabled={busy} onClick={generate}>{busy ? 'WORKING…' : 'GENERATE'}</button>
      </div>

      <div className="panel daws">
        <div className="panel-title"><span>02</span> DAWs</div>
        <div className="daw-card">
          <div>
            <strong>Ardour</strong>
            <small>{ardour?.executable || 'Executable not detected yet'}</small>
          </div>
          <div className="badges">
            <i className={truthy(ardour?.installed ?? false) ? 'good' : ''}>{truthy(ardour?.installed ?? false) ? 'installed' : 'not found'}</i>
            <i className={truthy(ardour?.running ?? false) ? 'good' : ''}>{truthy(ardour?.running ?? false) ? 'running' : 'closed'}</i>
            <i className={truthy(ardour?.bridge_ready ?? false) ? 'good' : ''}>{truthy(ardour?.bridge_ready ?? false) ? 'bridge ready' : 'bridge offline'}</i>
          </div>
        </div>
        <div className="future">Ableton Live <span>adapter next</span></div>
        <div className="future">REAPER <span>adapter next</span></div>
        {!truthy(ardour?.running ?? false) && <button className="secondary" onClick={launchArdour}>OPEN ARDOUR</button>}
      </div>
    </section>

    <section className="panel result">
      <div className="panel-title"><span>03</span> Result</div>
      {!generation ? <div className="empty">No generation yet. The fake API will return four fixed demo stems.</div> : <>
        <div className="generation-head">
          <div><h2>{generation.title}</h2><p>{generation.prompt}</p></div>
          <div className="meta">{generation.bpm} BPM · {generation.bars} bars</div>
        </div>
        <div className="stems">
          {generation.assets.map((asset, index) => <div className="stem" key={asset.role}>
            <span className="stem-index">0{index + 1}</span>
            <strong>{asset.name}</strong>
            <div className="wave">▁▃▆▄▂▇▅▂▃▆▇▃▁▅▇▂▅▃▇▆▂▁▆▄</div>
            <small>{asset.local_path}</small>
          </div>)}
        </div>
        <button className="import" disabled={busy || !truthy(ardour?.bridge_ready ?? false)} onClick={importArdour}>
          IMPORT ALL STEMS INTO ARDOUR
        </button>
        {!truthy(ardour?.bridge_ready ?? false) && <p className="hint">Enable the supplied “AI DAW Import Bridge” Editor Hook in the open Ardour session first.</p>}
      </>}
    </section>
  </main>;
}
