// Commit semua perubahan lalu push ke remote.
// Pemakaian: npm run push -- "pesan commit"   (pesan opsional)
const { execFileSync } = require('child_process');

const run = (args, opts = {}) => execFileSync('git', args, { stdio: 'inherit', ...opts });
const message = process.argv.slice(2).join(' ') || `update ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

run(['add', '-A']);
try {
  execFileSync('git', ['diff', '--cached', '--quiet']);
  console.log('Tidak ada perubahan untuk di-commit.');
} catch {
  run(['commit', '-m', message]);
}
run(['push']);
