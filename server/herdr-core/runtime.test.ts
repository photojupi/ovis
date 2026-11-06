import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHc } from "./discovery.ts";
import { coreConnection, HC_MOVED, hcBin, hcRecovery, NO_CORE_STATE, startRuntime } from "./runtime.ts";
import { herdrRpc, socketAddress } from "../herdr/client.ts";

/** an hc stand-in found, so no test looks at the developer's own PATH, shell or hc */
const standIn = async () => ({ bin: "/nonexistent/hc", version: "0.1.17" });

const platform = process.platform;
const previousRuntime = process.env["OVIS_RUNTIME"];
const previousSocket = process.env["HERDR_SOCKET"];
const previousPath = process.env["PATH"];
const previousHcBin = process.env["OVIS_HC_BIN"];
const previousHcSocket = process.env["HC_SOCKET"];
const previousHcEnv = process.env["OVIS_HC_ENV"];
const previousStateHome = process.env["XDG_STATE_HOME"];
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  mock.restore();
  Object.defineProperty(process, "platform", { value: platform });
  if (previousRuntime === undefined) delete process.env["OVIS_RUNTIME"];
  else process.env["OVIS_RUNTIME"] = previousRuntime;
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = previousSocket;
  process.env["PATH"] = previousPath;
  if (previousHcBin === undefined) delete process.env["OVIS_HC_BIN"];
  else process.env["OVIS_HC_BIN"] = previousHcBin;
  if (previousHcSocket === undefined) delete process.env["HC_SOCKET"];
  else process.env["HC_SOCKET"] = previousHcSocket;
  if (previousHcEnv === undefined) delete process.env["OVIS_HC_ENV"];
  else process.env["OVIS_HC_ENV"] = previousHcEnv;
  // on Windows any spelling names the one variable; elsewhere a test sets only the upper-case one
  delete process.env["xdg_state_home"];
  if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = previousStateHome;
});

it.skipIf(platform === "win32")("runs the hc it found, not an unrelated one named first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-found-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const script = (name: string, output: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    return join(dir, "bin", name);
  };
  process.env["OVIS_RUNTIME"] = "herdr-core";
  process.env["OVIS_HC_BIN"] = script("hc", "herbstclient 0.9.5");
  const core = script("herdr-core", "hc 0.1.17");
  process.env["PATH"] = join(dir, "bin");
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: process.env, home: dir, loginShellPath: async () => null, usualDirs: [] }));
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(hcBin()).toBe(core);
  } finally {
    adapter.stop();
  }
});

/** a stand-in hc in `folder` that answers --version with `says` */
function hcIn(dir: string, folder: string, says: string): string {
  mkdirSync(join(dir, folder), { recursive: true });
  const path = join(dir, folder, "herdr-core");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${says}'\n`, { mode: 0o755 });
  return path;
}

it.skipIf(platform === "win32")("finds a moved hc again where only the login shell's PATH shows it, as the start did", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-moved-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const old = hcIn(dir, "old", "hc 0.1.17");
  let login = join(dir, "old");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: { PATH: join(dir, "empty") }, home: dir, loginShellPath: async () => login, usualDirs: [] }));
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(hcBin()).toBe(old);
    rmSync(old);
    const moved = hcIn(dir, "new", "hc 0.1.18");
    login = join(dir, "new");
    hcBin();
    await hcRecovery();
    expect(hcBin()).toBe(moved);
  } finally {
    adapter.stop();
  }
});

it.skipIf(platform === "win32")("never runs a file the search did not just verify: one that fails --version is passed over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-replaced-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const old = hcIn(dir, "old", "hc 0.1.17");
  hcIn(dir, "other", "hc 0.1.16");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), () => findHc({ env: { PATH: join(dir, "empty") }, home: dir, loginShellPath: async () => null, usualDirs: [join(dir, "old"), join(dir, "other")] }));
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(hcBin()).toBe(old);
    rmSync(old);
    // the file an earlier look found was replaced with one that is not herdr-core
    const replaced = hcIn(dir, "other", "herbstclient 0.9.5");
    hcBin();
    await hcRecovery();
    expect(hcBin()).not.toBe(replaced);
    // nothing verified: not even a file that reappears at the old path is handed out
    hcIn(dir, "old", "herbstclient 0.9.5");
    expect(hcBin()).toBe(HC_MOVED);
    await hcRecovery();
    expect(hcBin()).toBe(HC_MOVED);
  } finally {
    adapter.stop();
  }
});

