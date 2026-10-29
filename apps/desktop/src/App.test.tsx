import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { open } from '@tauri-apps/plugin-dialog';
import App from './App';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@crabnebula/tauri-plugin-drag', () => ({ startDrag: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

// Shaped like real daw-agent output: Boost's JSON writer turns every value into
// a string and empty arrays into "".
const daws = [
  { id: 'ableton', name: 'Ableton Live', installed: 'true', running: 'true', bridge_ready: 'true', executable: '/Applications/Ableton Live 12 Suite.app', supports_auto_import: 'true' },
  { id: 'ardour', name: 'Ardour', installed: 'true', running: 'false', bridge_ready: 'false', executable: '/opt/Ardour/bin/ardour9', supports_auto_import: 'true' },
  { id: 'logic', name: 'Logic Pro', installed: 'true', running: 'true', bridge_ready: 'false', executable: '/Applications/Logic Pro.app', supports_auto_import: 'false' },
];
const generation = {
  ok: 'true', id: 'song-2', title: 'Prototype Generation', prompt: 'berlin techno', bpm: '128', bars: '8',
  manifest_path: '/data/song-2/generation.json',
  assets: [
    { role: 'drums', name: 'Drums', url: '', local_path: '/data/song-2/drums.wav' },
    { role: 'bass', name: 'Bass', url: '', local_path: '/data/song-2/bass.wav' },
  ],
};
const songs = [
  { id: 'song-2', title: 'Prototype Generation', prompt: 'berlin techno', created_at: '1790000000', uploads: '' },
  { id: 'song-1', title: 'Prototype Generation', prompt: 'lofi house', created_at: '1780000000',
    uploads: [{ id: 'upload-1', filename: 'first mix.wav', size: '2097152' }] },
];

let responses: Record<string, unknown>;
const agentCalls = () => vi.mocked(invoke).mock.calls
  .filter(([command]) => command === 'agent_call')
  .map(([, payload]) => (payload as { args: string[] }).args);

beforeEach(() => {
  responses = {
    songs: { ok: 'true', user: { email: 'ana@example.com' }, songs },
    daws: { ok: 'true', daws },
    generate: generation,
    download: generation,
    import: { ok: 'true', queued: 'true' },
    upload: { ok: 'true', upload: { id: 'upload-2', filename: 'final.wav', size: '10' } },
    export: { ok: 'true', upload: { id: 'upload-3', filename: 'reaper-mix-20261029-120000.wav', size: '10' } },
    launch: { ok: 'true' },
    logout: { ok: 'true' },
    login: { ok: 'true', user: { email: 'ana@example.com' } },
  };
  vi.mocked(invoke).mockImplementation(async (command, payload) =>
    JSON.stringify(responses[command === 'agent_login' ? 'login' : (payload as { args: string[] }).args[0]]));
  // jsdom has no canvas; the drag preview only needs a data URL back.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, fillText() {} } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,stub');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const songRow = (prompt: string) => screen.getByText(prompt, { selector: 'small' }).closest('li')!;

async function renderWithOpenSong() {
  render(<App />);
  await screen.findByText('berlin techno', { selector: 'small' });
  fireEvent.click(within(songRow('berlin techno')).getByRole('button', { name: 'OPEN' }));
  await screen.findByText('Drums');
}

describe('signing in', () => {
  it('asks to sign in when there is no session, then shows the songs', async () => {
    responses.songs = { ok: 'false', auth_required: 'true', error: 'Sign in first.' };
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'demo' } });

    responses.songs = { ok: 'true', user: { email: 'ana@example.com' }, songs };
    fireEvent.click(screen.getByRole('button', { name: 'SIGN IN' }));
    expect(await screen.findByText('lofi house')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('agent_login', { email: 'ana@example.com', password: 'demo' });
    expect(screen.getByText(/ana@example.com ·/)).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('keeps the form and shows the reason when sign-in fails', async () => {
    responses.songs = { ok: 'false', auth_required: 'true', error: 'Sign in first.' };
    responses.login = { ok: 'false', auth_required: 'true', error: 'Invalid email or password' };
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'SIGN IN' }));
    expect(await screen.findByText(/Sign-in failed: Invalid email or password/)).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('signs out', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(agentCalls()).toContainEqual(['logout']);
  });
});

