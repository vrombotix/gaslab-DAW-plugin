// Embedded stand-in for the music backend, implementing schemas/api.md so the
// desktop app runs without any external service. Served on the port the C++
// daw-agent talks to by default (127.0.0.1:8787). Everything is in memory and
// resets when the app quits.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server};

struct Stem {
    role: &'static str,
    name: &'static str,
    filename: &'static str,
    bytes: &'static [u8],
}

const STEMS: &[Stem] = &[
    Stem { role: "drums", name: "Drums", filename: "drums.wav", bytes: include_bytes!("../assets/drums.wav") },
    Stem { role: "bass", name: "Bass", filename: "bass.wav", bytes: include_bytes!("../assets/bass.wav") },
    Stem { role: "synth", name: "Synth", filename: "synth.wav", bytes: include_bytes!("../assets/synth.wav") },
    Stem { role: "vocals", name: "Vocals", filename: "vocals.wav", bytes: include_bytes!("../assets/vocals.wav") },
];

/// Mock accounts: any email signs in with this password.
const DEMO_PASSWORD: &str = "demo";
/// The tracks (title, BPM) every mock account owns, newest first, all built
/// from the bundled demo stems. The real API returns the user's own tracks.
const DEMO_TRACKS: &[(&str, u32)] = &[("Night Drive", 124), ("Warehouse Pressure", 130), ("Sunday Lofi", 86)];
// ponytail: uploads live in memory, so cap them; the real API streams to storage.
const MAX_UPLOAD_BYTES: u64 = 500 * 1024 * 1024;
const UPLOAD_EXTENSIONS: &[&str] = &["wav", "aif", "aiff", "flac", "mp3"];

#[derive(Default)]
struct State {
    sessions: HashMap<String, String>,              // bearer token -> email
    songs: HashMap<String, Vec<Value>>,             // owner email -> songs, newest first
    uploads: HashMap<String, (String, Vec<u8>)>,    // upload id -> (owner email, bytes)
    counter: u64,
}

impl State {
    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}-{}", self.counter)
    }
}

type Reply = Response<Cursor<Vec<u8>>>;

/// Starts the embedded API on a background thread. Fire-and-forget:
/// a bind failure (e.g. port already in use) is logged, not fatal to the app.
pub fn spawn() {
    thread::spawn(|| match Server::http("127.0.0.1:8787") {
        Ok(server) => serve(server),
        Err(e) => eprintln!("mock_api: failed to bind 127.0.0.1:8787: {e}"),
    });
}

