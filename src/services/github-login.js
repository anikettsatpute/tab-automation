// GitHub sign-in via the GitHub CLI device flow (`gh auth login --web`): no PAT, no OAuth app.
// The resulting gh token is copied into the MCP server's TOKEN slot and git is set up to push with it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOGIN_TIMEOUT_MS = 15 * 60000;
const sessions = new Map(); // serverId -> { status, code, url, error, child, at }

export function ghBin() {
  if (process.env.GH_BIN) return process.env.GH_BIN;
  const local = path.join(os.homedir(), ".local/gh");
  try {
    const d = readdirSync(local).filter((x) => x.startsWith("gh_")).sort().pop();
    if (d && existsSync(path.join(local, d, "bin/gh"))) return path.join(local, d, "bin/gh");
  } catch {}
  return "gh";
}

// gh prefers GH_TOKEN/GITHUB_TOKEN over its stored login; drop them so we read the real login.
function ghEnv() {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[k];
  return env;
}

function gh(args, timeout = 20000) {
  const r = spawnSync(ghBin(), args, { encoding: "utf8", timeout, env: ghEnv(), stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || r.error?.message || "").trim() };
}

/** Existing gh login token, or "" when gh is missing / logged out. */
export function ghToken() {
  const r = gh(["auth", "token", "--hostname", "github.com"]);
  return r.ok && /^gh[opsu]_|^github_pat_/.test(r.out) ? r.out : "";
}

function finish(serverId, onToken) {
  const s = sessions.get(serverId);
  const token = ghToken();
  if (!token) { Object.assign(s, { status: "error", error: "gh finished but returned no token" }); return; }
  try {
    onToken(token);
    gh(["auth", "setup-git", "--hostname", "github.com"]);
    const who = gh(["api", "user", "--jq", ".login"]);
    Object.assign(s, { status: "done", user: who.ok ? who.out : "" });
  } catch (e) { Object.assign(s, { status: "error", error: String(e.message).slice(0, 300) }); }
}

/** Start (or reuse) a device-flow login. Resolves once the one-time code is known, or done if already logged in. */
export function startGithubLogin(serverId, onToken) {
  const prev = sessions.get(serverId);
  if (prev?.status === "pending" && prev.code) return Promise.resolve(publicLogin(serverId));
  try { prev?.child?.kill("SIGKILL"); } catch {}
  const s = { status: "pending", code: "", url: "", error: "", child: null, at: Date.now() };
  sessions.set(serverId, s);
  if (ghToken()) { finish(serverId, onToken); return Promise.resolve(publicLogin(serverId)); }

  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(ghBin(), ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--scopes", "repo,read:org"], { env: ghEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      Object.assign(s, { status: "error", error: `gh not runnable: ${e.message}` });
      resolve(publicLogin(serverId)); return;
    }
    s.child = child;
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, LOGIN_TIMEOUT_MS);
    const onData = (d) => {
      out += String(d);
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)?.[1];
      const url = /(https:\/\/github\.com\/login\/device)/.exec(out)?.[1];
      // gh prints the code then waits for Enter; /dev/null stdin never sends it, so answer here.
      if (code && !s.code) {
        Object.assign(s, { code, url: url || "https://github.com/login/device" });
        try { child.stdin.end("\n"); } catch {}
        resolve(publicLogin(serverId));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      Object.assign(s, { status: "error", error: /ENOENT/.test(e.message) ? "GitHub CLI (gh) not installed — install it (Termux: pkg install gh) and retry" : e.message });
      resolve(publicLogin(serverId));
    });
    child.on("close", (code) => {
      clearTimeout(timer); s.child = null;
      if (code === 0) finish(serverId, onToken);
      else if (s.status === "pending") Object.assign(s, { status: "error", error: (out.trim().split("\n").pop() || `gh exited ${code}`).slice(0, 300) });
      resolve(publicLogin(serverId));
    });
  });
}

export function publicLogin(serverId) {
  const s = sessions.get(serverId);
  if (!s) return { status: "idle" };
  return { status: s.status, code: s.code, url: s.url, error: s.error, user: s.user || "" };
}

export function cancelGithubLogin(serverId) {
  const s = sessions.get(serverId);
  try { s?.child?.kill("SIGKILL"); } catch {}
  sessions.delete(serverId);
}
