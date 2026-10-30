const fs = require('node:fs');
const { queryValue } = require('../http/request-context');

class PublicController {
  constructor({
    authService,
    activationService,
    feedbackService,
    interactionService,
    contentService,
    releaseService,
    releaseStore,
    analyticsService,
    resourcePackService,
    companionService,
    visitStickerService,
    petMarketService,
    uninstallService
  }) {
    this.authService = authService;
    this.activationService = activationService;
    this.feedbackService = feedbackService;
    this.interactionService = interactionService;
    this.contentService = contentService;
    this.releaseService = releaseService;
    this.releaseStore = releaseStore;
    this.analyticsService = analyticsService;
    this.resourcePackService = resourcePackService;
    this.companionService = companionService;
    this.visitStickerService = visitStickerService;
    this.petMarketService = petMarketService;
    this.uninstallService = uninstallService;
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
    const result = await this.activationService.activate(req, req.body);
    res.locals.activatedLicense = result;
    res.status(200).json(result);
  }

  async trial(req, res) {
    const result = await this.activationService.trial(req, req.body);
    res.locals.activityDevice = this.activationService.identifyActivityDevice(req.body);
    res.status(200).json(result);
  }

  heartbeat(req, res) {
    res.locals.activityDevice = this.activationService.heartbeat(req, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, serverTime: new Date().toISOString() });
  }

  async installEvent(req, res) {
    const result = await this.uninstallService.record(req, req.body);
    if (req.body?.eventType !== 'uninstall_completed') {
      res.locals.activityDevice = this.activationService.identifyActivityDevice(req.body);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
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

  companionProfile(req, res) {
    res.status(200).json(this.companionService.profile(req));
  }

  companionHall(req, res) {
    res.status(200).json(this.companionService.hall(req));
  }

  updateCompanionHall(req, res) {
    res.status(200).json(this.companionService.updateHall(req, req.body));
  }

  updateCompanionProfile(req, res) {
    res.status(200).json(this.companionService.updateProfile(req, req.body));
  }

  pairCompanion(req, res) {
    res.status(200).json(this.companionService.pair(req, req.body));
  }

  unpairCompanion(req, res) {
    res.status(200).json(this.companionService.unpair(req));
  }

  async sendCompanionGif(req, res) {
    res.status(201).json(await this.companionService.send(req, req.body));
  }

  async sendHallCompanionGif(req, res) {
    res.status(201).json(await this.companionService.sendHall(
      req,
      req.body,
      req.params.recipientId,
      queryValue(req, 'message')
    ));
  }

  companionDeliveries(req, res) {
    res.status(200).json(this.companionService.pending(req));
  }

  companionDeliveryFile(req, res) {
    const item = this.companionService.file(req);
    res.status(200);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', item.size);
    res.setHeader('ETag', `"${item.sha256}"`);
    res.sendFile(item.filePath);
  }

  acknowledgeCompanionDelivery(req, res) {
    res.status(200).json(this.companionService.acknowledge(req));
  }

  trialVisitCatalog(req, res) {
    this.visitStickerService.requireTrial(req);
    res.status(200).json(this.visitStickerService.catalog(req));
  }

  playTrialVisit(req, res) {
    const result = this.visitStickerService.play(req, req.body);
    res.locals.usageFeature = {
      feature: 'trial_visit',
      category: result.category,
      detail: result.id
    };
    res.status(200).json(result);
  }

  trialVisitFile(req, res) {
    const item = this.visitStickerService.file(req, req.params.id);
    res.status(200);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', item.size);
    res.setHeader('ETag', `"${item.sha256}"`);
    res.sendFile(item.filePath);
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

  publicSiteSettings(_req, res) {
    res.status(200).json(this.releaseService.siteSettings());
  }

  publicResourcePacks(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      packs: this.resourcePackService.publicList(queryValue(req, 'category') || queryValue(req, 'kind'))
    });
  }

  async downloadResourcePack(req, res, next) {
    const item = await this.resourcePackService.download(req.params.id);
    const safeName = item.pack.originalName.replace(/[^A-Za-z0-9._-]/g, '_') || 'resource-pack.zip';
    res.status(200);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(item.pack.originalName)}`
    );
    res.setHeader('Content-Length', item.size);
    res.setHeader('ETag', `"${item.pack.sha256}"`);
    res.setHeader('X-Accel-Buffering', 'no');
    res.end(item.bytes);
  }

  petMarketCatalog(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(this.petMarketService.catalog(req));
  }

  async petMarketPreview(req, res) {
    const item = await this.petMarketService.preview(
      req.params.id,
      req.params.version,
      queryValue(req, 'file')
    );
    res.status(200);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', item.bytes.length);
    res.setHeader('ETag', `"${item.file.sha256}"`);
    res.send(item.bytes);
  }

  petMarketClaim(req, res) {
    res.status(200).json(this.petMarketService.claim(req, req.params.id));
  }

  petMarketCreateOrder(req, res) {
    const result = this.petMarketService.createOrder(req, req.body);
    res.status(result.reused ? 200 : 201).json(result);
  }

  petMarketOrders(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(this.petMarketService.listOrders(req, queryValue(req, 'cursor')));
  }

  petMarketOrder(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(this.petMarketService.getOrder(req, req.params.id));
  }

  petMarketCancelOrder(req, res) {
    res.status(200).json(this.petMarketService.cancelOrder(req, req.params.id));
  }

  petMarketPaymentEvent(req, res) {
    res.status(200).json(this.petMarketService.paymentEvent(req, req.body));
  }

  petMarketPaymentHeartbeat(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(this.petMarketService.paymentHeartbeat(req, req.body));
  }

  petMarketDownloadDescriptor(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(this.petMarketService.downloadDescriptor(req, req.params.id));
  }

  petMarketAuthorizeUse(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(this.petMarketService.authorizeUse(req, req.params.id));
  }

  async petMarketDownload(req, res, next) {
    const item = this.petMarketService.download(req, req.params.id, req.params.version);
    const stat = await fs.promises.stat(item.filePath);
    const safeName = item.version.fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'deskpet.zip';
    res.status(200);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(item.version.fileName)}`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('ETag', `"${item.version.sha256}"`);
    res.setHeader('X-Accel-Buffering', 'no');
    const stream = fs.createReadStream(item.filePath, { highWaterMark: 1024 * 1024 });
    stream.on('error', next);
    stream.pipe(res);
  }

  latestDownload(req, res) {
    const release = this.releaseService.publicDownload(req.params.platform, req.params.architecture);
    res.redirect(302, `/downloads/${encodeURIComponent(release.fileName)}`);
  }

  async analytics(req, res) {
    res.status(202).json(await this.analyticsService.recordPublic(req, req.body));
  }

  async download(req, res, next) {
    res.vary('User-Agent');
    res.vary('X-DeskPet-Platform');
    const item = await this.releaseService.download(req, req.params.fileName);
    res.locals.releaseDownload = item.release;
    if (item.redirectUrl) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.locals.ossRedirect = true;
      res.redirect(302, item.redirectUrl);
      return;
    }
    res.status(item.range ? 206 : 200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Cache-Control',
      item.isBootstrap ? 'public, max-age=31536000, immutable' : 'private, no-store'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${item.release.fileName}"`);
    res.setHeader(
      'Content-Type',
      item.release.platform === 'android'
        ? 'application/vnd.android.package-archive'
        : 'application/octet-stream'
    );
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
