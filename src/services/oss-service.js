const crypto = require('node:crypto');
const fs = require('node:fs');
const OSS = require('ali-oss');
const { HttpError } = require('../errors/http-error');

function errorCode(error) {
  const code = String(error?.code || 'OSS_SYNC_FAILED');
  return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code) ? code : 'OSS_SYNC_FAILED';
}
function missing(error) { return error?.status === 404 || error?.code === 'NoSuchKey'; }

class OssService {
  constructor(config, {store, client} = {}) {
    this.config = config;
    this.store = store;
    this.inflight = new Map();
    const options = config.oss && {
      region:config.oss.region, endpoint:config.oss.endpoint, bucket:config.oss.bucket,
      accessKeyId:config.oss.accessKeyId, accessKeySecret:config.oss.accessKeySecret,
      secure:true, timeout:180000
    };
    this.client = config.oss ? (client || new OSS(options)) : null;
    this.downloadClient = this.client && config.oss.downloadDomain
      ? new OSS({...options, endpoint:`https://${config.oss.downloadDomain}`, cname:true})
      : this.client;
    this.signingContext = crypto.createHash('sha256')
      .update(JSON.stringify(config.oss || {})).digest('hex');
  }
  get enabled() { return Boolean(this.client); }
  objectKey(release) {
    const name = `${release.platform}/${release.architecture}/${release.version}/${release.fileName}`;
    const prefix = String(this.config.oss?.prefix || '').replace(/^\/+|\/+$/g, '');
    return prefix ? `${prefix}/${name}` : name;
  }
  identity(release) {
    const {bucket, endpoint} = this.config.oss;
    const objectKey = this.objectKey(release);
    const id = crypto.createHash('sha256').update(JSON.stringify([bucket,endpoint,objectKey,release.sha256,release.size])).digest('hex');
    return {id, bucket, endpoint, objectKey, platform:release.platform, architecture:release.architecture,
      version:release.version, fileName:release.fileName, size:release.size, sha256:release.sha256};
  }
  status(release) {
    if (!this.enabled) return {status:'disabled'};
    const record = this.store?.get(this.identity(release).id);
    if (!record) return {status:'pending'};
    const link = this.store.link(record.id, 'GET');
    const currentLink = link?.signingContext === this.signingContext ? link : null;
    return {...record, attempts:this.store.attempts(record.id),
      downloadDomain:this.config.oss.downloadDomain || '',
      urlExpiresAt:currentLink ? new Date(currentLink.expiresAt).toISOString() : null,
      urlRefreshedAt:currentLink?.refreshedAt || null};
  }
  async upload(release, filePath) {
    if (!this.enabled) return null;
    const record = this.identity(release);
    if (this.inflight.has(record.id)) return this.inflight.get(record.id);
    const pending = this.syncObject(record, filePath);
    this.inflight.set(record.id, pending);
    try { return await pending; }
    finally { this.inflight.delete(record.id); }
  }
  async syncObject(record, filePath) {
    const attempt = this.store?.begin(record);
    try {
      const sha = crypto.createHash('sha256');
      const md5 = crypto.createHash('md5');
      let size = 0;
      for await (const chunk of fs.createReadStream(filePath)) { sha.update(chunk); md5.update(chunk); size += chunk.length; }
      const localMd5 = md5.digest('hex');
      if (size !== record.size || sha.digest('hex') !== record.sha256) {
        throw new HttpError(409, '安装包校验失败，未同步到 OSS', 'OSS_LOCAL_HASH_MISMATCH');
      }
      let head;
      try { head = await this.client.head(record.objectKey); }
      catch (error) { if (!missing(error)) throw error; }
      if (!head) {
        try {
          await this.client.put(record.objectKey, filePath, {headers:{
            'Content-Type':record.platform === 'android' ? 'application/vnd.android.package-archive' : 'application/octet-stream',
            'Content-Disposition':`attachment; filename="${record.fileName}"`,
            'Cache-Control':'private, no-store',
            'Content-MD5':Buffer.from(localMd5,'hex').toString('base64'),
            'x-oss-meta-sha256':record.sha256,
            'x-oss-forbid-overwrite':'true'
          }});
        } catch (error) {
          if (error.status !== 409) throw error;
        }
        head = await this.client.head(record.objectKey);
      }
      const headers = head.res?.headers || {};
      const etag = String(headers.etag || '').replaceAll('"','').toLowerCase();
      const remoteSha = head.meta?.sha256 || headers['x-oss-meta-sha256'];
      if (Number(headers['content-length']) !== record.size
        || (remoteSha ? remoteSha !== record.sha256 : etag !== localMd5)) {
        throw new HttpError(409, 'OSS 中同名对象与安装包不一致，已拒绝覆盖', 'OSS_OBJECT_MISMATCH');
      }
      this.store?.finish(record.id, attempt, {etag});
      this.sign(record, 'GET');
      return this.store?.get(record.id) || {...record,status:'uploaded',etag};
    } catch (error) {
      const code = errorCode(error);
      this.store?.finish(record.id, attempt, {errorCode:code});
      // SDK errors may contain request credentials; only expose a stable code.
      throw new HttpError(409, `OSS 同步失败（${code}），请检查配置后重试；当前版本未切换`, code);
    }
  }
  sign(record, method) {
    const cached = this.store?.link(record.id, method);
    const refreshAhead = Math.min(120, this.config.oss.urlExpires / 3) * 1000;
    if (cached?.signingContext === this.signingContext && cached.expiresAt > Date.now() + refreshAhead) return cached.url;
    const url = this.downloadClient.signatureUrl(record.objectKey, {
      method, expires:this.config.oss.urlExpires,
      response:{'content-disposition':`attachment; filename="${record.fileName}"`,'cache-control':'private, no-store'}
    });
    const expiresAt = Number(new URL(url).searchParams.get('Expires')) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid OSS signature expiry');
    this.store?.saveLink(record.id,method,this.signingContext,url,expiresAt);
    return url;
  }
  async downloadUrl(release, filePath, method = 'GET') {
    if (!this.enabled) return null;
    const record = this.identity(release);
    if (this.store?.get(record.id)?.status !== 'uploaded') await this.upload(release, filePath);
    return this.sign(record, method === 'HEAD' ? 'HEAD' : 'GET');
  }
  refreshDownloadLinks(releases) {
    if (!this.enabled) return;
    for (const release of releases) {
      if (!release.publishedAt) continue;
      const record = this.identity(release);
      if (this.store?.get(record.id)?.status !== 'uploaded') continue;
      this.sign(record, 'GET');
      if (this.store.link(record.id, 'HEAD')) this.sign(record, 'HEAD');
    }
  }
}
module.exports = { OssService };
