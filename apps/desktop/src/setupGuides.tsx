import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, Cancel01Icon, RefreshIcon, Tick02Icon } from '@hugeicons/core-free-icons';

/** Per-DAW, per-OS setup steps: how to start the DAW and switch on the Gaslab
 *  DAW Plugin. Menu paths were checked against each DAW's own menus/manual;
 *  keep them exact, they are what people search for on screen. */

export type Os = 'macos' | 'windows' | 'linux';
const OS_LABEL: Record<Os, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

export function currentOs(): Os {
  const agent = navigator.userAgent;
  return /Mac/.test(agent) ? 'macos' : /Win/.test(agent) ? 'windows' : 'linux';
}

/** What `daw-agent install-bridges` reports for one DAW. */
export type InstallResult = { daw: string; ok: string | boolean; detail: string; path: string };

const Menu = ({ children }: { children: ReactNode }) => <span className="font-medium text-white">{children}</span>;
const Path = ({ children }: { children: ReactNode }) =>
  <code className="break-all rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.78rem] text-white/80">{children}</code>;
const Key = ({ children }: { children: ReactNode }) =>
  <kbd className="rounded-md border border-white/15 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[0.72rem] text-white/80">{children}</kbd>;

type Step = { title: string; body: ReactNode };
type Guide = {
  platforms: Os[];
  intro: string;
  steps: (os: Os) => Step[];
  troubleshooting?: (os: Os) => ReactNode;
  /** Where the app installs the plugin when it can't report it (other OS tabs). Absent for drag-only DAWs. */
  pluginPath?: Partial<Record<Os, string>>;
};

const openTrackStep: Step = {
  title: 'Open one of your tracks here',
  body: 'Click Open on a track under Your tracks. Its stems appear below the list.',
};
const keepFilesNote = 'Your project refers to the stems where this app downloaded them, so keep that folder.';

