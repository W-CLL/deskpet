const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config/app-config');
const { OssService } = require('../src/services/oss-service');
const { OssUploadStore } = require('../lib/oss-upload-store');
const {ossOptions,mockClient} = require('./oss-fixture');
const config = (domain='') => loadConfig({publicUrl:'http://127.0.0.1:3110',...ossOptions(domain)});
async function fixture(t, domain='download.example.com') {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(),'deskpet-oss-'));
  const store = new OssUploadStore(directory);
  await store.initialize();
  t.after(async()=>{store.close();await fs.promises.rm(directory,{recursive:true,force:true});});
  const bytes = Buffer.from('local release test');
  const file = path.join(directory,'package.apk');
  await fs.promises.writeFile(file,bytes);
  const release = {platform:'android',architecture:'arm64-v8a',version:'1.4.0',
    fileName:'ZhuoDazi-Android-1.4.0-arm64.apk',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),publishedAt:new Date().toISOString()};
  const client=mockClient();
  const service=new OssService(config(domain),{store,client});
  return {directory,store,bytes,file,release,client,service};
}
test('OSS custom download domain accepts only an HTTPS origin',()=>{
  assert.equal(config('https://DOWNLOAD.example.com/').oss.downloadDomain,'download.example.com');
  assert.equal(config('').oss.downloadDomain,'');
  for (const value of ['http://download.example.com','https://user:pass@download.example.com',
    'download.example.com/files','download.example.com?token=1','download.example.com#file','download.example.com:8443','download..example.com']) {
    assert.throws(()=>config(value),/OSS_DOWNLOAD_DOMAIN/);
  }
});
test('OSS sync persists an upload and signs CNAME requests without changing the upload endpoint',async t=>{
  const {service,store,release,file,client}=await fixture(t);
  const url=new URL(await service.downloadUrl(release,file));
  const record=store.get(service.identity(release).id);
  assert.equal(record.status,'uploaded');
  assert.equal(record.sha256,release.sha256);
  assert.equal(record.objectKey,service.objectKey(release));
  assert.equal(client.putCount,1);
  assert.equal(url.origin,'https://download.example.com');
  assert.equal(client.options.endpoint.hostname,'oss-cn-hangzhou.aliyuncs.com');
  const resource='/test-bucket/'+service.objectKey(release)+'?response-cache-control=private, no-store&response-content-disposition='+url.searchParams.get('response-content-disposition');
  const expected=crypto.createHmac('sha1','test-secret').update('GET\n\n\n'+url.searchParams.get('Expires')+'\n'+resource).digest('base64');
  assert.equal(url.searchParams.get('Signature'),expected);
  assert.equal(store.attempts(record.id)[0].status,'uploaded');
  assert.equal(Object.hasOwn(service.status(release),'url'),false);
  await fs.promises.unlink(file);
  assert.equal(await service.downloadUrl(release,file),url.href);
});
test('OSS HEAD signs as HEAD, and standard endpoint is retained without CNAME',async t=>{
  const {service,release,file}=await fixture(t,'');
  const signed=new URL(await service.downloadUrl(release,file,'HEAD'));
  assert.equal(signed.origin,'https://test-bucket.oss-cn-hangzhou.aliyuncs.com');
  const resource='/test-bucket/'+service.objectKey(release)+'?response-cache-control=private, no-store&response-content-disposition='+signed.searchParams.get('response-content-disposition');
  const expected=crypto.createHmac('sha1','test-secret').update('HEAD\n\n\n'+signed.searchParams.get('Expires')+'\n'+resource).digest('base64');
  assert.equal(signed.searchParams.get('Signature'),expected);
});
test('OSS sync failures retain history, retry succeeds, and a different remote object is never overwritten',async t=>{
  const {service,store,release,file,client}=await fixture(t);
  client.failure=Object.assign(new Error('contains secret'),{status:403,code:'AccessDenied'});
  await assert.rejects(service.upload(release,file),e=>e.code==='AccessDenied'&&!e.message.includes('secret'));
  assert.equal(service.status(release).status,'failed');
  client.failure=null;
  await service.upload(release,file);
  assert.deepEqual(store.attempts(service.identity(release).id).map(a=>a.status),['uploaded','failed']);
  client.objects.set(service.objectKey(release),{bytes:Buffer.from('wrong')});
  await assert.rejects(service.upload(release,file),e=>e.code==='OSS_OBJECT_MISMATCH');
  assert.equal(client.putCount,1);
});
test('existing objects without metadata are adopted only after size and MD5 validation; corrupt local files fail',async t=>{
  const {service,release,file,client,bytes}=await fixture(t);
  client.objects.set(service.objectKey(release),{bytes});
  await service.upload(release,file);
  assert.equal(client.putCount,0);
  await fs.promises.writeFile(file,'corrupt');
  await assert.rejects(service.upload(release,file),e=>e.code==='OSS_LOCAL_HASH_MISMATCH');
});
test('OSS scheduled refresh renews early; expired links and credential/domain changes renew on demand',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-22T12:00:00Z')});
  const {service,store,release,file,client}=await fixture(t);
  const first=await service.downloadUrl(release,file);
  t.mock.timers.tick(790000);
  service.refreshDownloadLinks([release]);
  const id=service.identity(release).id;
  const refreshed=store.link(id,'GET').url;
  assert.notEqual(first,refreshed);
  assert.equal(await service.downloadUrl(release,file),refreshed);
  t.mock.timers.tick(1000000);
  assert.notEqual(await service.downloadUrl(release,file),refreshed);
  const changed=config('new-download.example.com');
  changed.oss.accessKeySecret='rotated-secret';
  const newService=new OssService(changed,{store,client});
  const rotated=new URL(await newService.downloadUrl(release,file));
  assert.equal(rotated.hostname,'new-download.example.com');
  assert.equal(client.putCount,1);
});
test('OSS upload deduplicates concurrent requests and upload history survives restarting the database',async t=>{
  const {service,store,release,file,client,directory}=await fixture(t);
  await Promise.all([service.upload(release,file),service.upload(release,file)]);
  assert.equal(client.putCount,1);
  const status=service.status(release);
  store.close();
  await store.initialize();
  assert.equal(store.get(status.id).status,'uploaded');
  assert.equal(store.attempts(status.id).length,1);
  assert.equal(store.databasePath,path.join(directory,'oss-uploads.db'));
});
