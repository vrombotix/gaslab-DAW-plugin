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
const ableton = { id: 'ableton', name: 'Ableton Live', installed: 'true', running: 'true', bridge_ready: 'true', executable: '', supports_auto_import: 'true' };
const flStudio = { id: 'flstudio', name: 'FL Studio', installed: 'true', running: 'false', bridge_ready: 'false', executable: '', supports_auto_import: 'false' };
const logic = { id: 'logic', name: 'Logic Pro', installed: 'true', running: 'true', bridge_ready: 'false', executable: '', supports_auto_import: 'false' };
const stems = ['drums', 'bass', 'synth', 'vocals'].map(role => ({ role, name: role, filename: `${role}.wav`, url: '' }));
const songs = [
  { id: 'song-1', title: 'Night Drive', owner: 'ana@example.com', bpm: '124', created_at: '1790000000', assets: stems, uploads: '' },
  { id: 'song-2', title: 'Sunday Lofi', owner: 'ana@example.com', bpm: '86', created_at: '1780000000', assets: stems,
    uploads: [{ id: 'upload-1', filename: 'first mix.wav', size: '2097152' }] },
];
const downloaded = {
  ok: 'true', id: 'song-1', title: 'Night Drive', bpm: '124', bars: '8', manifest_path: '/data/song-1/generation.json',
  assets: [
    { role: 'drums', name: 'Drums', url: '', local_path: '/data/song-1/drums.wav' },
    { role: 'bass', name: 'Bass', url: '', local_path: '/data/song-1/bass.wav' },
  ],
};

let responses: Record<string, unknown>;
const agentCalls = () => vi.mocked(invoke).mock.calls
  .filter(([command]) => command === 'agent_call')
  .map(([, payload]) => (payload as { args: string[] }).args);
const calls = (command: string) => agentCalls().filter(args => args[0] === command);

beforeEach(() => {
  responses = {
    songs: { ok: 'true', user: { email: 'ana@example.com' }, songs },
    daws: { ok: 'true', daws: [ableton, flStudio, logic] },
    download: downloaded,
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

const trackRow = (title: string) => within(screen.getByRole('table')).getByText(title).closest('tr')!;
const noBridge = () => { responses.daws = { ok: 'true', daws: [{ ...ableton, bridge_ready: 'false' }, flStudio, logic] }; };

/** Signed in, with a track opened while no bridge is ready (so nothing is imported yet). */
async function renderWithOpenTrack() {
  noBridge();
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Night Drive' }));
  await screen.findByText('Drums');
  responses.daws = { ok: 'true', daws: [ableton, flStudio, logic] };
}

describe('signing in', () => {
  it('asks to sign in when there is no session, then lists the user\'s tracks', async () => {
    responses.songs = { ok: 'false', auth_required: 'true', error: 'Sign in first.' };
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'demo' } });

    responses.songs = { ok: 'true', user: { email: 'ana@example.com' }, songs };
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Night Drive')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('agent_login', { email: 'ana@example.com', password: 'demo' });
    expect(screen.getByText('ana@example.com')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('starts on the sign-in form without an error when there is no session yet', async () => {
    responses.songs = { ok: 'false', auth_required: 'true', error: 'Sign in first.' };
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    await waitFor(() => expect(calls('songs')).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the form and shows the reason when sign-in fails', async () => {
    responses.songs = { ok: 'false', auth_required: 'true', error: 'Sign in first.' };
    responses.login = { ok: 'false', auth_required: 'true', error: 'Invalid email or password' };
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Sign-in failed: Invalid email or password/)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('signs out', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(calls('logout')).toHaveLength(1);
  });
});

describe('your tracks', () => {
  it('lists the tracks the user owns, with no way to generate new ones', async () => {
    render(<App />);
    await screen.findByText('Night Drive');
    expect(within(trackRow('Night Drive')).getByText('124')).toBeTruthy();
    expect(within(trackRow('Night Drive')).getByText('4 stems')).toBeTruthy();
    expect(within(trackRow('Sunday Lofi')).getByText('1')).toBeTruthy(); // one uploaded mix
    expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /prompt/i })).toBeNull();
  });

  it('shows an empty list (sent by the agent as "")', async () => {
    responses.songs = { ok: 'true', user: { email: 'ana@example.com' }, songs: '' };
    render(<App />);
    expect(await screen.findByText(/You don’t own any tracks yet/)).toBeTruthy();
  });

  it('imports a track into the DAW whose bridge is ready in one click', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import Night Drive into Ableton Live' }));
    expect(await screen.findByText(/Import queued — “Night Drive” should appear in Ableton Live/)).toBeTruthy();
    expect(agentCalls()).toContainEqual(['download', '--song', 'song-1']);
    expect(agentCalls()).toContainEqual(['import', '--daw', 'ableton', '--manifest', downloaded.manifest_path]);
    expect(trackRow('Night Drive').getAttribute('aria-current')).toBe('true');
  });

  it('only downloads when no bridge is ready, so the stems can be dragged', async () => {
    noBridge();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Night Drive' }));
    expect(await screen.findByText(/is downloaded. Drag the stems into your DAW/)).toBeTruthy();
    expect(screen.getByText('Drums')).toBeTruthy();
    expect(calls('import')).toHaveLength(0);
    expect(screen.getByText(/No DAW bridge is ready/)).toBeTruthy();
  });

  it('reports a failed download instead of opening the track', async () => {
    responses.download = { ok: 'false', error: 'Song not found' };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import Night Drive into Ableton Live' }));
    expect(await screen.findByText(/Download failed: Song not found/)).toBeTruthy();
    expect(calls('import')).toHaveLength(0);
    expect(screen.queryByText('Drums')).toBeNull();
  });

  it('shows the agent error when the DAW refuses the import', async () => {
    responses.import = { ok: 'false', queued: 'false', error: 'Bridge went offline' };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import Night Drive into Ableton Live' }));
    expect(await screen.findByText(/Ableton Live import failed: Bridge went offline/)).toBeTruthy();
    expect(screen.queryByText(/Import queued/)).toBeNull();
  });

  it('drags all stems, or a single one, out as files', async () => {
    await renderWithOpenTrack();
    fireEvent.dragStart(screen.getByText('Drag all stems into your DAW'));
    expect(startDrag).toHaveBeenLastCalledWith({
      item: ['/data/song-1/drums.wav', '/data/song-1/bass.wav'],
      icon: 'data:image/png;base64,stub',
    });
    fireEvent.dragStart(screen.getByText('Bass').closest('li')!);
    expect(startDrag).toHaveBeenLastCalledWith({ item: ['/data/song-1/bass.wav'], icon: 'data:image/png;base64,stub' });
  });
});

