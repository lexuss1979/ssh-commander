// Ручной live-сценарий security-audit: требует тестовый sshd
// (linuxserver/openssh-server на 127.0.0.1:2222, user test / pass test123,
// SUDO_ACCESS=true).
// Запуск: npx tsx test/security-audit.manual.ts
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

console.log('== Аудит без привилегий (все секции) ==');
const plain = await runSecurityAudit(profile, {});
console.log(plain);
check('есть все секции', ['auth', 'network', 'updates', 'activity', 'docker', 'filesystem'].every((s) => plain.includes(`## ${s}`)));
check('root-подсекции помечены пропуском', plain.includes('пропущено: нет прав'));
check('sshd_config прочитан', /PermitRootLogin|PasswordAuthentication/i.test(plain));
check('порты видны', plain.includes('Открытые порты') && /LISTEN/.test(plain));
check('docker недоступен — пометка, не падение', /docker недоступен|контейнеров нет/.test(plain));

console.log('\n== Аудит с привилегиями (sudo) ==');
const priv = await runSecurityAudit(profile, { privileged: true, sudoPassword: 'test123' });
console.log(priv);
check('нет сообщения о нерабочем sudo', !priv.includes('sudo не сработал'));
check('root-подсекции выполнены', !priv.includes('пропущено: нет прав'));
check('пароль не попал в вывод', !priv.includes('test123'));

console.log('\n== Аудит с неверным sudo-паролем ==');
const wrong = await runSecurityAudit(profile, { privileged: true, sudoPassword: 'wrong-pass' });
check('sudo не сработал — деградация', wrong.includes('sudo не сработал') && wrong.includes('пропущено: нет прав'));

console.log('\n== Запрос одной секции ==');
const one = await runSecurityAudit(profile, { sections: ['network'] });
check('только network', one.includes('## network') && !one.includes('## auth'));

console.log(failed === 0 ? '\nВСЁ OK' : `\nПРОВАЛОВ: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
