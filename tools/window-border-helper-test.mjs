// Invoked by the native test's isolated, hidden Desktop fixture parent.
import assert from 'node:assert/strict';
import { createWindowBorder } from '../window-border.mjs';
const border = createWindowBorder();
async function until(test, label) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(test())return;await new Promise(r=>setTimeout(r,50));}
  throw Error(label+': '+JSON.stringify(border.status));
}
try {
  border.setHidden(true);
  await until(()=>border.status.supported===true&&border.status.hidden,'helper hides fixture border');
  assert.equal(border.status.windows,1);
  border.setHidden(false);await until(()=>!border.status.hidden,'helper restores on show');
  border.setHidden(true);await until(()=>border.status.hidden,'helper enables again');
  border.dispose();await until(()=>!border.status.hidden,'EOF restores and exits helper');
  console.log('PASS actual hidden helper: DSH ancestry, stdin hide/show, EOF restoration and clean exit');
} finally { border.dispose(); }
