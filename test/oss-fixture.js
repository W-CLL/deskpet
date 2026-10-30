const crypto = require('node:crypto');
const fs = require('node:fs');
const OSS = require('ali-oss');
function ossOptions(domain = 'download.example.com') {
  return {ossRegion:'oss-cn-hangzhou',ossEndpoint:'oss-cn-hangzhou.aliyuncs.com',ossBucket:'test-bucket',
    ossAccessKeyId:'test-id',ossAccessKeySecret:'test-secret',ossPrefix:'releases',ossUrlExpires:900,ossDownloadDomain:domain};
}
function mockClient() {
  const client = new OSS({region:'oss-cn-hangzhou',endpoint:'oss-cn-hangzhou.aliyuncs.com',
    bucket:'test-bucket',accessKeyId:'test-id',accessKeySecret:'test-secret',secure:true});
  client.objects = new Map();
  client.putCount = 0;
  client.headCount = 0;
  client.head = async (key) => {
    client.headCount++;
    if (client.failure) throw client.failure;
    const object = client.objects.get(key);
    if (!object) throw Object.assign(new Error('Missing'),{status:404,code:'NoSuchKey'});
    return {res:{headers:{'content-length':String(object.bytes.length),etag:crypto.createHash('md5').update(object.bytes).digest('hex')}},
      meta:object.sha256 ? {sha256:object.sha256} : null};
  };
  client.put = async (key, file, options) => {
    client.putCount++;
    if (client.failure) throw client.failure;
    if (client.objects.has(key)) throw Object.assign(new Error('Exists'),{status:409});
    const bytes = await fs.promises.readFile(file);
    client.objects.set(key,{bytes,sha256:options.headers['x-oss-meta-sha256']});
    return {res:{status:200}};
  };
  return client;
}
module.exports = {ossOptions,mockClient};
