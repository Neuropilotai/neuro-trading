/**
 * Checkpoint Manager
 * Tracks last processed candle for each symbol/timeframe
 */

const fs = require('fs').promises;
const path = require('path');

class CheckpointManager {
  constructor() {
    this.checkpointDir = path.join(__dirname, '../../data/checkpoints');
  }

  /**
   * Get checkpoint file path
   */
  getCheckpointPath(symbol, timeframe) {
    return path.join(this.checkpointDir, `${symbol}_${timeframe}.json`);
  }

  /**
   * Ensure checkpoint directory exists
   */
  async ensureCheckpointDir() {
    await fs.mkdir(this.checkpointDir, { recursive: true });
  }

  /**
   * Get last processed timestamp
   */
  async getLastProcessed(symbol, timeframe) {
    const checkpointPath = this.getCheckpointPath(symbol, timeframe);
    
    try {
      const data = await fs.readFile(checkpointPath, 'utf8');
      const checkpoint = JSON.parse(data);
      return checkpoint.lastProcessed || null;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Update checkpoint (atomic write)
   */
  async updateCheckpoint(symbol, timeframe, lastProcessed, metadata = {}) {
    await this.ensureCheckpointDir();
    const checkpointPath = this.getCheckpointPath(symbol, timeframe);
    const tempPath = `${checkpointPath}.tmp`;

    const checkpoint = {
      symbol,
      timeframe,
      lastProcessed,
      updatedAt: new Date().toISOString(),
      ...metadata
    };

    // Atomic write
    await fs.writeFile(tempPath, JSON.stringify(checkpoint, null, 2), 'utf8');
    await fs.rename(tempPath, checkpointPath);
  }

  /**
   * Get all checkpoints
   */
  async getAllCheckpoints() {
    await this.ensureCheckpointDir();
    
    try {
      const files = await fs.readdir(this.checkpointDir);
      const checkpoints = {};

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const data = await fs.readFile(path.join(this.checkpointDir, file), 'utf8');
            const checkpoint = JSON.parse(data);
            const key = `${checkpoint.symbol}_${checkpoint.timeframe}`;
            checkpoints[key] = checkpoint;
          } catch (error) {
            // Skip invalid checkpoints
            console.warn(`⚠️  Invalid checkpoint file: ${file}`);
          }
        }
      }

      return checkpoints;
    } catch (error) {
      return {};
    }
  }
}

module.exports = new CheckpointManager();


