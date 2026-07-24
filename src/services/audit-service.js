class AuditService {
  constructor(releaseStore) {
    this.releaseStore = releaseStore;
  }

  async write(entry) {
    await this.releaseStore.audit(entry).catch((error) => {
      console.error('audit-write-failed', error.message);
    });
  }
}

module.exports = { AuditService };