const GUIDES: Record<string, Guide> = {
  ableton: {
    platforms: ['macos', 'windows'],
    intro: 'This app installs a small control surface script, the Gaslab DAW Plugin, into Live. Once it is selected, Import puts each stem of a track on its own audio track at Live’s playhead.',
    steps: os => [
      {
        title: 'Use Ableton Live 12.0.5 or newer',
        body: <>Older versions can’t load audio from a script. Check your version under <Menu>{os === 'macos' ? 'Live › About Live' : 'Help › About Live'}</Menu>.</>,
      },
      {
        title: 'Let this app install the plugin',
        body: 'It copies the Gaslab_DAW_Plugin folder into your User Library each time the app starts, and when this guide opens. Where it went is shown below.',
      },
      {
        title: 'Open — or restart — Live',
        body: 'Click Open next to Ableton Live in the sidebar, or start Live as usual. If Live was already running when the plugin was installed, quit and reopen it so it finds the plugin.',
      },
      {
        title: 'Select the control surface',
        body: <>Open <Menu>{os === 'macos' ? 'Live › Settings…' : 'Options › Settings…'}</Menu> (<Key>{os === 'macos' ? '⌘ ,' : 'Ctrl ,'}</Key>), go to the <Menu>Link, Tempo & MIDI</Menu> tab and choose <Menu>Gaslab_DAW_Plugin</Menu> in an empty Control Surface slot. Leave its Input and Output on None. Live remembers this for every Set.</>,
      },
      {
        title: 'Check the sidebar',
        body: 'Ableton Live shows Bridge ready within a few seconds. From then on, Import into Ableton Live puts a track’s stems at the playhead in Arrangement View.',
      },
    ],
    troubleshooting: () => <>Gaslab_DAW_Plugin not in the list? You may have moved your User Library (<Menu>Settings › Library</Menu>). Copy the <Path>Gaslab_DAW_Plugin</Path> folder from the location below into the <Path>Remote Scripts</Path> folder of your User Library, then restart Live.</>,
    pluginPath: {
      macos: '~/Music/Ableton/User Library/Remote Scripts/Gaslab_DAW_Plugin',
      windows: '%USERPROFILE%\\Documents\\Ableton\\User Library\\Remote Scripts\\Gaslab_DAW_Plugin',
    },
  },

  flstudio: {
    platforms: ['macos', 'windows'],
    intro: 'FL Studio doesn’t let other apps add audio to a project, so there is nothing to install: you drag the stems in.',
    steps: () => [
      { title: 'Open FL Studio', body: 'Click Open next to FL Studio in the sidebar, or start it as usual, and open the project you want the track in.' },
      openTrackStep,
      { title: 'Drag the stems onto the Playlist', body: <>Drag <Menu>Drag all stems into your DAW</Menu> — or a single stem — onto FL Studio’s Playlist. Each stem becomes an audio clip.</> },
    ],
    troubleshooting: () => keepFilesNote,
  },

  logic: {
    platforms: ['macos'],
    intro: 'Logic Pro doesn’t let other apps add audio to a project, so there is nothing to install: you drag the stems in.',
    steps: () => [
      { title: 'Open Logic Pro', body: 'Click Open next to Logic Pro in the sidebar, or start it from Applications, and open your project.' },
      openTrackStep,
      { title: 'Drag the stems into the Tracks area', body: <>Drag <Menu>Drag all stems into your DAW</Menu> onto the empty space below your tracks. When Logic asks how to add the files, choose <Menu>Create new tracks</Menu> — one track per stem.</> },
    ],
    troubleshooting: () => keepFilesNote,
  },

  ardour: {
    platforms: ['linux', 'macos', 'windows'],
    intro: 'This app installs a Lua script, the Gaslab DAW Plugin, into Ardour. You switch it on once in each session; Import then puts each stem on its own track at the playhead.',
    steps: () => [
      { title: 'Let this app install the plugin', body: 'It copies the script into Ardour’s scripts folder each time the app starts, and when this guide opens. Where it went is shown below.' },
      { title: 'Open Ardour and your session', body: 'Click Open next to Ardour in the sidebar, or start Ardour as usual, then open or create the session you want the stems in.' },
      {
        title: 'Switch the plugin on for this session',
        body: <>Choose <Menu>Edit › Lua Scripts › Script Manager</Menu>, open the <Menu>Action Hooks</Menu> tab, click <Menu>New Hook</Menu> and pick <Menu>Gaslab DAW Plugin</Menu>. Save the session: Ardour keeps the hook in it.</>,
      },
      { title: 'Check the sidebar', body: 'Ardour shows Bridge ready within a few seconds.' },
    ],
    troubleshooting: () => <>Still offline? Check that the hook is <Menu>Gaslab DAW Plugin</Menu> and not another script with a similar name. Ardour stores a copy of the hook inside each session, so after this app updates the plugin, select the hook, click <Menu>Remove</Menu> and add it again with <Menu>New Hook</Menu>.</>,
    pluginPath: {
      linux: '~/.config/ardour9/scripts/ai_daw_import_bridge.lua',
      macos: '~/Library/Preferences/Ardour9/scripts/ai_daw_import_bridge.lua',
      windows: '%LOCALAPPDATA%\\ardour9\\scripts\\ai_daw_import_bridge.lua',
    },
  },

  reaper: {
    platforms: ['linux', 'macos', 'windows'],
    intro: 'This app installs a ReaScript, the Gaslab DAW Plugin, and adds one line to REAPER’s startup script so it runs whenever REAPER starts. There is nothing to switch on.',
    steps: () => [
      { title: 'Let this app install the plugin', body: <>It copies the script into REAPER’s <Path>Scripts</Path> folder and adds a line that loads it to <Path>Scripts/__startup.lua</Path>. Your own startup code stays as it is.</> },
      { title: 'Open — or restart — REAPER', body: 'Click Open next to REAPER in the sidebar, or start it as usual. If REAPER was already running, restart it: the startup script only runs when REAPER starts.' },
      { title: 'Check the sidebar', body: 'REAPER shows Bridge ready within a few seconds. Import places each stem on a new track at the edit cursor.' },
    ],
    troubleshooting: () => <>Still offline? Open <Menu>Options › Show REAPER resource path in explorer/finder</Menu> and check that <Path>Scripts/__startup.lua</Path> has the line mentioning <Path>ai_daw_import_bridge.lua</Path>. A portable REAPER install uses its own resource folder: copy both files there.</>,
    pluginPath: {
      linux: '~/.config/REAPER/Scripts/ai_daw_import_bridge.lua',
      macos: '~/Library/Application Support/REAPER/Scripts/ai_daw_import_bridge.lua',
      windows: '%APPDATA%\\REAPER\\Scripts\\ai_daw_import_bridge.lua',
    },
  },
};

