// postinstall: make `npm start` work without `brew install duckdb`.
// Auto-fetches the DuckDB CLI for this platform into ./bin, UNLESS one is
// already present (local ./bin, on PATH, or the Docker image's /usr/local/bin).
// Best-effort: never fails the install; prints a manual hint if it can't.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const DUCKDB_VER = "v1.5.3";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const binDir = path.join(root, "bin");
const target = path.join(binDir, isWin ? "duckdb.exe" : "duckdb");

const onPath = () => { try { execSync(isWin ? "where duckdb" : "command -v duckdb", { stdio: "ignore" }); return true; } catch { return false; } };

if (fs.existsSync(target)) { console.log("[duckdb] bundled binary present — ok"); process.exit(0); }
if (onPath()) { console.log("[duckdb] found on PATH — ok"); process.exit(0); }
if (isWin) { console.log("[duckdb] Windows: install DuckDB manually (or use Docker) — https://duckdb.org"); process.exit(0); }

const arch = process.arch === "arm64" ? "arm64" : "amd64";
const asset = process.platform === "darwin" ? "duckdb_cli-osx-universal.gz"
  : process.platform === "linux" ? `duckdb_cli-linux-${arch}.gz`
  : null;
if (!asset) { console.log(`[duckdb] no auto-install for ${process.platform}/${process.arch}; install manually — https://duckdb.org`); process.exit(0); }

const url = `https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VER}/${asset}`;
try {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const bin = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(target, bin, { mode: 0o755 });
  console.log(`[duckdb] installed ${asset} -> bin/duckdb`);
} catch (e) {
  console.log(`[duckdb] auto-install failed (${e.message}); install manually: brew install duckdb  (or apt/dnf)`);
}
process.exit(0);
