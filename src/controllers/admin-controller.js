const { HttpError } = require('../errors/http-error');
const { queryValue } = require('../http/request-context');

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{20,80}$/;
const CONTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireParam(value, pattern) {
  if (!pattern.test(String(value || ''))) {
    throw new HttpError(404, 'Not found', 'NOT_FOUND');
  }
  return value;
}

class AdminController {
  constructor({
    authService,
    activationService,
    releaseService,
    feedbackService,
    interactionService,
    contentService,
    analyticsService,
    resourcePackService,
    companionService,
    visitStickerService
  }) {
    this.authService = authService;
    this.activationService = activationService;
    this.releaseService = releaseService;
    this.feedbackService = feedbackService;
    this.interactionService = interactionService;
    this.contentService = contentService;
    this.analyticsService = analyticsService;
    this.resourcePackService = resourcePackService;
    this.companionService = companionService;
    this.visitStickerService = visitStickerService;
  }

  async login(req, res) {
    const result = await this.authService.login(req, req.body);
    res.setHeader('Set-Cookie', result.cookie);
    res.status(200).json(result.payload);
  }

  session(req, res) {
    res.status(200).json(this.authService.getSession(req));
  }

  async logout(req, res) {
    const result = await this.authService.logout(req);
    res.setHeader('Set-Cookie', result.cookie);
    res.status(200).json(result.payload);
  }

  releases(_req, res) {
    res.status(200).json(this.releaseService.list());
  }

  siteSettings(_req, res) {
    res.status(200).json(this.releaseService.siteSettings());
  }

  async updateSiteSettings(req, res) {
    res.status(200).json(await this.releaseService.updateSiteSettings(req, req.body));
  }

  activationCodes(_req, res) {
    res.status(200).json(this.activationService.list());
  }

  async createActivationCodes(req, res) {
    const generated = await this.activationService.createCodes(req, req.body);
    res.status(201).json(generated);
  }

  async revealActivationCode(req, res) {
    const codeId = requireParam(req.params.id, UUID_PATTERN);
    res.status(200).json(await this.activationService.reveal(req, codeId));
  }

  async revokeLicense(req, res) {
    const licenseId = requireParam(req.params.id, UUID_PATTERN);
    res.status(200).json(await this.activationService.revoke(req, licenseId));
  }

  async createRebindCode(req, res) {
    const accountId = requireParam(req.params.id, UUID_PATTERN);
    res.status(201).json(await this.activationService.createRebindCode(
      req,
      accountId,
      req.body
    ));
  }

  feedback(_req, res) {
    res.status(200).json(this.feedbackService.listAll());
  }

  interactions(_req, res) {
    res.status(200).json(this.interactionService.listAll());
  }

  async companions(_req, res) {
    res.status(200).json(await this.companionService.adminStats());
  }

  async sendCompanionDelivery(req, res) {
    res.status(201).json(await this.companionService.adminSend(req, req.body, {
      senderAccountId: queryValue(req, 'senderAccountId'),
      recipientLicenseId: queryValue(req, 'recipientLicenseId'),
      message: queryValue(req, 'message')
    }));
  }

  analytics(req, res) {
    res.status(200).json({
      ...this.analyticsService.summary({
        from: queryValue(req, 'from') || undefined,
        to: queryValue(req, 'to') || undefined
      }),
      usage: this.analyticsService.usageSummary(this.activationService.devices())
    });
  }

  content(_req, res) {
    res.status(200).json(this.contentService.listAll());
  }

  async createContent(req, res) {
    res.status(201).json(await this.contentService.create(req, req.body));
  }

  async updateContent(req, res) {
    const contentId = requireParam(req.params.id, CONTENT_ID_PATTERN);
    res.status(200).json(await this.contentService.update(req, contentId, req.body));
  }

  async disableContent(req, res) {
    const contentId = requireParam(req.params.id, CONTENT_ID_PATTERN);
    res.status(200).json(await this.contentService.disable(req, contentId));
  }

  async bulkDisableContent(req, res) {
    res.status(200).json(await this.contentService.bulkDisable(req, req.body));
  }

  async importContent(req, res) {
    res.status(200).json(await this.contentService.import(req, req.body));
  }

  async updateFeedback(req, res) {
    const feedbackId = requireParam(req.params.id, UUID_PATTERN);
    res.status(200).json(await this.feedbackService.updateStatus(req, feedbackId, req.body));
  }

  resourcePacks(_req, res) {
    res.status(200).json(this.resourcePackService.list());
  }

  createResourcePackUpload(req, res) {
    res.status(201).json(this.resourcePackService.createUpload(req.body, res.locals.adminSession));
  }

  async receiveResourcePackUpload(req, res) {
    const uploadId = requireParam(req.params.uploadId, UPLOAD_ID_PATTERN);
    res.status(201).json(await this.resourcePackService.receiveUpload(
      req,
      uploadId,
      res.locals.adminSession
    ));
  }

  async deleteResourcePack(req, res) {
    const id = requireParam(req.params.id, UUID_PATTERN);
    res.status(200).json(await this.resourcePackService.delete(req, id));
  }

  visitStickers(_req, res) {
    res.status(200).json(this.visitStickerService.adminList());
  }

  createVisitStickerUpload(req, res) {
    res.status(201).json(this.visitStickerService.createUpload(req.body, res.locals.adminSession));
  }

  async receiveVisitStickerUpload(req, res) {
    const uploadId = requireParam(req.params.uploadId, UPLOAD_ID_PATTERN);
    res.status(201).json(await this.visitStickerService.receiveUpload(
      req,
      uploadId,
      res.locals.adminSession
    ));
  }

  async deleteVisitStickerPack(req, res) {
    const id = requireParam(req.params.id, UUID_PATTERN);
    res.status(200).json(await this.visitStickerService.deletePack(req, id));
  }

  async deleteVisitSticker(req, res) {
    const id = requireParam(req.params.id, UUID_PATTERN);
    res.status(200).json(await this.visitStickerService.deleteSticker(req, id));
  }

  createUpload(req, res) {
    const payload = this.releaseService.createUpload(req.body, res.locals.adminSession);
    res.status(201).json(payload);
  }

  async receiveUpload(req, res) {
    const uploadId = requireParam(req.params.uploadId, UPLOAD_ID_PATTERN);
    const payload = await this.releaseService.receiveUpload(
      req,
      uploadId,
      res.locals.adminSession
    );
    res.status(201).json(payload);
  }

  async publish(req, res) {
    res.status(200).json(await this.releaseService.publish(
      req,
      req.params.platform,
      req.params.architecture,
      req.params.version
    ));
  }

  async delete(req, res) {
    res.status(200).json(await this.releaseService.delete(
      req,
      req.params.platform,
      req.params.architecture,
      req.params.version
    ));
  }
}

module.exports = { AdminController };
