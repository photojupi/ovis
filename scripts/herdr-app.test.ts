import { expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coreSocket } from "../server/herdr-core/discovery.ts";

const launcher = join(import.meta.dir, "herdr-app.ps1");
const windows = process.platform === "win32";
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** Windows PowerShell running `args` (a script file and its arguments, or -EncodedCommand). */
async function powershell(args: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
    env: { ...process.env, ...env }, windowsHide: true, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: out.trim(), err, code };
}
/** `commands` after dot-sourcing the launcher, which then defines its functions and runs nothing. */
const withFunctions = (commands: string, env: Record<string, string | undefined> = {}) =>
  powershell(["-EncodedCommand", Buffer.from(`. ${quoted(launcher)}; ${commands}`, "utf16le").toString("base64")], env);

/** A pipe server that counts the connections made to it. */
async function pipe(name: string): Promise<{ server: Server; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(`\\\\.\\pipe\\${name}`, done); });
  return { server, connections: () => connections };
}
const close = (server: Server) => new Promise<void>((done) => server.close(() => done()));

it.skipIf(!windows)("parses in Windows PowerShell, which reads it in the ANSI code page: ASCII only", async () => {
  expect([...readFileSync(launcher)].filter((byte) => byte > 127)).toEqual([]);
  const parse = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quoted(launcher)}, [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message }; $errors.Count`;
  const { out, err, code } = await powershell(["-EncodedCommand", Buffer.from(parse, "utf16le").toString("base64")]);
  expect([code, out], err).toEqual([0, "0"]);
}, 30_000);

it.skipIf(!windows)("names the Herdr app's core pipe as hc does", async () => {
  const { out, err } = await withFunctions([
    "$env:HC_SOCKET = $null; $env:HC_SESSION = $null; $env:USERNAME = 'J\u00fc Pi.2'; Get-CorePipe",
    "$env:USERNAME = 'jupi'; $env:HC_SESSION = ' work '; Get-CorePipe",
    "$env:HC_SOCKET = '\\\\.\\pipe\\mine.sock'; Get-CorePipe",
  ].join("; "));
  expect(out.split(/\r?\n/), err).toEqual(["herdr-core-JPi2-default.sock", "herdr-core-jupi-work.sock", "mine.sock"]);
  // and as the server does, which refuses to connect while that pipe is not listed
  const asServer = (env: Record<string, string>) => coreSocket({ env, home: join(tmpdir(), "ovis-no-such-home"), platform: "win32", pipes: () => [] }).path;
  expect([asServer({ USERNAME: "Jü Pi.2" }), asServer({ USERNAME: "jupi", HC_SESSION: " work " }), asServer({ HC_SOCKET: "\\\\.\\pipe\\mine.sock" })])
    .toEqual(["\\\\.\\pipe\\herdr-core-JPi2-default.sock", "\\\\.\\pipe\\herdr-core-jupi-work.sock", "\\\\.\\pipe\\mine.sock"]);
}, 30_000);

it.skipIf(!windows)("finds the bun.exe behind an npm .cmd shim in a path with literal percent signs", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ovis bun shim "));
  const bin = join(scratch, "npm %OS% !OS! ^x prefix");
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, "bun.cmd"), `@echo off\r\n"${process.execPath}" %*\r\n`);
    const { out, err } = await withFunctions(`$env:PATH = ${quoted(bin)}; Find-Bun`);
    expect(out, err).toBe(process.execPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!windows)("finds the core's pipe in the pipe list without connecting to it", async () => {
  const name = `ovis-scratch-herdr-app-${process.pid}.sock`;
  // a name no .NET path can hold: Directory.GetFiles('\\.\pipe\') throws while it is listed
  const odd = await pipe(`ovis-scratch-herdr-app-${process.pid}-a|b<c>.sock`);
  try {
    expect((await withFunctions(`Wait-Core '${name}' 0`)).out).toBe("False");
    const core = await pipe(name);
    try {
      expect((await withFunctions(`Wait-Core '${name.toUpperCase()}' 0`)).out).toBe("True");
    } finally { await close(core.server); }
    expect(core.connections()).toBe(0);
  } finally { await close(odd.server); }
}, 30_000);

it.skipIf(!windows)("reads the server's log from the folder scripts/plugin.ts finds, herdr's plugin folder and older names too", async () => {
  // by its long name: the launcher's answer is compared with paths under it
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ovis herdr app state ")));
  const own = join("profile", ".local", "state", "ovis");
  const ownOld = join("profile", ".local", "state", "herdr-web-ui");
  const managed = join("local", "herdr", "plugins", "devswha.ovis");
  const managedOld = join("local", "herdr", "plugins", "devswha.herdr-web-ui");
  const xdg = join("xdg", "herdr", "plugins", "devswha.ovis");
  // a folder holding a record of a running server (this test), of one that is gone, or just there;
  // `status` names the pid of the record it read, so it says which folder scripts/plugin.ts took
  const cases: { running: string; gone?: string[]; there?: string[]; env?: (root: string) => Record<string, string> }[] = [
    { running: own },
    { running: own, there: [managed] },
    { running: managed, gone: [own] },
    { running: ownOld },
    { running: managedOld },
    { running: managedOld, there: [managed] },
    { running: "given", there: [managed], env: (root) => ({ HERDR_PLUGIN_STATE_DIR: join(root, "given") }) },
    { running: xdg, there: [managed], env: (root) => ({ XDG_STATE_HOME: join(root, "xdg") }) },
  ];
  try {
    await Promise.all(cases.map(async ({ running, gone = [], there = [], env }, index) => {
      const root = join(scratch, String(index));
      for (const dir of [running, ...gone, ...there]) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, running, "server.pid"), `${process.pid}\n`);
      for (const dir of gone) writeFileSync(join(root, dir, "server.pid"), "2147483647\n");
      const environment = {
        USERPROFILE: join(root, "profile"), LOCALAPPDATA: join(root, "local"), HOME: undefined, XDG_STATE_HOME: undefined, HERDR_PLUGIN_STATE_DIR: undefined,
        HERDR_PLUGIN_CONFIG_DIR: join(root, "config"), OVIS_STATE_DIR: join(root, "app-state"), PORT: "1", ...env?.(root),
      };
      const status = Bun.spawnSync([process.execPath, join(import.meta.dir, "plugin.ts"), "status"], { cwd: scratch, env: { ...process.env, ...environment }, windowsHide: true, stdout: "pipe", stderr: "pipe" });
      expect(status.stdout.toString(), `case ${index}: ${status.stderr.toString()}`).toContain(`(pid ${process.pid})`);
      const { out, err } = await withFunctions("Get-ServerLog", environment);
      expect(out, `case ${index}: ${err}`).toBe(join(root, running, "server.log"));
    }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!windows)("installs and builds a fresh checkout once, starts scripts/plugin.ts out of sight without the terminal's identity, then shows its status, or the log's end when a failed start wrote it", async () => {
  // by its long name, which PowerShell gives the launcher's folder even when TEMP is a short 8.3 one
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ovis herdr app ")));
  const root = join(scratch, "checkout");
  // git, here and in the launcher, without the developer's config or any repository but the checkout's
  const gitEnv = {
    ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("GIT_")).map((key) => [key, undefined])),
    GIT_CEILING_DIRECTORIES: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
  };
  const state = join(scratch, "state");
  const runs = join(scratch, "runs.jsonl");
  const coreName = `ovis-scratch-herdr-app-${process.pid}-core.sock`;
  const core = await pipe(coreName);
  try {
    // fresh: no node_modules and no dist yet
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(state);
    copyFileSync(launcher, join(root, "scripts", "herdr-app.ps1"));
    // A stand-in for scripts/plugin.ts, and for the install's and the build's scripts: it records how
    // it ran, and starts nothing. As the build, it writes the commit it is of, as vite.config.ts does.
    writeFileSync(join(root, "scripts", "plugin.ts"), `
      import { execFileSync } from "node:child_process";
      import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
      const env = process.env;
      appendFileSync(${JSON.stringify(runs)}, JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(), runtime: env.OVIS_RUNTIME, home: env.HOME,
        terminal: [env.HC_TERMINAL_ID, env.HC_SCOPE, env.HC_TERMINAL_SOCKET].filter(Boolean),
      }) + "\\n");
      if (process.argv[2] === "build") {
        mkdirSync("dist", { recursive: true });
        writeFileSync("dist/build.json", JSON.stringify({ revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }));
      }
      if (process.argv[2] === "status") console.log("running http://127.0.0.1:1 (stand-in)");
      if (process.argv[2] === "start" && env.STAND_IN_LOG) appendFileSync(${JSON.stringify(join(state, "server.log"))}, env.STAND_IN_LOG + "\\n");
      process.exit(process.argv[2] === "start" ? Number(env.STAND_IN_EXIT) : 0);
    `);
    // no dependencies: bun install fetches nothing, and runs only the stand-in as its postinstall
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { postinstall: "bun scripts/plugin.ts install", build: "bun scripts/plugin.ts build" } }));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { env: { ...process.env, ...gitEnv }, windowsHide: true }).stdout.toString().trim();
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "t");
    writeFileSync(join(state, "server.log"), "an earlier line\n");
    const launch = (command: string, startExit = 0, lastWords?: string) => powershell(["-File", join(root, "scripts", "herdr-app.ps1"), command], {
      ...gitEnv, HOME: undefined, HC_SOCKET: `\\\\.\\pipe\\${coreName}`, HERDR_PLUGIN_STATE_DIR: state, STAND_IN_EXIT: String(startExit), STAND_IN_LOG: lastWords,
      HC_TERMINAL_ID: "t2", HC_SCOPE: "0-scope", HC_TERMINAL_SOCKET: "\\\\.\\pipe\\terminal.sock",
      // bun install leaves a node-gyp shim folder in its temp folder (TMPDIR, which scripts/test-herdr.ts
      // sets, else TEMP) at every postinstall: the launcher's temp folder is the scratch one, removed below
      TMPDIR: scratch, TEMP: scratch, TMP: scratch,
    });

    for (const command of ["start", "restart"]) {
      const { out, err, code } = await launch(command);
      expect(code, err + out).toBe(0);
      expect(out).toContain("running http://127.0.0.1:1 (stand-in)");
    }
    type Run = { argv: string[]; cwd: string; runtime?: string; home?: string; terminal: string[] };
    const ran = readFileSync(runs, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Run);
    // installed and built by the first start alone: the next one found both
    expect(ran.map(({ argv }) => argv.join(" "))).toEqual(["install", "build", "start", "status", "stop", "start", "status"]);
    for (const { cwd, runtime, home, terminal } of ran) {
      expect(resolve(cwd).toLowerCase()).toBe(resolve(root).toLowerCase());
      expect({ runtime, home, terminal }).toEqual({ runtime: "herdr-core", home: process.env["USERPROFILE"], terminal: [] });
    }
    // a commit since (a pull, say) leaves the client of the one before: the next start builds again
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "t2");
    const pulled = await launch("start");
    expect(pulled.code, pulled.err + pulled.out).toBe(0);
    const since = readFileSync(runs, "utf8").trim().split("\n").slice(ran.length).map((line) => (JSON.parse(line) as Run).argv.join(" "));
    expect(since).toEqual(["build", "start", "status"]);
    const failed = await launch("start", 3, "the stand-in's last words");
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("Could not start Ovis (exit 3)");
    expect(failed.err).toContain("the stand-in's last words");
    // one that stops before it writes the log (a package that does not load, say) leaves there the
    // words of the run before it, which are not why it failed
    const silent = await launch("start", 3);
    expect(silent.code).toBe(1);
    expect(silent.err).toContain("Could not start Ovis (exit 3), and the server's log has nothing new");
    expect(silent.err).not.toContain("the stand-in's last words");
    expect(core.connections()).toBe(0);
  } finally {
    await close(core.server);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