describe('songs', () => {
  it('lists the user\'s songs with their uploads, handling an empty list', async () => {
    render(<App />);
    await screen.findByText('lofi house');
    expect(within(songRow('lofi house')).getByText(/1 upload/)).toBeTruthy();
    expect(within(songRow('berlin techno')).getByText(/0 upload/)).toBeTruthy();
    cleanup();

    responses.songs = { ok: 'true', user: { email: 'ana@example.com' }, songs: '' };
    render(<App />);
    expect(await screen.findByText(/No songs yet/)).toBeTruthy();
  });

  it('opens a song by downloading its stems', async () => {
    await renderWithOpenSong();
    expect(agentCalls()).toContainEqual(['download', '--song', 'song-2']);
    expect(screen.getByText('Bass')).toBeTruthy();
    expect(songRow('berlin techno').className).toBe('current');
  });

  it('generates with the typed prompt, then refreshes the list', async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'berlin techno' } });
    const listLoads = agentCalls().filter(args => args[0] === 'songs').length;
    fireEvent.click(screen.getByRole('button', { name: 'GENERATE' }));
    expect(await screen.findByText('Drums')).toBeTruthy();
    expect(agentCalls()).toContainEqual(['generate', '--prompt', 'berlin techno']);
    await waitFor(() => expect(agentCalls().filter(args => args[0] === 'songs').length).toBe(listLoads + 1));
  });

  it('reports a failed generation instead of showing it', async () => {
    responses.generate = { ok: 'false', error: 'Connection refused' };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'GENERATE' }));
    expect(await screen.findByText(/Generation failed: Connection refused/)).toBeTruthy();
    expect(screen.queryByText('Drums')).toBeNull();
  });
});

describe('DAWs', () => {
  it('lists every DAW the agent reports with its state', async () => {
    render(<App />);
    expect(await screen.findByText('Ableton Live')).toBeTruthy();
    expect(screen.getByText('bridge ready')).toBeTruthy();
    expect(screen.getByText('bridge offline')).toBeTruthy();
    expect(screen.getByText('manual import only')).toBeTruthy();
    expect(screen.getByText(/Logic Pro has no import API/)).toBeTruthy();
    // Only the closed DAW offers to be opened.
    expect(screen.getByRole('button', { name: 'OPEN ARDOUR' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'OPEN LOGIC PRO' })).toBeNull();
  });

  it('launches a closed DAW', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'OPEN ARDOUR' }));
    await waitFor(() => expect(agentCalls()).toContainEqual(['launch', '--daw', 'ardour']));
  });
});