describe('DAWs', () => {
  it('shows each DAW\'s state in words, not only color', async () => {
    responses.daws = { ok: 'true', daws: [ableton, flStudio, logic, { ...ableton, id: 'reaper', name: 'REAPER', bridge_ready: 'false' }] };
    render(<App />);
    expect(await screen.findByText('Bridge ready')).toBeTruthy();
    expect(screen.getByText('Bridge offline')).toBeTruthy();
    expect(screen.getByText('Drag only')).toBeTruthy();
    expect(screen.getByText('Running · drag only')).toBeTruthy();
  });

  it('launches a closed DAW', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open FL Studio' }));
    await waitFor(() => expect(agentCalls()).toContainEqual(['launch', '--daw', 'flstudio']));
    expect(screen.queryByRole('button', { name: 'Open Logic Pro' })).toBeNull(); // already running
  });
});

describe('export to the API', () => {
  it('uploads the chosen mix to the open track and lists it', async () => {
    vi.mocked(open).mockResolvedValue('/mixes/final.wav');
    await renderWithOpenTrack();
    responses.songs = { ok: 'true', user: { email: 'ana@example.com' }, songs: [
      { ...songs[0], uploads: [{ id: 'upload-2', filename: 'final.wav', size: '10' }] }, songs[1]] };

    fireEvent.click(screen.getByRole('button', { name: 'Export mix' }));
    expect(await screen.findByText(/Uploaded final.wav to “Night Drive”/)).toBeTruthy();
    expect(agentCalls()).toContainEqual(['upload', '--song', 'song-1', '--file', '/mixes/final.wav']);
    expect(within(screen.getByRole('list', { name: 'Uploaded mixes' })).getByText('final.wav')).toBeTruthy();
    expect(vi.mocked(open).mock.calls[0][0]?.filters?.[0].extensions).toContain('wav');
  });

  it('does nothing when the file picker is cancelled', async () => {
    vi.mocked(open).mockResolvedValue(null);
    await renderWithOpenTrack();
    fireEvent.click(screen.getByRole('button', { name: 'Export mix' }));
    expect(await screen.findByText('Export cancelled.')).toBeTruthy();
    expect(calls('upload')).toHaveLength(0);
  });

  it('offers no render button without a dev-mode DAW', async () => {
    await renderWithOpenTrack();
    expect(screen.queryByRole('button', { name: /^Render in/ })).toBeNull();
  });

  it('renders in a dev-mode DAW and uploads the mix', async () => {
    await renderWithOpenTrack();
    responses.daws = { ok: 'true', daws: [ableton,
      { id: 'reaper', name: 'REAPER', installed: 'true', running: 'true', bridge_ready: 'true', executable: '',
        supports_auto_import: 'true', supports_render: 'true' }] };
    fireEvent.click(await screen.findByRole('button', { name: 'Render in REAPER & upload' }, { timeout: 3000 }));
    expect(await screen.findByText(/Rendered in REAPER and uploaded reaper-mix-20261029-120000.wav/)).toBeTruthy();
    expect(agentCalls()).toContainEqual(['export', '--daw', 'reaper', '--song', 'song-1']);
  });

  it('returns to sign-in when the session has expired', async () => {
    vi.mocked(open).mockResolvedValue('/mixes/final.wav');
    responses.upload = { ok: 'false', auth_required: 'true', error: 'Sign in required' };
    await renderWithOpenTrack();
    fireEvent.click(screen.getByRole('button', { name: 'Export mix' }));
    expect(await screen.findByText(/Upload failed: Sign in required/)).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });
});
