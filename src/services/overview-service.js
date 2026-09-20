function daysAgoIso(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function percent(part, total) {
  const a = Number(part) || 0;
  const b = Number(total) || 0;
  if (b <= 0) return 0;
  return Math.round((a / b) * 1000) / 10;
}

class OverviewService {
  constructor({
    analyticsService,
    activationService,
    feedbackService,
    contentService,
    resourcePackService,
    companionService,
    releaseService
  }) {
    this.analyticsService = analyticsService;
    this.activationService = activationService;
    this.feedbackService = feedbackService;
    this.contentService = contentService;
    this.resourcePackService = resourcePackService;
    this.companionService = companionService;
    this.releaseService = releaseService;
  }

  async build() {
    const from = daysAgoIso(6);
    const to = daysAgoIso(0);
    const analytics = this.analyticsService.summary({ from, to });
    const usage = this.analyticsService.usageSummary(this.activationService.devices());
    const activations = this.activationService.list();
    const feedback = this.feedbackService.listAll();
    const content = this.contentService.listAll();
    const packs = this.resourcePackService.list();
    const companions = await this.companionService.adminStats();
    const releases = this.releaseService.list();

    const funnel = analytics.funnel || {};
    const contentSummary = content.summary || {};
    const feedbackSummary = feedback.summary || {};
    const activationSummary = activations.summary || {};
    const companionSummary = companions.summary || {};

    const pageViews = Number(funnel.pageViews || 0);
    const downloadClicks = Number(funnel.downloadClicks || 0);
    const uniqueVisitors = Number(funnel.uniqueVisitors || 0);

    const activeContent = Number(contentSummary.active || 0);
    const totalContent = Number(contentSummary.total || 0);
    const pendingFeedback = Number(feedbackSummary.pending || 0)
      + Number(feedbackSummary.inProgress || 0);

    const packList = packs.packs || packs || [];
    const wordPacks = packList.filter((item) => item.category === 'interaction-words').length;
    const theaterPacks = packList.filter((item) => item.category === 'theater-scripts').length;

    const activeVersions = releases.activeVersions || {};
    const draftCount = (releases.releases || []).filter((item) => !item.publishedAt).length;
    const publishedCount = (releases.releases || []).filter((item) => Boolean(item.publishedAt)).length;

    return {
      generatedAt: new Date().toISOString(),
      range: { from, to },
      ops: {
        pageViews7d: pageViews,
        uniqueVisitors7d: uniqueVisitors,
        downloadClicks7d: downloadClicks,
        clickRate7d: Number(funnel.clickRate || 0),
        unusedCodes: Number(activationSummary.unused || 0),
        activeLicenses: Number(activationSummary.active || 0),
        accounts: Number(activationSummary.accounts || 0),
        pendingFeedback,
        companionPending: Number(companionSummary.pending || 0),
        companionReceiptRate: companionSummary.receiptRate ?? null
      },
      content: {
        catalogVersion: Number(content.catalog?.version || 0),
        total: totalContent,
        active: activeContent,
        disabled: Number(contentSummary.disabled || 0),
        activeRate: percent(activeContent, totalContent),
        byType: {
          joke: Number(contentSummary.jokes || 0),
          math: Number(contentSummary.math || 0),
          trivia: Number(contentSummary.trivia || 0),
          riddle: Number(contentSummary.riddles || 0),
          tip: Number(contentSummary.tips || 0),
          care: Number(contentSummary.care || 0)
        },
        resourcePacks: {
          total: packList.length,
          words: wordPacks,
          theater: theaterPacks
        }
      },
      tech: {
        onlineDevices: Number(usage.summary?.onlineDevices || 0),
        activeAuthorizedDevices: Number(usage.summary?.activeAuthorizedDevices || 0),
        inactive7Days: Number(usage.summary?.inactive7Days || 0),
        activeVersions,
        releaseCounts: {
          published: publishedCount,
          drafts: draftCount,
          total: (releases.releases || []).length
        }
      },
      todos: [
        {
          id: 'feedback',
          page: 'feedback',
          title: '待处理反馈',
          detail: pendingFeedback > 0 ? `${pendingFeedback} 条待处理/进行中` : '暂无积压'
        },
        {
          id: 'releases',
          page: 'releases',
          title: '版本草稿',
          detail: draftCount > 0 ? `${draftCount} 个草稿待发布` : '没有待发布草稿'
        },
        {
          id: 'activations',
          page: 'activations',
          title: '未使用激活码',
          detail: `${Number(activationSummary.unused || 0)} 个可发放`
        },
        {
          id: 'companions',
          page: 'companions',
          title: '搭子领取',
          detail: Number(companionSummary.pending || 0) > 0
            ? `${companionSummary.pending} 条待领取`
            : '投递队列正常'
        },
        {
          id: 'content',
          page: 'content',
          title: '内容库',
          detail: `启用率 ${percent(activeContent, totalContent)}% · 目录 v${content.catalog?.version || 0}`
        }
      ]
    };
  }
}

module.exports = { OverviewService };
