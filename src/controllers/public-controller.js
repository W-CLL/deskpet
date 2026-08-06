const fs = require('node:fs');

class PublicController {
  constructor({
    authService,
    activationService,
    feedbackService,
    interactionService,
    contentService,
    releaseService,
    releaseStore,
    analyticsService
  }) {
    this.authService = authService;
    this.activationService = activationService;
    this.feedbackService = feedbackService;
    this.interactionService = interactionService;
    this.contentService = contentService;
    this.releaseService = releaseService;
    this.releaseStore = releaseStore;
    this.analyticsService = analyticsService;
    this.startedAt = new Date().toISOString();
  }

  async health(_req, res) {
    res.status(200).json({
      ok: true,
      service: 'deskpet-update',
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      configured: await this.authService.isConfigured(),
      activeVersion: this.releaseStore.data.activeVersions['windows/x64'] || null,
      activeVersions: this.releaseStore.data.activeVersions
    });
  }

  async activate(req, res) {
    res.status(200).json(await this.activationService.activate(req, req.body));
  }

  feedback(req, res) {
    res.status(200).json(this.feedbackService.listForDevice(req));
  }

  async submitFeedback(req, res) {
    res.status(201).json(await this.feedbackService.submit(req, req.body));
  }

  interactionProfile(req, res) {
    res.status(200).json(this.interactionService.profile(req));
  }

  updateInteractionProfile(req, res) {
    res.status(200).json(this.interactionService.updateProfile(req, req.body));
  }

  interactionStats(req, res) {
    res.status(200).json(this.interactionService.stats(req));
  }

  recordInteractionEvents(req, res) {
    res.status(200).json(this.interactionService.recordEvents(req, req.body));
  }

  contentBatch(req, res) {
    res.status(200).json(this.contentService.batch(req, req.body));
  }

  contentOfflinePack(req, res) {
    const payload = this.contentService.offlinePack(req);
    const etag = `"${payload.sha256}"`;
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).json(payload);
  }

  latest(req, res) {
    res.status(200).json(this.releaseService.latestManifest(req));
  }

  publicDownloads(_req, res) {
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      downloads: this.releaseService.publicDownloads()
    });
  }

  latestDownload(req, res) {
    const release = this.releaseService.publicDownload(req.params.platform, req.params.architecture);
    res.redirect(302, `/downloads/${encodeURIComponent(release.fileName)}`);
  }

  async analytics(req, res) {
    res.status(202).json(await this.analyticsService.recordPublic(req, req.body));
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
