const fs = require('node:fs');
const path = require('node:path');
const { ActivationStore } = require('../lib/activation-store');
const { FeedbackStore } = require('../lib/feedback-store');

function validateDataDirectory(dataDirectory, requireExisting) {
  if (!requireExisting) {
    return;
  }

  let stats;
  try {
    stats = fs.statSync(dataDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`生产数据目录不存在：${dataDirectory}`);
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`生产数据路径不是目录：${dataDirectory}`);
  }

  const activationDatabase = path.join(dataDirectory, 'activation.db');
  if (!fs.existsSync(activationDatabase)) {
    throw new Error(`生产激活数据库不存在，拒绝创建空库：${activationDatabase}`);
  }
}

async function main(args = process.argv.slice(2)) {
  const unknownArguments = args.filter((argument) => argument !== '--require-existing');
  if (unknownArguments.length > 0) {
    throw new Error(`不支持的迁移参数：${unknownArguments.join(', ')}`);
  }

  process.umask(0o077);
  const dataDirectory = path.resolve(
    process.env.DESKPET_DATA_DIR || path.join(__dirname, '..', 'data')
  );
  validateDataDirectory(dataDirectory, args.includes('--require-existing'));
  const activationStore = new ActivationStore(dataDirectory);
  const feedbackStore = new FeedbackStore(dataDirectory);

  try {
    await activationStore.initialize();
    await feedbackStore.initialize();
    const result = {
      dataDirectory,
      activation: activationStore.migrationState,
      feedback: feedbackStore.migrationState
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    feedbackStore.close();
    activationStore.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main, validateDataDirectory };
