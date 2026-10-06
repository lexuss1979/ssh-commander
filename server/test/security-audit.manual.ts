// Manual live security-audit scenario: requires a test sshd
// (linuxserver/openssh-server on 127.0.0.1:2222, user test / pass test123,
// SUDO_ACCESS=true).
// Run: npx tsx test/security-audit.manual.ts
import { runSecurityAudit } from '../src/services/security-audit.js';
import type { Profile } from '../src/types.js';

const profile: Profile = {
  id: 'test-sshd',
  name: 'test-sshd',
  host: '127.0.0.1',
  port: 2222,
  username: 'test',
  authType: 'password',
  password: 'test123',
  dockerCommand: 'docker',
};

let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ok: ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${name} ${detail}`);
  }
}

console.log('== Unprivileged audit (all sections) ==');
const plain = await runSecurityAudit(profile, {});
console.log(plain);
check('all sections present', ['auth', 'network', 'updates', 'activity', 'docker', 'filesystem'].every((s) => plain.includes(`## ${s}`)));
check('root subsections marked as skipped', plain.includes('пропущено: нет прав'));
check('sshd_config read', /PermitRootLogin|PasswordAuthentication/i.test(plain));
check('ports visible', plain.includes('Открытые порты') && /LISTEN/.test(plain));
check('docker unavailable — a note, not a crash', /docker недоступен|контейнеров нет/.test(plain));

console.log('\n== Privileged audit (sudo) ==');
const priv = await runSecurityAudit(profile, { privileged: true, sudoPassword: 'test123' });
console.log(priv);
check('no broken-sudo message', !priv.includes('sudo не сработал'));
check('root subsections executed', !priv.includes('пропущено: нет прав'));
check('the password never leaked into the output', !priv.includes('test123'));

console.log('\n== Audit with a wrong sudo password ==');
const wrong = await runSecurityAudit(profile, { privileged: true, sudoPassword: 'wrong-pass' });
check('sudo failed — graceful degradation', wrong.includes('sudo не сработал') && wrong.includes('пропущено: нет прав'));

console.log('\n== A single section request ==');
const one = await runSecurityAudit(profile, { sections: ['network'] });
check('network only', one.includes('## network') && !one.includes('## auth'));

console.log(failed === 0 ? '\nALL OK' : `\nFAILURES: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
