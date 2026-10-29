import { useEffect, useState, type ComponentProps, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { open } from '@tauri-apps/plugin-dialog';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight02Icon, CloudUploadIcon, DragDropIcon, LockPasswordIcon, Logout03Icon, Mail01Icon,
} from '@hugeicons/core-free-icons';

// daw-agent writes JSON with Boost.PropertyTree: every value arrives as a string
// ("true", "128") and an empty array arrives as "".
type Flag = boolean | string | undefined;
type Asset = { role: string; name: string; local_path: string; url: string };
type Generation = {
  ok: Flag; id: string; title: string; bpm: string | number;
  bars: string | number; manifest_path: string; assets: Asset[];
};
type Upload = { id: string; filename: string; size: string | number };
type Song = {
  id: string; title: string; bpm?: string | number; created_at: string | number;
  assets?: unknown[] | string; uploads?: Upload[] | string;
};
type Daw = {
  id: string; name: string; installed: Flag; running: Flag;
  bridge_ready: Flag; executable: string; supports_auto_import: Flag; supports_render?: Flag;
};
type AgentFailure = { error?: string; auth_required?: Flag };

const truthy = (v: Flag) => v === true || v === 'true';
const asList = <T,>(v: T[] | string | undefined): T[] => (Array.isArray(v) ? v : []);
const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(' ');
const AUDIO_EXTENSIONS = ['wav', 'aif', 'aiff', 'flac', 'mp3'];

// Button and input recipes from Gaslab Rights (components/ui/button.tsx, input.tsx).
const BUTTON = 'focus-ring inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2.5 text-sm font-medium whitespace-nowrap transition-all duration-200 ease-(--ease-snappy) select-none active:translate-y-px active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50';
const primaryButton = cx(BUTTON, 'bg-primary text-primary-foreground hover:bg-primary-bright');
const quietButton = cx(BUTTON, 'border-white/10 bg-white/[0.04] text-white/65 hover:bg-white/[0.08] hover:text-white');
const inputClassLg = 'h-12 w-full rounded-xl border border-white/12 bg-white/[0.045] px-4 pl-11 text-sm text-white outline-none transition placeholder:text-white/25 hover:border-white/20 focus:border-primary/55 focus:bg-primary/[0.025] focus:ring-4 focus:ring-primary/10';

async function agent(args: string[]) {
  const raw = await invoke<string>('agent_call', { args });
  return JSON.parse(raw);
}

// startDrag requires a PNG preview image; draw a small chip in the brand acid.
function dragPreview(label: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 180; canvas.height = 34;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#aaff00'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000'; ctx.font = '600 13px "Figtree Variable", sans-serif'; ctx.fillText(label, 12, 22);
  return canvas.toDataURL('image/png');
}

const GASLAB_LOGO_PATH =
  'M36.5195 1.08239C39.0194 -0.360796 41.5197 -0.360798 44.0195 1.08239C44.0195 1.08239 72.7193 13.886 78.8673 16.7405C80.8829 17.6763 80.1755 21.0229 77.9534 20.9953L40.2695 20.5277C26.5233 20.5277 15.3801 31.6712 15.3799 45.4174C15.3801 59.1636 26.5233 70.307 40.2695 70.307C51.6763 70.307 61.2902 62.6336 64.2324 52.1674H47.3945C43.8737 52.1674 41.0195 49.3132 41.0195 45.7924C41.0195 42.2715 43.8737 39.4174 47.3945 39.4174H74.5391C77.8528 39.4174 80.5391 42.1036 80.5391 45.4174V64.3382C80.5388 67.2245 79.2888 69.3892 76.7891 70.8324L44.0195 89.7533C41.5198 91.1963 39.0193 91.1963 36.5195 89.7533L3.75 70.8324C1.25025 69.3892 0.000252923 67.2245 0 64.3382V26.4974C0.000113426 23.611 1.25024 21.4466 3.75 20.0033L36.5195 1.08239Z';

function AppBrand() {
  return (
    <div className="flex items-center gap-3 px-3">
      <svg viewBox="-10 -8 101 107" aria-hidden="true" className="inline-block size-5 shrink-0 text-primary">
        <path d={GASLAB_LOGO_PATH} fill="currentColor" />
      </svg>
      <span className="min-w-0">
        <span className="block text-xl font-semibold leading-none tracking-tight text-white">Gaslab</span>
        <span className="mt-1 block text-[10px] font-medium uppercase tracking-[0.18em] text-white/35">DAW</span>
      </span>
    </div>
  );
}

