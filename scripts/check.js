let child;
import { spawn } from "child_process";
import net from "net";
import os from "os";
let isWSL = () => {
    if ("linux" !== process.platform) return !1;
    if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return !0;
    let release = os.release().toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  },
  forceKillPidTree = pid => {
    if (!pid || pid === process.pid) return;
    let isWin = "win32" === process.platform,
      wsl = isWSL();
    try {
      if (isWin)
        return void spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on(
          "error",
          () => {}
        );
      if (wsl) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            (process.kill(pid, 0), process.kill(pid, "SIGKILL"));
          } catch {}
        }, 700);
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 0);
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            process.kill(pid, "SIGKILL");
          }
        } catch {}
      }, 600);
    } catch {}
  },
  CONTROL_PORT = Number(process.env.CHECK_RUNNER_PORT || 45991),
  CONTROL_HOST = "127.0.0.1";
async function requestPreviousShutdown() {
  let tryConnect = () =>
    new Promise(resolve => {
      let socket = net.createConnection({ port: CONTROL_PORT, host: CONTROL_HOST }, () => {
        (socket.write("KILL\n"), socket.end(), resolve(!0));
      });
      (socket.on("error", () => resolve(!1)),
        socket.setTimeout(400, () => {
          (socket.destroy(), resolve(!1));
        }));
    });
  (await tryConnect()) || (await new Promise(r => setTimeout(r, 150)), await tryConnect());
}
let controlServer = null,
  sawError = !1;
(async function () {
  var onKill;
  (await requestPreviousShutdown(),
    await ((onKill = () => {
      try {
        child && !child.killed && forceKillPidTree(child.pid ?? null);
      } catch {}
      try {
        controlServer?.close();
      } catch {}
      process.exit();
    }),
    new Promise(resolve => {
      let server = net.createServer(socket => {
        let dataBuf = "";
        socket.on("data", chunk => {
          (dataBuf += chunk.toString("utf8")).includes("KILL") && (socket.end(), onKill());
        });
      });
      (server.on("error", err => {
        resolve();
      }),
        server.listen(CONTROL_PORT, CONTROL_HOST, () => {
          ((controlServer = server), resolve());
        }));
    })));
  let isWin = "win32" === process.platform,
    wsl = isWSL(),
    spawnOpts = {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1", npm_config_color: "always" },
      detached: !isWin && !wsl
    };
  if (isWin) child = spawn("npm run check --silent", { ...spawnOpts, shell: !0, detached: !1 });
  else if (
    ((child = spawn("npm", ["run", "check", "--silent"], { ...spawnOpts, shell: !1 })),
    spawnOpts.detached)
  )
    try {
      child.unref();
    } catch {}
  let ansiRegex = RegExp(`[[0-9;?]*[ -/]*[@-~]`, "g"),
    stripAnsi = s => s.replace(ansiRegex, ""),
    shouldSuppress = sanitizedLower =>
      (sanitizedLower.includes("found ") &&
        sanitizedLower.includes("warning") &&
        sanitizedLower.includes("errors")) ||
      (sanitizedLower.includes("finished in ") &&
        sanitizedLower.includes(" files using ") &&
        sanitizedLower.includes(" threads")),
    rewriteLine = line =>
      line.replace(/\.\.\/shared\//g, "shared/").replace(/\.\.\\shared\\/g, "shared\\");
  function streamProcessor(isErr) {
    let buffer = "";
    return chunk => {
      let idx;
      for (buffer += chunk.toString("utf8"); -1 !== (idx = buffer.search(/\r?\n/)); ) {
        let lineWithNewline = buffer.slice(
          0,
          idx + ("\r" === buffer[idx] && "\n" === buffer[idx + 1] ? 2 : 1)
        );
        buffer = buffer.slice(lineWithNewline.length);
        let line = lineWithNewline.replace(/\r?\n$/, ""),
          lower = stripAnsi(line)
            .trim()
            .replace(/^[\s\u2713\u2714\u2705ℹ•>*\-–[\](){}:]+/, "")
            .toLowerCase();
        (shouldSuppress(lower) ||
          (isErr ? process.stderr : process.stdout).write(rewriteLine(line) + "\n"),
          !/\berror\b/.test(lower) ||
            /0 errors?/.test(lower) ||
            /no errors?/.test(lower) ||
            (sawError = !0));
      }
    };
  }
  function shutdown() {
    try {
      child && !child.killed && forceKillPidTree(child.pid ?? null);
    } catch {}
    try {
      controlServer?.close();
    } catch {}
    process.exit();
  }
  (child.stdout?.on("data", streamProcessor(!1)),
    child.stderr?.on("data", streamProcessor(!0)),
    child.on("close", (code, signal) => {
      let reset = "\x1b[0m",
        failed = (code ?? 0) !== 0 || sawError;
      if (failed) {
        let reason =
          (code ?? 0) === 0 && sawError
            ? " (detected errors in output)"
            : signal
              ? ` (signal ${signal})`
              : "";
        console.log(`\x1b[31m❌ Checks failed${reason}${reset}`);
      } else console.log(`\x1b[32m✅ All checks passed${reset}`);
      try {
        if (controlServer)
          return void controlServer.close(() => {
            process.exit(+!!failed);
          });
      } catch {}
      process.exit(+!!failed);
    }),
    child.on("error", err => {
      (console.error("❌ Failed to start check process:", err), (process.exitCode = 1));
    }),
    process.on("SIGINT", shutdown),
    process.on("SIGTERM", shutdown));
})().catch(err => {
  (console.error("[check-runner] fatal error:", err), process.exit(1));
});