fn serve(server: Server) {
    let mut state = State::default();
    for mut request in server.incoming_requests() {
        let reply = route(&mut request, &mut state).with_header(header("Access-Control-Allow-Origin", "*"));
        let _ = request.respond(reply);
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn json_response(status: u16, body: Value) -> Reply {
    Response::from_data(body.to_string().into_bytes())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
}

fn error(status: u16, message: &str) -> Reply {
    json_response(status, json!({ "error": message }))
}

fn audio(bytes: Vec<u8>, content_type: &str) -> Reply {
    Response::from_data(bytes).with_header(header("Content-Type", content_type))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn route(request: &mut Request, state: &mut State) -> Reply {
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    let method = request.method().clone();

    match (&method, segments.as_slice()) {
        (Method::Options, _) => {
            return Response::from_data(Vec::new())
                .with_status_code(204)
                .with_header(header("Access-Control-Allow-Methods", "GET,POST,OPTIONS"))
                .with_header(header("Access-Control-Allow-Headers", "content-type,authorization"));
        }
        (Method::Get, ["health"]) => return json_response(200, json!({"ok": true, "service": "ai-daw-desktop"})),
        (Method::Post, ["v1", "auth", "login"]) => return login(&read_text(request), state),
        _ => {}
    }

    let Some(email) = authenticate(request, state) else {
        return error(401, "Sign in required");
    };
    match (&method, segments.as_slice()) {
        (Method::Get, ["v1", "songs"]) => json_response(200, json!({ "songs": state.songs.get(&email).cloned().unwrap_or_default() })),
        (Method::Get, ["v1", "songs", id]) => match find_song(state, &email, id) {
            Some(song) => json_response(200, song.clone()),
            None => error(404, "Song not found"),
        },
        (Method::Get, ["v1", "assets", filename]) => match STEMS.iter().find(|s| s.filename == *filename) {
            Some(stem) => audio(stem.bytes.to_vec(), "audio/wav"),
            None => error(404, "Not found"),
        },
        (Method::Post, ["v1", "songs", id, "uploads"]) => upload(request, state, &email, id, query),
        (Method::Get, ["v1", "uploads", id]) => match state.uploads.get(*id) {
            Some((owner, bytes)) if *owner == email => audio(bytes.clone(), "application/octet-stream"),
            _ => error(404, "Upload not found"),
        },
        _ => error(404, "Not found"),
    }
}

fn read_text(request: &mut Request) -> String {
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    body
}

fn authenticate(request: &Request, state: &State) -> Option<String> {
    let value = request.headers().iter().find(|h| h.field.equiv("Authorization"))?.value.as_str();
    state.sessions.get(value.strip_prefix("Bearer ")?).cloned()
}

fn find_song<'a>(state: &'a mut State, email: &str, id: &str) -> Option<&'a mut Value> {
    state.songs.get_mut(email)?.iter_mut().find(|s| s["id"] == id)
}

fn login(body: &str, state: &mut State) -> Reply {
    let credentials: Value = serde_json::from_str(body).unwrap_or_default();
    let email = credentials["email"].as_str().unwrap_or("").trim().to_lowercase();
    if !email.contains('@') || credentials["password"].as_str() != Some(DEMO_PASSWORD) {
        return error(401, "Invalid email or password");
    }
    // Mock-grade token: unique, not unguessable. The real API issues proper ones.
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let token = state.next_id(&format!("tok{nanos}"));
    state.sessions.insert(token.clone(), email.clone());
    if !state.songs.contains_key(&email) {
        let tracks = DEMO_TRACKS
            .iter()
            .enumerate()
            .map(|(days_old, &(title, bpm))| demo_track(state.next_id("song"), &email, title, bpm, days_old as u64))
            .collect();
        state.songs.insert(email.clone(), tracks);
    }
    json_response(200, json!({ "token": token, "user": { "email": email } }))
}

fn demo_track(id: String, owner: &str, title: &str, bpm: u32, days_old: u64) -> Value {
    let assets: Vec<Value> = STEMS
        .iter()
        .map(|s| json!({ "role": s.role, "name": s.name, "filename": s.filename, "url": format!("/v1/assets/{}", s.filename) }))
        .collect();
    json!({
        "id": id,
        "title": title,
        "owner": owner,
        "bpm": bpm,
        "bars": 8,
        "created_at": now_secs() - days_old * 86_400,
        "assets": assets,
        "uploads": [],
    })
}

fn upload(request: &mut Request, state: &mut State, email: &str, song_id: &str, query: &str) -> Reply {
    let filename = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("filename="))
        .and_then(percent_decode)
        .unwrap_or_default();
    if !is_safe_upload_name(&filename) {
        return error(400, "Upload needs a .wav, .aif, .aiff, .flac or .mp3 file name");
    }
    if find_song(state, email, song_id).is_none() {
        return error(404, "Song not found");
    }
    let mut bytes = Vec::new();
    if request.as_reader().take(MAX_UPLOAD_BYTES + 1).read_to_end(&mut bytes).is_err() || bytes.is_empty() {
        return error(400, "Upload is empty");
    }
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return error(413, "Upload is too large");
    }

    let id = state.next_id("upload");
    let entry = json!({
        "id": id,
        "filename": filename,
        "size": bytes.len(),
        "url": format!("/v1/uploads/{id}"),
        "created_at": now_secs(),
    });
    state.uploads.insert(id, (email.to_string(), bytes));
    if let Some(list) = find_song(state, email, song_id).and_then(|s| s["uploads"].as_array_mut()) {
        list.push(entry.clone());
    }
    json_response(200, json!({ "upload": entry }))
}