/** The glass hexagon that marks one entry in a list (Rights' HexMarker). */
const HEX = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';
function HexMarker() {
  return (
    <span aria-hidden className="relative block h-4 w-3.5 shrink-0">
      <span className="absolute inset-0 bg-gradient-to-br from-primary-soft/70 via-primary/40 to-primary-deep/25" style={{ clipPath: HEX }} />
      <span className="absolute inset-[1px] bg-gradient-to-br from-primary/[0.20] to-primary/[0.04]" style={{ clipPath: HEX }} />
    </span>
  );
}

function Field({ id, label, icon, ...input }: { id: string; label: string; icon: typeof Mail01Icon } & ComponentProps<'input'>) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-white/80">{label}</label>
      <div className="group relative">
        <HugeiconsIcon icon={icon} size={18}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/35 transition-colors group-focus-within:text-primary" />
        <input id={id} className={inputClassLg} {...input} />
      </div>
    </div>
  );
}

function Notice({ notice }: { notice: { text: string; error: boolean } }) {
  if (!notice.text) return null;
  return notice.error
    ? <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">{notice.text}</p>
    : <p role="status" className="flex items-center gap-2 text-sm text-white/60">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />{notice.text}
      </p>;
}

function CardLabel({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/40">{children}</p>;
}

/** One word per DAW state, carried by a dot as well so it never depends on color alone. */
function dawState(daw: Daw): { label: string; lit: boolean } {
  if (!truthy(daw.supports_auto_import)) {
    return { label: truthy(daw.running) ? 'Running · drag only' : truthy(daw.installed) ? 'Drag only' : 'Not found', lit: false };
  }
  if (truthy(daw.bridge_ready)) return { label: 'Bridge ready', lit: true };
  return { label: truthy(daw.running) ? 'Bridge offline' : truthy(daw.installed) ? 'Closed' : 'Not found', lit: false };
}

export default function App() {
  const [user, setUser] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [daws, setDaws] = useState<Daw[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState({ text: 'Connecting to Gaslab…', error: false });
  const say = (text: string) => setNotice({ text, error: false });

  const signedOut = () => { setUser(null); setSongs([]); setGeneration(null); };

  // Shows an agent failure; an auth failure means the session is gone.
  const fail = (what: string, result: AgentFailure) => {
    if (truthy(result.auth_required)) signedOut();
    setNotice({ text: `${what}: ${result.error}`, error: true });
  };

  // Runs one user action: busy while it runs, any thrown error shown as the status.
  const act = async (status: string, action: () => Promise<void>) => {
    setBusy(true);
    say(status);
    try { await action(); }
    catch (e) { setNotice({ text: `Agent error: ${String(e)}`, error: true }); }
    finally { setBusy(false); }
  };

  // `signedOutIsNormal`: at startup, having no session just means showing the
  // sign-in form - only a session lost mid-use is worth an error.
  const refreshSongs = async (signedOutIsNormal = false) => {
    const result = await agent(['songs']);
    if (signedOutIsNormal && truthy(result.auth_required)) { signedOut(); say(''); return false; }
    if (!truthy(result.ok)) { fail('Could not load your tracks', result); return false; }
    setUser(result.user.email);
    setSongs(asList<Song>(result.songs));
    return true;
  };

  const refreshDaws = async () => {
    try {
      const result = await agent(['daws']);
      setDaws(result.daws ?? []);
    } catch (e) {
      setNotice({ text: `Agent error: ${String(e)}`, error: true });
    }
  };

  useEffect(() => {
    act('Connecting to Gaslab…', async () => { if (await refreshSongs(true)) say('Pick a track to bring it into your DAW.'); });
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
      if (await refreshSongs()) say(`Signed in as ${result.user.email}.`);
    });
  };

  const signOut = () => act('Signing out…', async () => {
    await agent(['logout']);
    signedOut();
    say('Signed out.');
  });

  const launchDaw = async (daw: Daw) => {
    say(`Launching ${daw.name}…`);
    try { await agent(['launch', '--daw', daw.id]); await refreshDaws(); }
    catch (e) { setNotice({ text: `Launch failed: ${String(e)}`, error: true }); }
  };

  // The first DAW whose bridge is listening; FL Studio and Logic Pro never qualify (drag only).
  const importTarget = daws.find(d => truthy(d.supports_auto_import) && truthy(d.bridge_ready));
  // Ardour and REAPER (dev builds only) can render their mix on request.
  const renderTarget = daws.find(d => truthy(d.supports_render) && truthy(d.bridge_ready));

  const sendToDaw = async (daw: Daw, track: Generation) => {
    say(`Sending “${track.title}” to ${daw.name}…`);
    const result = await agent(['import', '--daw', daw.id, '--manifest', track.manifest_path]);
    if (!truthy(result.ok)) return fail(`${daw.name} import failed`, result);
    say(`Import queued — “${track.title}” should appear in ${daw.name}.`);
  };

  // Clicking a track downloads its stems and, with a DAW bridge ready, imports them straight away.
  const bringIn = (song: Song, daw: Daw | undefined) => act(`Downloading “${song.title}”…`, async () => {
    const result = await agent(['download', '--song', song.id]);
    if (!truthy(result.ok)) return fail('Download failed', result);
    setGeneration(result);
    if (daw) return sendToDaw(daw, result);
    say(`“${song.title}” is downloaded. Drag the stems into your DAW.`);
  });

  const reimport = (daw: Daw, track: Generation) => act(`Sending “${track.title}” to ${daw.name}…`, () => sendToDaw(daw, track));

  const renderAndUpload = (daw: Daw, track: Generation) => act(`Rendering the mix in ${daw.name}…`, async () => {
    const result = await agent(['export', '--daw', daw.id, '--song', track.id]);
    if (!truthy(result.ok)) return fail('Export failed', result);
    await refreshSongs();
    say(`Rendered in ${daw.name} and uploaded ${result.upload.filename} to “${track.title}”.`);
  });

  // Ableton Live, FL Studio and Logic Pro can't be made to render from
  // outside, so the user bounces the mix and picks the file; it is uploaded
  // to the open track.
  const exportMix = (track: Generation) => act('Choose the mix you exported from your DAW…', async () => {
    const file = await open({
      title: 'Choose the mix you exported from your DAW',
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (!file) return say('Export cancelled.');
    say('Uploading your mix…');
    const result = await agent(['upload', '--song', track.id, '--file', file]);
    if (!truthy(result.ok)) return fail('Upload failed', result);
    await refreshSongs();
    say(`Uploaded ${result.upload.filename} to “${track.title}”.`);
  });

  // Native OS file drag, so the stems drop into any DAW like files from Finder/Explorer -
  // the only route into DAWs without an import API (FL Studio, Logic Pro).
  const dragOut = (e: DragEvent, paths: string[], label: string) => {
    e.preventDefault();
    startDrag({ item: paths, icon: dragPreview(label) }).catch(err => setNotice({ text: `Drag failed: ${String(err)}`, error: true }));
  };

  if (!user) {
    return <main className="grid min-h-svh bg-background text-white lg:grid-cols-[minmax(0,0.9fr)_minmax(32rem,1.1fr)]">
      <section className="relative flex min-h-svh flex-col px-10 py-8 lg:px-12">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_4%,color-mix(in_srgb,var(--primary)_9%,transparent),transparent_28%),radial-gradient(circle_at_85%_90%,color-mix(in_srgb,var(--primary)_4%,transparent),transparent_30%)]" />
        <header className="absolute left-3 top-5 z-10"><AppBrand /></header>
        <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 items-center py-12">
          <div className="w-full animate-fade-slide-up">
            <h1 className="max-w-sm text-4xl font-semibold leading-[1.05] tracking-[-0.035em]">Your tracks. In your DAW.</h1>
            <p className="mt-4 max-w-sm text-sm leading-6 text-white/50">
              Sign in with your Gaslab account to bring the tracks you own into Ableton Live, FL Studio or Logic Pro.
            </p>
            <form onSubmit={signIn} className="mt-7 flex flex-col gap-4">
              <Field id="email" label="Email address" icon={Mail01Icon} type="email" required autoFocus autoComplete="username"
                placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
              <Field id="password" label="Password" icon={LockPasswordIcon} type="password" required autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)} />
              <button type="submit" disabled={busy}
                className={cx(BUTTON, 'group/continue h-12 w-full rounded-xl bg-primary px-5 font-semibold text-black shadow-[0_12px_40px_-18px_color-mix(in_srgb,var(--primary)_80%,transparent)] hover:bg-primary-bright')}>
                <span>{busy ? 'Signing in…' : 'Sign in'}</span>
                {!busy && <HugeiconsIcon icon={ArrowRight02Icon} size={17} className="transition-transform group-hover/continue:translate-x-0.5" />}
              </button>
              <p className="text-xs text-white/35">Built-in mock API: any email, password <span className="font-mono text-white/55">demo</span>.</p>
            </form>
            {notice.error && <div className="mt-5"><Notice notice={notice} /></div>}
          </div>
        </div>
      </section>
      <aside className="relative hidden min-h-svh overflow-hidden border-l border-white/[0.08] bg-black lg:block">
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(70%_60%_at_70%_35%,color-mix(in_oklch,var(--primary)_22%,transparent),transparent_70%),radial-gradient(50%_40%_at_20%_90%,color-mix(in_oklch,var(--primary-deep)_18%,transparent),transparent_70%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.18),rgba(0,0,0,0.24)_52%,rgba(0,0,0,0.78))]" />
        <div className="absolute inset-x-0 bottom-0 z-10 p-10 xl:p-14">
          <p className="max-w-md border-l border-primary/50 pl-5 text-base leading-relaxed text-white/60 xl:text-lg">
            Every track you own on Gaslab, one click away from your DAW — and your mix one click back.
          </p>
        </div>
      </aside>
    </main>;
  }

  const uploads = asList(songs.find(s => s.id === generation?.id)?.uploads);

  return <div className="flex min-h-svh w-full bg-surface text-white">
    <aside className="sticky top-0 flex h-svh w-64 shrink-0 flex-col gap-6 border-r border-white/[0.07] bg-sidebar px-3 py-5">
      <AppBrand />
      <nav aria-label="DAWs" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <p className="column-label px-3 pb-1 text-white/35">DAWs</p>
        {daws.map(daw => {
          const state = dawState(daw);
          const target = daw.id === importTarget?.id;
          return <div key={daw.id} className={cx('relative flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm',
            target && 'liquid-glass border-white/[0.07] bg-[color-mix(in_oklch,var(--primary)_7%,rgb(0_0_0_/_20%))]')}>
            {/* A lit rail marks the DAW that imports go to. */}
            <span aria-hidden className={cx('absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary', !target && 'opacity-0')} />
            <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', state.lit ? 'bg-primary' : truthy(daw.running) ? 'bg-white/60' : 'ring-1 ring-white/30')} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-white">{daw.name}</span>
              <span className={cx('mt-0.5 block truncate text-xs', state.lit ? 'text-primary/80' : 'text-white/45')}>{state.label}</span>
            </span>
            {!truthy(daw.running) && truthy(daw.installed) &&
              <button className={cx(quietButton, 'h-7 px-2 text-xs')} aria-label={`Open ${daw.name}`} onClick={() => launchDaw(daw)}>Open</button>}
          </div>;
        })}
        {daws.length === 0 && <p className="px-3 text-xs text-white/40">No DAWs reported by the agent yet.</p>}
        <p className="mt-3 px-3 text-xs leading-5 text-white/35">
          FL Studio and Logic Pro have no import API — drag the stems from a track into them.
        </p>
      </nav>
      <div className="flex items-center gap-2.5 rounded-xl py-1.5 pl-3 pr-1.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[conic-gradient(from_210deg,var(--color-primary),#2dd4bf,#818cf8,var(--color-primary))] text-[0.7rem] font-bold text-black">
          {user.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{user}</span>
        <button aria-label="Sign out" title="Sign out" disabled={busy} onClick={signOut}
          className="focus-ring flex size-8 shrink-0 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/[0.06] hover:text-white">
          <HugeiconsIcon icon={Logout03Icon} size={16} />
        </button>
      </div>
    </aside>

    <main className="min-w-0 flex-1 overflow-y-auto bg-surface bg-[radial-gradient(60%_50%_at_10%_-5%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_70%),radial-gradient(45%_45%_at_95%_105%,color-mix(in_oklch,var(--primary)_7%,transparent),transparent_70%)]">
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <header>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-[-0.04em]">Your tracks</h1>
          <p className="mt-3 text-sm text-white/60">
            The tracks you own on Gaslab. {importTarget ? `Pick one to import it into ${importTarget.name}.` : 'Pick one to download its stems.'}
          </p>
        </header>
        <div className="mt-6"><Notice notice={notice} /></div>

        <section className="mt-8">
          {songs.length === 0 ? <p className="py-8 text-sm text-white/40">You don’t own any tracks yet.</p> :
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] text-left">
                  <th scope="col" className="column-label py-3 pr-4 font-semibold text-white/35">Track</th>
                  <th scope="col" className="column-label py-3 pr-4 text-right font-semibold text-white/35">BPM</th>
                  <th scope="col" className="column-label py-3 pr-4 font-semibold text-white/35">Added</th>
                  <th scope="col" className="column-label py-3 pr-4 text-right font-semibold text-white/35">Mixes</th>
                  <th scope="col" className="py-3"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {songs.map(song => {
                  const current = generation?.id === song.id;
                  return <tr key={song.id} aria-current={current ? 'true' : undefined}
                    className={cx('group transition-colors hover:bg-[color-mix(in_oklch,var(--primary)_5%,transparent)]',
                      current && 'bg-[color-mix(in_oklch,var(--primary)_7%,transparent)]')}>
                    <td className="max-w-md py-3 pr-4">
                      <span className="flex items-center gap-3">
                        <HexMarker />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-white group-hover:text-primary">{song.title}</span>
                          <span className="mt-0.5 block truncate text-xs text-white/40">{asList(song.assets).length} stems</span>
                        </span>
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums text-white/60">{song.bpm ?? '—'}</td>
                    <td className="py-3 pr-4 text-white/60">{new Date(Number(song.created_at) * 1000).toLocaleDateString()}</td>
                    <td className="py-3 pr-4 text-right tabular-nums text-white/60">{asList(song.uploads).length}</td>
                    <td className="py-3 text-right">
                      <button disabled={busy} onClick={() => bringIn(song, importTarget)}
                        aria-label={importTarget ? `Import ${song.title} into ${importTarget.name}` : `Open ${song.title}`}
                        className={cx(quietButton, importTarget && 'group-hover:border-transparent group-hover:bg-primary group-hover:text-primary-foreground')}>
                        {importTarget ? `Import into ${importTarget.name}` : 'Open'}
                      </button>
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>}
        </section>

        {generation && <section aria-labelledby="track-title" className="glass-panel mt-10 overflow-hidden rounded-3xl animate-fade-slide-up">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-white/[0.12] px-6 py-4">
            <h2 id="track-title" className="text-[0.95rem] font-semibold tracking-tight text-white">{generation.title}</h2>
            <p className="text-xs text-white/55">{generation.bpm} BPM · {generation.bars} bars · {generation.assets.length} stems</p>
          </div>
          <div className="px-6 py-5">
            <CardLabel>Stems</CardLabel>
            <ul className="mt-3 divide-y divide-white/[0.06] text-sm">
              {generation.assets.map(asset => <li key={asset.role} draggable title="Drag into your DAW"
                onDragStart={e => dragOut(e, [asset.local_path], asset.name)}
                className="group flex cursor-grab items-center gap-3 py-2.5 select-none">
                <HexMarker />
                <span className="w-24 shrink-0 font-medium text-white">{asset.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-white/35">{asset.local_path}</span>
                <HugeiconsIcon icon={DragDropIcon} size={16} className="shrink-0 text-white/30 transition-colors group-hover:text-primary" />
              </li>)}
            </ul>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button disabled={busy || !importTarget} onClick={() => importTarget && reimport(importTarget, generation)} className={primaryButton}>
                Import into {importTarget ? importTarget.name : 'DAW'}
              </button>
              <button disabled={busy} onClick={() => exportMix(generation)} className={quietButton}>
                <HugeiconsIcon icon={CloudUploadIcon} size={16} />Export mix
              </button>
              {renderTarget && <button disabled={busy} onClick={() => renderAndUpload(renderTarget, generation)} className={quietButton}>
                Render in {renderTarget.name} &amp; upload
              </button>}
              <div draggable role="button" tabIndex={-1}
                onDragStart={e => dragOut(e, generation.assets.map(a => a.local_path), `${generation.assets.length} stems`)}
                className={cx(quietButton, 'cursor-grab')}>
                <HugeiconsIcon icon={DragDropIcon} size={16} />Drag all stems into your DAW
              </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-white/40">
              {importTarget ? '' : 'No DAW bridge is ready: open Ableton Live with the AI_DAW_Bridge control surface active, or drag the stems in. '}
              To export, bounce your mix in the DAW first, then pick that file — it is uploaded to this track.
            </p>

            {uploads.length > 0 && <div className="mt-6">
              <CardLabel>Uploaded mixes</CardLabel>
              <ul aria-label="Uploaded mixes" className="mt-3 divide-y divide-white/[0.06]">
                {uploads.map(u => <li key={u.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                  <span className="min-w-0 truncate text-white/80">{u.filename}</span>
                  <span className="shrink-0 tabular-nums text-xs text-white/40">{(Number(u.size) / 1048576).toFixed(1)} MB</span>
                </li>)}
              </ul>
            </div>}
          </div>
        </section>}
      </div>
    </main>
  </div>;
}
