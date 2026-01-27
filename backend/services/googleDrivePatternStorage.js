/**
 * Google Drive Pattern Storage Service
 * Syncs patterns to/from Google Drive for backup and sharing
 * 
 * Feature Flag: ENABLE_GOOGLE_DRIVE_SYNC (default: false)
 * Requires: GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN
 */

const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');

class GoogleDrivePatternStorage {
  constructor() {
    this.enabled = process.env.ENABLE_GOOGLE_DRIVE_SYNC === 'true';
    this.clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    this.refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    this.folderId = process.env.GOOGLE_DRIVE_PATTERNS_FOLDER_ID || null;
    
    this.drive = null;
    this.syncInterval = null;
    this.syncIntervalMs = 5 * 60 * 1000; // 5 minutes
    this.lastSyncAt = null;
    this.lastError = null;
    this.connected = false;
    
    if (this.enabled) {
      this.initialize();
    }
  }

  /**
   * Initialize Google Drive client
   * Fast-fail if enabled but credentials missing
   */
  async initialize() {
    if (!this.enabled) {
      console.log('⚠️  Google Drive sync is DISABLED');
      return;
    }

    // Fast-fail check: if enabled, credentials must be present
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      const errorMsg = 'ENABLE_GOOGLE_DRIVE_SYNC=true but missing credentials. Required: GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN';
      console.error(`❌ ${errorMsg}`);
      this.lastError = errorMsg;
      this.enabled = false;
      throw new Error(errorMsg);
    }

    try {
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        'urn:ietf:wg:oauth:2.0:oob'
      );

      oauth2Client.setCredentials({
        refresh_token: this.refreshToken
      });

      this.drive = google.drive({
        version: 'v3',
        auth: oauth2Client
      });

      // Find or create patterns folder
      await this.ensurePatternsFolder();

      // Start periodic sync
      this.startPeriodicSync();