fn percent_decode(text: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut bytes = text.bytes();
    while let Some(b) = bytes.next() {
        match b {
            b'%' => {
                let hex = [bytes.next()?, bytes.next()?];
                out.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
            }
            b'+' => out.push(b' '),
            _ => out.push(b),
        }
    }
    String::from_utf8(out).ok()
}

fn is_safe_upload_name(name: &str) -> bool {
    let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase());
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.contains(['/', '\\'])
        && extension.is_some_and(|ext| UPLOAD_EXTENSIONS.contains(&ext.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::{SocketAddr, TcpStream};

    fn start() -> SocketAddr {
        let server = Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        thread::spawn(move || serve(server));
        addr
    }

    /// Minimal HTTP/1.0 client (the server closes the connection after each response).
    fn request(addr: SocketAddr, method: &str, path: &str, token: Option<&str>, body: &[u8]) -> (u16, Vec<u8>) {
        let mut stream = TcpStream::connect(addr).unwrap();
        let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        write!(stream, "{method} {path} HTTP/1.0\r\n{auth}Content-Length: {}\r\n\r\n", body.len()).unwrap();
        stream.write_all(body).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let status = std::str::from_utf8(&raw[9..12]).unwrap().parse().unwrap();
        let body_start = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        (status, raw[body_start..].to_vec())
    }

    fn json_request(addr: SocketAddr, method: &str, path: &str, token: Option<&str>, body: &str) -> (u16, Value) {
        let (status, bytes) = request(addr, method, path, token, body.as_bytes());
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn login(addr: SocketAddr, email: &str) -> String {
        let (status, body) = json_request(addr, "POST", "/v1/auth/login", None, &json!({"email": email, "password": "demo"}).to_string());
        assert_eq!(status, 200);
        body["token"].as_str().unwrap().to_string()
    }

    fn songs(addr: SocketAddr, token: &str) -> Vec<Value> {
        let (status, body) = json_request(addr, "GET", "/v1/songs", Some(token), "");
        assert_eq!(status, 200);
        body["songs"].as_array().unwrap().clone()
    }

    #[test]
    fn login_needs_an_email_and_the_demo_password() {
        let addr = start();
        let attempt = |email: &str, password: &str| {
            json_request(addr, "POST", "/v1/auth/login", None, &json!({"email": email, "password": password}).to_string())
        };
        assert_eq!(attempt("ana@example.com", "wrong").0, 401);
        assert_eq!(attempt("not-an-email", "demo").0, 401);
        let (status, body) = attempt(" Ana@Example.com ", "demo");
        assert_eq!(status, 200);
        assert_eq!(body["user"]["email"], "ana@example.com");
        assert!(body["token"].as_str().is_some_and(|t| !t.is_empty()));
    }

    #[test]
    fn everything_but_login_and_health_needs_a_valid_token() {
        let addr = start();
        assert_eq!(request(addr, "GET", "/health", None, b"").0, 200);
        assert_eq!(request(addr, "GET", "/v1/songs", None, b"").0, 401);
        assert_eq!(request(addr, "GET", "/v1/songs", Some("made-up"), b"").0, 401);
        assert_eq!(request(addr, "GET", "/v1/assets/drums.wav", None, b"").0, 401);
        assert_eq!(request(addr, "GET", "/v1/songs/song-1", None, b"").0, 401);
    }

    #[test]
    fn each_account_lists_only_the_tracks_it_owns() {
        let addr = start();
        let ana = login(addr, "ana@example.com");
        let bob = login(addr, "bob@example.com");
        let anas = songs(addr, &ana);
        let titles: Vec<&str> = anas.iter().map(|s| s["title"].as_str().unwrap()).collect();
        assert_eq!(titles, ["Night Drive", "Warehouse Pressure", "Sunday Lofi"]);
        assert!(anas.iter().all(|s| s["owner"] == "ana@example.com" && s["assets"].as_array().unwrap().len() == 4));
        assert!(anas.windows(2).all(|w| w[0]["created_at"].as_u64() > w[1]["created_at"].as_u64()), "newest first");

        let bobs = songs(addr, &bob);
        assert!(bobs.iter().all(|s| s["owner"] == "bob@example.com"));
        assert!(bobs.iter().all(|b| anas.iter().all(|a| a["id"] != b["id"])));

        let path = format!("/v1/songs/{}", anas[0]["id"].as_str().unwrap());
        assert_eq!(json_request(addr, "GET", &path, Some(&ana), "").1, anas[0]);
        assert_eq!(request(addr, "GET", &path, Some(&bob), b"").0, 404, "not Bob's track");
    }

    #[test]
    fn signing_in_again_keeps_the_same_tracks() {
        let addr = start();
        let first = songs(addr, &login(addr, "ana@example.com"));
        assert_eq!(songs(addr, &login(addr, "ana@example.com")), first);
    }

    #[test]
    fn serves_each_stem_as_wav() {
        let addr = start();
        let token = login(addr, "ana@example.com");
        for stem in STEMS {
            let (status, body) = request(addr, "GET", &format!("/v1/assets/{}", stem.filename), Some(&token), b"");
            assert_eq!(status, 200);
            assert_eq!(body, stem.bytes);
            assert_eq!(&body[..4], b"RIFF");
        }
        assert_eq!(request(addr, "GET", "/v1/assets/missing.wav", Some(&token), b"").0, 404);
    }

    #[test]
    fn uploads_attach_to_the_song_and_download_again() {
        let addr = start();
        let ana = login(addr, "ana@example.com");
        let bob = login(addr, "bob@example.com");
        let song_id = songs(addr, &ana)[0]["id"].as_str().unwrap().to_string();

        let path = format!("/v1/songs/{song_id}/uploads?filename=My%20Mix%20(final).WAV");
        let (status, body) = request(addr, "POST", &path, Some(&ana), b"RIFF-mixdown");
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
        let upload = serde_json::from_slice::<Value>(&body).unwrap()["upload"].clone();
        assert_eq!(upload["filename"], "My Mix (final).WAV");
        assert_eq!(upload["size"], 12);

        let (_, song) = json_request(addr, "GET", &format!("/v1/songs/{song_id}"), Some(&ana), "");
        assert_eq!(song["uploads"], json!([upload]));

        let url = upload["url"].as_str().unwrap();
        assert_eq!(request(addr, "GET", url, Some(&ana), b""), (200, b"RIFF-mixdown".to_vec()));
        assert_eq!(request(addr, "GET", url, Some(&bob), b"").0, 404);
        // Bob can't attach files to Ana's song either.
        assert_eq!(request(addr, "POST", &path, Some(&bob), b"RIFF").0, 404);
    }

    #[test]
    fn rejects_bad_uploads() {
        let addr = start();
        let token = login(addr, "ana@example.com");
        let song_id = songs(addr, &token)[0]["id"].as_str().unwrap().to_string();
        let upload = |query: &str, body: &[u8]| request(addr, "POST", &format!("/v1/songs/{song_id}/uploads{query}"), Some(&token), body).0;
        assert_eq!(upload("", b"RIFF"), 400);
        assert_eq!(upload("?filename=..%2F..%2Fevil.wav", b"RIFF"), 400);
        assert_eq!(upload("?filename=mix.exe", b"RIFF"), 400);
        assert_eq!(upload("?filename=mix.wav", b""), 400);
        assert_eq!(request(addr, "POST", "/v1/songs/song-999/uploads?filename=mix.wav", Some(&token), b"RIFF").0, 404);
    }

    #[test]
    fn upload_names() {
        for good in ["mix.wav", "Mix (final) v2.AIFF", "take.flac", "demo.mp3"] {
            assert!(is_safe_upload_name(good), "{good}");
        }
        for bad in ["", ".wav", "mix", "mix.exe", "../mix.wav", "dir\\mix.wav", ".hidden.wav"] {
            assert!(!is_safe_upload_name(bad), "{bad}");
        }
        assert_eq!(percent_decode("My%20Mix+%28v2%29.wav").as_deref(), Some("My Mix (v2).wav"));
        assert_eq!(percent_decode("bad%2"), None);
    }
}
