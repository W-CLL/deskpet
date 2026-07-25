const fs = require('node:fs');

class PublicController {
  constructor({ authService, activationService, releaseService, releaseStore }) {
    this.authService = authService;
    this.activationService = activationService;
    this.releaseService = releaseService;
    this.releaseStore = releaseStore;
    this.startedAt = new Date().toISOString();
  }

  async health(_req, res) {
    res.status(200).json({
      ok: true,
      service: 'deskpet-update',
      startedAt: this.startedAt,
      configured: await this.authService.isConfigured(),
      activeVersion: this.releaseStore.data.activeVersion
    });
  }

  async activate(req, res) {
    res.status(200).json(await this.activationService.activate(req, req.body));
  }

  latest(req, res) {
    res.status(200).json(this.releaseService.latestManifest(req));
  }

  async download(req, res, next) {
    const item = await this.releaseService.download(req, req.params.fileName);
    res.status(item.range ? 206 : 200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Cache-Control',
      item.isBootstrap ? 'public, max-age=31536000, immutable' : 'private, no-store'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${item.release.fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('ETag', `"${item.release.sha256}"`);
    res.setHeader('X-Accel-Buffering', 'no');
    if (item.range) {
      res.setHeader(
        'Content-Range',
        `bytes ${item.range.start}-${item.range.end}/${item.size}`
      );
      res.setHeader('Content-Length', item.range.end - item.range.start + 1);
    } else {
      res.setHeader('Content-Length', item.size);
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(item.filePath, {
      ...(item.range || {}),
      highWaterMark: 1024 * 1024
    });
    stream.on('error', next);
    stream.pipe(res);
  }
}

module.exports = { PublicController };
