'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The Node inside Electron 43 (24.22) no longer removes a read-only file on Windows, and git marks its object files
// read-only: the tests' clean-up of their temporary folders makes those writable and tries again, as the app's own
// rmTree does (src/main/v8/rmTree.ts).
const plainRm = fs.rmSync;
fs.rmSync = function rmSync(target, options) {
  try { return plainRm.call(fs, target, options); }
  catch (err) {
    if (err?.code !== 'EPERM' || !options?.recursive) throw err;
    const writable = p => {
      try { fs.chmodSync(p, 0o666); } catch { /* gone */ }
      let entries = [];
      try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) { const full = path.join(p, e.name); if (e.isDirectory()) writable(full); else { try { fs.chmodSync(full, 0o666); } catch { /* gone */ } } }
    };
    writable(String(target));
    return plainRm.call(fs, target, options);
  }
};

const cache = new Map();

function resolveTs(fromDir, request) {
  const base = request.startsWith('@shared/')
    ? path.resolve(__dirname, '..', 'src/shared', request.slice('@shared/'.length))
    : path.resolve(fromDir, request);
  for (const candidate of [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadFile(filename) {
  const cached = cache.get(filename);
  if (cached) return cached.exports;
  // A `.json` import is data, not TypeScript. The bundler parses it (the app
  // compiles with resolveJsonModule); handing it to transpileModule instead
  // fails output generation outright, so parse it the same way here.
  if (filename.endsWith('.json')) {
    const json = { exports: JSON.parse(fs.readFileSync(filename, 'utf8')) };
    cache.set(filename, json);
    return json.exports;
  }
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      // Match tsconfig.node/tsconfig.web. Without it a default import of a CJS
      // builtin (`import path from 'node:path'`) compiles to `path_1.default`,
      // which is undefined at run time — the module loads fine and then explodes
      // on first use. Test harness only; no shipped code compiles through here.
      esModuleInterop: true
    },
    fileName: filename,
    reportDiagnostics: true
  });
  if (output.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n'
    }));
  }
  const mod = { exports: {} };
  cache.set(filename, mod);
  const localRequire = (request) => {
    if (request.startsWith('.') || request.startsWith('@shared/')) {
      const resolved = resolveTs(path.dirname(filename), request);
      if (resolved) return loadFile(resolved);
    }
    return require(request);
  };
  const run = new Function('module', 'exports', 'require', '__filename', '__dirname', output.outputText);
  run(mod, mod.exports, localRequire, filename, path.dirname(filename));
  return mod.exports;
}

/** Load a TypeScript module and its local TypeScript imports for node:test. */
module.exports = function loadTs(relativePath) {
  return loadFile(path.resolve(__dirname, '..', relativePath));
};
