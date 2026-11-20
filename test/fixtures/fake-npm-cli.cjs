'use strict';
// A stand-in for npm's cli.js: `install --prefix <dir> ... <name@version>` puts a package with a bin script into
// <dir>/node_modules, the way npm would. Used to test installing an agent with the npm that ships inside the app.
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'install') process.exit(2);
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.length - 1];
const at = spec.lastIndexOf('@'), name = at > 0 ? spec.slice(0, at) : spec, version = at > 0 ? spec.slice(at + 1) : '0.0.0';
const dir = path.join(prefix, 'node_modules', ...name.split('/'));
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, bin: { agent: 'dist/index.js' } }));
fs.writeFileSync(path.join(dir, 'dist', 'index.js'), '// fake agent\n');
fs.appendFileSync(path.join(prefix, 'npm-calls.txt'), args.join(' ') + '\n');
