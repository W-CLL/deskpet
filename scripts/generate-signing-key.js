const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.umask(0o077);

async function main() {
  const dataDirectory = path.resolve(
    process.env.DESKPET_DATA_DIR || path.join(__dirname, '..', 'data')
  );
  const privateKeyPath = path.resolve(
    process.env.DESKPET_SIGNING_PRIVATE_KEY || path.join(dataDirectory, 'signing-private.pem')
  );
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });

  await fs.promises.mkdir(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(privateKeyPath, privatePem, { flag: 'wx', mode: 0o600 });
  console.log(`签名私钥已写入：${privateKeyPath}`);
  console.log(`客户端公钥（SPKI DER Base64）：${publicDer.toString('base64')}`);
  console.log('发布客户端前，必须把上面的公钥配置到客户端更新校验代码中。');
}

main().catch((error) => {
  if (error.code === 'EEXIST') {
    console.error('签名私钥已存在，已拒绝覆盖。');
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