describe('import into the DAW', () => {
  it('imports the open song through the DAW whose bridge is ready', async () => {
    await renderWithOpenSong();
    fireEvent.click(await screen.findByRole('button', { name: 'IMPORT INTO ABLETON LIVE' }));
    expect(await screen.findByText(/Import queued — the stems should appear in Ableton Live/)).toBeTruthy();
    expect(agentCalls()).toContainEqual(['import', '--daw', 'ableton', '--manifest', generation.manifest_path]);
  });

  it('is unavailable while no bridge is ready', async () => {
    responses.daws = { ok: 'true', daws: daws.map(d => ({ ...d, bridge_ready: 'false' })) };
    await renderWithOpenSong();
    expect((screen.getByRole('button', { name: 'IMPORT INTO DAW' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No DAW bridge is ready/)).toBeTruthy();
  });

  it('shows the agent error when an import is refused', async () => {
    responses.import = { ok: 'false', queued: 'false', error: 'Bridge went offline' };
    await renderWithOpenSong();
    fireEvent.click(await screen.findByRole('button', { name: 'IMPORT INTO ABLETON LIVE' }));
    expect(await screen.findByText('Bridge went offline')).toBeTruthy();
    expect(screen.queryByText(/Import queued/)).toBeNull();
  });

  it('drags all stems, or a single one, out as files', async () => {
    await renderWithOpenSong();
    fireEvent.dragStart(screen.getByText('DRAG ALL STEMS INTO YOUR DAW'));
    expect(startDrag).toHaveBeenLastCalledWith({
      item: ['/data/song-2/drums.wav', '/data/song-2/bass.wav'],
      icon: 'data:image/png;base64,stub',
    });
    fireEvent.dragStart(screen.getByText('Bass').closest('.stem')!);
    expect(startDrag).toHaveBeenLastCalledWith({ item: ['/data/song-2/bass.wav'], icon: 'data:image/png;base64,stub' });
  });
});

describe('export to the API', () => {
  it('uploads the chosen mix to the open song and lists it', async () => {
    vi.mocked(open).mockResolvedValue('/mixes/final.wav');
    await renderWithOpenSong();
    responses.songs = { ok: 'true', user: { email: 'ana@example.com' }, songs: [
      { ...songs[0], uploads: [{ id: 'upload-2', filename: 'final.wav', size: '10' }] }, songs[1]] };

    fireEvent.click(screen.getByRole('button', { name: 'EXPORT MIX TO API' }));
    expect(await screen.findByText(/Uploaded final.wav to “Prototype Generation”/)).toBeTruthy();
    expect(agentCalls()).toContainEqual(['upload', '--song', 'song-2', '--file', '/mixes/final.wav']);
    expect(within(screen.getByRole('list', { name: 'Uploaded mixes' })).getByText('final.wav')).toBeTruthy();
    expect(vi.mocked(open).mock.calls[0][0]?.filters?.[0].extensions).toContain('wav');
  });

  it('does nothing when the file picker is cancelled', async () => {
    vi.mocked(open).mockResolvedValue(null);
    await renderWithOpenSong();
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT MIX TO API' }));
    expect(await screen.findByText('Export cancelled.')).toBeTruthy();
    expect(agentCalls().some(args => args[0] === 'upload')).toBe(false);
  });

  it('offers no render button without a dev-mode DAW', async () => {
    await renderWithOpenSong();
    expect(screen.queryByRole('button', { name: /^RENDER IN/ })).toBeNull();
  });

  it('renders in a dev-mode DAW and uploads the mix', async () => {
    responses.daws = { ok: 'true', daws: [...daws,
      { id: 'reaper', name: 'REAPER', installed: 'true', running: 'true', bridge_ready: 'true', executable: '/opt/REAPER/reaper',
        supports_auto_import: 'true', supports_render: 'true' }] };
    await renderWithOpenSong();
    fireEvent.click(await screen.findByRole('button', { name: 'RENDER IN REAPER & UPLOAD' }));
    expect(await screen.findByText(/Rendered in REAPER and uploaded reaper-mix-20261029-120000.wav/)).toBeTruthy();
    expect(agentCalls()).toContainEqual(['export', '--daw', 'reaper', '--song', 'song-2']);
  });

  it('shows why a render failed', async () => {
    responses.daws = { ok: 'true', daws: [
      { id: 'ardour', name: 'Ardour', installed: 'true', running: 'true', bridge_ready: 'true', executable: '',
        supports_auto_import: 'true', supports_render: 'true' }] };
    responses.export = { ok: 'false', error: 'The session is empty - nothing to render.' };
    await renderWithOpenSong();
    fireEvent.click(await screen.findByRole('button', { name: 'RENDER IN ARDOUR & UPLOAD' }));
    expect(await screen.findByText(/Export failed: The session is empty/)).toBeTruthy();
  });

  it('returns to sign-in when the session has expired', async () => {
    vi.mocked(open).mockResolvedValue('/mixes/final.wav');
    responses.upload = { ok: 'false', auth_required: 'true', error: 'Sign in required' };
    await renderWithOpenSong();
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT MIX TO API' }));
    expect(await screen.findByText(/Upload failed: Sign in required/)).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });
});