it.skipIf(platform === "win32")("starts nothing, and runs no other hc, when none answers as herdr-core's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-none-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  await expect(startRuntime(join(dir, "state"), async () => null)).rejects.toThrow(/no herdr-core found/);
  expect(existsSync(join(dir, "state"))).toBe(false);
});

it.skipIf(platform === "win32")("tightens an existing state directory and socket on every start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-mode-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  for (let start = 0; start < 2; start++) {
    chmodSync(dir, 0o755);
    const adapter = await startRuntime(dir, standIn);
    if (!adapter) throw new Error("runtime did not start");
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(adapter.socketPath).mode & 0o777).toBe(0o600);
      expect(process.env["HERDR_SOCKET"]).toBe(adapter.socketPath);
    } finally {
      adapter.stop();
    }
  }
});

it.skipIf(platform === "win32")("refuses another user's state directory before changing its mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-owner-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  chmodSync(dir, 0o755);
  process.env["OVIS_RUNTIME"] = "herdr-core";
  spyOn(process, "geteuid").mockReturnValue(statSync(dir).uid + 1);
  await expect(startRuntime(dir, standIn)).rejects.toThrow();
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  expect(existsSync(join(dir, "herdr-core.sock"))).toBe(false);
});

it("rejects herdr-core on an OS it is not served on before creating state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-freebsd-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  Object.defineProperty(process, "platform", { value: "freebsd" });
  await expect(startRuntime(state, standIn)).rejects.toThrow(/not freebsd/);
  expect(existsSync(state)).toBe(false);
});

it.skipIf(platform !== "win32")("serves herdr-core on Windows through a named pipe the herdr client reaches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-windows-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  const adapter = await startRuntime(join(dir, "state"), standIn);
  if (!adapter) throw new Error("runtime did not start");
  try {
    expect(adapter.socketPath).toMatch(/^\\\\\.\\pipe\\ovis-herdr-core-[0-9a-f]{32}$/);
    expect(process.env["HERDR_SOCKET"]).toBe(adapter.socketPath);
    // the client's own address for it: a pipe name is used as it is
    expect(socketAddress(adapter.socketPath)).toBe(adapter.socketPath);
    // a second server on the same state folder is refused while this one listens
    await expect(startRuntime(join(dir, "state"), standIn)).rejects.toThrow(/Another Ovis owns this state directory/);
    // and through a junction to the same folder, which names the same pipe
    symlinkSync(join(dir, "state"), join(dir, "alias"), "junction");
    await expect(startRuntime(join(dir, "alias"), standIn)).rejects.toThrow(/Another Ovis owns this state directory/);
  } finally {
    adapter.stop();
  }
  // and the pipe went with it: a server started afterwards takes the same name
  const again = await startRuntime(join(dir, "state"), standIn);
  if (!again) throw new Error("runtime did not start again");
  again.stop();
});

/** nothing runs: `hc connect` starts a core where none listens */
const noProcesses = () => spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("not run in tests"); });
/** no line and no hc found from a test before this one: a start that was refused keeps them, and only a stop lets go */
const freshRuntime = async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-fresh-"));
  process.env["OVIS_RUNTIME"] = "herdr-core";
  try { (await startRuntime(dir, standIn))?.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
};

it("connects to no core on Windows unless its pipe is listed, and starts none", async () => {
  const spawn = noProcesses();
  Object.defineProperty(process, "platform", { value: "win32" });
  process.env["HC_SOCKET"] = `\\\\.\\pipe\\ovis-test-no-core-${process.pid}.sock`;
  const hc = coreConnection();
  cleanup = () => hc.close();
  // hello fails as a call does, and the next try is refused the same way
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(hc.hello()).rejects.toMatchObject({ kind: "closed", message: expect.stringContaining("open the Herdr app (Ovis starts no core on Windows)") });
    await expect(hc.call("terminal.list", {})).rejects.toMatchObject({ kind: "closed" });
  }
  expect(spawn).not.toHaveBeenCalled();
});

it.skipIf(platform !== "win32")("answers as a herdr nobody can reach, and goes on serving, while the core's pipe is not listed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-windows-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const spawn = noProcesses();
  process.env["OVIS_RUNTIME"] = "herdr-core";
  process.env["HC_SOCKET"] = `\\\\.\\pipe\\ovis-test-no-core-${process.pid}.sock`;
  const adapter = await startRuntime(join(dir, "state"), standIn);
  if (!adapter) throw new Error("runtime did not start");
  try {
    // ping asks hc's hello first: refused, it ends one answer, not this process
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(herdrRpc("ping", {}, adapter.socketPath)).rejects.toMatchObject({ code: "connect_failed", message: expect.stringContaining("open the Herdr app") });
    }
  } finally {
    adapter.stop();
  }
  expect(spawn).not.toHaveBeenCalled();
});

