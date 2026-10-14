const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const { AITextService } = require('./ai-text-service');
const { assertValidYouTubeMetadata } = require('./youtube-metadata-validator');
const { Logger } = require('./logger');

const DEFAULT_PARENT_FOLDER_ID = '1PVOAlPtbJXLsS0L8J-cULdVGXr2B-ih5';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

class GoogleDriveVideoSync {
  constructor(credentials, options = {}) {
    this.credentials = credentials;
    this.logger = options.logger || new Logger('GoogleDriveVideoSync');
    this.folderId = String(process.env.DRIVE_FOLDER_ID || DEFAULT_PARENT_FOLDER_ID).trim();
    this.pollMs = Math.max(60, Number(process.env.DRIVE_POLL_INTERVAL_SECONDS || 300)) * 1000;
    this.publishDelayMinutes = Math.max(0, Number(process.env.DRIVE_PUBLISH_DELAY_MINUTES ?? 30));
    this.ai = new AITextService(credentials?.credentials || {});
    this.drive = null;
    this.youtube = null;
    this.uploadedFolderId = null;
    this.timer = null;
    this.running = false;
    this.inFlight = false;
  }

  isEnabled() {
    return String(process.env.DRIVE_SYNC_ENABLED || 'false').toLowerCase() === 'true';
  }

  async initialize() {
    if (!this.isEnabled()) return false;
    if (!this.folderId) throw new Error('DRIVE_FOLDER_ID is required when Drive sync is enabled');
    if (!this.ai.isAvailable()) throw new Error('Configure an OpenAI/Gemini text provider before enabling Drive sync');
    if (!this.credentials?.getYouTubeAuth) throw new Error('YouTube OAuth credentials are not configured');

    const credentialsJson = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
    const credentialsPath = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE;
    let authOptions;
    if (credentialsJson) {
      let parsed;
      try { parsed = JSON.parse(credentialsJson); } catch (_error) {
        throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON must contain valid JSON');
      }
      authOptions = { credentials: parsed, scopes: ['https://www.googleapis.com/auth/drive'] };
    } else if (credentialsPath) {
      authOptions = { keyFile: path.resolve(credentialsPath), scopes: ['https://www.googleapis.com/auth/drive'] };
    } else {
      throw new Error('Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE');
    }

    const driveAuth = new google.auth.GoogleAuth(authOptions);
    this.drive = google.drive({ version: 'v3', auth: await driveAuth.getClient() });
    this.youtube = google.youtube({ version: 'v3', auth: this.credentials.getYouTubeAuth() });
    await this.assertFolderAccess();
    this.uploadedFolderId = await this.ensureChildFolder('Uploaded');
    this.timer = setInterval(() => { void this.poll().catch(error => this.logger.error('Drive sync poll failed:', error)); }, this.pollMs);
    this.timer.unref?.();
    this.logger.info(`Google Drive sync enabled for folder ${this.folderId}; polling every ${Math.round(this.pollMs / 1000)}s`);
    void this.poll().catch(error => this.logger.error('Initial Drive sync poll failed:', error));
    return true;
  }

  async assertFolderAccess() {
    const response = await this.drive.files.get({ fileId: this.folderId, fields: 'id,name,mimeType,capabilities(canAddChildren)' });
    if (response.data.mimeType !== 'application/vnd.google-apps.folder') throw new Error('DRIVE_FOLDER_ID must point to a Google Drive folder');
    if (response.data.capabilities?.canAddChildren === false) throw new Error('The Drive service account needs Editor access to the configured parent folder');
  }