      this.connected = true;
      this.lastError = null;
      console.log('✅ Google Drive pattern storage initialized');
    } catch (error) {
      const errorMsg = `Google Drive initialization failed: ${error.message}`;
      console.error(`❌ ${errorMsg}`);
      this.lastError = errorMsg;
      this.connected = false;
      this.enabled = false;
      throw error; // Re-throw for fast-fail behavior
    }
  }

  /**
   * Find or create patterns folder in Google Drive
   */
  async ensurePatternsFolder() {
    if (!this.drive) return;

    try {
      // If folder ID is provided, use it
      if (this.folderId) {
        const folder = await this.drive.files.get({
          fileId: this.folderId
        });
        console.log(`✅ Using existing patterns folder: ${folder.data.name}`);
        return;
      }

      // Search for existing folder
      const response = await this.drive.files.list({
        q: "name='TradingPatterns' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id, name)'
      });

      if (response.data.files.length > 0) {
        this.folderId = response.data.files[0].id;
        console.log(`✅ Found existing patterns folder: ${response.data.files[0].name}`);
        return;
      }

      // Create new folder
      const folder = await this.drive.files.create({
        requestBody: {
          name: 'TradingPatterns',
          mimeType: 'application/vnd.google-apps.folder'
        },
        fields: 'id, name'
      });

      this.folderId = folder.data.id;
      console.log(`✅ Created patterns folder: ${folder.data.name} (ID: ${this.folderId})`);
    } catch (error) {
      console.error('❌ Error ensuring patterns folder:', error.message);
    }
  }

  /**
   * Upload pattern to Google Drive
   */
  async uploadPattern(pattern, patternType) {
    if (!this.enabled || !this.drive) {
      return false;
    }

    try {
      const fileName = `${pattern.patternId}.json`;
      const filePath = path.join(__dirname, '../../data/patterns_temp', fileName);
      
      // Ensure temp directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      
      // Write pattern to temp file
      await fs.writeFile(filePath, JSON.stringify(pattern, null, 2));

      // Check if file already exists
      const existingFile = await this.findFile(fileName);
      
      if (existingFile) {
        // Update existing file
        await this.drive.files.update({
          fileId: existingFile.id,
          requestBody: {
            name: fileName
          },
          media: {
            mimeType: 'application/json',
            body: fs.createReadStream(filePath)
          }
        });
        console.log(`📤 Updated pattern in Google Drive: ${fileName}`);
      } else {
        // Create new file
        await this.drive.files.create({
          requestBody: {
            name: fileName,
            parents: this.folderId ? [this.folderId] : []
          },
          media: {
            mimeType: 'application/json',
            body: fs.createReadStream(filePath)
          },
          fields: 'id, name'
        });
        console.log(`📤 Uploaded pattern to Google Drive: ${fileName}`);
      }

      // Clean up temp file
      await fs.unlink(filePath).catch(() => {});

      return true;
    } catch (error) {
      console.error(`❌ Error uploading pattern ${pattern.patternId}:`, error.message);
      return false;
    }
  }

  /**
   * Download patterns from Google Drive (primary storage)
   */
  async downloadPatterns() {
    if (!this.enabled || !this.drive) {
      return [];
    }

    try {
      const patterns = [];

      // First, try to download consolidated pattern bank file
      try {
        const bankFile = await this.findFile('pattern_bank.json');
        if (bankFile) {
          const fileContent = await this.drive.files.get({
            fileId: bankFile.id,
            alt: 'media'
          }, {
            responseType: 'text'
          });

          const bankData = JSON.parse(fileContent.data);
          if (bankData.patterns && Array.isArray(bankData.patterns)) {
            patterns.push(...bankData.patterns);
            console.log(`📥 Loaded ${patterns.length} patterns from pattern_bank.json`);
            return patterns; // Return early if bank file exists
          }
        }
      } catch (error) {
        console.log('ℹ️  Pattern bank file not found, downloading individual patterns...');
      }

      // Fallback: Download individual pattern files
      const query = this.folderId 
        ? `'${this.folderId}' in parents and mimeType='application/json' and trashed=false and name contains 'PATTERN_'`
        : "name contains 'PATTERN_' and mimeType='application/json' and trashed=false";

      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name, modifiedTime)',
        orderBy: 'modifiedTime desc'
      });

      for (const file of response.data.files || []) {
        try {
          const fileContent = await this.drive.files.get({
            fileId: file.id,
            alt: 'media'
          }, {
            responseType: 'text'
          });

          const pattern = JSON.parse(fileContent.data);
          patterns.push(pattern);
        } catch (error) {
          console.error(`❌ Error downloading pattern ${file.name}:`, error.message);
        }
      }

      console.log(`📥 Downloaded ${patterns.length} patterns from Google Drive`);
      return patterns;
    } catch (error) {
      console.error('❌ Error downloading patterns:', error.message);
      return [];
    }
  }

  /**
   * Sync all patterns to Google Drive (primary storage)
   */
  /**
   * Get storage status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      connected: this.connected && this.drive !== null,
      folderId: this.folderId,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError
    };
  }

  async syncToDrive(patterns) {
    if (!this.enabled || !this.drive) {
      return { success: false, reason: 'Google Drive sync disabled' };
    }

    try {
      let uploaded = 0;
      let updated = 0;
      let failed = 0;

      // Also save a consolidated pattern bank file
      const patternBankData = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        totalPatterns: patterns.length,
        storage: 'Google Drive (primary)',
        patterns: patterns
      };

      // Upload individual patterns
      for (const pattern of patterns) {
        const success = await this.uploadPattern(pattern, pattern.patternType);
        if (success) {
          uploaded++;
        } else {
          failed++;
        }
      }

      // Upload consolidated pattern bank file
      try {
        const bankFileName = 'pattern_bank.json';
        const existingBank = await this.findFile(bankFileName);
        
        const tempPath = path.join(__dirname, '../../data/patterns_temp', bankFileName);
        await fs.mkdir(path.dirname(tempPath), { recursive: true });
        await fs.writeFile(tempPath, JSON.stringify(patternBankData, null, 2));

        if (existingBank) {
          // Update existing file
          await this.drive.files.update({
            fileId: existingBank.id,
            requestBody: {
              name: bankFileName
            },
            media: {
              mimeType: 'application/json',
              body: fs.createReadStream(tempPath)
            }
          });
          updated = 1;
        } else {
          // Create new file
          await this.drive.files.create({
            requestBody: {
              name: bankFileName,
              parents: this.folderId ? [this.folderId] : []
            },
            media: {
              mimeType: 'application/json',
              body: fs.createReadStream(tempPath)
            },
            fields: 'id, name'
          });
          uploaded++;
        }

        // Clean up temp file
        await fs.unlink(tempPath).catch(() => {});
      } catch (error) {
        console.warn('⚠️  Error uploading pattern bank file:', error.message);
      }

      console.log(`✅ Synced ${uploaded} patterns + ${updated} bank file to Google Drive (${failed} failed)`);
      
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      
      return {
        success: true,
        uploaded: uploaded + updated,
        failed,
        total: patterns.length
      };
    } catch (error) {
      const errorMsg = `Error syncing to Google Drive: ${error.message}`;
      console.error(`❌ ${errorMsg}`);
      this.lastError = errorMsg;
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Sync patterns from Google Drive
   */
  async syncFromDrive() {
    if (!this.enabled || !this.drive) {
      return { success: false, reason: 'Google Drive sync disabled' };
    }

    try {
      const patterns = await this.downloadPatterns();
      
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      
      return {
        success: true,
        patterns: patterns,
        count: patterns.length
      };
    } catch (error) {
      const errorMsg = `Error syncing from Google Drive: ${error.message}`;
      console.error(`❌ ${errorMsg}`);
      this.lastError = errorMsg;
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Find file in Google Drive
   */
  async findFile(fileName) {
    if (!this.drive) return null;

    try {
      const query = this.folderId
        ? `name='${fileName}' and '${this.folderId}' in parents and trashed=false`
        : `name='${fileName}' and trashed=false`;

      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name)'
      });

      return response.data.files.length > 0 ? response.data.files[0] : null;
    } catch (error) {
      console.error(`❌ Error finding file ${fileName}:`, error.message);
      return null;
    }
  }

  /**
   * Start periodic sync
   */
  startPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    this.syncInterval = setInterval(async () => {
      console.log('🔄 Starting periodic Google Drive sync...');
      // This will be called by pattern recognition service
    }, this.syncIntervalMs);

    console.log(`✅ Periodic Google Drive sync started (every ${this.syncIntervalMs / 1000}s)`);
  }

  /**
   * Stop periodic sync
   */
  stopPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }
}

module.exports = new GoogleDrivePatternStorage();