it.skipIf(platform !== "win32")("connects on Windows once the core's pipe is listed, through an hc that can start no core", async () => {
  await freshRuntime();
  const spawn = noProcesses();
  const pipe = `\\\\.\\pipe\\ovis-test-core-${process.pid}.sock`;
  process.env["HC_SOCKET"] = pipe;
  // the server's own state folder, in a spelling of its name other than hc's: Windows keeps a
  // variable under the spelling it was first set with, so one set before is cleared first
  delete process.env["XDG_STATE_HOME"];
  process.env["xdg_state_home"] = join(tmpdir(), "ovis-test-state-home");
  const core = Bun.listen({ unix: pipe, socket: { data() {} } });
  const hc = coreConnection();
  cleanup = () => { hc.close(); core.stop(true); };
  await expect(hc.hello()).rejects.toMatchObject({ kind: "closed", message: expect.stringContaining("hc could not be started") });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]![0]).toEqual([hcBin(), "connect"]);
  expect(spawn.mock.calls[0]![1]).toMatchObject({ windowsHide: true });
  // the server's environment as it is now (hc looks for the pipe that was listed), with a state
  // folder Windows cannot make in place of the server's: hc makes it before it starts a core
  const { XDG_STATE_HOME: state, ...rest } = spawn.mock.calls[0]![1]?.env ?? {};
  expect(state).toBe(NO_CORE_STATE);
  expect(rest).toEqual(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "XDG_STATE_HOME")));
  expect(rest["HC_SOCKET"]).toBe(pipe);
  expect(() => mkdirSync(join(NO_CORE_STATE, "herdr-core", "x"), { recursive: true })).toThrow();
});

it.skipIf(platform !== "win32")("looks on Windows at the core a machine's server reaches (OVIS_HC_ENV), not at its own environment's", async () => {
  await freshRuntime();
  const spawn = noProcesses();
  const listed = `\\\\.\\pipe\\ovis-test-core-machine-${process.pid}.sock`;
  const unlisted = `\\\\.\\pipe\\ovis-test-no-core-machine-${process.pid}.sock`;
  const core = Bun.listen({ unix: listed, socket: { data() {} } });
  const hc = coreConnection();
  cleanup = () => { hc.close(); core.stop(true); };
  process.env["HC_SOCKET"] = listed;
  process.env["OVIS_HC_ENV"] = JSON.stringify({ HC_SOCKET: unlisted });
  await expect(hc.hello()).rejects.toMatchObject({ kind: "closed", message: expect.stringContaining("open the Herdr app") });
  expect(spawn).not.toHaveBeenCalled();
  process.env["HC_SOCKET"] = unlisted;
  process.env["OVIS_HC_ENV"] = JSON.stringify({ HC_SOCKET: listed, XDG_STATE_HOME: join(tmpdir(), "ovis-test-state-home") });
  await expect(hc.hello()).rejects.toMatchObject({ kind: "closed", message: expect.stringContaining("hc could not be started") });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]![1]?.env).toMatchObject({ HC_SOCKET: listed, XDG_STATE_HOME: NO_CORE_STATE });
});

it("spawns hc connect off Windows with no environment of its own but a machine's, as before", async () => {
  await freshRuntime();
  const spawn = noProcesses();
  Object.defineProperty(process, "platform", { value: "linux" });
  // a core of its own: spawnHcConnect turns down the default one under a test session (bun run check)
  process.env["HC_SOCKET"] = join(tmpdir(), "ovis-test-no-core.sock");
  const hc = coreConnection();
  cleanup = () => hc.close();
  await expect(hc.hello()).rejects.toMatchObject({ kind: "closed", message: expect.stringContaining("hc could not be started") });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]![1]).not.toHaveProperty("env");
  process.env["OVIS_HC_ENV"] = JSON.stringify({ HC_SESSION: "work", XDG_STATE_HOME: "/state" });
  await expect(hc.hello()).rejects.toMatchObject({ kind: "closed", message: expect.stringContaining("hc could not be started") });
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[1]![1]?.env).toEqual({ ...process.env, HC_SESSION: "work", XDG_STATE_HOME: "/state" });
});

it("leaves the default runtime's state and socket unchanged even on Windows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-default-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  delete process.env["OVIS_RUNTIME"];
  process.env["HERDR_SOCKET"] = "default-socket";
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(await startRuntime(state, standIn)).toBeNull();
  expect(existsSync(state)).toBe(false);
  expect(process.env["HERDR_SOCKET"]).toBe("default-socket");
});