export function hasGuide(dawId: string) {
  return dawId in GUIDES;
}

/** The setup guide for one DAW, as a modal dialog in the Gaslab glass style. */
export function SetupGuide({ daw, onClose, installBridges }: {
  daw: { id: string; name: string };
  onClose: () => void;
  /** Runs install-bridges and returns its per-DAW results. */
  installBridges: () => Promise<InstallResult[]>;
}) {
  const guide = GUIDES[daw.id];
  const here = currentOs();
  const [os, setOs] = useState<Os>(guide.platforms.includes(here) ? here : guide.platforms[0]);
  const [install, setInstall] = useState<InstallResult | 'installing' | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const reinstall = async () => {
    setInstall('installing');
    try {
      const result = (await installBridges()).find(r => r.daw === daw.id);
      setInstall(result ?? { daw: daw.id, ok: false, detail: 'This build did not install it.', path: '' });
    } catch (e) {
      setInstall({ daw: daw.id, ok: false, detail: String(e), path: '' });
    }
  };

  useEffect(() => {
    dialog.current?.showModal();
    if (guide.pluginPath && guide.platforms.includes(here)) void reinstall();
  }, []);

  const installed = install !== null && install !== 'installing' ? install : null;
  const installedOk = installed !== null && (installed.ok === true || installed.ok === 'true');
  const path = os === here && installed?.path ? installed.path : guide.pluginPath?.[os];

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="setup-title"
      className="glass-panel m-auto w-[min(42rem,calc(100vw-2rem))] max-h-[calc(100vh-3rem)] overflow-hidden rounded-3xl bg-popover/95 p-0 text-white backdrop:bg-black/60 backdrop:backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-3rem)] flex-col">
        <div className="flex items-center justify-between gap-6 border-b border-white/[0.12] px-6 py-4">
          <h2 id="setup-title" className="text-[0.95rem] font-semibold tracking-tight">Set up {daw.name}</h2>
          <button aria-label="Close" onClick={() => dialog.current?.close()}
            className="focus-ring flex size-8 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/[0.06] hover:text-white">
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div role="group" aria-label="Operating system" className="inline-flex rounded-xl border border-white/10 bg-black/20 p-1">
            {guide.platforms.map(platform => (
              <button key={platform} aria-pressed={platform === os} onClick={() => setOs(platform)}
                className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium transition ${platform === os ? 'bg-white/[0.08] text-white' : 'text-white/50 hover:text-white'}`}>
                {OS_LABEL[platform]}{platform === here ? ' · this computer' : ''}
              </button>
            ))}
          </div>
          {!guide.platforms.includes(here) &&
            <p className="mt-3 text-xs text-white/45">{daw.name} doesn’t run on {OS_LABEL[here]}; these steps are for {guide.platforms.map(p => OS_LABEL[p]).join(' and ')}.</p>}

          <p className="mt-5 text-sm leading-6 text-white/60">{guide.intro}</p>

          <ol className="mt-5 space-y-4">
            {guide.steps(os).map((step, index) => (
              <li key={step.title} className="flex gap-3.5">
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/[0.08] text-xs font-semibold tabular-nums text-primary">
                  {index + 1}
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-sm font-semibold text-white">{step.title}</p>
                  <p className="mt-1 text-sm leading-6 text-white/60">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          {guide.troubleshooting &&
            <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-white/55">
              {guide.troubleshooting(os)}
            </div>}
        </div>

        {path && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.12] px-6 py-4">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/40">Plugin location</p>
            <p className="mt-1.5"><Path>{path}</Path></p>
            {os === here && install === 'installing' && <p className="mt-1.5 text-xs text-white/45">Installing…</p>}
            {os === here && installed && (installedOk
              ? <p className="mt-1.5 flex items-center gap-1.5 text-xs text-primary/80"><HugeiconsIcon icon={Tick02Icon} size={14} />Installed</p>
              : <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive"><HugeiconsIcon icon={Alert02Icon} size={14} />Could not install: {installed.detail}</p>)}
          </div>
          {os === here && <button onClick={reinstall} disabled={install === 'installing'}
            className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-sm font-medium text-white/65 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-50">
            <HugeiconsIcon icon={RefreshIcon} size={15} />Reinstall
          </button>}
        </div>}
      </div>
    </dialog>
  );
}