  async ensureChildFolder(name) {
    const response = await this.drive.files.list({
      q: `'${this.folderId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      pageSize: 100,
      fields: 'files(id,name)'
    });
    const existing = (response.data.files || []).find(file => file.name === name);
    if (existing) return existing.id;
    const created = await this.drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [this.folderId] },
      fields: 'id,name'
    });
    this.logger.info(`Created Drive destination folder: ${name}`);
    return created.data.id;
  }

  async poll() {
    if (this.inFlight || !this.drive || !this.youtube) return;
    this.inFlight = true;
    try {
      const response = await this.drive.files.list({
        q: `'${this.folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        pageSize: 100,
        orderBy: 'createdTime',
        fields: 'files(id,name,mimeType,size,appProperties,parents,webViewLink)'
      });
      for (const file of response.data.files || []) {
        if (!this.isVideo(file)) continue;
        const state = file.appProperties?.youtubeAutomationStatus;
        if (file.appProperties?.youtubeVideoId || state === 'uploading') continue;
        try {
          await this.processFile(file);
        } catch (error) {
          this.logger.error(`Drive video failed (${file.name}):`, error);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  isVideo(file) {
    return String(file.mimeType || '').startsWith('video/') ||
      VIDEO_EXTENSIONS.has(path.extname(file.name || '').toLowerCase());
  }

  async updateProperties(fileId, appProperties) {
    await this.drive.files.update({
      fileId,
      requestBody: { appProperties },
      fields: 'id,appProperties'
    });
  }

  async processFile(file) {
    const currentProps = file.appProperties || {};
    await this.updateProperties(file.id, {
      ...currentProps,
      youtubeAutomationStatus: 'processing',
      youtubeAutomationUpdatedAt: new Date().toISOString()
    });

    const tempPath = path.join(os.tmpdir(), `drive-video-${file.id}-${path.basename(file.name)}`);
    try {
      const download = await this.drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(tempPath);
        download.data.on('error', reject);
        output.on('error', reject);
        output.on('finish', resolve);
        download.data.pipe(output);
      });
      const stats = await fsp.stat(tempPath);
      if (!stats.size) throw new Error('Downloaded video is empty');

      const seo = await this.generateMetadata(file.name);
      const metadata = assertValidYouTubeMetadata(seo).value;
      const delayMs = this.publishDelayMinutes > 0 ? Math.max(this.publishDelayMinutes, 15) * 60 * 1000 : 0;
      const publishAt = new Date(Date.now() + delayMs).toISOString();
      const videoStatus = { privacyStatus: 'private', selfDeclaredMadeForKids: false };
      if (delayMs >= 15 * 60 * 1000) videoStatus.publishAt = publishAt;

      // Persist an in-progress marker before upload. If the upload outcome is uncertain,
      // subsequent polls skip the file instead of risking a duplicate YouTube upload.
      await this.updateProperties(file.id, {
        ...currentProps,
        youtubeAutomationStatus: 'uploading',
        youtubeAutomationStartedAt: new Date().toISOString()
      });

      let upload;
      try {
        upload = await this.youtube.videos.insert({
          part: 'snippet,status',
          requestBody: {
            snippet: {
              title: metadata.title,
              description: metadata.description,
              tags: metadata.tags,
              categoryId: metadata.categoryId,
              defaultLanguage: metadata.defaultLanguage,
              defaultAudioLanguage: metadata.defaultAudioLanguage
            },
            status: videoStatus
          },
          media: { body: fs.createReadStream(tempPath) }
        });
      } catch (error) {
        const status = Number(error.status || error.response?.status || 0);
        if (status && status < 500) {
          await this.updateProperties(file.id, {
            ...currentProps,
            youtubeAutomationStatus: 'failed',
            youtubeAutomationError: String(error.message || 'Upload failed').slice(0, 500),
            youtubeAutomationUpdatedAt: new Date().toISOString()
          });
        }
        throw error;
      }

      const videoId = upload?.data?.id;
      if (!videoId) throw new Error('YouTube returned no video ID; file is left marked uploading to prevent duplicate uploads');

      const uploadedAt = new Date().toISOString();
      await this.updateProperties(file.id, {
        ...currentProps,
        youtubeAutomationStatus: 'uploaded',
        youtubeVideoId: videoId,
        youtubeVideoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        youtubeAutomationUpdatedAt: uploadedAt
      });

      // Move only after YouTube confirms an ID; the root folder remains the source inbox.
      await this.drive.files.update({
        fileId: file.id,
        addParents: this.uploadedFolderId,
        removeParents: this.folderId,
        fields: 'id,parents,appProperties'
      });
      this.logger.info(`Drive video uploaded and moved to Uploaded: ${file.name} -> https://www.youtube.com/watch?v=${videoId}`);
    } finally {
      await fsp.unlink(tempPath).catch(() => {});
    }
  }

  async generateMetadata(fileName) {
    const prompt = [
      'Create YouTube SEO metadata for an existing video file. The filename is only a clue; do not invent specific facts about unseen video content.',
      'Return ONLY valid JSON with keys: title, description, hashtags (array), tags (array), categoryId, defaultLanguage.',
      'Title max 95 characters. Description must be useful, include a brief neutral summary based only on the filename, a natural call to action, and 3-5 relevant hashtags.',
      'Tags should contain 5-15 concise search phrases. categoryId must be a numeric YouTube category ID. defaultLanguage should be en unless the filename clearly indicates another language.',
      `Video filename: ${path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, ' ')}`
    ].join('\n');
    const raw = await this.ai.generateText(prompt, { maxTokens: 1200, temperature: 0.4 });
    const cleaned = raw.trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI provider returned invalid metadata JSON');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
      .map(tag => `#${String(tag).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`)
      .filter(tag => tag.length > 1)
      .slice(0, 5);
    const description = [String(parsed.description || '').trim(), hashtags.join(' ')].filter(Boolean).join('\n\n').slice(0, 4900);
    return {
      title: String(parsed.title || '').trim().slice(0, 100),
      description,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      categoryId: String(parsed.categoryId || '22'),
      defaultLanguage: String(parsed.defaultLanguage || 'en'),
      defaultAudioLanguage: String(parsed.defaultLanguage || 'en')
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { GoogleDriveVideoSync, DEFAULT_PARENT_FOLDER_ID };
