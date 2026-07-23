const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, validateNewPassword } = require('../lib/security');

process.umask(0o077);

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error('该命令必须在交互式终端中运行'));
      return;
    }
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('操作已取消'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function atomicWrite(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporaryPath, filePath);
}

async function main() {
  const dataDirectory = path.resolve(process.env.DESKPET_DATA_DIR || path.join(__dirname, '..', 'data'));
  const password = validateNewPassword(await readHidden('新管理员密码：'));
  const confirmation = await readHidden('再次输入密码：');
  if (password !== confirmation) throw new Error('两次输入的密码不一致');
  const authRecord = await hashPassword(password);
  await fs.promises.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(dataDirectory, 'auth.json'), authRecord);
  console.log('管理员密码已更新。');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
