'use strict';
// Before packaging: put the Magpie program the app ships (requirement 8) where electron-builder takes it from
// (build/magpie/, not kept in git), and check it is the pinned release, unchanged.
// The program comes from BEASTIE_MAGPIE_EXE (yetone/magpie v0.1.1336, MIT; see THIRD_PARTY_NOTICES.txt).

const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const NAME = 'magpie-v0.1.1336.exe';
const SHA256 = '29ab69019f6aa375c2a13811c71e862c40121dd4eaa0a31c252979bc1afb64ce';

const from = process.env.BEASTIE_MAGPIE_EXE;
if (!from || !existsSync(from)) {
  console.error(`[prepare-magpie] set BEASTIE_MAGPIE_EXE to the ${NAME} program`);
  process.exit(1);
}
const sum = createHash('sha256').update(readFileSync(from)).digest('hex');
if (sum !== SHA256) {
  console.error(`[prepare-magpie] ${from} is not the pinned ${NAME} (sha256 ${sum})`);
  process.exit(1);
}
const dir = join(__dirname, '..', 'build', 'magpie');
mkdirSync(dir, { recursive: true });
copyFileSync(from, join(dir, NAME));
console.log(`[prepare-magpie] ${NAME} ready (sha256 ok)`);
