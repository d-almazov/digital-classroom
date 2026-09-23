"use strict";

const PYODIDE_VERSION = "0.27.7";
const PYODIDE_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let pyodide = null;
let initialization = null;

self.addEventListener("message", async (event) => {
  const message = event.data;

  if (message.type === "init") {
    try {
      await initializePyodide();
      self.postMessage({ type: "ready" });
    } catch (_error) {
      self.postMessage({ type: "init-error" });
    }
    return;
  }

  if (message.type === "run") {
    try {
      await initializePyodide();
      const result = await executePython(message.code);
      self.postMessage({ type: "result", id: message.id, ...result });
    } catch (error) {
      self.postMessage({
        type: "result",
        id: message.id,
        ok: false,
        stdout: "",
        error: formatPythonError(error),
      });
    }
  }
});

function initializePyodide() {
  if (initialization) return initialization;

  initialization = (async () => {
    importScripts(`${PYODIDE_BASE_URL}pyodide.js`);
    pyodide = await loadPyodide({ indexURL: PYODIDE_BASE_URL });
  })();

  return initialization;
}

async function executePython(code) {
  const stdout = [];
  const stderr = [];
  const globals = pyodide.runPython("dict()");

  pyodide.setStdout({ batched: (text) => stdout.push(text) });
  pyodide.setStderr({ batched: (text) => stderr.push(text) });

  try {
    await pyodide.runPythonAsync(code, { globals });
    return {
      ok: true,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: stdout.join("\n"),
      error: formatPythonError(error),
    };
  } finally {
    globals.destroy();
  }
}

function formatPythonError(error) {
  const lines = String(error && error.message ? error.message : error)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const conciseError = [...lines]
    .reverse()
    .find((line) => /(?:Error|Exception):/.test(line));

  return conciseError || lines.at(-1) || "Невідома помилка Python.";
}
